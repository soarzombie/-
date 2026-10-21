// Spectrogram (waterfall): x = the same 20 Hz – 20 kHz axis as the spectrum, y = time with the
// newest sound at the top, colour = weighted dB. Live it scrolls down as rows arrive; for a saved
// analysis it is built once from the recorded sound, with a playhead while it plays back.

import { reduceRanges } from './dsp.js';
import { SPECTRUM_COLORS, plotBox, columnsFor, drawXAxis, freqAxis, FMIN, FMAX } from './spectrum.js';
import { fmtClock } from './format.js';

const SPAN = 60; // dB of colour range below the running top, when the range is automatic

// Dark violet -> red -> yellow -> white, readable on the black panel.
const STOPS = [
  [0, [6, 6, 14]],
  [0.2, [44, 11, 87]],
  [0.42, [120, 28, 109]],
  [0.62, [195, 59, 76]],
  [0.8, [245, 125, 21]],
  [0.92, [251, 193, 43]],
  [1, [252, 255, 164]],
];
const LUT = (() => {
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    const j = STOPS.findIndex(([s]) => s >= t);
    const [s1, c1] = STOPS[Math.max(1, j)];
    const [s0, c0] = STOPS[Math.max(0, j - 1)];
    const u = s1 > s0 ? (t - s0) / (s1 - s0) : 0;
    for (let ch = 0; ch < 3; ch++) lut[i * 3 + ch] = c0[ch] + (c1[ch] - c0[ch]) * u;
  }
  return lut;
})();

