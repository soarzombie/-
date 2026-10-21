// Per-device settings (kept in localStorage).

export const APP_VERSION = '0.7.0';

const KEY = 'noise-meter:settings:v1';

const DEFAULTS = {
  company: '우리 회사',
  vehicle: '',
  recentVehicles: [],
  // analyzer display
  view: 'spectrum', // 'spectrum' (with the level trace below) | 'gram' (spectrogram) | 'both' | 'octave' (1/3-octave bars)
  traceSec: 30, // seconds of level history under the spectrum; 0 = hidden
  weighting: 'A', // frequency weighting 'A' | 'C' | 'Z', for levels and spectrum alike
  style: 'fill', // 'fill' | 'line'
  fftSize: 4096,
  scale: 'log',
  hold: true,
  audioSec: 10, // seconds of sound kept for "save"; 0 = off
  fileUnit: 'cal', // attached files: 'cal' = this phone's calibration, dB; 'fs' = digital level, dBFS
  alertLevel: 85, // the level bar turns red from here, dB
  // dBFS -> dB SPL. Phones differ by 10 dB or more, so each device should be calibrated.
  offset: 100,
  calibratedAt: null,
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
