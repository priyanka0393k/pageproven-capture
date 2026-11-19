'use strict';
// Out-of-process watchdog. Runs as plain Node (Electron with ELECTRON_RUN_AS_NODE) next to Capture.
// While a capture screen is open, Capture's main process sends a heartbeat every 500 ms. If the
// heartbeats stop (the main process is stuck), the capture screen can't be closed from inside the app,
// so this process records what it was stuck on and force-quits Capture, which gives the screen back.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const STALL_MS = 3000;
const parentPid = process.ppid;
let armed = false;
let lastBeat = 0;
let logDir = null;

function log(line) {
  if (!logDir) return;
  try {
    fs.appendFileSync(path.join(logDir, 'capture.log'), `[${new Date().toISOString()}] watchdog: ${line}\n`);
  } catch { /* nothing else to do */ }
}

process.on('message', (msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.logDir) logDir = msg.logDir;
  if (msg.type === 'arm') { armed = true; lastBeat = Date.now(); }
  else if (msg.type === 'beat') lastBeat = Date.now();
  else if (msg.type === 'disarm') armed = false;
});

// Capture quit or crashed: nothing left to watch.
process.on('disconnect', () => process.exit(0));

setInterval(() => {
  if (!armed || Date.now() - lastBeat < STALL_MS) return;
  armed = false;
  log(`main process stopped responding for ${Date.now() - lastBeat} ms with a capture screen open; force-quitting Capture`);
  if (process.platform === 'darwin' && logDir) {
    // A 1-second sample of every thread shows exactly where the main process was stuck.
    const file = path.join(logDir, `hang-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
    const r = spawnSync('/usr/bin/sample', [String(parentPid), '1', '-file', file], { timeout: 6000 });
    log(r.error ? `sample failed: ${r.error.message}` : `stack sample saved to ${path.basename(file)}`);
  }
  try {
    process.kill(parentPid, 'SIGKILL');
  } catch (err) {
    log(`could not stop Capture: ${err.message}`);
  }
  process.exit(0);
}, 250);
