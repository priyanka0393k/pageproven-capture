'use strict';
// Runs a script in Electron with ELECTRON_RUN_AS_NODE removed (VS Code sets it, which turns Electron into plain Node).
const { spawn } = require('child_process');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(require('electron'), process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 0));
