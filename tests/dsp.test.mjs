import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  aWeightDb,
  cWeightDb,
  weightDb,
  designAWeighting,
  designWeighting,
  BANDS,
  bandIndex,
  bandLevels,
  sosMagnitude,
  binLevelTable,
  binLevels,
  totalLevel,
  rangeIndex,
  reduceRanges,
  logGrid,
  findPeaks,
  stft,
  levelHistory,
  toDb,
} from '../js/dsp.js';
import { analyzeSound, frameAt } from '../js/analysis.js';
import { encodeWav, decodeWav } from '../js/audio.js';
import { columnRange } from '../js/timeline.js';

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

// IEC 61672-1 C-weighting at the same frequencies.
const IEC_C = [
  [-5, -3.0], [-4, -0.8], [-3, -0.2], [-2, 0.0], [-1, 0.0],
  [0, 0], [1, -0.2], [2, -0.8], [3, -3.0],
];

test('analytic C-weighting matches the IEC table; Z is flat', () => {
  for (const [n, expected] of IEC_C) {
    const f = 1000 * 10 ** (0.3 * n);
    assert.ok(Math.abs(cWeightDb(f) - expected) < 0.1, `${f} Hz: ${cWeightDb(f)}`);
    assert.equal(weightDb(f, 'Z'), 0);
    assert.equal(weightDb(f, 'C'), cWeightDb(f));
    assert.equal(weightDb(f), aWeightDb(f));
  }
  assert.deepEqual(designWeighting(48000, 'Z'), []);
});

