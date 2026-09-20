const ROOT_ID = 'ytm-better-lyrics-root';

const CSS = `
  :host { color-scheme: dark; display: flow-root; width: 100%; }
  *, *::before, *::after { box-sizing: border-box; }
  .panel {
    --muted: #a5a5aa;
    --line: #d7d7dc;
    --active: #fff;
    --surface: rgba(27, 27, 30, .96);
    color: var(--line);
    background: var(--surface);
    border-radius: 18px;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: min(50vh, 430px);
    max-height: min(64vh, 620px);
    overflow: hidden;
    font-family: Roboto, Arial, sans-serif;
    box-shadow: 0 12px 36px rgba(0, 0, 0, .25);
  }
  .header { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; padding: 18px 20px 10px; }
  .eyebrow { color: var(--muted); font-size: 11px; letter-spacing: .09em; text-transform: uppercase; }
  .source { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 20px 22px; scrollbar-color: #62626a transparent; }
  .line { appearance: none; width: 100%; border: 0; border-radius: 8px; padding: 7px 4px; background: transparent; color: #9f9fa6; cursor: pointer; font: inherit; font-size: clamp(19px, 2.1vw, 28px); font-weight: 650; letter-spacing: -.018em; line-height: 1.34; text-align: left; transition: color 180ms ease, transform 180ms ease, opacity 180ms ease, background-color 180ms ease; }
  .line:hover { background: rgba(255, 255, 255, .07); color: #e6e6e9; }
  .line:focus-visible { background: rgba(255, 255, 255, .1); outline: 2px solid #e7e7eb; outline-offset: 2px; color: #fff; }
  .line.active { color: var(--active); transform: scale(1.018); transform-origin: left center; }
  .line.past { color: #74747a; }
  .empty { display: grid; flex: 1 1 auto; min-height: min(50vh, 430px); padding: 40px 26px; place-content: center; text-align: center; }
  .empty.plain-state { display: block; max-height: min(64vh, 620px); min-height: 260px; overflow-y: auto; }
  .empty-title { color: #f0f0f2; font-size: 21px; font-weight: 700; }
  .empty-copy { color: var(--muted); font-size: 14px; line-height: 1.5; margin-top: 9px; max-width: 30rem; }
  .plain { white-space: pre-wrap; color: #d6d6da; font-size: 17px; line-height: 1.55; margin-top: 20px; text-align: left; }
  :host([data-ytm-artwork-aligned]) .panel { height: 100%; min-height: 0; max-height: 100%; }
  :host([data-ytm-artwork-aligned]) .empty { min-height: 0; }
  :host([data-ytm-artwork-aligned]) .empty.plain-state { height: 100%; max-height: 100%; }
  @media (max-width: 600px) { .panel { border-radius: 14px; } .header { padding: 15px 16px 8px; } .scroll { padding-left: 18px; padding-right: 18px; } }
  @media (prefers-reduced-motion: reduce) { .line { transition: none; } }
`;

function makeElement(document, className, text) {
  const element = document.createElement('div');
  element.className = className;
  if (text != null) element.textContent = String(text);
  return element;
}

