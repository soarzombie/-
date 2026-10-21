// End-to-end check in real Chromium with a WAV file as the microphone.
// A tone of known level goes in; the app's dB(A) / dB(C) / dB(Z), peak frequency, cursor reading,
// recording and file analysis must come out right.
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

// Two steady parts: 1 kHz then 100 Hz, `part` seconds each (levels known exactly).
function writeTwoTone(file, part = 3, rate = 48000) {
  const n = 2 * part * rate;
  const buf = Buffer.alloc(44 + n * 2);
  writeWavHeader(buf, n, rate);
  for (let i = 0; i < n; i++) {
    const v = i < part * rate ? 0.1 * Math.sin((2 * Math.PI * 1000 * i) / rate) : 0.5 * Math.sin((2 * Math.PI * 100 * i) / rate);
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

// 20 s demo recording: road/tyre noise, engine orders rising with rpm, a brake squeal and a knock.
function writeDemoFile(file, seconds = 20, rate = 48000) {
  const n = seconds * rate;
  const x = new Float64Array(n);
  let seed = 99;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  let road = 0;
  let tyre = 0;
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const w = rand();
    road += (w - road) * 0.02;
    tyre += (w - tyre) * 0.15;
    phase += (2 * Math.PI * (45 + 2.5 * t)) / rate; // engine speeding up
    x[i] = 3 * road + 0.6 * tyre + 0.04 * w + 0.12 * (Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.3 * Math.sin(4 * phase));
  }
  const rms = Math.sqrt(x.reduce((s, v) => s + v * v, 0) / n);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    let v = (x[i] / rms) * 0.1;
    if (t > 8 && t < 11.5) v += 0.05 * Math.sin(Math.PI * ((t - 8) / 3.5)) * Math.sin(2 * Math.PI * 3150 * t); // brake squeal
    if (t > 15 && t < 15.25) v += 0.6 * Math.exp(-(t - 15) * 25) * (Math.sin(2 * Math.PI * 70 * t) + 0.5 * rand()); // knock
    x[i] = v;
  }
  const buf = Buffer.alloc(44 + n * 2);
  writeWavHeader(buf, n, rate);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(x[i] * 32767))), 44 + i * 2);
  fs.writeFileSync(file, buf);
}

const toneDb = (amp, weight = 0) => 20 * Math.log10(amp / Math.SQRT2) + OFFSET + weight;

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

async function newPage(browser, base, errors, { viewport = { width: 390, height: 844 }, mic = true, seed = {}, geo = null } = {}) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    permissions: [...(mic ? ['microphone'] : []), ...(geo ? ['geolocation'] : [])],
    ...(geo ? { geolocation: geo } : {}),
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

// A car going north at `kmh`: a new position every half second.
function drive(context, kmh, start = { latitude: 37.5, longitude: 127 }) {
  let metres = 0;
  return setInterval(() => {
    metres += (kmh / 3.6) * 0.5;
    context.setGeolocation({ ...start, latitude: start.latitude + metres / 111195, accuracy: 5 }).catch(() => {});
  }, 500);
}

// Screen point of a frequency on the spectrum, using the chart's own layout rules.
async function tapFrequency(page, hz, fmin = 20, fmax = 20000) {
  const host = page.locator('#a-chart');
  const r = await host.boundingBox();
  const w = Math.floor(r.width);
  const k = w < 360 ? 0.92 : 1;
  const x0 = 30 * k;
  const x1 = w - 6 * k;
  const x = x0 + (Math.log(hz / fmin) / Math.log(fmax / fmin)) * (x1 - x0);
  await page.mouse.click(r.x + x, r.y + r.height * 0.75); // low enough to miss the floating level panel in landscape
}

// The same, with the analyzer turned sideways (the plot's x runs down the screen, its y to the left).
async function tapSideways(page, hz, fmin = 20, fmax = 20000) {
  const r = await page.locator('#a-chart').boundingBox();
  const [w, h] = await page.evaluate(() => [document.querySelector('#a-chart').clientWidth, document.querySelector('#a-chart').clientHeight]);
  const k = w < 360 ? 0.92 : 1;
  const x0 = 30 * k;
  const x1 = w - 6 * k;
  const lx = x0 + (Math.log(hz / fmin) / Math.log(fmax / fmin)) * (x1 - x0);
  await page.mouse.click(r.x + r.width - h * 0.75, r.y + lx);
}

const settingsOf = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('noise-meter:settings:v1')));
const num = async (page, sel) => parseFloat((await page.locator(sel).textContent()).replace(/[^\d.-]/g, ''));
const running = (page) => page.waitForSelector('.analyzer[data-state="run"]');

async function setMode(page, mode) {
  await page.locator(`.mode[data-mode=${mode}]`).click();
  assert.equal(await page.locator('.an-chart').getAttribute('data-view'), mode);
  assert.equal(await page.locator(`.mode[data-mode=${mode}]`).getAttribute('aria-pressed'), 'true');
}

// Graph settings sheet: pick values by key, e.g. { style: 'line', fft: '8192' }.
// Chart menu (the chart button): { style: 'line', on: ['minHold'], off: ['peakHold'] }.
async function chartMenu(page, { style, on = [], off = [] } = {}, shotName) {
  await page.getByRole('button', { name: '그래프 설정' }).click();
  const menu = page.getByRole('menu');
  await menu.waitFor();
  if (style) {
    await menu.locator(`[data-style=${style}]`).click();
    assert.equal(await menu.locator(`[data-style=${style}]`).getAttribute('aria-checked'), 'true', `style ${style}`);
  }
  for (const [keys, want] of [[on, 'true'], [off, 'false']]) {
    for (const key of keys) {
      const b = menu.locator(`[data-toggle=${key}]`);
      if ((await b.getAttribute('aria-checked')) !== want) await b.click();
      assert.equal(await b.getAttribute('aria-checked'), want, `${key} ${want}`);
    }
  }
  if (shotName) await shot(page, shotName);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.menu', { state: 'detached' });
}

