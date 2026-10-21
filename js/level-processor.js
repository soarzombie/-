// AudioWorklet: A-weights the microphone signal sample by sample and reports
// energy sums plus the Fast (125 ms) time-weighted level, so Leq, LAFmax and LAFmin
// are computed from every sample rather than from sampled analyser frames.
// Filter coefficients come from dsp.js via processorOptions.

class LevelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.sos = opts.sos;
    this.state = this.sos.map(() => new Float64Array(2));
    this.blockSize = opts.blockSize || Math.round(sampleRate * 0.05);
    this.kFast = 1 - Math.exp(-1 / (0.125 * sampleRate));
    this.fast = 0;
    this.reset();
  }

  reset() {
    this.n = 0;
    this.sumA = 0;
    this.sumZ = 0;
    this.fastMax = 0;
    this.fastMin = Infinity;
    this.peak = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const sos = this.sos;
    const st = this.state;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      let y = x;
      for (let s = 0; s < sos.length; s++) {
        const c = sos[s];
        const z = st[s];
        const out = c[0] * y + z[0];
        z[0] = c[1] * y - c[3] * out + z[1];
        z[1] = c[2] * y - c[4] * out;
        y = out;
      }
      const y2 = y * y;
      this.sumA += y2;
      this.sumZ += x * x;
      this.fast += (y2 - this.fast) * this.kFast;
      if (this.fast > this.fastMax) this.fastMax = this.fast;
      if (this.fast < this.fastMin) this.fastMin = this.fast;
      const ax = x < 0 ? -x : x;
      if (ax > this.peak) this.peak = ax;
      if (++this.n >= this.blockSize) {
        this.port.postMessage({
          n: this.n,
          sumA: this.sumA,
          sumZ: this.sumZ,
          fast: this.fast,
          fastMax: this.fastMax,
          fastMin: this.fastMin,
          peak: this.peak,
        });
        this.reset();
      }
    }
    return true;
  }
}

registerProcessor('level-processor', LevelProcessor);
