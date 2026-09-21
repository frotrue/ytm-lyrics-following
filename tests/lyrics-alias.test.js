import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cacheKey,
  compareCandidate,
  createLyricsService,
  matchCandidate,
  selectSearchCandidate,
} from '../src/shared/lyrics.js';

/*
 * Candidate metadata below mirrors the 2026-09-21 LRCLIB snapshot for the
 * observed bilingual-title false negative (record ids, titles, artists,
 * albums and durations).  Every lyric body is a short synthetic string
 * written for these tests, never the real copyrighted text.
 */
const SYNCED_A = '[00:01.00]synthetic synced line A';
const SYNCED_B = '[00:01.00]synthetic synced line B';
const PLAIN = 'synthetic plain lyrics';

const OORT = {
  synced207: { id: 8570392, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA', albumName: 'END THEORY', duration: 207, instrumental: false, syncedLyrics: SYNCED_A, plainLyrics: PLAIN },
  synced206: { id: 26059383, trackName: 'Oort Cloud (오르트구름)', artistName: 'Younha', albumName: 'END THEORY : Final Edition', duration: 206.626667, instrumental: false, syncedLyrics: SYNCED_A, plainLyrics: PLAIN },
  compositeArtist: { id: 36589132, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA (윤하)', albumName: "YOUNHA 6th Album 'END THEORY'", duration: 206, instrumental: false, syncedLyrics: SYNCED_A, plainLyrics: PLAIN },
  short90: { id: 36002291, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA', albumName: 'END THEORY', duration: 90, instrumental: false, syncedLyrics: SYNCED_A, plainLyrics: PLAIN },
  short140: { id: 36068667, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA', albumName: 'END THEORY', duration: 140, instrumental: false, syncedLyrics: SYNCED_A, plainLyrics: PLAIN },
  koreanPlain: { id: 34051725, trackName: '오르트구름', artistName: '윤하', albumName: 'END THEORY', duration: 206, instrumental: false, plainLyrics: PLAIN },
  unrelatedArtist: { id: 9990001, trackName: 'Oort Cloud (오르트구름)', artistName: 'Unrelated Oort Band', albumName: 'Elsewhere', duration: 207, instrumental: false, syncedLyrics: SYNCED_A },
};

function response(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

function routeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url) => {
    const target = String(url);
    calls.push(target);
    for (const [matches, handler] of routes) {
      if (matches(target)) return handler(target);
    }
    return response(404, {});
  };
  return { fetchImpl, calls };
}

function memoryStorage(initial = {}) {
  const state = { ...initial };
  return {
    state,
    api: {
      async get(key) { return { [key]: state[key] }; },
      async set(value) { Object.assign(state, value); },
    },
  };
}

test('observed bilingual false negative now matches while wrong durations and artists are rejected', () => {
  const track = { title: '오르트구름', artist: 'YOUNHA', album: 'END THEORY', duration: 207 };
  assert.equal(compareCandidate(OORT.synced207, track), 'alias');
  assert.equal(matchCandidate(OORT.synced207, track), true);
  assert.equal(matchCandidate(OORT.synced206, track), true);
  assert.equal(matchCandidate(OORT.short90, track), false);
  assert.equal(matchCandidate(OORT.short140, track), false);
  assert.equal(matchCandidate(OORT.unrelatedArtist, track), false);
  assert.equal(matchCandidate(OORT.compositeArtist, track), true);
});

test('explicit bilingual pairing works in both directions and for another synthetic song', () => {
  const korean = { title: '오르트구름', artist: 'YOUNHA', duration: 207 };
  const bilingual = { title: 'Oort Cloud (오르트구름)', artist: 'YOUNHA', duration: 207 };
  assert.equal(compareCandidate({ trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA', duration: 207 }, korean), 'alias');
  assert.equal(compareCandidate({ trackName: '오르트구름', artistName: 'YOUNHA', duration: 207 }, bilingual), 'alias');
  assert.equal(compareCandidate(bilingual, korean), 'alias');

  const synthetic = { title: '겨울 편지', artist: '하늘바다', album: 'Synthetic Album', duration: 245 };
  const syntheticCandidate = { trackName: 'Winter Letter (겨울 편지)', artistName: 'Haneul Bada (하늘바다)', albumName: 'Synthetic Album', duration: 245, syncedLyrics: SYNCED_B };
  assert.equal(compareCandidate(syntheticCandidate, synthetic), 'alias');
  assert.equal(matchCandidate(syntheticCandidate, synthetic), true);
  assert.equal(selectSearchCandidate([syntheticCandidate], synthetic).id, undefined);
});

test('version and collaboration qualifiers are never treated as aliases', () => {
  const korean = { title: '노래', artist: '가수', duration: 200 };
  for (const qualifier of ['Live', 'Remix', 'Acoustic', 'Inst.', 'Demo', '라이브', '리믹스', '어쿠스틱', '반주', '버전']) {
    assert.equal(
      matchCandidate({ trackName: '노래 (' + qualifier + ')', artistName: '가수', duration: 200 }, korean),
      false,
      qualifier,
    );
  }
  assert.equal(matchCandidate({ trackName: '노래 (Song)', artistName: '가수', duration: 200 }, korean), true);

  const solo = { title: 'Song', artist: 'Singer', duration: 200 };
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Singer feat. Guest', duration: 200 }, solo), false);
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Singer & Guest', duration: 200 }, solo), false);
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Singer with Guest', duration: 200 }, solo), false);
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Singer (게스트)', duration: 200 }, solo), true);
});

test('different songs that share one bracketed word are rejected', () => {
  const artist = '가수';
  assert.equal(matchCandidate({ trackName: '봄 (Spring)', artistName: artist, duration: 200 }, { title: '여름 (Spring)', artist, duration: 200 }), false);
  assert.equal(matchCandidate({ trackName: '봄 (Spring)', artistName: artist, duration: 200 }, { title: '봄 (Summer)', artist, duration: 200 }), false);
  assert.equal(matchCandidate({ trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA', duration: 207 }, { title: '오르트구름', artist: 'YOUNHA', duration: 207 }), true);
});

test('alias matches need a real, close duration while exact matches keep the old tolerance', () => {
  const track = { title: 'Song', artist: 'Artist', duration: 200 };
  const aliasAt = (duration) => ({ trackName: 'Song (노래)', artistName: 'Artist', duration });
  assert.equal(matchCandidate(aliasAt(198), track), true);
  assert.equal(matchCandidate(aliasAt(202), track), true);
  assert.equal(matchCandidate(aliasAt(197.9), track), false);
  assert.equal(matchCandidate(aliasAt(202.1), track), false);
  assert.equal(matchCandidate(aliasAt(0), track), false);
  assert.equal(matchCandidate({ trackName: 'Song (노래)', artistName: 'Artist' }, track), false);
  assert.equal(matchCandidate({ trackName: 'Song (노래)', artistName: 'Artist' }, { title: 'Song', artist: 'Artist' }), false);
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Artist' }, track), true);
  assert.equal(matchCandidate({ trackName: 'Song', artistName: 'Artist', duration: 200 }, { title: 'Song', artist: 'Artist' }), true);
});

test('search relaxes the album filter but still validates every candidate', async () => {
  const track = { title: '오르트구름', artist: 'YOUNHA', album: 'END THEORY', duration: 207 };
  const { fetchImpl, calls } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [(url) => url.includes('album_name='), () => response(200, [])],
    [(url) => url.includes('artist_name='), () => response(200, [OORT.synced207, OORT.short90, OORT.unrelatedArtist])],
    [() => true, () => response(200, [])],
  ]);
  const service = createLyricsService({ fetchImpl, storage: null });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'synced');
  assert.equal(result.lines.length, 1);
  assert.ok(calls.some((url) => url.includes('/search') && !url.includes('album_name')));
});

test('the search plan is bounded and deduplicated', async () => {
  const noAlbum = { title: 'No Album Song', artist: 'Artist', duration: 100 };
  const first = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [() => true, () => response(200, [])],
  ]);
  const firstService = createLyricsService({ fetchImpl: first.fetchImpl, storage: null });
  assert.equal((await firstService.getLyrics(noAlbum)).status, 'missing');
  assert.equal(first.calls.length, 3); // /get plus two distinct searches
  assert.equal(new Set(first.calls).size, 3);

  const withAlias = { title: 'Oort Cloud (오르트구름)', artist: 'YOUNHA', album: 'END THEORY', duration: 207 };
  const second = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [() => true, () => response(200, [])],
  ]);
  const secondService = createLyricsService({ fetchImpl: second.fetchImpl, storage: null });
  assert.equal((await secondService.getLyrics(withAlias)).status, 'missing');
  assert.equal(second.calls.filter((url) => url.includes('/search')).length, 5);
  assert.equal(new Set(second.calls).size, 6);
});

test('equal-scoring records with different ids are rejected as ambiguous', async () => {
  const track = { title: 'Twin Song', artist: 'Artist', album: 'Album', duration: 200 };
  const twinA = { id: 501, trackName: 'Twin Song (쌍둥이)', artistName: 'Artist', albumName: 'Album', duration: 200, syncedLyrics: SYNCED_A };
  const twinB = { id: 502, trackName: 'Twin Song (쌍둥이)', artistName: 'Artist', albumName: 'Album', duration: 200, syncedLyrics: SYNCED_B };
  const { fetchImpl } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [(url) => url.includes('album_name='), () => response(200, [twinA])],
    [(url) => url.includes('artist_name='), () => response(200, [twinB])],
    [() => true, () => response(200, [])],
  ]);
  const service = createLyricsService({ fetchImpl, storage: null });
  assert.equal((await service.getLyrics(track)).status, 'missing');
});