// The rest of the graph settings: chart menu -> last item -> sheet.
async function chartSettings(page, picks, shotName) {
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menuitem', { name: /가중치/ }).click();
  const sheet = page.locator('dialog.sheet');
  for (const [key, v] of Object.entries(picks)) {
    const b = sheet.locator(`.seg[data-key=${key}] button[data-v="${v}"]`);
    await b.click();
    assert.equal(await b.getAttribute('aria-pressed'), 'true', `${key} = ${v}`);
  }
  if (shotName) await shot(page, shotName);
  await sheet.getByRole('button', { name: '닫기' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
}

// Graph settings sheet -> microphone list: pick by name ('' = the phone's default).
async function pickMic(page, label) {
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menuitem', { name: /가중치/ }).click();
  const sel = page.locator('dialog.sheet #f-mic');
  await page.waitForFunction(() => document.querySelectorAll('#f-mic option').length > 1);
  if (label) await sel.selectOption({ label });
  else await sel.selectOption('');
  await (label ? page.waitForSelector(`#a-mic:not([hidden]):has-text("${label}")`) : page.waitForSelector('#a-mic', { state: 'hidden' }));
  await running(page);
  await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
}

async function cursorDb(page, hz) {
  await tapFrequency(page, hz);
  await page.waitForSelector('#a-cursor:not([hidden])');
  const db = Number(await page.locator('#a-cursor .cr-cur em').textContent());
  await page.locator('#a-cursor .cr-close').click();
  return db;
}

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

  // the cursor reads the live level and the maximum at one frequency; another tap moves it; x clears
  await tapFrequency(page, 1000);
  await page.waitForSelector('#a-cursor:not([hidden])');
  const hzAt = async () => Number((await page.locator('#a-cursor .cr-hz').textContent()).replace(/[^\d.]/g, ''));
  const aHz = await hzAt();
  const aDb = Number(await page.locator('#a-cursor .cr-cur em').textContent());
  const aMax = Number(await page.locator('#a-cursor .cr-max em').textContent());
  console.log(`cursor: ${await page.locator('#a-cursor .cr-lines').textContent()}`);
  assert.ok(Math.abs(aHz - 1000) / 1000 < 0.03, 'cursor frequency');
  assert.ok(aDb > 60, 'cursor reads the tone level');
  assert.ok(aMax >= aDb - 0.5 && aMax - aDb < 3, 'and the maximum there');
  assert.match(await page.locator('#a-cursor .cr-cur').textContent(), /^지금 /);
  assert.match(await page.locator('#a-cursor .cr-max').textContent(), /^최대 /);
  await tapFrequency(page, 5000);
  await page.waitForFunction(() => /^5,0\d\d Hz|^4,9\d\d Hz/.test(document.querySelector('#a-cursor .cr-hz')?.textContent || ''));
  assert.equal(await page.locator('#a-cursor .cr-hz').count(), 1, 'one cursor: the second tap moved it');
  await tapFrequency(page, 1000);
  await page.waitForTimeout(300);
  await shot(page, 'cursor');
  await page.locator('#a-cursor .cr-close').click();
  await page.waitForSelector('#a-cursor', { state: 'hidden' });

  // the main view is two graphs: frequency dB on top, the smaller time-axis dB below
  const specBox = await page.locator('#a-chart').boundingBox();
  const traceBox = await page.locator('#a-trace').boundingBox();
  assert.ok(await page.locator('#a-trace canvas').isVisible(), 'time-axis graph under the spectrum');
  assert.ok(traceBox.y > specBox.y + specBox.height - 1, 'below it');
  assert.ok(traceBox.height < specBox.height * 0.6, 'and smaller');

  // 가로: where the screen cannot be locked (here, as on an iPhone) the page turns sideways into the
  // landscape layout; a tap still reads the right frequency, the chart menu opens on screen; 세로 goes back
  await page.getByRole('button', { name: '가로 화면으로' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.rotate === 'on' && document.documentElement.dataset.layout === 'landscape');
  assert.ok(await page.locator('.tabbar').isHidden(), 'no tab bar in the landscape layout');
  const turned = await page.evaluate(() => [document.querySelector('#a-chart').clientWidth, document.querySelector('#a-chart').clientHeight]);
  assert.ok(turned[0] > turned[1] * 1.5, `a wide chart when turned: ${turned}`);
  await page.waitForTimeout(800);
  await tapSideways(page, 1000);
  await page.waitForSelector('#a-cursor:not([hidden])');
  const sideHz = Number((await page.locator('#a-cursor .cr-hz').textContent()).replace(/[^\d.]/g, ''));
  console.log(`turned sideways: chart ${turned.join(' x ')}, cursor ${sideHz} Hz`);
  assert.ok(Math.abs(sideHz - 1000) / 1000 < 0.04, 'the cursor reads the tapped frequency when turned');
  await shot(page, 'sideways');
  await page.locator('#a-cursor .cr-close').click();
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menu').waitFor();
  const mb = await page.getByRole('menu').boundingBox();
  assert.ok(mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= 391 && mb.y + mb.height <= 845, `the menu stays on screen: ${JSON.stringify(mb)}`);
  await shot(page, 'sideways-menu');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '세로 화면으로' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.layout === 'portrait' && document.documentElement.dataset.rotate === 'off');
  assert.ok(await page.locator('.tabbar').isVisible(), 'back to portrait');

  // other views: spectrogram and 1/3 octave each on their own, then back
  assert.equal(await page.locator('.mode').count(), 3, 'three views');
  await page.waitForTimeout(3000);
  await setMode(page, 'gram');
  // the spectrogram kept what came in while it was not shown: the tone is there at once, seconds deep
  await page.waitForTimeout(200);
  const gramRows = await page.evaluate(() => {
    const cv = document.querySelector('#a-gram canvas');
    const { data, width, height } = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height);
    let rows = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 60; x < width; x++) {
        const i = (y * width + x) * 4;
        if (data[i] + data[i + 1] + data[i + 2] > 600) {
          rows++;
          break;
        }
      }
    }
    return rows / (window.devicePixelRatio || 1);
  });
  console.log(`spectrogram history on showing it: ${gramRows.toFixed(0)} rows`);
  assert.ok(gramRows > 60, 'rows from before the spectrogram was shown');
  assert.ok(!(await page.locator('#a-trace canvas').isVisible()), 'time-axis graph only in the main view');
  await page.waitForTimeout(1500);
  assert.ok(await page.locator('#a-gram canvas').isVisible() && !(await page.locator('#a-chart canvas').isVisible()));
  await setMode(page, 'octave');
  await page.waitForTimeout(1500);
  assert.ok(await page.locator('#a-octave canvas').isVisible());
  await shot(page, 'tone-octave');
  await setMode(page, 'spectrum');
  assert.ok(await page.locator('#a-chart canvas').isVisible() && (await page.locator('#a-trace canvas').isVisible()));
  // the time-axis graph shows the last 30 s, 1 min or 5 min
  assert.equal(await page.locator('dialog .seg[data-key=trace] button').count(), 0);
  await chartSettings(page, { trace: '60' });
  assert.equal((await page.evaluate(() => JSON.parse(localStorage.getItem('noise-meter:settings:v1')))).traceSec, 60);
  await chartSettings(page, { trace: '30' });
  assert.match(await page.locator('#a-mode-name').textContent(), /주파수 \+ 시간축/);

  // chart menu: style and curves; graph settings sheet: FFT size, axis
  await chartMenu(page, { style: 'line', on: ['maxTrack', 'minTrack', 'minHold'], off: ['peakHold'] });
  await chartSettings(page, { fft: '8192', scale: 'linear' });
  await page.waitForTimeout(800);
  await shot(page, 'tone-linear');
  await chartMenu(page, { style: 'bar' });
  await page.waitForTimeout(300);
  await shot(page, 'tone-bars');
  await chartMenu(page, { style: 'fill', on: ['peakHold'], off: ['maxTrack', 'minTrack'] });
  await chartSettings(page, { fft: '4096', scale: 'log' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('noise-meter:settings:v1')));
  assert.deepEqual(
    [saved.style, saved.peakHold, saved.minHold, saved.maxTrack, saved.minTrack, saved.fftSize, saved.scale, saved.view],
    ['fill', true, true, false, false, 4096, 'log', 'spectrum'],
  );
  assert.ok(!('hold' in saved), 'old single max switch is gone');
  // tapping outside closes the menu, also when the tap is on the chart button itself
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menu').waitFor();
  await page.getByRole('button', { name: '그래프 설정' }).click({ force: true });
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.menu').count(), 0, 'menu closed');
  // hold reset starts the curves again but not the levels
  const leqBefore = await page.locator('#a-leq').textContent();
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menuitem', { name: '홀드 재설정' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  assert.equal(await page.locator('.menu').count(), 0);
  assert.notEqual(await page.locator('#a-time').textContent(), '00:00', 'hold reset keeps measuring time');
  assert.ok(leqBefore !== '–' && (await page.locator('#a-leq').textContent()) !== '–', 'and the levels');

  // measurement situations: one choice sets several settings; a change by hand makes it 사용자 지정;
  // 사용자 지정 brings back the own mix
  const pickPreset = async (name) => {
    await page.locator('#a-preset').click();
    await page.getByRole('menuitemradio', { name: new RegExp(`^${name}`) }).click();
    await page.waitForSelector('.menu', { state: 'detached' });
    assert.match(await page.locator('#a-preset').textContent(), new RegExp(name));
  };
  assert.match(await page.locator('#a-preset').textContent(), /사용자 지정/);
  const own = await settingsOf(page);
  await pickPreset('공회전');
  let st = await settingsOf(page);
  assert.deepEqual([st.preset, st.fftSize, st.style, st.peakHold, st.minHold, st.traceSec], ['idle', 16384, 'line', true, true, 60]);
  await page.getByRole('button', { name: '그래프 설정' }).click();
  assert.equal(await page.locator('.menu [data-style=line]').getAttribute('aria-checked'), 'true', 'chart menu shows it');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await shot(page, 'preset-idle');
  await chartMenu(page, { style: 'bar' });
  assert.match(await page.locator('#a-preset').textContent(), /사용자 지정/, 'changed by hand');
  await pickPreset('주행');
  st = await settingsOf(page);
  assert.deepEqual([st.preset, st.fftSize, st.style, st.maxTrack, st.traceSec], ['drive', 4096, 'fill', true, 300]);
  await pickPreset('사용자 지정');
  st = await settingsOf(page);
  assert.deepEqual([st.preset, st.fftSize, st.style, st.minHold, st.traceSec], ['custom', 16384, 'bar', true, 60], 'the own mix (공회전 + 막대)');
  // back to the settings the rest of this run expects
  await chartMenu(page, { style: own.style });
  await chartSettings(page, { fft: String(own.fftSize), trace: String(own.traceSec), timeWeighting: own.timeWeighting });
  assert.equal(await page.locator('#a-tw').textContent(), 'Fast');

  // axis ranges: frequency by quick pick and typed in, a range that is refused, fixed dB ranges,
  // a cursor that reads right on the narrowed axis, then back to the start
  const openRanges = async () => {
    await page.getByRole('button', { name: '그래프 설정' }).click();
    await page.getByRole('menuitem', { name: '축 범위' }).click();
    await page.waitForSelector('dialog.sheet .range-sheet');
    return page.locator('dialog.sheet');
  };
  const typeIn = async (loc, v) => {
    await loc.fill(String(v));
    await loc.dispatchEvent('change');
  };
  let rs = await openRanges();
  await rs.locator('[data-f="20,500"]').click();
  st = await settingsOf(page);
  assert.deepEqual([st.freqMin, st.freqMax, st.preset], [20, 500, 'custom']);
  await typeIn(rs.locator('#r-fmax'), 2000);
  await typeIn(rs.locator('#r-fmin'), 500);
  await typeIn(rs.locator('#r-fmin'), 3000);
  assert.ok(await rs.locator('#r-error').isVisible(), 'start above the end is refused');
  st = await settingsOf(page);
  assert.deepEqual([st.freqMin, st.freqMax], [500, 2000]);
  await typeIn(rs.locator('#r-fmin'), 500);
  assert.ok(!(await rs.locator('#r-error').isVisible()));
  for (const key of ['specDb', 'traceDb', 'gramDb', 'octDb']) {
    await rs.locator(`.seg[data-key=${key}] [data-v=manual]`).click();
    assert.ok(Array.isArray((await settingsOf(page))[key]), `${key} fixed from what is shown`);
  }
  const spec = rs.locator('[data-range=specDb]');
  await typeIn(spec.locator('[data-lo]'), -40);
  await typeIn(spec.locator('[data-hi]'), 120);
  await typeIn(rs.locator('[data-range=traceDb] [data-hi]'), 0); // below the low end: refused
  assert.ok(await rs.locator('#r-error').isVisible());
  st = await settingsOf(page);
  assert.deepEqual(st.specDb, [-40, 120]);
  await shot(page, 'range-sheet');
  await rs.getByRole('button', { name: '닫기' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
  await page.locator('#a-cursor .cr-close').click().catch(() => {});
  await tapFrequency(page, 1000, 500, 2000);
  await page.waitForSelector('#a-cursor:not([hidden])');
  const rHz = Number((await page.locator('#a-cursor .cr-hz').textContent()).replace(/[^\d.]/g, ''));
  const rDb = Number(await page.locator('#a-cursor .cr-cur em').textContent());
  console.log(`cursor on 500 Hz – 2 kHz: ${rHz} Hz ${rDb}`);
  assert.ok(Math.abs(rHz - 1000) < 15 && rDb > 60, 'cursor on the narrowed axis');
  await shot(page, 'range-live');
  await page.locator('#a-cursor .cr-close').click();
  rs = await openRanges();
  await rs.getByRole('button', { name: '처음대로' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
  st = await settingsOf(page);
  assert.deepEqual([st.freqMin, st.freqMax, st.specDb, st.traceDb, st.gramDb, st.octDb], [20, 20000, null, null, null, null]);

  // two fingers on 200 Hz and 2 kHz spread to the ends of the plot: the axis becomes 200 Hz – 2 kHz;
  // "전체 보기" goes back
  {
    const r = await page.locator('#a-chart').boundingBox();
    const k = r.width < 360 ? 0.92 : 1;
    const x0 = r.x + 30 * k;
    const x1 = r.x + Math.floor(r.width) - 6 * k;
    const at = (hz) => x0 + (Math.log(hz / 20) / Math.log(1000)) * (x1 - x0);
    const yy = r.y + r.height * 0.5;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type, xa, xb) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x: xa, y: yy, id: 1 }, { x: xb, y: yy, id: 2 }] });
    await touch('touchStart', at(200), at(2000));
    for (let i = 1; i <= 8; i++) await touch('touchMove', at(200) + ((x0 + 1 - at(200)) * i) / 8, at(2000) + ((x1 - 1 - at(2000)) * i) / 8);
    await touch('touchEnd');
    await page.waitForSelector('#a-zoom:not([hidden])');
    const zoomed = await settingsOf(page);
    console.log(`pinch: ${zoomed.freqMin} – ${zoomed.freqMax} Hz`);
    assert.ok(Math.abs(zoomed.freqMin - 200) < 12 && Math.abs(zoomed.freqMax - 2000) < 120, 'pinched axis');
    assert.ok(await page.locator('#a-cursor').isHidden(), 'a pinch places no cursor');
    await shot(page, 'pinch');
    await page.locator('#a-zoom').click();
    await page.waitForSelector('#a-zoom', { state: 'hidden' });
    const back = await settingsOf(page);
    assert.deepEqual([back.freqMin, back.freqMax], [20, 20000]);
  }

  // help sheet
  await page.getByRole('button', { name: '도움말' }).click();
  await page.waitForSelector('dialog.sheet .help');
  await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();

  // save -> history -> saved analysis -> share card + CSV
  await page.waitForTimeout(1500);
  await page.getByRole('button', { name: '저장', exact: true }).first().click();
  const sheet = page.locator('dialog.sheet');
  await sheet.locator('#f-vehicle').fill('12가 3456');
  await sheet.locator('#f-memo').fill('공회전 1000Hz 시험음');
  await page.waitForFunction(() => /초도 함께 저장/.test(document.querySelector('#f-audio-label')?.textContent || ''));
  assert.ok(await sheet.locator('#f-audio').isChecked());
  await sheet.getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.waitForSelector('.record-row');
  assert.equal(await page.locator('.record-row').count(), 1);
  const span = await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.open('noise-meter');
    req.onsuccess = () => {
      const all = req.result.transaction('records').objectStore('records').getAll();
      all.onsuccess = () => {
        const sp = all.result[0].spectrum;
        resolve([sp.freqs[0], sp.freqs.at(-1), sp.min?.length, sp.min?.every((v, i) => v <= sp.max[i])]);
      };
    };
  }));
  assert.deepEqual(span, [20, 20000, 241, true], 'saved spectrum spans 20 Hz – 20 kHz, with the minimum hold'); 
  const [csv] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: /엑셀/ }).click()]);
  const csvText = fs.readFileSync(await csv.path(), 'utf8');
  assert.ok(csvText.startsWith('\uFEFF일시,출처,차량번호'), 'CSV header with BOM');
  await page.locator('.record-row').click();
  await page.waitForSelector('.stats-grid');
  assert.ok(Math.abs((await num(page, '.stats-grid div:first-child b')) - expected1) < 0.3);
  const [card] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '결과 보내기' }).click()]);
  const cardPath = path.join(SHOTS || tmp, 'share-card.png');
  await card.saveAs(cardPath);
  assert.ok(fs.statSync(cardPath).size > 20000, 'share card PNG');

  // the saved sound: playable, analysed into a spectrogram, shareable as WAV
  await page.waitForSelector('#rec-audio');
  await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  const duration = await page.evaluate(
    () => new Promise((resolve) => {
      const a = document.querySelector('#rec-audio');
      if (a.readyState >= 1) resolve(a.duration);
      else a.addEventListener('loadedmetadata', () => resolve(a.duration));
    }),
  );
  console.log(`saved sound: ${duration.toFixed(1)} s`);
  assert.ok(duration > 2 && duration <= 10.05, 'sound length');
  const [wav] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '소리 파일 보내기' }).click()]);
  const wavBytes = fs.readFileSync(await wav.path());
  assert.equal(wavBytes.toString('latin1', 0, 4), 'RIFF');
  assert.ok(wavBytes.length > 48000, 'WAV has sound in it');
  await page.evaluate(() => document.querySelector('#rec-audio').play());
  await page.waitForTimeout(1200);
  await shot(page, 'record-tone-playing', true);

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

  // recording is separate from measuring: start it while paused, it does not resume measuring;
  // resume measuring, the recording runs on; stop it, measuring goes on and the file opens on request
  await page.getByRole('button', { name: '일시정지' }).click();
  await page.waitForSelector('.analyzer[data-state="pause"]');
  const frozen = await page.locator('#a-time').textContent();
  await page.getByRole('button', { name: '녹음 시작' }).click();
  await page.waitForSelector('.analyzer[data-rec="on"]');
  await page.waitForTimeout(1600);
  assert.equal(await page.locator('.analyzer').getAttribute('data-state'), 'pause', 'recording does not resume measuring');
  assert.equal(await page.locator('#a-time').textContent(), frozen, 'measuring clock stays still');
  assert.match(await page.locator('#a-rec-time').textContent(), /00:0[12]/, 'recording clock runs while paused');
  await page.getByRole('button', { name: '다시 측정' }).click();
  await running(page);
  await page.waitForTimeout(1800);
  assert.equal(await page.locator('.analyzer').getAttribute('data-rec'), 'on', 'resuming leaves the recording on');
  assert.match(await page.locator('#a-state').textContent(), /측정 중/);
  assert.match(await page.locator('#a-rec-time').textContent(), /00:0[34]/);
  await shot(page, 'recording');
  await page.getByRole('button', { name: '녹음 정지' }).click();
  await page.waitForSelector('.analyzer[data-rec="off"]');
  await page.waitForSelector('#toast:not([hidden]) .toast-action');
  assert.equal(await page.evaluate(() => location.hash), '#/', 'stopping the recording stays on the analyzer');
  assert.equal(await page.locator('.analyzer').getAttribute('data-state'), 'run', 'measuring goes on');
  await shot(page, 'recording-done');
  await page.locator('#toast .toast-action').click();
  await page.waitForSelector('#fa-result .stats-grid', { timeout: 20000 });
  assert.match(await page.locator('.file-name').textContent(), /^녹음_\d{8}_\d{4}\.wav$/);
  const recLen = await page.evaluate(() => document.querySelector('#fa-audio').duration);
  const recLeq = await num(page, '#fa-result .stats-grid div:nth-child(1) b');
  console.log(`recording: ${recLen.toFixed(2)} s, Leq ${recLeq}`);
  assert.ok(recLen > 3 && recLen < 4.8, 'recording length includes the paused part');
  assert.ok(Math.abs(recLeq - (expected1 + 3)) < 0.3, 'recording Leq');

  // calibrator mode: the 1 kHz test tone stands in for a 94 dB calibrator; steady, so stability is good,
  // the value is filled in, and after applying the analyzer reads 94 dB(A)
  await page.locator('.tabbar a[data-tab=settings]').click();
  await page.waitForSelector('.cal-modes'); // still unlocked from the calibration above
  await page.locator('.cal-modes button[data-v=calibrator]').click();
  assert.ok(await page.locator('.cal-ref-pick').isVisible(), 'calibrator level choice');
  await page.getByRole('button', { name: /보정 측정/ }).click();
  await page.waitForSelector('#cal-live:not([hidden])');
  await page.waitForSelector('#cal-result:not([hidden])', { timeout: 15000 });
  const stab = await page.locator('#cal-stab').textContent();
  console.log(`calibrator: phone ${await page.locator('#cal-phone').textContent()}, ${stab}`);
  assert.match(stab, /안정성 좋음/);
  assert.ok(await page.locator('#cal-warn').isHidden(), 'no warning for a steady 1 kHz tone');
  assert.equal(await page.locator('#f-cal-ref').inputValue(), '94');
  await shot(page, 'calibrator', true);
  await page.getByRole('button', { name: '적용' }).click();
  const calOffset = parseFloat(await page.locator('#cal-offset').textContent());
  assert.ok(Math.abs(calOffset - (103 + 94 - (expected1 + 3))) < 0.4, `calibrator offset ${calOffset}`);
  await page.locator('.tabbar a[data-tab=home]').click();
  await running(page);
  await page.waitForTimeout(2000);
  assert.ok(Math.abs((await num(page, '#a-now')) - 94) < 0.5, 'reads the calibrator level');
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

  // C and Z weighting: 100 Hz loses 0.3 dB with C and nothing with Z
  for (const [w, weight] of [['C', -0.3], ['Z', 0], ['A', -19.1]]) {
    await chartSettings(page, { weighting: w }, w === 'C' ? 'settings-sheet' : null);
    assert.equal(await page.locator('#a-unit').textContent(), `dB(${w})`);
    await page.waitForTimeout(1800);
    const v = await num(page, '#a-now');
    const leq = await num(page, '#a-leq');
    console.log(`100 Hz ${w}: now ${v}, avg ${leq} dB(${w}), expected ${toneDb(0.5, weight).toFixed(1)}`);
    assert.ok(Math.abs(v - toneDb(0.5, weight)) < 0.6, `${w}-weighted level`);
    assert.ok(Math.abs(leq - toneDb(0.5, weight)) < 0.6, `${w}-weighted average starts again`);
  }

  // external microphone (an iMM-6C stand-in): picked in the graph settings, it starts from the phone's
  // calibration marked "보정 안 됨"; its own offset (+10 dB) and a flat +3 dB calibration file then apply to
  // it alone: the big number follows the offset, the spectrum also the file; back to the phone mic, all as before
  await page.waitForTimeout(1500);
  const phoneCursor = await cursorDb(page, 100);
  await pickMic(page, 'Fake Audio Input 1');
  assert.match(await page.locator('#a-mic').textContent(), /보정 안 됨/);
  await page.waitForTimeout(1800);
  const extNow = await num(page, '#a-now');
  console.log(`external mic, not calibrated: now ${extNow}`);
  assert.ok(Math.abs(extNow - expected2) < 0.6, 'an uncalibrated external mic starts from the phone offset');
  await page.locator('.tabbar a[data-tab=settings]').click();
  await page.locator('#f-pin').fill('0000');
  await page.getByRole('button', { name: '확인' }).click();
  await page.waitForFunction(() => document.querySelector('#f-cal-mic')?.selectedOptions[0]?.textContent === 'Fake Audio Input 1');
  assert.equal(await page.locator('#cal-mic').textContent(), 'Fake Audio Input 1');
  await page.locator('summary', { hasText: '보정값 직접 입력' }).click();
  await page.locator('#f-offset').fill('110');
  await page.getByRole('button', { name: '설정 저장' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  const dayton = ['*1000Hz\t-40.0', ...[10, 20, 50, 100, 200, 1000, 5000, 10000, 20000].map((f) => `${f}\t3.00\t0.0`)].join('\r\n');
  await page.setInputFiles('#f-cal-file', { name: 'iMM-6C_0000001.txt', mimeType: 'text/plain', buffer: Buffer.from(dayton) });
  await page.waitForFunction(() => /감도 -40 dB/.test(document.querySelector('#cal-file-state').textContent));
  assert.match(await page.locator('#cal-offset').textContent(), /^110 dB$/);
  await page.selectOption('#f-cal-mic', '');
  assert.match(await page.locator('#cal-offset').textContent(), /^100 dB$/, 'the phone mic keeps its own offset');
  assert.equal(await page.locator('#cal-file-state').textContent(), '보정 파일 없음');
  const mics = (await settingsOf(page)).mics;
  assert.equal(mics['Fake Audio Input 1'].offset, 110);
  assert.equal(mics['Fake Audio Input 1'].calSens, -40);
  await page.locator('.tabbar a[data-tab=home]').click();
  await running(page);
  await page.waitForSelector('#a-mic:not([hidden])');
  assert.doesNotMatch(await page.locator('#a-mic').textContent(), /보정 안 됨/, 'now calibrated');
  await page.waitForTimeout(1800);
  const extNowCal = await num(page, '#a-now');
  const extCursor = await cursorDb(page, 100);
  console.log(`external mic, +10 dB and flat +3 dB file: now ${extNowCal}; cursor ${phoneCursor} -> ${extCursor}`);
  assert.ok(Math.abs(extNowCal - (expected2 + 10)) < 0.6, 'the big number uses the offset only');
  assert.ok(Math.abs(extCursor - (phoneCursor + 10 - 3)) < 0.4, 'the spectrum also takes the calibration file');
  await shot(page, 'external-mic');
  await pickMic(page, '');
  await page.waitForTimeout(1800);
  assert.ok(Math.abs((await num(page, '#a-now')) - expected2) < 0.6, 'back on the phone mic');
  assert.equal((await settingsOf(page)).micId, '');

  // timed measurement: from zero, exactly 5 s, then it pauses by itself and the save sheet opens;
  // tapping it again cancels and measuring goes on
  await chartSettings(page, { timed: '5' });
  assert.equal(await page.locator('#a-timed-cap').textContent(), '5초 측정');
  await page.getByRole('button', { name: '5초 측정', exact: true }).click();
  await page.waitForSelector('.analyzer[data-timed="on"]');
  assert.equal(await page.locator('#a-state').textContent(), '5초 측정 중');
  await page.getByRole('button', { name: '5초 측정 취소' }).click();
  await page.waitForSelector('.analyzer[data-timed="off"]');
  assert.equal(await page.locator('.analyzer').getAttribute('data-state'), 'run', 'cancelling keeps measuring');
  await page.getByRole('button', { name: '5초 측정', exact: true }).click();
  await page.waitForTimeout(2000);
  assert.match(await page.locator('#a-timed-cap').textContent(), /^남은 [34]초$/);
  await shot(page, 'timed');
  await page.waitForSelector('dialog.sheet h2:has-text("5초 측정 저장")', { timeout: 10000 });
  assert.equal(await page.locator('.analyzer').getAttribute('data-state'), 'pause');
  assert.equal(await page.locator('#a-time').textContent(), '00:05');
  assert.equal(await page.locator('#a-state').textContent(), '5초 측정 끝');
  assert.ok(Math.abs((await num(page, '#a-leq')) - expected2) < 0.4, 'timed Leq');
  await page.waitForFunction(() => /측정한 소리 5초/.test(document.querySelector('#f-audio-label')?.textContent || ''));
  await shot(page, 'timed-save');
  await page.locator('dialog.sheet').getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.locator('.record-row').first().click();
  await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  assert.match(await page.locator('.rec-head p').first().textContent(), /5초 측정 00:05/);
  const timedAudio = await page.evaluate(() => new Promise((r) => {
    const a = document.querySelector('#rec-audio');
    if (a.readyState >= 1) r(a.duration);
    else a.onloadedmetadata = () => r(a.duration);
  }));
  console.log(`timed 5 s: saved sound ${timedAudio.toFixed(2)} s`);
  assert.ok(Math.abs(timedAudio - 5) < 0.15, 'the saved sound is the measured 5 s');
  assert.match(await page.locator('.chart-card .legend').textContent(), /측정 평균/, 'a measurement keeps its average spectrum');

  // before / after: the saved measurement as a dashed reference over the live spectrum
  await page.getByRole('button', { name: '실시간과 비교' }).click();
  await running(page);
  await page.waitForSelector('#a-ref:not([hidden])');
  assert.match(await page.locator('#a-ref-name').textContent(), /^기준 \d+\.\d\d \d\d:\d\d$/);
  await page.getByRole('button', { name: '일시정지' }).click(); // the chip compares the average since reset
  await page.getByRole('button', { name: '다시 측정' }).click();
  await page.waitForTimeout(2500);
  const refDiff = parseFloat((await page.locator('#a-ref-diff').textContent()).replace('−', '-'));
  console.log(`live against the saved 5 s: ${await page.locator('#a-ref').textContent()}`);
  assert.ok(Math.abs(refDiff) < 0.5, 'the same tone: no difference');
  await tapFrequency(page, 100);
  await page.waitForSelector('#a-cursor .cr-ref');
  const crRef = await page.locator('#a-cursor .cr-ref').textContent(); // "기준 68.4 (+0.1)"
  const [refAt, refD] = crRef.replace('−', '-').match(/-?[\d.]+/g).map(Number);
  assert.ok(refAt > 60 && Math.abs(refD) < 1, `cursor reads the reference too: ${crRef}`);
  await shot(page, 'compare-live');
  await page.locator('#a-cursor .cr-close').click();
  await page.locator('[data-act=ref-off]').click();
  await page.waitForSelector('#a-ref', { state: 'hidden' });
  assert.equal((await settingsOf(page)).refId, '');

  // 오디오 세부정보: the microphone, the browser's audio values, sound processing off
  await page.getByRole('button', { name: '그래프 설정' }).click();
  await page.getByRole('menuitem', { name: '오디오 세부정보' }).click();
  const details = page.locator('dialog.sheet .details');
  await details.waitFor();
  const dText = await details.textContent();
  assert.match(dText, /샘플링 레이트\d+ Hz/);
  assert.match(dText, /자동 음량 조절꺼짐/);
  assert.match(dText, /A특성/);
  await shot(page, 'details');
  await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();
  await page.waitForSelector('dialog.sheet', { state: 'detached' });

  // 바로 저장: a timed measurement saves without the sheet, with the last vehicle number
  await page.evaluate(async () => (await import('./js/settings.js')).saveSettings({ vehicle: '78다 9012' })); // as after an earlier save
  await chartSettings(page, { autoSave: 'on' });
  const before = await page.evaluate(() => new Promise((r) => {
    const q = indexedDB.open('noise-meter');
    q.onsuccess = () => {
      const c = q.result.transaction('records').objectStore('records').count();
      c.onsuccess = () => r(c.result);
    };
  }));
  await page.getByRole('button', { name: '5초 측정', exact: true }).click();
  await page.waitForFunction(() => /5초 측정을 저장했습니다 \(78다 9012\)/.test(document.querySelector('#toast')?.textContent || ''), null, { timeout: 12000 });
  assert.equal(await page.locator('dialog.sheet').count(), 0, 'no save sheet');
  await page.locator('#toast .toast-action').click();
  await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  assert.match(await page.locator('.rec-head h1').textContent(), /78다 9012/);
  assert.match(await page.locator('.rec-head p').first().textContent(), /5초 측정 00:05/);
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.waitForSelector('.record-row');
  assert.equal(await page.locator('.record-row').count(), before + 1);
  await page.locator('.tabbar a[data-tab=home]').click();
  await running(page);
  await chartSettings(page, { autoSave: 'off' });
  await page.evaluate(async () => (await import('./js/settings.js')).saveSettings({ vehicle: '' }));

  // 영상: the readings and graphs with the sound as one video file, offered to send when it stops
  await page.getByRole('button', { name: '영상 녹화' }).click();
  await page.waitForSelector('#a-video-badge:not([hidden])');
  await page.waitForTimeout(2600);
  assert.match(await page.locator('#a-video-time').textContent(), /00:0[23]/);
  await shot(page, 'video');
  await page.getByRole('button', { name: '영상 정지' }).click();
  await page.waitForSelector('dialog.sheet h2:has-text("영상 녹화 끝")');
  const vText = await page.locator('dialog.sheet p').first().textContent();
  const [vid] = await Promise.all([page.waitForEvent('download'), page.locator('dialog.sheet').getByRole('button', { name: '보내기' }).click()]);
  const vBytes = fs.readFileSync(await vid.path());
  const isMp4 = vBytes.subarray(4, 8).toString() === 'ftyp';
  const isWebm = vBytes.readUInt32BE(0) === 0x1a45dfa3;
  console.log(`video: ${vText}, ${vBytes.length} bytes, ${isMp4 ? 'MP4' : isWebm ? 'WebM' : 'unknown'}`);
  assert.ok(vBytes.length > 20000 && (isMp4 || isWebm), 'a playable video file');
  if (SHOTS) fs.writeFileSync(path.join(SHOTS, `video.${isMp4 ? 'mp4' : 'webm'}`), vBytes);
  await page.waitForSelector('dialog.sheet', { state: 'detached' });

  // attached file: 3 s of 1 kHz (77.0 dB(A)) then 3 s of 100 Hz (71.9 dB(A))
  // (passed as a buffer: Playwright here cannot attach files from non-ASCII paths, and the Korean name
  // is part of what is being checked)
  const twoTone = path.join(tmp, 'two-tone.wav');
  writeTwoTone(twoTone);
  await page.locator('.tabbar a[data-tab=file]').click();
  await page.setInputFiles('#fa-input', { name: '두 구간 시험음.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(twoTone) });
  await page.waitForSelector('#fa-result .stats-grid', { timeout: 20000 });
  const l1 = toneDb(0.1);
  const l2 = toneDb(0.5, -19.1);
  const fileLeq = 10 * Math.log10((10 ** (l1 / 10) + 10 ** (l2 / 10)) / 2);
  const fLeq = await num(page, '#fa-result .stats-grid div:nth-child(1) b');
  const fMax = await num(page, '#fa-result .stats-grid div:nth-child(2) b');
  const fMin = await num(page, '#fa-result .stats-grid div:nth-child(3) b');
  console.log(`file: Leq ${fLeq} (expected ${fileLeq.toFixed(1)}), max ${fMax}, min ${fMin}`);
  assert.ok(Math.abs(fLeq - fileLeq) < 0.3, 'file Leq');
  assert.ok(Math.abs(fMax - l1) < 0.4 && Math.abs(fMin - l2) < 0.6, 'file max/min');
  assert.match(await page.locator('.file-name').textContent(), /두 구간 시험음/);
  assert.match(await page.locator('#fa-result .meta').textContent(), /1,00\d Hz|99\d Hz/);
  // digital level: the same numbers without the +100 dB calibration
  await page.getByRole('button', { name: /레벨 기준/ }).click();
  await page.waitForFunction(() => /dBFS/.test(document.querySelector('#fa-result .stats-grid small')?.textContent || ''));
  assert.ok(Math.abs((await num(page, '#fa-result .stats-grid div:nth-child(1) b')) - (fileLeq - OFFSET)) < 0.3, 'dBFS Leq');
  await page.getByRole('button', { name: /레벨 기준/ }).click();
  await page.waitForFunction(() => /dB\(A\)/.test(document.querySelector('#fa-result .stats-grid small')?.textContent || ''));
  // tapping the time history seeks; the spectrum then shows that moment
  await page.evaluate(() => document.querySelector('#fa-time').scrollIntoView({ block: 'center' }));
  const tl = await page.locator('#fa-time').boundingBox();
  await page.mouse.click(tl.x + 30 + (tl.width - 36) * 0.9, tl.y + tl.height / 2);
  const t = await page.evaluate(() => document.querySelector('#fa-audio').currentTime);
  assert.ok(Math.abs(t - 5.4) < 0.4, `seek to ${t}`);
  assert.match(await page.locator('#fa-legend').textContent(), /재생 위치/);
  await page.getByRole('button', { name: '기록에 저장' }).click();
  await page.locator('dialog.sheet').getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.locator('.record-row').first().click();
  await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  assert.match(await page.locator('.rec-head h1').textContent(), /두 구간 시험음/);
  assert.ok(Math.abs((await num(page, '.stats-grid div:first-child b')) - fileLeq) < 0.3, 'saved file Leq');
  // record against record: the 5 s measurement dashed over the file, and the two averages
  await page.getByRole('button', { name: '다른 기록과 비교' }).click();
  await page.locator('dialog.sheet .record-row').filter({ hasText: '차량 미입력' }).filter({ hasText: '5초 측정' }).click();
  await page.waitForSelector('#rec-ref:not([hidden])');
  const cmp = await page.locator('#rec-ref-text').textContent();
  console.log(`record comparison: ${cmp}`);
  const cmpD = parseFloat(cmp.match(/([+−])([\d.]+) dB/).slice(1).join('').replace('−', '-'));
  assert.ok(Math.abs(cmpD - (fileLeq - expected2)) < 0.5, 'difference of the averages');
  assert.match(await page.locator('.chart-card .legend').textContent(), /비교: /);
  await shot(page, 'compare-records', true);

  // office sharing: this phone sends all its records (with their sound) as one file; a second phone takes
  // in the ones it does not have, labelled with the first phone's name; doing it again adds nothing
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.getByRole('button', { name: '기록 백업 보내기' }).click();
  await page.locator('dialog.sheet #f-device').fill('정비팀 1호');
  await shot(page, 'backup-sheet');
  const [bak] = await Promise.all([page.waitForEvent('download'), page.locator('dialog.sheet').getByRole('button', { name: '파일 만들기' }).click()]);
  const bakPath = path.join(tmp, 'backup.nmb');
  await bak.saveAs(bakPath);
  assert.equal((await settingsOf(page)).device, '정비팀 1호');
  const office = await newPage(browser, base, errors, { mic: false, seed: { device: '사무실' } });
  await office.evaluate(() => (location.hash = '#/history'));
  await office.waitForSelector('.empty-hint');
  await office.setInputFiles('#f-backup', { name: 'backup.nmb', mimeType: 'application/octet-stream', buffer: fs.readFileSync(bakPath) });
  await office.waitForFunction(() => /정비팀 1호의 기록 3건을 넣었습니다/.test(document.querySelector('#toast')?.textContent || ''));
  await office.waitForSelector('.record-row');
  assert.equal(await office.locator('.record-row').count(), 3);
  assert.equal(await office.locator('.rr-dev').first().textContent(), '정비팀 1호');
  await shot(office, 'backup-imported');
  await office.locator('.record-row').filter({ hasText: '차량 미입력' }).filter({ hasText: '5초 측정' }).click();
  await office.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  assert.match(await office.locator('.meta dt:has-text("휴대폰") + dd').textContent(), /정비팀 1호 \(\d{4}\.\d\d\.\d\d 백업에서 넣음\)/);
  assert.ok(await office.getByRole('button', { name: '소리 파일 보내기' }).isVisible(), 'the sound came along');
  await office.evaluate(() => (location.hash = '#/history'));
  await office.waitForSelector('.record-row');
  await office.setInputFiles('#f-backup', { name: 'backup.nmb', mimeType: 'application/octet-stream', buffer: fs.readFileSync(bakPath) });
  await office.waitForFunction(() => /새 기록이 없습니다 \(3건 모두 이미 있음\)/.test(document.querySelector('#toast')?.textContent || ''));
  assert.equal(await office.locator('.record-row').count(), 3);
  await office.context().close();
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

    // 속도 (GPS) on, driving at 80 km/h
    page = await newPage(browser, base, errors, { viewport, seed: { vehicle: '12가 3456', recentVehicles: ['12가 3456', '34나 5678'], gps: true }, geo: { latitude: 37.5, longitude: 127, accuracy: 5 } });
    const driving = drive(page.context(), 80);
    await running(page);
    await page.waitForTimeout(4000);
    const kmh = await num(page, '#a-speed');
    console.log(`speed (${name}): ${kmh} km/h`);
    assert.ok(Math.abs(kmh - 80) < 4, 'speed from the position');
    await tapFrequency(page, 1250);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-live`);
    await page.locator('#a-cursor .cr-close').click();
    await setMode(page, 'gram');
    await page.waitForTimeout(3500);
    await shot(page, `main-${name}-gram`);
    await setMode(page, 'spectrum');
    await chartMenu(page, { style: 'line' });
    await page.waitForTimeout(2500);
    await tapFrequency(page, 125);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-line`);
    await page.locator('#a-cursor .cr-close').click();
    await chartMenu(page, { style: 'fill' });
    // the curves from the chart menu, then the menu itself
    await chartMenu(page, { style: 'line', on: ['maxTrack', 'minTrack', 'minHold'] });
    await page.waitForTimeout(2500);
    await shot(page, `main-${name}-curves`);
    await chartMenu(page, { style: 'bar' });
    await page.waitForTimeout(500);
    await shot(page, `main-${name}-bars`);
    await chartMenu(page, {}, `chart-menu-${name}`);
    await page.locator('#a-preset').click();
    await page.getByRole('menu').waitFor();
    await shot(page, `preset-menu-${name}`);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '그래프 설정' }).click();
    await page.getByRole('menuitem', { name: '축 범위' }).click();
    await page.waitForSelector('dialog.sheet .range-sheet');
    await shot(page, `range-sheet-${name}`);
    await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();
    await chartMenu(page, { style: 'fill', off: ['maxTrack', 'minTrack', 'minHold'] });
    await setMode(page, 'octave');
    await page.waitForTimeout(2500);
    await shot(page, `main-${name}-octave`);
    await setMode(page, 'spectrum');
    await page.waitForTimeout(6000); // let the level trace fill up
    await tapFrequency(page, 1250);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-trace`);
    await page.locator('#a-cursor .cr-close').click();
    // the bright screen for sunlight
    await chartSettings(page, { theme: 'light' });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
    await page.waitForTimeout(600);
    await tapFrequency(page, 1250);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-light`);
    await page.locator('#a-cursor .cr-close').click();
    await chartSettings(page, { theme: 'dark' });
    await page.getByRole('button', { name: '그래프 설정' }).click();
    await page.getByRole('menuitem', { name: /가중치/ }).click();
    await page.waitForTimeout(200);
    await shot(page, `settings-sheet-${name}`);
    await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();
    await page.getByRole('button', { name: '도움말' }).click();
    await page.waitForTimeout(200);
    await shot(page, `help-${name}`);
    await page.locator('dialog.sheet').getByRole('button', { name: '닫기' }).click();
    await page.getByRole('button', { name: '저장', exact: true }).first().click();
    await page.waitForSelector('dialog.sheet');
    await shot(page, `save-${name}`);
    await page.locator('dialog.sheet #f-memo').fill('주행 80km/h, 오른쪽 뒤 윙 소리');
    await page.locator('dialog.sheet').getByRole('button', { name: '저장' }).click();
    await page.waitForSelector('#toast:not([hidden])');
    clearInterval(driving);
    await page.getByRole('button', { name: '일시정지' }).click();
    await page.waitForSelector('.analyzer[data-state="pause"]');
    await page.waitForTimeout(3000); // let the toast go
    await shot(page, `main-${name}-paused`);
    await page.evaluate(() => (location.hash = '#/history'));
    await page.waitForSelector('.record-row');
    await shot(page, `history-${name}`);
    await page.locator('.record-row').first().click();
    await page.waitForSelector('.stats-grid');
    await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
    await page.waitForTimeout(300);
    const speedMeta = await page.locator('.meta dt:has-text("속도") + dd').textContent();
    assert.match(speedMeta, /^평균 (7[6-9]|8[0-4]) km\/h · 최고 \d+ km\/h · 저장 순간 \d+ km\/h$/, speedMeta);
    await shot(page, `record-${name}`);
    await page.locator('.audio-card').scrollIntoViewIfNeeded();
    await shot(page, `record-${name}-sound`);
    await page.context().close();
  }

  // file analysis screenshots with the 20 s demo recording
  const demo = path.join(tmp, 'demo.wav');
  writeDemoFile(demo);
  const demoFile = { name: '주행 녹음 예시.wav', mimeType: 'audio/wav', buffer: fs.readFileSync(demo) };
  for (const [name, viewport] of [['portrait', { width: 390, height: 844 }], ['landscape', { width: 844, height: 390 }]]) {
    page = await newPage(browser, base, errors, { viewport, mic: false });
    await page.evaluate(() => (location.hash = '#/file'));
    await page.waitForSelector('#fa-drop');
    if (name === 'portrait') await shot(page, 'file-empty');
    await page.setInputFiles('#fa-input', demoFile);
    await page.waitForSelector('#fa-result .stats-grid', { timeout: 20000 });
    await page.waitForTimeout(400);
    await shot(page, `file-${name}`);
    await shot(page, `file-${name}-full`, true);
    await page.evaluate(() => document.querySelector('#fa-gram').scrollIntoView({ block: 'center' }));
    const gb = await page.locator('#fa-gram').boundingBox();
    await page.mouse.click(gb.x + gb.width / 2, gb.y + 8 + (gb.height - 30) * (1 - 9.5 / 20)); // the squeal, ~9.5 s
    await page.waitForTimeout(300);
    await page.locator('.fa-chart').scrollIntoViewIfNeeded();
    await shot(page, `file-${name}-seek`, true);
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
