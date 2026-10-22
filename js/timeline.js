// Level over time. TimelineView: a whole recording, the Fast level every 0.1 s, its Leq as a dashed
// line and the playback position; tap or drag to seek. LiveTimelineView: the analyzer's time-axis graph,
// the live Fast level over the last 30 s – 5 min of measuring, newest at the right, under the spectrum.
// Both label the time axis with the measuring time, or with the clock time where it is known (시간축
// 표시: 현재 시각).

import { SPECTRUM_COLORS } from './spectrum.js';
import { fmtClock, fmtTimeOfDay } from './format.js';

const TICKS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

// Where a run of clock times (ms, rising) passes a multiple of tickMs: [[index, that time]]. A pause
// in between shows as one tick at the time measuring went on.
export function clockTicks(times, from, to, tickMs) {
  const out = [];
  for (let i = Math.max(from, 1); i < to; i++) {
    const a = Math.floor(times[i - 1] / tickMs);
    const b = Math.floor(times[i] / tickMs);
    if (b > a) out.push([i, b * tickMs]);
  }
  return out;
}

// Time labels along the bottom, kept from running into each other.
function drawTimeLabels(g, labels, box, h, k, grid) {
  let last = -Infinity;
  for (const [xx, text] of labels) {
    const w = g.measureText(text).width;
    const align = xx < box.x0 + w / 2 ? 'left' : xx > box.x1 - w / 2 ? 'right' : 'center';
    const left = align === 'left' ? xx : align === 'right' ? xx - w : xx - w / 2;
    if (left < last + 6 * k) continue;
    last = left + w;
    if (grid) {
      g.beginPath();
      g.moveTo(Math.round(xx) + 0.5, box.yTop);
      g.lineTo(Math.round(xx) + 0.5, box.yBot);
      g.stroke();
    }
    g.textAlign = align;
    g.fillText(text, xx, h - 6 * k);
  }
}

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

  // history: level every `step` seconds; leq drawn as a reference line. For clock-time labels: start
  // (ms at time 0) or times (ms of each value, for a measurement with pauses), and clock: true.
  set(history, step, leq, unit = 'dB(A)', { start = null, times = null, clock = false } = {}) {
    this.data = { history, step, leq, unit, duration: history.length * step, start, times };
    this.clock = clock;
    this.draw();
  }

  // 시간축 표시 changed: clock time (where known) or measuring time
  setClock(clock) {
    this.clock = clock;
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
    const labels = [];
    if (this.clock && data.times?.length) {
      for (const [i, ms] of clockTicks(data.times, 0, data.times.length, tick * 1000)) labels.push([x((i + 1) * data.step), fmtTimeOfDay(ms, tick < 60)]);
    } else if (this.clock && Number.isFinite(data.start)) {
      const tickMs = tick * 1000;
      for (let ms = Math.ceil(data.start / tickMs) * tickMs; ms <= data.start + data.duration * 1000 + 1; ms += tickMs) labels.push([x((ms - data.start) / 1000), fmtTimeOfDay(ms, tick < 60)]);
    } else {
      for (let t = 0; t <= data.duration + 1e-6; t += tick) labels.push([x(t), fmtClock(t)]);
    }
    drawTimeLabels(g, labels, box, this.h, k, true);

    g.beginPath();
    data.history.forEach((v, i) => g[i ? 'lineTo' : 'moveTo'](x((i + 1) * data.step), y(v)));
    g.strokeStyle = c.history;
    g.lineWidth = 1.6 * k;
    g.lineJoin = 'round';
    g.stroke();

    if (Number.isFinite(data.leq)) {
      g.setLineDash([6 * k, 4 * k]);
      g.strokeStyle = c.mean;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(box.x0, y(data.leq));
      g.lineTo(box.x1, y(data.leq));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = c.meanText;
      g.textAlign = 'right';
      g.fillText(`Leq ${data.leq.toFixed(1)} ${data.unit}`, box.x1 - 4 * k, Math.max(box.yTop + 11 * k, y(data.leq) - 5 * k));
    }
    if (this.playhead != null) {
      g.strokeStyle = c.playhead;
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

// Lowest and highest value per column for samples [from, to) spread over `cols` columns.
// Each column also takes the last sample of the one before, so the drawn band has no gaps.
export function columnRange(values, from, to, cols) {
  const lo = new Float32Array(cols).fill(Infinity);
  const hi = new Float32Array(cols).fill(-Infinity);
  const per = (to - from) / cols;
  for (let c = 0; c < cols; c++) {
    const a = Math.max(from, Math.floor(from + c * per) - (c ? 1 : 0));
    const b = Math.min(to, Math.max(a + 1, Math.floor(from + (c + 1) * per)));
    for (let i = a; i < b; i++) {
      const v = values[i];
      if (v < lo[c]) lo[c] = v;
      if (v > hi[c]) hi[c] = v;
    }
  }
  return { lo, hi };
}


export class LiveTimelineView {
  // step: seconds between pushed values (the meter's 50 ms blocks); keeps up to maxSec of them.
  constructor(host, { windowSec = 30, step = 0.05, maxSec = 300 } = {}) {
    this.host = host;
    this.step = step;
    this.windowSec = windowSec;
    this.cap = Math.ceil(maxSec / step);
    this.values = new Float32Array(this.cap * 2);
    this.speeds = new Float32Array(this.cap * 2); // km/h with each value (NaN = not known)
    this.times = new Float64Array(this.cap * 2); // clock time of each value, ms
    this.len = 0; // values held
    this.first = 0; // sample number of values[0]
    this.stats = { leq: NaN, unit: 'dB(A)' };
    this.yRange = null; // [lo, hi] dB, or null = fit the values shown
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'spectrum-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '시간축 그래프 (가로: 측정 시간, 세로: dB)');
    host.prepend(this.canvas);
    this.g = this.canvas.getContext('2d');
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
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

  push(db, kmh = NaN, at = Date.now()) {
    if (this.len === this.values.length) {
      // drop the older half; only the last maxSec are ever shown
      this.values.copyWithin(0, this.cap);
      this.speeds.copyWithin(0, this.cap);
      this.times.copyWithin(0, this.cap);
      this.len -= this.cap;
      this.first += this.cap;
    }
    this.speeds[this.len] = kmh ?? NaN;
    this.times[this.len] = at;
    this.values[this.len++] = Number.isFinite(db) ? db : -Infinity;
  }

  // What is held (up to the last 10 minutes of measuring), for keeping with a saved record:
  // { at: clock time of the first value, step, t: ms after it, v: dB (null = no sound) }.
  snapshot() {
    if (!this.len) return null;
    const at = this.times[0];
    return {
      at,
      step: this.step,
      t: Array.from(this.times.subarray(0, this.len), (ms) => Math.round(ms - at)),
      v: Array.from(this.values.subarray(0, this.len), (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null)),
    };
  }

  clear() {
    this.len = 0;
    this.first = 0;
    this.draw();
  }

  // speed: also draw the speed (km/h, own scale on the right) when values carry one
  // clock: label the time axis with the clock time instead of the measuring time
  configure({ windowSec = this.windowSec, leq = this.stats.leq, unit = this.stats.unit, yRange = this.yRange, speed = this.speed, clock = this.clock } = {}) {
    this.windowSec = windowSec;
    this.clock = clock;
    this.stats = { leq, unit };
    this.yRange = yRange;
    this.speed = speed;
  }

  draw() {
    if (!this.w || this.host.offsetParent === null) return;
    const { g, step } = this;
    const c = SPECTRUM_COLORS;
    const k = this.w < 360 ? 0.92 : 1;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    // same left edge as the spectrum above
    const box = { x0: 30 * k, x1: this.w - 6 * k, yTop: 8 * k, yBot: this.h - 22 * k };
    const total = this.first + this.len; // samples measured so far
    const tEnd = Math.max(total * step, this.windowSec);
    const tStart = tEnd - this.windowSec;
    const from = Math.max(0, Math.ceil(tStart / step) - this.first);
    const to = this.len;
    let vmin = Infinity;
    let vmax = -Infinity;
    for (let i = from; i < to; i++) {
      const v = this.values[i];
      if (Number.isFinite(v)) {
        if (v < vmin) vmin = v;
        if (v > vmax) vmax = v;
      }
    }
    let lo = Number.isFinite(vmin) ? Math.floor((vmin - 3) / 10) * 10 : 30;
    let hi = Number.isFinite(vmax) ? Math.ceil((vmax + 3) / 10) * 10 : 90;
    if (hi - lo < 30) lo = hi - 30;
    if (this.yRange) [lo, hi] = this.yRange;
    this.shown = [lo, hi];
    const y = (v) => box.yBot - (((Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : lo) - lo) / (hi - lo)) * (box.yBot - box.yTop);
    const x = (t) => box.x0 + ((t - tStart) / this.windowSec) * (box.x1 - box.x0);

    g.font = `500 ${11 * k}px ${c.font}`;
    g.lineWidth = 1;
    g.strokeStyle = c.grid;
    g.fillStyle = c.axis;
    g.textAlign = 'left';
    const stepDb = (box.yBot - box.yTop) / ((hi - lo) / 10) < 18 * k ? 20 : 10;
    for (let v = Math.ceil(lo / stepDb) * stepDb; v <= hi; v += stepDb) {
      const yy = Math.round(y(v)) + 0.5;
      g.beginPath();
      g.moveTo(box.x0, yy);
      g.lineTo(box.x1, yy);
      g.stroke();
      g.fillText(String(v), 2 * k, yy + 4 * k);
    }
    const tick = TICKS.find((s) => this.windowSec / s <= 6) || 600;
    const labels = [];
    if (this.clock) {
      if (to > from) {
        const tickMs = tick * 1000;
        for (const [i, ms] of clockTicks(this.times, from, to, tickMs)) labels.push([x((this.first + i + 1) * step), fmtTimeOfDay(ms, tick < 60)]);
        // right of the newest value the clock runs on, as the measuring time does
        const tLast = (this.first + to) * step;
        const cLast = this.times[to - 1];
        for (let ms = (Math.floor(cLast / tickMs) + 1) * tickMs; ms <= cLast + (tEnd - tLast) * 1000 + 1; ms += tickMs) labels.push([x(tLast + (ms - cLast) / 1000), fmtTimeOfDay(ms, tick < 60)]);
      }
    } else {
      for (let t = Math.ceil(tStart / tick) * tick; t <= tEnd + 1e-6; t += tick) labels.push([x(t), fmtClock(t)]);
    }
    drawTimeLabels(g, labels, box, this.h, k, true);
    g.textAlign = 'left';
    g.fillStyle = c.axis;
    const day = this.clock && to > from ? new Date(this.times[to - 1]) : null;
    const title = `시간축 ${this.stats.unit} · 최근 ${this.windowSec < 60 ? `${this.windowSec}초` : `${this.windowSec / 60}분`}${day ? ` · ${day.getMonth() + 1}월 ${day.getDate()}일` : ''}`;
    g.fillText(title, box.x0 + 6 * k, box.yTop + 12 * k);
    this.titleEnd = box.x0 + 6 * k + g.measureText(title).width;

    if (to - from >= 2) {
      const t0 = (this.first + from + 1) * step;
      const xEnd = x((this.first + to) * step);
      g.save();
      g.beginPath();
      g.rect(box.x0, box.yTop, box.x1 - box.x0, box.yBot - box.yTop);
      g.clip();
      g.strokeStyle = c.live;
      g.lineWidth = 1.5 * k;
      g.lineJoin = 'round';
      g.beginPath();
      const cols = Math.max(1, Math.round(xEnd - x(t0)));
      if (to - from <= cols * 2) {
        for (let i = from; i < to; i++) g[i === from ? 'moveTo' : 'lineTo'](x((this.first + i + 1) * step), y(this.values[i]));
      } else {
        // more points than pixels: one vertical stroke per pixel from its lowest to highest value
        const { lo: cl, hi: ch } = columnRange(this.values, from, to, cols);
        for (let col = 0; col < cols; col++) {
          const xx = x(t0) + col + 0.5;
          g.moveTo(xx, y(ch[col]) - 0.5);
          g.lineTo(xx, y(cl[col]) + 0.5);
        }
      }
      g.stroke();
      g.restore();
      // the newest value
      g.fillStyle = c.live;
      g.beginPath();
      g.arc(Math.min(box.x1, xEnd), y(this.values[to - 1]), 3.2 * k, 0, Math.PI * 2);
      g.fill();
    }

    if (this.speed && to - from >= 2) this.drawSpeed(box, from, to, x, k);

    const { leq, unit } = this.stats;
    if (Number.isFinite(leq) && to - from >= 2) {
      g.setLineDash([6 * k, 4 * k]);
      g.strokeStyle = c.mean;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(box.x0, y(leq));
      g.lineTo(box.x1, y(leq));
      g.stroke();
      g.setLineDash([]);
      g.fillStyle = c.meanText;
      g.textAlign = 'right';
      g.fillText(`평균 ${leq.toFixed(1)} ${unit}`, box.x1 - 4 * k, Math.max(box.yTop + 11 * k, y(leq) - 5 * k));
    }
  }

  // Speed on its own scale (0 to a round top), labelled inside the right edge.
  drawSpeed(box, from, to, x, k) {
    const { g, step } = this;
    let top = -Infinity;
    for (let i = from; i < to; i++) if (this.speeds[i] > top) top = this.speeds[i];
    if (!Number.isFinite(top)) return; // no speed known in this window
    const hi = Math.max(40, Math.ceil((top * 1.4) / 20) * 20); // room above the line for the title
    const y = (v) => box.yBot - (Math.min(hi, Math.max(0, v)) / hi) * (box.yBot - box.yTop);
    g.save();
    g.beginPath();
    g.rect(box.x0, box.yTop, box.x1 - box.x0, box.yBot - box.yTop);
    g.clip();
    g.strokeStyle = SPECTRUM_COLORS.speed;
    g.lineWidth = 1.4 * k;
    g.lineJoin = 'round';
    g.beginPath();
    // speed changes slowly: a point every couple of pixels is enough
    const every = Math.max(1, Math.floor((to - from) / Math.max(1, (box.x1 - box.x0) / 2)));
    let open = false;
    for (let i = from; i < to; i += every) {
      const v = this.speeds[i];
      if (!Number.isFinite(v)) {
        open = false;
        continue;
      }
      g[open ? 'lineTo' : 'moveTo'](x((this.first + i + 1) * step), y(v));
      open = true;
    }
    g.stroke();
    g.restore();
    // its scale goes after the graph title, in the line's colour
    g.fillStyle = SPECTRUM_COLORS.speed;
    g.textAlign = 'left';
    g.fillText(` · 노란 선 속도 0–${hi} km/h`, this.titleEnd, box.yTop + 12 * k);
  }

  destroy() {
    this.ro.disconnect();
    this.canvas.remove();
  }
}
