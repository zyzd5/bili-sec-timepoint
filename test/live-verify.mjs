/**
 * Live verification harness — runs the userscript against the REAL bilibili page.
 *
 * The jsdom suite (test/run-tests.mjs) proves the script's logic against a
 * hand-built DOM. It cannot prove that the class names the script looks for are
 * the ones bilibili actually ships, nor that a real mouse click reaches the
 * readout. This script covers exactly that gap: it drives headless Chrome over
 * the DevTools Protocol, opens a real video page, injects the userscript with
 * minimal GM_* stubs, inspects what the script found, and clicks the readout
 * with a genuine synthesised mouse event.
 *
 * Zero npm dependencies — Node's built-in fetch and WebSocket are enough.
 *
 *   node test/live-verify.mjs [url] [--out=DIR] [--keep-open]
 *
 * Exit status is 0 only when every check passes, so this doubles as a
 * regression gate.
 *
 * SANDBOX NOTE (macOS + DSH): under a workspace-write file sandbox Chrome dies
 * instantly with `Failed to initialize sandbox` / exit 133, because its own
 * process sandbox and its Crashpad reporter both need to write outside the
 * workspace (`~/Library/Application Support/Google/Chrome/Crashpad/`). That is
 * a filesystem-permission problem, not a macOS privacy setting — granting the
 * host app "Full Disk Access" does not change it. Run this under a wider
 * sandbox mode instead.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEFAULT_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7/';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const url = argv.find((a) => !a.startsWith('--')) || DEFAULT_URL;
const outDir = resolve(flag('out', '.tmp'));
const port = Number(flag('port', '9333'));

const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : 'google-chrome');

const SCRIPT = readFileSync(new URL('../bili-sec-timepoint.user.js', import.meta.url), 'utf8');
const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => process.stderr.write(`${msg}\n`);

mkdirSync(outDir, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'bst-chrome-'));

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--disable-component-update',
    '--disable-background-networking',
    '--no-first-run',
    '--no-default-browser-check',
    '--mute-audio',
    '--window-size=1440,900',
    '--autoplay-policy=no-user-gesture-required',
    `--user-agent=${USER_AGENT}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    'about:blank',
  ],
  { stdio: ['ignore', 'ignore', 'pipe'] },
);

let chromeStderr = '';
chrome.stderr.on('data', (d) => {
  chromeStderr += String(d);
});

const cleanup = () => {
  try {
    chrome.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

// --- Wait for the debugging endpoint -------------------------------------
let wsUrl = null;
for (let i = 0; i < 60 && !wsUrl; i += 1) {
  await sleep(500);
  if (chrome.exitCode !== null) break;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    wsUrl = (await res.json()).webSocketDebuggerUrl;
  } catch {
    /* not up yet */
  }
}

if (!wsUrl) {
  log('\nChrome never exposed its debugging endpoint.');
  if (/Failed to initialize sandbox|Operation not permitted/.test(chromeStderr)) {
    log(
      '\nThis is the file sandbox, not Chrome and not a macOS privacy setting.\n' +
        'Chrome needs to write its Crashpad reports outside the workspace.\n' +
        'Re-run this script under a wider sandbox mode.\n',
    );
  } else if (chrome.exitCode !== null) {
    log(`Chrome exited early with code ${chrome.exitCode}.`);
  } else {
    log(`Chrome path used: ${CHROME}\nSet CHROME_PATH to override it.`);
  }
  log(chromeStderr.split('\n').slice(-12).join('\n'));
  cleanup();
  process.exit(2);
}

// --- Attach to a fresh tab ------------------------------------------------
const target = await (
  await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let nextId = 1;
const pending = new Map();
const consoleLines = [];
const pageErrors = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) rej(new Error(JSON.stringify(msg.error)));
    else res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    consoleLines.push(
      msg.params.args
        .map((a) => (a.value !== undefined ? String(a.value) : a.description || a.type))
        .join(' '),
    );
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(`${d.text} ${d.exception?.description || ''}`.trim());
  }
});

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = nextId++;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    return { __error: `${d.text} ${d.exception?.description || ''}`.trim() };
  }
  return r.result.value;
};

await send('Page.enable');
await send('Runtime.enable');
// Chrome's default headless viewport is phone-sized and can push the control
// bar below the fold, which makes hit-testing lie. Use a real desktop window.
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 2,
  mobile: false,
});

log(`→ opening ${url}`);
await send('Page.navigate', { url });

