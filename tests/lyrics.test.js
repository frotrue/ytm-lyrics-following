import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createLyricsService,
  findActiveLine,
  matchCandidate,
  parseLrc,
  selectSearchCandidate,
} from '../src/shared/lyrics.js';

const track = { title: 'Example Song', artist: 'Example Artist', album: 'Record', duration: 120 };

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

test('parseLrc expands multiple timestamps, metadata, offset, and stable ties', () => {
  const lines = parseLrc('[ar:Artist]\n[offset:500]\n[offset:500][00:02.00][00:01.50]first\n[00:01.5]second\n[00:60.00]bad');
  assert.deepEqual(lines, [
    { time: 1, text: 'first' },
    { time: 1, text: 'second' },
    { time: 1.5, text: 'first' },
  ]);
  assert.equal(findActiveLine(lines, 0.99), -1);
  assert.equal(findActiveLine(lines, 1), 1);
  assert.equal(findActiveLine(lines, 99), 2);
});

test('candidate matching preserves live/remix qualifiers and checks duration', () => {
  assert.equal(matchCandidate({ track_name: 'Example Song', artist_name: 'Example Artist', duration: 121 }, track), true);
  assert.equal(matchCandidate({ track_name: 'Example Song (Live)', artist_name: 'Example Artist', duration: 120 }, track), false);
  assert.equal(matchCandidate({ track_name: 'Example Song', artist_name: 'Example Artist', duration: 160 }, track), false);
  assert.equal(selectSearchCandidate([
    { track_name: 'Example Song', artist_name: 'Example Artist', album_name: 'Record', duration: 120, syncedLyrics: '[00:01.00]ok' },
    { track_name: 'Example Song (Remix)', artist_name: 'Example Artist', duration: 120, syncedLyrics: '[00:01.00]wrong' },
  ], track).syncedLyrics, '[00:01.00]ok');
});

test('service uses /get, falls back to a uniquely matching /search result, and caches it', async () => {
  const calls = [];
  const storageState = {};
  const storage = {
    async get(key) { return { [key]: storageState[key] }; },
    async set(value) { Object.assign(storageState, value); },
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (calls.length === 1) return response(404, {});
    return response(200, [{
      track_name: 'Example Song', artist_name: 'Example Artist', album_name: 'Record', duration: 120,
      syncedLyrics: '[00:01.00]hello\n[00:02.00]world',
    }]);
  };
  const service = createLyricsService({ fetchImpl, storage, now: () => 10_000 });
  const first = await service.getLyrics(track);
  const second = await service.getLyrics(track);
  assert.equal(first.status, 'synced');
  assert.deepEqual(second, first);
  assert.equal(calls.length, 2);
  assert.match(calls[0], /track_name=Example\+Song/);
  assert.match(calls[0], /duration=120/);
  assert.ok(storageState.lyricsCacheV1);
});

test('Promise storage APIs receive only their declared argument', async () => {
  const saved = {};
  const storage = {
    get(...args) {
      assert.equal(args.length, 1);
      return Promise.resolve({ [args[0]]: saved[args[0]] });
    },
    set(...args) {
      assert.equal(args.length, 1);
      Object.assign(saved, args[0]);
      return Promise.resolve();
    },
  };
  let fetches = 0;
  const fetchImpl = async () => {
    fetches += 1;
    return response(200, {
      track_name: track.title,
      artist_name: track.artist,
      album_name: track.album,
      duration: track.duration,
      syncedLyrics: '[00:01.00]cached',
    });
  };
  const first = await createLyricsService({ storage, fetchImpl, now: () => 1000 }).getLyrics(track);
  const second = await createLyricsService({ storage, fetchImpl, now: () => 1000 }).getLyrics(track);
  assert.equal(first.status, 'synced');
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
});

test('service reports timeout as unavailable and does not cache transient errors', async () => {
  let calls = 0;
  const fetchImpl = (_url, options) => {
    calls += 1;
    return new Promise((resolve, reject) => {
      options.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      void resolve;
    });
  };
  const storage = { async get() { return {}; }, async set() { throw new Error('should not persist errors'); } };
  const service = createLyricsService({ fetchImpl, storage, timeoutMs: 5 });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'error');
  assert.match(result.message, /unavailable/i);
  assert.equal(calls, 1);
  assert.equal(service.getCacheSnapshot().size, 0);
});

test('service times out when the response body stalls after headers arrive', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: () => new Promise(() => {}),
  });
  const service = createLyricsService({ fetchImpl, timeoutMs: 5 });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'error');
  assert.match(result.message, /timed out/i);
});

test('negative results use a short cache and malformed tracks are rejected', async () => {
  let calls = 0;
  const service = createLyricsService({
    fetchImpl: async () => { calls += 1; return response(404, {}); },
    negativeTtlMs: 100,
    now: () => 1000,
  });
  assert.equal((await service.getLyrics(track)).status, 'missing');
  assert.equal((await service.getLyrics(track)).status, 'missing');
  assert.equal(calls, 2); // /get and /search on the first request, then cache hit
  assert.equal((await service.getLyrics({ title: '   ', artist: 'A' })).status, 'error');
});
