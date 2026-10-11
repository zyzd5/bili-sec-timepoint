/**
 * Offline test suite for bili-sec-timepoint.user.js
 *
 * Runs the real userscript inside jsdom against three different bilibili
 * player DOM shapes:
 *
 *   1. modern  — today's `.bpx-player-ctrl-time-*` markup (exact selectors)
 *   2. renamed — the same structure with unknown class names (heuristic path)
 *   3. bare    — a player with no clock node at all (nothing is displayed)
 *
 * jsdom does not implement media playback, so the <video> element's
 * `currentTime` / `duration` / `paused` are replaced with controllable stubs.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(HERE, '..', 'bili-sec-timepoint.user.js');
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, 'utf8');

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

const results = [];
let currentGroup = '(none)';

function group(name) {
  currentGroup = name;
  results.push({ kind: 'group', name });
}

function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  results.push({ kind: 'assert', group: currentGroup, label, ok, actual, expected });
  return ok;
}

function checkThat(label, condition, detail) {
  const ok = !!condition;
  results.push({ kind: 'assert', group: currentGroup, label, ok, actual: detail, expected: 'truthy' });
  return ok;
}

/* ------------------------------------------------------------------ *
 * jsdom scaffolding
 * ------------------------------------------------------------------ */

const PLAYER_MODERN = `
  <div id="bilibili-player">
    <div class="bpx-player-container">
      <div class="bpx-player-video-wrap"><video id="v"></video></div>
      <div class="bpx-player-control-wrap">
        <div class="bpx-player-control-bottom">
          <div class="bpx-player-ctrl-time">
            <span class="bpx-player-ctrl-time-current">00:02</span>
            <span class="bpx-player-ctrl-time-divide">/</span>
            <span class="bpx-player-ctrl-time-duration">06:29</span>
          </div>
        </div>
      </div>
    </div>
  </div>`;

const PLAYER_RENAMED = `
  <div id="bilibili-player">
    <div class="bpx-player-container">
      <div class="bpx-player-video-wrap"><video id="v"></video></div>
      <div class="bpx-player-control-bottom">
        <div class="weird-clock-box">
          <span class="weird-clock-elapsed">00:02</span>
          <span class="weird-clock-slash">/</span>
          <span class="weird-clock-total">06:29</span>
        </div>
      </div>
    </div>
  </div>`;

const PLAYER_BARE = `
  <div id="bilibili-player">
    <div class="bpx-player-container">
      <div class="bpx-player-video-wrap"><video id="v"></video></div>
      <div class="bpx-player-control-bottom"><span class="dummy">弹幕</span></div>
    </div>
  </div>`;

/**
 * Boot a jsdom window with the given player markup and execute the userscript.
 * Returns the window plus the test-facing handles we need.
 */
function boot(html, {
  url = 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2',
  media = {},
  stored = null,   // raw value the GM store hands back for the config key
} = {}) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url,
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  const errors = [];
  window.addEventListener('error', (e) => errors.push(String(e.message || e)));

  // --- GM_* stubs -------------------------------------------------
  const menus = [];
  window.GM_getValue = (_key, fallback) => (stored === null ? fallback : stored);
  window.GM_setValue = () => {};
  window.GM_registerMenuCommand = (label) => { menus.push(label); return menus.length; };
  window.GM_unregisterMenuCommand = () => {};

  // --- console capture --------------------------------------------
  // The startup banner and the "found no clock" message are the two
  // diagnostics a user relies on to tell "script never ran" apart from "script
  // ran but found no clock", so they are asserted below.
  const logs = [];
  window.console.log = function () {
    logs.push(Array.prototype.slice.call(arguments).join(' '));
  };

  // --- media stubs ------------------------------------------------
  const video = window.document.getElementById('v');
  const mediaState = {
    currentTime: media.currentTime ?? 2.4,
    duration: media.duration ?? 389.4,
    paused: media.paused ?? true,
    readyState: media.readyState ?? 4,
  };
  for (const key of ['currentTime', 'duration', 'paused', 'readyState']) {
    Object.defineProperty(video, key, {
      configurable: true,
      get: () => mediaState[key],
      set: (v) => { mediaState[key] = v; },
    });
  }
  video.play = () => { mediaState.paused = false; };
  video.pause = () => { mediaState.paused = true; };

  // --- run the userscript ----------------------------------------
  const script = window.document.createElement('script');
  script.textContent = SCRIPT_SOURCE;
  window.document.head.appendChild(script);

  const api = window.__biliSecTimepoint;
  if (api) {
    // Make sure the DOMContentLoaded branch (if taken) has fired.
    window.document.dispatchEvent(new window.Event('DOMContentLoaded'));
    window.dispatchEvent(new window.Event('DOMContentLoaded'));
  }

  return { dom, window, doc: window.document, api, menus, mediaState, video, errors, logs };
}

