'use strict';
// Live self-test: runs real captures on the real screen and checks that the capture screen
// responds to input and can always be closed. Start with:  npm run selftest
// Results go to the Capture log; screenshots of the capture screen go next to it.
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = async function liveSelftest({ startCapture, overlays, log, app }) {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    log(`SELFTEST ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
  };
  const outDir = app.getPath('userData');

  async function openCapture() {
    startCapture();
    for (let i = 0; i < 50; i++) {
      await wait(100);
      const list = overlays();
      if (list.length && list.every((o) => o.ready) && list[0].win.isVisible()) return list[0];
    }
    return null;
  }

  async function closedWithin(ms) {
    for (let t = 0; t < ms; t += 100) {
      if (!overlays().length) return true;
      await wait(100);
    }
    return false;
  }

  const js = (o, code) => o.win.webContents.executeJavaScript(code, true);

  try {
    await wait(1000);
    log('SELFTEST start');

    // 1. Capture opens and responds
    const t0 = Date.now();
    const o = await openCapture();
    check('capture screen opens', !!o, o ? `${Date.now() - t0} ms` : 'not shown within 5 s');
    if (!o) throw new Error('no capture screen');
    await wait(500);
    check('capture screen has focus', o.win.isFocused());
    const bounds = o.win.getBounds();
    check('capture screen covers the display', bounds.width === o.display.bounds.width && bounds.height === o.display.bounds.height,
      `${JSON.stringify(bounds)} vs ${JSON.stringify(o.display.bounds)}`);

    // 2. Drag a selection with mouse events
    const send = (ev) => o.win.webContents.sendInputEvent(ev);
    send({ type: 'mouseMove', x: 150, y: 150 });
    send({ type: 'mouseDown', x: 150, y: 150, button: 'left', clickCount: 1 });
    for (let i = 1; i <= 10; i++) send({ type: 'mouseMove', x: 150 + i * 30, y: 150 + i * 20, button: 'left' });
    send({ type: 'mouseUp', x: 450, y: 350, button: 'left', clickCount: 1 });
    await wait(400);
    const sel = await js(o, 'JSON.stringify(__capture.state().sel)');
    check('mouse drag makes a selection', sel && sel !== 'null', sel);
    const toolbar = await js(o, 'getComputedStyle(document.getElementById("actions")).display');
    check('toolbar appears', toolbar === 'flex', toolbar);
    const shot = await o.win.webContents.capturePage();
    fs.writeFileSync(path.join(outDir, 'selftest-capture.png'), shot.toPNG());
    // Outside the selection must be visibly darker than the original screen.
    const px = await js(o, `(() => {
      const s = __capture.debugPixels(600, 500);
      return JSON.stringify(s);
    })()`);
    const { base: b, stage: st, dpr, ratio } = JSON.parse(px);
    const lum = (c) => 0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2];
    log(`SELFTEST info: dpr=${dpr} ratio=${ratio} base=${b} stage=${st}`);
    check('area outside the selection is dimmed', lum(b) < 8 || lum(st) < lum(b) * 0.75, `base ${b} → shown ${st}`);

    // 3. A real Esc key press closes it (needs Accessibility permission for osascript)
    const keyResult = await new Promise((resolve) => {
      execFile('osascript', ['-e', 'tell application "System Events" to key code 53'], (err) => resolve(err ? String(err.message).split('\n')[0] : 'sent'));
    });
    if (keyResult === 'sent') {
      check('real Esc key closes the capture screen', await closedWithin(2000));
    } else {
      log(`SELFTEST SKIP: real Esc key (osascript: ${keyResult})`);
      await js(o, '__captureEscape()');
      check('Esc handler closes the capture screen', await closedWithin(2000));
    }

    // 4. A frozen capture screen is closed by the watchdog
    await wait(800);
    const o2 = await openCapture();
    check('second capture opens', !!o2);
    if (o2) {
      o2.win.webContents.executeJavaScript('const end = Date.now() + 15000; while (Date.now() < end) {}', true).catch(() => {});
      const t1 = Date.now();
      const closed = await closedWithin(8000);
      check('frozen capture screen is closed by the watchdog', closed, closed ? `${Date.now() - t1} ms` : 'still open after 8 s');
    }

    // 5. A capture screen that never receives input closes by itself
    await wait(800);
    const o3 = await openCapture();
    check('third capture opens', !!o3);
    if (o3) {
      const t2 = Date.now();
      const closed = await closedWithin(19000);
      check('capture screen with no input closes by itself', closed, closed ? `${Date.now() - t2} ms` : 'still open after 19 s');
    }
  } catch (err) {
    log('SELFTEST error:', String(err && err.stack ? err.stack : err));
    results.push({ name: 'no errors', ok: false });
  }

  const failed = results.filter((r) => !r.ok).length;
  log(`SELFTEST done: ${results.length - failed} passed, ${failed} failed`);
  app.exit(failed ? 1 : 0);
};
