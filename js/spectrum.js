// Large canvas spectrum: x = 1/3-octave bands (Hz, log spaced), y = A-weighted level dB(A).
// Bars are the current (or averaged) band levels, thin marks the maximum held per band,
// and the separate bar on the right is the overall dB(A). Used live and on saved results.

import { BANDS, zoneOfFrequency } from './dsp.js';
import { fmtDb } from './format.js';

const ZONE_LABEL = { low: '저음', mid: '중음', high: '고음' };
const SPAN = 90; // dB shown on the y axis

export class SpectrumChart {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '주파수별 소음도 그래프 (가로: 주파수 Hz, 세로: dB(A))');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.data = { levels: null, holds: null, overall: null, verdict: 'none' };
    this.top = 100; // grows when the signal needs it, never shrinks while the chart lives
    this.readColors();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.scheme = matchMedia('(prefers-color-scheme: dark)');
    this.onScheme = () => {
      this.readColors();
      this.draw();
    };
    this.scheme.addEventListener?.('change', this.onScheme);
  }

  readColors() {
    const cs = getComputedStyle(this.host);
    const v = (name) => cs.getPropertyValue(name).trim();
    this.c = {
      ink: v('--ink'),
      ink2: v('--ink-2'),
      ink3: v('--ink-3'),
      line: v('--line'),
      zone: v('--chart-zone'),
      bar: v('--chart-bar'),
      peak: v('--chart-peak'),
      hold: v('--chart-hold'),
      ok: v('--ok'),
      warn: v('--warn'),
      over: v('--over'),
      font: v('--font') || 'sans-serif',
    };
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

  update(data) {
    Object.assign(this.data, data);
    this.draw();
  }

  draw() {
    const { g, w, h, c } = this;
    if (!w || !h) return;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const { levels, holds, overall, verdict } = this.data;
    const small = h < 220 || w < 360;
    const fs = small ? 10 : 12;
    const font = (size, weight = 500) => `${weight} ${size}px ${c.font}`;

    const finite = [...(levels || []), ...(holds || []), overall].filter(Number.isFinite);
    const need = finite.length ? Math.max(...finite) + 4 : 0;
    while (need > this.top && this.top < 150) this.top += 10;
    const top = this.top;
    const bottom = top - SPAN;

    const L = small ? 28 : 34;
    const R = 4;
    const T = fs * 2 + 16; // unit title on the first line, zone names on the second
    const B = fs * 2 + 12;
    const overallW = Math.max(small ? 30 : 38, w * 0.07);
    const x0 = L;
    const x1 = w - R - overallW - 10;
    const yTop = T;
    const yBot = h - B;
    const y = (v) => yBot - ((Math.max(bottom, Math.min(top, v)) - bottom) / SPAN) * (yBot - yTop);
    const n = BANDS.length;
    const slot = (x1 - x0) / n;

    // low / mid / high shading with names
    let start = 0;
    g.textBaseline = 'alphabetic';
    for (let i = 1; i <= n; i++) {
      const zone = zoneOfFrequency(BANDS[start].exact);
      if (i < n && zoneOfFrequency(BANDS[i].exact) === zone) continue;
      if (zone !== 'mid') {
        g.fillStyle = c.zone;
        g.fillRect(x0 + start * slot, yTop - fs - 6, (i - start) * slot, yBot - yTop + fs + 6);
      }
      g.fillStyle = c.ink2;
      g.font = font(fs, 700);
      g.textAlign = 'center';
      g.fillText(ZONE_LABEL[zone], x0 + ((start + i) / 2) * slot, yTop - 4);
      start = i;
    }

    // horizontal grid + dB labels
    const step = (yBot - yTop) / SPAN * 10 < 16 ? 20 : 10;
    g.font = font(fs);
    g.textAlign = 'right';
    for (let v = bottom; v <= top; v += step) {
      const yy = Math.round(y(v)) + 0.5;
      g.strokeStyle = c.line;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x0, yy);
      g.lineTo(w - R, yy);
      g.stroke();
      g.fillStyle = c.ink3;
      g.fillText(String(v), x0 - 5, yy + fs * 0.35);
    }
    g.textAlign = 'left';
    g.fillStyle = c.ink2;
    g.font = font(fs, 700);
    g.fillText('dB(A)', 0, fs);

    // band bars
    let peak = -1;
    levels?.forEach((v, i) => {
      if (Number.isFinite(v) && (peak < 0 || v > levels[peak])) peak = i;
    });
    const barW = Math.max(1, slot * 0.7);
    levels?.forEach((v, i) => {
      if (!Number.isFinite(v) || v <= bottom) return;
      const by = y(v);
      g.fillStyle = i === peak ? c.peak : c.bar;
      g.fillRect(x0 + i * slot + (slot - barW) / 2, by, barW, yBot - by);
    });
    holds?.forEach((v, i) => {
      if (!Number.isFinite(v) || v <= bottom) return;
      g.fillStyle = c.hold;
      g.fillRect(x0 + i * slot + (slot - barW) / 2, Math.round(y(v)) - 1, barW, 2.5);
    });

    // x axis labels at octave centres
    g.font = font(fs);
    g.textAlign = 'center';
    g.fillStyle = c.ink3;
    BANDS.forEach((b, i) => {
      if (b.major || (!small && slot > 22)) g.fillText(b.label, x0 + (i + 0.5) * slot, yBot + fs + 4);
    });
    g.textAlign = 'right';
    g.fillStyle = c.ink2;
    g.font = font(fs, 700);
    g.fillText('주파수 (Hz)', x1, h - 4);

    // value over the loudest band
    if (peak >= 0 && levels[peak] > bottom) {
      const px = Math.min(x1 - 20, Math.max(x0 + 20, x0 + (peak + 0.5) * slot));
      const top = Math.min(y(levels[peak]), holds && Number.isFinite(holds[peak]) ? y(holds[peak]) : Infinity);
      g.textAlign = 'center';
      g.fillStyle = c.ink;
      g.font = font(fs, 800);
      g.fillText(`${BANDS[peak].label}Hz`, px, Math.max(yTop + fs, top - 6));
    }

    // overall dB(A) bar
    const ox = w - R - overallW;
    g.strokeStyle = c.line;
    g.beginPath();
    g.moveTo(ox - 5.5, yTop - fs - 6);
    g.lineTo(ox - 5.5, yBot);
    g.stroke();
    if (Number.isFinite(overall) && overall > bottom) {
      const oy = y(overall);
      g.fillStyle = { ok: c.ok, warn: c.warn, over: c.over }[verdict] || c.ink2;
      g.fillRect(ox + overallW * 0.15, oy, overallW * 0.7, yBot - oy);
      g.fillStyle = c.ink;
      g.font = font(fs, 800);
      g.textAlign = 'center';
      g.fillText(fmtDb(overall), ox + overallW / 2, Math.max(yTop + fs, oy - 6));
    }
    g.fillStyle = c.ink2;
    g.font = font(fs, 700);
    g.textAlign = 'center';
    g.fillText('전체', ox + overallW / 2, yBot + fs + 4);
  }

  destroy() {
    this.ro.disconnect();
    this.scheme.removeEventListener?.('change', this.onScheme);
    this.canvas.remove();
  }
}
