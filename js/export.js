// Raw data of one record for Excel (xlsx.js): a summary, the level over time at a chosen interval,
// the spectrum per FFT bin at the record's own FFT size, and 1/3-octave bands (overall and over time).
// Worked out from the record's sound where it has one, else from what the record keeps. Pure, so it
// runs under Node for the tests.

import { levelHistory, tauOf, FFT_WINDOWS, BANDS, bandIndex, bandLevels } from './dsp.js';
import { analyzeSound, bandHistory } from './analysis.js';

export const EXPORT_STEPS = [0.1, 0.125, 1]; // seconds per row in the time sheets
export const defaultStep = (rec) => (rec.timeWeighting === 'S' ? 1 : 0.125);

const r1 = (v) => (Number.isFinite(v) && v > -900 ? Math.round(v * 10) / 10 : null);
const r3 = (v) => Math.round(v * 1000) / 1000;
const TW = { F: 'Fast (125 ms)', S: 'Slow (1 s)' };

// When the record's sound starts (ms), where it is known: a recording keeps its start; a snapshot's
// sound is the last seconds before it was saved.
export function soundStart(rec, seconds) {
  if (Number.isFinite(rec.startedAt)) return rec.startedAt;
  if (rec.source !== 'file' && Number.isFinite(rec.ts) && Number.isFinite(seconds)) return rec.ts - seconds * 1000;
  return null;
}