for (const fs of [44100, 48000]) {
  test(`digital C-weighting filter tracks the analytic curve at ${fs} Hz`, () => {
    for (const f of [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000]) {
      const digital = 20 * Math.log10(sosMagnitude(designWeighting(fs, 'C'), f, fs));
      const tol = f <= 4000 ? 0.1 : 0.7;
      assert.ok(Math.abs(digital - cWeightDb(f)) < tol, `${f} Hz: digital ${digital.toFixed(2)} vs ${cWeightDb(f).toFixed(2)}`);
    }
  });

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

test('stft frames match the analyser convention used live', () => {
  const fs = 48000;
  const N = 2048;
  const x = sine(1500, 0.3, fs, N * 3).map((v, i) => v + 0.05 * Math.sin((2 * Math.PI * 300 * i) / fs));
  const { frames, binHz, hopSec } = stft(x, fs, N, N / 2);
  assert.equal(frames.length, 5);
  assert.equal(binHz, fs / N);
  assert.ok(Math.abs(hopSec - N / 2 / fs) < 1e-12);
  const ref = analyserSpectrum(x.slice(N, 2 * N));
  for (const k of [5, 13, 64, 300]) assert.ok(Math.abs(frames[2][k] - ref[k]) < 1e-6, `bin ${k}`);
});

test('WAV encode/decode keeps the samples to 16-bit precision', async () => {
  const x = Float32Array.from({ length: 4800 }, (_, i) => 0.8 * Math.sin(i / 7));
  const blob = encodeWav(x, 48000);
  assert.equal(blob.size, 44 + 4800 * 2);
  assert.equal(blob.type, 'audio/wav');
  const { samples, rate } = await decodeWav(blob);
  assert.equal(rate, 48000);
  assert.equal(samples.length, 4800);
  for (let i = 0; i < x.length; i += 97) assert.ok(Math.abs(samples[i] - x[i]) < 1 / 16000);
});

test('worklet keeps the last ringSec seconds of sound, oldest first, and holds it while paused', () => {
  const fs = 1000;
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
  const proc = new Processor({ processorOptions: { sos: designAWeighting(48000), ringSec: 0.3 } }); // 300 samples
  let t = 0;
  const feed = (n) => {
    for (let b = 0; b < n / 100; b++) proc.process([[Float32Array.from({ length: 100 }, () => (t++) / 10000)]]);
  };
  const dump = () => {
    proc.port.onmessage({ data: { type: 'dump', id: 'x' } });
    return messages.filter((m) => m.type === 'audio').at(-1).samples;
  };
  feed(200);
  assert.equal(dump().length, 200);
  feed(500);
  const last = dump();
  assert.equal(last.length, 300);
  assert.ok(Math.abs(last[0] - 400 / 10000) < 1e-6 && Math.abs(last[299] - 699 / 10000) < 1e-6);
  proc.port.onmessage({ data: { type: 'pause', paused: true } });
  feed(200);
  assert.ok(Math.abs(dump()[299] - 699 / 10000) < 1e-6, 'paused: buffer unchanged');
  proc.port.onmessage({ data: { type: 'clear' } });
  assert.equal(dump().length, 0);
  assert.ok(messages.some((m) => m.type === 'level'));
});

test('levelHistory gives the same LAeq / LAFmax / LAFmin as the worklet for a steady tone', () => {
  const fs = 48000;
  const x = sine(1000, 0.2, fs, 2 * fs);
  const r = levelHistory(x, fs, 100, 0.1);
  const expected = toDb(0.02, 100);
  assert.ok(Math.abs(r.leq - expected) < 0.05, `Leq ${r.leq}`);
  assert.ok(Math.abs(r.lmax - expected) < 0.2 && Math.abs(r.lmin - expected) < 0.2, `max ${r.lmax} min ${r.lmin}`);
  assert.equal(r.history.length, 20);
  assert.ok(Math.abs(r.history[15] - expected) < 0.2);
  assert.ok(Math.abs(r.peak - 0.2) < 1e-3);
});

test('analyzeSound of a two-part file: energy-average Leq, max/min of the parts, peaks and per-time spectra', () => {
  const fs = 48000;
  const a1 = sine(1000, 0.1, fs, 3 * fs);
  const a2 = sine(100, 0.5, fs, 3 * fs);
  const x = new Float32Array(6 * fs);
  x.set(a1, 0);
  x.set(a2, 3 * fs);
  const r = analyzeSound(x, fs, 100);
  const l1 = toDb(0.005, 100); // 77.0 dB(A)
  const l2 = toDb(0.125, 100) + aWeightDb(100); // 71.8 dB(A)
  const leq = 10 * Math.log10((10 ** (l1 / 10) + 10 ** (l2 / 10)) / 2);
  assert.ok(Math.abs(r.duration - 6) < 1e-9);
  assert.ok(Math.abs(r.leq - leq) < 0.2, `Leq ${r.leq} vs ${leq}`);
  assert.ok(Math.abs(r.lmax - l1) < 0.3, `max ${r.lmax}`);
  assert.ok(Math.abs(r.lmin - l2) < 0.5, `min ${r.lmin}`);
  const hz = r.peaks.map((p) => p.hz).sort((a, b) => a - b);
  assert.ok(hz.some((f) => Math.abs(f - 100) < 4) && hz.some((f) => Math.abs(f - 1000) < 6), `peaks ${hz}`);
  const loudestAt = (frame) => r.freqs[frame.indexOf(Math.max(...frame))];
  assert.ok(Math.abs(loudestAt(frameAt(r, 1.5)) - 1000) < 40, 'early frame is the 1 kHz part');
  assert.ok(Math.abs(loudestAt(frameAt(r, 4.5)) - 100) < 8, 'late frame is the 100 Hz part');
  assert.ok(r.frames.length <= 1501 && r.frames[0].length === 400);
});

test('third-octave bands run 25 Hz – 20 kHz and sum the bins that fall in them', () => {
  assert.equal(BANDS.length, 30);
  assert.equal(BANDS[0].label, '25');
  assert.equal(BANDS[16].label, '1k');
  assert.equal(BANDS.at(-1).label, '20k');
  assert.ok(Math.abs(BANDS[16].exact - 1000) < 1e-9);
  for (let i = 1; i < BANDS.length; i++) assert.ok(Math.abs(BANDS[i].lo - BANDS[i - 1].hi) < 1e-9, 'bands touch');
  assert.deepEqual(Array.from(bandIndex(Float32Array.from([10, 25, 1000, 1100, 20000, 23000]))), [-1, 0, 16, 16, 29, -1]);
  const idx = Int16Array.from([-1, 3, 3, 4]);
  const out = bandLevels(Float32Array.from([90, 60, 60, -Infinity]), idx, 5);
  assert.ok(Math.abs(out[3] - (60 + 10 * Math.log10(2))) < 1e-4);
  assert.equal(out[4], -Infinity);
  assert.equal(out[0], -Infinity);
});

test('band levels of a tone equal the tone level, with a 16384-point analyser', () => {
  const fs = 48000;
  const N = 16384;
  const levels = binLevels(analyserSpectrum(sine(1000, 0.25, fs, N)), binLevelTable(N / 2, fs / N), 100);
  const freqs = Float32Array.from({ length: N / 2 }, (_, k) => (k * fs) / N);
  const bands = bandLevels(levels, bandIndex(freqs));
  const expected = toDb(0.25 ** 2 / 2, 100);
  assert.ok(Math.abs(bands[16] - expected) < 0.3, `1 kHz band ${bands[16]} vs ${expected}`);
  assert.ok(bands[13] < expected - 60 && bands[19] < expected - 60, 'neighbouring bands are quiet');
  assert.ok(BANDS.every((_, b) => Number.isFinite(bands[b])), 'every band has bins at 2.9 Hz resolution');
});

function loadWorklet(fs) {
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
  return { Processor, messages };
}

test('worklet switches weighting on an sos message', () => {
  const fs = 48000;
  const { Processor, messages } = loadWorklet(fs);
  const proc = new Processor({ processorOptions: { sos: designWeighting(fs, 'A') } });
  const amp = 0.5;
  let n0 = 0;
  const run = (sec) => {
    for (let block = 0; block < (sec * fs) / 128; block++, n0 += 128) {
      proc.process([[Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin((2 * Math.PI * 100 * (n0 + i)) / fs))]]);
    }
  };
  const levelOf = (list) => toDb(list.reduce((s, m) => s + m.sumA, 0) / list.reduce((s, m) => s + m.n, 0));
  const expected = toDb((amp * amp) / 2);
  run(1);
  assert.ok(Math.abs(levelOf(messages.slice(10)) - (expected + aWeightDb(100))) < 0.1, 'A');
  for (const [w, weight] of [['C', cWeightDb(100)], ['Z', 0]]) {
    proc.port.onmessage({ data: { type: 'sos', sos: designWeighting(fs, w) } });
    const from = messages.length + 10;
    run(1);
    assert.ok(Math.abs(levelOf(messages.slice(from)) - (expected + weight)) < 0.1, w);
  }
});

