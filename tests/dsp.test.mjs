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
  newHolds,
  updateHolds,
  tauOf,
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
import { freqAxis, freqTicks, freqToX, xToFreq, checkFreqRange, checkDbRange } from '../js/spectrum.js';
import { PRESETS, PRESET_KEYS, choosePreset, customize, presetOf } from '../js/presets.js';
import { micProfile, saveMicProfile, parseCalFile, calCorrection } from '../js/mics.js';
import { Meter } from '../js/meter.js';

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
  const dump = (max) => {
    proc.port.onmessage({ data: { type: 'dump', id: 'x', max } });
    return messages.filter((m) => m.type === 'audio').at(-1).samples;
  };
  feed(200);
  assert.equal(dump().length, 200);
  feed(500);
  const last = dump();
  assert.equal(last.length, 300);
  assert.ok(Math.abs(last[0] - 400 / 10000) < 1e-6 && Math.abs(last[299] - 699 / 10000) < 1e-6);
  const tail = dump(120); // only the last 120 samples
  assert.ok(tail.length === 120 && Math.abs(tail[0] - 580 / 10000) < 1e-6 && Math.abs(tail[119] - 699 / 10000) < 1e-6);
  assert.equal(dump(1000).length, 300, 'no more than is buffered');
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
  for (const i of [50, 200, 350]) assert.ok(r.min[i] <= r.avg[i] + 1e-4 && r.avg[i] <= r.max[i] + 1e-4, `min <= avg <= max at ${i}`);
  assert.ok(r.max[100] - r.min[100] > 20, 'a part with and a part without the 100 Hz tone');
});

test('third-octave bands run 10 Hz – 20 kHz and sum the bins that fall in them', () => {
  assert.equal(BANDS.length, 34);
  assert.equal(BANDS[0].label, '10');
  assert.equal(BANDS[20].label, '1k');
  assert.equal(BANDS.at(-1).label, '20k');
  assert.ok(Math.abs(BANDS[20].exact - 1000) < 1e-9);
  assert.ok(Math.abs(BANDS[0].exact - 9.84) < 0.01, 'nominal 10 Hz is the base-2 9.84 Hz');
  assert.deepEqual(BANDS.filter((b) => b.low).map((b) => b.label), ['10', '12.5', '16'], 'under 20 Hz: a guide only');
  for (let i = 1; i < BANDS.length; i++) assert.ok(Math.abs(BANDS[i].lo - BANDS[i - 1].hi) < 1e-9, 'bands touch');
  assert.deepEqual(Array.from(bandIndex(Float32Array.from([5, 10, 25, 1000, 1100, 20000, 23000]))), [-1, 0, 4, 20, 20, 33, -1]);
  const idx = Int16Array.from([-1, 3, 3, 4]);
  const out = bandLevels(Float32Array.from([90, 60, 60, -Infinity]), idx, 5);
  assert.ok(Math.abs(out[3] - (60 + 10 * Math.log10(2))) < 1e-4);
  assert.equal(out[4], -Infinity);
  assert.equal(out[0], -Infinity);
});

