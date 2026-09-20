/**
 * Small LRC parser and LRCLIB client used by the background module.
 *
 * The module deliberately has no browser-only imports.  The service accepts
 * its side effects (fetch and storage) as dependencies, which keeps all of
 * the matching and cache behavior testable in Node.
 */

export const LRCLIB_API = 'https://lrclib.net/api';
export const CACHE_STORAGE_KEY = 'lyricsCacheV1';
export const DEFAULT_TIMEOUT_MS = 7000;
export const DEFAULT_SUCCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_NEGATIVE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CACHE_LIMIT = 100;
export const DEFAULT_CACHE_BYTES = 1_500_000;

const TIME_TAG_RE = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG_RE = /\[offset\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\]/gi;
const METADATA_TAG_RE = /\[(?:ar|al|ti|by|re|ve|length|id)\s*:[^\]]*\]/gi;
const CACHEABLE_STATUSES = new Set(['synced', 'plain', 'instrumental', 'missing']);

function finiteNumber(value) {
  if (typeof value === 'boolean' || value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function textValue(value, maxLength = 500) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result.length > maxLength ? result.slice(0, maxLength) : result;
}

/**
 * Parse an LRC document.  A line may carry more than one timestamp and
 * [offset:N] shifts every timestamp by N milliseconds.  Metadata tags are
 * ignored while all timestamped text (including empty text) is retained.
 */
export function parseLrc(input) {
  if (typeof input !== 'string' || input.length === 0) return [];

  let offsetMs = 0;
  for (const match of input.matchAll(OFFSET_TAG_RE)) {
    const value = finiteNumber(match[1]);
    if (value !== null) offsetMs = value;
  }

  const lines = [];
  let order = 0;
  for (const rawLine of input.split(/\r?\n/)) {
    const timestamps = [];
    for (const match of rawLine.matchAll(TIME_TAG_RE)) {
      const minutes = Number(match[1]);
      const seconds = Number(match[2]);
      if (!Number.isFinite(minutes) || !Number.isFinite(seconds) || seconds >= 60) continue;
      let fraction = 0;
      if (match[3]) {
        // Treat the digits as a decimal fraction: .5 and .50 are both half
        // a second, while .005 is five milliseconds.
        fraction = Number(`0.${match[3]}`);
      }
      // FFmpeg's lrc demuxer applies `pts = timestamp - offset`: a positive
      // correction advances a line so it becomes active earlier.
      const time = minutes * 60 + seconds + fraction - offsetMs / 1000;
      if (Number.isFinite(time)) timestamps.push(time);
    }
    if (timestamps.length === 0) continue;

    const lyricText = rawLine.replace(TIME_TAG_RE, '').replace(OFFSET_TAG_RE, '').replace(METADATA_TAG_RE, '').trim();
    for (const time of timestamps) lines.push({ time, text: lyricText, order: order++ });
  }

  // Do not rely on a particular engine's sort stability: declarations with
  // equal timestamps retain their original order explicitly.
  lines.sort((a, b) => a.time - b.time || a.order - b.order);
  return lines.map(({ time, text }) => ({ time, text }));
}

/** Return the index of the last line whose timestamp is at or before time. */
export function findActiveLine(lines, time) {
  if (!Array.isArray(lines) || lines.length === 0) return -1;
  const currentTime = finiteNumber(time);
  if (currentTime === null) return -1;

  // Parsed lines are ordered, but a linear pass is intentionally tolerant of
  // caller-created arrays and keeps the returned index tied to that array.
  let active = -1;
  let activeTime = -Infinity;
  lines.forEach((line, index) => {
    const lineTime = finiteNumber(line?.time);
    if (lineTime !== null && lineTime <= currentTime && lineTime >= activeTime) {
      active = index;
      activeTime = lineTime;
    }
  });
  return active;
}

/** Normalize comparisons without removing semantic version qualifiers. */
export function normalizeMatchText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateTitle(candidate) {
  return candidate?.track_name ?? candidate?.trackName ?? candidate?.name ?? candidate?.title;
}

function candidateArtist(candidate) {
  return candidate?.artist_name ?? candidate?.artistName ?? candidate?.artist;
}

function candidateDuration(candidate) {
  return finiteNumber(candidate?.duration);
}

/**
 * Conservative candidate check.  Version qualifiers remain part of the
 * normalized title, so an album version cannot silently match the studio
 * track.  If both records have durations, they must be close.
 */
export function matchCandidate(candidate, track, durationTolerance = 2) {
  if (!candidate || !track) return false;
  const title = normalizeMatchText(track.title);
  const artist = normalizeMatchText(track.artist);
  if (!title || !artist) return false;
  if (normalizeMatchText(candidateTitle(candidate)) !== title) return false;
  if (normalizeMatchText(candidateArtist(candidate)) !== artist) return false;

  const expectedDuration = finiteNumber(track.duration);
  const actualDuration = candidateDuration(candidate);
  if (expectedDuration !== null && actualDuration !== null) {
    if (Math.abs(expectedDuration - actualDuration) > durationTolerance) return false;
  }
  return true;
}

/**
 * Select a unique, high-confidence search result.  A tie is rejected rather
 * than resolved by array order, preventing an arbitrary duplicate from being
 * shown to the user.
 */
export function selectSearchCandidate(candidates, track) {
  if (!Array.isArray(candidates)) return null;
  const matches = candidates.filter((candidate) => matchCandidate(candidate, track));
  if (matches.length === 0) return null;

  const expectedDuration = finiteNumber(track?.duration);
  const scored = matches.map((candidate, index) => {
    const actualDuration = candidateDuration(candidate);
    const durationScore = expectedDuration !== null && actualDuration !== null
      ? 2 - Math.min(1, Math.abs(expectedDuration - actualDuration) / Math.max(expectedDuration, 1))
      : 0;
    const albumScore = normalizeMatchText(candidate?.album_name ?? candidate?.albumName ?? candidate?.album) === normalizeMatchText(track?.album)
      ? 0.25
      : 0;
    return { candidate, score: durationScore + albumScore, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  if (scored.length > 1 && Math.abs(scored[0].score - scored[1].score) < 1e-9) return null;
  return scored[0].candidate;
}

export function normalizeTrack(track) {
  if (!track || typeof track !== 'object' || Array.isArray(track)) return null;
  const title = textValue(track.title);
  const artist = textValue(track.artist);
  if (!title || !artist) return null;
  const result = { title, artist };
  const album = textValue(track.album);
  if (album) result.album = album;
  const duration = finiteNumber(track.duration);
  if (duration !== null && duration >= 0) result.duration = duration;
  const id = textValue(track.id, 200);
  if (id) result.id = id;
  return result;
}

function cacheKey(track) {
  return JSON.stringify([
    normalizeMatchText(track.title),
    normalizeMatchText(track.artist),
    normalizeMatchText(track.album),
    finiteNumber(track.duration),
  ]);
}

function storageAreaFromGlobals() {
  return globalThis.browser?.storage?.local ?? globalThis.chrome?.storage?.local ?? null;
}

async function storageCall(area, method, args = []) {
  if (!area || typeof area[method] !== 'function') return undefined;
  // Firefox WebExtension storage and Chrome 121+ both expose the Promise
  // form.  Do not append a callback: Firefox rejects extra arguments on its
  // Promise API, and modern Chrome no longer needs the legacy callback form.
  return area[method](...args);
}

function sanitizeResult(result) {
  if (!result || typeof result !== 'object' || !CACHEABLE_STATUSES.has(result.status)) return null;
  const sanitized = { status: result.status };
  if (result.status === 'synced' && Array.isArray(result.lines)) {
    sanitized.lines = result.lines
      .filter((line) => Number.isFinite(line?.time) && typeof line.text === 'string')
      .slice(0, 500)
      .map((line) => ({ time: line.time, text: line.text.slice(0, 2000) }));
    if (sanitized.lines.length === 0) return null;
  } else if (result.status === 'plain' && typeof result.plainLyrics === 'string') {
    sanitized.plainLyrics = result.plainLyrics.slice(0, 100_000);
  } else if (result.status === 'instrumental') {
    // no body
  } else if (result.status === 'missing') {
    // no body
  }
  if (typeof result.source === 'string') sanitized.source = result.source.slice(0, 100);
  return sanitized;
}

function resultFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const syncedLyrics = typeof payload.syncedLyrics === 'string' ? payload.syncedLyrics : '';
  const plainLyrics = typeof payload.plainLyrics === 'string' ? payload.plainLyrics : '';
  if (syncedLyrics.trim()) {
    const lines = parseLrc(syncedLyrics);
    if (lines.length) return { status: 'synced', lines, source: 'lrclib' };
  }
  if (payload.instrumental === true) return { status: 'instrumental', source: 'lrclib' };
  if (plainLyrics.trim()) return { status: 'plain', plainLyrics, source: 'lrclib' };
  return { status: 'missing', source: 'lrclib' };
}

function queryUrl(path, params) {
  // The base and path are constants: callers cannot turn this provider into a
  // proxy for arbitrary URLs.
  const url = new URL(`${LRCLIB_API}${path}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  }
  return url;
}

export async function fetchJsonWithTimeout(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Lyrics service unavailable: fetch is not available');
  const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(1, options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  let timer;
  let timedOut = false;
  try {
    const request = (async () => {
      const response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller?.signal,
      });
      if (!response || typeof response.ok !== 'boolean') throw new Error('Lyrics service returned an invalid response');
      let payload;
      try {
        payload = await response.json();
      } catch {
        payload = null;
      }
      return { response, payload };
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        const error = new Error('Lyrics service unavailable: request timed out');
        error.code = 'TIMEOUT';
        reject(error);
      }, timeoutMs);
    });
    return await Promise.race([request, timeout]);
  } catch (error) {
    if (timedOut || error?.code === 'TIMEOUT') {
      const timeoutError = new Error('Lyrics service unavailable: request timed out');
      timeoutError.code = 'TIMEOUT';
      throw timeoutError;
    }
    const wrapped = new Error(`Lyrics service unavailable: ${error?.message || 'network request failed'}`);
    wrapped.code = 'UNAVAILABLE';
    throw wrapped;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function providerLookup(track, options = {}) {
  const query = {
    track_name: track.title,
    artist_name: track.artist,
  };
  if (track.album) query.album_name = track.album;
  if (finiteNumber(track.duration) !== null) query.duration = finiteNumber(track.duration);

  let getResult;
  try {
    const getResponse = await fetchJsonWithTimeout(queryUrl('/get', query), options);
    if (getResponse.response.status === 404) {
      getResult = { status: 'missing' };
    } else if (!getResponse.response.ok) {
      throw new Error(`Lyrics service unavailable: HTTP ${getResponse.response.status}`);
    } else if (!getResponse.payload || typeof getResponse.payload !== 'object' || Array.isArray(getResponse.payload)) {
      throw new Error('Lyrics service returned an invalid payload');
    } else if (!matchCandidate(getResponse.payload, track)) {
      getResult = { status: 'missing' };
    } else {
      getResult = resultFromPayload(getResponse.payload);
    }
  } catch (error) {
    throw error;
  }

  if (getResult.status !== 'missing') return getResult;

  let searchResponse;
  try {
    searchResponse = await fetchJsonWithTimeout(queryUrl('/search', query), options);
  } catch (error) {
    throw error;
  }
  if (searchResponse.response.status === 404) return { status: 'missing' };
  if (!searchResponse.response.ok) throw new Error(`Lyrics service unavailable: HTTP ${searchResponse.response.status}`);
  if (!Array.isArray(searchResponse.payload)) throw new Error('Lyrics service returned an invalid search payload');
  const selected = selectSearchCandidate(searchResponse.payload, track);
  return selected ? resultFromPayload(selected) : { status: 'missing' };
}

/** Perform one uncached LRCLIB lookup, useful for callers and unit tests. */
export async function fetchLyrics(inputTrack, options = {}) {
  const track = normalizeTrack(inputTrack);
  if (!track) return { status: 'error', message: 'Invalid track metadata' };
  try {
    return await providerLookup(track, options);
  } catch (error) {
    return {
      status: 'error',
      message: error?.message?.startsWith('Lyrics service unavailable')
        ? error.message
        : `Lyrics service error: ${error?.message || 'unknown error'}`,
    };
  }
}

export function createLyricsService(options = {}) {
  const storage = options.storage === undefined ? storageAreaFromGlobals() : options.storage;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const config = {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    storage,
    timeoutMs: Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS,
    successTtlMs: Number.isFinite(options.successTtlMs) ? options.successTtlMs : DEFAULT_SUCCESS_TTL_MS,
    negativeTtlMs: Number.isFinite(options.negativeTtlMs) ? options.negativeTtlMs : DEFAULT_NEGATIVE_TTL_MS,
    cacheLimit: Number.isFinite(options.cacheLimit) ? Math.max(1, Math.floor(options.cacheLimit)) : DEFAULT_CACHE_LIMIT,
    cacheBytes: Number.isFinite(options.cacheBytes) ? Math.max(10_000, Math.floor(options.cacheBytes)) : DEFAULT_CACHE_BYTES,
  };
  let cache = new Map();
  let loaded = false;
  let loading;
  const inFlight = new Map();

  async function loadCache() {
    if (loaded) return;
    if (loading) return loading;
    loading = (async () => {
      try {
        const stored = await storageCall(config.storage, 'get', [CACHE_STORAGE_KEY]);
        const entries = stored?.[CACHE_STORAGE_KEY];
        if (entries && typeof entries === 'object' && !Array.isArray(entries)) {
          for (const [key, value] of Object.entries(entries)) {
            if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= now()) continue;
            const result = sanitizeResult(value.result);
            if (result) cache.set(key, { expiresAt: value.expiresAt, savedAt: Number(value.savedAt) || 0, result });
          }
        }
      } catch {
        // A storage failure must not make network lyrics unavailable.
      } finally {
        loaded = true;
        loading = null;
      }
    })();
    return loading;
  }

  async function persistCache() {
    if (!config.storage) return;
    const entries = Object.fromEntries([...cache.entries()].map(([key, value]) => [key, value]));
    try {
      await storageCall(config.storage, 'set', [{ [CACHE_STORAGE_KEY]: entries }]);
    } catch {
      // Cache persistence is best effort.
    }
  }

  async function putCache(key, result) {
    const sanitized = sanitizeResult(result);
    if (!sanitized) return;
    const ttl = sanitized.status === 'missing' ? config.negativeTtlMs : config.successTtlMs;
    const entry = { expiresAt: now() + Math.max(0, ttl), savedAt: now(), result: sanitized };
    if (JSON.stringify({ [key]: entry }).length > config.cacheBytes) return;
    cache.set(key, entry);
    const ordered = [...cache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    while (ordered.length > config.cacheLimit) cache.delete(ordered.shift()[0]);
    while (JSON.stringify(Object.fromEntries(cache)).length > config.cacheBytes && cache.size) {
      const oldestKey = [...cache.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt)[0][0];
      cache.delete(oldestKey);
    }
    await persistCache();
  }

  async function getLyrics(inputTrack) {
    const track = normalizeTrack(inputTrack);
    if (!track) return { status: 'error', message: 'Invalid track metadata' };
    await loadCache();
    const key = cacheKey(track);
    const cached = cache.get(key);
    if (cached) {
      if (cached.expiresAt > now()) return cached.result;
      cache.delete(key);
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const request = (async () => {
      try {
        const result = await providerLookup(track, config);
        if (CACHEABLE_STATUSES.has(result.status)) await putCache(key, result);
        return result;
      } catch (error) {
        return {
          status: 'error',
          message: error?.message?.startsWith('Lyrics service unavailable')
            ? error.message
            : `Lyrics service error: ${error?.message || 'unknown error'}`,
        };
      } finally {
        inFlight.delete(key);
      }
    })();
    inFlight.set(key, request);
    return request;
  }

  return {
    getLyrics,
    clearMemoryCache() {
      cache.clear();
    },
    getCacheSnapshot() {
      return new Map(cache);
    },
  };
}

export { cacheKey };
