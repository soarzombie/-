// Getting results off the phone: text for messengers, a PNG result card, CSV for Excel.

import { OCTAVES, zoneOfFrequency } from './dsp.js';
import {
  VERDICT,
  ZONE_INFO,
  METRIC_LABEL,
  fmtDb,
  fmtHz,
  fmtDate,
  criterionText,
  mapUrl,
} from './format.js';

export function summaryText(rec, settings) {
  const v = VERDICT[rec.verdict];
  const lines = [
    `[차량 소음 측정] ${settings.company}`,
    `차량: ${rec.vehicle || '-'}${rec.driver ? ` (기사 ${rec.driver})` : ''}`,
    `항목: ${rec.modeName}`,
    rec.limit != null
      ? `결과: ${v.label} / ${METRIC_LABEL[rec.metric]} ${fmtDb(rec.value)} dB(A) (기준 ${rec.limit} 이하)`
      : `결과: ${METRIC_LABEL[rec.metric]} ${fmtDb(rec.value)} dB(A)`,
    `평균 ${fmtDb(rec.leq)} / 최대 ${fmtDb(rec.lmax)} dB(A)`,
    rec.peakHz ? `주요 소리: ${fmtHz(rec.peakHz)} (${ZONE_INFO[zoneOfFrequency(rec.peakHz)].name})` : '',
    `일시: ${fmtDate(rec.ts)}`,
    rec.loc ? `위치: ${mapUrl(rec.loc)}` : '',
    rec.memo ? `메모: ${rec.memo}` : '',
    '※ 스마트폰 측정 참고값',
  ];
  return lines.filter(Boolean).join('\n');
}

// Fixed light palette: the card is an image that leaves the app.
const CARD = {
  bg: '#ffffff',
  head: '#14263d',
  headInk: '#ffffff',
  headSub: '#aab9cc',
  ink: '#111c27',
  sub: '#5b6875',
  line: '#dbe2e9',
  bar: '#2f5fd0',
  barPeak: '#14263d',
  verdict: {
    ok: ['#e2f4e9', '#11733f'],
    warn: ['#fff0d1', '#935600'],
    over: ['#fde3e1', '#b4231f'],
    none: ['#e8eef6', '#14263d'],
  },
};
const FONT = '"Pretendard", "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", system-ui, sans-serif';

