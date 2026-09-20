const LYRICS_TAB_SELECTOR =
  "ytmusic-tab-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS']";

const PLAYER_BAR_SELECTORS = [
  'ytmusic-player-bar',
  '[data-testid="player-bar"]',
];

const MEDIA_SELECTORS = [
  'ytmusic-player video',
  'ytmusic-player audio',
  'video.html5-main-video',
  'audio.html5-main-audio',
  'audio',
  'video',
];

const TITLE_SELECTORS = [
  'yt-formatted-string.title.ytmusic-player-bar',
  '.title.ytmusic-player-bar',
  '[data-testid="player-bar-title"]',
];

const BYLINE_SELECTORS = [
  'yt-formatted-string.byline.ytmusic-player-bar',
  '.byline.ytmusic-player-bar',
  '[data-testid="player-bar-byline"]',
];

const ALBUM_SELECTORS = [
  'a[href^="browse/"][title]',
  'a[href^="/browse/"][title]',
  'a[href^="browse/"]',
  'a[href^="/browse/"]',
  '[data-testid="player-bar-album"]',
];

const LYRICS_SHELF_SELECTORS = [
  ":scope ytmusic-section-list-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'] ytmusic-description-shelf-renderer[page-type='MUSIC_PAGE_TYPE_TRACK_LYRICS'][is-track-lyrics-page]",
];

function firstMatch(root, selectors) {
  if (!root) return null;
  for (const selector of selectors) {
    try {
      const match = root.querySelector(selector);
      if (match) return match;
    } catch {
      // A selector unsupported by an old page should not stop playback UI.
    }
  }
  return null;
}

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function textOf(root, selectors) {
  const element = firstMatch(root, selectors);
  return cleanText(element?.getAttribute('title') || element?.textContent || '');
}

function artistOf(playerBar) {
  const byline = firstMatch(playerBar, BYLINE_SELECTORS);
  if (!byline) return '';
  // The current player bar exposes artist channel links as `channel/...`
  // (without a leading slash), while the album uses `browse/...`.
  return textOf(byline, ['a[href^="channel/"]', 'a[href^="/channel/"]'])
    || cleanText(byline.textContent || '');
}

function videoIdFromLocation(location) {
  try {
    const url = new URL(location.href);
    const id = url.searchParams.get('v');
    return id ? id.trim() : '';
  } catch {
    return '';
  }
}

function normalizedPart(value) {
  return cleanText(value).toLocaleLowerCase();
}

export function trackIdentity(track) {
  if (!track) return '';
  const parts = [track.title, track.artist, track.album]
    .map(normalizedPart)
    .filter(Boolean);
  if (!parts.length) return '';
  const identity = track.id ? `video:${track.id}` : 'metadata';
  // The media id changes earlier than the player-bar title during navigation.
  // Keep the visible metadata and rounded duration in the fingerprint so a
  // later stable player-bar update starts a fresh, correctly matched lookup.
  const duration = Number.isFinite(track.duration) ? Math.round(track.duration) : '';
  return `${identity}|${parts.join('|')}|${duration}`;
}

/**
 * Reads only public page DOM and media element state. It deliberately does not
 * reach into YouTube Music's private player objects.
 */
export class YouTubeMusicAdapter {
  constructor({ document = globalThis.document, window = globalThis.window, onInvalidate = () => {}, debounceMs = 180, fallbackMs = 2500 } = {}) {
    this.document = document;
    this.window = window;
    this.onInvalidate = onInvalidate;
    this.debounceMs = debounceMs;
    this.fallbackMs = fallbackMs;
    this._observer = null;
    this._media = null;
    this._fallbackTimer = null;
    this._invalidateTimer = null;
    this._lastFallbackSignature = '';
    this._started = false;

    this._onMutations = this._onMutations.bind(this);
    this._onMediaMetadata = this._onMediaMetadata.bind(this);
  }

  getPlayerBar() {
    return firstMatch(this.document, PLAYER_BAR_SELECTORS);
  }

  getMedia() {
    return firstMatch(this.document, MEDIA_SELECTORS);
  }

  getTrack() {
    const playerBar = this.getPlayerBar();
    const media = this.getMedia();
    const title = textOf(playerBar, TITLE_SELECTORS);
    const artist = artistOf(playerBar);
    const album = textOf(playerBar, ALBUM_SELECTORS);
    const id = videoIdFromLocation(this.window?.location || {});
    const duration = Number.isFinite(media?.duration) && media.duration > 0
      ? media.duration
      : undefined;

    // The background matching contract requires both values. Waiting here is
    // safer than asking LRCLIB with an old byline during player SPA updates.
    if (!title || !artist) return null;
    const track = { title, artist };
    if (album) track.album = album;
    if (duration) track.duration = duration;
    if (id) track.id = id;
    return track;
  }

