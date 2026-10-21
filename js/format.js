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

export function fileStamp(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// "10.21 14:03": a short date and time, for picking one record among others
export function fmtWhen(ts) {
  const d = new Date(ts);
  return `${d.getMonth() + 1}.${pad(d.getDate())} ${fmtTime(ts)}`;
}
