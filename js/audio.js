// The sound saved with an analysis: 16-bit mono PCM WAV, which every phone can play.

export function encodeWav(samples, rate) {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (offset, s) => [...s].forEach((c, i) => v.setUint8(offset + i, c.charCodeAt(0)));
  text(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buf], { type: 'audio/wav' });
}

// Reads back files made by encodeWav (header is always 44 bytes).
export async function decodeWav(blob) {
  const v = new DataView(await blob.arrayBuffer());
  const rate = v.getUint32(24, true);
  const n = (v.byteLength - 44) >> 1;
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) samples[i] = v.getInt16(44 + i * 2, true) / 32768;
  return { samples, rate };
}

// Any file the browser can play (mp3, m4a/aac, wav, ogg, webm, flac, and the sound of mp4 video),
// mixed to mono at `rate`. Long files are cut to the first `maxSec` seconds to keep memory sane.
export async function decodeAudioFile(blob, { rate = 48000, maxSec = 300 } = {}) {
  const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ctx = new Offline(1, 1, rate);
  const data = await blob.arrayBuffer();
  const buf = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(data, resolve, reject); // old Safari only has the callback form
    p?.then?.(resolve, reject);
  });
  const n = Math.min(buf.length, Math.round(maxSec * buf.sampleRate));
  const samples = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < n; i++) samples[i] += ch[i] / buf.numberOfChannels;
  }
  return { samples, rate: buf.sampleRate, duration: buf.duration, channels: buf.numberOfChannels, capped: buf.length > n };
}
