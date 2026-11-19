'use strict';
(() => {
  const api = window.captureApi;
  const IS_MAC = api.platform === 'darwin';
  const MOD = IS_MAC ? '⌘' : 'Ctrl+';
  // The Chrome extension can't pin a window to the screen; the desktop app can.
  const CAN_PIN = !(api.features && api.features.pin === false);

  // Tell the main process the user is active (it closes an idle or stuck capture screen).
  let lastActivitySent = 0;
  const reportActivity = () => {
    const now = Date.now();
    if (now - lastActivitySent > 1000) { lastActivitySent = now; api.send('overlay:activity'); }
  };
  ['pointerdown', 'keydown', 'wheel'].forEach((t) => window.addEventListener(t, reportActivity, { capture: true, passive: true }));
  // Key and click names go to the log (not what is typed in the text tool), to diagnose a stuck screen.
  window.addEventListener('keydown', (e) => api.send('overlay:input', `key ${e.key.length === 1 ? 'char' : e.key}`), { capture: true, passive: true });
  window.addEventListener('pointerdown', (e) => api.send('overlay:input', `mouse button ${e.button}`), { capture: true, passive: true });
  // macOS sends a pointer event when the window appears under the cursor; only real movement counts.
  let firstPointer = null;
  window.addEventListener('pointermove', (e) => {
    if (!firstPointer) { firstPointer = { x: e.screenX, y: e.screenY }; return; }
    if (Math.abs(e.screenX - firstPointer.x) + Math.abs(e.screenY - firstPointer.y) > 3) reportActivity();
  }, { capture: true, passive: true });

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const ctx = stage.getContext('2d');
  const base = document.createElement('canvas');
  const bctx = base.getContext('2d', { willReadFrequently: true });
  const tmp = document.createElement('canvas');
  const tctx = tmp.getContext('2d');
  const loupeCanvas = $('loupeCanvas');
  const lctx = loupeCanvas.getContext('2d');
  const ta = $('textInput');

  // ---------- state ----------
  let cssW = 0; let cssH = 0; let ratio = 1; let dpr = 1;
  let ready = false; let busy = false;
  let sel = null; // {x,y,w,h} in CSS px of this display
  let mode = 'idle'; // idle | selecting | moving | resizing | drawing
  let drag = null;
  let tool = null; // null = adjust selection
  let color = '#ff3b30';
  let size = 4;
  let objects = []; let redoStack = []; let current = null;
  let mouse = { x: -1, y: -1 }; let pointerInside = false;
  let textEdit = null;
  let paletteOpen = false;
  let toastTimer = 0;

  const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ff2d92', '#111111', '#ffffff'];

  const ICONS = {
    select: '<path d="M5 3l14 8-6.2 1.8L11 19z"/>',
    pen: '<path d="M4 20l4.5-1L19 8.5 15.5 5 5 15.5z"/><path d="M13.5 7l3.5 3.5"/>',
    line: '<path d="M5 19L19 5"/>',
    arrow: '<path d="M5 19L19 5"/><path d="M10 5h9v9"/>',
    rect: '<rect x="4" y="5" width="16" height="14" rx="1.5"/>',
    ellipse: '<ellipse cx="12" cy="12" rx="8.5" ry="7"/>',
    marker: '<path d="M14.5 4.5l5 5L12 17H7v-5z"/><path d="M4 20.5h9"/>',
    text: '<path d="M5 7V4.5h14V7"/><path d="M12 4.5v15"/><path d="M9 19.5h6"/>',
    pixelate: '<rect x="4" y="4" width="7" height="7" fill="currentColor" stroke="none"/><rect x="13" y="13" width="7" height="7" fill="currentColor" stroke="none"/><rect x="13" y="4" width="7" height="7"/><rect x="4" y="13" width="7" height="7"/>',
    step: '<circle cx="12" cy="12" r="8.5"/><path d="M10.5 9.5L12.5 8v8"/>',
    undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 010 11H11"/>',
    redo: '<path d="M15 14l5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 000 11H13"/>',
    pin: '<path d="M12 16v6"/><path d="M8 3h8l-1 6 3.5 4h-13L9 9z"/>',
    save: '<path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 012-2h9"/>',
    close: '<path d="M6 6l12 12M18 6L6 18"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name]}</svg>`;

  const TOOLS = [
    { id: null, icon: 'select', title: 'Adjust selection', key: 'V' },
    { id: 'pen', icon: 'pen', title: 'Pen', key: 'P' },
    { id: 'line', icon: 'line', title: 'Line', key: 'L' },
    { id: 'arrow', icon: 'arrow', title: 'Arrow', key: 'A' },
    { id: 'rect', icon: 'rect', title: 'Rectangle', key: 'R' },
    { id: 'ellipse', icon: 'ellipse', title: 'Ellipse', key: 'E' },
    { id: 'marker', icon: 'marker', title: 'Highlighter', key: 'M' },
    { id: 'text', icon: 'text', title: 'Text', key: 'T' },
    { id: 'pixelate', icon: 'pixelate', title: 'Pixelate (hide private info)', key: 'B' },
    { id: 'step', icon: 'step', title: 'Numbered step', key: 'N' },
  ];

  // ---------- toolbar DOM ----------
  const toolsEl = $('tools');
  const actionsEl = $('actions');
  const paletteEl = $('palette');

  TOOLS.forEach((t) => {
    const b = document.createElement('button');
    b.innerHTML = svg(t.icon);
    b.title = `${t.title} (${t.key})`;
    b.dataset.tool = t.id || '';
    b.addEventListener('click', () => setTool(t.id));
    toolsEl.appendChild(b);
  });
  toolsEl.insertAdjacentHTML('beforeend', '<div class="sep"></div>');
  const colorBtn = document.createElement('button');
  colorBtn.title = 'Color and size (scroll to change size)';
  colorBtn.innerHTML = '<span class="color-dot"></span>';
  colorBtn.addEventListener('click', () => togglePalette());
  toolsEl.appendChild(colorBtn);

  const ACTIONS = [
    { id: 'undo', title: `Undo (${MOD}Z)`, run: () => undo() },
    { id: 'redo', title: `Redo (${MOD}⇧Z)`, run: () => redo() },
    'sep',
    ...(CAN_PIN ? [{ id: 'pin', title: `Pin to screen (${MOD}P)`, run: () => doAction('pin') }] : []),
    { id: 'save', title: `Save as… (${MOD}S) — ${MOD}⇧S saves instantly`, run: (e) => doAction(e.shiftKey ? 'quicksave' : 'save') },
    { id: 'copy', title: `Copy (${MOD}C or Enter)`, run: () => doAction('copy'), primary: true },
    'sep',
    { id: 'close', title: 'Cancel (Esc)', run: () => cancel() },
  ];
  const actionButtons = {};
  ACTIONS.forEach((a) => {
    if (a === 'sep') { actionsEl.insertAdjacentHTML('beforeend', '<div class="sep"></div>'); return; }
    const b = document.createElement('button');
    b.innerHTML = svg(a.id);
    b.title = a.title;
    if (a.primary) b.classList.add('primary');
    b.addEventListener('click', (e) => a.run(e));
    actionsEl.appendChild(b);
    actionButtons[a.id] = b;
  });

  paletteEl.innerHTML = `
    <div class="swatches">
      ${COLORS.map((c) => `<button data-color="${c}" style="background:${c}" title="${c}"></button>`).join('')}
      <input type="color" id="customColor" title="Custom color">
    </div>
    <label>Size <span id="sizeVal" class="mono"></span></label>
    <input type="range" id="sizeRange" min="1" max="20" step="1">`;
  paletteEl.querySelectorAll('[data-color]').forEach((b) => b.addEventListener('click', () => setColor(b.dataset.color)));
  $('customColor').addEventListener('input', (e) => setColor(e.target.value));
  $('sizeRange').addEventListener('input', (e) => setSize(Number(e.target.value)));

  // Keep clicks on bars from reaching the stage.
  [toolsEl, actionsEl, paletteEl].forEach((el) => el.addEventListener('pointerdown', (e) => e.stopPropagation()));

  // ---------- init from main ----------
  // d.bitmap: raw BGRA pixels (desktop app).  d.image: a decoded image (Chrome extension).
  api.on('overlay:init', (d) => {
    cssW = d.cssWidth;
    cssH = d.cssHeight;
    base.width = d.width;
    base.height = d.height;
    if (d.image) {
      bctx.drawImage(d.image, 0, 0);
      finishInit(d);
      return;
    }
    const src = new Uint8Array(d.bitmap.buffer, d.bitmap.byteOffset, d.bitmap.byteLength);
    const px = new Uint8ClampedArray(d.width * d.height * 4);
    const rowBytes = Math.floor(src.length / d.height);
    const rowLen = d.width * 4;
    for (let y = 0; y < d.height; y++) {
      const s = y * rowBytes; const t = y * rowLen;
      for (let i = 0; i < rowLen; i += 4) { // BGRA -> RGBA
        px[t + i] = src[s + i + 2];
        px[t + i + 1] = src[s + i + 1];
        px[t + i + 2] = src[s + i];
        px[t + i + 3] = 255;
      }
    }
    bctx.putImageData(new ImageData(px, d.width, d.height), 0, 0);
    finishInit(d);
  });

  function finishInit(d) {
    ratio = d.width / cssW;
    resizeStage();
    ready = true;
    syncControls();
    render();
    layoutUI();
    requestAnimationFrame(() => api.send('overlay:ready'));
  }

  api.on('overlay:clear', () => {
    if (textEdit) commitText();
    sel = null; current = null; mode = 'idle'; drag = null;
    closePalette();
    update();
  });

  function resizeStage() {
    dpr = window.devicePixelRatio || 1;
    stage.width = Math.round(cssW * dpr);
    stage.height = Math.round(cssH * dpr);
    stage.style.width = `${cssW}px`;
    stage.style.height = `${cssH}px`;
  }

  // ---------- geometry helpers ----------
  const clamp = (v, a, b) => Math.min(Math.max(v, a), b);
  const clampPt = (p) => ({ x: clamp(p.x, 0, cssW), y: clamp(p.y, 0, cssH) });
  const rectFrom = (a, b) => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) });
  const norm = (o) => ({ x: o.w < 0 ? o.x + o.w : o.x, y: o.h < 0 ? o.y + o.h : o.y, w: Math.abs(o.w), h: Math.abs(o.h) });
  const inRect = (p, r) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
  const roundRect = (r) => {
    const x = Math.round(r.x); const y = Math.round(r.y);
    return { x, y, w: Math.round(r.x + r.w) - x, h: Math.round(r.y + r.h) - y };
  };
  const pt = (e) => ({ x: e.clientX, y: e.clientY });

  function handlesOf(r) {
    const R = r.x + r.w; const B = r.y + r.h; const cx = r.x + r.w / 2; const cy = r.y + r.h / 2;
    return [['nw', r.x, r.y], ['n', cx, r.y], ['ne', R, r.y], ['e', R, cy], ['se', R, B], ['s', cx, B], ['sw', r.x, B], ['w', r.x, cy]];
  }

  function hitHandle(p) {
    if (!sel) return null;
    for (const [k, hx, hy] of handlesOf(sel)) {
      if (Math.abs(p.x - hx) <= 7 && Math.abs(p.y - hy) <= 7) return k;
    }
    if (tool) return null; // with a drawing tool, only the corner/edge squares resize
    const E = 4;
    const inX = p.x >= sel.x && p.x <= sel.x + sel.w;
    const inY = p.y >= sel.y && p.y <= sel.y + sel.h;
    if (inY && Math.abs(p.x - sel.x) <= E) return 'w';
    if (inY && Math.abs(p.x - (sel.x + sel.w)) <= E) return 'e';
    if (inX && Math.abs(p.y - sel.y) <= E) return 'n';
    if (inX && Math.abs(p.y - (sel.y + sel.h)) <= E) return 's';
    return null;
  }

  function resizeRect(start, h, p) {
    let l = start.x; let t = start.y; let r = start.x + start.w; let b = start.y + start.h;
    const q = clampPt(p);
    if (h.includes('w')) l = q.x;
    if (h.includes('e')) r = q.x;
    if (h.includes('n')) t = q.y;
    if (h.includes('s')) b = q.y;
    return rectFrom({ x: l, y: t }, { x: r, y: b });
  }

  const CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
  function updateCursor(p) {
    let c = 'crosshair';
    const h = hitHandle(p);
    if (h) c = CURSORS[h];
    else if (sel && inRect(p, sel)) c = tool === 'text' ? 'text' : tool ? 'crosshair' : 'move';
    if (stage.style.cursor !== c) stage.style.cursor = c;
  }

  // ---------- drawing ----------
  let raf = 0;
  function update() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; render(); layoutUI(); });
  }

  function render() {
    if (!ready) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, 0, 0, cssW, cssH);

    if (sel && sel.w > 0 && sel.h > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(sel.x, sel.y, sel.w, sel.h);
      ctx.clip();
      objects.forEach((o) => drawObject(ctx, o));
      if (current) drawObject(ctx, current);
      ctx.restore();
    }

    ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.beginPath();
    ctx.rect(0, 0, cssW, cssH);
    if (sel) ctx.rect(sel.x, sel.y, sel.w, sel.h);
    ctx.fill('evenodd');

    if (sel) {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#0a84ff';
      ctx.strokeRect(sel.x - 0.5, sel.y - 0.5, sel.w + 1, sel.h + 1);
      if (mode !== 'selecting') {
        ctx.fillStyle = '#fff';
        handlesOf(sel).forEach(([, hx, hy]) => {
          ctx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
          ctx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
        });
      }
    }
  }

  const fontPx = (s) => Math.round(12 + s * 2.5);
  const fontFor = (s) => `600 ${fontPx(s)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
  const stepRadius = (s) => 9 + s * 1.5;

  function drawObject(c, o) {
    c.save();
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = o.color;
    c.fillStyle = o.color;
    c.lineWidth = o.size;
    switch (o.type) {
      case 'pen':
        strokePath(c, o.pts);
        break;
      case 'marker':
        c.globalAlpha = 0.4;
        c.lineCap = 'butt';
        c.lineWidth = o.size * 4 + 6;
        strokePath(c, o.pts);
        break;
      case 'line':
        c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(o.x2, o.y2); c.stroke();
        break;
      case 'arrow':
        drawArrow(c, o);
        break;
      case 'rect': {
        const r = norm(o);
        c.strokeRect(r.x, r.y, r.w, r.h);
        break;
      }
      case 'ellipse': {
        const r = norm(o);
        c.beginPath();
        c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
        c.stroke();
        break;
      }
      case 'pixelate':
        drawPixelate(c, o);
        break;
      case 'text': {
        c.font = fontFor(o.size);
        c.textBaseline = 'top';
        const lh = fontPx(o.size) * 1.25;
        o.text.split('\n').forEach((line, i) => c.fillText(line, o.x, o.y + i * lh + fontPx(o.size) * 0.1));
        break;
      }
      case 'step': {
        const r = stepRadius(o.size);
        c.beginPath();
        c.arc(o.x, o.y, r, 0, Math.PI * 2);
        c.fill();
        c.lineWidth = 2;
        c.strokeStyle = '#fff';
        c.stroke();
        c.fillStyle = isLight(o.color) ? '#111' : '#fff';
        c.font = `700 ${Math.round(r * 1.1)}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
        c.textAlign = 'center';
        c.textBaseline = 'middle';
        c.fillText(String(o.n), o.x, o.y + r * 0.06);
        break;
      }
      default:
    }
    c.restore();
  }

  function strokePath(c, pts) {
    if (!pts.length) return;
    c.beginPath();
    c.moveTo(pts[0].x, pts[0].y);
    if (pts.length < 3) {
      const last = pts[pts.length - 1];
      c.lineTo(last.x + 0.01, last.y);
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2;
        const my = (pts[i].y + pts[i + 1].y) / 2;
        c.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      const last = pts[pts.length - 1];
      c.lineTo(last.x, last.y);
    }
    c.stroke();
  }

  function drawArrow(c, o) {
    const dx = o.x2 - o.x1; const dy = o.y2 - o.y1;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ang = Math.atan2(dy, dx);
    const head = Math.min(Math.max(12, o.size * 4), len * 0.8);
    const spread = Math.PI / 7;
    const bx = o.x2 - Math.cos(ang) * head * 0.8;
    const by = o.y2 - Math.sin(ang) * head * 0.8;
    c.beginPath(); c.moveTo(o.x1, o.y1); c.lineTo(bx, by); c.stroke();
    c.beginPath();
    c.moveTo(o.x2, o.y2);
    c.lineTo(o.x2 - Math.cos(ang - spread) * head, o.y2 - Math.sin(ang - spread) * head);
    c.lineTo(o.x2 - Math.cos(ang + spread) * head, o.y2 - Math.sin(ang + spread) * head);
    c.closePath();
    c.lineWidth = Math.max(1, o.size / 2);
    c.fill();
    c.stroke();
  }

  function drawPixelate(c, o) {
    const r = norm(o);
    if (r.w < 1 || r.h < 1) return;
    const block = Math.max(8, o.size * 3);
    const sw = Math.max(1, Math.ceil(r.w / block));
    const sh = Math.max(1, Math.ceil(r.h / block));
    tmp.width = sw; tmp.height = sh;
    tctx.imageSmoothingEnabled = true;
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(base, r.x * ratio, r.y * ratio, r.w * ratio, r.h * ratio, 0, 0, sw, sh);
    c.imageSmoothingEnabled = false;
    c.drawImage(tmp, 0, 0, sw, sh, r.x, r.y, r.w, r.h);
  }

  function isLight(hex) {
    const n = parseInt(hex.slice(1), 16);
    const r = (n >> 16) & 255; const g = (n >> 8) & 255; const b = n & 255;
    return 0.299 * r + 0.587 * g + 0.114 * b > 170;
  }

  // ---------- UI layout ----------
  function show(el, on) { el.style.display = on ? '' : 'none'; if (el.classList.contains('bar')) el.classList.toggle('show', on); }

  function place(el, x, y) {
    const w = el.offsetWidth; const h = el.offsetHeight;
    el.style.left = `${clamp(x, 4, cssW - w - 4)}px`;
    el.style.top = `${clamp(y, 4, cssH - h - 4)}px`;
  }

  function layoutUI() {
    const hasSel = !!sel && sel.w > 0 && sel.h > 0;
    const showBars = hasSel && mode !== 'selecting';

    // hint
    const hint = $('hint');
    if (!sel) {
      hint.innerHTML = `Drag to select an area &nbsp;·&nbsp; <b>${MOD}A</b> whole screen &nbsp;·&nbsp; <b>C</b> copy color &nbsp;·&nbsp; <b>Esc</b> cancel`;
      hint.style.display = 'block';
    } else hint.style.display = 'none';

    // size label
    const sl = $('sizeLabel');
    if (hasSel) {
      sl.textContent = `${Math.round(sel.w * ratio)} × ${Math.round(sel.h * ratio)}`;
      sl.style.display = 'block';
      const above = sel.y - sl.offsetHeight - 6;
      place(sl, sel.x, above >= 4 ? above : sel.y + 6);
    } else sl.style.display = 'none';

    // toolbars
    show(toolsEl, showBars);
    show(actionsEl, showBars);
    if (showBars) {
      const tw = toolsEl.offsetWidth; const th = toolsEl.offsetHeight;
      const aw = actionsEl.offsetWidth; const ah = actionsEl.offsetHeight;
      const R = sel.x + sel.w; const B = sel.y + sel.h;
      // actions: below, right-aligned; else above; else inside bottom
      let ay = B + 8;
      if (ay + ah > cssH - 4) ay = sel.y - ah - 8 >= 4 ? sel.y - ah - 8 : B - ah - 8;
      place(actionsEl, R - aw, ay);
      // tools: right of selection; else left; else inside right
      let tx = R + 8;
      if (tx + tw > cssW - 4) tx = sel.x - tw - 8 >= 4 ? sel.x - tw - 8 : R - tw - 8;
      const ty = clamp(B - th, sel.y, cssH - th - 4);
      place(toolsEl, tx, ty);
    }
    if (paletteOpen && showBars) {
      show(paletteEl, true);
      const tb = toolsEl.getBoundingClientRect();
      const pw = paletteEl.offsetWidth;
      const px = tb.right + 8 + pw <= cssW ? tb.right + 8 : tb.left - pw - 8;
      place(paletteEl, px, tb.bottom - paletteEl.offsetHeight);
    } else show(paletteEl, false);

    drawLoupe();
  }

  function drawLoupe() {
    const loupe = $('loupe');
    const wanted = ready && pointerInside && !textEdit && (!sel || mode === 'selecting' || mode === 'resizing');
    if (!wanted) { loupe.style.display = 'none'; return; }
    const N = 15; // native pixels shown across
    const cx = Math.floor(mouse.x * ratio); const cy = Math.floor(mouse.y * ratio);
    lctx.imageSmoothingEnabled = false;
    lctx.fillStyle = '#000';
    lctx.fillRect(0, 0, 120, 120);
    lctx.drawImage(base, cx - 7, cy - 7, N, N, 0, 0, 120, 120);
    const cell = 120 / N;
    lctx.strokeStyle = 'rgba(255,255,255,0.08)';
    lctx.lineWidth = 1;
    for (let i = 1; i < N; i++) {
      lctx.beginPath(); lctx.moveTo(i * cell, 0); lctx.lineTo(i * cell, 120); lctx.stroke();
      lctx.beginPath(); lctx.moveTo(0, i * cell); lctx.lineTo(120, i * cell); lctx.stroke();
    }
    lctx.strokeStyle = '#fff';
    lctx.strokeRect(7 * cell, 7 * cell, cell, cell);
    lctx.strokeStyle = 'rgba(0,0,0,0.6)';
    lctx.strokeRect(7 * cell - 1, 7 * cell - 1, cell + 2, cell + 2);

    const hex = pixelHex(mouse);
    const info = $('loupeInfo');
    info.innerHTML = `${Math.round(mouse.x * ratio)}, ${Math.round(mouse.y * ratio)}<br>`
      + `<span class="swatch" style="background:${hex}"></span><span class="hex">${hex}</span>`;
    loupe.style.display = 'block';
    const lw = loupe.offsetWidth; const lh = loupe.offsetHeight;
    let lx = mouse.x + 20; let ly = mouse.y + 20;
    if (lx + lw > cssW - 4) lx = mouse.x - lw - 20;
    if (ly + lh > cssH - 4) ly = mouse.y - lh - 20;
    loupe.style.left = `${lx}px`;
    loupe.style.top = `${ly}px`;
  }

  function pixelHex(p) {
    const x = clamp(Math.floor(p.x * ratio), 0, base.width - 1);
    const y = clamp(Math.floor(p.y * ratio), 0, base.height - 1);
    const d = bctx.getImageData(x, y, 1, 1).data;
    return `#${[d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.style.display = 'block';
    place(t, mouse.x + 16, mouse.y - 32);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.style.display = 'none'; }, 900);
  }

  // ---------- controls ----------
  function setTool(id) {
    if (textEdit) commitText();
    tool = id;
    syncControls();
    updateCursor(mouse);
  }

  function setColor(c) {
    color = c;
    if (textEdit) { textEdit.color = c; ta.style.color = c; }
    syncControls();
  }

  function setSize(s) {
    size = clamp(s, 1, 20);
    if (textEdit) { textEdit.size = size; styleTextarea(); }
    syncControls();
  }

  function syncControls() {
    toolsEl.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', (b.dataset.tool || null) === tool));
    colorBtn.querySelector('.color-dot').style.background = color;
    paletteEl.querySelectorAll('[data-color]').forEach((b) => b.classList.toggle('active', b.dataset.color.toLowerCase() === color.toLowerCase()));
    $('customColor').value = color.length === 7 ? color : '#ff3b30';
    $('sizeRange').value = String(size);
    $('sizeVal').textContent = String(size);
    actionButtons.undo.disabled = objects.length === 0;
    actionButtons.redo.disabled = redoStack.length === 0;
    update();
  }

  function togglePalette() { paletteOpen = !paletteOpen; update(); }
  function closePalette() { if (paletteOpen) { paletteOpen = false; update(); } }

  function pushObject(o) {
    objects.push(o);
    redoStack = [];
    syncControls();
  }
  function undo() { if (objects.length) { redoStack.push(objects.pop()); syncControls(); } }
  function redo() { if (redoStack.length) { objects.push(redoStack.pop()); syncControls(); } }
  const nextStep = () => objects.filter((o) => o.type === 'step').length + 1;

  // ---------- text tool ----------
  function openText(p) {
    textEdit = { x: p.x, y: p.y, color, size };
    ta.value = '';
    ta.style.display = 'block';
    styleTextarea();
    setTimeout(() => ta.focus(), 0);
    update();
  }

  function styleTextarea() {
    if (!textEdit) return;
    ta.style.font = fontFor(textEdit.size);
    ta.style.lineHeight = '1.25';
    ta.style.color = textEdit.color;
    ta.style.left = `${textEdit.x - 3}px`;
    ta.style.top = `${textEdit.y - 1}px`;
    autosizeText();
  }

  function autosizeText() {
    ctx.save();
    ctx.font = fontFor(textEdit.size);
    const lines = ta.value.split('\n');
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width), 10);
    ctx.restore();
    ta.style.width = `${Math.ceil(w + 24)}px`;
    ta.style.height = `${Math.ceil(lines.length * fontPx(textEdit.size) * 1.25 + 4)}px`;
  }

  ta.addEventListener('input', autosizeText);
  ta.addEventListener('pointerdown', (e) => e.stopPropagation());

  function commitText() {
    if (!textEdit) return;
    const text = ta.value.replace(/\s+$/, '');
    if (text.trim()) {
      pushObject({ type: 'text', x: textEdit.x, y: textEdit.y, text, color: textEdit.color, size: textEdit.size });
    }
    textEdit = null;
    ta.style.display = 'none';
    ta.blur();
    update();
  }

  // ---------- pointer handling ----------
  stage.addEventListener('pointerdown', (e) => {
    if (!ready || busy) return;
    if (e.button === 2) return; // handled by contextmenu
    if (e.button !== 0) return;
    const p = pt(e);
    if (paletteOpen) { closePalette(); return; }
    if (textEdit) { commitText(); return; }
    stage.setPointerCapture(e.pointerId);

    const h = hitHandle(p);
    if (h) { mode = 'resizing'; drag = { h, start: { ...sel } }; update(); return; }
    if (sel && inRect(p, sel)) {
      if (tool) { startDraw(p); return; }
      mode = 'moving'; drag = { start: { ...sel }, p0: p };
      return;
    }
    mode = 'selecting';
    drag = { p0: clampPt(p), prev: sel };
    sel = { x: drag.p0.x, y: drag.p0.y, w: 0, h: 0 };
    api.send('overlay:selection-start');
    update();
  });

  window.addEventListener('pointermove', (e) => {
    if (!ready) return;
    const p = pt(e);
    mouse = p;
    pointerInside = true;
    switch (mode) {
      case 'selecting':
        sel = rectFrom(drag.p0, clampPt(p));
        break;
      case 'moving': {
        const s = drag.start;
        sel = {
          x: clamp(s.x + p.x - drag.p0.x, 0, cssW - s.w),
          y: clamp(s.y + p.y - drag.p0.y, 0, cssH - s.h),
          w: s.w,
          h: s.h,
        };
        break;
      }
      case 'resizing':
        sel = resizeRect(drag.start, drag.h, p);
        break;
      case 'drawing':
        updateDraw(p, e.shiftKey);
        break;
      default:
        updateCursor(p);
    }
    update();
  });

  window.addEventListener('pointerup', (e) => {
    if (!ready) return;
    if (mode === 'selecting' || mode === 'moving' || mode === 'resizing') {
      sel = roundRect(sel);
      if (sel.w < 4 || sel.h < 4) {
        // a plain click: keep the previous selection instead of losing it
        sel = mode === 'selecting' ? (drag.prev || null) : drag.start;
      }
    }
    if (mode === 'drawing') finishDraw();
    mode = 'idle';
    drag = null;
    updateCursor(pt(e));
    update();
  });

  document.addEventListener('pointerleave', () => { pointerInside = false; update(); });
  document.addEventListener('pointerenter', () => { pointerInside = true; });

  stage.addEventListener('dblclick', (e) => {
    if (sel && !tool && inRect(pt(e), sel)) doAction('copy');
  });

  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (textEdit) { commitText(); return; }
    if (sel) { sel = null; mode = 'idle'; closePalette(); update(); } else cancel();
  });

  window.addEventListener('wheel', (e) => {
    if (e.target.closest && e.target.closest('.bar')) return;
    e.preventDefault(); // never scroll whatever is underneath the capture screen
    if (!sel || !ready) return;
    setSize(size + (e.deltaY < 0 ? 1 : -1));
    toast(`Size ${size}`);
  }, { passive: false });

  function startDraw(p) {
    const common = { color, size };
    switch (tool) {
      case 'pen':
      case 'marker':
        current = { type: tool, pts: [p], ...common };
        break;
      case 'line':
      case 'arrow':
        current = { type: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, ...common };
        break;
      case 'rect':
      case 'ellipse':
      case 'pixelate':
        current = { type: tool, x: p.x, y: p.y, w: 0, h: 0, ...common };
        break;
      case 'text':
        openText(p);
        return;
      case 'step':
        pushObject({ type: 'step', x: p.x, y: p.y, n: nextStep(), ...common });
        return;
      default:
        return;
    }
    mode = 'drawing';
    update();
  }

  function updateDraw(p, shift) {
    const o = current;
    if (!o) return;
    if (o.type === 'pen' || o.type === 'marker') {
      const last = o.pts[o.pts.length - 1];
      if (shift && o.type === 'marker') {
        // straight horizontal highlight
        o.pts = [o.pts[0], { x: p.x, y: o.pts[0].y }];
      } else if (Math.hypot(p.x - last.x, p.y - last.y) > 1) o.pts.push(p);
    } else if (o.type === 'line' || o.type === 'arrow') {
      let { x, y } = p;
      if (shift) {
        const dx = x - o.x1; const dy = y - o.y1;
        const ang = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
        const len = Math.hypot(dx, dy);
        x = o.x1 + Math.cos(ang) * len; y = o.y1 + Math.sin(ang) * len;
      }
      o.x2 = x; o.y2 = y;
    } else {
      let w = p.x - o.x; let h = p.y - o.y;
      if (shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
      o.w = w; o.h = h;
    }
  }

  function finishDraw() {
    const o = current;
    current = null;
    if (!o) return;
    let keep = true;
    if (o.type === 'line' || o.type === 'arrow') keep = Math.hypot(o.x2 - o.x1, o.y2 - o.y1) > 3;
    else if (o.type === 'rect' || o.type === 'ellipse' || o.type === 'pixelate') keep = Math.abs(o.w) > 3 && Math.abs(o.h) > 3;
    if (keep) pushObject(o); else update();
  }

  // ---------- keyboard ----------
  const TOOL_KEYS = Object.fromEntries(TOOLS.map((t) => [t.key.toLowerCase(), t.id]));

  window.addEventListener('keydown', (e) => {
    if (!ready) return;
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if (textEdit) {
      if (e.key === 'Escape' || (e.key === 'Enter' && mod)) { e.preventDefault(); commitText(); }
      return;
    }
    if (e.target && e.target.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();

    if (e.key === 'Escape') { e.preventDefault(); if (paletteOpen) closePalette(); else cancel(); return; }
    if (e.key === 'Enter') { e.preventDefault(); doAction('copy'); return; }

    if (mod) {
      if (k === 'c') { e.preventDefault(); doAction('copy'); }
      else if (k === 's') { e.preventDefault(); doAction(e.shiftKey ? 'quicksave' : 'save'); }
      else if (k === 'p') { e.preventDefault(); if (CAN_PIN) doAction('pin'); }
      else if (k === 'a') { e.preventDefault(); sel = { x: 0, y: 0, w: cssW, h: cssH }; api.send('overlay:selection-start'); update(); }
      else if (k === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
      else if (k === 'y') { e.preventDefault(); redo(); }
      return;
    }

    if (e.key.startsWith('Arrow') && sel) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
      if (e.altKey) {
        sel = { ...sel, w: clamp(sel.w + d[0], 4, cssW - sel.x), h: clamp(sel.h + d[1], 4, cssH - sel.y) };
      } else {
        sel = { ...sel, x: clamp(sel.x + d[0], 0, cssW - sel.w), y: clamp(sel.y + d[1], 0, cssH - sel.h) };
      }
      update();
      return;
    }

    if (k === 'c' && !e.altKey) {
      if (mouse.x >= 0) {
        const hex = pixelHex(mouse);
        api.send('overlay:copy-text', hex);
        toast(`Copied ${hex}`);
      }
      return;
    }
    if (sel && k in TOOL_KEYS) { setTool(TOOL_KEYS[k]); return; }
    if (k === '[' || k === ']') { setSize(size + (k === ']' ? 1 : -1)); toast(`Size ${size}`); }
  });

  // ---------- export ----------
  function exportPNG() {
    const r = sel;
    const X0 = Math.round(r.x * ratio); const Y0 = Math.round(r.y * ratio);
    const W = Math.max(1, Math.round((r.x + r.w) * ratio) - X0);
    const H = Math.max(1, Math.round((r.y + r.h) * ratio) - Y0);
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const x = c.getContext('2d');
    x.setTransform(ratio, 0, 0, ratio, -X0, -Y0);
    x.imageSmoothingEnabled = false;
    x.drawImage(base, 0, 0, cssW, cssH);
    x.imageSmoothingEnabled = true;
    objects.forEach((o) => drawObject(x, o));
    return new Promise((resolve, reject) => {
      c.toBlob((blob) => (blob ? blob.arrayBuffer().then(resolve, reject) : reject(new Error('Export failed'))), 'image/png');
    });
  }

  async function doAction(kind) {
    if (!sel || sel.w < 1 || sel.h < 1 || busy) return;
    commitText();
    busy = true;
    try {
      const png = await exportPNG();
      if (kind === 'copy') api.send('overlay:copy', { png });
      else if (kind === 'save') api.send('overlay:save', { png, quick: false });
      else if (kind === 'quicksave') api.send('overlay:save', { png, quick: true });
      else if (kind === 'pin') api.send('overlay:pin', { png, rect: { x: sel.x, y: sel.y, w: sel.w, h: sel.h } });
    } catch (err) {
      busy = false;
      toast(String(err.message || err));
    }
  }

  function cancel() { api.send('overlay:cancel'); }

  // Called by the main process when Esc is pressed (Esc is captured globally during a capture).
  window.__captureEscape = () => {
    if (textEdit) commitText();
    else if (paletteOpen) closePalette();
    else cancel();
    return true;
  };

  // Test hook (used only by the automated self-test).
  window.__capture = {
    state: () => ({ sel, objects, tool, color, size, ratio, cssW, cssH }),
    setSel: (r) => { sel = r; update(); },
    add: (o) => pushObject({ color, size, ...o }),
    exportPNG,
    debugPixels: (x, y) => {
      const b = bctx.getImageData(Math.floor(x * ratio), Math.floor(y * ratio), 1, 1).data;
      const st = ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
      return { base: [b[0], b[1], b[2]], stage: [st[0], st[1], st[2]], dpr, ratio };
    },
  };
})();
