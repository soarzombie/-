// Measurement modes and per-device settings (kept in localStorage).

export const APP_VERSION = '0.1.0';

// metric: which figure the verdict uses. 'leq' = average level, 'lmax' = Fast maximum.
// warn / limit: dB(A). limit null = no pass/fail, the result focuses on frequency.
// delay: seconds between tapping start and recording, to put the phone in place.
export const MODES = [
  {
    id: 'drive',
    name: '주행 중 실내',
    desc: '달리는 차 안, 운전석',
    metric: 'leq',
    defaults: { warn: 75, limit: 80, duration: 15, delay: 10 },
    guide: [
      '운전석 머리받침 옆, 귀 높이에 휴대폰을 두세요. 거치대도 괜찮습니다.',
      '창문을 닫고 음악·라디오를 끄세요.',
      '평소 속도로 일정하게 달리는 동안 측정됩니다.',
    ],
    safety: '운전 중에는 휴대폰을 만지지 마세요. 동승자가 누르거나, 출발 전에 시작을 누르고 거치대에 두세요.',
  },
  {
    id: 'idle',
    name: '정차 공회전',
    desc: '시동 켜고 멈춘 상태',
    metric: 'leq',
    defaults: { warn: 55, limit: 65, duration: 10, delay: 3 },
    guide: [
      '시동을 켜고 기어를 P(또는 N)에 둔 채 정차하세요.',
      '창문을 닫고 음악·라디오를 끄세요.',
      '운전석 귀 높이에 휴대폰을 두세요.',
    ],
  },
  {
    id: 'exhaust',
    name: '배기 소음',
    desc: '차 뒤, 배기구 옆',
    metric: 'lmax',
    defaults: { warn: 95, limit: 100, duration: 8, delay: 5 },
    guide: [
      '정차 상태에서 측정합니다. 동승자 한 명이 운전석에 있어야 합니다.',
      '배기구 끝에서 비스듬히(45°) 50cm 떨어진 곳, 배기구 높이에 휴대폰 아래쪽(마이크)이 배기구를 향하게 두세요.',
      '측정이 시작되면 가속 페달을 밟아 엔진 회전수를 높게 유지하세요.',
    ],
  },
  {
    id: 'inspect',
    name: '이상음 찾기',
    desc: '어떤 소리인지 확인',
    metric: 'leq',
    defaults: { warn: null, limit: null, duration: 10, delay: 3 },
    guide: [
      '이상한 소리가 나는 상태(속도·회전수·브레이크 등)를 만들어 주세요.',
      '소리가 나는 곳 가까이에 휴대폰 아래쪽(마이크)을 향하게 두세요.',
    ],
  },
];

export const MODE_BY_ID = Object.fromEntries(MODES.map((m) => [m.id, m]));

const KEY = 'noise-meter:settings:v1';

const DEFAULTS = {
  company: '우리 회사',
  team: '',
  driver: '',
  vehicle: '',
  recentVehicles: [],
  modes: Object.fromEntries(MODES.map((m) => [m.id, { ...m.defaults }])),
  // dBFS -> dB SPL. Phones differ by 10 dB or more, so each device should be calibrated.
  offset: 100,
  calibratedAt: null,
  voice: true,
  location: true,
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
  cache = {
    ...DEFAULTS,
    ...saved,
    modes: Object.fromEntries(
      MODES.map((m) => [m.id, { ...m.defaults, ...(saved.modes?.[m.id] || {}) }]),
    ),
  };
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

export function modeConfig(id) {
  const mode = MODE_BY_ID[id];
  return mode && { ...mode, ...getSettings().modes[id] };
}

export function rememberVehicle(vehicle) {
  const v = vehicle.trim();
  if (!v) return;
  const recent = [v, ...getSettings().recentVehicles.filter((x) => x !== v)].slice(0, 6);
  saveSettings({ vehicle: v, recentVehicles: recent });
}
