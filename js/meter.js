// Microphone sound level meter for continuous analysis.
// Levels (Fast now, Leq / Fast max / Fast min since the last reset) come from the AudioWorklet,
// which sees every sample, keeps the last few seconds of sound and streams it while recording;
// the spectrum comes from an AnalyserNode, per bin in dB with the same frequency weighting (A/C/Z).

import { designWeighting, binLevelTable, binLevels, toDb, unitOf } from './dsp.js';

const WARMUP_SEC = 0.5; // filter and Fast detector settle; also skips the tap on the screen
const CLIP_LEVEL = 0.98;
export const FFT_SIZES = [2048, 4096, 8192, 16384];
export const MAX_RECORD_SEC = 300; // the file analysis reads the first 5 minutes

export class MicError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const MESSAGES = {
  insecure: '보안 연결(https) 주소에서만 마이크를 쓸 수 있습니다. 관리자에게 받은 주소로 접속하세요.',
  unsupported: '이 브라우저는 측정을 지원하지 않습니다. 크롬 또는 사파리 최신 버전에서 열어 주세요.',
  denied: '마이크 사용이 허용되지 않았습니다. 브라우저 설정에서 이 사이트의 마이크를 "허용"으로 바꾼 뒤 다시 시도하세요.',
  notfound: '마이크를 찾을 수 없습니다.',
  busy: '다른 앱이 마이크를 쓰고 있습니다. 통화·녹음 앱을 끄고 다시 시도하세요.',
  failed: '마이크를 시작하지 못했습니다. 앱을 다시 열어 주세요.',
};

function micError(code) {
  return new MicError(code, MESSAGES[code]);
}

export class Meter {
  constructor(offset, weighting = 'A') {
    this.offset = offset;
    this.weighting = weighting;
    this.onLevel = null; // (Fast level, dB) => void, about every 50 ms
    this.recording = null; // { chunks, samples, done } while recording
    this.samples = 0;
    this.laf = -Infinity;
    this._paused = false;
    this.stopped = false;
    this.pending = new Map(); // audio dumps waiting for the worklet
    this.resetStats();
  }

  // Paused: readings, spectrum and the sound buffer all hold still.
  get paused() {
    return this._paused;
  }

  set paused(v) {
    this._paused = v;
    this.node?.port.postMessage({ type: 'pause', paused: v });
  }

