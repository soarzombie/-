// Signal-processing helpers shared by the meter, the charts and the tests.
// Pure functions only (no DOM, no Web Audio) so they also run under Node.

// IEC 61672-1 A-weighting pole frequencies (Hz).
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;
const A1000 = 1.9997; // dB, makes the analytic curve 0 dB at 1 kHz

// Mean of w[n]^2 for the Blackman window (alpha = 0.16) the Web Audio AnalyserNode applies.
export const BLACKMAN_POWER = 0.42 ** 2 + 0.5 ** 2 / 2 + 0.08 ** 2 / 2;

// Turns an analyser bin (dB of the 1/N-scaled, windowed |X[k]|) into that bin's share of the
// signal's mean square, one-sided. With it the bins of a spectrum add up to the overall level.
const BIN_CORRECTION_DB = 10 * Math.log10(2 / BLACKMAN_POWER);

export function aWeightDb(f) {
  if (f <= 0) return -Infinity;
  const f2 = f * f;
  const ra =
    (F4 ** 2 * f2 * f2) /
    ((f2 + F1 ** 2) * Math.sqrt((f2 + F2 ** 2) * (f2 + F3 ** 2)) * (f2 + F4 ** 2));
  return 20 * Math.log10(ra) + A1000;
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

// Per-bin dB to add to analyser output for an A-weighted, calibrated level per bin.
export function binLevelTable(binCount, binHz) {
  const t = new Float32Array(binCount);
  t[0] = -Infinity; // DC is not sound
  for (let k = 1; k < binCount; k++) t[k] = BIN_CORRECTION_DB + aWeightDb(k * binHz);
  return t;
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

// In-place iterative radix-2 FFT (length must be a power of two).
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
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
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

// Short-time spectra of recorded samples in the AnalyserNode's convention (Blackman window,
// 1/N scaling, dB of |X|), so binLevels() turns them into the same dB(A) the live view shows.
export function stft(samples, rate, fftSize = 2048, hop = fftSize / 2) {
  const win = Float64Array.from(
    { length: fftSize },
    (_, n) => 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / fftSize) + 0.08 * Math.cos((4 * Math.PI * n) / fftSize),
  );
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  const frames = [];
  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    for (let n = 0; n < fftSize; n++) {
      re[n] = samples[start + n] * win[n];
      im[n] = 0;
    }
    fft(re, im);
    const out = new Float32Array(fftSize / 2);
    for (let k = 0; k < out.length; k++) out[k] = 20 * Math.log10(Math.hypot(re[k], im[k]) / fftSize);
    frames.push(out);
  }
  return { frames, binHz: rate / fftSize, hopSec: hop / rate };
}
