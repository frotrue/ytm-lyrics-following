import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LyricsContentController } from '../src/content.js';

async function waitFor(predicate, window, message) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function fixture() {
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://music.youtube.com/watch?v=seek-a' });
  const host = { tab: { isConnected: true }, mount: { isConnected: true } };
  let media = { currentTime: 1, duration: 100, paused: true, playCalls: 0, play() { this.playCalls += 1; } };
  const state = { track: { title: 'Seek Song', artist: 'Artist', id: 'seek-a' } };
  const adapter = {
    start() {},
    stop() {},
    getTrack: () => state.track,
    getMedia: () => media,
    getLyricsHost: () => host,
    isLyricsHostCurrent: () => true,
    replaceMedia(next) { media = next; },
  };
  const panel = {
    data: {},
    activeIndex: -1,
    mount() {},
    destroy() {},
    isMountedAt() { return true; },
    setData(data) { this.data = data; },
    setActiveIndex(index) { this.activeIndex = index; },
  };
  const controller = new LyricsContentController({
    document: dom.window.document,
    window: dom.window,
    adapter,
    panel,
    runtime: { sendMessage: async () => ({
      status: 'synced',
      lines: [{ time: 1, text: 'one' }, { time: 4, text: 'four' }, { time: 8, text: 'eight' }],
    }) },
    metadataSettleMs: 0,
    clockIntervalMs: 60_000,
  });
  return { dom, state, adapter, panel, controller, getMedia: () => media };
}

test('seekTo clamps lyric times, preserves paused state, and refreshes active line immediately', async (t) => {
  const { dom, adapter, panel, controller, getMedia } = fixture();
  t.after(() => { controller.stop(); dom.window.close(); });
  controller.start();
  await waitFor(() => controller._lines.length === 3, dom.window, 'lyrics to load');

  assert.equal(controller.seekTo(-3), true);
  assert.equal(getMedia().currentTime, 0);
  assert.equal(getMedia().paused, true);
  assert.equal(getMedia().playCalls, 0);
  assert.equal(panel.activeIndex, -1);

  assert.equal(controller.seekTo(999), true);
  assert.equal(getMedia().currentTime, 100);
  assert.equal(panel.activeIndex, 2);
});

test('seekTo uses a replacement media element and preserves playing state without auto-play', async (t) => {
  const { dom, adapter, controller, getMedia } = fixture();
  t.after(() => { controller.stop(); dom.window.close(); });
  controller.start();
  await waitFor(() => controller._lines.length === 3, dom.window, 'lyrics to load');
  const replacement = { currentTime: 0, duration: 20, paused: false, playCalls: 0, play() { this.playCalls += 1; } };
  adapter.replaceMedia(replacement);

  assert.equal(controller.seekTo(5), true);
  assert.equal(replacement.currentTime, 5);
  assert.equal(replacement.paused, false);
  assert.equal(replacement.playCalls, 0);
  assert.equal(getMedia(), replacement);
});

test('seekTo rejects stale tracks, non-finite input, and unusable media bounds', async (t) => {
  const { dom, state, adapter, controller, getMedia } = fixture();
  t.after(() => { controller.stop(); dom.window.close(); });
  controller.start();
  await waitFor(() => controller._lines.length === 3, dom.window, 'lyrics to load');
  const before = getMedia().currentTime;

  state.track = { title: 'Other Song', artist: 'Artist', id: 'other' };
  assert.equal(controller.seekTo(5), false);
  assert.equal(getMedia().currentTime, before);
  state.track = { title: 'Seek Song', artist: 'Artist', id: 'seek-a' };
  assert.equal(controller.seekTo(Number.NaN), false);
  assert.equal(controller.seekTo(Number.POSITIVE_INFINITY), false);

  const unusable = { currentTime: 3, duration: Number.NaN, paused: true };
  adapter.replaceMedia(unusable);
  assert.equal(controller.seekTo(5), false);
  assert.equal(unusable.currentTime, 3);
});

test('default LyricsPanel receives an onSeek callback wired to controller.seekTo', (t) => {
  const { dom, adapter } = fixture();
  const controller = new LyricsContentController({
    document: dom.window.document,
    window: dom.window,
    adapter,
    runtime: { sendMessage: async () => ({ status: 'missing' }) },
  });
  t.after(() => { controller.stop(); dom.window.close(); });
  // This property is supplied by the panel implementation owned by the UI
  // agent; the controller contract is that it receives this callback.
  assert.equal(typeof controller.panel?.onSeek, 'function');
  const calls = [];
  controller.seekTo = (time) => { calls.push(time); return true; };
  assert.equal(controller.panel.onSeek(3.25), true);
  assert.deepEqual(calls, [3.25]);
});