test('worklet streams the sound in chunks while recording, also while paused', () => {
  const fs = 1000; // chunks of 0.5 s = 500 samples
  const { Processor, messages } = loadWorklet(fs);
  const proc = new Processor({ processorOptions: { sos: [] } });
  let t = 0;
  const feed = (n) => {
    for (let b = 0; b < n / 100; b++) proc.process([[Float32Array.from({ length: 100 }, () => (t++) / 10000)]]);
  };
  const chunks = () => messages.filter((m) => m.type === 'chunk');
  feed(300);
  proc.port.onmessage({ data: { type: 'record', on: true } });
  feed(700);
  assert.equal(chunks().length, 1);
  assert.equal(chunks()[0].samples.length, 500);
  assert.ok(Math.abs(chunks()[0].samples[0] - 300 / 10000) < 1e-6, 'starts where recording started');
  // pausing the measurement holds the "save" buffer but not the recording
  proc.port.onmessage({ data: { type: 'pause', paused: true } });
  feed(400);
  proc.port.onmessage({ data: { type: 'pause', paused: false } });
  feed(100);
  proc.port.onmessage({ data: { type: 'record', on: false } });
  const all = chunks();
  assert.equal(all.length, 3);
  assert.equal(all[1].samples.length, 500);
  assert.equal(all[2].last, true);
  assert.equal(all[2].samples.length, 200);
  const joined = all.flatMap((c) => Array.from(c.samples));
  assert.equal(joined.length, 1200);
  joined.forEach((v, i) => assert.ok(Math.abs(v - (300 + i) / 10000) < 1e-6, `sample ${i} kept in order`));
  feed(600);
  assert.equal(chunks().length, 3, 'nothing after stop');
});

test('analyzeSound with C and Z weighting', () => {
  const fs = 48000;
  const x = sine(100, 0.5, fs, 2 * fs);
  for (const w of ['A', 'C', 'Z']) {
    const r = analyzeSound(x, fs, 100, { weighting: w });
    const expected = toDb(0.125, 100) + weightDb(100, w);
    assert.equal(r.weighting, w);
    assert.ok(Math.abs(r.leq - expected) < 0.2, `${w}: Leq ${r.leq} vs ${expected}`);
    const top = Math.max(...r.avg);
    assert.ok(top < expected && top > expected - 6, `${w}: spectrum peak ${top}`);
  }
});

test('columnRange gives the lowest and highest level per pixel column without gaps', () => {
  const values = Float32Array.from([50, 52, 70, 51, 49, 60, 55, 54, 53, 58]);
  const { lo, hi } = columnRange(values, 0, 10, 5); // 2 samples per column, plus the one before
  assert.deepEqual(Array.from(hi), [52, 70, 60, 60, 58]);
  assert.deepEqual(Array.from(lo), [50, 51, 49, 54, 53]);
  // every column overlaps the one before, so the strokes join up
  for (let c = 1; c < 5; c++) assert.ok(lo[c] <= hi[c - 1] && hi[c] >= lo[c - 1], `column ${c}`);
  const part = columnRange(values, 4, 10, 3);
  assert.deepEqual(Array.from(part.hi), [60, 60, 58]);
  assert.deepEqual(Array.from(part.lo), [49, 54, 53]);
});
