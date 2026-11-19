'use strict';
(() => {
  const api = window.captureApi;
  const IS_MAC = api.platform === 'darwin';
  const img = document.getElementById('img');
  let dragging = false;

  api.on('pin:init', ({ src }) => { img.src = src; });

  img.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    img.setPointerCapture(e.pointerId);
    dragging = true;
    document.body.classList.add('dragging');
    api.send('pin:drag-start');
  });
  img.addEventListener('pointermove', () => { if (dragging) api.send('pin:drag'); });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('dragging');
    api.send('pin:drag-end');
  };
  img.addEventListener('pointerup', end);
  img.addEventListener('pointercancel', end);

  img.addEventListener('dblclick', () => api.send('pin:close'));
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); api.send('pin:menu'); });
  window.addEventListener('wheel', (e) => {
    e.preventDefault();
    api.send('pin:zoom', { dir: e.deltaY < 0 ? 1 : -1 });
  }, { passive: false });
  window.addEventListener('keydown', (e) => {
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (e.key === 'Escape') api.send('pin:close');
    else if (mod && e.key.toLowerCase() === 'c') api.send('pin:copy');
  });
})();
