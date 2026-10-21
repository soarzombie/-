// Level displays. Gauge: needle 20–130 dB, ticks every 5 dB, the alert zone in orange, marks at the
// minimum and maximum since reset. LevelBar: a row of LED segments, green / yellow / red.

const LO = 20;
const HI = 130;
const A0 = 180; // degrees (maths convention) for LO, left end of a half circle
const A1 = 0; // for HI, right end
const CX = 150;
const CY = 148;
const R = 112;

const clamp = (v) => Math.max(LO, Math.min(HI, v));
const angle = (v) => A0 + ((clamp(v) - LO) / (HI - LO)) * (A1 - A0);
const pt = (r, deg) => {
  const a = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY - r * Math.sin(a)];
};
const f = (n) => n.toFixed(1);

function arc(r, from, to) {
  const [x0, y0] = pt(r, angle(from));
  const [x1, y1] = pt(r, angle(to));
  const span = Math.abs(angle(to) - angle(from));
  return `M${f(x0)} ${f(y0)}A${r} ${r} 0 ${span > 180 ? 1 : 0} 1 ${f(x1)} ${f(y1)}`;
}

export class Gauge {
  constructor(host, alertLevel) {
    let ticks = '';
    for (let v = LO; v <= HI; v += 5) {
      const major = v % 10 === 0;
      const [xa, ya] = pt(R - (major ? 16 : 9), angle(v));
      const [xb, yb] = pt(R, angle(v));
      const cls = v >= alertLevel ? 'g-tick g-alert' : 'g-tick';
      ticks += `<line class="${cls}${major ? ' g-major' : ''}" x1="${f(xa)}" y1="${f(ya)}" x2="${f(xb)}" y2="${f(yb)}"/>`;
      if (major) {
        const [xl, yl] = pt(R + 16, angle(v));
        ticks += `<text class="g-label${v >= alertLevel ? ' g-alert' : ''}" x="${f(xl)}" y="${f(yl + 4)}" text-anchor="middle">${v}</text>`;
      }
    }
    host.innerHTML = `<svg class="gauge-svg" viewBox="0 0 300 160" aria-hidden="true">
      <path class="g-arc" d="${arc(R - 16, LO, alertLevel)}"/>
      <path class="g-arc g-alert" d="${arc(R - 16, alertLevel, HI)}"/>
      ${ticks}
      <path class="g-mark g-mark-min" d="M0 -5L6 5H-6Z"/>
      <path class="g-mark g-mark-max" d="M0 -5L6 5H-6Z"/>
      <line class="g-needle" x1="${CX}" y1="${CY}" x2="${CX + R - 20}" y2="${CY}"/>
      <circle class="g-hub" cx="${CX}" cy="${CY}" r="9"/>
    </svg>`;
    this.needle = host.querySelector('.g-needle');
    this.minMark = host.querySelector('.g-mark-min');
    this.maxMark = host.querySelector('.g-mark-max');
    this.set(LO);
    this.marks(NaN, NaN);
  }

  set(v) {
    this.needle.style.transform = `rotate(${-angle(Number.isFinite(v) ? v : LO)}deg)`;
  }

  marks(min, max) {
    const place = (el, v) => {
      el.style.display = Number.isFinite(v) ? '' : 'none';
      if (!Number.isFinite(v)) return;
      const [x, y] = pt(R - 26, angle(v));
      el.setAttribute('transform', `translate(${f(x)} ${f(y)}) rotate(${f(90 - angle(v))})`);
    };
    place(this.minMark, min);
    place(this.maxMark, max);
  }
}

const LED_LO = 30;
const LED_STEP = 3; // dB per segment
const LED_N = 30; // 30 – 120 dB

export class LevelBar {
  constructor(host, alertLevel) {
    host.innerHTML = Array.from({ length: LED_N }, (_, i) => {
      const v = LED_LO + i * LED_STEP;
      const tone = v >= alertLevel ? 'r' : v >= alertLevel - 15 ? 'y' : 'g';
      return `<i class="led-${tone}"></i>`;
    }).join('');
    this.segs = [...host.children];
    this.lit = -1;
    this.peak = -1;
  }

  // now: current level (lights the segments below it); max: held maximum (one bright segment).
  set(now, max) {
    const seg = (v) => (Number.isFinite(v) ? Math.min(LED_N - 1, Math.floor((v - LED_LO) / LED_STEP)) : -1);
    const lit = seg(now);
    const peak = seg(max);
    if (lit !== this.lit) {
      this.segs.forEach((el, i) => el.classList.toggle('on', i <= lit));
      this.lit = lit;
    }
    if (peak !== this.peak) {
      this.segs[this.peak]?.classList.remove('hold');
      this.segs[peak]?.classList.add('hold');
      this.peak = peak;
    }
  }
}
