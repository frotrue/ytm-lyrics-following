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

const DURATION_TOLERANCE_SECONDS = 2;
const MAX_SEARCH_REQUESTS = 5;
/**
 * Bumped whenever candidate matching or the search plan changes shape.  Older
 * plain/missing cache entries are dropped on load so a repaired matcher is not
 * masked by a stale negative result; synced and instrumental entries stay.
 */
const MATCH_POLICY_VERSION = 2;
const TIME_TAG_RE = /\[(\d+):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const OFFSET_TAG_RE = /\[offset\s*:\s*([+-]?\d+(?:\.\d+)?)\s*\]/gi;
const METADATA_TAG_RE = /\[(?:ar|al|ti|by|re|ve|length|id)\s*:[^\]]*\]/gi;
const CACHEABLE_STATUSES = new Set(['synced', 'plain', 'instrumental', 'missing']);
const RETRYABLE_HTTP_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 2_000;

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

function candidateAlbum(candidate) {
  return candidate?.album_name ?? candidate?.albumName ?? candidate?.album;
}

/**
 * Words that describe a version, edit, or participant rather than an
 * alternate name.  A bracket group made only of these words is never treated
 * as an alias, so "(Live)", "(리믹스)", or "feat. X" cannot erase a qualifier.
 */
const VERSION_QUALIFIER_TOKENS = new Set([
  'live', 'remix', 'remixed', 'mix', 'acoustic', 'unplugged', 'instrumental',
  'inst', 'karaoke', 'demo', 'remaster', 'remastered', 'version', 'ver',
  'edit', 'edition', 'radio', 'extended', 'original', 'cover', 'bonus',
  'track', 'deluxe', 'mono', 'stereo', 'sped', 'slowed', 'reprise',
  'session', 'sessions', 'practice', 'ost', 'bgm',
  '라이브', '리믹스', '어쿠스틱', '반주', '버전', '편곡', '커버', '데모',
  '리마스터', '연주', '노래방', '원곡', '축소', '확장', '가사',
]);

const COLLABORATION_TOKENS = new Set([
  'feat', 'ft', 'featuring', 'with', 'prod', 'produced', 'and', 'vs', 'duet',
  '피처링', '듀엣',
]);

