// Level over time: the Fast dB(A) every 0.1 s, the recording's Leq as a dashed line and the
// playback position. Tap or drag to seek.

import { SPECTRUM_COLORS } from './spectrum.js';
import { fmtClock } from './format.js';

const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

export class TimelineView {
  constructor(host, { onSeek = null } = {}) {
    this.host = host;
    this.onSeek = onSeek;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '시간별 소음도 그래프');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.data = null;
    this.playhead = null;
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    let dragging = false;
    const seek = (e) => {
      if (!this.data || !this.box) return;
      const x = e.clientX - this.host.getBoundingClientRect().left;
      const t = ((x - this.box.x0) / (this.box.x1 - this.box.x0)) * this.data.duration;
      this.onSeek?.(Math.max(0, Math.min(this.data.duration, t)));
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

  // history: level every `step` seconds; leq drawn as a reference line.
  set(history, step, leq, unit = 'dB(A)') {
    this.data = { history, step, leq, unit, duration: history.length * step };
    this.draw();
  }

  setPlayhead(t) {
    this.playhead = t;
    this.draw();
  }

  draw() {
    if (!this.w || !this.data || this.host.offsetParent === null) return;
    const { g, data } = this;
    const c = SPECTRUM_COLORS;
    const k = this.w < 360 ? 0.92 : 1;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    const box = (this.box = { x0: 30 * k, x1: this.w - 6 * k, yTop: 8 * k, yBot: this.h - 22 * k });
    const vals = Array.from(data.history).filter(Number.isFinite);
    if (!vals.length) return;
    let lo = Math.floor((Math.min(...vals) - 3) / 10) * 10;
    let hi = Math.ceil((Math.max(...vals) + 3) / 10) * 10;
    if (hi - lo < 20) lo = hi - 20;
    const y = (v) => box.yBot - (((Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo) - lo) / (hi - lo)) * (box.yBot - box.yTop);
    const x = (t) => box.x0 + (t / data.duration) * (box.x1 - box.x0);

    g.font = `500 ${11 * k}px ${c.font}`;
    g.lineWidth = 1;
    g.strokeStyle = c.grid;
    g.fillStyle = c.axis;
    g.textAlign = 'left';
    const stepDb = hi - lo > 60 ? 20 : 10;
    for (let v = lo; v <= hi; v += stepDb) {
      const yy = Math.round(y(v)) + 0.5;
      g.beginPath();
      g.moveTo(box.x0, yy);
      g.lineTo(box.x1, yy);
      g.stroke();
      g.fillText(String(v), 2 * k, yy + 4 * k);
    }
    const tick = TICKS.find((s) => data.duration / s <= 6) || 600;
    for (let t = 0; t <= data.duration + 1e-6; t += tick) {
      const xx = Math.round(x(t)) + 0.5;
      g.beginPath();
      g.moveTo(xx, box.yTop);
      g.lineTo(xx, box.yBot);
      g.stroke();
      g.textAlign = t === 0 ? 'left' : 'center';
      g.fillText(fmtClock(t), Math.min(box.x1 - 14 * k, xx), this.h - 6 * k);
    }

    g.beginPath();
    data.history.forEach((v, i) => g[i ? 'lineTo' : 'moveTo'](x((i + 1) * data.step), y(v)));
    g.strokeStyle = '#ffb547';
    g.lineWidth = 1.6 * k;
    g.lineJoin = 'round';
    g.stroke();

    if (Number.isFinite(data.leq)) {
      g.setLineDash([6 * k, 4 * k]);
      g.strokeStyle = 'rgba(255,255,255,0.6)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(box.x0, y(data.leq));
      g.lineTo(box.x1, y(data.leq));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.textAlign = 'right';
      g.fillText(`Leq ${data.leq.toFixed(1)} ${data.unit}`, box.x1 - 4 * k, Math.max(box.yTop + 11 * k, y(data.leq) - 5 * k));
    }
    if (this.playhead != null) {
      g.strokeStyle = '#ffffff';
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x(this.playhead), box.yTop);
      g.lineTo(x(this.playhead), box.yBot);
      g.stroke();
    }
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
