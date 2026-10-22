// Offline copy update check: the app served like GitHub Pages (files may be kept 10 minutes by the
// browser), a new version deployed, the app opened again. It must switch to the new version by itself,
// with only new files in its cache. (The app turns the offline copy on only over https; this test
// serves a copy of it that allows localhost.)
//   NODE_PATH=$(npm root -g) node tests/sw-update.cjs
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const src = path.join(__dirname, '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-update-'));
for (const f of ['index.html', 'manifest.webmanifest', 'sw.js', 'css', 'js', 'icons']) fs.cpSync(path.join(src, f), path.join(root, f), { recursive: true });
const patch = (f, a, b) => {
  const p = path.join(root, f);
  const text = fs.readFileSync(p, 'utf8');
  assert.ok(text.includes(a), `${f}: ${a}`);
  fs.writeFileSync(p, text.replace(a, b));
};
patch('js/app.js', "location.protocol === 'https:'", "(location.protocol === 'https:' || location.hostname === 'localhost')");
const now = fs.readFileSync(path.join(src, 'js/settings.js'), 'utf8').match(/APP_VERSION = '([\d.]+)'/)[1];
const next = `${now}-next`;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(root, p);
  if (!f.startsWith(root) || !fs.existsSync(f)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'max-age=600' });
  res.end(fs.readFileSync(f));
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://localhost:${server.address().port}/`;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    const version = () => page.evaluate(async () => (await import('./js/settings.js')).APP_VERSION).catch(() => null);
    await page.goto(url);
    await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 15000 });
    assert.equal(await version(), now);
    // deploy a new version: sw.js and an app file change
    patch('sw.js', `const VERSION = 'v${now}'`, `const VERSION = 'v${next}'`);
    patch('js/settings.js', `APP_VERSION = '${now}'`, `APP_VERSION = '${next}'`);
    const t0 = Date.now();
    await page.goto(url); // opening the app again shows the old copy first
    let v = null;
    for (let i = 0; i < 60 && v !== next; i++) {
      await new Promise((r) => setTimeout(r, 250));
      v = await version();
    }
    assert.equal(v, next, 'switched to the new version by itself');
    const cached = await page.evaluate(async () => {
      const keys = (await caches.keys()).filter((k) => k.startsWith('noise-meter-'));
      const text = await (await (await caches.open(keys[0])).match('js/settings.js')).text();
      return { keys, version: text.match(/APP_VERSION = '([^']+)'/)[1] };
    });
    assert.deepEqual(cached, { keys: [`noise-meter-v${next}`], version: next }, 'only the new files are kept');
    console.log(`sw update ok: ${now} -> ${next} in ${Date.now() - t0} ms`);
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