// rec: a stored record; sound: { samples, rate } decoded from rec.audio, or null; step: seconds per row;
// correction: the microphone's response correction (mics.js calCorrection) for spectra, or null.
export function rawDataSheets(rec, { sound = null, step = defaultStep(rec), correction = null } = {}) {
  const w = rec.weighting || 'A';
  const tw = rec.timeWeighting || 'F';
  const unit = rec.unit || `dB(${w})`;
  const offset = Number.isFinite(rec.offset) ? rec.offset : 0;
  const win = rec.window || 'blackman';
  const fromFile = rec.source === 'file';
  const sheets = [];
  const notes = [];
  const soundSec = sound ? sound.samples.length / sound.rate : null;
  const start = sound ? soundStart(rec, soundSec) : null;
  const at = (sec, base = start) => (base != null ? { date: base + sec * 1000 } : null);

  // level over time: a snapshot's own trace (the whole measurement), else the sound
  const time = [['시각', '경과(초)', `L${w}${tw} ${unit}`, `L${w}eq,${step}s ${unit}`, `L${w}${tw}max ${unit}`, `L${w}${tw}min ${unit}`]];
  if (!fromFile && rec.trace?.v?.length) {
    const { v, t, at: t0 } = rec.trace;
    const dt = rec.trace.step || 0.05;
    let group = [];
    let n = 0;
    const flush = (i) => {
      const pow = group.reduce((s, x) => s + 10 ** (x / 10), 0) / group.length;
      time.push([Number.isFinite(t0) && t ? { date: t0 + t[i] } : null, r3((n + 1) * step), r1(group[group.length - 1]), r1(10 * Math.log10(pow)), r1(Math.max(...group)), r1(Math.min(...group))]);
    };
    for (let i = 0; i < v.length; i++) {
      const k = Math.floor(((i + 1) * dt - 1e-9) / step);
      if (k !== n && group.length) {
        flush(i - 1);
        group = [];
      }
      n = k;
      if (Number.isFinite(v[i])) group.push(v[i]);
    }
    if (group.length) flush(v.length - 1);
    notes.push(['시간별 레벨', `측정 중 ${dt * 1000} ms마다 기록한 시간 가중 레벨 (${step}초씩 묶음, Leq는 그 값들의 에너지 평균)`]);
  } else if (sound) {
    const h = levelHistory(sound.samples, sound.rate, offset, step, w, tauOf(tw), { detail: true });
    for (let n = 0; n < h.history.length; n++) {
      const sec = (n + 1) * h.step;
      time.push([at(sec), r3(sec), r1(h.history[n]), r1(h.stepLeq[n]), r1(h.stepMax[n]), r1(h.stepMin[n])]);
    }
    notes.push(['시간별 레벨', `${fromFile ? '파일' : '저장된'} 소리 ${r3(soundSec)}초를 매 샘플 계산 (${step}초 간격)`]);
  }
  if (time.length > 1) sheets.push({ name: '시간별 레벨', rows: time, widths: [24, 10, 16, 18, 18, 18] });

  // spectrum per FFT bin: a snapshot's own bins, else the sound at the record's FFT size, else the
  // 241 points the record keeps for its graph
  const fft = [];
  let bins = null; // { hz, curves: [[name, values]] } for the band sums
  const sp = rec.spectrum || {};
  if (sp.bins?.hz) {
    const b = sp.bins;
    const curves = [['저장 순간', b.cur], ['측정 평균', b.avg], ['측정 중 최대', b.max], ['측정 중 최소', b.min]].filter(([, a]) => a?.length);
    bins = { hz: b.hz, curves };
    notes.push(['주파수', `FFT ${rec.fftSize} (${r3(b.hz)} Hz 간격), 측정 화면의 값 그대로`]);
  } else if (sound) {
    const a = analyzeSound(sound.samples, sound.rate, offset, { fftSize: rec.fftSize || 4096, maxFrames: 400, weighting: w, timeWeighting: tw, window: win, correction, bins: true });
    bins = { hz: a.binHz, curves: [['평균', a.binAvg], ['최대', a.binMax], ['최소', a.binMin]] };
    notes.push(['주파수', `${fromFile ? '파일' : '저장된'} 소리에서 FFT ${a.fftSize} (${r3(a.binHz)} Hz 간격)로 계산`]);
  }
  if (bins) {
    fft.push(['주파수(Hz)', ...bins.curves.map(([name]) => `${name} ${unit}`)]);
    const len = Math.min(...bins.curves.map(([, a]) => a.length));
    for (let k = 1; k < len; k++) fft.push([r3(k * bins.hz), ...bins.curves.map(([, a]) => r1(a[k]))]);
  } else if (sp.freqs?.length) {
    const curves = [[fromFile ? '전체 평균' : '저장 순간', sp.cur], ['측정 평균', sp.avg], ['최대', sp.max], ['최소', sp.min]].filter(([, a]) => a?.length);
    fft.push(['주파수(Hz)', ...curves.map(([name]) => `${name} ${unit}`)]);
    sp.freqs.forEach((f, i) => fft.push([f, ...curves.map(([, a]) => r1(a[i]))]));
    notes.push(['주파수', '저장된 그래프의 241점 (20 Hz – 20 kHz, 로그 간격)']);
  }
  if (fft.length > 1) sheets.push({ name: '주파수', rows: fft, widths: [12, ...fft[0].slice(1).map(() => 18)] });

  // 1/3 octave: over time from the sound, and per band overall
  const oct = [];
  if (sound) {
    const bh = bandHistory(sound.samples, sound.rate, offset, { step, fftSize: Math.max(8192, rec.fftSize || 0), weighting: w, window: win, correction });
    const used = BANDS.map((_, b) => bh.rows.some((row) => Number.isFinite(row[b])));
    const cols = BANDS.map((band, b) => ({ band, b })).filter(({ b }) => used[b]);
    const rows = [['시각', '경과(초)', ...cols.map(({ band }) => `${band.label} Hz`)]];
    bh.rows.forEach((row, n) => rows.push([at((n + 1) * bh.step), r3((n + 1) * bh.step), ...cols.map(({ b }) => r1(row[b]))]));
    if (rows.length > 1) sheets.push({ name: '1／3 옥타브 시간별', rows, widths: [24, 10, ...cols.map(() => 9)] });
    oct.push(['대역(Hz)', `평균 Leq ${unit}`, `최대 (${step}초 Leq) ${unit}`, `최소 (${step}초 Leq) ${unit}`]);
    for (const { band, b } of cols) {
      const vals = bh.rows.map((row) => row[b]).filter(Number.isFinite);
      const leq = 10 * Math.log10(vals.reduce((s, x) => s + 10 ** (x / 10), 0) / vals.length);
      oct.push([band.label, r1(leq), r1(Math.max(...vals)), r1(Math.min(...vals))]);
    }
    notes.push(['1/3 옥타브', `${fromFile ? '파일' : '저장된'} 소리, 대역마다 ${step}초 Leq`]);
  } else if (bins) {
    const idx = bandIndex(Float32Array.from({ length: Math.min(...bins.curves.map(([, a]) => a.length)) }, (_, k) => k * bins.hz));
    const sums = bins.curves.filter(([name]) => !/최대|최소/.test(name)).map(([name, a]) => [name, bandLevels(Float32Array.from(a, (x) => (Number.isFinite(x) ? x : -Infinity)), idx)]);
    oct.push(['대역(Hz)', ...sums.map(([name]) => `${name} ${unit}`)]);
    BANDS.forEach((band, b) => sums.some(([, s]) => Number.isFinite(s[b])) && oct.push([band.label, ...sums.map(([, s]) => r1(s[b]))]));
    notes.push(['1/3 옥타브', 'FFT 칸의 에너지 합']);
  }
  if (oct.length > 1) sheets.push({ name: '1／3 옥타브', rows: oct, widths: [10, 18, 22, 22] });

  const peaks = (rec.peaks || []).map((p, i) => [`피크 ${i + 1}`, `${Math.round(p.hz)} Hz · ${r1(p.db)} ${unit}`]);
  const summary = [
    ['항목', '값'],
    ['일시', Number.isFinite(rec.ts) ? { date: rec.ts } : null],
    ['출처', fromFile ? `파일 ${rec.fileName || ''}` : '마이크 실시간 측정'],
    ['차량번호', rec.vehicle || ''],
    ['메모', rec.memo || ''],
    ['휴대폰', rec.device || ''],
    [`평균 Leq ${unit}`, r1(rec.leq)],
    [`최대 ${unit}`, r1(rec.lmax)],
    [`최소 ${unit}`, r1(rec.lmin)],
    ...(fromFile ? [] : [[`저장 순간 ${unit}`, r1(rec.laf)]]),
    [fromFile ? '길이(초)' : '측정 시간(초)', r1(rec.elapsed)],
    ...(rec.timedSec ? [['정해진 시간 측정(초)', rec.timedSec]] : []),
    ['주파수 가중', `${w}특성`],
    ['시간 가중', TW[tw] || tw],
    ['FFT 크기', rec.fftSize || null],
    ['창 함수', FFT_WINDOWS[win]?.name || win],
    ['샘플링 레이트(Hz)', rec.sampleRate || (sound ? sound.rate : null)],
    ['보정값(dB)', r1(offset)],
    ['마이크', rec.mic || '휴대폰 마이크'],
    ['마이크 보정', unit.startsWith('dBFS') ? '파일 디지털 레벨(dBFS)' : rec.calibrated ? '보정됨' : '보정 안 됨 (참고값)'],
    ...(rec.micCal ? [['보정 파일', rec.micCal]] : []),
    ...('speedAvg' in rec ? [['속도 평균(km/h)', r1(rec.speedAvg)], ['속도 최고(km/h)', r1(rec.speedMax)]] : []),
    ...peaks,
    ...(rec.audioSec ? [['소리 길이(초)', r1(rec.audioSec)]] : []),
    ['시간 간격(초)', step],
    ...notes,
    ['앱 버전', rec.app || ''],
    ['주의', '스마트폰 측정 참고값 (정밀 소음계를 대신하지 않음)'],
  ];
  return [{ name: '요약', rows: summary, widths: [22, 60] }, ...sheets];
}