test('the same record reappearing across searches is deduplicated', async () => {
  const track = { title: 'Twin Song', artist: 'Artist', album: 'Album', duration: 200 };
  const twin = { id: 501, trackName: 'Twin Song (쌍둥이)', artistName: 'Artist', albumName: 'Album', duration: 200, syncedLyrics: SYNCED_A };
  const { fetchImpl, calls } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [(url) => url.includes('album_name='), () => response(200, [twin])],
    [(url) => url.includes('artist_name='), () => response(200, [twin])],
    [() => true, () => response(200, [twin])],
  ]);
  const service = createLyricsService({ fetchImpl, storage: null });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'synced');
  assert.equal(calls.length, 4);
});

test('a valid plain result survives empty, failing, malformed, and ambiguous supplemental searches', async () => {
  const track = { title: '오르트구름', artist: '윤하', album: 'END THEORY', duration: 207 };
  const twinA = { id: 601, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA (윤하)', albumName: 'END THEORY', duration: 206, syncedLyrics: SYNCED_A };
  const twinB = { id: 602, trackName: 'Oort Cloud (오르트구름)', artistName: 'YOUNHA (윤하)', albumName: 'END THEORY', duration: 206, syncedLyrics: SYNCED_B };
  const cases = [
    ['empty', () => response(200, [])],
    ['ambiguous', () => response(200, [twinA, twinB])],
    ['http failure', () => response(503, {})],
    ['malformed', () => response(200, { message: 'not an array' })],
  ];
  for (const [label, handler] of cases) {
    const { fetchImpl } = routeFetch([
      [(url) => url.includes('/api/get'), () => response(200, OORT.koreanPlain)],
      [() => true, handler],
    ]);
    const service = createLyricsService({ fetchImpl, storage: null, sleep: async () => {}, retryDelayMs: 0 });
    const result = await service.getLyrics(track);
    assert.equal(result.status, 'plain', label);
    assert.equal(result.plainLyrics, PLAIN, label);
  }
});

test('a plain result is upgraded to synced only for a uniquely validated synced record', async () => {
  const track = { title: '오르트구름', artist: '윤하', album: 'END THEORY', duration: 207 };
  const { fetchImpl, calls } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(200, OORT.koreanPlain)],
    [(url) => url.includes('artist_name='), () => response(200, [OORT.koreanPlain])],
    [() => true, () => response(200, [OORT.compositeArtist, OORT.synced207])],
  ]);
  const service = createLyricsService({ fetchImpl, storage: null });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'synced');
  assert.equal(result.lines.length, 1);
  assert.equal(calls.length, 4);
});

