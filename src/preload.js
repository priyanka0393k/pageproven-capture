'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const SEND = new Set([
  'overlay:ready', 'overlay:cancel', 'overlay:activity', 'overlay:input', 'overlay:selection-start', 'overlay:copy',
  'overlay:save', 'overlay:pin', 'overlay:copy-text',
  'pin:drag-start', 'pin:drag', 'pin:drag-end', 'pin:zoom', 'pin:menu', 'pin:copy', 'pin:close',
]);
const RECEIVE = new Set(['overlay:init', 'overlay:clear', 'pin:init']);

contextBridge.exposeInMainWorld('captureApi', {
  platform: process.platform,
  send(channel, data) {
    if (SEND.has(channel)) ipcRenderer.send(channel, data);
  },
  on(channel, fn) {
    if (RECEIVE.has(channel)) ipcRenderer.on(channel, (_e, data) => fn(data));
  },
});
