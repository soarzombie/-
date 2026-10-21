// Real-time FFT spectrum: x = frequency 20 Hz – 20 kHz (log) or 0 – 20 kHz (linear), y = weighted dB per FFT bin.
// Style 'fill': red area = current, grey area = maximum held since reset.
// Style 'line': yellow line = current, pink line = maximum.
// Labels mark the strongest tonal peaks; cursors A/B are crosshairs that read exact values. drawSpectrum() is
// also used for the share image, and the layout helpers keep the spectrogram aligned with it.

import { rangeIndex, reduceRanges } from './dsp.js';

const LOG_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
export const FMIN = 20;
export const FMAX = 20000;

export const SPECTRUM_COLORS = {
  grid: '#272b33',
  axis: '#7d8592',
  max: 'rgba(120, 126, 138, 0.55)',
  maxLine: 'rgba(170, 176, 188, 0.7)',
  cur: 'rgba(214, 58, 72, 0.9)',
  curLine: '#ffe3e6',
  lineCur: '#e3f36a',
  lineMax: '#ff6fae',
  cursor: '#5cc8ff',
  label: '#ffffff',
  labelBg: 'rgba(12, 14, 18, 0.72)',
  font: '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif',
};

const hzLabel = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));

// Plot rectangle inside a w x h drawing; shared by the spectrum and the spectrogram.
export function plotBox(w, h, k = 1, xLabels = true) {
  return { x0: 30 * k, x1: w - 6 * k, yTop: 8 * k, yBot: h - (xLabels ? 22 * k : 4 * k) };
}

export function freqToX(f, box, scale) {
  const t = scale === 'log' ? Math.log(Math.max(f, FMIN) / FMIN) / Math.log(FMAX / FMIN) : f / FMAX;
  return box.x0 + t * (box.x1 - box.x0);
}

export function xToFreq(x, box, scale) {
  const t = Math.max(0, Math.min(1, (x - box.x0) / (box.x1 - box.x0)));
  return scale === 'log' ? FMIN * (FMAX / FMIN) ** t : Math.max(1, t * FMAX);
}

// One column per pixel: its frequency range and where those frequencies sit in `freqs`.
export function columnsFor(freqs, box, scale) {
  const n = Math.max(2, Math.round(box.x1 - box.x0));
  const fAt = scale === 'log' ? (i) => FMIN * (FMAX / FMIN) ** (i / n) : (i) => (FMAX * i) / n;
  const edges = Float32Array.from({ length: n + 1 }, (_, i) => fAt(i));
  const centres = Float32Array.from({ length: n }, (_, i) => fAt(i + 0.5));
  return { n, centres, idx: rangeIndex(freqs, edges), cur: new Float32Array(n), max: new Float32Array(n) };
}

export function drawXAxis(g, box, h, scale, k, c) {
  const fs = 11 * k;
  g.font = `500 ${fs}px ${c.font}`;
  g.fillStyle = c.axis;
  const ticks =
    scale === 'log'
      ? LOG_TICKS
      : Array.from({ length: FMAX / 2000 + 1 }, (_, i) => i * 2000).filter((f) => (box.x1 - box.x0) / 10 > 34 * k || f % 4000 === 0);
  ticks.forEach((f, i) => {
    const xx = freqToX(f, box, scale);
    // the first label carries the unit; the last is right-aligned so it stays inside
    const last = i === ticks.length - 1;
    g.textAlign = i === 0 ? 'left' : last ? 'right' : 'center';
    g.fillText(i === 0 ? `${hzLabel(f)} Hz` : hzLabel(f), i === 0 ? box.x0 : last ? box.x1 : xx, h - 6 * k);
  });
}