function tokenizeForQualifier(raw) {
  return raw.normalize('NFKC').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function hasQualifierOrCollaboration(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return true;
  const text = raw.normalize('NFKC');
  if (/[&+,;/×]/.test(text)) return true;
  return tokenizeForQualifier(text).some((token) => (
    VERSION_QUALIFIER_TOKENS.has(token) || COLLABORATION_TOKENS.has(token)
      || /^(?:라이브|리믹스|어쿠스틱|리마스터|연주|노래방)버전$/u.test(token)
  ));
}

function scriptOfName(text) {
  const composed = text.normalize('NFKC');
  const latin = /\p{Script=Latin}/u.test(composed);
  const hangul = /\p{Script=Hangul}/u.test(composed);
  if (latin && !hangul) return 'latin';
  if (hangul && !latin) return 'hangul';
  return null;
}

const ALIAS_PAIR_RE = /^([^()\[\]{}]+?)\s*(?:\(([^()\[\]{}]+)\)|\[([^()\[\]{}]+)\])$/;

/**
 * Read an explicit pairing such as "Oort Cloud (오르트구름)" or "YOUNHA (윤하)".
 * Only one trailing bracket group, only two clearly different scripts, and no
 * version or collaboration wording qualify.  Everything else returns null and
 * falls back to a whole-string comparison, so no name is ever guessed.
 */
function parseAliasPair(raw) {
  if (typeof raw !== 'string') return null;
  const text = raw.normalize('NFKC').trim();
  if (!text) return null;
  const match = ALIAS_PAIR_RE.exec(text);
  if (!match) return null;
  const outer = match[1].trim();
  const inner = (match[2] ?? match[3]).trim();
  if (!outer || !inner) return null;
  const outerScript = scriptOfName(outer);
  const innerScript = scriptOfName(inner);
  if (!outerScript || !innerScript || outerScript === innerScript) return null;
  if (hasQualifierOrCollaboration(outer) || hasQualifierOrCollaboration(inner)) return null;
  return { parts: [outer, inner] };
}

function sameNameSet(left, right) {
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Compare one metadata name.  'exact' means the normalized whole strings are
 * equal, 'alias' means an explicit bilingual pairing connects the two sides,
 * and 'none' rejects everything else.  Transliteration is never guessed.
 */
function compareName(candidateRaw, trackRaw) {
  const candidateText = normalizeMatchText(candidateRaw);
  const trackText = normalizeMatchText(trackRaw);
  if (!candidateText || !trackText) return 'none';
  if (candidateText === trackText) return 'exact';

  const candidatePair = parseAliasPair(candidateRaw);
  const trackPair = parseAliasPair(trackRaw);
  if (!candidatePair && !trackPair) return 'none';

  const candidateParts = (candidatePair ? candidatePair.parts : [candidateRaw]).map(normalizeMatchText);
  const trackParts = (trackPair ? trackPair.parts : [trackRaw]).map(normalizeMatchText);
  if (candidateParts.some((part) => !part) || trackParts.some((part) => !part)) return 'none';

  if (candidatePair && trackPair) {
    // Two pairings must correspond on both names; sharing one bracketed word
    // is not enough.
    return sameNameSet(candidateParts, trackParts) ? 'alias' : 'none';
  }
  const single = candidatePair ? trackText : candidateText;
  const pairParts = candidatePair ? candidateParts : trackParts;
  return pairParts.includes(single) ? 'alias' : 'none';
}

/**
 * Conservative candidate check.  Version qualifiers remain part of the
 * normalized title, so an album version cannot silently match the studio
 * track.  An explicit bilingual alias is weaker evidence: it is accepted only
 * when both records carry a real, close duration.
 */
function candidateMatch(candidate, track, durationTolerance = DURATION_TOLERANCE_SECONDS) {
  if (!candidate || !track) return null;
  const titleConfidence = compareName(candidateTitle(candidate), track.title);
  if (titleConfidence === 'none') return null;
  const artistConfidence = compareName(candidateArtist(candidate), track.artist);
  if (artistConfidence === 'none') return null;

  const expectedDuration = finiteNumber(track.duration);
  const actualDuration = candidateDuration(candidate);
  const exact = titleConfidence === 'exact' && artistConfidence === 'exact';
  if (exact) {
    if (expectedDuration !== null && actualDuration !== null
      && Math.abs(expectedDuration - actualDuration) > durationTolerance) return null;
  } else {
    if (expectedDuration === null || actualDuration === null) return null;
    if (expectedDuration <= 0 || actualDuration <= 0) return null;
    if (Math.abs(expectedDuration - actualDuration) > durationTolerance) return null;
  }
  return {
    confidence: exact ? 'exact' : 'alias',
    titleExact: titleConfidence === 'exact',
    artistExact: artistConfidence === 'exact',
  };
}

/** Report how a candidate matched: 'exact', 'alias', or 'none'. */
export function compareCandidate(candidate, track, durationTolerance = DURATION_TOLERANCE_SECONDS) {
  const match = candidateMatch(candidate, track, durationTolerance);
  return match ? match.confidence : 'none';
}

export function matchCandidate(candidate, track, durationTolerance = DURATION_TOLERANCE_SECONDS) {
  return candidateMatch(candidate, track, durationTolerance) !== null;
}

function scoreCandidate(candidate, track, durationTolerance = DURATION_TOLERANCE_SECONDS) {
  const match = candidateMatch(candidate, track, durationTolerance);
  if (!match) return null;
  const expectedDuration = finiteNumber(track?.duration);
  const actualDuration = candidateDuration(candidate);
  const durationScore = expectedDuration !== null && actualDuration !== null
    ? 2 - Math.min(1, Math.abs(expectedDuration - actualDuration) / Math.max(expectedDuration, 1))
    : 0;
  const album = normalizeMatchText(track?.album);
  const albumScore = album && normalizeMatchText(candidateAlbum(candidate)) === album ? 0.25 : 0;
  // Confidence tiers outrank every duration and album term, so an exact title
  // and artist never loses to a closer but merely aliased record.
  const confidenceBonus = match.titleExact && match.artistExact
    ? 6
    : (match.titleExact || match.artistExact ? 3 : 0);
  return { candidate, score: confidenceBonus + durationScore + albumScore, match };
}

function pickUniqueTop(scored) {
  if (!Array.isArray(scored) || scored.length === 0) return null;
  const sorted = [...scored].sort((a, b) => b.score - a.score || a.index - b.index);
  if (sorted.length > 1 && Math.abs(sorted[0].score - sorted[1].score) < 1e-9) return null;
  return sorted[0];
}

/**
 * Select a unique, high-confidence search result.  Exact title and artist win
 * first, alias degree comes next, and duration/album only separate candidates
 * inside a tier.  A tie is rejected rather than resolved by array order.
 */
export function selectSearchCandidate(candidates, track, durationTolerance = DURATION_TOLERANCE_SECONDS) {
  if (!Array.isArray(candidates)) return null;
  const scored = [];
  candidates.forEach((candidate, index) => {
    const entry = scoreCandidate(candidate, track, durationTolerance);
    if (entry) scored.push({ ...entry, index });
  });
  const top = pickUniqueTop(scored);
  return top ? top.candidate : null;
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

function retryAfterMs(response) {
  const header = response?.headers?.get?.('retry-after')
    ?? response?.headers?.get?.('Retry-After');
  if (typeof header !== 'string' || !header.trim()) return null;
  const value = header.trim();
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - Date.now()) : null;
}

function defaultSleep(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchProviderJson(url, options = {}) {
  const maxRetries = Number.isFinite(options.maxRetries)
    ? Math.max(0, Math.floor(options.maxRetries))
    : DEFAULT_MAX_RETRIES;
  const maxRetryDelayMs = Number.isFinite(options.maxRetryDelayMs)
    ? Math.max(0, options.maxRetryDelayMs)
    : DEFAULT_MAX_RETRY_DELAY_MS;
  const sleep = typeof options.sleep === 'function' ? options.sleep : defaultSleep;

  for (let attempt = 0; ; attempt += 1) {
    const result = await fetchJsonWithTimeout(url, options);
    const status = result.response.status;
    if (!RETRYABLE_HTTP_STATUSES.has(status) || attempt >= maxRetries) return result;

    const retryAfter = retryAfterMs(result.response);
    const configuredDelay = typeof options.retryDelayMs === 'function'
      ? options.retryDelayMs(attempt + 1, result.response)
      : Number.isFinite(options.retryDelayMs)
        ? options.retryDelayMs * (2 ** attempt)
        : DEFAULT_RETRY_DELAY_MS * (2 ** attempt);
    const fallbackDelay = Number.isFinite(configuredDelay) ? Math.max(0, configuredDelay) : DEFAULT_RETRY_DELAY_MS;
    const delay = Math.min(maxRetryDelayMs, Math.max(0, retryAfter ?? fallbackDelay));
    await sleep(delay);
  }
}

function providerId(candidate) {
  const raw = candidate?.id ?? candidate?.trackId ?? null;
  if (raw === null || raw === undefined) return null;
  const value = String(raw).trim();
  return value === '' ? null : value;
}

/**
 * Merge results from several searches.  Only the same provider id reappearing
 * is collapsed; different ids stay apart so a genuine tie is still rejected.
 * One id appearing with conflicting metadata is dropped entirely rather than
 * trusting an arbitrary copy.
 */
function collectCandidates(collected, conflicted, candidates) {
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const serialized = JSON.stringify([
      candidateTitle(candidate), candidateArtist(candidate), candidateAlbum(candidate),
      candidateDuration(candidate), candidate.instrumental === true,
      candidate.syncedLyrics ?? '', candidate.plainLyrics ?? '',
    ]);
    const id = providerId(candidate);
    const key = id === null ? `raw:${serialized}` : `id:${id}`;
    if (conflicted.has(key)) continue;
    const existing = collected.get(key);
    if (!existing) {
      collected.set(key, { serialized, candidate });
    } else if (existing.serialized !== serialized) {
      collected.delete(key);
      conflicted.add(key);
    }
  }
}

function getQueryParams(track) {
  const query = { track_name: track.title, artist_name: track.artist };
  if (track.album) query.album_name = track.album;
  if (finiteNumber(track.duration) !== null) query.duration = finiteNumber(track.duration);
  return query;
}

/**
 * Bounded, deduplicated search plan: the exact metadata first, then the album
 * condition removed, then the title alone, then each side of an explicit
 * bilingual title so a composite artist record can still be found.  Every
 * result is validated against the original track, so widening the query never
 * widens acceptance.
 */
function buildSearchSteps(track) {
  const steps = [];
  const seen = new Set();
  const add = (params) => {
    if (steps.length >= MAX_SEARCH_REQUESTS) return;
    const url = queryUrl('/search', params);
    const key = url.toString();
    if (seen.has(key)) return;
    seen.add(key);
    steps.push(url);
  };
  const base = { track_name: track.title, artist_name: track.artist };
  if (track.album) add({ ...base, album_name: track.album });
  add(base);
  add({ track_name: track.title });
  const pair = parseAliasPair(track.title);
  if (pair) for (const part of pair.parts) add({ track_name: part });
  return steps;
}

async function providerLookup(track, options = {}) {
  const durationTolerance = Number.isFinite(options.durationTolerance)
    ? options.durationTolerance
    : DURATION_TOLERANCE_SECONDS;

  // Exact metadata first; a synced or instrumental hit is returned at once.
  let plainFallback = null;
  const getResponse = await fetchProviderJson(queryUrl('/get', getQueryParams(track)), options);
  if (getResponse.response.status === 404) {
    // No exact record; the bounded search below takes over.
  } else if (!getResponse.response.ok) {
    throw new Error(`Lyrics service unavailable: HTTP ${getResponse.response.status}`);
  } else if (!getResponse.payload || typeof getResponse.payload !== 'object' || Array.isArray(getResponse.payload)) {
    throw new Error('Lyrics service returned an invalid payload');
  } else if (candidateMatch(getResponse.payload, track, durationTolerance)) {
    const getResult = resultFromPayload(getResponse.payload);
    if (getResult.status === 'synced' || getResult.status === 'instrumental') return getResult;
    if (getResult.status === 'plain') plainFallback = getResult;
  }

  const collected = new Map();
  const conflicted = new Set();
  const getPlainFallback = plainFallback;
  let ranked = [];
  for (const url of buildSearchSteps(track)) {
    let searchResponse;
    try {
      searchResponse = await fetchProviderJson(url, options);
    } catch (error) {
      // A plain result already satisfies the request, and a failure is never
      // followed by more requests against the service.
      if (plainFallback) return plainFallback;
      throw error;
    }
    if (searchResponse.response.status === 404) continue;
    if (!searchResponse.response.ok) {
      if (plainFallback) return plainFallback;
      throw new Error(`Lyrics service unavailable: HTTP ${searchResponse.response.status}`);
    }
    if (!Array.isArray(searchResponse.payload)) {
      if (plainFallback) return plainFallback;
      throw new Error('Lyrics service returned an invalid search payload');
    }
    collectCandidates(collected, conflicted, searchResponse.payload);
    ranked = [];
    for (const { candidate } of collected.values()) {
      const entry = scoreCandidate(candidate, track, durationTolerance);
      if (entry) ranked.push({ ...entry, index: ranked.length, result: resultFromPayload(candidate) });
    }
    const top = pickUniqueTop(ranked);
    // Keep a uniquely validated plain search result if a later request fails.
    // Recompute it after every response so conflicts or ties cannot preserve
    // a previously selected arbitrary record.
    plainFallback = getPlainFallback || (top?.result?.status === 'plain' ? top.result : null);
    if (top?.match.confidence === 'exact' && top.result?.status === 'synced') return top.result;
  }

  if (plainFallback) {
    // Only a validated synced record may replace a working plain result.
    const synced = pickUniqueTop(ranked.filter((entry) => entry.result?.status === 'synced'));
    return synced ? synced.result : plainFallback;
  }
  const top = pickUniqueTop(ranked);
  if (!top || top.result?.status === 'missing') return { status: 'missing' };
  return top.result;
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
    maxRetries: Number.isFinite(options.maxRetries) ? options.maxRetries : DEFAULT_MAX_RETRIES,
    retryDelayMs: options.retryDelayMs,
    maxRetryDelayMs: Number.isFinite(options.maxRetryDelayMs) ? options.maxRetryDelayMs : DEFAULT_MAX_RETRY_DELAY_MS,
    sleep: options.sleep,
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
            if (!result) continue;
            const policy = Number(value.policy);
            const currentPolicy = Number.isFinite(policy) && policy === MATCH_POLICY_VERSION;
            // A plain/missing entry written by an older matcher must not hide
            // the repaired matching and search behavior.  Synced and
            // instrumental entries carry no matching risk and are kept.
            if (!currentPolicy && (result.status === 'plain' || result.status === 'missing')) continue;
            cache.set(key, {
              expiresAt: value.expiresAt,
              savedAt: Number(value.savedAt) || 0,
              policy: currentPolicy ? policy : null,
              result,
            });
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
    const entry = {
      expiresAt: now() + Math.max(0, ttl),
      savedAt: now(),
      policy: MATCH_POLICY_VERSION,
      result: sanitized,
    };
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
