// Microphone sound level meter for continuous analysis.
// Levels (LAF now, LAeq / LAFmax / LAFmin since the last reset) come from the AudioWorklet,
// which sees every sample; the spectrum comes from an AnalyserNode, per bin in dB(A).

import { designAWeighting, binLevelTable, binLevels, toDb } from './dsp.js';

const WARMUP_SEC = 0.5; // filter and Fast detector settle; also skips the tap on the screen
const CLIP_LEVEL = 0.98;
export const FFT_SIZES = [2048, 4096, 8192, 16384];

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
  constructor(offset) {
    this.offset = offset;
    this.onLevel = null; // (dB(A) Fast) => void, about every 50 ms
    this.samples = 0;
    this.laf = -Infinity;
    this.paused = false;
    this.stopped = false;
    this.resetStats();
  }

  // Best called from a tap handler; otherwise check `running` and call wake() on the next tap.
  async start(fftSize = 4096) {
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
        processorOptions: { sos: designAWeighting(fs), blockSize: Math.round(fs * 0.05) },
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
      this.node.port.onmessage = (e) => this.handleBlock(e.data);
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
    this.table = binLevelTable(bins, this.binHz);
    this.rawDb = new Float32Array(bins);
    this.levels = new Float32Array(bins);
    this.freqs = Float32Array.from({ length: bins }, (_, k) => k * this.binHz);
  }

  // Current spectrum, dB(A) per analyser bin (calibrated). The array is reused between calls.
  spectrum() {
    this.analyser.getFloatFrequencyData(this.rawDb);
    return binLevels(this.rawDb, this.table, this.offset, this.levels);
  }

  resetStats() {
    this.stats = { n: 0, sumA: 0, max: 0, min: Infinity, clipped: false };
    this.warmUntil = this.samples + WARMUP_SEC * this.sampleRate;
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
    if (!this.paused) this.onLevel?.(this.laf);
    if (this.paused || this.samples < this.warmUntil) return;
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
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}
