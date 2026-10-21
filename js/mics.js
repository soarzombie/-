// Microphones: each one (by the name the phone gives it, e.g. "iMM-6C" or the phone's own microphone)
// keeps its own calibration offset and, optionally, the frequency response from its calibration file.
// The phone's own microphone uses the original `offset` / `calibratedAt` settings, so nothing changes for
// phones calibrated before external microphones were supported. Pure functions; run under Node.

export const BUILT_IN = ''; // label key for "the phone's own microphone" before its name is known

// Calibration for the microphone called `label`: { offset, calibratedAt, cal, calName, known }.
// An external microphone that was never calibrated starts from the phone's offset, marked not calibrated.
export function micProfile(st, label = '') {
  const own = !label || label === st.baseMic;
  const saved = st.mics?.[label];
  if (saved) return { offset: st.offset, calibratedAt: null, cal: null, calName: '', ...saved, known: true };
  return { offset: st.offset, calibratedAt: own ? st.calibratedAt : null, cal: null, calName: '', known: own };
}

// Settings patch storing `patch` (offset, calibratedAt, cal, calName) for the microphone `label`.
export function saveMicProfile(st, label, patch) {
  const own = !label || label === st.baseMic;
  const out = { mics: { ...(st.mics || {}), [label]: { ...(st.mics?.[label] || {}), ...patch } } };
  if (own && 'offset' in patch) out.offset = patch.offset;
  if (own && 'calibratedAt' in patch) out.calibratedAt = patch.calibratedAt;
  return out;
}

// Reads a microphone calibration file: lines "frequency  dB [phase]" (miniDSP UMIK, Dayton iMM-6C, REW and
// most others). Header and comment lines are skipped; a miniDSP "Sens Factor", a Dayton "*1000Hz -40.3"
// sensitivity line (dB re 1 V/Pa at 1 kHz) and a serial number are kept. A file that lists the absolute
// sensitivity on every line (all around -40 dB) is turned into a response relative to 1 kHz.
// Returns { points: [[hz, db], ...] by frequency, sensFactor, sens1k, serial } or throws a Korean message.
export function parseCalFile(text) {
  let points = [];
  let sensFactor = null;
  let sens1k = null;
  let serial = null;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim().replace(/^"|"$/g, '');
    if (!line) continue;
    const sens = line.match(/sens(?:itivity)?\s*factor\s*=?\s*(-?[\d.]+)/i);
    if (sens) sensFactor = parseFloat(sens[1]);
    const at1k = line.match(/^\*\s*1000\s*hz\s*[:=]?\s*(-?[\d.]+)/i);
    if (at1k) sens1k = parseFloat(at1k[1]);
    const ser = line.match(/ser(?:no|ial)(?:\s*(?:no\.?|number|#))?\s*[:=]?\s*([\w-]*\d[\w-]*)/i);
    if (ser) serial = ser[1];
    if (/^[*#;"]/.test(raw.trim()) || !/^[+-]?\d/.test(line)) continue;
    const nums = line.split(/[\s,;]+/).map(Number);
    if (nums.length < 2 || !Number.isFinite(nums[0]) || !Number.isFinite(nums[1]) || nums[0] <= 0) continue;
    points.push([nums[0], nums[1]]);
  }
  points.sort((a, b) => a[0] - b[0]);
  if (points.length < 5) throw new Error('보정 파일에서 "주파수 dB" 줄을 찾지 못했습니다.');
  if (points[0][0] > 200 || points.at(-1)[0] < 5000) throw new Error('보정 파일의 주파수 범위가 너무 좁습니다.');
  const ref = -calCorrection(points)(1000);
  if (Math.abs(ref) > 20) {
    points = points.map(([f, db]) => [f, Math.round((db - ref) * 1000) / 1000]);
    sens1k ??= Math.round(ref * 10) / 10;
  }
  if (points.some(([, db]) => Math.abs(db) > 40)) throw new Error('보정 파일의 dB 값이 이상합니다 (±40 dB 넘음).');
  return { points, sensFactor, sens1k, serial };
}

// The dB to add at frequency f so the microphone reads flat: minus its response, interpolated on a log
// frequency scale and held at the ends. Null points -> no correction.
export function calCorrection(points) {
  if (!points?.length) return null;
  const lf = points.map(([f]) => Math.log(f));
  return (f) => {
    if (!(f > 0)) return 0;
    const x = Math.log(f);
    if (x <= lf[0]) return -points[0][1];
    if (x >= lf.at(-1)) return -points.at(-1)[1];
    let i = 1;
    while (lf[i] < x) i++;
    const t = (x - lf[i - 1]) / (lf[i] - lf[i - 1]);
    return -(points[i - 1][1] + t * (points[i][1] - points[i - 1][1]));
  };
}
