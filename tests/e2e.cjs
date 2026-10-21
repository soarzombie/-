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

// Screen point of a frequency on the spectrum, using the chart's own layout rules.
async function tapFrequency(page, hz) {
  const host = page.locator('#a-chart');
  const r = await host.boundingBox();
  const w = Math.floor(r.width);
  const k = w < 360 ? 0.92 : 1;
  const x0 = 30 * k;
  const x1 = w - 6 * k;
  const x = x0 + (Math.log(hz / 20) / Math.log(1000)) * (x1 - x0);
  await page.mouse.click(r.x + x, r.y + r.height / 2);
}

const num = async (page, sel) => parseFloat((await page.locator(sel).textContent()).replace(/[^\d.-]/g, ''));
const running = (page) => page.waitForSelector('.analyzer[data-state="run"]');

async function setMode(page, mode) {
  await page.locator(`.mode[data-mode=${mode}]`).click();
  assert.equal(await page.locator('.an-chart').getAttribute('data-view'), mode);
  assert.equal(await page.locator(`.mode[data-mode=${mode}]`).getAttribute('aria-pressed'), 'true');
}

// Graph settings sheet: pick values by key, e.g. { style: 'line', fft: '8192' }.
async function chartSettings(page, picks, shotName) {
  await page.getByRole('button', { name: '그래프 설정' }).click();
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

  // cursors: A at 1 kHz reads the tone, B adds the difference, x clears
  await tapFrequency(page, 1000);
  await page.waitForSelector('#a-cursor:not([hidden])');
  const aText = await page.locator('#a-cursor .cr-lines span').first().textContent();
  const [aHz, aDb] = aText.replace(/,/g, '').match(/[\d.]+/g).map(Number); // "A 1,000 Hz 74.4"

  console.log(`cursor A: ${aText}`);
  assert.ok(Math.abs(aHz - 1000) / 1000 < 0.03, 'cursor frequency');
  assert.ok(aDb > 60, 'cursor reads the tone level');
  await tapFrequency(page, 5000);
  await page.waitForSelector('#a-cursor .cr-diff');
  await shot(page, 'cursor');
  await page.locator('#a-cursor .cr-close').click();
  await page.waitForSelector('#a-cursor', { state: 'hidden' });

  // views: time axis, both, 1/3 octave, gauge, back to the spectrum; each shows its own drawing
  await setMode(page, 'gram');
  await page.waitForTimeout(1500);
  assert.ok(await page.locator('#a-gram canvas').isVisible() && !(await page.locator('#a-chart canvas').isVisible()));
  await setMode(page, 'both');
  assert.ok(await page.locator('#a-gram canvas').isVisible() && (await page.locator('#a-chart canvas').isVisible()));
  await setMode(page, 'octave');
  await page.waitForTimeout(1500);
  assert.ok(await page.locator('#a-octave canvas').isVisible());
  await shot(page, 'tone-octave');
  await setMode(page, 'gauge');
  assert.ok(await page.locator('#a-gauge svg').isVisible());
  await setMode(page, 'spectrum');
  assert.match(await page.locator('#a-mode-name').textContent(), /스펙트럼/);

  // graph settings: style, max hold, FFT size, axis
  await chartSettings(page, { style: 'line', hold: 'off', fft: '8192', scale: 'linear' });
  await page.waitForTimeout(800);
  await shot(page, 'tone-linear');
  await chartSettings(page, { style: 'fill', hold: 'on', fft: '4096', scale: 'log' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('noise-meter:settings:v1')));
  assert.deepEqual([saved.style, saved.hold, saved.fftSize, saved.scale, saved.view], ['fill', true, 4096, 'log', 'spectrum']);

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
      all.onsuccess = () => resolve([all.result[0].spectrum.freqs[0], all.result[0].spectrum.freqs.at(-1)]);
    };
  }));
  assert.deepEqual(span, [20, 20000], 'saved spectrum spans 20 Hz – 20 kHz');
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
    assert.equal(await page.locator('#a-weight').textContent(), `${w}특성`);
    await page.waitForTimeout(1800);
    const v = await num(page, '#a-now');
    const leq = await num(page, '#a-leq');
    console.log(`100 Hz ${w}: now ${v}, avg ${leq} dB(${w}), expected ${toneDb(0.5, weight).toFixed(1)}`);
    assert.ok(Math.abs(v - toneDb(0.5, weight)) < 0.6, `${w}-weighted level`);
    assert.ok(Math.abs(leq - toneDb(0.5, weight)) < 0.6, `${w}-weighted average starts again`);
  }

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
  assert.match(await page.locator('#fa-cur-label').textContent(), /재생 위치/);
  await page.getByRole('button', { name: '기록에 저장' }).click();
  await page.locator('dialog.sheet').getByRole('button', { name: '저장' }).click();
  await page.waitForSelector('#toast:not([hidden])');
  await page.locator('.tabbar a[data-tab=history]').click();
  await page.locator('.record-row').first().click();
  await page.waitForSelector('#rec-gram-wait', { state: 'detached', timeout: 10000 });
  assert.match(await page.locator('.rec-head h1').textContent(), /두 구간 시험음/);
  assert.ok(Math.abs((await num(page, '.stats-grid div:first-child b')) - fileLeq) < 0.3, 'saved file Leq');
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
    await tapFrequency(page, 1250);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-live`);
    await page.locator('#a-cursor .cr-close').click();
    await setMode(page, 'gram');
    await page.waitForTimeout(3500);
    await shot(page, `main-${name}-gram`);
    await setMode(page, 'both');
    await chartSettings(page, { style: 'line' });
    await page.waitForTimeout(2500);
    await tapFrequency(page, 1250);
    await tapFrequency(page, 125);
    await page.waitForTimeout(300);
    await shot(page, `main-${name}-both`);
    await page.locator('#a-cursor .cr-close').click();
    await chartSettings(page, { style: 'fill' });
    await setMode(page, 'octave');
    await page.waitForTimeout(2500);
    await shot(page, `main-${name}-octave`);
    await setMode(page, 'gauge');
    await page.waitForTimeout(500);
    await shot(page, `main-${name}-gauge`);
    await setMode(page, 'spectrum');
    await page.getByRole('button', { name: '그래프 설정' }).click();
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
