// Signal-processing helpers shared by the meter, the charts and the tests.
// Pure functions only (no DOM, no Web Audio) so they also run under Node.

// IEC 61672-1 A-weighting pole frequencies (Hz).
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;
const A1000 = 1.9997; // dB, makes the analytic curve 0 dB at 1 kHz
const C1000 = 0.0619;

// Time weightings of the level detector: Fast (125 ms, follows quick changes) and Slow (1 s, steadier).
export const TIME_WEIGHTINGS = { F: 0.125, S: 1 };
export const tauOf = (t = 'F') => TIME_WEIGHTINGS[t] || TIME_WEIGHTINGS.F;

// Frequency weightings: 'A' (default), 'C' (flatter, for loud and low sounds), 'Z' (none).
export const WEIGHTINGS = ['A', 'C', 'Z'];
export const unitOf = (w = 'A', digital = false) => `${digital ? 'dBFS' : 'dB'}(${w})`;

// FFT windows (창 함수), as cosine sums w[n] = a0 - a1 cos(2πn/N) + a2 cos(4πn/N). Blackman (alpha = 0.16)
// is the one the Web Audio AnalyserNode applies itself; the others are applied in meter.js.
export const FFT_WINDOWS = {
  hann: { name: 'Hanning', a: [0.5, 0.5, 0] },
  hamming: { name: 'Hamming', a: [0.54, 0.46, 0] },
  blackman: { name: 'Blackman', a: [0.42, 0.5, 0.08] },
};
const windowSpec = (kind) => FFT_WINDOWS[kind] || FFT_WINDOWS.blackman;

// Mean of w[n]^2 for a window.
export const windowPower = (kind = 'blackman') => {
  const [a0, a1, a2] = windowSpec(kind).a;
  return a0 ** 2 + a1 ** 2 / 2 + a2 ** 2 / 2;
};
export const BLACKMAN_POWER = windowPower('blackman');

// Turns a bin (dB of the 1/N-scaled, windowed |X[k]|) into that bin's share of the signal's mean
// square, one-sided. With it the bins of a spectrum add up to the overall level, whatever the window.
const binCorrectionDb = (kind) => 10 * Math.log10(2 / windowPower(kind));

export function aWeightDb(f) {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const ra =
    (F4 ** 2 * f2 * f2) /
    ((f2 + F1 ** 2) * Math.sqrt((f2 + F2 ** 2) * (f2 + F3 ** 2)) * (f2 + F4 ** 2));
  return 20 * Math.log10(ra) + A1000;
}

export function cWeightDb(f) {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  return 20 * Math.log10((F4 ** 2 * f2) / ((f2 + F1 ** 2) * (f2 + F4 ** 2))) + C1000;
}

export function weightDb(f, weighting = 'A') {
  if (f <= 0) return -Infinity;
  return weighting === 'C' ? cWeightDb(f) : weighting === 'Z' ? 0 : aWeightDb(f);
}

// Biquads for the chosen weighting ('Z' = no filter).
export function designWeighting(fs, weighting = 'A') {
  if (weighting === 'Z') return [];
  if (weighting === 'A') return designAWeighting(fs);
  const pole = (hz) => (2 * fs - 2 * Math.PI * hz) / (2 * fs + 2 * Math.PI * hz);
  const p1 = pole(F1);
  const p4 = pole(F4);
  const sos = [
    [1, -2, 1, -2 * p1, p1 * p1], // two zeros at DC, double pole at F1
    [1, 2, 1, -2 * p4, p4 * p4], // two zeros at Nyquist, double pole at F4
  ];
  const g = 1 / sosMagnitude(sos, 1000, fs);
  sos[1] = [sos[1][0] * g, sos[1][1] * g, sos[1][2] * g, sos[1][3], sos[1][4]];
  return sos;
}