test('band levels of a tone equal the tone level, with the 32768-point analyser of the octave view', () => {
  const fs = 48000;
  const N = 32768;
  const levels = binLevels(analyserSpectrum(sine(1000, 0.25, fs, N)), binLevelTable(N / 2, fs / N), 100);
  const freqs = Float32Array.from({ length: N / 2 }, (_, k) => (k * fs) / N);
  const bands = bandLevels(levels, bandIndex(freqs));
  const expected = toDb(0.25 ** 2 / 2, 100);
  assert.ok(Math.abs(bands[20] - expected) < 0.3, `1 kHz band ${bands[20]} vs ${expected}`);
  assert.ok(bands[17] < expected - 60 && bands[23] < expected - 60, 'neighbouring bands are quiet');
  assert.ok(BANDS.every((_, b) => Number.isFinite(bands[b])), 'every band, 10 Hz too, has bins at 1.46 Hz resolution');
  for (const rate of [44100, 48000]) {
    const idx = bandIndex(Float32Array.from({ length: N / 2 }, (_, k) => (k * rate) / N));
    assert.ok(idx.includes(0), `the 10 Hz band has a bin at ${rate} Hz`);
  }
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

test('holds: peak and minimum hold keep the extremes, tracking curves drift back at 12 dB/s', () => {
  const h = newHolds(3);
  updateHolds(h, Float32Array.from([0, 60, 40]), 0.1);
  assert.deepEqual([h.max[1], h.min[1], h.maxTrack[1], h.minTrack[1]], [60, 60, 60, 60]);
  assert.equal(h.max[0], -Infinity, 'DC left alone');
  updateHolds(h, Float32Array.from([0, 30, 70]), 0.5); // bin 1 drops 30 dB, bin 2 rises 30 dB
  assert.equal(h.max[1], 60);
  assert.equal(h.min[1], 30);
  assert.ok(Math.abs(h.maxTrack[1] - 54) < 1e-5, `max tracking falls 6 dB in 0.5 s: ${h.maxTrack[1]}`);
  assert.equal(h.minTrack[1], 30, 'min tracking follows a drop at once');
  assert.equal(h.maxTrack[2], 70, 'max tracking follows a rise at once');
  assert.ok(Math.abs(h.minTrack[2] - 46) < 1e-5, `min tracking rises 6 dB in 0.5 s: ${h.minTrack[2]}`);
  for (let i = 0; i < 10; i++) updateHolds(h, Float32Array.from([0, 30, 70]), 0.5);
  assert.equal(h.maxTrack[1], 30, 'max tracking comes down to the level');
  assert.equal(h.minTrack[2], 70, 'min tracking comes up to the level');
  assert.equal(h.max[1], 60, 'peak hold stays');
  assert.equal(h.min[2], 40, 'minimum hold stays');
});

test('measurement situations: choosing one sets all its values, 사용자 지정 comes back as it was', () => {
  const mine = { preset: 'custom', custom: null, weighting: 'C', fftSize: 2048, style: 'bar', scale: 'linear', peakHold: false, minHold: false, maxTrack: false, minTrack: true, traceSec: 30, view: 'gram' };
  for (const p of PRESETS) assert.deepEqual(Object.keys(p.values).sort(), [...PRESET_KEYS].sort(), `${p.name} sets every key`);
  // custom -> idle: idle values, and the own mix is kept
  let st = { ...mine, ...choosePreset(mine, 'idle') };
  assert.equal(st.preset, 'idle');
  assert.deepEqual([st.weighting, st.fftSize, st.style, st.minHold, st.traceSec], ['A', 16384, 'line', true, 60]);
  assert.equal(st.view, 'gram', 'the view is not part of a situation');
  assert.equal(st.custom.style, 'bar');
  // idle -> drive keeps the same remembered mix
  st = { ...st, ...choosePreset(st, 'drive') };
  assert.deepEqual([st.preset, st.fftSize, st.maxTrack, st.traceSec, st.custom.fftSize], ['drive', 4096, true, 300, 2048]);
  // back to custom: exactly the own mix
  st = { ...st, ...choosePreset(st, 'custom') };
  assert.equal(st.preset, 'custom');
  for (const k of PRESET_KEYS) assert.equal(st[k], mine[k], k);
  // a change by hand while a situation is chosen makes it 사용자 지정, other changes do not
  const idle = { ...mine, ...choosePreset(mine, 'idle') };
  assert.deepEqual(customize(idle, { style: 'fill' }), { style: 'fill', preset: 'custom' });
  assert.deepEqual(customize(idle, { style: 'line' }), { style: 'line' }, 'same value: still 공회전');
  assert.deepEqual(customize(idle, { view: 'octave' }), { view: 'octave' });
  assert.deepEqual(customize(mine, { style: 'fill' }), { style: 'fill' });
  assert.equal(presetOf('nope').id, 'custom');
});

test('frequency axis over a chosen range: mapping, round trip and ticks', () => {
  const box = { x0: 30, x1: 330 };
  assert.deepEqual(freqTicks(freqAxis('log')), [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000], 'whole range as before');
  const low = freqAxis('log', 20, 500);
  assert.equal(freqToX(20, box, low), 30);
  assert.equal(freqToX(500, box, low), 330);
  assert.ok(Math.abs(freqToX(100, box, low) - (30 + 300 * Math.log(5) / Math.log(25))) < 1e-9);
  for (const f of [31.5, 125, 400]) assert.ok(Math.abs(xToFreq(freqToX(f, box, low), box, low) - f) < 1e-6);
  assert.deepEqual(freqTicks(low), [20, 50, 100, 200, 500]);
  // narrow log range and linear ranges get round steps inside the range
  const narrow = freqTicks(freqAxis('log', 500, 2000), 300);
  assert.ok(narrow.length >= 3 && narrow.every((f) => f >= 500 && f <= 2000) && narrow.includes(1000), `narrow ${narrow}`);
  const lin = freqAxis('linear');
  assert.equal(lin.a, 0, 'whole linear axis starts at 0 Hz');
  assert.deepEqual(freqTicks(lin, 300), [0, 5000, 10000, 15000, 20000]);
  const lin2 = freqAxis('linear', 1000, 3000);
  assert.equal(freqToX(2000, box, lin2), 180);
  assert.ok(freqTicks(lin2, 300).every((f) => f >= 1000 && f <= 3000));
  // what the settings accept
  assert.deepEqual(checkFreqRange(20, 500), [20, 500]);
  assert.equal(typeof checkFreqRange(3000, 1000), 'string');
  assert.equal(typeof checkFreqRange(5, 1000), 'string');
  assert.equal(typeof checkFreqRange(100, 30000), 'string');
  assert.deepEqual(checkDbRange(-20, 100), [-20, 100]);
  assert.equal(typeof checkDbRange(50, 55), 'string');
  assert.equal(typeof checkDbRange(NaN, 80), 'string');
});

test('Slow time weighting (1 s) rises slower than Fast (125 ms), in levelHistory and the worklet', () => {
  const fs = 48000;
  // 1 s of silence, then a steady 1 kHz tone
  const x = new Float64Array(3 * fs);
  for (let i = fs; i < x.length; i++) x[i] = 0.2 * Math.sin((2 * Math.PI * 1000 * i) / fs);
  const steady = toDb(0.02, 100);
  const fast = levelHistory(x, fs, 100, 0.05, 'A', tauOf('F'));
  const slow = levelHistory(x, fs, 100, 0.05, 'A', tauOf('S'));
  const at = (r, t) => r.history[Math.round(t / r.step) - 1];
  // 0.25 s after the start: Fast is nearly there (1 - e^-2 -> -0.6 dB), Slow is not (1 - e^-0.25 -> -6.5 dB)
  assert.ok(Math.abs(at(fast, 1.25) - (steady + 10 * Math.log10(1 - Math.exp(-2)))) < 0.4, `Fast ${at(fast, 1.25)}`);
  assert.ok(Math.abs(at(slow, 1.25) - (steady + 10 * Math.log10(1 - Math.exp(-0.25)))) < 0.4, `Slow ${at(slow, 1.25)}`);
  assert.ok(Math.abs(at(slow, 3) - (steady + 10 * Math.log10(1 - Math.exp(-2)))) < 0.3, `Slow 2 s after the start: ${at(slow, 3)}`);
  assert.equal(tauOf('X'), 0.125, 'unknown -> Fast');

  // the worklet switches on a 'tau' message
  const { Processor, messages } = loadWorklet(fs);
  const proc = new Processor({ processorOptions: { sos: [], tau: tauOf('S') } });
  const feed = (sec, amp) => {
    for (let b = 0; b < (sec * fs) / 128; b++) proc.process([[Float32Array.from({ length: 128 }, (_, i) => amp * Math.sin((2 * Math.PI * 1000 * (b * 128 + i)) / fs))]]);
  };
  feed(0.25, 0.2);
  const slowLevel = toDb(messages.at(-1).fast);
  proc.port.onmessage({ data: { type: 'tau', tau: tauOf('F') } });
  feed(0.5, 0.2); // from where Slow had got to, Fast is within 0.1 dB after 4 time constants
  const fastLevel = toDb(messages.at(-1).fast);
  const target = toDb(0.02);
  assert.ok(slowLevel < target - 5, `Slow still rising after 0.25 s: ${slowLevel}`);
  assert.ok(Math.abs(fastLevel - target) < 0.3, `Fast settles: ${fastLevel}`);
});

test('microphone calibration files: miniDSP, Dayton/REW style and bad files', () => {
  const umik = ['"Sens Factor =-1.007dB, SERNO: 7090123"', '10.054\t-6.20', '20.0\t-1.50\t12.3', '100\t-0.20', '1000\t0.00', '10000\t0.80', '20000\t-2.40'].join('\r\n');
  const u = parseCalFile(umik);
  assert.equal(u.points.length, 6);
  assert.equal(u.sensFactor, -1.007);
  assert.equal(u.serial, '7090123');
  assert.deepEqual(u.points[1], [20, -1.5], 'phase column ignored');
  const rew = ['* Dayton Audio iMM-6C  Serial 123-4567', '* freq(Hz)  dB  phase', '20000, 1.1, 0', '5000, 0.4, 0', '1000, 0, 0', '200, 0.1, 0', '50, -0.9, 0', '18, -3.0, 0'].join('\n');
  const r = parseCalFile(rew);
  assert.equal(r.points[0][0], 18, 'sorted by frequency');
  assert.equal(r.serial, '123-4567');
  assert.equal(r.sens1k, null);
  // Dayton iMM-6C: "*1000Hz -40.3" (sensitivity, dB re 1 V/Pa) then tab-separated rows relative to 1 kHz
  const dayton = ['*1000Hz\t-40.3', '10.0\t-2.31\t25.1', '20.0\t-0.95\t11.0', '100.0\t-0.05\t1.2', '1000.0\t0.00\t0.0', '10000.0\t1.42\t-8.0', '20000.0\t3.10\t-20.4'].join('\r\n');
  const d = parseCalFile(dayton);
  assert.equal(d.points.length, 6, 'the sensitivity line is not a point');
  assert.equal(d.sens1k, -40.3);
  assert.deepEqual(d.points[0], [10, -2.31]);
  // the same microphone written as absolute sensitivity on every line: made relative to 1 kHz
  const absolute = parseCalFile(d.points.map(([f, db]) => `${f} ${(db - 40.3).toFixed(2)}`).join('\n'));
  assert.equal(absolute.sens1k, -40.3);
  absolute.points.forEach(([f, db], i) => assert.ok(f === d.points[i][0] && Math.abs(db - d.points[i][1]) < 1e-9, `relative at ${f} Hz`));
  assert.throws(() => parseCalFile('hello\nworld'), /찾지 못했습니다/);
  assert.throws(() => parseCalFile(['1000 0', '1100 0', '1200 0', '1300 0', '1400 0'].join('\n')), /좁습니다/);
  assert.throws(() => parseCalFile(['10 -90', '100 0', '1000 0', '5000 0', '20000 0'].join('\n')), /이상합니다/);
  // correction: minus the response, log-interpolated, held at the ends
  const corr = calCorrection(u.points);
  assert.ok(Math.abs(corr(1000)) < 1e-9);
  assert.ok(Math.abs(corr(20) - 1.5) < 1e-9);
  assert.ok(Math.abs(corr(Math.sqrt(20 * 100)) - (1.5 + 0.2) / 2) < 1e-9, 'halfway on a log scale');
  assert.ok(Math.abs(corr(5) - 6.2) < 1e-9 && Math.abs(corr(24000) - 2.4) < 1e-9);
  assert.equal(calCorrection(null), null);
  // the spectrum table carries it
  const t0 = binLevelTable(100, 10);
  const t1 = binLevelTable(100, 10, 'A', calCorrection(u.points));
  assert.ok(Math.abs(t1[2] - t0[2] - 1.5) < 1e-4, '20 Hz bin raised by 1.5 dB');
});

test('microphone profiles: the phone mic keeps the old offset, others start uncalibrated', () => {
  const st = { offset: 103, calibratedAt: 1700000000000, baseMic: 'iPhone 마이크', mics: {} };
  assert.deepEqual([micProfile(st, 'iPhone 마이크').offset, !!micProfile(st, 'iPhone 마이크').calibratedAt], [103, true]);
  assert.deepEqual([micProfile(st, '').offset, micProfile(st, '').known], [103, true]);
  const ext = micProfile(st, 'iMM-6C');
  assert.deepEqual([ext.offset, ext.calibratedAt, ext.known], [103, null, false], 'external: starts from the phone offset, not calibrated');
  const p1 = saveMicProfile(st, 'iMM-6C', { offset: 118.4, calibratedAt: 1, calName: 'imm.txt' });
  assert.equal(p1.offset, undefined, 'the phone offset is untouched');
  const st2 = { ...st, ...p1 };
  assert.deepEqual([micProfile(st2, 'iMM-6C').offset, micProfile(st2, 'iMM-6C').calName, micProfile(st2, 'iPhone 마이크').offset], [118.4, 'imm.txt', 103]);
  const p2 = saveMicProfile(st2, 'iPhone 마이크', { offset: 101, calibratedAt: 2 });
  assert.deepEqual([p2.offset, p2.calibratedAt, p2.mics['iMM-6C'].offset], [101, 2, 118.4], 'the phone mic also updates the old fields');
});

test('timed measurement: the meter counts exactly N seconds after the warm-up, then pauses itself', () => {
  const m = new Meter(100); // no audio context here: 48 kHz, blocks fed by hand as the worklet posts them
  const posted = [];
  m.node = { port: { postMessage: (msg) => posted.push(msg) } };
  const block = { n: 2400, sumA: 2400 * 0.01, sumZ: 0, fast: 0.01, fastMax: 0.01, fastMin: 0.01, peak: 0.2 };
  let done = 0;
  m.measureFor(5, () => done++);
  assert.ok(m.timed);
  for (let i = 0; i < 10 + 5 * 20 - 1; i++) m.handleBlock(block); // 0.5 s warm-up, then 4.95 s
  assert.equal(done, 0);
  assert.ok(Math.abs(m.elapsed - 4.95) < 1e-9);
  m.handleBlock(block);
  assert.equal(done, 1, 'done once, at 5 s');
  assert.equal(m.elapsed, 5);
  assert.ok(m.paused && !m.timed);
  assert.deepEqual(posted.at(-1), { type: 'pause', paused: true }, 'the worklet holds the sound buffer still');
  for (let i = 0; i < 20; i++) m.handleBlock(block);
  assert.equal(m.elapsed, 5, 'nothing more is counted while paused');
  assert.ok(Math.abs(m.leq - 80) < 1e-9);
  // cancelled: measuring just goes on
  m.paused = false;
  m.resetStats();
  m.measureFor(1, () => done++);
  m.cancelTimed();
  for (let i = 0; i < 40; i++) m.handleBlock(block);
  assert.equal(done, 1);
  assert.ok(!m.paused && m.elapsed > 1);
});
