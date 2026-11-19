'use strict';
// Gives the shared capture screen (overlay.js) the same small API the desktop app provides,
// backed by the browser: clipboard for Copy, the downloads API for Save.
(() => {
  const listeners = {};
  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const emit = (ch, data) => (listeners[ch] || []).forEach((fn) => fn(data));

  function close(toast) {
    window.parent.postMessage({ __capture: 'close', toast }, '*');
  }

  function stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} at ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  }

  function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }

  async function download(png, saveAs) {
    const res = await chrome.runtime.sendMessage({
      type: 'download',
      dataUrl: `data:image/png;base64,${toBase64(png)}`,
      filename: `Capture/Capture ${stamp()}.png`,
      saveAs,
    });
    if (res && res.ok) close(saveAs ? undefined : 'Saved to Downloads/Capture');
    else close(`Couldn't save: ${(res && res.error) || 'unknown error'}`);
  }

  const handlers = {
    'overlay:cancel': () => close(),
    'overlay:copy': async ({ png }) => {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        close('Copied to clipboard');
      } catch {
        // Some sites block the clipboard for frames; save the picture instead.
        await download(png, false);
      }
    },
    'overlay:save': ({ png, quick }) => download(png, !quick),
    'overlay:copy-text': (text) => { navigator.clipboard.writeText(text).catch(() => {}); },
  };

  window.captureApi = {
    platform: IS_MAC ? 'darwin' : 'win32',
    features: { pin: false },
    on(ch, fn) { (listeners[ch] = listeners[ch] || []).push(fn); },
    send(ch, data) { if (handlers[ch]) handlers[ch](data); },
  };

  window.addEventListener('load', async () => {
    window.focus();
    const res = await chrome.runtime.sendMessage({ type: 'get-capture' }).catch(() => null);
    if (!res || !res.dataUrl) { close("Couldn't take the screenshot. Try again."); return; }
    const img = new Image();
    img.src = res.dataUrl;
    await img.decode();
    emit('overlay:init', {
      image: img,
      width: img.naturalWidth,
      height: img.naturalHeight,
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
    });
  });
})();
