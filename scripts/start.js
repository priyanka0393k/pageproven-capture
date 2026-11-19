'use strict';
// Starts Capture in development.
// macOS: Electron is launched through LaunchServices (`open`) so that macOS treats it as its own app.
// Started directly from a terminal, macOS would ask for (and check) Screen Recording permission for the
// terminal app instead of Electron.
// Windows / Linux: Electron is started directly.
const { spawn, spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const extra = process.argv.slice(2);
const electronBin = require('electron'); // path to the Electron executable

if (process.platform !== 'darwin') {
  const child = spawn(electronBin, [root, ...extra], { stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
  process.on('SIGINT', () => child.kill('SIGINT'));
  return;
}

const appBundle = path.resolve(path.dirname(electronBin), '..', '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

console.log('Starting Capture… (menu bar icon). Press Ctrl+C here to quit.');
console.log(`Log: ~/Library/Application Support/Capture/capture.log`);
const child = spawn('open', ['-n', '-W', '-a', appBundle, '--args', root, ...extra], { stdio: 'inherit', env });

const stop = () => {
  spawnSync('pkill', ['-f', `${electronBin} ${root}`]);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));
