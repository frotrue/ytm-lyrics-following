import test from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { LyricsPanel } from '../src/content/panel.js';

function makeFixture() {
  const dom = new JSDOM(`<!doctype html><body>
    <ytmusic-player><div id="song-image"></div></ytmusic-player>
    <div id="side-panel"><ytmusic-description-shelf-renderer><div>native</div></ytmusic-description-shelf-renderer></div>
  </body>`);
  const document = dom.window.document;
  return {
    dom,
    document,
    shelf: document.querySelector('ytmusic-description-shelf-renderer'),
    artwork: document.querySelector('#song-image'),
    sidePanel: document.querySelector('#side-panel'),
  };
}

function rect({ left, top, width, height }) {
  return {
    left, top, width, height,
    right: left + width,
    bottom: top + height,
    x: left, y: top,
    toJSON() { return this; },
  };
}

test('synced lyric lines are native seek buttons and keyboard events stay inside the panel', (t) => {
  const { dom, document, shelf } = makeFixture();
  const seeks = [];
  const panel = new LyricsPanel({ document, window: dom.window, onSeek: (time) => seeks.push(time) });
  t.after(() => {
    panel.destroy();
    dom.window.close();
  });
  panel.mount({ mount: shelf });
  panel.setData({ status: 'synced', lines: [{ time: 83.77, text: 'A lyric line' }] });

  const line = panel.shadow.querySelector('button.line');
  assert.ok(line);
  assert.equal(line.type, 'button');
  assert.equal(line.dataset.time, '83.77');
  assert.equal(line.title, 'Jump to 1:23');
  assert.match(line.getAttribute('aria-label'), /^Jump to 1:23:/);

  line.click();
  assert.deepEqual(seeks, [83.77]);
  assert.equal(panel._followPausedUntil, 0);

  let escapedKeys = 0;
  document.addEventListener('keydown', () => { escapedKeys += 1; });
  panel._followPausedUntil = 123;
  line.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: ' ', bubbles: true, composed: true }));
  line.dispatchEvent(new dom.window.KeyboardEvent('keyup', { key: 'Enter', bubbles: true, composed: true }));
  assert.equal(escapedKeys, 0);
  assert.equal(panel._followPausedUntil, 123);
});

test('artwork alignment follows a side-by-side cover and clears when the layout stacks', (t) => {
  const { dom, document, shelf, artwork, sidePanel } = makeFixture();
  const panel = new LyricsPanel({ document, window: dom.window });
  t.after(() => {
    panel.destroy();
    dom.window.close();
  });
  panel.mount({ mount: shelf });

  let rootLeft = 1698;
  artwork.getBoundingClientRect = () => rect({ left: 569, top: 296.667, width: 800, height: 800 });
  sidePanel.getBoundingClientRect = () => rect({ left: 1698, top: 128, width: 766, height: 1105 });
  panel.root.getBoundingClientRect = () => {
    const offset = Number(panel.root.dataset.ytmArtworkOffset || 0);
    return rect({ left: rootLeft, top: 176.667 + offset, width: 766, height: Number.parseFloat(panel.root.style.height) || 593 });
  };

  assert.equal(panel.refreshArtworkAlignment(), true);
  assert.ok(Math.abs(Number.parseFloat(panel.root.style.marginTop) - 120) < 0.001);
  assert.equal(panel.root.style.height, '800px');
  assert.equal(panel.root.hasAttribute('data-ytm-artwork-aligned'), true);

  rootLeft = 104;
  artwork.getBoundingClientRect = () => rect({ left: 227, top: 128, width: 402, height: 402 });
  assert.equal(panel.refreshArtworkAlignment(), false);
  assert.equal(panel.root.style.marginTop, '');
  assert.equal(panel.root.style.height, '');
  assert.equal(panel.root.hasAttribute('data-ytm-artwork-aligned'), false);
});

test('edge padding derives from the scroll viewport and a resize recenters the active line only when needed', (t) => {
  const { dom, document, shelf } = makeFixture();
  const panel = new LyricsPanel({ document, window: dom.window });
  t.after(() => {
    panel.destroy();
    dom.window.close();
  });
  panel.mount({ mount: shelf });
  panel.setData({ status: 'synced', lines: [{ time: 1, text: 'one' }, { time: 2, text: 'two' }] });
  const scroll = panel.scroll;
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 500 });
  scroll.getBoundingClientRect = () => rect({ left: 0, top: 100, width: 300, height: 500 });
  Object.defineProperty(scroll, 'clientTop', { configurable: true, value: 0 });
  Object.defineProperty(scroll, 'scrollTop', { configurable: true, writable: true, value: 0 });
  let calls = 0;
  scroll.scrollTo = ({ top }) => { calls += 1; scroll.scrollTop = top; };
  panel.lineNodes[0].getBoundingClientRect = () => rect({ left: 0, top: 150, width: 280, height: 40 });
  panel.lineNodes[1].getBoundingClientRect = () => rect({ left: 0, top: 650 - scroll.scrollTop, width: 280, height: 40 });

  panel.setActiveIndex(1);
  panel._updateLyricsEdgePadding();
  assert.equal(scroll.style.paddingTop, '230px');
  assert.equal(scroll.style.paddingBottom, '230px');
  assert.equal(calls, 1);
  panel._updateLyricsEdgePadding();
  assert.equal(calls, 1);
});