function formatTimestamp(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function visibleRect(element) {
  if (!element?.isConnected || typeof element.getBoundingClientRect !== 'function') return null;
  const rect = element.getBoundingClientRect();
  if (!Number.isFinite(rect?.width) || !Number.isFinite(rect?.height) || rect.width < 1 || rect.height < 1) return null;
  return rect;
}

function statusCopy(status, message) {
  if (message) return message;
  switch (status) {
    case 'loading': return 'Looking for timed lyrics for this track.';
    case 'plain': return 'Lyrics are available, but they do not have time stamps.';
    case 'instrumental': return 'This track is marked as instrumental.';
    case 'missing': return 'Timed lyrics are not available for this track yet.';
    case 'error': return 'Lyrics could not be loaded right now.';
    default: return 'Timed lyrics are not available for this track yet.';
  }
}

function statusTitle(status) {
  switch (status) {
    case 'loading': return 'Loading lyrics';
    case 'plain': return 'No synced lyrics';
    case 'instrumental': return 'Instrumental';
    case 'error': return 'Could not load lyrics';
    default: return 'No synced lyrics';
  }
}

/** A self-contained Shadow DOM surface. Dynamic values are always text nodes. */
export class LyricsPanel {
  constructor({ document = globalThis.document, window = globalThis.window, followPauseMs = 5500, onSeek = () => {} } = {}) {
    this.document = document;
    this.window = window;
    this.followPauseMs = followPauseMs;
    this.onSeek = typeof onSeek === 'function' ? onSeek : () => {};
    this.root = null;
    this.shadow = null;
    this.scroll = null;
    this.lineNodes = [];
    this.activeIndex = -1;
    this.data = { status: 'loading', lines: [] };
    this._restoreRecords = [];
    this._followPausedUntil = 0;
    this._resizeObserver = null;
    this._geometryFrame = null;
    this._geometryFrameKind = '';
    this._geometryTargets = [];
    this._paddingFrame = null;
    this._paddingFrameKind = '';
    this._onInteraction = this._onInteraction.bind(this);
    this._onLineClick = this._onLineClick.bind(this);
    this._onLineKey = this._onLineKey.bind(this);
    this._onWindowResize = this._onWindowResize.bind(this);
  }

  isMountedAt(mount) {
    return Boolean(this.root?.isConnected && this.root.parentElement === mount);
  }

  mount({ mount, nativeContainer = null, replaceNative = false } = {}) {
    if (!mount?.isConnected) return false;
    if (this.isMountedAt(mount)) return true;
    this.destroy();

    const existing = mount.querySelector?.(`#${ROOT_ID}`);
    existing?.remove?.();
    this.root = this.document.createElement('div');
    this.root.id = ROOT_ID;
    this.shadow = this.root.attachShadow({ mode: 'open' });
    mount.append(this.root);
    this._render();
    this._startGeometryObservers();

    // This is deliberately restricted to a verified lyrics shelf supplied by
    // the adapter, after the replacement itself has been mounted successfully.
    if (replaceNative && nativeContainer === mount && nativeContainer.isConnected) {
      this._hideNativeChildren(nativeContainer);
    }
    return true;
  }

  setData(data = {}) {
    this.data = {
      status: data.status || 'missing',
      lines: Array.isArray(data.lines) ? data.lines : [],
      plainLyrics: typeof data.plainLyrics === 'string' ? data.plainLyrics : '',
      source: typeof data.source === 'string' ? data.source : '',
      message: typeof data.message === 'string' ? data.message : '',
    };
    this.activeIndex = -1;
    if (this.root?.isConnected) this._render();
  }

  setActiveIndex(nextIndex) {
    if (!Number.isInteger(nextIndex) || nextIndex < -1 || nextIndex >= this.lineNodes.length) return;
    if (nextIndex === this.activeIndex) return;
    this.lineNodes.forEach((node, index) => {
      const active = index === nextIndex;
      node.classList.toggle('active', active);
      node.classList.toggle('past', index < nextIndex);
      if (active) node.setAttribute('aria-current', 'true');
      else node.removeAttribute('aria-current');
    });
    this.activeIndex = nextIndex;
    const next = this.lineNodes[nextIndex];
    if (next && Date.now() >= this._followPausedUntil) this._centerActiveLine(next);
  }

  destroy() {
    this._stopGeometryObservers();
    this._restoreNativeChildren();
    this.root?.remove?.();
    this.root = null;
    this.shadow = null;
    this.scroll = null;
    this.lineNodes = [];
    this.activeIndex = -1;
  }

  _hideNativeChildren(container) {
    this._restoreRecords = [...container.children]
      .filter((child) => child !== this.root)
      .map((element) => ({
        element,
        hidden: element.hidden,
        ariaHidden: element.getAttribute('aria-hidden'),
      }));
    for (const { element } of this._restoreRecords) {
      element.hidden = true;
      element.setAttribute('aria-hidden', 'true');
    }
  }

  _restoreNativeChildren() {
    for (const record of this._restoreRecords) {
      const { element, hidden, ariaHidden } = record;
      if (!element) continue;
      element.hidden = hidden;
      if (ariaHidden == null) element.removeAttribute('aria-hidden');
      else element.setAttribute('aria-hidden', ariaHidden);
    }
    this._restoreRecords = [];
  }

  _render() {
    if (!this.shadow) return;
    this.shadow.replaceChildren();
    const style = this.document.createElement('style');
    style.textContent = CSS;
    const panel = makeElement(this.document, 'panel');
    panel.setAttribute('role', 'region');
    panel.setAttribute('aria-label', 'Synced lyrics');

    if (this.data.status === 'synced' && this.data.lines.length) {
      const header = makeElement(this.document, 'header');
      header.append(makeElement(this.document, 'eyebrow', 'Lyrics'));
      if (this.data.source) header.append(makeElement(this.document, 'source', `Source: ${this.data.source}`));
      const scroll = makeElement(this.document, 'scroll');
      scroll.tabIndex = 0;
      scroll.setAttribute('aria-label', 'Lyrics lines');
      scroll.addEventListener('wheel', this._onInteraction, { passive: true });
      scroll.addEventListener('touchstart', this._onInteraction, { passive: true });
      scroll.addEventListener('keydown', this._onInteraction);
      this.lineNodes = this.data.lines.map((line) => {
        const node = this.document.createElement('button');
        node.type = 'button';
        node.className = 'line';
        node.textContent = line.text;
        node.dataset.time = String(line.time);
        const timestamp = formatTimestamp(line.time);
        node.title = `Jump to ${timestamp}`;
        node.setAttribute('aria-label', `Jump to ${timestamp}: ${line.text}`);
        node.addEventListener('keydown', this._onLineKey);
        node.addEventListener('keyup', this._onLineKey);
        scroll.append(node);
        return node;
      });
      scroll.addEventListener('click', this._onLineClick);
      panel.append(header, scroll);
      this.scroll = scroll;
    } else {
      this.lineNodes = [];
      this.scroll = null;
      const empty = makeElement(this.document, 'empty');
      if (this.data.status === 'plain') empty.classList.add('plain-state');
      empty.append(makeElement(this.document, 'empty-title', statusTitle(this.data.status)));
      empty.append(makeElement(this.document, 'empty-copy', statusCopy(this.data.status, this.data.message)));
      if (this.data.status === 'plain' && this.data.plainLyrics) {
        empty.append(makeElement(this.document, 'plain', this.data.plainLyrics));
      }
      if (this.data.source) empty.append(makeElement(this.document, 'source', `Source: ${this.data.source}`));
      panel.append(empty);
    }
    this.shadow.append(style, panel);
    this._scheduleLyricsEdgePadding();
  }

  _onInteraction(event) {
    if (event?.target?.closest?.('.line')) return;
    this._followPausedUntil = Date.now() + this.followPauseMs;
  }

  _onLineClick(event) {
    const line = event.target?.closest?.('button.line');
    if (!line || !this.scroll?.contains(line)) return;
    const time = Number(line.dataset.time);
    if (!Number.isFinite(time)) return;
    // Seeking intentionally resumes following; it never invokes playback.
    this._followPausedUntil = 0;
    this.onSeek(time);
  }

  _onLineKey(event) {
    if ((event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar')
      && event.target?.closest?.('button.line')) {
      // YouTube Music has global keyboard handlers outside this shadow root.
      // Stopping propagation preserves the native button activation default.
      event.stopPropagation();
    }
  }

  _centerActiveLine(node) {
    const reducedMotion = this.window?.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    if (!this.scroll) return;
    const lineRect = node.getBoundingClientRect();
    const scrollRect = this.scroll.getBoundingClientRect();
    const top = Math.max(0, this.scroll.scrollTop + lineRect.top - scrollRect.top
      - this.scroll.clientTop - (this.scroll.clientHeight - lineRect.height) / 2);
    const lineMidpoint = lineRect.top + lineRect.height / 2;
    const scrollMidpoint = scrollRect.top + this.scroll.clientTop + this.scroll.clientHeight / 2;
    if (Math.abs(lineMidpoint - scrollMidpoint) < 2) return;
    try {
      if (typeof this.scroll.scrollTo === 'function') {
        this.scroll.scrollTo({ top, behavior: reducedMotion ? 'auto' : 'smooth' });
      } else {
        this.scroll.scrollTop = top;
      }
    } catch {
      this.scroll.scrollTop = top;
    }
  }

  /** Re-evaluate the desktop artwork alignment without re-rendering lyrics. */
  refreshArtworkAlignment() {
    if (!this.root?.isConnected) return false;
    const artwork = this._findArtwork();
    const rootRect = visibleRect(this.root);
    const sidePanel = this.root.closest?.('#side-panel') || this.document?.querySelector?.('#side-panel');
    const sideRect = visibleRect(sidePanel);
    if (!artwork || !rootRect || !sideRect || !sidePanel?.contains(this.root)
      || artwork.right > rootRect.left + 24) {
      this._clearArtworkAlignment();
      this._scheduleLyricsEdgePadding();
      return false;
    }

    const previousOffset = Number(this.root.dataset.ytmArtworkOffset || 0);
    const baselineTop = rootRect.top - previousOffset;
    const offset = artwork.top - baselineTop;
    this.root.style.marginTop = `${offset}px`;
    this.root.style.height = `${artwork.height}px`;
    this.root.dataset.ytmArtworkOffset = String(offset);
    this.root.setAttribute('data-ytm-artwork-aligned', '');
    this._scheduleLyricsEdgePadding();
    return true;
  }

  _clearArtworkAlignment() {
    if (!this.root) return;
    this.root.style.removeProperty('margin-top');
    this.root.style.removeProperty('height');
    delete this.root.dataset.ytmArtworkOffset;
    this.root.removeAttribute('data-ytm-artwork-aligned');
  }

  _findArtwork() {
    const selectors = [
      'ytmusic-player #song-image',
      'ytmusic-player #song-image img',
      'ytmusic-player#player',
    ];
    for (const selector of selectors) {
      const rect = visibleRect(this.document?.querySelector?.(selector));
      if (rect) return rect;
    }
    return null;
  }

  _startGeometryObservers() {
    this._stopGeometryObservers();
    const ResizeObserverImpl = this.window?.ResizeObserver || globalThis.ResizeObserver;
    if (ResizeObserverImpl) {
      this._resizeObserver = new ResizeObserverImpl(() => this._scheduleArtworkAlignment());
      this._refreshGeometryTargets();
    }
    this.window?.addEventListener?.('resize', this._onWindowResize, { passive: true });
    this._scheduleArtworkAlignment();
  }

  _stopGeometryObservers() {
    this._resizeObserver?.disconnect();
    this._resizeObserver = null;
    this._geometryTargets = [];
    this.window?.removeEventListener?.('resize', this._onWindowResize);
    if (this._geometryFrame != null) {
      if (this._geometryFrameKind === 'raf') this.window?.cancelAnimationFrame?.(this._geometryFrame);
      else this.window?.clearTimeout?.(this._geometryFrame);
    }
    this._geometryFrame = null;
    this._geometryFrameKind = '';
    if (this._paddingFrame != null) {
      if (this._paddingFrameKind === 'raf') this.window?.cancelAnimationFrame?.(this._paddingFrame);
      else this.window?.clearTimeout?.(this._paddingFrame);
    }
    this._paddingFrame = null;
    this._paddingFrameKind = '';
  }

  _refreshGeometryTargets() {
    if (!this._resizeObserver) return;
    const artworkElement = [
      'ytmusic-player #song-image',
      'ytmusic-player #song-image img',
      'ytmusic-player#player',
    ].map((selector) => this.document?.querySelector?.(selector)).find(Boolean);
    const sidePanel = this.root?.closest?.('#side-panel') || this.document?.querySelector?.('#side-panel');
    const targets = [artworkElement, sidePanel].filter((target) => target?.isConnected);
    if (targets.length === this._geometryTargets.length && targets.every((target, index) => target === this._geometryTargets[index])) return;
    this._resizeObserver.disconnect();
    targets.forEach((target) => this._resizeObserver.observe(target));
    this._geometryTargets = targets;
  }

  _onWindowResize() {
    this._scheduleArtworkAlignment();
  }

  _scheduleArtworkAlignment() {
    if (this._geometryFrame != null) return;
    const callback = () => {
      this._geometryFrame = null;
      this._geometryFrameKind = '';
      this._refreshGeometryTargets();
      this.refreshArtworkAlignment();
    };
    if (typeof this.window?.requestAnimationFrame === 'function') {
      this._geometryFrameKind = 'raf';
      this._geometryFrame = this.window.requestAnimationFrame(callback);
    } else {
      this._geometryFrameKind = 'timeout';
      this._geometryFrame = this.window?.setTimeout?.(callback, 0);
    }
  }

  _scheduleLyricsEdgePadding() {
    if (this._paddingFrame != null || !this.scroll) return;
    const callback = () => {
      this._paddingFrame = null;
      this._paddingFrameKind = '';
      this._updateLyricsEdgePadding();
    };
    if (typeof this.window?.requestAnimationFrame === 'function') {
      this._paddingFrameKind = 'raf';
      this._paddingFrame = this.window.requestAnimationFrame(callback);
    } else {
      this._paddingFrameKind = 'timeout';
      this._paddingFrame = this.window?.setTimeout?.(callback, 0);
    }
  }

  _updateLyricsEdgePadding() {
    if (!this.scroll || this.lineNodes.length === 0) return;
    // Reset before measuring: old edge padding participates in the flex
    // item's minimum contribution and can otherwise make the scrollport look
    // taller than the panel that contains it.
    this.scroll.style.paddingTop = '0px';
    this.scroll.style.paddingBottom = '0px';
    if (this.scroll.clientHeight <= 0) return;
    const first = this.lineNodes[0];
    const last = this.lineNodes[this.lineNodes.length - 1];
    const firstHeight = first.getBoundingClientRect().height || first.offsetHeight || 0;
    const lastHeight = last.getBoundingClientRect().height || last.offsetHeight || 0;
    const edge = Math.max(20, Math.floor((this.scroll.clientHeight - Math.max(firstHeight, lastHeight)) / 2));
    const padding = `${edge}px`;
    this.scroll.style.paddingTop = padding;
    this.scroll.style.paddingBottom = padding;
    const active = this.lineNodes[this.activeIndex];
    if (active && Date.now() >= this._followPausedUntil) this._centerActiveLine(active);
  }
}

export { ROOT_ID };
