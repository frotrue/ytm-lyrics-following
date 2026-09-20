import { createLyricsService } from './shared/lyrics.js';

function runtimeFromGlobals() {
  return globalThis.browser?.runtime ?? globalThis.chrome?.runtime ?? null;
}

function isAllowedSender(sender) {
  const senderUrl = sender?.tab?.url;
  if (!senderUrl) return true;
  try {
    return new URL(senderUrl).hostname === 'music.youtube.com';
  } catch {
    return false;
  }
}

export function senderIsAllowed(sender) {
  return isAllowedSender(sender);
}

function errorResult(message) {
  return { status: 'error', message };
}

/** Handle one extension message; exported for browser-independent tests. */
export async function handleMessage(message, sender, service = defaultService) {
  if (!isAllowedSender(sender)) return errorResult('Requests are only accepted from music.youtube.com');
  if (!message || typeof message !== 'object' || message.type !== 'GET_LYRICS') {
    return errorResult('Unsupported message');
  }
  if (!service || typeof service.getLyrics !== 'function') return errorResult('Lyrics service unavailable');
  try {
    return await service.getLyrics(message.track);
  } catch (error) {
    return errorResult(error?.message || 'Lyrics service error');
  }
}

/**
 * Register a callback compatible with both Firefox's Promise listener API and
 * Chrome's sendResponse callback API.  Supplying runtime/service is useful in
 * tests and avoids touching browser globals in Node.
 */
export function registerBackground(runtime = runtimeFromGlobals(), service = defaultService) {
  if (!runtime?.onMessage?.addListener) return null;
  const listener = (message, sender, sendResponse) => {
    const pending = handleMessage(message, sender, service);
    if (typeof sendResponse === 'function') {
      pending.then((result) => sendResponse(result), (error) => sendResponse(errorResult(error?.message || 'Lyrics service error')));
      return true;
    }
    return pending;
  };
  runtime.onMessage.addListener(listener);
  return listener;
}

export const defaultService = createLyricsService();
export const registeredListener = runtimeFromGlobals() ? registerBackground() : null;