// Digital A-weighting filter as three biquads [b0, b1, b2, a1, a2] (a0 = 1),
// via the plain bilinear transform. Pre-warping the poles was tried and tracks the
// analytic curve worse below 8 kHz; unwarped, the error at 44.1/48 kHz is under
// 0.1 dB up to 4 kHz and about -0.6 dB at 8 kHz (IEC class 1 allows +1.5/-2.5 there).
export function designAWeighting(fs) {
  const pole = (hz) => {
    const w = 2 * Math.PI * hz;
    return (2 * fs - w) / (2 * fs + w);
  };
  const p1 = pole(F1);
  const p2 = pole(F2);
  const p3 = pole(F3);
  const p4 = pole(F4);
  const sos = [
    [1, -2, 1, -2 * p1, p1 * p1], // two zeros at DC, double pole at F1
    [1, -2, 1, -2 * p4, p4 * p4], // two zeros at DC, double pole at F4
    [1, 2, 1, -(p2 + p3), p2 * p3], // two zeros at Nyquist, poles at F2 and F3
  ];
  const g = 1 / sosMagnitude(sos, 1000, fs);
  sos[2] = [sos[2][0] * g, sos[2][1] * g, sos[2][2] * g, sos[2][3], sos[2][4]];
  return sos;
}