test('a synced or instrumental /get result returns immediately without searches', async () => {
  const track = { title: 'Fast Song', artist: 'Artist', album: 'Album', duration: 100 };
  const synced = routeFetch([
    [(url) => url.includes('/api/get'), () => response(200, { trackName: 'Fast Song', artistName: 'Artist', albumName: 'Album', duration: 100, syncedLyrics: SYNCED_A })],
  ]);
  assert.equal((await createLyricsService({ fetchImpl: synced.fetchImpl, storage: null }).getLyrics(track)).status, 'synced');
  assert.equal(synced.calls.length, 1);

  const instrumental = routeFetch([
    [(url) => url.includes('/api/get'), () => response(200, { trackName: 'Fast Song', artistName: 'Artist', albumName: 'Album', duration: 100, instrumental: true })],
  ]);
  assert.equal((await createLyricsService({ fetchImpl: instrumental.fetchImpl, storage: null }).getLyrics(track)).status, 'instrumental');
  assert.equal(instrumental.calls.length, 1);
});

test('an initial provider failure stays an error and is never cached as missing', async () => {
  const track = { title: '오르트구름', artist: 'YOUNHA', album: 'END THEORY', duration: 207 };
  let calls = 0;
  const service = createLyricsService({
    fetchImpl: async () => { calls += 1; return response(503, {}); },
    sleep: async () => {},
    retryDelayMs: 0,
  });
  const result = await service.getLyrics(track);
  assert.equal(result.status, 'error');
  assert.match(result.message, /HTTP 503/);
  assert.equal(calls, 3); // initial attempt plus two bounded retries, and no search
  assert.equal(service.getCacheSnapshot().size, 0);
});

