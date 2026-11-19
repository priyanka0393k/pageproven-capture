// Builds the Chrome extension into extension/dist/capture-extension/ and a .zip for the Web Store.
// The capture screen (overlay.js / overlay.css) is shared with the desktop app and copied from src/.
//   npm run build:extension            → the store build
//   npm run build:extension -- --test  → adds <all_urls> host access, for the automated test only
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const test = process.argv.includes('--test');
const out = join(here, 'dist', test ? 'capture-extension-test' : 'capture-extension');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(here, 'src'), out, { recursive: true });
cpSync(join(here, 'icons'), join(out, 'icons'), { recursive: true });
cpSync(join(root, 'src', 'overlay.js'), join(out, 'overlay.js'));
cpSync(join(root, 'src', 'overlay.css'), join(out, 'overlay.css'));

const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
if (test) manifest.host_permissions = ['<all_urls>'];
writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

if (!test) {
  const zip = join(here, 'dist', `capture-extension-${manifest.version}.zip`);
  if (existsSync(zip)) rmSync(zip);
  // macOS and Windows 10+ ship bsdtar, which writes zips; Linux (CI) uses zip.
  if (process.platform === 'linux') execFileSync('zip', ['-r', '-X', '-q', zip, ...readdirSync(out)], { cwd: out, stdio: 'inherit' });
  else execFileSync('tar', ['-a', '-c', '-f', zip, '-C', out, ...readdirSync(out)], { stdio: 'inherit' });
  console.log(`Built ${zip}`);
}
console.log(`Built ${out}`);
