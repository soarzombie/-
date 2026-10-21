// Signal-processing helpers shared by the meter and the tests.
// Pure functions only (no DOM, no Web Audio) so they also run under Node.

// IEC 61672-1 A-weighting pole frequencies (Hz).
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;
const A1000 = 1.9997; // dB, makes the analytic curve 0 dB at 1 kHz

// 1/1-octave bands shown in the app. `exact` is the base-2 centre used for band edges.
export const OCTAVES = [-5, -4, -3, -2, -1, 0, 1, 2, 3].map((n) => {
  const exact = 1000 * 2 ** n;
  const label = { 31.25: '31.5', 62.5: '63' }[exact] ?? (exact >= 1000 ? `${exact / 1000}k` : String(exact));
  return { exact, label, lo: exact / Math.SQRT2, hi: exact * Math.SQRT2 };
});

// Band index ranges for the plain-language "low / mid / high" summary.
export const ZONES = {
  low: [0, 1, 2], // 31.5 – 125 Hz
  mid: [3, 4, 5], // 250 – 1k Hz
  high: [6, 7, 8], // 2k – 8k Hz
};

// Mean of w[n]^2 for the Blackman window (alpha = 0.16) the Web Audio AnalyserNode applies.
export const BLACKMAN_POWER = 0.42 ** 2 + 0.5 ** 2 / 2 + 0.08 ** 2 / 2;

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

// AnalyserNode.getFloatFrequencyData() bins (dB of |X[k]|, 1/N-scaled, Blackman-windowed)
// to each bin's contribution to the signal's mean square, one-sided.
export function analyserDbToPower(dbBins, out = new Float64Array(dbBins.length)) {
  for (let k = 0; k < dbBins.length; k++) {
    const db = dbBins[k];
    out[k] = Number.isFinite(db) ? (2 * 10 ** (db / 10)) / BLACKMAN_POWER : 0;
  }
  out[0] = 0; // DC offset is not sound
  return out;
}

export function aWeightPower(power, binHz) {
  const out = new Float64Array(power.length);
  for (let k = 1; k < power.length; k++) out[k] = power[k] * 10 ** (aWeightDb(k * binHz) / 10);
  return out;
}

// Sum bins into bands; returns mean square per band.
export function bandPowers(power, binHz, bands = OCTAVES) {
  return bands.map(({ lo, hi }) => {
    let sum = 0;
    const k0 = Math.max(1, Math.ceil(lo / binHz));
    const k1 = Math.min(power.length - 1, Math.floor(hi / binHz));
    for (let k = k0; k <= k1; k++) sum += power[k];
    return sum;
  });
}

// Percent share of energy in the low / mid / high groups (rounded, sums to 100).
export function zoneShares(bandPower) {
  const sums = Object.fromEntries(
    Object.entries(ZONES).map(([zone, idx]) => [zone, idx.reduce((s, i) => s + (bandPower[i] || 0), 0)]),
  );
  const total = sums.low + sums.mid + sums.high;
  if (!(total > 0)) return { low: 0, mid: 0, high: 0 };
  const low = Math.round((sums.low / total) * 100);
  const mid = Math.round((sums.mid / total) * 100);
  return { low, mid, high: Math.max(0, 100 - low - mid) };
}

export function dominantZone(shares) {
  return Object.entries(shares).sort((a, b) => b[1] - a[1])[0][0];
}

export function zoneOfFrequency(hz) {
  if (hz < OCTAVES[3].lo) return 'low';
  if (hz < OCTAVES[6].lo) return 'mid';
  return 'high';
}

// Strongest bin between fmin and fmax, refined by parabolic interpolation.
// `prominence` is how far (dB) it stands above the median of its +-1/3-octave neighbourhood,
// so a clear whine or squeal scores high and broadband rumble scores low.
export function findPeak(power, binHz, fmin = 20, fmax = 10000) {
  const k0 = Math.max(2, Math.ceil(fmin / binHz));
  const k1 = Math.min(power.length - 2, Math.floor(fmax / binHz));
  let k = -1;
  for (let i = k0; i <= k1; i++) if (k < 0 || power[i] > power[k]) k = i;
  if (k < 0 || !(power[k] > 0)) return null;
  const db = (i) => 10 * Math.log10(power[i] || 1e-30);
  const a = db(k - 1);
  const b = db(k);
  const c = db(k + 1);
  const denom = a - 2 * b + c;
  const delta = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
  const hz = (k + delta) * binHz;

  const lo = Math.max(1, Math.floor(hz / 2 ** (1 / 3) / binHz));
  const hi = Math.min(power.length - 1, Math.ceil((hz * 2 ** (1 / 3)) / binHz));
  const around = [];
  for (let i = lo; i <= hi; i++) if (Math.abs(i - k) > 4) around.push(db(i));
  around.sort((x, y) => x - y);
  const median = around.length ? around[Math.floor(around.length / 2)] : b;
  return { hz, prominence: b - median };
}

// 'ok' | 'warn' | 'over' | 'none' (no criteria set for this mode).
export function judge(value, warn, limit) {
  if (!Number.isFinite(value) || limit == null) return 'none';
  const v = Math.round(value * 10) / 10;
  if (v > limit) return 'over';
  if (warn != null && v >= warn) return 'warn';
  return 'ok';
}