export function sosMagnitude(sos, f, fs) {
  const w = (2 * Math.PI * f) / fs;
  const c1 = Math.cos(w);
  const s1 = -Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = -Math.sin(2 * w);
  let mag = 1;
  for (const [b0, b1, b2, a1, a2] of sos) {
    const nr = b0 + b1 * c1 + b2 * c2;
    const ni = b1 * s1 + b2 * s2;
    const dr = 1 + a1 * c1 + a2 * c2;
    const di = a1 * s1 + a2 * s2;
    mag *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return mag;
}

export function toDb(meanSquare, offset = 0) {
  return meanSquare > 0 ? 10 * Math.log10(meanSquare) + offset : -Infinity;
}

// Per-bin dB to add to analyser output for a weighted, calibrated level per bin. `correction(f)` is the
// microphone's frequency-response correction from its calibration file (mics.js), if any.
export function binLevelTable(binCount, binHz, weighting = 'A', correction = null, window = 'blackman') {
  const t = new Float32Array(binCount);
  const win = binCorrectionDb(window);
  t[0] = -Infinity; // DC is not sound
  for (let k = 1; k < binCount; k++) t[k] = win + weightDb(k * binHz, weighting) + (correction ? correction(k * binHz) : 0);
  return t;
}

// 1/3-octave bands 10 Hz – 20 kHz (base-2 centres 1000 * 2^(n/3)); `major` marks octave centres, `low`
// the bands under 20 Hz, where phone and USB microphones are not specified (shown as a guide only).
const THIRD_LABELS = [
  '10', '12.5', '16', '20', '25', '31.5', '40', '50', '63', '80', '100', '125', '160', '200', '250', '315', '400', '500',
  '630', '800', '1k', '1.25k', '1.6k', '2k', '2.5k', '3.15k', '4k', '5k', '6.3k', '8k', '10k', '12.5k', '16k', '20k',
];
const OCTAVE_LABELS = new Set(['16', '31.5', '63', '125', '250', '500', '1k', '2k', '4k', '8k', '16k']);
const BAND_1K = THIRD_LABELS.indexOf('1k');
export const BANDS = THIRD_LABELS.map((label, i) => {
  const exact = 1000 * 2 ** ((i - BAND_1K) / 3);
  return { exact, label, major: OCTAVE_LABELS.has(label), low: exact < 19, lo: exact * 2 ** (-1 / 6), hi: exact * 2 ** (1 / 6) };
});

// Band number for each frequency point (-1 outside the bands).
export function bandIndex(freqs, bands = BANDS) {
  return Int16Array.from(freqs, (f) => bands.findIndex((b) => f >= b.lo && f < b.hi));
}

// Energy sum of per-bin levels into bands; bands no bin falls into come out -Infinity.
export function bandLevels(levels, idx, count = BANDS.length, out = new Float32Array(count)) {
  const pow = new Float64Array(count);
  for (let k = 0; k < levels.length; k++) if (idx[k] >= 0 && levels[k] > -300) pow[idx[k]] += 10 ** (levels[k] / 10);
  for (let b = 0; b < count; b++) out[b] = toDb(pow[b]);
  return out;
}

// Per-bin curves kept beside the live spectrum: peak hold (max since reset), minimum hold, and two
// tracking curves that follow the spectrum's highs / lows and drift back at `rate` dB per second.
export const TRACK_DB_PER_SEC = 12;

export function newHolds(n) {
  return {
    max: new Float32Array(n).fill(-Infinity),
    min: new Float32Array(n).fill(Infinity),
    maxTrack: new Float32Array(n).fill(-Infinity),
    minTrack: new Float32Array(n).fill(Infinity),
  };
}

// dt: seconds since the last update. Bin 0 (DC) is left alone.
export function updateHolds(h, cur, dt, rate = TRACK_DB_PER_SEC) {
  const fall = rate * dt;
  for (let k = 1; k < cur.length; k++) {
    const v = cur[k];
    if (v > h.max[k]) h.max[k] = v;
    if (v < h.min[k]) h.min[k] = v;
    h.maxTrack[k] = Math.max(v, h.maxTrack[k] - fall);
    h.minTrack[k] = Math.min(v, h.minTrack[k] + fall);
  }
  return h;
}

export function binLevels(dbBins, table, offset, out = new Float32Array(dbBins.length)) {
  for (let k = 0; k < dbBins.length; k++) out[k] = dbBins[k] + table[k] + offset;
  return out;
}

// Energy sum of per-bin levels: the overall level the spectrum represents.
export function totalLevel(levels) {
  let sum = 0;
  for (const l of levels) if (l > -300) sum += 10 ** (l / 10);
  return toDb(sum);
}

// For each [edges[c], edges[c+1]) range, the slice of the (ascending) `freqs` inside it.
export function rangeIndex(freqs, edges) {
  const idx = new Int32Array(edges.length);
  let i = 0;
  edges.forEach((e, c) => {
    while (i < freqs.length && freqs[i] < e) i++;
    idx[c] = i;
  });
  return idx;
}

// Collapses levels onto ranges: the loudest point inside each range, or, where a range is
// narrower than the point spacing, the level interpolated at its centre frequency.
// Ranges past the last point get -Infinity (nothing measured there, e.g. a 32 kHz mic above 16 kHz).
export function reduceRanges(levels, freqs, idx, centres, out = new Float32Array(centres.length)) {
  for (let c = 0; c < centres.length; c++) {
    const lo = idx[c];
    const hi = idx[c + 1];
    if (hi > lo) {
      let m = -Infinity;
      for (let i = lo; i < hi; i++) if (levels[i] > m) m = levels[i];
      out[c] = m;
    } else if (lo >= freqs.length) {
      out[c] = -Infinity;
    } else if (lo <= 0) {
      out[c] = levels[0];
    } else {
      const t = (centres[c] - freqs[lo - 1]) / (freqs[lo] - freqs[lo - 1]);
      out[c] = levels[lo - 1] + (levels[lo] - levels[lo - 1]) * t;
    }
  }
  return out;
}

// n log-spaced frequencies from fmin to fmax inclusive, and the n + 1 range edges halfway
// (geometrically) between them, so a resampled spectrum still reaches both ends of the axis.
export function logGrid(n, fmin, fmax) {
  const step = Math.log(fmax / fmin) / (n - 1);
  const centres = Float32Array.from({ length: n }, (_, i) => fmin * Math.exp(step * i));
  const edges = Float32Array.from({ length: n + 1 }, (_, i) => fmin * Math.exp(step * (i - 0.5)));
  return { centres, edges };
}

// The strongest tonal peaks: local maxima standing `minProminence` dB above the median of their
// +-1/3-octave neighbourhood (at least +-12 bins, so low frequencies have enough to compare with),
// at least `minOctaves` apart, loudest first. Frequencies are refined by parabolic interpolation.
export function findPeaks(levels, binHz, { count = 2, fmin = 30, fmax = 16000, minProminence = 6, minOctaves = 1 / 3 } = {}) {
  const k0 = Math.max(3, Math.ceil(fmin / binHz));
  const k1 = Math.min(levels.length - 3, Math.floor(fmax / binHz));
  const candidates = [];
  for (let k = k0; k <= k1; k++) {
    const v = levels[k];
    if (v > levels[k - 1] && v >= levels[k + 1] && v >= levels[k - 2] && v >= levels[k + 2]) candidates.push(k);
  }
  candidates.sort((a, b) => levels[b] - levels[a]);
  const peaks = [];
  for (const k of candidates.slice(0, 40)) {
    const hz = refine(levels, k) * binHz;
    if (peaks.some((p) => Math.abs(Math.log2(p.hz / hz)) < minOctaves)) continue;
    const lo = Math.max(1, Math.min(k - 12, Math.floor(hz / 2 ** (1 / 3) / binHz)));
    const hi = Math.min(levels.length - 1, Math.max(k + 12, Math.ceil((hz * 2 ** (1 / 3)) / binHz)));
    const around = [];
    for (let i = lo; i <= hi; i++) if (Math.abs(i - k) > 3) around.push(levels[i]);
    around.sort((a, b) => a - b);
    const prominence = around.length ? levels[k] - around[Math.floor(around.length / 2)] : 0;
    if (prominence < minProminence) continue;
    peaks.push({ hz, db: levels[k], prominence });
    if (peaks.length >= count) break;
  }
  return peaks;
}

function refine(levels, k) {
  const a = levels[k - 1];
  const b = levels[k];
  const c = levels[k + 1];
  const denom = a - 2 * b + c;
  return k + (denom !== 0 && Number.isFinite(denom) ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0);
}

// In-place iterative radix-2 FFT (length must be a power of two). Twiddle factors are cached
// per size, so analysing a whole file costs no trigonometry per frame.
const TWIDDLES = new Map();
function twiddles(n) {
  let t = TWIDDLES.get(n);
  if (!t) {
    t = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      t.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      t.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    TWIDDLES.set(n, t);
  }
  return t;
}

export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  const { cos, sin } = twiddles(n);
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + half;
        const vr = re[b] * wr - im[b] * wi;
        const vi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
}

