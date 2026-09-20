import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { YouTubeMusicAdapter, trackIdentity } from '../src/content/adapter.js';

function liveDom() {
  const dom = new JSDOM(`<!doctype html><body>
    <ytmusic-player-bar>
      <div class="content-info-wrapper">
        <yt-formatted-string class="title ytmusic-player-bar" title="Stay This Way">Stay This Way</yt-formatted-string>
        <yt-formatted-string class="byline ytmusic-player-bar">
          <a href="channel/UCexample">fromis_9</a><span> • </span><a href="browse/MPREexample">from our Memento Box</a>
        </yt-formatted-string>
      </div>
    </ytmusic-player-bar>
    <ytmusic-player><video class="video-stream html5-main-video"></video></ytmusic-player>
    <ytmusic-tab-renderer id="tab-renderer" class="scroller" page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
      <ytmusic-section-list-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
        <div id="contents">
          <ytmusic-description-shelf-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS" is-track-lyrics-page expanded>
            <div class="wrapper">native lyrics</div><dom-if></dom-if>
          </ytmusic-description-shelf-renderer>
        </div>
      </ytmusic-section-list-renderer>
    </ytmusic-tab-renderer>
    <ytmusic-player-queue hidden></ytmusic-player-queue>
  </body>`, { url: 'https://music.youtube.com/watch?v=video-123' });
  const media = dom.window.document.querySelector('video');
  Object.defineProperty(media, 'duration', { configurable: true, value: 196 });
  return dom;
}

test('adapter reads the verified player bar DOM and confines replacement to the lyrics shelf', () => {
  const dom = liveDom();
  const adapter = new YouTubeMusicAdapter({ document: dom.window.document, window: dom.window });

  assert.deepEqual(adapter.getTrack(), {
    title: 'Stay This Way',
    artist: 'fromis_9',
    album: 'from our Memento Box',
    duration: 196,
    id: 'video-123',
  });
  assert.equal(trackIdentity(adapter.getTrack()), 'video:video-123|stay this way|fromis_9|from our memento box|196');

  const host = adapter.getLyricsHost();
  assert.equal(host.mount.localName, 'ytmusic-description-shelf-renderer');
  assert.equal(host.nativeContainer, host.mount);
  assert.equal(host.replaceNative, true);
  assert.equal(adapter.isLyricsHostCurrent(host), true);
  assert.equal(dom.window.document.querySelector('ytmusic-player-queue').hidden, true);
});

test('adapter observes page-type-only tab changes without waiting for its fallback poll', async () => {
  const dom = liveDom();
  let invalidations = 0;
  const adapter = new YouTubeMusicAdapter({
    document: dom.window.document,
    window: dom.window,
    debounceMs: 0,
    onInvalidate: () => { invalidations += 1; },
  });
  adapter.start();
  dom.window.document.querySelector('ytmusic-tab-renderer').removeAttribute('page-type');
  await new Promise((resolve) => dom.window.setTimeout(resolve, 10));
  adapter.stop();

  assert.ok(invalidations >= 1);
});

test('adapter does not nominate a non-lyrics tab for replacement', () => {
  const dom = liveDom();
  const tab = dom.window.document.querySelector('ytmusic-tab-renderer');
  tab.removeAttribute('page-type');
  const adapter = new YouTubeMusicAdapter({ document: dom.window.document, window: dom.window });

  assert.equal(adapter.getLyricsHost(), null);
});
