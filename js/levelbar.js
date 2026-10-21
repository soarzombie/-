// LED level bar for the level panel: a row of segments, 30 – 120 dB in 3 dB steps, green / yellow / red
// against the alert level, lit up to the current level, with one bright segment at the held maximum.

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
