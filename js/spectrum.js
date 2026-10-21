// Real-time FFT spectrum: x = frequency, 20 Hz – 20 kHz (log) or 0 – 20 kHz (linear) unless a narrower range
// is set; y = weighted dB per FFT bin.
// Style 'fill': red area = current, grey area = peak hold (maximum since reset); 'bar': the same as bars;
// 'line': blue line = current, red line = peak hold. Over any style: orange = minimum hold, dashed light
// red / light orange = max / min tracking.
// Labels mark the strongest tonal peaks; the cursor reads the live level and the maximum at one frequency. drawSpectrum() is
// also used for the share image, and the layout helpers keep the spectrogram aligned with it.

import { rangeIndex, reduceRanges } from './dsp.js';

export const FMIN = 20;
export const FMAX = 20000;

const DARK = {
  grid: '#272b33',
  axis: '#7d8592',
  max: 'rgba(120, 126, 138, 0.55)',
  maxLine: 'rgba(170, 176, 188, 0.7)',
  cur: 'rgba(214, 58, 72, 0.9)',
  curLine: '#ffe3e6',
  lineCur: '#5aa2ff',
  lineMax: '#ff5a66',
  minHold: '#ffa53d',
  maxTrack: '#ff9aa5',
  minTrack: '#ffd08a',
  avg: '#7fe0c4',
  ref: '#c9a6ff',
  cursor: '#5cc8ff',
  label: '#ffffff', // text on the dark label pills
  labelBg: 'rgba(12, 14, 18, 0.72)',
  ink: '#ffffff', // text straight on the chart
  mean: 'rgba(255, 255, 255, 0.55)', // average (Leq) lines and their labels
  meanText: 'rgba(255, 255, 255, 0.85)',
  shade: 'rgba(255, 255, 255, 0.045)',
  live: '#5aa2ff', // the live level trace
  speed: '#f2c94c',
  history: '#ffb547', // a recording's level over time
  playhead: '#ffffff',
  font: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
};
// The bright screen for sunlight: dark lines and text on white.
const LIGHT = {
  ...DARK,
  grid: '#dde1e6',
  axis: '#56606d',
  max: 'rgba(110, 116, 128, 0.38)',
  maxLine: 'rgba(90, 96, 108, 0.7)',
  lineCur: '#1f6fe0',
  lineMax: '#e0313f',
  minHold: '#d97300',
  maxTrack: '#e0607a',
  minTrack: '#b8860b',
  avg: '#0f9a78',
  ref: '#7a4fd6',
  cursor: '#0a7fc0',
  ink: '#111418',
  mean: 'rgba(0, 0, 0, 0.5)',
  meanText: 'rgba(0, 0, 0, 0.75)',
  shade: 'rgba(0, 0, 0, 0.05)',
  live: '#1f6fe0',
  speed: '#a87900',
  history: '#d97300',
  playhead: '#111418',
};
export const DARK_COLORS = DARK; // the share card is always dark
export const SPECTRUM_COLORS = { ...DARK };

// 'dark' | 'light': every chart reads SPECTRUM_COLORS when it draws.
export function setChartTheme(theme) {
  Object.assign(SPECTRUM_COLORS, theme === 'light' ? LIGHT : DARK);
}

const hzLabel = (f) => (f >= 1000 ? `${parseFloat((f / 1000).toFixed(2))}k` : String(parseFloat(f.toFixed(1))));

// What each curve looks like in a style, for legends: [colour, 'area' | 'line' | 'dash'].
export function curveLook(style, c = SPECTRUM_COLORS) {
  const line = style === 'line';
  return {
    cur: line ? [c.lineCur, 'line'] : ['#d63a48', 'area'],
    max: line ? [c.lineMax, 'line'] : ['#787e8a', 'area'],
    min: [c.minHold, 'line'],
    maxTrack: [c.maxTrack, 'dash'],
    minTrack: [c.minTrack, 'dash'],
    avg: [c.avg, 'line'],
    ref: [c.ref, 'dash'],
  };
}

// Colours for the cursor's levels on the dark label: the live curve's and the maximum's, brightened
// where the curve is an area.
export function readingColors(style, c = SPECTRUM_COLORS) {
  return style === 'line' ? { cur: c.lineCur, max: c.lineMax } : { cur: '#ff7a85', max: '#c9ced8' };
}

