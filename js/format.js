// Display text and formatting shared by screens and the share image.

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtDb(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '–';
}

export function fmtHz(hz) {
  if (!Number.isFinite(hz)) return '–';
  return `${Math.round(hz).toLocaleString('ko-KR')} Hz`;
}

// 75 -> "01:15", 3725 -> "1:02:05"
export function fmtClock(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const hh = Math.floor(s / 3600);
  const mm = pad(Math.floor((s % 3600) / 60));
  const ss = pad(s % 60);
  return hh ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토'];
const pad = (n) => String(n).padStart(2, '0');

export function fmtDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} (${WEEKDAY[d.getDay()]}) ${fmtTime(ts)}`;
}

export function fmtDay(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}월 ${d.getDate()}일 (${WEEKDAY[d.getDay()]})`;
}

export function fmtShortDate(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`;
}

export function fmtTime(ts) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// "14:03:05" (or "14:03" without seconds): the clock time on time-axis graphs
export function fmtTimeOfDay(ts, seconds = true) {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}${seconds ? `:${pad(d.getSeconds())}` : ''}`;
}

export function fileStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// "10.21 14:03": a short date and time, for picking one record among others
export function fmtWhen(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}.${pad(d.getDate())} ${fmtTime(ts)}`;
}

// Speed kept with a measurement (GPS): "평균 62 km/h · 최고 70 km/h · 저장 순간 63 km/h".
export function speedText(rec) {
  const kmh = (v) => `${Math.round(v)} km/h`;
  const parts = [];
  if (Number.isFinite(rec.speedAvg)) parts.push(`평균 ${kmh(rec.speedAvg)}`);
  if (Number.isFinite(rec.speedMax)) parts.push(`최고 ${kmh(rec.speedMax)}`);
  if (Number.isFinite(rec.speed)) parts.push(`저장 순간 ${kmh(rec.speed)}`);
  return parts.join(' · ') || '알 수 없음 (위치 신호 없음)';
}
