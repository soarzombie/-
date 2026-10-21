import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  OCTAVES,
  aWeightDb,
  designAWeighting,
  sosMagnitude,
  analyserDbToPower,
  aWeightPower,
  bandPowers,
  zoneShares,
  findPeak,
  judge,
  toDb,
} from '../js/dsp.js';

// IEC 61672-1 A-weighting (dB) at the exact base-10 octave frequencies 1000 * 10^(0.3n).
const IEC_A = [
  [-5, -39.4], [-4, -26.2], [-3, -16.1], [-2, -8.6], [-1, -3.2],
  [0, 0], [1, 1.2], [2, 1.0], [3, -1.1],
];

test('analytic A-weighting matches the IEC table', () => {
  for (const [n, expected] of IEC_A) {
    const f = 1000 * 10 ** (0.3 * n);
    assert.ok(Math.abs(aWeightDb(f) - expected) < 0.1, `${f} Hz: ${aWeightDb(f)}`);
  }
});

for (const fs of [44100, 48000]) {
  test(`digital A-weighting filter tracks the analytic curve at ${fs} Hz`, () => {
    for (const f of [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
      const digital = 20 * Math.log10(sosMagnitude(designAWeighting(fs), f, fs));
      // IEC class 1 allows about +-1 dB up to 4 kHz and +1.5/-2.5 dB at 8 kHz.
      const tol = f <= 4000 ? 0.1 : 0.7;
      assert.ok(Math.abs(digital - aWeightDb(f)) < tol, `${f} Hz: digital ${digital.toFixed(2)} vs ${aWeightDb(f).toFixed(2)}`);
    }
  });
}

test('octave bands are contiguous and labelled with nominal centres', () => {
  assert.deepEqual(OCTAVES.map((b) => b.label), ['31.5', '63', '125', '250', '500', '1k', '2k', '4k', '8k']);
  for (let i = 1; i < OCTAVES.length; i++) assert.ok(Math.abs(OCTAVES[i].lo - OCTAVES[i - 1].hi) < 1e-9);
});

// Reference FFT mirroring the AnalyserNode spec: Blackman window, 1/N scaling, 20*log10|X|.
function analyserSpectrum(x) {
  const N = x.length;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let n = 0; n < N; n++) {
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / N) + 0.08 * Math.cos((4 * Math.PI * n) / N);
    re[n] = x[n] * w;
  }
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * wr - im[i + k + len / 2] * wi;
        const vi = re[i + k + len / 2] * wi + im[i + k + len / 2] * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
      }
    }
  }
  const out = new Float32Array(N / 2);
  for (let k = 0; k < N / 2; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / N);
  return out;
}

const sine = (f, amp, fs, N) => Float64Array.from({ length: N }, (_, n) => amp * Math.sin((2 * Math.PI * f * n) / fs));

test('analyser bins convert back to the true mean square and land in the right band', () => {
  const fs = 48000;
  const N = 8192;
  const amp = 0.25;
  const power = analyserDbToPower(analyserSpectrum(sine(1000, amp, fs, N)));
  const bands = bandPowers(power, fs / N);
  const total = bands.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(toDb(total) - toDb((amp * amp) / 2)) < 0.2, `total ${toDb(total)} dBFS`);
  assert.equal(bands.indexOf(Math.max(...bands)), 5); // 1 kHz band
});

test('A-weighting a 100 Hz tone lowers it by about 19 dB', () => {
  const fs = 48000;
  const N = 8192;
  const power = analyserDbToPower(analyserSpectrum(sine(100, 0.25, fs, N)));
  const z = bandPowers(power, fs / N).reduce((a, b) => a + b, 0);
  const a = bandPowers(aWeightPower(power, fs / N), fs / N).reduce((s, b) => s + b, 0);
  assert.ok(Math.abs(toDb(a) - toDb(z) - aWeightDb(100)) < 0.5);
});

test('findPeak locates a tone and rates it prominent over noise', () => {
  const fs = 48000;
  const N = 8192;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const x = sine(1250, 0.1, fs, N).map((v) => v + 0.01 * rand());
  const peak = findPeak(analyserDbToPower(analyserSpectrum(x)), fs / N);
  assert.ok(Math.abs(peak.hz - 1250) < 3, `peak at ${peak.hz}`);
  assert.ok(peak.prominence > 15, `prominence ${peak.prominence}`);

  // The app averages ~100 analyser frames per measurement; 16 is enough to tame noise variance.
  const avg = new Float64Array(N / 2);
  for (let frame = 0; frame < 16; frame++) {
    const p = analyserDbToPower(analyserSpectrum(Float64Array.from({ length: N }, () => 0.05 * rand())));
    for (let k = 0; k < avg.length; k++) avg[k] += p[k] / 16;
  }
  const flat = findPeak(avg, fs / N);
  assert.ok(flat.prominence < 6, `noise prominence ${flat.prominence}`);
});

test('zoneShares sums to 100 and follows band energy', () => {
  const shares = zoneShares([1, 1, 1, 0, 0, 0, 0, 0, 3]);
  assert.equal(shares.low + shares.mid + shares.high, 100);
  assert.equal(shares.low, 50);
  assert.equal(shares.high, 50);
  assert.deepEqual(zoneShares([0, 0, 0, 0, 0, 0, 0, 0, 0]), { low: 0, mid: 0, high: 0 });
});

test('judge compares the rounded value with the criteria', () => {
  assert.equal(judge(74.94, 75, 80), 'ok');
  assert.equal(judge(74.96, 75, 80), 'warn');
  assert.equal(judge(80.0, 75, 80), 'warn');
  assert.equal(judge(80.06, 75, 80), 'over');
  assert.equal(judge(70, null, null), 'none');
  assert.equal(judge(NaN, 75, 80), 'none');
});

test('worklet reports Leq and Fast max that match the input tone', () => {
  const fs = 48000;
  const messages = [];
  let Processor;
  const context = {
    sampleRate: fs,
    AudioWorkletProcessor: class {
      constructor() {
        this.port = { postMessage: (m) => messages.push(m) };
      }
    },
    registerProcessor: (_name, cls) => (Processor = cls),
  };
  vm.runInNewContext(readFileSync(new URL('../js/level-processor.js', import.meta.url), 'utf8'), context);
  const proc = new Processor({ processorOptions: { sos: designAWeighting(fs) } });

  const amp = 0.2;
  const f = 1000;
  for (let block = 0; block < fs / 128; block++) {
    const buf = new Float32Array(128);
    for (let i = 0; i < 128; i++) buf[i] = amp * Math.sin((2 * Math.PI * f * (block * 128 + i)) / fs);
    proc.process([[buf]]);
  }
  const settled = messages.slice(10); // skip filter and detector start-up
  const n = settled.reduce((s, m) => s + m.n, 0);
  const leqA = toDb(settled.reduce((s, m) => s + m.sumA, 0) / n);
  const leqZ = toDb(settled.reduce((s, m) => s + m.sumZ, 0) / n);
  const expected = toDb((amp * amp) / 2);
  assert.ok(Math.abs(leqA - expected) < 0.05, `LAeq ${leqA} vs ${expected}`);
  assert.ok(Math.abs(leqZ - expected) < 0.05);
  const fastMax = toDb(Math.max(...settled.map((m) => m.fastMax)));
  assert.ok(Math.abs(fastMax - expected) < 0.2, `LAFmax ${fastMax}`);
  assert.ok(Math.abs(settled[0].peak - amp) < 0.01);
});