// --- Wait for the player to exist -----------------------------------------
let ready = false;
for (let i = 0; i < 40 && !ready; i += 1) {
  await sleep(750);
  ready = await evaluate(`(() => {
    const v = document.querySelector('video');
    return !!v && v.readyState >= 1 && !!document.querySelector('.bpx-player-ctrl-time');
  })()`);
  if (ready === true) break;
}
if (ready !== true) log('  player clock never appeared; continuing anyway to report what is there');

const report = { url, steps: {}, checks: [], console: [], pageErrors: [] };

const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail });
  log(`  ${pass ? '✓' : '✗'} ${name}${detail === undefined ? '' : ` — ${detail}`}`);
};

// --- Step 1: the page as bilibili ships it --------------------------------
report.steps.beforeScript = await evaluate(`(() => {
  const q = (s) => document.querySelectorAll(s).length;
  const v = document.querySelector('video');
  return {
    title: document.title,
    hasVideo: !!v,
    videoReadyState: v ? v.readyState : null,
    videoDuration: v ? v.duration : null,
    timeBox: q('.bpx-player-ctrl-time'),
    timeCurrent: q('.bpx-player-ctrl-time-current'),
    timeDuration: q('.bpx-player-ctrl-time-duration'),
    timeLabel: q('.bpx-player-ctrl-time-label'),
    timeDivide: q('.bpx-player-ctrl-time-divide'),
    timeSeek: q('.bpx-player-ctrl-time-seek'),
    controlBottom: q('.bpx-player-control-bottom'),
    container: q('.bpx-player-container'),
    legacyNow: q('.bilibili-player-video-time-now'),
    legacyTotal: q('.bilibili-player-video-time-total'),
  };
})()`);

log(`  page: ${report.steps.beforeScript.title}`);

// --- Step 2: inject the userscript with GM_* stubs ------------------------
await evaluate(`(() => {
  window.__gmStore = {};
  window.GM_getValue = (k, d) => (k in window.__gmStore ? window.__gmStore[k] : d);
  window.GM_setValue = (k, v) => { window.__gmStore[k] = v; };
  window.GM_registerMenuCommand = () => 1;
  window.GM_unregisterMenuCommand = () => {};
  return 'stubs ready';
})()`);

report.steps.injection = await evaluate(`${SCRIPT}\n; 'injected'`);
await sleep(2500);

const readStyle = `(() => ({
  style: window.__biliSecTimepoint.config.style,
  readouts: document.querySelectorAll('.bst-sec').length,
  boxDisplay: (document.querySelector('.bpx-player-ctrl-time') || {}).style
    ? document.querySelector('.bpx-player-ctrl-time').style.display
    : null,
}))()`;

// --- Step 3: what did the script find? ------------------------------------
report.steps.afterScript = await evaluate(`(() => {
  const api = window.__biliSecTimepoint;
  if (!api) return { apiMissing: true };
  const badge = document.querySelector('.bst-sec');
  const box = api.resolveTimeBox();
  const cur = document.querySelector('.bpx-player-ctrl-time-current');
  const cs = badge ? getComputedStyle(badge) : null;
  const ncs = cur ? getComputedStyle(cur) : null;
  const mutations = api.describeMutations ? api.describeMutations() : {};
  const roots = [document.querySelector('#bilibili-player'), document.querySelector('.bpx-player-container')];
  return {
    config: api.config,
    readoutText: badge ? badge.textContent : null,
    readoutParentClass: badge && badge.parentNode ? badge.parentNode.className : null,
    readoutColor: cs ? cs.color : null,
    readoutFontSize: cs ? cs.fontSize : null,
    nativeColor: ncs ? ncs.color : null,
    nativeFontSize: ncs ? ncs.fontSize : null,
    timeBoxFound: !!box,
    timeBoxClass: box ? box.className : null,
    nodes: (() => {
      const n = api.resolveTimeNodes();
      return n ? { current: n.current && n.current.className, duration: n.duration && n.duration.className } : null;
    })(),
    hiddenClocks: mutations.hiddenClocks,
    readouts: mutations.readouts,
    missCount: mutations.missCount,
    playerInlinePosition: roots.map((r) => (r ? r.style.position || '(none)' : 'missing')),
    playerHasHiddenMark: roots.some((r) => r && r.hasAttribute('data-bst-hidden')),
  };
})()`);

