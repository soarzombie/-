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
    permissions: mic ? ['microphone'] : [],
    acceptDownloads: true,
  });
  await context.addInitScript((extra) => {
    if (localStorage.getItem('e2e-seeded')) return;
    localStorage.setItem('e2e-seeded', '1');
    localStorage.setItem('noise-meter:settings:v1', JSON.stringify(extra));
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

const num = async (page, sel) => parseFloat((await page.locator(sel).textContent()).replace(/[^\d.-]/g, ''));
const running = (page) => page.waitForSelector('.analyzer[data-state="run"]');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'noise-e2e-'));
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const errors = [];

  // Run 1: 1 kHz at -23 dBFS RMS -> 77.0 dB(A) with the default +100 dB calibration
  const wav1 = path.join(tmp, 'tone-1k.wav');
  writeTone(wav1, 1000, 0.1);
  let browser = await launch(wav1);
  let page = await newPage(browser, base, errors);
  await running(page);
  await page.waitForTimeout(2500);
  const expected1 = toneDb(0.1);
  const now1 = await num(page, '#a-now');
  const leq1 = await num(page, '#a-leq');
  const peak1 = await num(page, '#a-peak');
  console.log(`1 kHz: now ${now1}, avg ${leq1} dB(A), expected ${expected1.toFixed(1)}; peak ${peak1} Hz`);
  assert.ok(Math.abs(now1 - expected1) < 0.5, 'current level');
  assert.ok(Math.abs(leq1 - expected1) < 0.3, 'average level');
  assert.ok(Math.abs(peak1 - 1000) < 10, 'peak frequency');

  // pause freezes the clock, play resumes, reset clears
  await page.getByRole('button', { name: '일시정지' }).click();
  await page.waitForSelector('.analyzer[data-state="pause"]');
  const t0 = await page.locator('#a-time').textContent();
  await page.waitForTimeout(1300);
  assert.equal(await page.locator('#a-time').textContent(), t0, 'clock stops while paused');
  await page.getByRole('button', { name: '다시 측정' }).click();
  await running(page);
  await page.getByRole('button', { name: '초기화' }).click();
  assert.equal(await page.locator('#a-time').textContent(), '00:00');

  // display options
  await page.getByRole('button', { name: /FFT/ }).click();
  assert.match(await page.locator('[data-opt=fft] b').textContent(), /8192/);
  await page.getByRole('button', { name: /주파수 축/ }).click();
  assert.match(await page.locator('[data-opt=scale] b').textContent(), /선형/);
  await page.waitForTimeout(800);
  await shot(page, 'tone-linear');
  await page.getByRole('button', { name: /주파수 축/ }).click();
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /FFT/ }).click();
  assert.match(await page.locator('[data-opt=fft] b').textContent(), /4096/);

  // save -> history -> saved analysis -> share card + CSV
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '저장', exact: true }).first().click();
  const sheet = page.locator('dialog.sheet');
  await sheet.locator('#f-vehicle').fill('12가 3456');
  await sheet.locator('#f-memo').fill('공회전 1000Hz 시험음');
  await sheet.getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.waitForSelector('.record-row');
  assert.equal(await page.locator('.record-row').count(), 1);
  const span = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('noise-meter');
    req.onsuccess = () => {
      const all = req.result.transaction('records').objectStore('records').getAll();
      all.onsuccess = () => resolve([all.result[0].spectrum.freqs[0], all.result[0].spectrum.freqs.at(-1)]);
    };
  }));
  assert.deepEqual(span, [20, 20000], 'saved spectrum spans 20 Hz – 20 kHz');
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /엑셀/ }).click()]);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvText.startsWith('﻿일시,차량번호'), 'CSV header with BOM');
  await page.locator('.record-row').click();
  await page.waitForSelector('.stats-grid');
  assert.ok(Math.abs((await num(page, '.stats-grid div:first-child b')) - expected1) < 0.3);
  const [card] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '결과 보내기' }).click()]);
  const cardPath = path.join(SHOTS || tmp, 'share-card.png');
  await card.saveAs(cardPath);
  assert.ok(fs.statSync(cardPath).size > 20000, 'share card PNG');

  // calibration: tell the app a reference meter read 3 dB more -> readings go up by 3 dB
  await page.locator('.tabbar a[data-tab=settings]').click();
  await page.locator('#f-pin').fill('1111');
  await page.getByRole('button', { name: '확인' }).click();
  await page.waitForSelector('#pin-error:not([hidden])');
  await page.locator('#f-pin').fill('0000');
  await page.getByRole('button', { name: '확인' }).click();
  await page.getByRole('button', { name: /보정 측정/ }).click();
  await page.waitForSelector('#cal-result:not([hidden])', { timeout: 15000 });
  const phone = await num(page, '#cal-phone');
  assert.ok(Math.abs(phone - expected1) < 0.3, `calibration reading ${phone}`);
  await page.locator('#f-cal-ref').fill(String(Math.round((phone + 3) * 10) / 10));
  await page.getByRole('button', { name: '적용' }).click();
  assert.match(await page.locator('#cal-offset').textContent(), /^103(\.0)? dB$/);
  await shot(page, 'settings', true);
  await page.locator('.tabbar a[data-tab=home]').click();
  await running(page);
  await page.waitForTimeout(2000);
  const now1c = await num(page, '#a-now');
  console.log(`after +3 dB calibration: now ${now1c}`);
  assert.ok(Math.abs(now1c - (expected1 + 3)) < 0.5, 'calibrated level');
  await browser.close();

  // Run 2: 100 Hz at -9 dBFS RMS; A-weighting takes off 19.1 dB -> 71.9 dB(A)
  const wav2 = path.join(tmp, 'tone-100.wav');
  writeTone(wav2, 100, 0.5);
  browser = await launch(wav2);
  page = await newPage(browser, base, errors);
  await running(page);
  await page.waitForTimeout(2500);
  const expected2 = toneDb(0.5, -19.1);
  const now2 = await num(page, '#a-now');
  const peak2 = await num(page, '#a-peak');
  console.log(`100 Hz: now ${now2} dB(A), expected ${expected2.toFixed(1)}; peak ${peak2} Hz`);
  assert.ok(Math.abs(now2 - expected2) < 0.6, 'A-weighted level of 100 Hz tone');
  assert.ok(Math.abs(peak2 - 100) < 6, 'low-frequency peak');
  await browser.close();

  // Run 3: cabin-like noise, screenshots in both orientations
  const wav3 = path.join(tmp, 'cabin.wav');
  writeCabinNoise(wav3);
  browser = await launch(wav3);
  for (const [name, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
    page = await newPage(browser, base, errors, { viewport, mic: false });
    await page.waitForSelector('#a-overlay:not([hidden])');
    await shot(page, `main-${name}-first`);
    await page.context().close();

    page = await newPage(browser, base, errors, { viewport, seed: { vehicle: '12가 3456', recentVehicles: ['12가 3456', '34나 5678'] } });
    await running(page);
    await page.waitForTimeout(4000);
    await shot(page, `main-${name}-live`);
    await page.getByRole('button', { name: '저장', exact: true }).first().click();
    await page.waitForSelector('dialog.sheet');
    await shot(page, `save-${name}`);
    await page.locator('dialog.sheet #f-memo').fill('주행 80km/h, 오른쪽 뒤 윙 소리');
    await page.locator('dialog.sheet').getByRole('button', { name: '저장' }).click();
    await page.waitForSelector('#toast:not([hidden])');
    await page.getByRole('button', { name: '일시정지' }).click();
    await page.waitForSelector('.analyzer[data-state="pause"]');
    await page.waitForTimeout(3000); // let the toast go
    await shot(page, `main-${name}-paused`);
    await page.evaluate(() => (location.hash = '#/history'));
    await page.waitForSelector('.record-row');
    await shot(page, `history-${name}`);
    await page.locator('.record-row').first().click();
    await page.waitForSelector('.stats-grid');
    await page.waitForTimeout(300);
    await shot(page, `record-${name}`);
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