/** Let the script's event handlers finish before asserting on their effects. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const badgeOf = (doc, extra = '') => doc.querySelector('.bst-sec' + extra);

/* ------------------------------------------------------------------ *
 * 1. Pure helpers
 * ------------------------------------------------------------------ */

function testHelpers(api) {
  group('debug surface reachable from the DevTools console');
  check('handle published on the page window', typeof api, 'object');
  check('handle reports its version', typeof api.version, 'string');
  check('resolveTimeNodes is callable', typeof api.resolveTimeNodes, 'function');
  check('guessTimeNodes is callable', typeof api.guessTimeNodes, 'function');
  check('readoutSeconds is callable', typeof api.readoutSeconds, 'function');
  check('toggleStyle is callable', typeof api.toggleStyle, 'function');
  check('but the removed copy helper is not exposed', typeof api.buildTimepointUrl, 'undefined');

  group('formatSeconds');
  check('1 decimal', api.formatSeconds(2.44, 1), '2.4s');
  check('0 decimals', api.formatSeconds(389.4, 0), '389s');
  check('3 decimals', api.formatSeconds(2.125, 3), '2.125s');
  check('precision is clamped high', api.formatSeconds(1.5, 99), '1.500s');
  check('precision is clamped low', api.formatSeconds(1.5, -3), '2s');
  check('NaN renders placeholder', api.formatSeconds(NaN, 1), '--');
  check('Infinity renders placeholder', api.formatSeconds(Infinity, 1), '--');
  check('negative renders placeholder', api.formatSeconds(-1, 1), '--');

  group('readoutSeconds');
  const fakeVideo = { currentTime: 10, duration: 100 };
  check('the default mode is a countdown', api.config.mode, 'remaining');
  check('the default style is the plugin one', api.config.style, 'plugin');
  check('and it defaults to whole seconds', api.config.precision, 0);
  api.config.mode = 'elapsed';
  check('elapsed counts up', api.readoutSeconds(fakeVideo), 10);
  api.config.mode = 'remaining';
  check('remaining counts down', api.readoutSeconds(fakeVideo), 90);
  checkThat(
    'remaining is NaN until duration is known',
    Number.isNaN(api.readoutSeconds({ currentTime: 10, duration: NaN }))
  );
  checkThat('no video yields NaN', Number.isNaN(api.readoutSeconds(null)));

  group('guessTimeNodes leaves non-clock text alone');
  checkThat('regex rejects the divide token', !/^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/.test('/'));
  checkThat('regex accepts hh:mm:ss', /^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/.test('1:02:31'));
  checkThat('regex rejects danmaku counts', !/^\s*\d{1,3}:\d{2}(?::\d{2})?\s*$/.test('151000'));
}

/* ------------------------------------------------------------------ *
 * 2. Modern player (exact selectors)
 * ------------------------------------------------------------------ */