const after = report.steps.afterScript;
check('the script published its debug entry point', !after.apiMissing);
check('it found bilibili\'s time box', after.timeBoxFound, after.timeBoxClass);
check('it resolved both clock nodes', !!(after.nodes && after.nodes.current && after.nodes.duration));
check('a single readout is on the page', after.readouts === 1, `readouts=${after.readouts}`);
check('the readout lives inside the time box', after.readoutParentClass === after.timeBoxClass, after.readoutParentClass);
check('the readout copies the native colour', after.readoutColor === after.nativeColor, `${after.readoutColor} vs ${after.nativeColor}`);
check('the readout copies the native font size', after.readoutFontSize === after.nativeFontSize, `${after.readoutFontSize} vs ${after.nativeFontSize}`);
check(
  'no inline position was written onto the player',
  after.playerInlinePosition.every((v) => v === '(none)' || v === 'missing'),
  JSON.stringify(after.playerInlinePosition),
);
check('the player elements carry no hidden marker', !after.playerHasHiddenMark);

// --- Step 4: click the readout with a real mouse event --------------------
const rect = await evaluate(`(() => {
  const b = document.querySelector('.bst-sec');
  if (!b) return null;
  const r = b.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
})()`);
report.steps.badgeRect = rect;

if (rect && rect.w > 0) {
  // The control bar auto-hides when idle, so a click out of nowhere can land on
  // the video instead. Move the pointer over the bar first, as a user would.
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none' });
  await sleep(800);

  const shot1 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, 'live-plugin.png'), Buffer.from(shot1.data, 'base64'));

  report.steps.hitTest = await evaluate(`(() => {
    const b = document.querySelector('.bst-sec');
    if (!b) return { badgeGone: true };
    const r = b.getBoundingClientRect();
    const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      hitTag: el && el.tagName,
      hitClass: el && el.className,
      hitIsBadge: el === b,
      hitInsideTimeBox: !!(el && el.closest && el.closest('.bpx-player-ctrl-time')),
      viewport: [innerWidth, innerHeight],
    };
  })()`);

  const hit = report.steps.hitTest;
  check('the readout is actually hit-testable', hit.hitIsBadge === true, `${hit.hitTag}.${hit.hitClass}`);

  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
  await sleep(700);
  report.steps.afterRealClick = await evaluate(readStyle);

  const shot2 = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(outDir, 'live-native.png'), Buffer.from(shot2.data, 'base64'));

  check(
    'a real mouse click switches to bilibili\'s own style',
    report.steps.afterRealClick.style === 'native' && report.steps.afterRealClick.readouts === 0,
    JSON.stringify(report.steps.afterRealClick),
  );
} else {
  check('the readout is actually hit-testable', false, 'no readout with a layout box');
}

// Clicking the time box itself must switch back. Dispatched in-page rather than
// via CDP because after the click above there is no readout left to aim at.
report.steps.afterClickBack = await evaluate(`(() => {
  const box = document.querySelector('.bpx-player-ctrl-time');
  if (!box) return { noBox: true };
  box.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  const b = document.querySelector('.bst-sec');
  return {
    style: window.__biliSecTimepoint.config.style,
    readouts: document.querySelectorAll('.bst-sec').length,
    readoutText: b ? b.textContent : null,
    boxDisplay: box.style.display,
  };
})()`);

const back = report.steps.afterClickBack;
check(
  'clicking the time box switches back to the plugin style',
  back.style === 'plugin' && back.readouts === 1 && /^\d+s$/.test(back.readoutText || ''),
  JSON.stringify(back),
);

// --- Verdict --------------------------------------------------------------
report.console = consoleLines.filter((l) => l.includes('bili-sec-timepoint'));
report.pageErrors = pageErrors;

check('the script logged its banner', report.console.some((l) => l.includes('已加载')));
check('the page threw no JavaScript errors', pageErrors.length === 0, pageErrors.join(' | '));

const failed = report.checks.filter((c) => !c.pass);

console.log(JSON.stringify(report, null, 2));
log('');
log(`screenshots: ${join(outDir, 'live-plugin.png')}, ${join(outDir, 'live-native.png')}`);
log(
  failed.length === 0
    ? `\n${report.checks.length} checks passed against the live page.`
    : `\n${failed.length} of ${report.checks.length} checks FAILED:\n` +
        failed.map((c) => `  ✗ ${c.name}${c.detail === undefined ? '' : ` (${c.detail})`}`).join('\n'),
);

ws.close();
cleanup();
await sleep(500);
process.exit(failed.length === 0 ? 0 : 1);