const WINDOWS = new Map();
export function windowOf(kind, n) {
  const key = `${kind}|${n}`;
  let w = WINDOWS.get(key);
  if (!w) {
    const [a0, a1, a2] = windowSpec(kind).a;
    w = Float64Array.from({ length: n }, (_, i) => a0 - a1 * Math.cos((2 * Math.PI * i) / n) + a2 * Math.cos((4 * Math.PI * i) / n));
    WINDOWS.set(key, w);
  }
  return w;
}

// One frame in the AnalyserNode's convention (window, 1/N scaling, dB of |X|), so binLevels() turns it
// into the same dB per bin the live view shows. Blackman is the analyser's own window.
export function frameSpectrum(samples, start, fftSize, out = new Float32Array(fftSize / 2), window = 'blackman') {
  const win = windowOf(window, fftSize);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let n = 0; n < fftSize; n++) re[n] = (samples[start + n] || 0) * win[n];
  fft(re, im);
  for (let k = 0; k < out.length; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / fftSize);
  return out;
}

export function stft(samples, rate, fftSize = 2048, hop = fftSize / 2, window = 'blackman') {
  const frames = [];
  for (let start = 0; start + fftSize <= samples.length; start += hop) frames.push(frameSpectrum(samples, start, fftSize, undefined, window));
  return { frames, binHz: rate / fftSize, hopSec: hop / rate };
}

