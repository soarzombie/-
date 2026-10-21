// Whole-recording analysis, for attached files and for sound saved with a record: the level over
// time, average and maximum spectrum, peaks, and a compact spectrum per frame (for the
// spectrogram and for "the spectrum at the playback position"). Pure functions, runs under Node.

import { binLevelTable, binLevels, frameSpectrum, levelHistory, findPeaks, logGrid, rangeIndex, reduceRanges } from './dsp.js';

// Frequency points the per-frame spectra are kept at: 400 log-spaced, 20 Hz – 20 kHz.
export const FRAME_GRID = logGrid(400, 20, 20000);

// offset: dB added to dBFS (the phone's calibration, or 0 for plain digital level).
export function analyzeSound(samples, rate, offset = 0, { fftSize = 4096, maxFrames = 1500 } = {}) {
  const levels = levelHistory(samples, rate, offset);
  const bins = fftSize / 2;
  const binHz = rate / fftSize;
  const table = binLevelTable(bins, binHz);
  const freqs = Float32Array.from({ length: bins }, (_, k) => k * binHz);
  const idx = rangeIndex(freqs, FRAME_GRID.edges);
  const span = Math.max(0, samples.length - fftSize);
  // frames overlap by 3/4 on short sound; on long sound they spread out so there are at most maxFrames
  const hop = Math.max(fftSize / 4, Math.ceil(span / maxFrames));
  const raw = new Float32Array(bins);
  const lv = new Float32Array(bins);
  const pow = new Float64Array(bins);
  const max = new Float32Array(bins).fill(-Infinity);
  const frames = [];
  for (let start = 0; start <= span; start += hop) {
    frameSpectrum(samples, start, fftSize, raw);
    binLevels(raw, table, offset, lv);
    for (let k = 1; k < bins; k++) {
      pow[k] += 10 ** (lv[k] / 10);
      if (lv[k] > max[k]) max[k] = lv[k];
    }
    frames.push(reduceRanges(lv, freqs, idx, FRAME_GRID.centres, new Float32Array(FRAME_GRID.centres.length)));
  }
  const avg = Float32Array.from(pow, (p) => 10 * Math.log10(p / frames.length));
  avg[0] = -Infinity;
  return {
    duration: samples.length / rate,
    rate,
    offset,
    leq: levels.leq,
    lmax: levels.lmax,
    lmin: levels.lmin,
    history: levels.history,
    historyStep: levels.step,
    clipped: levels.peak >= 0.999,
    peaks: findPeaks(avg, binHz, { count: 3 }),
    freqs: FRAME_GRID.centres,
    frames,
    frameStep: hop / rate,
    frameStart: fftSize / 2 / rate, // centre of the first frame
    avg: reduceRanges(avg, freqs, idx, FRAME_GRID.centres),
    max: reduceRanges(max, freqs, idx, FRAME_GRID.centres),
  };
}

export function frameAt(analysis, t) {
  const i = Math.round((t - analysis.frameStart) / analysis.frameStep);
  return analysis.frames[Math.max(0, Math.min(analysis.frames.length - 1, i))];
}
