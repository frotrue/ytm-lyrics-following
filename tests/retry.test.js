import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LyricsContentController } from '../src/content.js';

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Expected lyrics state did not arrive');
}

test('Retry recovers a failed lookup for the same track without switching tabs or restarting playback', async t => {
  const dom = new JSDOM(`<!doctype html><body>
    <ytmusic-player-bar>
      <yt-formatted-string class="title ytmusic-player-bar">Test song</yt-formatted-string>
      <yt-formatted-string class="byline ytmusic-player-bar"><a href="channel/test">Test artist</a></yt-formatted-string>
    </ytmusic-player-bar>
    <video></video>
    <ytmusic-tab-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
      <ytmusic-section-list-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS">
        <ytmusic-description-shelf-renderer page-type="MUSIC_PAGE_TYPE_TRACK_LYRICS" is-track-lyrics-page><div>Native lyrics</div></ytmusic-description-shelf-renderer>
      </ytmusic-section-list-renderer>
    </ytmusic-tab-renderer>
  </body>`, { url: 'https://music.youtube.com/watch?v=test' });
  const media = dom.window.document.querySelector('video');
  Object.defineProperty(media, 'duration', { value: 120 });
  let calls = 0;
  const controller = new LyricsContentController({
    document: dom.window.document, window: dom.window, metadataSettleMs: 0,
    runtime: { sendMessage: async () => {
      calls++;
      return calls === 1
        ? { status: 'error', message: 'Lyrics service unavailable: HTTP 503' }
        : { status: 'synced', lines: [{ time: 1, text: 'Recovered line' }] };
    } },
  });
  t.after(() => { controller.stop(); dom.window.close(); });
  controller.start();
  await waitFor(() => controller.panel.shadow?.querySelector('.retry'));
  assert.equal(calls, 1);
  controller.panel.shadow.querySelector('.retry').click();
  await waitFor(() => controller.panel.data.status === 'synced');
  assert.equal(calls, 2);
  assert.equal(controller.panel.shadow.querySelector('.line').textContent, 'Recovered line');
  assert.equal(controller.panel.shadow.querySelector('.retry'), null);
  assert.equal(media.paused, true);
  assert.equal(media.currentTime, 0);
});