  // Best called from a tap handler; otherwise check `running` and call wake() on the next tap.
  async start(fftSize = 4096, ringSec = 0) {
    if (!window.isSecureContext) throw micError('insecure');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices?.getUserMedia) throw micError('unsupported');
    this.ctx = new Ctx();
    // Not awaited: without a recent tap the context stays suspended until wake() is called.
    this.ctx.resume().catch(() => {});
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
        video: false,
      });
    } catch (err) {
      this.ctx.close();
      const code = {
        NotAllowedError: 'denied',
        SecurityError: 'denied',
        NotFoundError: 'notfound',
        OverconstrainedError: 'notfound',
        NotReadableError: 'busy',
        AbortError: 'busy',
      }[err?.name];
      throw micError(code || 'failed');
    }
    if (this.stopped) {
      // The screen was left while the permission prompt was open: release the mic at once.
      this.stream.getTracks().forEach((t) => t.stop());
      throw new MicError('cancelled', '측정을 취소했습니다.');
    }
    try {
      if (!this.ctx.audioWorklet) throw micError('unsupported');
      await this.ctx.audioWorklet.addModule(new URL('./level-processor.js', import.meta.url));
      const fs = this.ctx.sampleRate;
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'level-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { sos: designWeighting(fs, this.weighting), blockSize: Math.round(fs * 0.05), ringSec },
      });
      this.analyser = this.ctx.createAnalyser();
      this.analyser.smoothingTimeConstant = 0.5;
      this.setFftSize(fftSize);
      // Both nodes must reach the destination to be rendered; the zero gain keeps it silent.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      source.connect(this.node);
      source.connect(this.analyser);
      this.node.connect(mute);
      this.analyser.connect(mute);
      mute.connect(this.ctx.destination);
      this.node.port.onmessage = (e) => {
        if (e.data.type === 'level') this.handleBlock(e.data);
        else if (e.data.type === 'chunk') this.handleChunk(e.data);
        else if (e.data.type === 'audio') {
          this.pending.get(e.data.id)?.(e.data.samples);
          this.pending.delete(e.data.id);
        }
      };
      this.resetStats();
    } catch (err) {
      this.stop();
      throw err instanceof MicError ? err : micError('failed');
    }
  }

  get sampleRate() {
    return this.ctx?.sampleRate || 48000;
  }

  // Browsers keep audio suspended until a tap; the screen shows a "tap to start" layer meanwhile.
  get running() {
    return this.ctx?.state === 'running';
  }

  wake() {
    return this.ctx?.resume();
  }

  setFftSize(n) {
    this.analyser.fftSize = n;
    const bins = n / 2;
    this.binHz = this.sampleRate / n;
    this.table = binLevelTable(bins, this.binHz, this.weighting);
    this.rawDb = new Float32Array(bins);
    this.levels = new Float32Array(bins);
    this.freqs = Float32Array.from({ length: bins }, (_, k) => k * this.binHz);
  }

  get unit() {
    return unitOf(this.weighting);
  }

  // A, C or Z. Levels since the last reset mix weightings, so they start again.
  setWeighting(w) {
    this.weighting = w;
    this.node?.port.postMessage({ type: 'sos', sos: designWeighting(this.sampleRate, w) });
    if (this.analyser) this.setFftSize(this.analyser.fftSize);
    this.resetStats();
  }

  // Records the raw microphone sound until stopRecording() or MAX_RECORD_SEC, also while paused.
  startRecording() {
    if (!this.node || this.recording) return;
    this.recording = { chunks: [], samples: 0, done: null };
    this.node.port.postMessage({ type: 'record', on: true });
  }

  get recordedSec() {
    return this.recording ? this.recording.samples / this.sampleRate : 0;
  }

  // Resolves the recorded sound as one Float32Array.
  stopRecording() {
    const r = this.recording;
    if (!r) return Promise.resolve(new Float32Array(0));
    return (r.stopped ||= new Promise((resolve) => {
      r.done = resolve;
      this.node.port.postMessage({ type: 'record', on: false });
    }));
  }

  handleChunk({ samples, last }) {
    const r = this.recording;
    if (!r) return;
    const room = MAX_RECORD_SEC * this.sampleRate - r.samples;
    if (room > 0) {
      const keep = samples.length > room ? samples.subarray(0, room) : samples;
      r.chunks.push(keep);
      r.samples += keep.length;
    }
    if (last) r.done?.(this.takeRecording());
    else if (r.samples >= MAX_RECORD_SEC * this.sampleRate) this.onRecordFull?.();
  }

  // What has arrived so far, at once (for when the screen is left mid-recording).
  takeRecording() {
    const r = this.recording;
    this.recording = null;
    this.node?.port.postMessage({ type: 'record', on: false });
    const out = new Float32Array(r ? r.samples : 0);
    let pos = 0;
    for (const c of r?.chunks || []) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  // Current spectrum, dB per analyser bin (weighted, calibrated). The array is reused between calls.
  spectrum() {
    this.analyser.getFloatFrequencyData(this.rawDb);
    return binLevels(this.rawDb, this.table, this.offset, this.levels);
  }

  resetStats() {
    this.stats = { n: 0, sumA: 0, max: 0, min: Infinity, clipped: false };
    this.warmUntil = this.samples + WARMUP_SEC * this.sampleRate;
    this.node?.port.postMessage({ type: 'clear' });
  }

  // The last few seconds of raw sound (Float32Array, oldest first); empty if recording is off.
  captureAudio() {
    if (!this.node) return Promise.resolve(new Float32Array(0));
    const id = Math.random().toString(36).slice(2);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.node.port.postMessage({ type: 'dump', id });
      setTimeout(() => this.pending.has(id) && (this.pending.delete(id), resolve(new Float32Array(0))), 2000);
    });
  }

  // True for the first 0.5 s after start / reset, while filters and the analyser settle.
  get warming() {
    return this.samples < this.warmUntil;
  }

  get elapsed() {
    return this.stats.n / this.sampleRate;
  }

  get leq() {
    return this.stats.n ? toDb(this.stats.sumA / this.stats.n, this.offset) : NaN;
  }

  get lmax() {
    return this.stats.n ? toDb(this.stats.max, this.offset) : NaN;
  }

  get lmin() {
    return this.stats.n ? toDb(this.stats.min, this.offset) : NaN;
  }

  handleBlock(b) {
    this.samples += b.n;
    this.laf = toDb(b.fast, this.offset);
    if (!this._paused) this.onLevel?.(this.laf);
    if (this._paused || this.samples < this.warmUntil) return;
    const s = this.stats;
    s.n += b.n;
    s.sumA += b.sumA;
    s.max = Math.max(s.max, b.fastMax);
    s.min = Math.min(s.min, b.fastMin);
    if (b.peak >= CLIP_LEVEL) s.clipped = true;
  }

  stop() {
    this.stopped = true;
    this.onLevel = null;
    if (this.recording) this.recording.done?.(this.takeRecording());
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}
