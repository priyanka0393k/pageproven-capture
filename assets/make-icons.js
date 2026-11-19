'use strict';
// Renders the Capture logo to every PNG size the app, installers, extension and website use.
// Run with:  npm run icons   (uses Electron's Chromium to draw the SVG)
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// size 1024 artwork. `bold` thickens the strokes for tiny sizes so they stay readable.
function logoSvg({ pad = 0, bold = false } = {}) {
  const s = (1024 - pad * 2) / 1024;
  const sw = bold ? 92 : 66;
  const a = 262; const b = 762; const L = bold ? 165 : 150;
  const r = bold ? 84 : 72;
  const corner = (x, y, dx, dy) => `M${x} ${y + dy * L}V${y}H${x + dx * L}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#22a35a"/>
      <stop offset="1" stop-color="#15803d"/>
    </linearGradient>
  </defs>
  <g transform="translate(${pad} ${pad}) scale(${s})">
    <rect width="1024" height="1024" rx="232" fill="url(#g)"/>
    <path d="${corner(a, a, 1, 1)} ${corner(b, a, -1, 1)} ${corner(a, b, 1, -1)} ${corner(b, b, -1, -1)}"
      fill="none" stroke="#fff" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>
    <circle cx="512" cy="512" r="${r}" fill="#fff"/>
  </g>
</svg>`;
}

const outputs = [
  // [file, size, options]
  ['build/icon.png', 1024, {}], // Windows installer + app icon (full bleed)
  ['build/icon-mac.png', 1024, { pad: 100 }], // macOS: Apple's icon grid leaves a margin
  ['extension/icons/icon-16.png', 16, { bold: true }],
  ['extension/icons/icon-32.png', 32, { bold: true }],
  ['extension/icons/icon-48.png', 48, {}],
  ['extension/icons/icon-128.png', 128, {}],
  ['assets/logo-256.png', 256, {}],
  ['assets/logo-512.png', 512, {}],
];

app.whenReady().then(async () => {
  fs.writeFileSync(path.join(root, 'assets/logo.svg'), logoSvg());
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await win.loadURL('data:text/html,<body></body>');
  for (const [file, size, opts] of outputs) {
    const svg = logoSvg(opts);
    const dataUrl = await win.webContents.executeJavaScript(`new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas'); c.width = ${size}; c.height = ${size};
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
        x.drawImage(img, 0, 0, ${size}, ${size});
        res(c.toDataURL('image/png'));
      };
      img.onerror = () => rej(new Error('svg failed'));
      img.src = 'data:image/svg+xml;base64,' + ${JSON.stringify(Buffer.from(svg).toString('base64'))};
    })`);
    const out = path.join(root, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
    console.log('wrote', file);
  }
  app.quit();
});