// Plot rectangle inside a w x h drawing; shared by the spectrum and the spectrogram.
export function plotBox(w, h, k = 1, xLabels = true) {
  return { x0: 30 * k, x1: w - 6 * k, yTop: 8 * k, yBot: h - (xLabels ? 22 * k : 4 * k) };
}

// Frequency axis: scale 'log' | 'linear' over [fmin, fmax] (the whole 20 Hz – 20 kHz by default; a
// linear axis over the whole range starts at 0 Hz). A plain 'log' / 'linear' string means the whole range.
export function freqAxis(scale = 'log', fmin = FMIN, fmax = FMAX) {
  const a = scale === 'log' ? fmin : fmin <= FMIN ? 0 : fmin;
  return { scale, fmin, fmax, a, b: fmax };
}
const toAxis = (axis) => (typeof axis === 'string' || !axis ? freqAxis(axis || 'log') : axis);

// Accepted range from the axis settings: [fmin, fmax], or a Korean message saying what is wrong.
export function checkFreqRange(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '숫자를 넣어 주세요.';
  if (lo < 10 || hi > FMAX) return `주파수는 10 Hz – ${FMAX / 1000} kHz 사이로 넣어 주세요.`;
  if (hi < lo * 1.25 || hi - lo < 50) return '끝 주파수는 시작보다 충분히 커야 합니다.';
  return [lo, hi];
}

// Pinch on the frequency axis: the frequencies fa and fb first under the two fingers stay under them as
// they move to xa and xb. Returns the new [fmin, fmax] (kept within 10 Hz – 20 kHz, rounded, at least what
// checkFreqRange accepts; the whole axis once it is reached) or null while the fingers are too close.
export function pinchRange(scale, box, fa, fb, xa, xb) {
  const W = box.x1 - box.x0;
  if (Math.abs(xb - xa) < 24) return null;
  const lin = scale === 'linear';
  const fwd = lin ? (f) => f : Math.log;
  const inv = lin ? (v) => v : Math.exp;
  const span = ((fwd(fb) - fwd(fa)) * W) / (xb - xa);
  if (!(span > 0)) return null;
  const lo = lin ? 0 : fwd(10);
  const hi = fwd(FMAX);
  if (span >= fwd(FMAX) - fwd(lin ? 0 : FMIN)) return [FMIN, FMAX];
  let a = fwd(fa) - ((xa - box.x0) / W) * span;
  if (a < lo) a = lo;
  if (a + span > hi) a = hi - span;
  const round = (f) => (f < 100 ? Math.round(f) : Number(f.toPrecision(3)));
  let fmin = round(Math.max(10, inv(a)));
  const fmax = round(Math.min(FMAX, inv(a + span)));
  if (lin && inv(a) < FMIN) fmin = FMIN; // a linear axis from 20 Hz starts at 0 Hz
  return Array.isArray(checkFreqRange(fmin, fmax)) ? [fmin, fmax] : null;
}

export function checkDbRange(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return '숫자를 넣어 주세요.';
  if (lo < -60 || hi > 160) return 'dB는 -60 – 160 사이로 넣어 주세요.';
  if (hi - lo < 10) return '위 값은 아래 값보다 10 dB 이상 커야 합니다.';
  return [lo, hi];
}

// Tick frequencies for a plot `px` wide: 1-2-5 per decade on a wide log axis, else round steps.
export function freqTicks(axis, px = 330) {
  const { scale, a, b } = toAxis(axis);
  const out = [];
  if (scale === 'log' && b / a >= 8) {
    for (let d = 10 ** Math.floor(Math.log10(a)); d <= b; d *= 10) {
      for (const m of [1, 2, 5]) if (m * d >= a * 0.999 && m * d <= b * 1.001) out.push(m * d);
    }
    return out;
  }
  const raw = (b - a) / Math.max(2, Math.min(10, Math.floor(px / 60)));
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw * 0.999);
  for (let f = Math.ceil(a / step - 1e-9) * step; f <= b * 1.000001; f += step) out.push(Math.round(f * 100) / 100 + 0); // + 0: no -0
  return out;
}

