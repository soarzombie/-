// Per-device settings (kept in localStorage).

export const APP_VERSION = '0.3.0';

const KEY = 'noise-meter:settings:v1';

const DEFAULTS = {
  company: '우리 회사',
  vehicle: '',
  recentVehicles: [],
  // analyzer display
  fftSize: 4096,
  scale: 'log',
  hold: true,
  alertLevel: 85, // gauge turns orange from here, dB(A)
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