async function testModern() {
  const t = boot(PLAYER_MODERN);
  checkThat('api is exposed', !!t.api);
  check('no init errors', t.errors.length, 0);

  group('modern player: injection point');
  const timeBox = t.doc.querySelector('.bpx-player-ctrl-time');
  const badge = badgeOf(t.doc);
  checkThat('live badge exists', !!badge);
  checkThat('badge lives inside the native time box', badge.parentNode === timeBox);
  checkThat('and takes over the slot the elapsed clock had', timeBox.firstElementChild === badge);
  checkThat('badge uses the standalone class', badge.classList.contains('bst-sec--solo'));

  group('modern player: values (a bare countdown, nothing else)');
  check('live seconds counts down from the duration', badge.textContent, '387s');
  check('there is exactly one readout', t.doc.querySelectorAll('.bst-sec').length, 1);
  checkThat('no duration readout is added any more', !badgeOf(t.doc, '.bst-sec--duration'));
  checkThat('no floating readout is ever created', t.doc.querySelectorAll('.bst-sec--overlay').length === 0);

  group('modern player: hover brightens instead of turning blue');
  /*
   * bilibili's own clock stays white and just brightens under the cursor, so
   * the plugin readout must do the same. There is no longer any blue anywhere
   * in the readout's styling.
   */
  const css = t.doc.getElementById('bst-style').textContent;
  const soloHover = (css.match(/\.bst-sec\.bst-sec--solo:hover\{[^}]*\}/) || [''])[0];
  checkThat('the solo hover rule exists', soloHover.length > 0);
  checkThat('it does not switch the colour to bilibili blue', soloHover.indexOf('#00aeec') === -1);
  checkThat('it re-declares the borrowed clock colour', soloHover.indexOf('var(--bst-clock-color') !== -1);
  checkThat('it lifts the borrowed opacity to full', /opacity:1/.test(soloHover));
  checkThat('and it brightens the text', /brightness\(/.test(soloHover));
  checkThat('no rule anywhere reintroduces bilibili blue', css.indexOf('#00aeec') === -1);
  checkThat('and the removed copied-flash state is gone', css.indexOf('bst-sec--copied') === -1);
  const baseRule = (css.match(/\.bst-sec\{[^}]*\}/) || [''])[0];
  checkThat('the brightening is transitioned, not instant', /transition:[^;}]*filter/.test(baseRule));

  group('modern player: live updates');
  t.mediaState.currentTime = 12.5;
  t.api.update(true);
  check('badge counts down as playback advances', badge.textContent, '377s');
  t.mediaState.currentTime = 65.06;
  t.api.update(false);
  check('badge tracks a second change', badge.textContent, '324s');

  group('modern player: switching to elapsed mode');
  t.api.config.mode = 'elapsed';
  t.api.applyConfig();
  check('badge now counts up instead', badge.textContent, '65s');
  checkThat('tooltip mentions elapsed, not remaining', badge.title.includes('已播'));
  t.api.config.mode = 'remaining';
  t.api.applyConfig();
  check('switching back gives a countdown again', badge.textContent, '324s');

  group('modern player: the native clock is blanked out, not destroyed');
  const nativeCurrent = t.doc.querySelector('.bpx-player-ctrl-time-current');
  const nativeTotal = t.doc.querySelector('.bpx-player-ctrl-time-duration');
  const nativeDivide = t.doc.querySelector('.bpx-player-ctrl-time-divide');
  /*
   * The box itself keeps its place in the layout: it is what contributes the
   * control bar's padding, height and vertical centring. Hiding the box rather
   * than its contents is what left the readout sitting a few pixels off from
   * where `00:02` used to be.
   */
  check('the clock box keeps its place in the control bar', timeBox.style.display, '');
  checkThat('and was never stamped by us', !timeBox.hasAttribute('data-bst-hidden'));
  check('the elapsed clock inside it is hidden', nativeCurrent.style.display, 'none');
  check('the duration clock inside it is hidden', nativeTotal.style.display, 'none');
  check('so the "/" goes with them', nativeDivide.style.display, 'none');
  checkThat('we stamped the children', nativeCurrent.getAttribute('data-bst-hidden') === '');
  checkThat('our own readout is still visible', badge.isConnected && badge.style.display !== 'none');
  checkThat('blanking the contents did not reposition the player', t.doc.querySelectorAll('[data-bst-positioned]').length === 0);

  group('modern player: the readout borrows the clock\'s own look');
  /*
   * The player paints the clock with a rule aimed at the child
   * (`...-ctrl-time-current{color:#fff}`), which does not inherit into our
   * span, so we copy it off the live element rather than hard-coding a hex.
   * Colour and opacity travel as custom properties so `:hover` still wins.
   */
  nativeCurrent.style.color = 'rgb(1, 2, 3)';
  nativeCurrent.style.opacity = '0.72';
  nativeCurrent.style.fontSize = '22px';
  nativeCurrent.style.fontWeight = '600';
  t.api.syncNativeAppearance();
  check('colour copied from the native clock', badge.style.getPropertyValue('--bst-clock-color'), 'rgb(1, 2, 3)');
  check('opacity copied too, so nothing dims our readout', badge.style.getPropertyValue('--bst-clock-opacity'), '0.72');
  check('font size copied too', badge.style.fontSize, '22px');
  check('font weight copied too', badge.style.fontWeight, '600');

  group('modern player: switching back to the default style');
  t.api.config.style = 'native';
  t.api.applyConfig();
  checkThat('our readout is gone', !badgeOf(t.doc));
  check('elapsed clock restored', nativeCurrent.style.display, '');
  check('duration clock restored', nativeTotal.style.display, '');
  check('divider restored', nativeDivide.style.display, '');
  checkThat('override markers cleared', !nativeCurrent.hasAttribute('data-bst-hidden'));
  checkThat('restoring did not remove the native clock', t.doc.contains(nativeCurrent));
  check('no readout of ours survives anywhere', t.doc.querySelectorAll('.bst-sec').length, 0);

  group('modern player: the master switch also restores the native clock');
  t.api.config.style = 'plugin';
  t.api.config.enabled = false;
  t.api.applyConfig();
  check('all readouts removed', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('native clock is back after disabling', nativeCurrent.style.display, '');
  t.api.config.enabled = true;
  t.api.applyConfig();

  group('modern player: clicking the time point toggles the style');
  // Re-query: the groups above cycled the master switch, which tears the
  // readout down and rebuilds it, so any earlier handle is stale.
  const liveBadge = badgeOf(t.doc);
  checkThat('readout exists after the switch cycle', !!liveBadge);
  // Listeners on bilibili's own clock stand in for its "type a time" editor.
  let reachedClock = false;
  nativeCurrent.addEventListener('mousedown', () => { reachedClock = true; });
  nativeCurrent.addEventListener('click', () => { reachedClock = true; });
  t.mediaState.currentTime = 83.7;
  liveBadge.dispatchEvent(new t.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  liveBadge.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  checkThat('our handler swallowed the click before it reached the clock', !reachedClock);
  check('clicking the readout switched to the default style', t.api.config.style, 'native');
  check('so our readout is gone', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('and bilibili\'s clock is visible again', nativeCurrent.style.display, '');

  let reachedClockAgain = false;
  nativeCurrent.addEventListener('click', () => { reachedClockAgain = true; });
  nativeCurrent.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  checkThat('the native clock never sees the click either', !reachedClockAgain);
  check('clicking the native clock switched back to the plugin style', t.api.config.style, 'plugin');
  check('our readout is back, showing the remaining seconds', badgeOf(t.doc).textContent, '306s');

  group('modern player: the click toggle can be turned off');
  checkThat('it is on by default', t.api.config.clickToToggle === true);
  t.api.config.clickToToggle = false;
  t.api.applyConfig();
  badgeOf(t.doc).dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  check('style unchanged when clickToToggle is off', t.api.config.style, 'plugin');
  t.api.config.clickToToggle = true;
  t.api.applyConfig();

  group('modern player: the Alt+C copy feature is gone');
  const altC = new t.window.KeyboardEvent('keydown', {
    key: 'c', altKey: true, bubbles: true, cancelable: true,
  });
  t.doc.dispatchEvent(altC);
  await settle();
  checkThat('Alt+C is no longer swallowed, so the page keeps its own binding', !altC.defaultPrevented);
  checkThat('the timepoint-link builder is off the debug surface', !('buildTimepointUrl' in t.api));
  checkThat('the copy entry point is off the debug surface too', !('copyCurrentTimepoint' in t.api));

  group('modern player: menu commands');
  checkThat('registers menu entries', t.menus.length >= 4);
  checkThat('mentions the master switch', t.menus.some((m) => m.includes('显示秒数')));
  checkThat('offers the style toggle', t.menus.some((m) => m.includes('样式：')));
  checkThat('offers the click toggle', t.menus.some((m) => m.includes('点击时间点切换样式')));
  checkThat('mentions precision', t.menus.some((m) => m.includes('小数位数')));
  checkThat('offers the remaining/elapsed mode toggle', t.menus.some((m) => m.includes('模式：')));
  checkThat('no longer offers copying the timepoint', !t.menus.some((m) => m.includes('复制')));
  checkThat('and no longer advertises the Alt+C shortcut', !t.menus.some((m) => m.includes('Alt+C')));
  checkThat('no longer advertises the removed hide-native option', !t.menus.some((m) => m.includes('隐藏原生时间')));

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 2b. Config migration
 * ------------------------------------------------------------------ */

/**
 * A config written by an older build is a real thing users have in their
 * manager's storage. Two things must happen on load: keys belonging to deleted
 * features must not linger, and a schema bump must reset the *display* keys
 * (otherwise an old `precision: 1` would keep painting `387.0s`).
 */
function testConfigMigration() {
  group('config migration from an older schema');
  const stale = JSON.stringify({
    configVersion: 2,
    enabled: true,
    style: 'native',
    mode: 'elapsed',
    precision: 1,
    clickToToggle: false,
    altCShortcut: false,
    showDuration: true,
    hideNative: true,
    copyOnClick: true,
  });
  const t = boot(PLAYER_MODERN, { stored: stale });

  checkThat('the switch for the deleted copy feature is dropped', !('altCShortcut' in t.api.config));
  checkThat('the other retired keys are dropped too', !('hideNative' in t.api.config) && !('copyOnClick' in t.api.config) && !('showDuration' in t.api.config));
  checkThat('the schema version is stamped forward', t.api.config.configVersion !== 2);
  check('a stale style is reset by the bump', t.api.config.style, 'plugin');
  check('and so is a stale precision', t.api.config.precision, 0);
  check('but surviving switches still carry over', t.api.config.mode, 'elapsed');
  check('including the ones the user turned off', t.api.config.clickToToggle, false);
  check('the readout honours the migrated precision', t.api.formatSeconds(387.4, t.api.config.precision), '387s');

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 3. Renamed classes (heuristic path)
 * ------------------------------------------------------------------ */

async function testRenamed() {
  const t = boot(PLAYER_RENAMED);
  check('no init errors', t.errors.length, 0);

  group('renamed classes: heuristic discovery');
  const badge = badgeOf(t.doc);
  checkThat('live badge exists without known class names', !!badge);
  const elapsed = t.doc.querySelector('.weird-clock-elapsed');
  checkThat('anchored to the elapsed clock', badge && badge.previousElementSibling === elapsed);
  check('live seconds counts down', badge.textContent, '387s');
  checkThat('heuristically found the clock, so nothing floats', t.doc.querySelectorAll('.bst-sec--overlay').length === 0);

  // The unknown box is not in SELECTORS.timeBox, so the fallback path hides the
  // three pieces individually — including the "/" divider, which is found by
  // scanning the elapsed clock's siblings.
  group('renamed classes: the pieces are hidden individually');
  const slash = t.doc.querySelector('.weird-clock-slash');
  check('elapsed clock hidden', elapsed.style.display, 'none');
  check('the "/" divider hidden', slash.style.display, 'none');
  check('total clock hidden', t.doc.querySelector('.weird-clock-total').style.display, 'none');
  checkThat('the box we did not recognise was left alone',
    t.doc.querySelector('.weird-clock-box').style.display !== 'none');

  group('renamed classes: clicking toggles the style here too');
  badge.dispatchEvent(new t.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  await settle();
  check('switched to the default style', t.api.config.style, 'native');
  check('native clocks restored', elapsed.style.display, '');
  check('divider restored', slash.style.display, '');
  check('no readout left', t.doc.querySelectorAll('.bst-sec').length, 0);

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 4. Bare player (no clock node at all)
 *
 * There is deliberately NO fallback display: an earlier version floated a
 * readout in the bottom-left corner, which required stamping an inline
 * `position:relative` onto the player container, and that silently disabled
 * bilibili's web fullscreen (inline styles outrank the stylesheet, and web
 * fullscreen works by switching the same container to `position:fixed`).
 * ------------------------------------------------------------------ */

async function testBare() {
  const t = boot(PLAYER_BARE);
  check('no init errors', t.errors.length, 0);
  const root = t.doc.querySelector('#bilibili-player');

  group('bare player: nothing is displayed');
  check('no readout at all', t.doc.querySelectorAll('.bst-sec').length, 0);

  group('bare player: the player layout is left completely alone');
  check('player root has no inline style', root.getAttribute('style') || '', '');
  check('player root was not made relative', root.style.position, '');
  checkThat('no position stamp marker', !root.hasAttribute('data-bst-positioned'));
  check('no repositioned roots in the inventory', t.doc.querySelectorAll('[data-bst-positioned]').length, 0);
  checkThat('the report no longer even tracks repositioned roots', !('repositionedRoots' in t.api.describeMutations()));

  group('bare player: the warning waits out the grace period');
  // The control bar is rebuilt on quality/fullscreen changes, so one or two
  // misses are normal and must not spam the console on first paint.
  checkThat('no scary log at startup', !t.logs.some((l) => l.indexOf('没找到') !== -1));
  for (let i = 0; i < 3; i++) t.api.ensureInjected();
  checkThat('still quiet after a few misses', !t.logs.some((l) => l.indexOf('没找到') !== -1));
  for (let i = 0; i < 6; i++) t.api.ensureInjected();
  checkThat(
    'the warning appears once the miss is persistent',
    t.logs.some((l) => l.indexOf('没找到') !== -1)
  );
  checkThat(
    'and it tells the user which command to run',
    t.logs.some((l) => l.indexOf('resolveTimeNodes') !== -1)
  );
  check('still nothing displayed', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('root still untouched', root.getAttribute('style') || '', '');

  group('bare player: the console explains what happened');
  checkThat(
    'a startup banner proves the script ran at all',
    t.logs.some((l) => l.indexOf('[bili-sec-timepoint]') === 0)
  );
  checkThat('the banner reports the version', t.logs.some((l) => l.indexOf('v1.5.0') !== -1));

  group('bare player: recovery when a clock finally shows up');
  // Bilibili renders the control bar a moment after the video element appears,
  // so the first heartbeats legitimately find no clock. Once one shows up the
  // readout must attach without any layout hackery.
  const bar = t.doc.querySelector('.bpx-player-control-bottom');
  bar.innerHTML =
    '<div class="bpx-player-ctrl-time">' +
    '<span class="bpx-player-ctrl-time-current">00:02</span>' +
    '<span class="bpx-player-ctrl-time-divide">/</span>' +
    '<span class="bpx-player-ctrl-time-duration">06:29</span>' +
    '</div>';
  t.api.heartbeat();
  const restored = badgeOf(t.doc);
  checkThat('the readout appears once a clock node exists', !!restored);
  check('restored value', restored && restored.textContent, '387s');
  checkThat('and it is inline, not floating', !!restored && !restored.classList.contains('bst-sec--overlay'));
  check('nothing was repositioned to accommodate it', root.getAttribute('style') || '', '');

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 5. Settings
 * ------------------------------------------------------------------ */

async function testSettings() {
  const t = boot(PLAYER_MODERN);
  const badge = badgeOf(t.doc);

  group('settings: the default precision is whole seconds');
  check('no decimal point in the default readout', badge.textContent, '387s');
  check('and the stored config agrees', t.api.config.precision, 0);

  group('settings: precision');
  t.api.config.precision = 3;
  t.api.applyConfig();
  check('3 decimals', badgeOf(t.doc).textContent, '387.000s');
  t.api.config.precision = 0;
  t.api.applyConfig();
  check('0 decimals', badgeOf(t.doc).textContent, '387s');

  group('settings: master switch off');
  t.api.config.enabled = false;
  t.api.applyConfig();
  check('all readouts removed', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('native clock restored', t.doc.querySelector('.bpx-player-ctrl-time-current').style.display, '');
  t.api.heartbeat();
  check('heartbeat does not resurrect them while disabled', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('nor does it re-hide the native clock', t.doc.querySelector('.bpx-player-ctrl-time-current').style.display, '');

  group('settings: master switch on again');
  t.api.config.enabled = true;
  t.api.applyConfig();
  checkThat('live badge is back', !!badgeOf(t.doc));
  check('the native clock is blanked again', t.doc.querySelector('.bpx-player-ctrl-time-current').style.display, 'none');

  group('settings: the native style renders nothing at all');
  t.api.config.style = 'native';
  t.api.applyConfig();
  t.api.heartbeat();
  t.api.update(true);
  check('still no readout', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('native clock left alone', t.doc.querySelector('.bpx-player-ctrl-time-current').style.display, '');
  t.api.config.style = 'plugin';
  t.api.applyConfig();

  group('settings: re-attaches after a player re-render');
  t.doc.querySelector('#bilibili-player').innerHTML = PLAYER_MODERN.replace(/^[\s\S]*?<div class="bpx-player-container">/, '<div class="bpx-player-container">');
  const freshVideo = t.doc.querySelector('video');
  const st = { currentTime: 7.25, duration: 100, paused: true, readyState: 4 };
  for (const key of Object.keys(st)) {
    Object.defineProperty(freshVideo, key, { configurable: true, get: () => st[key], set: (v) => { st[key] = v; } });
  }
  t.api.heartbeat();
  const reborn = badgeOf(t.doc);
  checkThat('badge re-injected into the new DOM', !!reborn);
  check('new badge counts down against the new video', reborn.textContent, '93s');

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 6. SPA navigation
 * ------------------------------------------------------------------ */

async function testSpaNavigation() {
  const t = boot(PLAYER_MODERN);
  group('spa navigation');
  checkThat('badge present before navigation', !!badgeOf(t.doc));

  // bilibili swaps the part / video without a full page load.
  t.window.history.pushState({}, '', '/video/BV1GJ411x7h7/?p=3');
  t.api.heartbeat();
  checkThat('badge still present after pushState', !!badgeOf(t.doc));
  checkThat('url really changed', t.window.location.search.includes('p=3'));
  check('no errors after navigation', t.errors.length, 0);

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * 7. Web-fullscreen safety
 *
 * Regression for the worst bug this script has had: a fallback overlay made
 * bilibili's player container `position:relative` with an INLINE style. Inline
 * outranks the stylesheet, and web fullscreen works by switching that same
 * container to `position:fixed` — so a leftover stamp disabled 网页全屏 for
 * good. The overlay is gone; these assertions pin down that no code path can
 * ever touch a player element's layout again.
 * ------------------------------------------------------------------ */

function testFullscreenSafety() {
  const t = boot(PLAYER_MODERN);
  const root = t.doc.querySelector('#bilibili-player');
  const container = t.doc.querySelector('.bpx-player-container');

  group('web fullscreen: a healthy player is never restyled');
  check('player root keeps an empty style attribute', root.getAttribute('style') || '', '');
  check('player container keeps an empty style attribute', container.getAttribute('style') || '', '');
  checkThat('nothing is marked as repositioned', t.doc.querySelectorAll('[data-bst-positioned]').length === 0);
  checkThat('the readout is inline as usual', !!badgeOf(t.doc));

  // A control-bar rebuild (quality switch / fullscreen toggle) wipes the clock
  // for a tick or two. That must NOT be mistaken for "this player has no clock".
  group('web fullscreen: a control-bar rebuild does not fall back');
  const clock = t.doc.querySelector('.bpx-player-ctrl-time');
  const stash = clock.parentNode;
  clock.remove();
  for (let i = 0; i < 3; i++) t.api.ensureInjected();
  check('nothing displayed during the gap', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('root still has no inline position', root.getAttribute('style') || '', '');
  check('container still has no inline position', container.getAttribute('style') || '', '');
  checkThat('still nothing marked as repositioned', t.doc.querySelectorAll('[data-bst-positioned]').length === 0);

  group('web fullscreen: a persistent miss never touches the layout either');
  // Even after far more misses than any grace period, the old design would have
  // stamped the container and broken web fullscreen. Nothing may happen now.
  for (let i = 0; i < 40; i++) t.api.ensureInjected();
  check('still nothing displayed', t.doc.querySelectorAll('.bst-sec').length, 0);
  check('root still has no inline position', root.getAttribute('style') || '', '');
  check('container still has no inline position', container.getAttribute('style') || '', '');
  check('no inline position anywhere in the document', t.doc.querySelectorAll('[style*="position"]').length, 0);
  checkThat('no stamp marker anywhere', t.doc.querySelectorAll('[data-bst-positioned]').length === 0);

  group('web fullscreen: the readout comes back as an inline badge');
  stash.appendChild(clock);
  t.api.ensureInjected();
  checkThat('the inline readout is back', t.doc.querySelectorAll('.bst-sec').length === 1);
  check('and it is not a floating one', t.doc.querySelectorAll('.bst-sec--overlay').length, 0);
  check('root still has no inline position', root.getAttribute('style') || '', '');
  check('container still has no inline position', container.getAttribute('style') || '', '');

  group('web fullscreen: the escape hatch');
  const report = t.api.revertDomMutations();
  check('nothing hidden', report.hiddenClocks.length, 0);
  checkThat('the report has no repositioned roots field', !('repositionedRoots' in report));
  check('no errors along the way', t.errors.length, 0);

  t.window.close();
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

function report() {
  let passed = 0;
  let failed = 0;
  const lines = [];
  for (const r of results) {
    if (r.kind === 'group') {
      lines.push(`\n  ${r.name}`);
      continue;
    }
    if (r.ok) {
      passed++;
      lines.push(`    \u001b[32m✓\u001b[0m ${r.label}`);
    } else {
      failed++;
      lines.push(`    \u001b[31m✗\u001b[0m ${r.label}\n        expected: ${JSON.stringify(r.expected)}\n        actual:   ${JSON.stringify(r.actual)}`);
    }
  }
  console.log(lines.join('\n'));
  console.log(`\n  ${passed} passed, ${failed} failed, ${passed + failed} total\n`);
  return failed === 0;
}

function bootHelpers() {
  // A throwaway window just to reach the pure helper functions.
  const t = boot(PLAYER_MODERN);
  const api = t.api;
  testHelpers(api);
  t.window.close();
  return api;
}

const api = bootHelpers();
if (!api) {
  console.error('FATAL: userscript did not expose window.__biliSecTimepoint');
  process.exit(1);
}

await testModern();
await testRenamed();
await testBare();
await testSettings();
await testSpaNavigation();
testFullscreenSafety();
testConfigMigration();

process.exit(report() ? 0 : 1);