// data: { freqs, cur, max?, peaks? }
// opts: { scale, style, range: [lo, hi], unit, fontScale, colors, cache, xLabels, cursors: [{ hz, name }] }
// Returns the plot box and the per-column values it drew (for cursor read-outs).
export function drawSpectrum(g, w, h, data, opts = {}) {
  const c = opts.colors || SPECTRUM_COLORS;
  const k = opts.fontScale || 1;
  const fs = 11 * k;
  const font = (size, weight = 500) => `${weight} ${size}px ${c.font}`;
  const [lo, hi] = opts.range || [-20, 100];
  const scale = opts.scale || 'log';
  const line = opts.style === 'line';
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
  const ticks = scale === 'log' ? LOG_TICKS : Array.from({ length: FMAX / 2000 + 1 }, (_, i) => i * 2000);
  ticks.forEach((f) => {
    const xx = Math.round(freqToX(f, box, scale)) + 0.5;
    g.beginPath();
    g.moveTo(xx, yTop);
    g.lineTo(xx, yBot);
    g.stroke();
  });
  if (xLabels) drawXAxis(g, box, h, scale, k, c);

  // curves
  const cache = opts.cache || {};
  const key = `${Math.round(x1 - x0)}|${scale}|${freqs.length}|${freqs[1]}|${freqs[freqs.length - 1]}`;
  if (cache.key !== key) Object.assign(cache, { key, cols: columnsFor(freqs, box, scale) });
  const cols = cache.cols;
  const curve = (levels, out, fill, stroke, width) => {
    reduceRanges(levels, freqs, cols.idx, cols.centres, out);
    if (fill) {
      g.beginPath();
      g.moveTo(x0, yBot);
      for (let i = 0; i < cols.n; i++) g.lineTo(x0 + i + 0.5, y(out[i]));
      g.lineTo(x0 + cols.n, yBot);
      g.closePath();
      g.fillStyle = fill;
      g.fill();
    }
    g.beginPath();
    for (let i = 0; i < cols.n; i++) g[i ? 'lineTo' : 'moveTo'](x0 + i + 0.5, y(out[i]));
    g.strokeStyle = stroke;
    g.lineWidth = width * k;
    g.stroke();
  };
  g.save();
  g.beginPath();
  g.rect(x0, yTop, x1 - x0, yBot - yTop);
  g.clip();
  g.lineJoin = 'round';
  if (data.max) curve(data.max, cols.max, line ? null : c.max, line ? c.lineMax : c.maxLine, line ? 1.4 : 1.2);
  if (data.cur) curve(data.cur, cols.cur, line ? null : c.cur, line ? c.lineCur : c.curLine, line ? 1.6 : 1.2);
  g.restore();

  // peak labels
  (data.peaks || []).forEach((p) => {
    if (!(p.hz >= (scale === 'log' ? FMIN : 0) && p.hz <= FMAX)) return;
    const px = freqToX(p.hz, box, scale);
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

  // cursors: a crosshair at the curve, with the frequency and level next to the point
  (opts.cursors || []).forEach((cur) => {
    const cx = Math.round(freqToX(cur.hz, box, scale)) + 0.5;
    const col = Math.max(0, Math.min(cols.n - 1, Math.floor(cx - x0)));
    const v = data.cur ? cols.cur[col] : NaN;
    g.strokeStyle = c.cursor;
    g.lineWidth = 1.2 * k;
    g.beginPath();
    g.moveTo(cx, yTop);
    g.lineTo(cx, yBot);
    g.stroke();
    if (Number.isFinite(v) && v > lo) {
      const cy = Math.round(y(v)) + 0.5;
      g.globalAlpha = 0.75;
      g.beginPath();
      g.moveTo(x0, cy);
      g.lineTo(x1, cy);
      g.stroke();
      g.globalAlpha = 1;
      g.fillStyle = c.cursor;
      g.beginPath();
      g.arc(cx, cy, 4 * k, 0, Math.PI * 2);
      g.fill();
      const hzText = `${Math.round(cur.hz).toLocaleString('ko-KR')} Hz`;
      const dbText = `${v.toFixed(1)} ${opts.unit || 'dB(A)'}`;
      g.font = font(13 * k, 700);
      const tag = 16 * k; // the cursor's letter, left of the numbers
      const tw = Math.max(g.measureText(hzText).width, g.measureText(dbText).width) + tag + 14 * k;
      const th = 38 * k;
      const gap = 8 * k;
      const bx = cx + gap + tw <= x1 ? cx + gap : cx - gap - tw;
      const by = cy + gap + th <= yBot ? cy + gap : Math.max(yTop + 20 * k, cy - gap - th);
      g.fillStyle = c.labelBg;
      g.beginPath();
      g.roundRect ? g.roundRect(bx, by, tw, th, 6 * k) : g.rect(bx, by, tw, th);
      g.fill();
      g.fillStyle = c.cursor;
      g.beginPath();
      g.roundRect ? g.roundRect(bx + 5 * k, by + 5 * k, tag, tag, 4 * k) : g.rect(bx + 5 * k, by + 5 * k, tag, tag);
      g.fill();
      g.textAlign = 'center';
      g.fillStyle = '#0b0d10';
      g.font = font(12 * k, 800);
      g.fillText(cur.name, bx + 5 * k + tag / 2, by + 17.5 * k);
      g.textAlign = 'left';
      g.font = font(13 * k, 700);
      g.fillStyle = c.label;
      g.fillText(hzText, bx + tag + 9 * k, by + 16 * k);
      g.fillStyle = c.cursor;
      g.fillText(dbText, bx + tag + 9 * k, by + 32 * k);
    }
  });

  return { box, cols };
}

// Canvas that follows its host's size and redraws on update(). With `cursor`, tapping the chart
// places cursor A, a second tap places B, and dragging moves the one under the finger.
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
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (cursor) this.enableCursor();
  }

  get fontScale() {
    return this.w < 360 ? 0.92 : 1;
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
    if (!this.w || !this.data || this.host.offsetParent === null) return;
    const { g } = this;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const cursors = this.cursors.map((c, i) => ({ hz: c.hz, name: 'AB'[i] }));
    const { box, cols } = drawSpectrum(g, this.w, this.h, this.data, { ...this.opts, fontScale: this.fontScale, cache: this.cache, cursors });
    this.box = box;
    if (this.onCursor) {
      const scale = this.opts.scale || 'log';
      this.onCursor(
        this.cursors.map((c) => {
          const col = Math.max(0, Math.min(cols.n - 1, Math.floor(freqToX(c.hz, box, scale) - box.x0)));
          return { hz: c.hz, cur: this.data.cur ? cols.cur[col] : NaN, max: this.data.max ? cols.max[col] : NaN };
        }),
      );
    }
  }

  clearCursors() {
    this.cursors = [];
    this.draw();
  }

  enableCursor() {
    let dragging = -1;
    const scale = () => this.opts.scale || 'log';
    const xAt = (e) => e.clientX - this.host.getBoundingClientRect().left;
    this.host.addEventListener('pointerdown', (e) => {
      if (!this.box) return;
      const x = xAt(e);
      const hz = xToFreq(x, this.box, scale());
      const dist = (c) => Math.abs(freqToX(c.hz, this.box, scale()) - x);
      const near = this.cursors.findIndex((c) => dist(c) < 28);
      if (near >= 0) dragging = near;
      else if (this.cursors.length < 2) {
        this.cursors.push({ hz });
        dragging = this.cursors.length - 1;
      } else {
        dragging = dist(this.cursors[0]) < dist(this.cursors[1]) ? 0 : 1;
        this.cursors[dragging].hz = hz;
      }
      this.host.setPointerCapture?.(e.pointerId);
      this.draw();
    });
    this.host.addEventListener('pointermove', (e) => {
      if (dragging < 0) return;
      this.cursors[dragging].hz = xToFreq(xAt(e), this.box, scale());
      this.draw();
    });
    const end = () => (dragging = -1);
    this.host.addEventListener('pointerup', end);
    this.host.addEventListener('pointercancel', end);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
