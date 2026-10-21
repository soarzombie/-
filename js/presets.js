// Measurement situations ("측정 상황"): one choice sets the weighting, FFT size, chart style, curves and
// time-axis length together. "사용자 지정" keeps the user's own mix: it is remembered when another
// situation is chosen and comes back when 사용자 지정 is chosen again. Changing any of these settings by
// hand while a situation is chosen turns it into 사용자 지정. Pure functions over a settings object.

export const PRESET_KEYS = ['weighting', 'timeWeighting', 'fftSize', 'style', 'scale', 'peakHold', 'minHold', 'maxTrack', 'minTrack', 'traceSec'];

export const PRESETS = [
  {
    id: 'idle',
    name: '공회전',
    note: '세워 두고 엔진 저음을 자세히 · Slow · FFT 16384 · 선 · 피크·미니멈 홀드',
    values: { weighting: 'A', timeWeighting: 'S', fftSize: 16384, style: 'line', scale: 'log', peakHold: true, minHold: true, maxTrack: false, minTrack: false, traceSec: 60 },
  },
  {
    id: 'drive',
    name: '주행',
    note: '달리면서 빠르게 · Fast · FFT 4096 · 최대값 추적 · 시간축 5분',
    values: { weighting: 'A', timeWeighting: 'F', fftSize: 4096, style: 'fill', scale: 'log', peakHold: true, minHold: false, maxTrack: true, minTrack: false, traceSec: 300 },
  },
  {
    id: 'indoor',
    name: '실내',
    note: '조용한 곳의 바닥 소음 · Slow · FFT 8192 · 미니멈 홀드·최소값 추적',
    values: { weighting: 'A', timeWeighting: 'S', fftSize: 8192, style: 'line', scale: 'log', peakHold: true, minHold: true, maxTrack: false, minTrack: true, traceSec: 60 },
  },
  {
    id: 'lowfreq',
    name: '저주파',
    note: '부밍음·웅웅거림 · Z특성(거르지 않음) · Slow · FFT 16384 · 1/3 옥타브 보기와 함께',
    values: { weighting: 'Z', timeWeighting: 'S', fftSize: 16384, style: 'line', scale: 'log', peakHold: true, minHold: true, maxTrack: false, minTrack: false, traceSec: 60 },
  },
];

export const CUSTOM = { id: 'custom', name: '사용자 지정', note: '직접 고른 설정 그대로' };

export const presetOf = (id) => PRESETS.find((p) => p.id === id) || CUSTOM;

const pick = (st) => Object.fromEntries(PRESET_KEYS.map((k) => [k, st[k]]));

// Settings patch for choosing situation `id`.
export function choosePreset(st, id) {
  const patch = { preset: id };
  if (st.preset === 'custom' || !st.preset) patch.custom = pick(st); // leaving 사용자 지정: remember it
  if (id === 'custom') Object.assign(patch, (st.preset === 'custom' ? null : st.custom) || {});
  else Object.assign(patch, presetOf(id).values);
  return patch;
}

// Patch for a change made by hand: a chosen situation becomes 사용자 지정 if a situation setting changes.
export function customize(st, patch) {
  const changes = PRESET_KEYS.some((k) => k in patch && patch[k] !== st[k]);
  return changes && st.preset !== 'custom' ? { ...patch, preset: 'custom' } : patch;
}
