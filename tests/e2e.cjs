// End-to-end check in real Chromium with a WAV file as the microphone.
// A tone of known level goes in; the app's dB(A), verdict and frequency must come out right.
//
//   NODE_PATH=$(npm root -g) node tests/e2e.cjs [screenshot-dir]
//
// Needs the `playwright` package (global or local) and a Chromium build.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = process.argv[2] || null;
const OFFSET = 100; // app default: dB SPL = dBFS + 100
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const file = path.join(ROOT, url === '/' ? 'index.html' : url);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// 16-bit mono PCM WAV with a sine at `amp` (peak, full scale = 1).
function writeTone(file, freq, amp, seconds = 4, rate = 48000) {
  const n = seconds * rate;
  const buf = Buffer.alloc(44 + n * 2);
  writeWavHeader(buf, n, rate);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

function writeWavHeader(buf, n, rate) {
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVEfmt ', 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(n * 2, 40);
}

// Something like a car cabin: road rumble, engine orders, tyre/wind noise and a gear whine.
function writeCabinNoise(file, seconds = 6, rate = 48000) {
  const n = seconds * rate;
  const x = new Float64Array(n);
  let seed = 12345;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let road = 0;
  let tyre = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const w = rand();
    road += (w - road) * 0.02;
    tyre += (w - tyre) * 0.15;
    const rpm = 1 + 0.08 * Math.sin(2 * Math.PI * 0.25 * t);
    const engine = 0.5 * Math.sin(2 * Math.PI * 62 * rpm * t) + 0.25 * Math.sin(2 * Math.PI * 124 * rpm * t + 1);
    const whine = 0.06 * (1 + 0.5 * Math.sin(2 * Math.PI * 0.7 * t)) * Math.sin(2 * Math.PI * 1250 * t);
    x[i] = 3 * road + 0.6 * tyre + 0.04 * w + 0.12 * engine + whine;
  }
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  const buf = Buffer.alloc(44 + n * 2);
  writeWavHeader(buf, n, rate);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round((x[i] / rms) * 0.12 * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

const toneDb = (amp, aWeight = 0) => 20 * Math.log10(amp / Math.SQRT2) + OFFSET + aWeight;

async function launch(wav) {
  return chromium.launch({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
}

async function newPage(browser, base, errors, { viewport = { width: 390, height: 844 }, mic = true, seed = {} } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    permissions: mic ? ['microphone', 'geolocation'] : ['geolocation'],
    geolocation: { latitude: 37.5112, longitude: 127.0981 },
    acceptDownloads: true,
  });
  // Short, no-delay measurements so the run takes seconds.
  await context.addInitScript((extra) => {
    if (localStorage.getItem('e2e-seeded')) return;
    localStorage.setItem('e2e-seeded', '1');
    localStorage.setItem('noise-meter:settings:v1', JSON.stringify({
      voice: false,
      modes: {
        drive: { warn: 75, limit: 80, duration: 3, delay: 0 },
        idle: { warn: 55, limit: 65, duration: 3, delay: 0 },
        exhaust: { warn: 95, limit: 100, duration: 3, delay: 0 },
        inspect: { warn: null, limit: null, duration: 3, delay: 0 },
      },
      ...extra,
    }));
  }, seed);
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${base}/#/`);
  return page;
}

async function shot(page, name, fullPage = false) {
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
}

async function measure(page, modeName) {
  await page.evaluate(() => (location.hash = '#/'));
  await page.waitForSelector('.meter[data-state="live"]');
  await page.getByRole('radio', { name: modeName }).click();
  await page.getByRole('button', { name: /측정 시작/ }).click();
  await page.waitForSelector('.meter[data-state="recording"]');
  await page.waitForURL(/#\/record\//, { timeout: 15000 });
  await page.waitForSelector('.verdict');
  const headline = parseFloat(await page.locator('.headline-value').textContent());
  const verdict = (await page.locator('.verdict-label').textContent()).trim();
  const peak = parseFloat((await page.locator('.figure').nth(2).locator('strong').textContent()).replace(/[^\d.]/g, ''));
  return { headline, verdict, peak };
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-e2e-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];

  // Run 1: 1 kHz at -23 dBFS RMS -> 77.0 dB(A), drive mode (warn 75 / limit 80) -> 주의
  const wav1 = path.join(tmp, 'tone-1k.wav');
  writeTone(wav1, 1000, 0.1);
  let browser = await launch(wav1);
  let page = await newPage(browser, base, errors);
  await page.waitForSelector('.meter[data-state="live"]');
  await page.getByRole('button', { name: /측정 시작/ }).click();
  await page.locator('#f-vehicle').fill('12가 3456');
  await page.locator('#f-driver').fill('김현장');
  await shot(page, 'vehicle-sheet');
  await page.getByRole('button', { name: '확인' }).click();
  await page.waitForSelector('.meter[data-state="live"]');
  await page.getByRole('button', { name: /측정 시작/ }).click();
  await page.waitForURL(/#\/record\//, { timeout: 15000 });
  let r = {
    headline: parseFloat(await page.locator('.headline-value').textContent()),
    verdict: (await page.locator('.verdict-label').textContent()).trim(),
    peak: parseFloat((await page.locator('.figure').nth(2).locator('strong').textContent()).replace(/[^\d.]/g, '')),
  };
  const expected1 = toneDb(0.1);
  console.log(`1 kHz: app ${r.headline} dB(A), expected ${expected1.toFixed(1)}; verdict ${r.verdict}; peak ${r.peak} Hz`);
  assert.ok(Math.abs(r.headline - expected1) < 0.5, 'Leq of 1 kHz tone');
  assert.equal(r.verdict, '주의');
  assert.ok(Math.abs(r.peak - 1000) < 15, 'peak frequency');
  await shot(page, 'result-drive', true);

  // Share card falls back to a download in headless Chromium.
  const [card] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '결과 보내기' }).click()]);
  const cardPath = path.join(SHOTS || tmp, 'share-card.png');
  await card.saveAs(cardPath);
  assert.ok(fs.statSync(cardPath).size > 10000, 'share card PNG');

  // Memo
  await page.getByRole('button', { name: /메모·사진 추가/ }).click();
  await page.locator('#f-memo').fill('시속 80km에서 오른쪽 뒤 윙 소리');
  await page.getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('.memo');

  // Second measurement in the same browser: inspect mode (no verdict)
  await page.goto(`${base}/#/`);
  r = await measure(page, '이상음');
  assert.equal(r.verdict, '분석 완료');
  assert.match(await page.locator('.verdict-msg').textContent(), /뚜렷한 소리/);
  await shot(page, 'result-inspect', true);
  await browser.close();

  // Run 2: 100 Hz at -9 dBFS RMS; A-weighting takes off 19.1 dB -> 71.9 dB(A); idle (55 / 65) -> 초과
  const wav2 = path.join(tmp, 'tone-100.wav');
  writeTone(wav2, 100, 0.5);
  browser = await launch(wav2);
  page = await newPage(browser, base, errors);
  await page.evaluate(() => {
    localStorage.setItem('noise-meter:settings:v1', JSON.stringify({
      ...JSON.parse(localStorage.getItem('noise-meter:settings:v1')),
      vehicle: '34나 5678',
      driver: '박기사',
    }));
  });
  await page.reload();
  r = await measure(page, '공회전');
  const expected2 = toneDb(0.5, -19.1);
  console.log(`100 Hz: app ${r.headline} dB(A), expected ${expected2.toFixed(1)}; verdict ${r.verdict}; peak ${r.peak} Hz`);
  assert.ok(Math.abs(r.headline - expected2) < 0.6, 'A-weighted Leq of 100 Hz tone');
  assert.equal(r.verdict, '초과');
  assert.ok(Math.abs(r.peak - 100) < 5);
  assert.match(await page.locator('.lead').textContent(), /저음/);

  r = await measure(page, '배기');
  console.log(`exhaust (LAFmax): app ${r.headline} dB(A); verdict ${r.verdict}`);
  assert.ok(Math.abs(r.headline - expected2) < 0.6, 'LAFmax of steady tone equals Leq');
  assert.equal(r.verdict, '정상');

  // History, CSV, report
  await page.goto(`${base}/#/history`);
  await page.waitForSelector('.record-row');
  assert.equal(await page.locator('.record-row').count(), 2);
  await shot(page, 'history', true);
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /엑셀/ }).click()]);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvText.startsWith('﻿일시,차량번호'), 'CSV header with BOM');
  assert.equal(csvText.trim().split('\r\n').length, 3);

  await page.getByRole('link', { name: '보고서 만들기' }).click();
  await page.waitForSelector('.report-table');
  await shot(page, 'report', true);
  if (SHOTS) {
    await page.emulateMedia({ media: 'print' });
    await page.pdf({ path: path.join(SHOTS, 'report.pdf'), format: 'A4', printBackground: true });
    await page.emulateMedia({ media: 'screen' });
  }

  // Admin settings behind the PIN
  await page.goto(`${base}/#/settings`);
  await page.locator('#f-pin').fill('1111');
  await page.getByRole('button', { name: '확인' }).click();
  await page.waitForSelector('#pin-error:not([hidden])');
  await page.locator('#f-pin').fill('0000');
  await page.getByRole('button', { name: '확인' }).click();
  await page.locator('#f-company').fill('한빛운수');
  await page.locator('#f-drive-warn').fill('85');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.waitForSelector('#settings-error:not([hidden])'); // warn 85 > limit 80 is refused
  await page.locator('#f-drive-warn').fill('76');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.waitForFunction(() => document.querySelector('#brand-company').textContent === '한빛운수');
  await shot(page, 'settings', true);

  await browser.close();

  // Run 3: cabin-like noise, the main screen in both orientations (screenshots only)
  const wav3 = path.join(tmp, 'cabin.wav');
  writeCabinNoise(wav3);
  browser = await launch(wav3);
  const seed = {
    vehicle: '12가 3456',
    driver: '김현장',
    modes: { drive: { warn: 75, limit: 80, duration: 6, delay: 0 } },
  };
  for (const [name, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
    page = await newPage(browser, base, errors, { viewport, mic: false, seed });
    await page.waitForSelector('#r-overlay:not([hidden])');
    await shot(page, `main-${name}-first`);
    await page.context().close();

    page = await newPage(browser, base, errors, { viewport, seed });
    await page.waitForSelector('.meter[data-state="live"]');
    await page.waitForTimeout(1500);
    await shot(page, `main-${name}-live`);
    await page.getByRole('button', { name: /측정 시작/ }).click();
    await page.waitForSelector('.meter[data-state="recording"]');
    await page.waitForTimeout(3500);
    await shot(page, `main-${name}-recording`);
    await page.waitForURL(/#\/record\//, { timeout: 15000 });
    await page.waitForTimeout(3200); // let the "saved" toast go
    await shot(page, `result-${name}`);
    if (name === 'portrait') {
      await page.evaluate(() => (location.hash = '#/'));
      await page.emulateMedia({ colorScheme: 'dark' });
      await page.waitForSelector('.meter[data-state="live"]');
      await page.waitForTimeout(1500);
      await shot(page, 'main-portrait-dark');
    }
    await page.context().close();
  }
  await browser.close();
  server.close();

  assert.deepEqual(errors, [], 'no console errors');
  console.log('e2e ok');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