export function freqToX(f, box, axis) {
  const { scale, a, b } = toAxis(axis);
  const t = scale === 'log' ? Math.log(Math.max(f, a) / a) / Math.log(b / a) : (f - a) / (b - a);
  return box.x0 + t * (box.x1 - box.x0);
}

export function xToFreq(x, box, axis) {
  const { scale, a, b } = toAxis(axis);
  const t = Math.max(0, Math.min(1, (x - box.x0) / (box.x1 - box.x0)));
  return scale === 'log' ? a * (b / a) ** t : Math.max(1, a + t * (b - a));
}

// One column per pixel: its frequency range and where those frequencies sit in `freqs`.
export function columnsFor(freqs, box, axis) {
  const { scale, a, b } = toAxis(axis);
  const n = Math.max(2, Math.round(box.x1 - box.x0));
  const fAt = scale === 'log' ? (i) => a * (b / a) ** (i / n) : (i) => a + ((b - a) * i) / n;
  const edges = Float32Array.from({ length: n + 1 }, (_, i) => fAt(i));
  const centres = Float32Array.from({ length: n }, (_, i) => fAt(i + 0.5));
  return { n, centres, idx: rangeIndex(freqs, edges), cur: new Float32Array(n), max: new Float32Array(n) };
}

// Labels under the plot; the first carries the unit. A label that would run into the one before is
// left out, and the ends stay inside the plot.
export function drawXAxis(g, box, h, axis, k, c) {
  g.font = `500 ${11 * k}px ${c.font}`;
  g.fillStyle = c.axis;
  g.textAlign = 'left';
  let lastRight = -Infinity;
  freqTicks(axis, box.x1 - box.x0).forEach((f, i) => {
    const text = i === 0 ? `${hzLabel(f)} Hz` : hzLabel(f);
    const w = g.measureText(text).width;
    const left = Math.max(box.x0, Math.min(box.x1 - w, freqToX(f, box, axis) - w / 2));
    if (left < lastRight + 4 * k) return;
    g.fillText(text, left, h - 6 * k);
    lastRight = left + w;
  });
}

