import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  aWeightDb,
  designAWeighting,
  sosMagnitude,
  binLevelTable,
  binLevels,
  totalLevel,
  rangeIndex,
  reduceRanges,
  logGrid,
  findPeaks,
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

const noise = (seed, n, amp) => {
  let x = seed;
  return Float64Array.from({ length: n }, () => amp * (((x = (x * 16807) % 2147483647) / 2147483647) * 2 - 1));
};

test('per-bin dB(A) levels add up to the true A-weighted level of a tone', () => {
  const fs = 48000;
  const N = 4096;
  for (const [f, amp] of [[1000, 0.25], [100, 0.5], [4000, 0.1]]) {
    const levels = binLevels(analyserSpectrum(sine(f, amp, fs, N)), binLevelTable(N / 2, fs / N), 100);
    const expected = toDb((amp * amp) / 2, 100) + aWeightDb(f);
    assert.ok(Math.abs(totalLevel(levels) - expected) < 0.3, `${f} Hz: ${totalLevel(levels).toFixed(2)} vs ${expected.toFixed(2)}`);
  }
});

test('findPeaks returns the two tones in noise, loudest first, with accurate frequencies', () => {
  const fs = 48000;
  const N = 8192;
  const n = noise(7, N, 0.01);
  const x = sine(1250, 0.1, fs, N).map((v, i) => v + 0.04 * Math.sin((2 * Math.PI * 3150 * i) / fs) + n[i]);
  const levels = binLevels(analyserSpectrum(x), binLevelTable(N / 2, fs / N), 0);
  const peaks = findPeaks(levels, fs / N, { count: 2 });
  assert.equal(peaks.length, 2);
  assert.ok(Math.abs(peaks[0].hz - 1250) < 2, `first ${peaks[0].hz}`);
  assert.ok(Math.abs(peaks[1].hz - 3150) < 2, `second ${peaks[1].hz}`);
});

test('findPeaks finds a low-frequency tone where a third octave spans only a few bins', () => {
  const fs = 48000;
  const N = 4096; // 11.7 Hz bins: 100 Hz +-1/3 octave is about 4 bins
  const n = noise(11, N, 0.002);
  const levels = binLevels(analyserSpectrum(sine(100, 0.5, fs, N).map((v, i) => v + n[i])), binLevelTable(N / 2, fs / N), 0);
  const [peak] = findPeaks(levels, fs / N, { count: 2 });
  assert.ok(peak && Math.abs(peak.hz - 100) < 3, `peak ${peak?.hz}`);
});

test('findPeaks finds nothing prominent in averaged broadband noise', () => {
  const fs = 48000;
  const N = 4096;
  const table = binLevelTable(N / 2, fs / N);
  const pow = new Float64Array(N / 2);
  for (let frame = 0; frame < 32; frame++) {
    const l = binLevels(analyserSpectrum(noise(frame + 3, N, 0.05)), table, 0);
    l.forEach((v, k) => (pow[k] += 10 ** (v / 10) / 32));
  }
  const avg = Float32Array.from(pow, (p) => 10 * Math.log10(p));
  assert.deepEqual(findPeaks(avg, fs / N, { count: 2 }), []);
});

test('reduceRanges keeps the loudest point per range and interpolates where a range is empty', () => {
  const freqs = Float32Array.from([10, 20, 30, 40, 50, 60]);
  const levels = Float32Array.from([1, 5, 2, 8, 3, 0]);
  const edges = Float32Array.from([10, 35, 36, 61]);
  const centres = Float32Array.from([22, 35.5, 50]);
  const out = reduceRanges(levels, freqs, rangeIndex(freqs, edges), centres);
  [5, 2 + (8 - 2) * 0.55, 8].forEach((v, i) => assert.ok(Math.abs(out[i] - v) < 1e-5, `range ${i}: ${out[i]}`));
  // past the last point there is no data
  const beyond = reduceRanges(levels, freqs, rangeIndex(freqs, Float32Array.from([70, 80, 90])), Float32Array.from([75, 85]));
  assert.deepEqual(Array.from(beyond), [-Infinity, -Infinity]);
});

test('logGrid points run exactly from 20 Hz to 20 kHz with edges halfway between', () => {
  const { centres, edges } = logGrid(241, 20, 20000);
  assert.equal(centres.length, 241);
  assert.equal(edges.length, 242);
  assert.ok(Math.abs(centres[0] - 20) < 1e-3 && Math.abs(centres[240] - 20000) < 0.5);
  for (const i of [1, 120, 240]) assert.ok(Math.abs(edges[i] - Math.sqrt(centres[i - 1] * centres[i])) / edges[i] < 1e-5);
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
  const fastMin = toDb(Math.min(...settled.map((m) => m.fastMin)));
  assert.ok(Math.abs(fastMax - expected) < 0.2, `LAFmax ${fastMax}`);
  assert.ok(Math.abs(fastMin - expected) < 0.2, `LAFmin ${fastMin}`);
  assert.ok(Math.abs(settled[0].peak - amp) < 0.01);
});
