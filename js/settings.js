// Per-device settings (kept in localStorage).

export const APP_VERSION = '0.14.0';

const KEY = 'noise-meter:settings:v1';

const DEFAULTS = {
  company: '우리 회사',
  vehicle: '',
  recentVehicles: [],
  // analyzer display
  view: 'spectrum', // 'spectrum' (frequency graph + time-axis graph below) | 'gram' (spectrogram) | 'octave' (1/3-octave bars)
  traceSec: 30, // seconds shown in the time-axis graph: 30 | 60 | 300
  timeAxis: 'elapsed', // 시간축 표시: 'elapsed' (measuring time) | 'clock' (the clock time)
  timedSec: 10, // "N초 측정" button: 5 | 10 | 30 | 60
  gps: false, // 속도 (GPS): show and keep the vehicle speed with the measurement
  autoSave: false, // a timed measurement saves at once (last vehicle number) instead of opening the save sheet
  theme: 'dark', // 화면 밝기: 'dark' | 'light' (sunlight)
  window: 'blackman', // FFT 창 함수: 'hann' | 'hamming' | 'blackman' (the analyser's own)
  device: '', // this phone's name, kept with its records and shown on other phones after a backup
  weighting: 'A', // frequency weighting 'A' | 'C' | 'Z', for levels and spectrum alike
  timeWeighting: 'F', // level detector 'F' (Fast 125 ms) | 'S' (Slow 1 s)
  style: 'fill', // 'fill' | 'line' | 'bar'
  fftSize: 4096,
  scale: 'log',
  refId: '', // a saved record shown as a dashed reference on the live spectrum ('' = none)
  camPos: null, // where the 영상 camera window sits on the graph: [x, y] as shares of the free room
  preset: 'custom', // measurement situation (presets.js): 'idle' | 'drive' | 'indoor' | 'custom'
  custom: null, // the user's own mix, kept while a situation is chosen
  // axis ranges ("축 범위"): frequency for the spectrum and spectrogram; dB ranges null = automatic
  freqMin: 20,
  freqMax: 20000,
  specDb: null, // [lo, hi] frequency graph, vertical
  traceDb: null, // time-axis graph, vertical
  gramDb: null, // spectrogram colour scale
  octDb: null, // 1/3 octave, vertical
  // curves over the spectrum
  peakHold: true, // maximum since reset
  minHold: false, // minimum since reset
  maxTrack: false, // follows the highs, drifts back down
  minTrack: false, // follows the lows, drifts back up
  audioSec: 10, // seconds of sound kept for "save"; 0 = off
  fileUnit: 'cal', // attached files: 'cal' = this phone's calibration, dB; 'fs' = digital level, dBFS
  alertLevel: 85, // the level bar turns red from here, dB
  // dBFS -> dB SPL. Phones differ by 10 dB or more, so each device should be calibrated.
  offset: 100,
  calibratedAt: null,
  // microphones (mics.js): the chosen input, the phone's own microphone, per-microphone calibration
  micId: '', // deviceId from enumerateDevices; '' = the phone's default
  micLabel: '',
  baseMic: '', // name of the phone's own microphone (uses offset / calibratedAt above)
  lastMic: '', // the microphone used last (for attached files and the calibration screen)
  mics: {}, // name -> { offset, calibratedAt, cal: [[hz, db], ...], calName, calSerial }
  pin: '0000',
};

let cache = null;

export function getSettings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {
    saved = {};
  }
  if ('hold' in saved && !('peakHold' in saved)) saved.peakHold = saved.hold; // before 0.8 there was one switch
  delete saved.hold;
  cache = { ...DEFAULTS, ...saved };
  return cache;
}

export function saveSettings(patch) {
  cache = { ...getSettings(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    // Storage full or blocked: keep the in-memory copy for this session.
  }
  return cache;
}

export function rememberVehicle(vehicle) {
  const v = vehicle.trim();
  if (!v) return;
  const recent = [v, ...getSettings().recentVehicles.filter((x) => x !== v)].slice(0, 6);
  saveSettings({ vehicle: v, recentVehicles: recent });
}