// data: { freqs, cur, max?, peaks? }
// opts: { scale, fmin, fmax, style, range: [lo, hi], unit, fontScale, colors, cache, xLabels, cursors: [{ hz, name }] }
// Returns the plot box and the per-column values it drew (for cursor read-outs).
export function drawSpectrum(g, w, h, data, opts = {}) {
  const c = opts.colors || SPECTRUM_COLORS;
  const k = opts.fontScale || 1;
  const fs = 11 * k;
  const font = (size, weight = 500) => `${weight} ${size}px ${c.font}`;
  const [lo, hi] = opts.range || [-20, 100];
  const axis = freqAxis(opts.scale || 'log', opts.fmin ?? FMIN, opts.fmax ?? FMAX);
  const style = opts.style || 'fill';
  const xLabels = opts.xLabels !== false;
  const { freqs } = data;
  const box = plotBox(w, h, k, xLabels);
  const { x0, x1, yTop, yBot } = box;
  const y = (v) => yBot - (((v > lo ? Math.min(hi, v) : lo) - lo) / (hi - lo)) * (yBot - yTop); // NaN/-Inf -> floor

  // grid + axes
  g.lineWidth = 1;
  g.strokeStyle = c.grid;
  g.fillStyle = c.axis;
  g.font = font(fs);
  g.textAlign = 'left';
  const step = (yBot - yTop) / ((hi - lo) / 20) < 22 * k ? 40 : 20;
  for (let v = lo; v <= hi; v += step) {
    const yy = Math.round(y(v)) + 0.5;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(x1, yy);
    g.stroke();
    g.fillText(String(v), 2 * k, yy + fs * 0.35);
  }
  g.fillText(opts.unit || 'dB(A)', 2 * k, Math.max(fs, y(hi - step / 2) + fs * 0.35));
  freqTicks(axis, x1 - x0).forEach((f) => {
    const xx = Math.round(freqToX(f, box, axis)) + 0.5;
    g.beginPath();
    g.moveTo(xx, yTop);
    g.lineTo(xx, yBot);
    g.stroke();
  });
  if (xLabels) drawXAxis(g, box, h, axis, k, c);

  // curves
  const cache = opts.cache || {};
  const key = `${Math.round(x1 - x0)}|${axis.scale}|${axis.a}|${axis.b}|${freqs.length}|${freqs[1]}|${freqs[freqs.length - 1]}`;
  if (cache.key !== key) Object.assign(cache, { key, cols: columnsFor(freqs, box, axis) });
  const cols = cache.cols;
  const reduce = (levels, name) => reduceRanges(levels, freqs, cols.idx, cols.centres, (cols[name] ||= new Float32Array(cols.n)));
  const area = (out, fill, stroke) => {
    g.beginPath();
    g.moveTo(x0, yBot);
    for (let i = 0; i < cols.n; i++) g.lineTo(x0 + i + 0.5, y(out[i]));
    g.lineTo(x0 + cols.n, yBot);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    trace(out, stroke, 1.2);
  };
  const trace = (out, stroke, width, dash = null) => {
    g.beginPath();
    for (let i = 0; i < out.length; i++) g[i ? 'lineTo' : 'moveTo'](x0 + i + 0.5, y(out[i]));
    g.strokeStyle = stroke;
    g.lineWidth = width * k;
    g.setLineDash(dash ? dash.map((d) => d * k) : []);
    g.stroke();
    g.setLineDash([]);
  };
  // bars a few pixels wide, each as high as the loudest column in it
  const bars = (out, fill) => {
    const bw = Math.max(3, Math.round(4 * k));
    g.fillStyle = fill;
    for (let i = 0; i < cols.n; i += bw) {
      let v = -Infinity;
      for (let j = i; j < Math.min(cols.n, i + bw); j++) if (out[j] > v) v = out[j];
      if (!(v > lo)) continue;
      const yy = y(v);
      g.fillRect(x0 + i, yy, bw - 1, yBot - yy);
    }
  };
  g.save();
  g.beginPath();
  g.rect(x0, yTop, x1 - x0, yBot - yTop);
  g.clip();
  g.lineJoin = 'round';
  if (data.max) {
    const out = reduce(data.max, 'max');
    if (style === 'line') trace(out, c.lineMax, 1.4);
    else if (style === 'bar') bars(out, c.max);
    else area(out, c.max, c.maxLine);
  }
  if (data.cur) {
    const out = reduce(data.cur, 'cur');
    if (style === 'line') trace(out, c.lineCur, 1.6);
    else if (style === 'bar') bars(out, c.cur);
    else area(out, c.cur, c.curLine);
  }
  if (data.avg) trace(reduce(data.avg, 'avg'), c.avg, 1.5);
  if (data.min) trace(reduce(data.min, 'min'), c.minHold, 1.4);
  if (data.maxTrack) trace(reduce(data.maxTrack, 'maxTrack'), c.maxTrack, 1.2, [5, 3]);
  if (data.minTrack) trace(reduce(data.minTrack, 'minTrack'), c.minTrack, 1.2, [5, 3]);
  // a reference (another measurement, on its own frequency points) as a dashed line over the rest
  let refOut = null;
  if (data.ref) {
    const rf = data.ref.freqs;
    const refKey = `${key}|${rf.length}|${rf[0]}|${rf[rf.length - 1]}`;
    if (cache.refKey !== refKey) Object.assign(cache, { refKey, refCols: columnsFor(rf, box, axis) });
    const rc = cache.refCols;
    refOut = reduceRanges(data.ref.values, rf, rc.idx, rc.centres, (rc.out ||= new Float32Array(rc.n)));
    trace(refOut, c.ref, 1.7, [6, 4]);
  }
  g.restore();

  // peak labels
  (data.peaks || []).forEach((p) => {
    if (!(p.hz >= axis.a && p.hz <= axis.b)) return;
    const px = freqToX(p.hz, box, axis);
    const py = y(p.db);
    g.fillStyle = c.label;
    g.beginPath();
    g.arc(px, py, 3 * k, 0, Math.PI * 2);
    g.fill();
    const text = `${Math.round(p.hz).toLocaleString('ko-KR')} Hz`;
    g.font = font(13 * k, 700);
    const tw = g.measureText(text).width + 12 * k;
    const bx = Math.min(x1 - tw, Math.max(x0, px - tw / 2));
    const by = Math.max(yTop, py - 30 * k);
    g.fillStyle = c.labelBg;
    g.beginPath();
    g.roundRect ? g.roundRect(bx, by, tw, 20 * k, 6 * k) : g.rect(bx, by, tw, 20 * k);
    g.fill();
    g.fillStyle = c.label;
    g.textAlign = 'left';
    g.fillText(text, bx + 6 * k, by + 14.5 * k);
  });

  // cursor: a vertical line at one frequency, a dot on the live curve and one on the maximum, and a
  // label with the frequency and both levels in their curves' colours. The columns read here are also
  // what the read-out strip shows.
  const colOf = (hz) => Math.max(0, Math.min(cols.n - 1, Math.floor(freqToX(hz, box, axis) - x0)));
  const labels = { cur: '지금', max: '최대', ...opts.cursorLabels };
  const readings = (opts.cursors || []).slice(0, 1).map((cur) => ({
    hz: cur.hz,
    cur: data.cur ? cols.cur[colOf(cur.hz)] : NaN,
    max: data.max ? cols.max[colOf(cur.hz)] : NaN,
    ref: refOut ? refOut[colOf(cur.hz)] : NaN,
    labels,
    style,
  }));
  const ink = readingColors(style, c);
  readings.forEach((r) => {
    const cx = Math.round(freqToX(r.hz, box, axis)) + 0.5;
    g.strokeStyle = c.cursor;
    g.lineWidth = 1.2 * k;
    g.beginPath();
    g.moveTo(cx, yTop);
    g.lineTo(cx, yBot);
    g.stroke();
    const shown = ['max', 'cur'].filter((key) => Number.isFinite(r[key]) && r[key] > lo);
    if (!shown.length) return;
    if (shown.includes('cur')) {
      const cy = Math.round(y(r.cur)) + 0.5;
      g.globalAlpha = 0.5;
      g.beginPath();
      g.moveTo(x0, cy);
      g.lineTo(x1, cy);
      g.stroke();
      g.globalAlpha = 1;
    }
    for (const key of shown) {
      g.fillStyle = ink[key];
      g.strokeStyle = c.labelBg;
      g.lineWidth = 2 * k;
      g.beginPath();
      g.arc(cx, y(r[key]), 4.5 * k, 0, Math.PI * 2);
      g.fill();
      g.stroke();
    }
    const lines = [
      [`${Math.round(r.hz).toLocaleString('ko-KR')} Hz`, c.label],
      ...['cur', 'max'].filter((key) => shown.includes(key)).map((key) => [`${labels[key]} ${r[key].toFixed(1)}`, ink[key]]),
    ];
    g.font = font(13 * k, 700);
    const tw = Math.max(...lines.map(([t]) => g.measureText(t).width)) + 14 * k;
    const th = (8 + 16 * lines.length) * k;
    const gap = 8 * k;
    const anchor = y(shown.includes('cur') ? r.cur : r.max);
    const bx = cx + gap + tw <= x1 ? cx + gap : cx - gap - tw;
    const by = anchor + gap + th <= yBot ? anchor + gap : Math.max(yTop + 20 * k, anchor - gap - th);
    g.fillStyle = c.labelBg;
    g.beginPath();
    g.roundRect ? g.roundRect(bx, by, tw, th, 6 * k) : g.rect(bx, by, tw, th);
    g.fill();
    g.textAlign = 'left';
    lines.forEach(([t, colour], i) => {
      g.fillStyle = colour;
      g.fillText(t, bx + 7 * k, by + (16 + 16 * i) * k);
    });
  });

  return { box, cols, readings };
}