export function renderCard(rec, settings) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const font = (size, weight = 400) => `${weight} ${size}px ${FONT}`;
  const text = (s, x, y, size, color, weight, align = 'left') => {
    g.font = font(size, weight);
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };

  g.fillStyle = CARD.bg;
  g.fillRect(0, 0, W, H);
  g.fillStyle = CARD.head;
  g.fillRect(0, 0, W, 170);
  text(settings.company + (settings.team ? ` · ${settings.team}` : ''), 64, 72, 34, CARD.headSub, 500);
  text('차량 소음 측정 결과', 64, 132, 50, CARD.headInk, 700);

  const [vbg, vink] = CARD.verdict[rec.verdict];
  g.fillStyle = vbg;
  roundRect(g, 48, 210, W - 96, 380, 28);
  g.fill();
  text(VERDICT[rec.verdict].label, 96, 330, 96, vink, 800);
  text(rec.modeName, W - 96, 300, 36, vink, 600, 'right');
  text(METRIC_LABEL[rec.metric], 96, 410, 34, CARD.sub, 500);
  g.font = font(150, 800);
  const valueText = fmtDb(rec.value);
  const vw = g.measureText(valueText).width;
  text(valueText, 92, 545, 150, CARD.ink, 800);
  text('dB(A)', 92 + vw + 18, 545, 46, CARD.sub, 600);
  if (rec.limit != null) text(`기준 ${rec.limit} 이하`, W - 96, 545, 38, vink, 700, 'right');

  const rows = [
    ['차량번호', `${rec.vehicle || '-'}${rec.driver ? `  (${rec.driver})` : ''}`],
    ['측정 일시', fmtDate(rec.ts)],
    ['평균 / 최대', `${fmtDb(rec.leq)} / ${fmtDb(rec.lmax)} dB(A)`],
    ['주요 소리', rec.peakHz ? `${fmtHz(rec.peakHz)} (${ZONE_INFO[zoneOfFrequency(rec.peakHz)].name})` : '-'],
    ['판정 기준', criterionText(rec)],
  ];
  let y = 660;
  for (const [label, value] of rows) {
    text(label, 64, y, 32, CARD.sub, 500);
    text(fitText(g, value, font(36, 600), W - 64 - 300), 300, y, 36, CARD.ink, 600);
    g.fillStyle = CARD.line;
    g.fillRect(64, y + 26, W - 128, 2);
    y += 74;
  }

  // Octave bars
  const values = rec.bands.filter(Number.isFinite);
  if (values.length) {
    const top = Math.ceil((Math.max(...values) + 4) / 10) * 10;
    const bottom = top - 50;
    const x0 = 64;
    const x1 = W - 64;
    const yTop = 1050;
    const yBot = 1220;
    const slot = (x1 - x0) / OCTAVES.length;
    const peak = rec.bands.indexOf(Math.max(...values));
    text('주파수별 소리 크기 dB(A)', 64, 1028, 30, CARD.sub, 600);
    rec.bands.forEach((v, i) => {
      const cx = x0 + slot * (i + 0.5);
      if (Number.isFinite(v)) {
        const h = ((Math.max(bottom, Math.min(top, v)) - bottom) / (top - bottom)) * (yBot - yTop);
        g.fillStyle = i === peak ? CARD.barPeak : CARD.bar;
        g.fillRect(cx - slot * 0.3, yBot - h, slot * 0.6, Math.max(2, h));
      }
      text(OCTAVES[i].label, cx, yBot + 38, 26, CARD.sub, 500, 'center');
    });
  }

  const cal = rec.calibrated ? '마이크 보정됨' : '마이크 보정 안 됨';
  text(`스마트폰 마이크 측정 참고값 · ${cal}`, 64, H - 40, 26, CARD.sub, 400);

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function fitText(g, s, font, maxWidth) {
  g.font = font;
  if (g.measureText(s).width <= maxWidth) return s;
  let t = s;
  while (t.length > 1 && g.measureText(`${t}…`).width > maxWidth) t = t.slice(0, -1);
  return `${t}…`;
}

const CSV_HEAD = [
  '일시', '차량번호', '기사', '측정 항목', '판정', '판정값 dB(A)', '판정 방식', '주의 기준', '초과 기준',
  '평균 Leq dB(A)', '최대 Lmax dB(A)', '주요 소리 Hz', '저음 %', '중음 %', '고음 %',
  ...OCTAVES.map((b) => `${b.label}Hz dB(A)`),
  '측정 시간(초)', '위도', '경도', '메모', '마이크 보정', '과부하',
];

export function recordsCsv(records) {
  const rows = records.map((r) => [
    fmtDate(r.ts), r.vehicle, r.driver, r.modeName, VERDICT[r.verdict].label, r.value, METRIC_LABEL[r.metric],
    r.warn, r.limit, r.leq, r.lmax, r.peakHz, r.zones?.low, r.zones?.mid, r.zones?.high,
    ...OCTAVES.map((_, i) => r.bands?.[i]),
    r.durationSec, r.loc?.lat, r.loc?.lon, r.memo, r.calibrated ? 'O' : 'X', r.clipped ? 'O' : '',
  ]);
  const csv = [CSV_HEAD, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
  // BOM so Excel opens the Korean text as UTF-8.
  return new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
}

function csvCell(v) {
  if (v == null) return '';
  let s = String(v);
  if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`; // keep Excel from running it as a formula
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Opens the phone's share sheet (KakaoTalk, mail, ...) with the file, or downloads it.
// Resolves 'shared' | 'downloaded' | 'cancelled'.
export async function deliverFile(blob, filename, { title, text } = {}) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
      // NotAllowedError etc.: fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return 'downloaded';
}
