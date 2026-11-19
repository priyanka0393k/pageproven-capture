'use strict';
// Injected into the page when Capture is clicked: shows the capture screen in a full-window frame.
(() => {
  const ID = '__pageproven_capture_frame';
  if (document.getElementById(ID)) return; // already open

  const important = (el, styles) => {
    for (const [k, v] of Object.entries(styles)) el.style.setProperty(k, v, 'important');
  };

  const frame = document.createElement('iframe');
  frame.id = ID;
  frame.src = chrome.runtime.getURL('editor.html');
  frame.allow = 'clipboard-write';
  frame.title = 'Capture';
  important(frame, {
    all: 'initial', position: 'fixed', top: '0', left: '0', width: '100vw', height: '100vh',
    border: '0', margin: '0', padding: '0', display: 'block', 'z-index': '2147483647',
    background: 'transparent', 'color-scheme': 'normal', 'pointer-events': 'auto', visibility: 'visible', opacity: '1',
  });

  function toast(text) {
    const t = document.createElement('div');
    t.textContent = text;
    important(t, {
      all: 'initial', position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
      'z-index': '2147483647', background: 'rgba(30,30,32,0.94)', color: '#f2f2f4', padding: '10px 16px',
      'border-radius': '8px', 'box-shadow': '0 8px 24px rgba(0,0,0,0.4)',
      font: '15px/20px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    });
    document.documentElement.appendChild(t);
    setTimeout(() => t.remove(), 1800);
  }

  function onMessage(e) {
    if (e.source !== frame.contentWindow || !e.data || e.data.__capture !== 'close') return;
    window.removeEventListener('message', onMessage, true);
    frame.remove();
    if (typeof e.data.toast === 'string') toast(e.data.toast);
  }
  window.addEventListener('message', onMessage, true);

  frame.addEventListener('load', () => frame.focus());
  document.documentElement.appendChild(frame);
})();