// The analyzer page turned a quarter turn clockwise in CSS (the 가로 button where the screen cannot be locked).
export const sideways = () => document.documentElement.dataset.rotate === 'on' && document.body.dataset.view === 'home';

// Canvas that follows its host's size and redraws on update(). With `cursor`, tapping the chart places
// the cursor (or moves it there) and dragging moves it; two fingers pinch the axis (onZoom).
export class SpectrumView {
  constructor(host, { cursor = false, onCursor = null } = {}) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '주파수 분석 그래프 (가로: 주파수 20Hz–20kHz, 세로: dB(A))');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.cache = {};
    this.data = null;
    this.opts = {};
    this.cursors = [];
    this.onCursor = onCursor;
    this.onZoom = null; // ([fmin, fmax], done) while two fingers pinch the frequency axis
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (cursor) this.enableCursor();
  }

  get fontScale() {
    return this.w < 360 ? 0.92 : 1;
  }

  resize() {
    const r = { width: this.host.clientWidth, height: this.host.clientHeight }; // layout size, also when turned sideways
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = Math.max(1, Math.floor(r.width));
    this.h = Math.max(1, Math.floor(r.height));
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.draw();
  }

  update(data, opts) {
    this.data = data;
    if (opts) this.opts = opts;
    this.draw();
  }

  draw() {
    if (!this.w || !this.data || this.host.offsetParent === null) return;
    const { g } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const { box, readings } = drawSpectrum(g, this.w, this.h, this.data, { ...this.opts, fontScale: this.fontScale, cache: this.cache, cursors: this.cursors });
    this.box = box;
    this.onCursor?.(readings);
  }

  clearCursors() {
    this.cursors = [];
    this.draw();
  }

  enableCursor() {
    let dragging = false;
    let before = null; // where the cursor was before this touch: put back if the touch turns into a pinch
    const fingers = new Map(); // pointerId -> x
    let pinch = null; // two fingers with onZoom: { ids, fa, fb } frequencies first under them
    const axis = () => freqAxis(this.opts.scale || 'log', this.opts.fmin ?? FMIN, this.opts.fmax ?? FMAX);
    // x along the plot; on the analyzer turned sideways (app.js) the plot's x runs down the screen
    const xAt = (e) => {
      const r = this.host.getBoundingClientRect();
      return sideways() ? e.clientY - r.top : e.clientX - r.left;
    };
    this.host.addEventListener('pointerdown', (e) => {
      if (!this.box) return;
      const x = xAt(e);
      fingers.set(e.pointerId, x);
      try {
        this.host.setPointerCapture(e.pointerId);
      } catch {
        // not a capturable pointer (synthetic): moves still arrive while over the chart
      }
      if (fingers.size === 2 && this.onZoom) {
        this.cursors = before == null ? [] : [{ hz: before }];
        dragging = false;
        const ids = [...fingers.keys()].sort((p, q) => fingers.get(p) - fingers.get(q));
        pinch = { ids, fa: xToFreq(fingers.get(ids[0]), this.box, axis()), fb: xToFreq(fingers.get(ids[1]), this.box, axis()) };
        this.draw();
        return;
      }
      if (fingers.size > 1) return;
      const hz = xToFreq(x, this.box, axis());
      const cur = this.cursors[0];
      before = cur ? cur.hz : null;
      // one cursor: a tap puts it there, unless the tap is on it (then it is just picked up)
      if (!cur) this.cursors = [{ hz }];
      else if (Math.abs(freqToX(cur.hz, this.box, axis()) - x) >= 28) cur.hz = hz;
      dragging = true;
      this.draw();
    });
    this.host.addEventListener('pointermove', (e) => {
      if (fingers.has(e.pointerId)) fingers.set(e.pointerId, xAt(e));
      if (pinch) {
        const [xa, xb] = pinch.ids.map((id) => fingers.get(id));
        const r = pinchRange(this.opts.scale || 'log', this.box, pinch.fa, pinch.fb, xa, xb);
        if (r && (r[0] !== this.opts.fmin || r[1] !== this.opts.fmax)) {
          this.opts = { ...this.opts, fmin: r[0], fmax: r[1] };
          this.draw();
          this.onZoom(r, false);
        }
        return;
      }
      if (!dragging || !this.cursors.length) return;
      this.cursors[0].hz = xToFreq(xAt(e), this.box, axis());
      this.draw();
    });
    const end = (e) => {
      fingers.delete(e.pointerId);
      dragging = false;
      if (pinch && fingers.size < 2) {
        pinch = null;
        this.onZoom([this.opts.fmin ?? FMIN, this.opts.fmax ?? FMAX], true);
      }
    };
    this.host.addEventListener('pointerup', end);
    this.host.addEventListener('pointercancel', end);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