test('legacy plain and missing cache entries are discarded while legacy synced entries are kept', async () => {
  const plainTrack = { title: 'Legacy Plain', artist: 'Artist', duration: 100 };
  const missingTrack = { title: 'Legacy Missing', artist: 'Artist', duration: 100 };
  const syncedTrack = { title: 'Legacy Synced', artist: 'Artist', duration: 100 };
  const instrumentalTrack = { title: 'Legacy Instrumental', artist: 'Artist', duration: 100 };
  const storage = memoryStorage({
    lyricsCacheV1: {
      [cacheKey(plainTrack)]: { expiresAt: 10_000, savedAt: 1, result: { status: 'plain', plainLyrics: 'stale plain' } },
      [cacheKey(missingTrack)]: { expiresAt: 10_000, savedAt: 1, result: { status: 'missing' } },
      [cacheKey(syncedTrack)]: { expiresAt: 10_000, savedAt: 1, result: { status: 'synced', lines: [{ time: 1, text: 'kept' }] } },
      [cacheKey(instrumentalTrack)]: { expiresAt: 10_000, savedAt: 1, result: { status: 'instrumental' } },
    },
  });
  const { fetchImpl, calls } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [() => true, () => response(200, [])],
  ]);
  const service = createLyricsService({ fetchImpl, storage: storage.api, now: () => 1000 });

  const kept = await service.getLyrics(syncedTrack);
  assert.equal(kept.status, 'synced');
  assert.equal(kept.lines[0].text, 'kept');
  assert.equal(calls.length, 0);
  assert.equal(service.getCacheSnapshot().has(cacheKey(missingTrack)), false);
  assert.equal(service.getCacheSnapshot().has(cacheKey(plainTrack)), false);
  assert.equal((await service.getLyrics(instrumentalTrack)).status, 'instrumental');
  assert.equal(calls.length, 0);

  assert.equal((await service.getLyrics(plainTrack)).status, 'missing'); // stale plain ignored
  assert.ok(calls.length > 0);
  assert.equal(storage.state.lyricsCacheV1[cacheKey(plainTrack)].policy, 2);

  const before = calls.length;
  const reopened = createLyricsService({ fetchImpl, storage: storage.api, now: () => 1000 });
  assert.equal((await reopened.getLyrics(plainTrack)).status, 'missing');
  assert.equal(calls.length, before); // current-policy entries survive a restart
});

test('cache identities stay separate for alias variants and different artists', () => {
  assert.notEqual(cacheKey({ title: 'Song', artist: 'Artist' }), cacheKey({ title: 'Song (노래)', artist: 'Artist' }));
  assert.notEqual(cacheKey({ title: 'Song (노래)', artist: 'Artist' }), cacheKey({ title: 'Song (노래)', artist: 'Other' }));
  assert.notEqual(cacheKey({ title: 'Song', artist: 'Artist' }), cacheKey({ title: 'Song (Live)', artist: 'Artist' }));
});

test('alias parsing preserves Unicode equivalence and rejects malformed or qualified pairs', () => {
  const track = { title: '겨울 편지', artist: '하늘바다', duration: 245 };
  const candidate = { trackName: 'Winter Letter [겨울 편지]', artistName: 'Haneul Bada (하늘바다)', duration: 245 };
  assert.equal(matchCandidate(candidate, { ...track, title: track.title.normalize('NFD'), artist: track.artist.normalize('NFD') }), true);
  for (const title of ['Winter Letter (겨울 편지]', 'Winter Letter [겨울 편지)', '겨울 편지 (Live)', 'Winter Letter (라이브버전)']) {
    assert.equal(matchCandidate({ ...candidate, trackName: title }, { ...track, title: title.startsWith('겨울') ? '겨울 편지' : 'Winter Letter' }), false, title);
  }
  assert.equal(matchCandidate({ ...candidate, artistName: 'Singer/Guest (하늘바다)' }, track), false);
});