  /**
   * Returns a mount point only inside the semantic lyrics tab. A shelf is the
   * only place where replacement is allowed; the tab fallback never hides its
   * native children.
   */
  getLyricsHost() {
    const tab = this.document?.querySelector?.(LYRICS_TAB_SELECTOR);
    if (!tab || !tab.isConnected) return null;
    const shelf = firstMatch(tab, LYRICS_SHELF_SELECTORS);
    if (shelf && shelf.isConnected) {
      return { tab, mount: shelf, nativeContainer: shelf, replaceNative: true };
    }
    return { tab, mount: tab, nativeContainer: null, replaceNative: false };
  }

  isLyricsHostCurrent(host) {
    if (!host?.tab?.isConnected || !host?.mount?.isConnected) return false;
    return host.tab.matches?.(LYRICS_TAB_SELECTOR) === true;
  }

  start() {
    if (this._started || !this.document?.body) return;
    this._started = true;
    const MutationObserverImpl = this.window?.MutationObserver || globalThis.MutationObserver;
    if (MutationObserverImpl) {
      this._observer = new MutationObserverImpl(this._onMutations);
      this._observer.observe(this.document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        // `page-type` changes on the one reusable tab renderer. The metadata
        // attributes cover player-bar updates without observing our own hidden
        // native shelf children and creating a mutation loop.
        attributeFilter: ['page-type', 'title', 'href'],
      });
    }
    this._syncMedia();
    this._lastFallbackSignature = this._fallbackSignature();
    this._fallbackTimer = this.window?.setInterval?.(() => this._fallback(), this.fallbackMs);
  }

  stop() {
    this._started = false;
    this._observer?.disconnect();
    this._observer = null;
    if (this._fallbackTimer != null) this.window?.clearInterval?.(this._fallbackTimer);
    this._fallbackTimer = null;
    if (this._invalidateTimer != null) this.window?.clearTimeout?.(this._invalidateTimer);
    this._invalidateTimer = null;
    this._disconnectMedia();
  }

  _onMutations(mutations) {
    if (!mutations.some((mutation) => this._isRelevantMutation(mutation))) return;
    this._syncMedia();
    this._scheduleInvalidation('page-change');
  }

  _isRelevantMutation(mutation) {
    const relevant = (node) => {
      if (node?.nodeType !== 1) return false;
      const element = node;
      return element.matches?.('ytmusic-player-bar, ytmusic-tab-renderer, ytmusic-description-shelf-renderer, ytmusic-player, video, audio')
        || element.closest?.('ytmusic-player-bar, ytmusic-tab-renderer, ytmusic-player') != null
        || element.querySelector?.('ytmusic-player-bar, ytmusic-tab-renderer, ytmusic-player, video, audio') != null;
    };
    return relevant(mutation.target)
      || [...mutation.addedNodes].some(relevant)
      || [...mutation.removedNodes].some(relevant);
  }

  _syncMedia() {
    const media = this.getMedia();
    if (media === this._media) return;
    this._disconnectMedia();
    this._media = media;
    for (const eventName of ['loadedmetadata', 'durationchange', 'emptied']) {
      media?.addEventListener?.(eventName, this._onMediaMetadata);
    }
  }

  _disconnectMedia() {
    for (const eventName of ['loadedmetadata', 'durationchange', 'emptied']) {
      this._media?.removeEventListener?.(eventName, this._onMediaMetadata);
    }
    this._media = null;
  }

  _onMediaMetadata() {
    this._scheduleInvalidation('media-metadata');
  }

  _fallbackSignature() {
    const track = this.getTrack();
    const media = this.getMedia();
    const host = this.getLyricsHost();
    return [trackIdentity(track), track?.duration || '', media ? 'media' : '', host?.mount === host?.nativeContainer ? 'shelf' : 'tab'].join('~');
  }

  _fallback() {
    if (!this._started) return;
    this._syncMedia();
    const signature = this._fallbackSignature();
    if (signature !== this._lastFallbackSignature) {
      this._lastFallbackSignature = signature;
      this._scheduleInvalidation('fallback');
    }
  }

  _scheduleInvalidation(reason) {
    if (!this._started) return;
    if (this._invalidateTimer != null) this.window?.clearTimeout?.(this._invalidateTimer);
    this._invalidateTimer = this.window?.setTimeout?.(() => {
      this._invalidateTimer = null;
      this.onInvalidate({ reason });
    }, this.debounceMs);
  }
}

export const selectors = Object.freeze({
  LYRICS_TAB_SELECTOR,
  PLAYER_BAR_SELECTORS,
  MEDIA_SELECTORS,
});
