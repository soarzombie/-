// Real-time FFT spectrum: x = frequency (log or linear), y = dB(A) per FFT bin.
// Grey area = maximum held since the last reset, red area = current spectrum,
// labels mark the strongest tonal peaks. drawSpectrum() is also used for the share image.

import { rangeIndex, reduceRanges } from './dsp.js';

const LOG_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
const FMIN = 20;
const FMAX = 20000;

export const SPECTRUM_COLORS = {
  grid: '#272b33',
  axis: '#7d8592',
  max: 'rgba(120, 126, 138, 0.55)',
  maxLine: 'rgba(170, 176, 188, 0.7)',
  cur: 'rgba(214, 58, 72, 0.9)',
  curLine: '#ffe3e6',
  label: '#ffffff',
  labelBg: 'rgba(12, 14, 18, 0.72)',
  font: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
};

const hzLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

// One column per pixel: its frequency range and where those frequencies sit in `freqs`.
function columns(freqs, x0, x1, scale, fmax) {
  const n = Math.max(2, Math.round(x1 - x0));
  const fAt =
    scale === 'log'
      ? (i) => FMIN * (fmax / FMIN) ** (i / n)
      : (i) => (fmax * i) / n;
  const edges = Float32Array.from({ length: n + 1 }, (_, i) => fAt(i));
  const centres = Float32Array.from({ length: n }, (_, i) => fAt(i + 0.5));
  return { n, edges, centres, idx: rangeIndex(freqs, edges), cur: new Float32Array(n), max: new Float32Array(n) };
}

// data: { freqs, cur, max?, peaks? }   opts: { scale, range: [lo, hi], fontScale, colors, cache }
export function drawSpectrum(g, w, h, data, opts = {}) {
  const c = opts.colors || SPECTRUM_COLORS;
  const k = opts.fontScale || 1;
  const fs = 11 * k;
  const font = (size, weight = 500) => `${weight} ${size}px ${c.font}`;
  const [lo, hi] = opts.range || [-20, 100];
  const scale = opts.scale || 'log';
  const { freqs } = data;
  const fmax = Math.min(FMAX, freqs[freqs.length - 1]);

  const L = 30 * k;
  const R = 6 * k;
  const T = 8 * k;
  const B = 22 * k;
  const x0 = L;
  const x1 = w - R;
  const yTop = T;
  const yBot = h - B;
  const y = (v) => yBot - (((v > lo ? Math.min(hi, v) : lo) - lo) / (hi - lo)) * (yBot - yTop); // NaN/-Inf -> floor
  const xOf =
    scale === 'log'
      ? (f) => x0 + (Math.log(f / FMIN) / Math.log(fmax / FMIN)) * (x1 - x0)
      : (f) => x0 + (f / fmax) * (x1 - x0);

  // grid + axes
  g.lineWidth = 1;
  g.strokeStyle = c.grid;
  g.fillStyle = c.axis;
  g.font = font(fs);
  g.textAlign = 'left';
  for (let v = lo; v <= hi; v += 20) {
    const yy = Math.round(y(v)) + 0.5;
    g.beginPath();
    g.moveTo(x0, yy);
    g.lineTo(x1, yy);
    g.stroke();
    g.fillText(String(v), 2 * k, yy + fs * 0.35);
  }
  g.fillText('dB(A)', 2 * k, Math.max(fs, y(hi - 10) + fs * 0.35));
  const ticks =
    scale === 'log'
      ? LOG_TICKS.filter((f) => f <= fmax)
      : Array.from({ length: Math.floor(fmax / 2000) + 1 }, (_, i) => i * 2000).filter((f) => (x1 - x0) / (fmax / 2000) > 34 * k || f % 4000 === 0);
  ticks.forEach((f, i) => {
    const xx = Math.round(xOf(Math.max(f, scale === 'log' ? FMIN : 0))) + 0.5;
    g.beginPath();
    g.moveTo(xx, yTop);
    g.lineTo(xx, yBot);
    g.stroke();
    // the first label carries the unit; the last is right-aligned so it stays inside
    const last = i === ticks.length - 1 && xx > x1 - 20 * k;
    g.textAlign = i === 0 ? 'left' : last ? 'right' : 'center';
    g.fillText(i === 0 ? `${hzLabel(f)} Hz` : hzLabel(f), i === 0 ? x0 : last ? x1 : xx, yBot + fs + 6 * k);
  });

  // curves
  const cache = opts.cache || {};
  const key = `${Math.round(x1 - x0)}|${scale}|${freqs.length}|${freqs[1]}|${fmax}`;
  if (cache.key !== key) Object.assign(cache, { key, cols: columns(freqs, x0, x1, scale, fmax) });
  const cols = cache.cols;
  const area = (levels, out, fill, stroke) => {
    reduceRanges(levels, freqs, cols.idx, cols.centres, out);
    g.beginPath();
    g.moveTo(x0, yBot);
    for (let i = 0; i < cols.n; i++) g.lineTo(x0 + i + 0.5, y(out[i]));
    g.lineTo(x0 + cols.n, yBot);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
    if (stroke) {
      g.beginPath();
      for (let i = 0; i < cols.n; i++) g[i ? 'lineTo' : 'moveTo'](x0 + i + 0.5, y(out[i]));
      g.strokeStyle = stroke;
      g.lineWidth = 1.2 * k;
      g.stroke();
    }
  };
  g.save();
  g.beginPath();
  g.rect(x0, yTop, x1 - x0, yBot - yTop);
  g.clip();
  if (data.max) area(data.max, cols.max, c.max, c.maxLine);
  if (data.cur) area(data.cur, cols.cur, c.cur, c.curLine);
  g.restore();

  // peak labels
  (data.peaks || []).forEach((p) => {
    if (!(p.hz >= (scale === 'log' ? FMIN : 0) && p.hz <= fmax)) return;
    const px = xOf(p.hz);
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
}

// Canvas that follows its host's size and redraws on update().
export class SpectrumView {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '실시간 주파수 분석 그래프 (가로: 주파수 Hz, 세로: dB(A))');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.cache = {};
    this.data = null;
    this.opts = {};
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
  }

  resize() {
    const r = this.host.getBoundingClientRect();
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
    if (!this.w || !this.data) return;
    const { g } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    drawSpectrum(g, this.w, this.h, this.data, { ...this.opts, fontScale: this.w < 360 ? 0.92 : 1, cache: this.cache });
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
