import { findActiveLine } from './shared/lyrics.js';
import { trackIdentity, YouTubeMusicAdapter } from './content/adapter.js';
import { LyricsPanel } from './content/panel.js';

const REQUEST_TYPE = 'GET_LYRICS';
const CLOCK_INTERVAL_MS = 250;

function getRuntime() {
  return globalThis.browser?.runtime || globalThis.chrome?.runtime || null;
}

function activeLineIndex(lines, currentTime) {
  if (!Array.isArray(lines) || !lines.length || !Number.isFinite(currentTime)) return -1;
  const result = findActiveLine(lines, currentTime);
  if (Number.isInteger(result)) return result >= 0 && result < lines.length ? result : -1;
  if (result && Number.isInteger(result.index)) return result.index;
  return result ? lines.indexOf(result) : -1;
}

function normalizedResponse(response) {
  const status = ['synced', 'plain', 'instrumental', 'missing', 'error'].includes(response?.status)
    ? response.status
    : 'error';
  const lines = Array.isArray(response?.lines)
    ? response.lines.filter((line) => Number.isFinite(line?.time) && typeof line.text === 'string')
    : [];
  return {
    status: status === 'synced' && !lines.length ? 'missing' : status,
    lines,
    plainLyrics: typeof response?.plainLyrics === 'string' ? response.plainLyrics : '',
    source: typeof response?.source === 'string' ? response.source : '',
    message: typeof response?.message === 'string' ? response.message : '',
  };
}

/**
 * Coordinates volatile YouTube Music DOM with the background lyric provider.
 * Every request gets a sequence token, so a slower answer for track A cannot
 * overwrite a newer request for track B or an updated player-bar metadata read.
 */
export class LyricsContentController {
  constructor({ document = globalThis.document, window = globalThis.window, runtime = getRuntime(), adapter, panel, clockIntervalMs = CLOCK_INTERVAL_MS, metadataSettleMs = 350 } = {}) {
    this.document = document;
    this.window = window;
    this.runtime = runtime;
    this.adapter = adapter || new YouTubeMusicAdapter({ document, window, onInvalidate: () => this.refresh() });
    this.panel = panel || new LyricsPanel({ document, window, onSeek: (time) => this.seekTo(time) });
    this.clockIntervalMs = clockIntervalMs;
    this.metadataSettleMs = metadataSettleMs;
    this._requestSequence = 0;
    this._trackKey = '';
    this._pendingTrackKey = '';
    this._settledTrackKey = '';
    this._settleTimer = null;
    this._lines = [];
    this._clock = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this.adapter.start();
    this._clock = this.window?.setInterval?.(() => this._updateClock(), this.clockIntervalMs);
    this.refresh();
  }

  stop() {
    this._started = false;
    this._cancelOutstandingWork();
    if (this._clock != null) this.window?.clearInterval?.(this._clock);
    this._clock = null;
    this.adapter.stop();
    this.panel.destroy();
    this._trackKey = '';
    this._lines = [];
  }

  async refresh() {
    if (!this._started) return;
    const host = this.adapter.getLyricsHost();
    if (!host) {
      this._cancelOutstandingWork();
      this.panel.destroy();
      return;
    }
    if (!this.adapter.isLyricsHostCurrent(host)) {
      this._cancelOutstandingWork();
      this.panel.destroy();
      return;
    }
    this.panel.mount(host);

    const track = this.adapter.getTrack();
    const key = trackIdentity(track);
    if (!key) {
      this._cancelOutstandingWork();
      this.panel.setData({ status: 'loading' });
      return;
    }
    if (key === this._trackKey) return;

    if (key !== this._settledTrackKey) {
      if (key !== this._pendingTrackKey) this._beginMetadataSettle(key);
      return;
    }

    this._trackKey = key;
    this._pendingTrackKey = '';
    this._settledTrackKey = '';
    this._lines = [];
    this.panel.setData({ status: 'loading' });
    const sequence = ++this._requestSequence;
    let response;
    try {
      response = await this._sendRequest(track);
    } catch (error) {
      response = { status: 'error', message: error?.message || 'Lyrics could not be loaded right now.' };
    }

    // Verify all three pieces of identity after awaiting: lifecycle, track, and
    // mount. YouTube Music frequently changes them independently during SPA navigation.
    if (!this._started || sequence !== this._requestSequence || key !== this._trackKey) return;
    const currentHost = this.adapter.getLyricsHost();
    if (!currentHost || !this.adapter.isLyricsHostCurrent(currentHost)) {
      this._cancelOutstandingWork();
      this.panel.destroy();
      return;
    }
    if (!this.panel.isMountedAt(currentHost.mount)) this.panel.mount(currentHost);
    const data = normalizedResponse(response);
    this._lines = data.status === 'synced' ? data.lines : [];
    this.panel.setData(data);
    this._updateClock();
  }

  async _sendRequest(track) {
    if (!this.runtime?.sendMessage) {
      return { status: 'error', message: 'Extension messaging is unavailable.' };
    }
    return this.runtime.sendMessage({ type: REQUEST_TYPE, track });
  }

  _updateClock() {
    if (!this._started || !this._lines.length) return;
    const media = this.adapter.getMedia();
    const index = activeLineIndex(this._lines, media?.currentTime);
    this.panel.setActiveIndex(index);
  }

  /**
   * Seek the currently loaded track without changing whether playback is
   * paused.  The adapter is queried at call time because YouTube Music
   * replaces its media element during SPA navigation.
   */
  seekTo(time) {
    if (!this._started || !this._trackKey || !this._lines.length || !Number.isFinite(time)) return false;

    const currentTrack = this.adapter.getTrack();
    if (!currentTrack || trackIdentity(currentTrack) !== this._trackKey) return false;

    const media = this.adapter.getMedia();
    if (!media || !Number.isFinite(media.duration) || media.duration <= 0) return false;
    const target = Math.min(Math.max(0, time), media.duration);
    if (!Number.isFinite(target)) return false;

    try {
      media.currentTime = target;
    } catch {
      return false;
    }

    // Setting currentTime does not start playback. Recompute immediately so
    // keyboard/click seeks update the highlighted row before the next clock
    // tick, including when a replacement media element is now active.
    this._updateClock();
    return true;
  }

  _beginMetadataSettle(key) {
    this._cancelOutstandingWork();
    this._pendingTrackKey = key;
    this.panel.setData({ status: 'loading' });
    this._settleTimer = this.window?.setTimeout?.(() => {
      this._settleTimer = null;
      if (!this._started || this._pendingTrackKey !== key) return;
      this._settledTrackKey = key;
      this.refresh();
    }, this.metadataSettleMs);
  }

  _cancelOutstandingWork() {
    this._requestSequence += 1;
    if (this._settleTimer != null) this.window?.clearTimeout?.(this._settleTimer);
    this._settleTimer = null;
    this._trackKey = '';
    this._pendingTrackKey = '';
    this._settledTrackKey = '';
    this._lines = [];
  }
}

export function bootContentScript() {
  const controller = new LyricsContentController();
  controller.start();
  return controller;
}

// Content scripts can be imported by tests; production builds run the module in
// a document and create one controller for that document.
if (typeof document !== 'undefined' && getRuntime()?.sendMessage && !globalThis.__YTM_BETTER_LYRICS_NO_AUTOBOOT__) {
  bootContentScript();
}
