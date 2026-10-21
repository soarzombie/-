// AudioWorklet: frequency-weights the microphone signal sample by sample and reports
// energy sums plus the Fast (125 ms) time-weighted level, so Leq, LAFmax and LAFmin
// are computed from every sample rather than from sampled analyser frames.
// It also keeps the last `ringSec` seconds of raw sound, so "save" can include what was just heard
// (held still while paused), and while recording it posts the raw sound in chunks (paused or not:
// recording is separate from measuring).
// Filter coefficients come from dsp.js via processorOptions, and again in a 'sos' message when
// the weighting changes.

class LevelProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.setSos(opts.sos);
    this.blockSize = opts.blockSize || Math.round(sampleRate * 0.05);
    this.kFast = 1 - Math.exp(-1 / (0.125 * sampleRate));
    this.fast = 0;
    this.ring = opts.ringSec > 0 ? new Float32Array(Math.round(sampleRate * opts.ringSec)) : null;
    this.ringPos = 0;
    this.ringFilled = 0;
    this.paused = false;
    this.rec = null; // chunk being filled while recording
    this.recLen = Math.round(sampleRate * 0.5);
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'pause') this.paused = m.paused;
      else if (m.type === 'dump') this.dump(m.id);
      else if (m.type === 'clear') this.ringFilled = 0;
      else if (m.type === 'sos') this.setSos(m.sos);
      else if (m.type === 'record') this.record(m.on);
    };
    this.reset();
  }

  setSos(sos) {
    this.sos = sos;
    this.state = sos.map(() => new Float64Array(2));
  }

  // on: start collecting; off: post what is left with last = true.
  record(on) {
    if (on) {
      this.rec = new Float32Array(this.recLen);
      this.recPos = 0;
    } else if (this.rec) {
      this.flush(true);
      this.rec = null;
    }
  }

  flush(last = false) {
    const out = this.rec.slice(0, this.recPos);
    this.port.postMessage({ type: 'chunk', samples: out, last }, [out.buffer]);
    this.recPos = 0;
  }

  // Posts the buffered sound, oldest sample first.
  dump(id) {
    const n = this.ringFilled;
    const out = new Float32Array(n);
    if (n) {
      const len = this.ring.length;
      const start = (this.ringPos - n + len) % len;
      const first = Math.min(n, len - start);
      out.set(this.ring.subarray(start, start + first), 0);
      out.set(this.ring.subarray(0, n - first), first);
    }
    this.port.postMessage({ type: 'audio', id, samples: out }, [out.buffer]);
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
    const ring = this.paused ? null : this.ring;
    const rec = this.rec;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      if (ring) {
        ring[this.ringPos] = x;
        if (++this.ringPos === ring.length) this.ringPos = 0;
        if (this.ringFilled < ring.length) this.ringFilled++;
      }
      if (rec) {
        rec[this.recPos] = x;
        if (++this.recPos === rec.length) this.flush();
      }
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
          type: 'level',
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
