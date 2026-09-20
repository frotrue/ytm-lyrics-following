import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessage, registerBackground, senderIsAllowed } from '../src/background.js';

test('only music.youtube.com tab senders may request lyrics', async () => {
  const service = { async getLyrics() { return { status: 'missing' }; } };
  assert.equal(senderIsAllowed({ tab: { url: 'https://music.youtube.com/watch?v=x' } }), true);
  assert.equal(senderIsAllowed({ tab: { url: 'https://www.youtube.com/watch?v=x' } }), false);
  assert.equal(senderIsAllowed({ tab: { url: 'https://music.youtube.com.evil.test/' } }), false);
  assert.equal((await handleMessage({ type: 'GET_LYRICS', track: { title: 'x', artist: 'y' } }, { tab: { url: 'https://evil.test/' } }, service)).status, 'error');
});

test('message handler validates type and delegates track metadata', async () => {
  const seen = [];
  const service = { async getLyrics(track) { seen.push(track); return { status: 'plain', plainLyrics: 'hello' }; } };
  const result = await handleMessage({ type: 'GET_LYRICS', track: { title: 'x', artist: 'y' } }, {}, service);
  assert.deepEqual(result, { status: 'plain', plainLyrics: 'hello' });
  assert.deepEqual(seen, [{ title: 'x', artist: 'y' }]);
  assert.equal((await handleMessage({ type: 'OTHER' }, {}, service)).status, 'error');
});

test('registration supports callback and Promise listener styles', async () => {
  let listener;
  const runtime = { onMessage: { addListener(fn) { listener = fn; } } };
  const service = { async getLyrics() { return { status: 'instrumental' }; } };
  assert.ok(registerBackground(runtime, service));
  const callbackResult = await new Promise((resolve) => {
    const keepChannelOpen = listener({ type: 'GET_LYRICS', track: { title: 'x', artist: 'y' } }, {}, resolve);
    assert.equal(keepChannelOpen, true);
  });
  assert.deepEqual(callbackResult, { status: 'instrumental' });
  assert.deepEqual(await listener({ type: 'GET_LYRICS', track: { title: 'x', artist: 'y' } }, {}), { status: 'instrumental' });
});