test('plain lyrics found in search survive a later failure and can upgrade to synced', async () => {
  const track = { title: '오르트구름', artist: '윤하', album: 'END THEORY', duration: 207 };
  const outcomes = [
    ['empty', () => response(200, []), 'plain'],
    ['HTTP', () => response(503, {}), 'plain'],
    ['malformed', () => response(200, {}), 'plain'],
    ['network', () => { throw new Error('offline'); }, 'plain'],
    ['timeout', () => new Promise(() => {}), 'plain'],
    ['synced', () => response(200, [OORT.compositeArtist]), 'synced'],
  ];
  for (const [label, later, expected] of outcomes) {
    const { fetchImpl, calls } = routeFetch([
      [(url) => url.includes('/api/get'), () => response(404, {})],
      [(url) => url.includes('album_name='), () => response(200, [OORT.koreanPlain])],
      [() => true, later],
    ]);
    const result = await createLyricsService({ fetchImpl, storage: null, maxRetries: 0, timeoutMs: 20 }).getLyrics(track);
    assert.equal(result.status, expected, label);
    if (expected === 'plain') assert.equal(result.plainLyrics, PLAIN, label);
    assert.ok(calls.length <= 4, label);
  }
});

test('a later tie invalidates an earlier plain search fallback', async () => {
  const track = { title: '노래', artist: 'Artist', album: 'Album', duration: 200 };
  const first = { id: 801, trackName: 'Song (노래)', artistName: 'Artist', albumName: 'Album', duration: 200, plainLyrics: PLAIN };
  const { fetchImpl } = routeFetch([
    [(url) => url.includes('/api/get'), () => response(404, {})],
    [(url) => url.includes('album_name='), () => response(200, [first])],
    [() => true, () => response(200, [{ ...first, id: 802, plainLyrics: 'different synthetic lyrics' }])],
  ]);
  assert.equal((await createLyricsService({ fetchImpl, storage: null }).getLyrics(track)).status, 'missing');
});

test('record identity ignores JSON property order but rejects conflicting record data', async () => {
  const track = { title: '오르트구름', artist: 'YOUNHA', album: 'END THEORY', duration: 207 };
  for (const conflict of [false, true]) {
    const reordered = Object.fromEntries(Object.entries(OORT.synced207).reverse());
    if (conflict) reordered.syncedLyrics = SYNCED_B;
    const { fetchImpl } = routeFetch([
      [(url) => url.includes('/api/get'), () => response(404, {})],
      [(url) => url.includes('album_name='), () => response(200, [OORT.synced207])],
      [() => true, () => response(200, [reordered])],
    ]);
    assert.equal((await createLyricsService({ fetchImpl, storage: null }).getLyrics(track)).status, conflict ? 'missing' : 'synced');
  }
});

test('exact metadata outranks a closer alias and ties are rejected', () => {
  const track = { title: 'Song', artist: 'Artist', album: 'Album', duration: 200 };
  const exact = { id: 1, trackName: 'Song', artistName: 'Artist', albumName: 'Album', duration: 202, syncedLyrics: SYNCED_A };
  const alias = { id: 2, trackName: 'Song (노래)', artistName: 'Artist', albumName: 'Album', duration: 200, syncedLyrics: SYNCED_B };
  assert.equal(selectSearchCandidate([alias, exact], track).id, 1);

  const aliasNear = { id: 3, trackName: 'Song (노래)', artistName: 'Artist', albumName: 'Album', duration: 200, syncedLyrics: SYNCED_A };
  const aliasFar = { id: 4, trackName: 'Song (노래)', artistName: 'Artist', albumName: 'Album', duration: 201, syncedLyrics: SYNCED_B };
  assert.equal(selectSearchCandidate([aliasFar, aliasNear], track).id, 3);

  assert.equal(selectSearchCandidate([{ ...exact, id: 5 }, { ...exact, id: 6 }], track), null);
  assert.equal(selectSearchCandidate([{ trackName: 'Other', artistName: 'Artist', duration: 200 }], track), null);
});
