import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LyricsContentController } from '../src/content.js';
import { LyricsPanel, ROOT_ID } from '../src/content/panel.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function waitFor(predicate, window, message = 'condition was not met') {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => window.setTimeout(resolve, 5));
  }
  assert.fail(message);
}

function fixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <ytmusic-tab-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
      <ytmusic-section-list-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
        <ytmusic-description-shelf-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS" is-track-lyrics-page>
          <div id="native">native lyrics</div>
        </ytmusic-description-shelf-renderer>
      </ytmusic-section-list-renderer>
    </ytmusic-tab-renderer>
  </body>`, { url: 'https://music.youtube.com/watch?v=video-a' });
  const shelf = dom.window.document.querySelector('ytmusic-description-shelf-renderer');
  const media = { currentTime: 1.1 };
  const state = { track: { title: 'A', artist: 'Artist', id: 'video-a' } };
  const adapter = {
    start() {}, stop() {},
    getTrack: () => state.track,
    getMedia: () => media,
    getLyricsHost: () => ({ tab: dom.window.document.querySelector('ytmusic-tab-renderer'), mount: shelf, nativeContainer: shelf, replaceNative: true }),
    isLyricsHostCurrent: (host) => host.tab.isConnected && host.tab.getAttribute('page-type') === 'MUSIC_PAGE_TYPE_TRACK_LYRICS',
  };
  return { dom, shelf, state, adapter };
}

test('a late response for an old track cannot overwrite newer lyrics', async (t) => {
  const { dom, adapter, state } = fixture();
  const requests = [];
  const runtime = { sendMessage: (message) => {
    const request = deferred();
    requests.push({ message, request });
    return request.promise;
  } };
  const panel = new LyricsPanel({ document: dom.window.document, window: dom.window });
  const controller = new LyricsContentController({
    document: dom.window.document,
    window: dom.window,
    runtime,
    adapter,
    panel,
    clockIntervalMs: 60_000,
    metadataSettleMs: 0,
  });
  t.after(() => {
    controller.stop();
    dom.window.close();
  });

  controller.start();
  await waitFor(() => requests.length === 1, dom.window, 'initial lyric request');
  assert.equal(requests[0].message.track.title, 'A');

  state.track = { title: 'B', artist: 'Artist', id: 'video-b' };
  controller.refresh();
  await waitFor(() => requests.length === 2, dom.window, 'second lyric request');
  assert.equal(requests[1].message.track.title, 'B');
  requests[1].request.resolve({ status: 'synced', lines: [{ time: 1, text: 'new line' }], source: 'test' });
  await waitFor(() => panel.data.lines[0]?.text === 'new line', dom.window, 'new lyrics to render');
  requests[0].request.resolve({ status: 'synced', lines: [{ time: 1, text: 'old line' }], source: 'test' });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));

  assert.deepEqual(panel.data.lines, [{ time: 1, text: 'new line' }]);
  assert.equal(panel.shadow.querySelector('.line').textContent, 'new line');
});

test('leaving the lyrics tab invalidates an in-flight response and re-entry starts a new request', async (t) => {
  const { dom, adapter } = fixture();
  const requests = [];
  const runtime = { sendMessage: () => {
    const request = deferred();
    requests.push(request);
    return request.promise;
  } };
  const panel = new LyricsPanel({ document: dom.window.document, window: dom.window });
  const controller = new LyricsContentController({
    document: dom.window.document,
    window: dom.window,
    runtime,
    adapter,
    panel,
    clockIntervalMs: 60_000,
    metadataSettleMs: 0,
  });
  t.after(() => {
    controller.stop();
    dom.window.close();
  });

  controller.start();
  await waitFor(() => requests.length === 1, dom.window, 'initial lyric request');
  const tab = dom.window.document.querySelector('ytmusic-tab-renderer');
  tab.removeAttribute('page-type');
  await controller.refresh();
  requests[0].resolve({ status: 'synced', lines: [{ time: 1, text: 'stale' }] });
  await new Promise((resolve) => dom.window.setTimeout(resolve, 0));
  assert.equal(panel.root, null);

  tab.setAttribute('page-type', 'MUSIC_PAGE_TYPE_TRACK_LYRICS');
  controller.refresh();
  await waitFor(() => requests.length === 2, dom.window, 're-entry lyric request');
  requests[1].resolve({ status: 'synced', lines: [{ time: 1, text: 'fresh' }] });
  await waitFor(() => panel.data.lines[0]?.text === 'fresh', dom.window, 'fresh lyrics to render');
  assert.equal(panel.shadow.querySelector('.line').textContent, 'fresh');
});

test('panel restores only the native lyrics shelf after content cleanup', () => {
  const { dom, shelf } = fixture();
  const native = shelf.querySelector('#native');
  const panel = new LyricsPanel({ document: dom.window.document, window: dom.window });
  assert.equal(panel.mount({ mount: shelf, nativeContainer: shelf, replaceNative: true }), true);
  assert.equal(native.hidden, true);
  assert.equal(shelf.querySelector(`#${ROOT_ID}`).shadowRoot != null, true);

  panel.destroy();
  assert.equal(native.hidden, false);
  assert.equal(native.hasAttribute('aria-hidden'), false);
  assert.equal(shelf.querySelector(`#${ROOT_ID}`), null);
});

test('panel clears emphasis before the first timestamp and recomputes past lines after a backward seek', () => {
  const { dom, shelf } = fixture();
  const panel = new LyricsPanel({ document: dom.window.document, window: dom.window });
  panel.mount({ mount: shelf, nativeContainer: shelf, replaceNative: true });
  panel.setData({ status: 'synced', lines: [
    { time: 1, text: 'one' }, { time: 2, text: 'two' }, { time: 3, text: 'three' },
  ] });
  panel.setActiveIndex(2);
  panel.setActiveIndex(0);
  assert.equal(panel.lineNodes[0].classList.contains('active'), true);
  assert.equal(panel.lineNodes[1].classList.contains('past'), false);
  assert.equal(panel.lineNodes[2].classList.contains('past'), false);

  panel.setActiveIndex(-1);
  assert.equal(panel.lineNodes.some((node) => node.classList.contains('active') || node.classList.contains('past')), false);
  panel.destroy();
});
