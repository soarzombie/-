// 1/3-octave bars, 25 Hz – 20 kHz: one bar per band (energy sum of the FFT bins in it), a mark
// for each band's maximum since reset, and the overall level as a last, wider bar.

import { BANDS } from './dsp.js';
import { SPECTRUM_COLORS } from './spectrum.js';

const BAR = { fill: 'rgba(214, 58, 72, 0.9)', top: '#ffe3e6', line: '#e3f36a', total: '#5c6474', mark: '#c9ced8' };

export class OctaveView {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '1/3 옥타브 막대 그래프 (25Hz–20kHz)');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.data = null;
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

  // bands / max: dB per band (BANDS order); total: overall level.
  // opts: { range: [lo, hi], unit, style: 'fill' | 'line' }
  update(data, opts = {}) {
    this.data = data;
    this.opts = opts;
    this.draw();
  }

  draw() {
    if (!this.w || !this.data || this.host.offsetParent === null) return;
    const { g, w, h } = this;
    const c = SPECTRUM_COLORS;
    const k = w < 360 ? 0.92 : 1;
    const fs = 11 * k;
    const [lo, hi] = this.opts.range || [0, 100];
    const unit = this.opts.unit || 'dB(A)';
    const line = this.opts.style === 'line';
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const x0 = 30 * k;
    const x1 = w - 6 * k;
    const yTop = 8 * k;
    const yBot = h - 22 * k;
    const y = (v) => yBot - (((v > lo ? Math.min(hi, v) : lo) - lo) / (hi - lo)) * (yBot - yTop);

    g.lineWidth = 1;
    g.strokeStyle = c.grid;
    g.fillStyle = c.axis;
    g.font = `500 ${fs}px ${c.font}`;
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
    g.fillText(unit, 2 * k, Math.max(fs, y(hi - step / 2) + fs * 0.35));

    // 30 bands, then a gap and a double-width bar for the overall level
    const n = BANDS.length;
    const slot = (x1 - x0) / (n + 3);
    const gap = Math.max(1, slot * 0.18);
    const { bands, max, total } = this.data;
    BANDS.forEach((b, i) => {
      const bx = x0 + i * slot + gap / 2;
      const bw = slot - gap;
      const v = bands[i];
      if (Number.isFinite(v) && v > lo) {
        const yy = y(v);
        g.fillStyle = line ? BAR.line : BAR.fill;
        g.globalAlpha = line ? 0.85 : 1;
        g.fillRect(bx, yy, bw, yBot - yy);
        g.globalAlpha = 1;
        if (!line) {
          g.fillStyle = BAR.top;
          g.fillRect(bx, yy, bw, Math.min(2 * k, yBot - yy));
        }
      }
      const m = max?.[i];
      if (Number.isFinite(m) && m > lo) {
        g.fillStyle = line ? c.lineMax : BAR.mark;
        g.fillRect(bx, y(m) - 1.5 * k, bw, 3 * k);
      }
      if (b.major) {
        g.fillStyle = c.axis;
        g.textAlign = 'center';
        g.fillText(b.label, bx + bw / 2, h - 6 * k);
      }
    });
    const tx = x0 + (n + 1) * slot;
    const tw = 2 * slot - gap;
    if (Number.isFinite(total) && total > lo) {
      const yy = y(total);
      g.fillStyle = BAR.total;
      g.fillRect(tx, yy, tw, yBot - yy);
      g.fillStyle = c.label;
      g.textAlign = 'center';
      g.font = `700 ${fs}px ${c.font}`;
      g.fillText(total.toFixed(0), tx + tw / 2, Math.max(yTop + fs, yy - 4 * k));
    }
    g.fillStyle = c.axis;
    g.textAlign = 'center';
    g.font = `500 ${fs}px ${c.font}`;
    g.fillText('전체', tx + tw / 2, h - 6 * k);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