export class SpectrogramView {
  constructor(host, { rowsPerSec = 20, onSeek = null } = {}) {
    this.host = host;
    this.rowsPerSec = rowsPerSec;
    this.unit = 'dB(A)';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '시간에 따른 주파수 변화 (스펙트로그램)');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.img = document.createElement('canvas'); // history, 1 px per column and per row
    this.ig = this.img.getContext('2d');
    this.scale = 'log';
    this.fmin = FMIN;
    this.fmax = FMAX;
    this.colorRange = null; // [lo, hi] dB, or null = automatic (60 dB below the loudest)
    this.xLabels = true;
    this.top = null;
    this.staticData = null;
    this.playhead = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    if (onSeek) {
      // saved sound: tap a row to play from there (bottom = start, top = end)
      let dragging = false;
      const seek = (e) => {
        if (!this.staticData || !this.box) return;
        const yy = e.clientY - this.host.getBoundingClientRect().top;
        const t = ((this.box.yBot - yy) / (this.box.yBot - this.box.yTop)) * this.staticData.durationSec;
        onSeek(Math.max(0, Math.min(this.staticData.durationSec, t)));
      };
      host.addEventListener('pointerdown', (e) => {
        dragging = true;
        host.setPointerCapture?.(e.pointerId);
        seek(e);
      });
      host.addEventListener('pointermove', (e) => dragging && seek(e));
      host.addEventListener('pointerup', () => (dragging = false));
      host.addEventListener('pointercancel', () => (dragging = false));
    }
  }

  configure({ scale = this.scale, xLabels = this.xLabels, fmin = this.fmin, fmax = this.fmax, colorRange = this.colorRange } = {}) {
    if (scale === this.scale && xLabels === this.xLabels && fmin === this.fmin && fmax === this.fmax && String(colorRange) === String(this.colorRange)) return;
    Object.assign(this, { scale, xLabels, fmin, fmax, colorRange });
    this.resize();
  }

  get axis() {
    return freqAxis(this.scale, this.fmin, this.fmax);
  }

  // dB at the bottom of the colour scale and the span above it
  colours(top) {
    return this.colorRange ? [this.colorRange[0], this.colorRange[1] - this.colorRange[0]] : [top - SPAN, SPAN];
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
    this.box = plotBox(this.w, this.h, this.fontScale, this.xLabels);
    this.img.width = Math.max(2, Math.round(this.box.x1 - this.box.x0));
    this.img.height = Math.max(2, Math.round(this.box.yBot - this.box.yTop));
    this.cols = null;
    if (this.staticData) this.renderStatic();
    this.draw();
  }

  clear() {
    this.ig.clearRect(0, 0, this.img.width, this.img.height);
    this.top = null;
    this.draw();
  }

  columns(freqs) {
    const key = `${this.img.width}|${this.scale}|${this.fmin}|${this.fmax}|${freqs.length}|${freqs[1]}`;
    if (!this.cols || this.cols.key !== key) this.cols = { key, ...columnsFor(freqs, { x0: 0, x1: this.img.width }, this.axis) };
    return this.cols;
  }

  paintRow(row, values, lo, span) {
    for (let i = 0; i < values.length; i++) {
      const t = values[i] > lo ? Math.min(1, (values[i] - lo) / span) : 0;
      const j = Math.round(t * 255) * 3;
      row.data[i * 4] = LUT[j];
      row.data[i * 4 + 1] = LUT[j + 1];
      row.data[i * 4 + 2] = LUT[j + 2];
      row.data[i * 4 + 3] = 255;
    }
  }

  // Live: add the newest spectrum (dB(A) per bin) as the top row.
  push(levels, freqs) {
    if (!this.box || this.host.offsetParent === null) return;
    const cols = this.columns(freqs);
    const values = reduceRanges(levels, freqs, cols.idx, cols.centres, cols.cur);
    let frameMax = -Infinity;
    for (const v of values) if (v > frameMax) frameMax = v;
    // colour range follows the loudest bins, rising at once and falling slowly
    this.top = this.top == null ? frameMax : Math.max(frameMax, this.top - 0.05);
    const row = this.ig.createImageData(this.img.width, 1);
    this.paintRow(row, values, ...this.colours(this.top));
    this.ig.drawImage(this.img, 0, 0, this.img.width, this.img.height - 1, 0, 1, this.img.width, this.img.height - 1);
    this.ig.putImageData(row, 0, 0);
    this.draw();
  }

  // Saved: frames are dB(A) spectra at `freqs`, oldest first, evenly spread over durationSec.
  // labels 'relative' counts back from the save moment at the top; 'absolute' shows m:ss from the start.
  setStatic(frames, freqs, durationSec, { labels = 'relative', unit = 'dB(A)' } = {}) {
    this.staticData = { frames, freqs, durationSec, labels };
    this.unit = unit;
    this.renderStatic();
    this.draw();
  }

  renderStatic() {
    const { frames, freqs } = this.staticData;
    if (!frames.length || !this.box) return;
    const cols = this.columns(freqs);
    const columnsPerFrame = frames.map((f) => Float32Array.from(reduceRanges(f, freqs, cols.idx, cols.centres, cols.cur)));
    const all = columnsPerFrame.flatMap((f) => Array.from(f)).filter(Number.isFinite).sort((a, b) => a - b);
    this.top = all.length ? all[Math.floor(all.length * 0.995)] + 2 : 60;
    const H = this.img.height;
    const W = this.img.width;
    const image = this.ig.createImageData(W, H);
    const row = { data: new Uint8ClampedArray(W * 4) };
    const values = new Float32Array(W);
    const F = frames.length;
    for (let y = 0; y < H; y++) {
      // top row = the newest frames; each row keeps the loudest of the frames it covers,
      // so a short knock in a long file still shows
      const f1 = Math.min(F - 1, Math.floor(((H - y) / H) * F));
      const f0 = Math.max(0, Math.min(f1, Math.floor(((H - y - 1) / H) * F)));
      values.fill(-Infinity);
      for (let f = f0; f <= f1; f++) {
        const col = columnsPerFrame[f];
        for (let i = 0; i < W; i++) if (col[i] > values[i]) values[i] = col[i];
      }
      this.paintRow(row, values, ...this.colours(this.top));
      image.data.set(row.data, y * W * 4);
    }
    this.ig.putImageData(image, 0, 0);
  }

  setPlayhead(sec) {
    this.playhead = sec;
    this.draw();
  }

  draw() {
    if (!this.box || this.host.offsetParent === null) return;
    const { g, box } = this;
    const k = this.fontScale;
    const c = SPECTRUM_COLORS;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.imageSmoothingEnabled = true;
    g.drawImage(this.img, box.x0, box.yTop, box.x1 - box.x0, box.yBot - box.yTop);

    // time axis: newest at the top, older further down
    const total = this.staticData ? this.staticData.durationSec : (box.yBot - box.yTop) / this.rowsPerSec;
    const every = [2, 5, 10, 15, 30, 60, 120, 300].find((s) => total / s <= 6) || 600;
    g.font = `500 ${11 * k}px ${c.font}`;
    g.fillStyle = c.axis;
    g.textAlign = 'left';
    const absolute = this.staticData?.labels === 'absolute';
    for (let s = 0; s <= total + 1e-6; s += every) {
      const yy = absolute ? box.yBot - (s / total) * (box.yBot - box.yTop) : box.yTop + (s / total) * (box.yBot - box.yTop);
      const text = absolute ? fmtClock(s) : s === 0 ? (this.staticData ? '저장' : '지금') : `-${s}초`;
      g.fillText(text, 2 * k, Math.min(box.yBot, Math.max(box.yTop + 9 * k, yy + 4 * k)));
    }
    if (this.xLabels) drawXAxis(g, box, this.h, this.axis, k, c);

    if (this.playhead != null && this.staticData) {
      const yy = box.yBot - (this.playhead / this.staticData.durationSec) * (box.yBot - box.yTop);
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(box.x0, yy);
      g.lineTo(box.x1, yy);
      g.stroke();
    }
    if (this.top != null) {
      // colour range, bottom right (the top right corner holds the chart buttons)
      const [lo, span] = this.colours(this.top);
      const text = `${Math.round(lo)}–${Math.round(lo + span)} ${this.unit}`;
      g.textAlign = 'right';
      const tw = g.measureText(text).width;
      g.fillStyle = 'rgba(6,6,14,0.7)';
      g.fillRect(box.x1 - tw - 8 * k, box.yBot - 18 * k, tw + 8 * k, 18 * k);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.fillText(text, box.x1 - 4 * k, box.yBot - 5 * k);
    }
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