// The live spectrum with a window the AnalyserNode does not have: the analyser's latest fftSize samples
// (getFloatTimeDomainData) windowed and transformed here, with the analyser's own smoothing over time
// (|X| averaged with the previous frame by `smoothing`), in dB of |X| / N like getFloatFrequencyData.
export class WindowedSpectrum {
  constructor(fftSize, window, smoothing = 0.5) {
    this.n = fftSize;
    this.win = windowOf(window, fftSize);
    this.smoothing = smoothing;
    this.time = new Float32Array(fftSize);
    this.re = new Float64Array(fftSize);
    this.im = new Float64Array(fftSize);
    this.mag = new Float64Array(fftSize / 2); // smoothed |X| / N
  }

  // samples: fftSize time-domain samples, oldest first. Writes dB per bin into out.
  run(samples, out) {
    const { n, win, re, im, mag, smoothing } = this;
    for (let i = 0; i < n; i++) {
      re[i] = samples[i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < mag.length; k++) {
      mag[k] = smoothing * mag[k] + (1 - smoothing) * (Math.hypot(re[k], im[k]) / n);
      out[k] = mag[k] > 0 ? 20 * Math.log10(mag[k]) : -Infinity;
    }
    return out;
  }
}

// The meter's level chain run over a whole recording: frequency weighting, Fast (or Slow) detector.
// Returns Leq of the whole file, max / min after the first 0.5 s (as live), and the time-weighted
// level every `step` seconds for a time-history graph. With `detail`, also per step: its Leq and the
// highest and lowest time-weighted level in it (NaN while warming up), for the raw data export.
export function levelHistory(samples, rate, offset = 0, step = 0.1, weighting = 'A', tau = 0.125, { detail = false } = {}) {
  const sos = designWeighting(rate, weighting);
  const st = sos.map(() => [0, 0]);
  const kFast = 1 - Math.exp(-1 / (tau * rate));
  const warm = samples.length > rate ? Math.round(0.5 * rate) : 0;
  const every = Math.max(1, Math.round(step * rate));
  const steps = Math.floor(samples.length / every);
  const history = new Float32Array(steps);
  const stepLeq = detail ? new Float32Array(steps) : null;
  const stepMax = detail ? new Float32Array(steps) : null;
  const stepMin = detail ? new Float32Array(steps) : null;
  let fast = 0;
  let sum = 0;
  let max = 0;
  let min = Infinity;
  let peak = 0;
  let sSum = 0;
  let sMax = -Infinity;
  let sMin = Infinity;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    let y = x;
    for (let s = 0; s < sos.length; s++) {
      const c = sos[s];
      const z = st[s];
      const out = c[0] * y + z[0];
      z[0] = c[1] * y - c[3] * out + z[1];
      z[1] = c[2] * y - c[4] * out;
      y = out;
    }
    const y2 = y * y;
    sum += y2;
    fast += (y2 - fast) * kFast;
    if (i >= warm) {
      if (fast > max) max = fast;
      if (fast < min) min = fast;
    }
    const ax = x < 0 ? -x : x;
    if (ax > peak) peak = ax;
    if (detail) {
      sSum += y2;
      if (i >= warm) {
        if (fast > sMax) sMax = fast;
        if (fast < sMin) sMin = fast;
      }
    }
    if ((i + 1) % every === 0) {
      const n = (i + 1) / every - 1;
      history[n] = toDb(fast, offset);
      if (detail) {
        stepLeq[n] = toDb(sSum / every, offset);
        stepMax[n] = Number.isFinite(sMax) ? toDb(sMax, offset) : NaN;
        stepMin[n] = Number.isFinite(sMin) ? toDb(sMin, offset) : NaN;
        sSum = 0;
        sMax = -Infinity;
        sMin = Infinity;
      }
    }
  }
  return {
    leq: toDb(sum / Math.max(1, samples.length), offset),
    lmax: toDb(max, offset),
    lmin: Number.isFinite(min) ? toDb(min, offset) : -Infinity,
    history,
    step: every / rate,
    peak,
    ...(detail ? { stepLeq, stepMax, stepMin } : {}),
  };
}
