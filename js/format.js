// Display text and formatting shared by screens, report and share card.

export const VERDICT = {
  ok: { label: '정상', msg: '기준 이내입니다.', speak: '정상입니다.' },
  warn: { label: '주의', msg: '기준에 가깝습니다. 계속 지켜봐 주세요.', speak: '주의 단계입니다.' },
  over: { label: '초과', msg: '기준을 넘었습니다. 관리자에게 알려 주세요.', speak: '기준을 초과했습니다. 관리자에게 알려 주세요.' },
  none: { label: '분석 완료', msg: '', speak: '분석이 끝났습니다.' },
};

export const ZONE_INFO = {
  low: {
    name: '저음',
    range: '160Hz 이하',
    sound: '웅~, 우웅 하는 낮은 소리',
    causes: '엔진·배기, 타이어·노면, 차체 떨림에서 많이 나는 소리입니다.',
  },
  mid: {
    name: '중음',
    range: '200Hz–1.25kHz',
    sound: '윙~, 그르륵 하는 소리',
    causes: '기어·베어링·펌프, 바람 소리에서 많이 나는 소리입니다.',
  },
  high: {
    name: '고음',
    range: '1.6kHz 이상',
    sound: '삐~, 끼익, 쉬익 하는 높은 소리',
    causes: '브레이크, 벨트, 공기 새는 곳에서 많이 나는 소리입니다.',
  },
};

export const METRIC_LABEL = { leq: '평균 소음', lmax: '최대 소음' };

// A whine or squeal stands this many dB above its neighbourhood.
export const TONAL_PROMINENCE = 10;

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function fmtDb(v) {
  return Number.isFinite(v) ? v.toFixed(1) : '–';
}

export function fmtHz(hz) {
  if (!Number.isFinite(hz)) return '–';
  return `${Math.round(hz).toLocaleString('ko-KR')}Hz`;
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

export function criterionText(rec) {
  if (rec.limit == null) return '판정 없이 주파수를 분석합니다';
  const warn = rec.warn != null ? ` (주의 ${rec.warn}부터)` : '';
  return `${METRIC_LABEL[rec.metric]} ${rec.limit} dB 이하${warn}`;
}

export function mapUrl(loc) {
  return loc ? `https://map.kakao.com/link/map/${encodeURIComponent('측정 위치')},${loc.lat},${loc.lon}` : '';
}

export function fmtLoc(loc) {
  return loc ? `${loc.lat.toFixed(5)}, ${loc.lon.toFixed(5)}` : '기록 안 됨';
}
