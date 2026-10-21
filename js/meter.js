// Microphone sound level meter: A-weighted Leq / LAFmax from the AudioWorklet,
// octave spectrum and dominant frequency from an AnalyserNode.

import {
  designAWeighting,
  analyserDbToPower,
  aWeightPower,
  bandPowers,
  zoneShares,
  findPeak,
  toDb,
} from './dsp.js';

const WARMUP_SEC = 0.5; // filter and Fast detector settle; also skips the tap on the screen
const CLIP_LEVEL = 0.98;
const FFT_SIZE = 8192;
const SPECTRUM_MS = 100;

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
    this.job = null;
    this.stopped = false;
  }

  // Call from a tap handler: browsers only start audio from a user gesture.
  async start() {
    if (!window.isSecureContext) throw micError('insecure');
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx || !navigator.mediaDevices?.getUserMedia) throw micError('unsupported');
    this.ctx = new Ctx();
    const resumed = this.ctx.resume();
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
      await resumed;
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
      this.analyser.fftSize = FFT_SIZE;
      this.analyser.smoothingTimeConstant = 0;
      // Both nodes must reach the destination to be rendered; the zero gain keeps it silent.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      source.connect(this.node);
      source.connect(this.analyser);
      this.node.connect(mute);
      this.analyser.connect(mute);
      mute.connect(this.ctx.destination);
      this.node.port.onmessage = (e) => this.handleBlock(e.data);
    } catch (err) {
      this.stop();
      throw err instanceof MicError ? err : micError('failed');
    }
  }

  get sampleRate() {
    return this.ctx?.sampleRate || 48000;
  }

  handleBlock(b) {
    this.samples += b.n;
    this.onLevel?.(toDb(b.fast, this.offset));
    const job = this.job;
    if (!job || this.samples < WARMUP_SEC * this.sampleRate) return;
    job.n += b.n;
    job.sumA += b.sumA;
    job.fastMax = Math.max(job.fastMax, b.fastMax);
    job.peak = Math.max(job.peak, b.peak);
    job.onProgress?.({
      elapsed: job.n / this.sampleRate,
      leq: toDb(job.sumA / job.n, this.offset),
    });
    if (job.n >= job.seconds * this.sampleRate) this.finish();
  }

  // Records for `seconds` and resolves with the analysed result.
  record(seconds, onProgress) {
    if (this.job) throw new Error('already recording');
    return new Promise((resolve, reject) => {
      const bins = this.analyser.frequencyBinCount;
      const job = {
        seconds,
        onProgress,
        resolve,
        reject,
        n: 0,
        sumA: 0,
        fastMax: 0,
        peak: 0,
        frames: 0,
        power: new Float64Array(bins),
        scratchDb: new Float32Array(bins),
        scratchPower: new Float64Array(bins),
      };
      job.timer = setInterval(() => {
        if (job.n === 0) return; // still warming up
        this.analyser.getFloatFrequencyData(job.scratchDb);
        analyserDbToPower(job.scratchDb, job.scratchPower);
        for (let k = 0; k < bins; k++) job.power[k] += job.scratchPower[k];
        job.frames++;
      }, SPECTRUM_MS);
      this.job = job;
    });
  }

  finish() {
    const job = this.job;
    this.job = null;
    clearInterval(job.timer);
    const binHz = this.sampleRate / FFT_SIZE;
    const power = job.power.map((p) => p / Math.max(1, job.frames));
    const powerA = aWeightPower(power, binHz);
    const bandsA = bandPowers(powerA, binHz);
    const peak = findPeak(powerA, binHz);
    job.resolve({
      leq: toDb(job.sumA / job.n, this.offset),
      lmax: toDb(job.fastMax, this.offset),
      clipped: job.peak >= CLIP_LEVEL,
      bands: bandsA.map((p) => round1(toDb(p, this.offset))),
      zones: zoneShares(bandsA),
      peakHz: peak ? Math.round(peak.hz) : null,
      peakProminence: peak ? round1(peak.prominence) : null,
      durationSec: round1(job.n / this.sampleRate),
      sampleRate: this.sampleRate,
    });
  }

  cancel() {
    if (!this.job) return;
    clearInterval(this.job.timer);
    this.job.reject(new MicError('cancelled', '측정을 취소했습니다.'));
    this.job = null;
  }

  stop() {
    this.stopped = true;
    this.cancel();
    this.onLevel = null;
    if (this.node) this.node.port.onmessage = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.ctx && this.ctx.state !== 'closed') this.ctx.close();
  }
}

function round1(v) {
  return Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}
