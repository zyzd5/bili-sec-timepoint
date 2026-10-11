// ==UserScript==
// @name         Bilibili 秒级时间点 (bili-sec-timepoint)
// @name:en      Bilibili Second Timepoint
// @namespace    https://github.com/local/bili-sec-timepoint
// @version      1.5.1
// @description  把 B 站播放器的时间区域改成只显示「距离视频结束还剩多少秒」；点击时间点即可在插件样式与 B 站默认样式之间切换。
// @description:en  Replace the bilibili player clock with a plain seconds-remaining countdown. Click the timepoint to switch back to bilibili's own clock.
// @author       bili-sec-timepoint
// @icon         https://www.bilibili.com/favicon.ico
// @match        *://www.bilibili.com/*
// @match        *://bilibili.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_unregisterMenuCommand
// @noframes
// ==/UserScript==

/*
 * Why this script is written defensively
 * --------------------------------------
 * bilibili has shipped at least three generations of player markup
 * (`bilibili-player-video-time`, `squirtle-*`, and today's `bpx-player-*`),
 * and the control bar is re-rendered on quality changes / fullscreen
 * transitions. So instead of hard-coding one selector we try, in order:
 *
 *   1. exact selectors of every known player generation;
 *   2. a structural heuristic: the only leaf node inside the control bar
 *      whose text looks like `mm:ss` (or `hh:mm:ss`).
 *
 * There is deliberately no floating-overlay fallback. An earlier version
 * pinned one to the bottom-left corner of the player, which required stamping
 * an inline `position` onto the player container; inline styles outrank the
 * stylesheet, and bilibili implements web fullscreen with `position:fixed` on
 * that same container, so the stamp permanently broke web fullscreen. When no
 * clock node can be found the script now simply shows nothing (and says so in
 * the console) rather than touching the player's layout.
 *
 * A polling heartbeat re-attaches the readout after any re-render, and also
 * detects bilibili's client-side (SPA) navigation between videos.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Constants
   * ------------------------------------------------------------------ */

  const CLS_SEC = 'bst-sec';            // the live seconds readout
  const CLS_SOLO = 'bst-sec--solo';     // ...when it is the ONLY time shown
  const CLS_STYLE = 'bst-style';

  const STORE_KEY = 'bst:config';
  const CONFIG_VERSION = 3;             // bump to reset display keys on upgrade
  const VERSION = '1.5.1';
  const HEARTBEAT_MS = 500;
  const TICK_MIN_INTERVAL_MS = 80;      // throttle for the per-frame update loop
  /*
   * After the readout is first attached, watch bilibili's clock styling at
   * frame cadence instead of waiting for a heartbeat. The player's stylesheet
   * lands in several passes and its control bar is rescaled as the layout
   * settles, so the value we read on attach can be a placeholder — and the
   * wrong font is most visible in exactly those first moments.
   */
  const APPEARANCE_SETTLE_MS = 3000;

  /** Leaf text that looks like a player clock, e.g. `02:31` or `1:02:31`. */
  const TIME_TEXT_RE = /^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/;

  /**
   * Short, greppable console prefix. Every message this script prints starts
   * with it, so the user can filter the console by `bili-sec-timepoint` and
   * tell our output apart from bilibili's own logging.
   */
  const LOG_PREFIX = '[bili-sec-timepoint]';

  function log() {
    try {
      const args = Array.prototype.slice.call(arguments);
      args.unshift(LOG_PREFIX);
      console.log.apply(console, args);
    } catch (err) {
      // A page is free to neuter console.log; never let logging break the run.
    }
  }

  /** Marks the native clock nodes whose `display` this script overrode. */
  const HIDDEN_ATTR = 'data-bst-hidden';
  /**
   * How many consecutive heartbeats a missing clock node must persist before we
   * tell the user in the console that nothing will be displayed. The control
   * bar is rebuilt on quality and fullscreen switches, so a transient miss is
   * normal and must not produce a scary log line. This only gates the message —
   * it never triggers a fallback display.
   */
  const WARN_AFTER_MISSES = 6;   // ~3s at HEARTBEAT_MS = 500

  const DEFAULT_CONFIG = {
    configVersion: CONFIG_VERSION,
    enabled: true,            // master switch
    /*
     * What occupies the clock area:
     *   'plugin' — bilibili's `mm:ss / mm:ss` is hidden and replaced by our
     *              remaining-seconds readout (`387s`);
     *   'native' — bilibili's own clock, untouched, and we show nothing.
     * Clicking the timepoint flips between the two.
     */
    style: 'plugin',
    mode: 'remaining',        // 'remaining' (countdown) | 'elapsed' (count-up)
    precision: 0,             // decimals in the live readout (0..3)
    clickToToggle: true,      // click the timepoint to switch styles
  };

  /**
   * Exact selectors, newest player first. Kept as arrays because several
   * builds coexist in the wild and `querySelector` returns the first hit.
   */
  const SELECTORS = {
    current: [
      '.bpx-player-ctrl-time-current',
      '.bpx-player-ctrl-time-label .bpx-player-ctrl-time-current',
      '.bpx-player-ctrl-time .bpx-player-ctrl-time-current',
      '.bilibili-player-video-time-now',
      '.squirtle-time-now',
      '.squirtle-video-time-now',
    ],
    duration: [
      '.bpx-player-ctrl-time-duration',
      '.bpx-player-ctrl-time-label .bpx-player-ctrl-time-duration',
      '.bilibili-player-video-time-total',
      '.squirtle-time-total',
      '.squirtle-video-time-total',
    ],
    /** Scopes scanned by the structural heuristic, narrowest first. */
    bars: [
      '#bilibili-player .bpx-player-control-bottom',
      '.bpx-player-control-bottom',
      '.bpx-player-control-wrap',
      '.bilibili-player-video-control-bottom',
      '#bilibili-player',
      '.bpx-player-container',
    ],
    /**
     * The wrapper around bilibili's own clock. Our readout is placed *inside*
     * this wrapper, in the slot the elapsed clock occupies, and the wrapper's
     * original children (both clocks plus the `/` divider) are hidden. Leaving
     * the wrapper itself in the layout is what keeps our readout positioned
     * exactly where bilibili's own clock was.
     */
    timeBox: [
      '.bpx-player-ctrl-time',
      '.bilibili-player-video-time',
      '.squirtle-time',
      '.squirtle-video-time',
    ],
  };

  /* ------------------------------------------------------------------ *
   * Config (GM storage, with a localStorage fallback for plain pages)
   * ------------------------------------------------------------------ */

  const hasGMStore =
    typeof GM_getValue === 'function' && typeof GM_setValue === 'function';

  let config = loadConfig();

  function loadConfig() {
    let raw;
    try {
      raw = hasGMStore ? GM_getValue(STORE_KEY, null) : localStorage.getItem(STORE_KEY);
    } catch (_) {
      raw = null;
    }
    let parsed = null;
    if (raw && typeof raw === 'object') {
      parsed = raw; // some managers deserialize GM values for us
    } else if (typeof raw === 'string' && raw) {
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        parsed = null;
      }
    }
    const stored = parsed && typeof parsed === 'object' ? parsed : {};
    const merged = Object.assign({}, DEFAULT_CONFIG, stored);
    /*
     * `hideNative`, `showDuration` and `copyOnClick` were replaced by the single
     * `style` axis, and the default precision dropped from one decimal to whole
     * seconds. A config saved by an older version must not keep the old look
     * (`00:02 387.0s / 06:29`), so reset the display keys once per schema bump
     * while carrying over the switches that survived the redesign. `altCShortcut`
     * is deleted outright because the copy feature it guarded no longer exists.
     */
    delete merged.showDuration;
    delete merged.hideNative;
    delete merged.copyOnClick;
    delete merged.altCShortcut;
    if (stored.configVersion !== CONFIG_VERSION) {
      merged.configVersion = CONFIG_VERSION;
      merged.style = DEFAULT_CONFIG.style;
      merged.precision = DEFAULT_CONFIG.precision;
    }
    return merged;
  }

  function saveConfig() {
    let raw;
    try {
      raw = JSON.stringify(config);
      if (hasGMStore) GM_setValue(STORE_KEY, raw);
      else localStorage.setItem(STORE_KEY, raw);
    } catch (_) {
      /* storage is unavailable (private mode, file://) — run with defaults */
    }
  }

  /* ------------------------------------------------------------------ *
   * Small utilities
   * ------------------------------------------------------------------ */

  /** `12.34` -> `"12.3s"`; non-finite values render as `"--"`. */
  function formatSeconds(sec, precision) {
    if (!Number.isFinite(sec) || sec < 0) return '--';
    return sec.toFixed(Math.max(0, Math.min(3, precision))) + 's';
  }

  /**
   * The number the live readout displays.
   *
   * `remaining` is the default: a countdown reads better than a count-up when
   * the thing you care about is "how much is left". Before metadata loads
   * `video.duration` is `NaN`, which propagates out and renders as `"--"`
   * rather than a nonsense number.
   */
  function readoutSeconds(video) {
    if (!video) return NaN;
    if (config.mode === 'remaining') {
      const total = video.duration;
      if (!Number.isFinite(total)) return NaN;
      return total - video.currentTime;
    }
    return video.currentTime;
  }

  /**
   * Hide/show one of bilibili's own clock nodes, remembering the inline
   * `display` we overrode so restoring never clobbers a value bilibili set
   * itself (e.g. when it hides the clock in its mini-player).
   */
  function setNativeHidden(el, hidden) {
    if (!el || !el.style) return;
    if (hidden) {
      if (!el.hasAttribute(HIDDEN_ATTR)) {
        el.setAttribute(HIDDEN_ATTR, el.style.display || '');
      }
      el.style.display = 'none';
    } else if (el.hasAttribute(HIDDEN_ATTR)) {
      el.style.display = el.getAttribute(HIDDEN_ATTR) || '';
      el.removeAttribute(HIDDEN_ATTR);
    }
  }

  /**
   * The wrapper around bilibili's own clock, if this player generation has one
   * with a stable class name.
   */
  function resolveTimeBox() {
    return queryFirst(SELECTORS.timeBox);
  }

  /**
   * The `/` that sits between the two clocks. Only needed for player builds
   * with no classed wrapper, where we must hide the three pieces ourselves.
   * The child-count guard keeps us from ever reaching outside the clock.
   */
  function resolveDividerEl(currentEl) {
    const parent = currentEl && currentEl.parentNode;
    if (!parent || !parent.children || parent.children.length > 6) return null;
    const kids = parent.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === currentEl || kids[i] === state.durationEl) continue;
      if ((kids[i].textContent || '').trim() === '/') return kids[i];
    }
    return null;
  }

  /**
   * Blank out the *contents* of bilibili's clock box while leaving the box
   * itself in the layout.
   *
   * Hiding the box outright was the obvious move, but it also throws away
   * everything the box contributes — its padding, its height, and the control
   * bar's vertical centring — so our readout ended up a few pixels off from
   * where `00:02` used to sit. Keeping the box and hiding only its children
   * means our readout is laid out by exactly the same rules the native clock
   * was.
   *
   * `state.badge` is skipped so re-running this never hides our own readout.
   */
  function setBoxChildrenHidden(box, hidden) {
    if (!box || !box.children) return;
    const kids = box.children;
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] === state.badge) continue;
      setNativeHidden(kids[i], hidden);
    }
  }

  /**
   * Hide/show a clock piece, but only when the box does not already own it.
   *
   * Both code paths below can point at the same node — the elapsed clock is a
   * piece *and* a child of the box — and the piece-wise path would happily undo
   * the box loop in the same call.
   */
  function setPieceHidden(el, hidden) {
    if (!el) return;
    if (state.timeBox && state.timeBox.contains(el)) return;
    setNativeHidden(el, hidden);
  }

  /**
   * Apply the current `style` to bilibili's own clocks. Safe to call
   * repeatedly: it only touches nodes this script previously hid.
   *
   * In plugin style the box stays where it is but its contents — both clocks
   * and the `/` between them — are blanked out, leaving our single `387s`
   * readout as the only thing in it. When the player has no recognisable
   * wrapper we fall back to hiding the two clocks and the divider
   * individually.
   */
  function applyNativeVisibility() {
    const solo = config.enabled && config.style === 'plugin';
    setBoxChildrenHidden(state.timeBox, solo);
    const hidePieces = solo && !state.timeBox;
    setPieceHidden(state.currentEl, hidePieces);
    setPieceHidden(state.durationEl, hidePieces);
    setPieceHidden(state.dividerEl, hidePieces);
  }

  /**
   * Undo every `display` override, e.g. when the script is switched off.
   */
  function restoreNativeClocks() {
    const marked = document.querySelectorAll('[' + HIDDEN_ATTR + ']');
    for (let i = 0; i < marked.length; i++) {
      const el = marked[i];
      el.style.display = el.getAttribute(HIDDEN_ATTR) || '';
      el.removeAttribute(HIDDEN_ATTR);
    }
  }

  /*
   * This script deliberately never writes an inline `position` (or any other
   * layout property) onto a bilibili element. An earlier version did, to anchor
   * a bottom-left overlay: it had to make the player container `relative`, but
   * an inline style outranks the stylesheet, and bilibili's "web fullscreen"
   * (网页全屏) works by switching that very container to `position:fixed` — so
   * the leftover stamp silently disabled web fullscreen for good. The overlay
   * is gone; the only property this script ever overrides on a bilibili
   * element is `display`, and every such node is tagged with HIDDEN_ATTR so it
   * can be restored exactly.
   */

  function queryFirst(selectors) {
    for (let i = 0; i < selectors.length; i++) {
      const el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  /* ------------------------------------------------------------------ *
   * DOM discovery
   * ------------------------------------------------------------------ */

  /** The `<video>` of the *main* player (never a hover-preview or mini player). */
  function resolveVideo() {
    const roots = [document.querySelector('#bilibili-player'), document.querySelector('.bpx-player-container')];
    for (let i = 0; i < roots.length; i++) {
      if (!roots[i]) continue;
      const vids = roots[i].querySelectorAll('video');
      let fallback = null;
      for (let j = 0; j < vids.length; j++) {
        const v = vids[j];
        if (!fallback) fallback = v;
        if (v.readyState > 0 || Number.isFinite(v.duration)) return v;
      }
      if (fallback) return fallback;
    }
    return null;
  }

  /**
   * Structural fallback: scan the control bar for leaf nodes whose text is a
   * clock. The first is the elapsed time, the last is the total duration.
   */
  function guessTimeNodes() {
    for (let i = 0; i < SELECTORS.bars.length; i++) {
      const bar = document.querySelector(SELECTORS.bars[i]);
      if (!bar) continue;
      const candidates = bar.querySelectorAll('span, div, p');
      const hits = [];
      for (let j = 0; j < candidates.length; j++) {
        const el = candidates[j];
        if (el.children.length !== 0) continue;
        if (el.classList.contains(CLS_SEC)) continue;
        if (TIME_TEXT_RE.test(el.textContent || '')) hits.push(el);
      }
      if (hits.length) {
        return { current: hits[0], duration: hits.length > 1 ? hits[hits.length - 1] : null };
      }
    }
    return null;
  }

  function resolveTimeNodes() {
    const current = queryFirst(SELECTORS.current);
    let duration = queryFirst(SELECTORS.duration);
    if (current) return { current: current, duration: duration };
    const guess = guessTimeNodes();
    if (guess) return { current: guess.current, duration: duration || guess.duration };
    return { current: null, duration: duration };
  }

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const state = {
    video: null,
    currentEl: null,
    durationEl: null,
    timeBox: null,      // the wrapper holding both native clocks
    dividerEl: null,    // the `/` between them (only when there is no wrapper)
    badge: null,        // live-seconds readout
    badgeAnchor: null,
    /** Native styling we last copied onto the readout; see syncNativeAppearance(). */
    syncedStyle: null,
    /** Timestamp until which we re-check that styling every frame, not per heartbeat. */
    settleUntil: 0,
    lastText: null,
    lastTickAt: 0,
    frameHandle: null,
    framePending: false,
    /** Consecutive ticks with no resolvable clock node; gates the warning only. */
    missCount: 0,
  };

  /* ------------------------------------------------------------------ *
   * Styles
   * ------------------------------------------------------------------ */

  function injectStyle() {
    if (document.getElementById(CLS_STYLE)) return;
    const style = document.createElement('style');
    style.id = CLS_STYLE;
    style.textContent = [
      '.' + CLS_SEC + '{',
      '  display:inline-flex;align-items:center;',
      '  margin:0 2px 0 4px;padding:0 1px;',
      '  font:inherit;font-size:12px;line-height:1;',
      '  font-variant-numeric:tabular-nums;',
      '  color:inherit;opacity:.72;',
      '  cursor:pointer;user-select:none;white-space:nowrap;',
      '  transition:opacity .15s ease,color .15s ease,filter .15s ease;',
      '}',
      '.' + CLS_SEC + ':hover{opacity:1;}',
      /*
       * Solo variant: the readout is standing in for bilibili's entire clock,
       * so it lives *inside* the clock's own box and copies the clock's own
       * colour and opacity. Both are pushed in at runtime by
       * `syncNativeAppearance()` as custom properties rather than inline
       * values, so the `:hover` rules below can still take over.
       */
      '.' + CLS_SEC + '.' + CLS_SOLO + '{',
      '  margin:0;padding:0;',
      '  color:var(--bst-clock-color,inherit);',
      '  opacity:var(--bst-clock-opacity,1);',
      '}',
      /*
       * Hover feedback is deliberately NOT a colour change. bilibili's own
       * clock stays white and merely brightens when you point at it, so we do
       * the same: lift the copied opacity to 1 and give it a small brightness
       * boost. `color` is re-declared so nothing darker can leak in from a
       * future generic rule.
       */
      '.' + CLS_SEC + '.' + CLS_SOLO + ':hover{',
      '  color:var(--bst-clock-color,inherit);',
      '  opacity:1;filter:brightness(1.35);',
      '}',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ *
   * Injection
   * ------------------------------------------------------------------ */

  function makeBadge(extraClass, title) {
    const el = document.createElement('span');
    el.className = extraClass ? CLS_SEC + ' ' + extraClass : CLS_SEC;
    el.textContent = '--';
    if (title) el.title = title;
    return el;
  }

  /** Tooltip for the live readout; wording follows the current mode. */
  function liveBadgeTitle() {
    const what = config.mode === 'remaining' ? '剩余时间' : '已播时间';
    return what + '（秒）。点击时间点切换显示样式';
  }

  /**
   * Copy bilibili's own clock styling onto our readout.
   *
   * Sitting inside the clock box gets us the box's layout, but not its colour:
   * the player paints the clock with a rule aimed at the *child*
   * (`...-ctrl-time-current{color:#fff}`), which does not inherit down to us.
   * Reading it off the live element instead of hard-coding a hex value keeps
   * us in step with whatever skin / theme / fullscreen scaling is in effect.
   *
   * Those values are *not* stable. bilibili injects its player stylesheet in
   * several passes and rescales the control bar as the layout lands, so a
   * reading taken the moment we attach can be a placeholder it replaces a
   * moment later. Snapshotting once made that placeholder stick: the readout
   * kept the wrong font until the next resize or style toggle happened to
   * force another read. So compare against what we last copied and refresh
   * whenever bilibili's own value moves; the heartbeat drives this.
   *
   * Colour and opacity go in as custom properties so the stylesheet's
   * `:hover` feedback still wins; the font metrics can safely be inline.
   */
  function syncNativeAppearance() {
    if (!state.badge) return;
    const src = state.currentEl;
    if (!src || typeof getComputedStyle !== 'function') return;
    let cs = null;
    try {
      cs = getComputedStyle(src);
    } catch (e) {
      return;
    }
    if (!cs) return;
    // A detached or not-yet-rendered source reports nothing at all. Keep the
    // last good reading instead of blanking the readout out.
    if (!cs.fontSize) return;

    const next = {
      color: cs.color || '',
      opacity: cs.opacity || '',
      fontSize: cs.fontSize,
      fontWeight: cs.fontWeight || '',
      fontFamily: cs.fontFamily || '',
      lineHeight: cs.lineHeight || '',
    };
    const prev = state.syncedStyle;
    if (
      prev &&
      prev.color === next.color &&
      prev.opacity === next.opacity &&
      prev.fontSize === next.fontSize &&
      prev.fontWeight === next.fontWeight &&
      prev.fontFamily === next.fontFamily &&
      prev.lineHeight === next.lineHeight
    ) {
      return;
    }
    state.syncedStyle = next;

    const s = state.badge.style;
    if (next.color) s.setProperty('--bst-clock-color', next.color);
    if (next.opacity) s.setProperty('--bst-clock-opacity', next.opacity);
    s.fontSize = next.fontSize;
    if (next.fontWeight) s.fontWeight = next.fontWeight;
    if (next.fontFamily) s.fontFamily = next.fontFamily;
    if (next.lineHeight) s.lineHeight = next.lineHeight;
  }

  /** Re-sync after bilibili rescales its control bar (fullscreen / resize). */
  function onViewportChange() {
    syncNativeAppearance();
  }

  /**
   * The live seconds readout. It goes *inside* bilibili's clock box, in the
   * slot the native elapsed clock occupied — the box's own padding, height and
   * vertical centring then place it exactly where `00:02` used to be. Only
   * when there is no classed box do we fall back to sitting next to the
   * elapsed clock.
   */
  function placeLiveBadge() {
    const box = state.timeBox;
    const anchor = box || state.currentEl;
    if (!anchor) return false;
    if (state.badge && state.badge.isConnected && state.badgeAnchor === anchor) {
      syncNativeAppearance();
      return true;
    }
    removeBadge();
    state.badge = makeBadge(CLS_SOLO, liveBadgeTitle());
    if (box) box.insertBefore(state.badge, box.firstChild);
    else if (anchor.parentNode) anchor.insertAdjacentElement('afterend', state.badge);
    else anchor.appendChild(state.badge);
    state.badgeAnchor = anchor;
    state.settleUntil = Date.now() + APPEARANCE_SETTLE_MS;
    syncNativeAppearance();
    return true;
  }

  /**
   * Remove every readout from the document, including ones we no longer track.
   *
   * Our badge lives *inside* bilibili's clock box, so if the player ever
   * detaches that box and re-attaches the same element (rather than rebuilding
   * the control bar from scratch), the stale badge rides back in with it and we
   * would end up with two readouts. Sweeping by class makes that impossible.
   */
  function removeBadge() {
    if (state.badge && state.badge.isConnected) state.badge.remove();
    state.badge = null;
    state.badgeAnchor = null;
    state.syncedStyle = null;
    state.lastText = null;
    const strays = document.querySelectorAll('.' + CLS_SEC);
    for (let i = 0; i < strays.length; i++) {
      if (strays[i].parentNode) strays[i].remove();
    }
  }

  function teardown() {
    removeBadge();
    restoreNativeClocks();
    state.timeBox = null;
    state.dividerEl = null;
  }

  /** (Re)attach the readout to whatever player DOM currently exists. */
  function ensureInjected() {
    if (!config.enabled) {
      teardown();
      return false;
    }
    const video = resolveVideo();
    if (!video) return false;
    state.video = video;
    bindVideo(video);

    const nodes = resolveTimeNodes();
    state.currentEl = nodes.current;
    state.durationEl = nodes.duration;
    state.timeBox = nodes.current ? resolveTimeBox() : null;
    state.dividerEl = nodes.current && !state.timeBox ? resolveDividerEl(nodes.current) : null;

    if (config.style === 'native') {
      /*
       * 默认样式：把时间区域完整交还给 B 站。这里仍然解析时钟节点，因为它是点击
       * 切回插件样式的落点；但既不显示自己的读数，也不去改它的 display。
       */
      removeBadge();
      state.missCount = 0;
      applyNativeVisibility();
      return true;
    }

    if (!(nodes.current && nodes.current.parentNode)) {
      /*
       * 找不到时钟节点时**什么都不显示**，也绝不碰播放器的布局。
       *
       * 早期版本会在这里降级成一个钉在播放器左下角的浮层读数，代价是必须给
       * 播放器容器写内联 `position:relative` 当定位祖先。内联样式优先级高于
       * 样式表，而 B 站的网页全屏恰恰是靠把同一个容器切成 `position:fixed`
       * 实现的——一个残留的内联 `position` 会让网页全屏永久失效。这条降级
       * 路径已整体删除，脚本从此不再写任何布局属性到 B 站元素上。
       *
       * 控制栏在切清晰度 / 进出全屏时会被整条重建，所以短暂 miss 是正常的，
       * 提示信息等连续 miss 够久（约 3 秒）再打，避免首屏刷一堆吓人的日志。
       */
      removeBadge();
      state.missCount += 1;
      if (state.missCount === WARN_AFTER_MISSES) {
        log(
          '没找到 B 站原生的时间节点，暂时不显示读数（不会改动播放器布局）。\n' +
          '若读数一直不出现，请在控制台运行下列命令，并把输出反馈给作者以补充精确选择器：\n' +
          '  __biliSecTimepoint.resolveTimeNodes()\n' +
          '  __biliSecTimepoint.guessTimeNodes()'
        );
      }
      return false;
    }

    state.missCount = 0;
    placeLiveBadge();
    applyNativeVisibility();
    update(true);
    return true;
  }

  /* ------------------------------------------------------------------ *
   * Updating
   * ------------------------------------------------------------------ */

  function update(force) {
    const video = state.video && state.video.isConnected ? state.video : resolveVideo();
    if (!video) return;
    state.video = video;

    if (state.badge && state.badge.isConnected) {
      if (Date.now() < state.settleUntil) syncNativeAppearance();
      const text = formatSeconds(readoutSeconds(video), config.precision);
      if (force || text !== state.lastText) {
        state.badge.textContent = text;
        state.lastText = text;
      }
    }
  }

  /**
   * Drive the readout from the video's own frame cadence when possible
   * (`requestVideoFrameCallback`), otherwise from `requestAnimationFrame`,
   * throttled so a 60fps decode loop does not cause 60 DOM writes/second.
   */
  function scheduleFrame() {
    const video = state.video;
    if (!config.enabled || config.style !== 'plugin' || !video || state.framePending) return;
    state.framePending = true;

    const run = function () {
      state.framePending = false;
      const now = Date.now();
      if (now - state.lastTickAt >= TICK_MIN_INTERVAL_MS) {
        state.lastTickAt = now;
        update(false);
      }
      if (state.video && !state.video.paused) scheduleFrame();
    };

    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(run);
    } else if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      state.framePending = false;
      setTimeout(run, TICK_MIN_INTERVAL_MS);
    }
  }

  const boundVideos = new WeakSet();

  function bindVideo(video) {
    if (boundVideos.has(video)) return;
    boundVideos.add(video);
    const onChange = function () { update(true); };
    ['loadedmetadata', 'durationchange', 'seeked', 'seeking', 'ratechange', 'emptied', 'ended']
      .forEach(function (type) { video.addEventListener(type, onChange); });
    video.addEventListener('play', function () { update(true); scheduleFrame(); });
    video.addEventListener('pause', function () { update(true); });
    video.addEventListener('timeupdate', function () { update(false); });
  }

  /* ------------------------------------------------------------------ *
   * Click the timepoint to switch styles
   *
   * Bilibili opens a "type a time and jump there" editor when its clock is
   * clicked. We take that gesture over: a capture-phase listener on `document`
   * runs before any handler bilibili bound on the clock itself, so swallowing
   * the event there both suppresses its editor and lets the click toggle
   * between the plugin readout and bilibili's original clock.
   * ------------------------------------------------------------------ */

  /** Does this click land on the time readout — ours or bilibili's? */
  function isTimepointTarget(target) {
    if (!target || !target.nodeType) return false;
    const parts = [state.badge, state.timeBox, state.currentEl, state.durationEl];
    for (let i = 0; i < parts.length; i++) {
      const el = parts[i];
      if (el && typeof el.contains === 'function' && el.contains(target)) return true;
    }
    return false;
  }

  function toggleStyle() {
    config.style = config.style === 'plugin' ? 'native' : 'plugin';
    applyConfig();
    log(config.style === 'plugin' ? '显示样式：插件样式（只有剩余秒数）。' : '显示样式：B 站默认。');
  }

  /** Swallow the press so bilibili's "type a time" editor never opens. */
  function onTimepointMouseDown(event) {
    if (!config.enabled || !config.clickToToggle) return;
    if (!isTimepointTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onTimepointClick(event) {
    if (!config.enabled || !config.clickToToggle) return;
    if (!isTimepointTarget(event.target)) return;
    event.preventDefault();
    event.stopPropagation();
    toggleStyle();
  }

  /* ------------------------------------------------------------------ *
   * Settings menu
   * ------------------------------------------------------------------ */

  const menuIds = [];

  function unregisterMenus() {
    if (typeof GM_unregisterMenuCommand === 'function') {
      menuIds.forEach(function (id) { try { GM_unregisterMenuCommand(id); } catch (_) {} });
    }
    menuIds.length = 0;
  }

  function registerMenus() {
    if (typeof GM_registerMenuCommand !== 'function') return;
    unregisterMenus();
    menuIds.push(GM_registerMenuCommand(
      (config.enabled ? '✅' : '⬜') + ' 显示秒数',
      function () { config.enabled = !config.enabled; applyConfig(); }
    ));
    menuIds.push(GM_registerMenuCommand(
      config.style === 'plugin'
        ? '样式：插件（只有剩余秒数）→ 点击改为 B 站默认'
        : '样式：B 站默认 → 点击改为插件样式',
      function () { toggleStyle(); }
    ));
    menuIds.push(GM_registerMenuCommand(
      config.mode === 'remaining' ? '模式：显示剩余秒数（点击改为已播）' : '模式：显示已播秒数（点击改为剩余）',
      function () {
        config.mode = config.mode === 'remaining' ? 'elapsed' : 'remaining';
        applyConfig();
      }
    ));
    menuIds.push(GM_registerMenuCommand(
      '小数位数：' + config.precision + ' 位（点击切换）',
      function () { config.precision = (config.precision + 1) % 4; applyConfig(); }
    ));
    menuIds.push(GM_registerMenuCommand(
      (config.clickToToggle ? '✅' : '⬜') + ' 点击时间点切换样式',
      function () { config.clickToToggle = !config.clickToToggle; applyConfig(); }
    ));
  }

  function applyConfig() {
    saveConfig();
    registerMenus();
    if (!config.enabled) {
      teardown();
      return;
    }
    ensureInjected();
    applyNativeVisibility();
    if (state.badge) state.badge.title = liveBadgeTitle();
    update(true);
    scheduleFrame();
  }

  /* ------------------------------------------------------------------ *
   * Lifecycle / SPA navigation
   * ------------------------------------------------------------------ */

  let lastHref = location.href;

  function heartbeat() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      teardown();
      ensureInjected();
      scheduleFrame();
      return;
    }
    if (!config.enabled) return;
    /*
     * Which element going missing means "we need to re-inject" depends on the
     * style: in plugin mode it is our own readout, in native mode we render
     * nothing at all and the only thing worth tracking is bilibili's clock.
     */
    const needsInject = config.style === 'plugin'
      ? (!state.badge || !state.badge.isConnected)
      : (!state.currentEl || !state.currentEl.isConnected);
    if (needsInject) {
      ensureInjected();
      return;
    }
    /*
     * Everything we depend on is still in place, so there is nothing to
     * re-inject — but bilibili may have restyled its clock since the last
     * tick (the player's stylesheet lands in several passes, and the control
     * bar is rescaled as the layout settles). Cheap enough to re-check here,
     * and it only writes when a value actually moved.
     */
    syncNativeAppearance();
    const video = resolveVideo();
    if (video && video !== state.video) {
      state.video = video;
      bindVideo(video);
      update(true);
      scheduleFrame();
      return;
    }
    update(false);
  }

  function start() {
    log('v' + VERSION + ' 已加载，调试入口：__biliSecTimepoint');
    injectStyle();
    registerMenus();
    ensureInjected();
    scheduleFrame();
    setInterval(heartbeat, HEARTBEAT_MS);
    // Capture-phase, so we run before any handler bilibili bound on the clock.
    document.addEventListener('mousedown', onTimepointMouseDown, true);
    document.addEventListener('click', onTimepointClick, true);
    // bilibili pushes history entries for every in-page video switch.
    ['pushState', 'replaceState'].forEach(function (name) {
      const original = history[name];
      if (typeof original !== 'function') return;
      history[name] = function () {
        const result = original.apply(this, arguments);
        setTimeout(heartbeat, 0);
        return result;
      };
    });
    window.addEventListener('popstate', heartbeat);
    // The control bar is rescaled on fullscreen / window resize, so the font
    // metrics we copied onto the readout go stale; refresh them either way.
    window.addEventListener('resize', onViewportChange, { passive: true });
    document.addEventListener('fullscreenchange', onViewportChange);
    document.addEventListener('webkitfullscreenchange', onViewportChange);
  }

  /* ------------------------------------------------------------------ *
   * Debug / test surface
   * ------------------------------------------------------------------ */

  const videoBindings = []; // reserved for future unbinding; kept for debug inspection
  /*
   * Everything this script changes on someone else's element is tagged with a
   * `data-bst-*` attribute, so this inventory is complete.
   */
  function describeMutations() {
    const inventory = (selector, attr) => Array.prototype.map.call(
      document.querySelectorAll(selector),
      (el) => ({
        tag: el.tagName.toLowerCase(),
        className: String(el.className || ''),
        previousValue: el.getAttribute(attr),
        inlineStyle: el.getAttribute('style') || '',
      })
    );
    return {
      readouts: document.querySelectorAll('.' + CLS_SEC).length,
      hiddenClocks: inventory('[' + HIDDEN_ATTR + ']', HIDDEN_ATTR),
      missCount: state.missCount,
    };
  }

  /**
   * Undo every change made to bilibili's own DOM, then report what was undone.
   * Escape hatch for "something on the player stopped working": run it and try
   * the broken feature again. The next heartbeat will re-hide the native clocks
   * if the script is still meant to be showing its readout, so switch the
   * script off first if you want the revert to stick.
   */
  function revertDomMutations() {
    restoreNativeClocks();
    const inventory = describeMutations();
    log('已撤销对 B 站 DOM 的全部改动：', inventory);
    return inventory;
  }

  const debugApi = {
    version: VERSION,
    config: config,
    state: state,
    update: update,
    ensureInjected: ensureInjected,
    heartbeat: heartbeat,
    scheduleFrame: scheduleFrame,
    teardown: teardown,
    formatSeconds: formatSeconds,
    readoutSeconds: readoutSeconds,
    applyNativeVisibility: applyNativeVisibility,
    syncNativeAppearance: syncNativeAppearance,
    restoreNativeClocks: restoreNativeClocks,
    resolveTimeNodes: resolveTimeNodes,
    resolveTimeBox: resolveTimeBox,
    resolveDividerEl: resolveDividerEl,
    guessTimeNodes: guessTimeNodes,
    resolveVideo: resolveVideo,
    toggleStyle: toggleStyle,
    isTimepointTarget: isTimepointTarget,
    applyConfig: applyConfig,
    describeMutations: describeMutations,
    revertDomMutations: revertDomMutations,
  };

  /*
   * A userscript that uses `@grant` runs inside the manager's sandbox, so a
   * plain `window.x = ...` may be invisible to the DevTools console (which
   * evaluates in the page's own context) — which shows up as the confusing
   * "Uncaught ReferenceError: __biliSecTimepoint is not defined". Publish the
   * handle on the real page window as well.
   */
  window.__biliSecTimepoint = debugApi;
  try {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow !== window) {
      unsafeWindow.__biliSecTimepoint = debugApi;
    }
  } catch (err) {
    // Reaching the page window can be denied; the sandbox global still works.
  }

  function boot() {
    try {
      start();
    } catch (err) {
      log('启动失败，请把下面的报错反馈给作者：', err);
      throw err;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
