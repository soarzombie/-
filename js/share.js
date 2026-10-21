// Getting saved analyses off the phone: text for messengers, a PNG card, CSV for Excel.

import { fmtDb, fmtHz, fmtDate, fmtClock } from './format.js';
import { drawSpectrum } from './spectrum.js';

export function summaryText(rec, settings) {
  const lines = [
    `[${rec.source === 'file' ? '파일 소음 분석' : '실시간 소음 분석'}] ${settings.company}`,
    `일시: ${fmtDate(rec.ts)}`,
    rec.source === 'file' ? `파일: ${rec.fileName}` : '',
    rec.vehicle ? `차량: ${rec.vehicle}` : '',
    `평균 ${fmtDb(rec.leq)} / 최대 ${fmtDb(rec.lmax)} / 최소 ${fmtDb(rec.lmin)} ${rec.unit || 'dB(A)'}`,
    `${rec.source === 'file' ? '길이' : '측정 시간'} ${fmtClock(rec.elapsed)}`,
    rec.peaks?.length ? `피크: ${rec.peaks.map((p) => fmtHz(p.hz)).join(', ')}` : '',
    rec.memo ? `메모: ${rec.memo}` : '',
    '※ 스마트폰 측정 참고값',
  ];
  return lines.filter(Boolean).join('\n');
}

const CARD = { bg: '#0e1013', panel: '#17191e', ink: '#f2f4f7', sub: '#9aa3b0', accent: '#ff5a66' };
const FONT = '-apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", "Malgun Gothic", sans-serif';

export function renderCard(rec, settings) {
  const W = 1080;
  const H = 1350;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const g = canvas.getContext('2d');
  const text = (s, x, y, size, color, weight = 500, align = 'left') => {
    g.font = `${weight} ${size}px ${FONT}`;
    g.fillStyle = color;
    g.textAlign = align;
    g.fillText(s, x, y);
  };
  g.fillStyle = CARD.bg;
  g.fillRect(0, 0, W, H);

  const fromFile = rec.source === 'file';
  text(settings.company, 64, 86, 34, CARD.sub, 600);
  text(fromFile ? '파일 소음 분석' : '실시간 소음 분석', 64, 146, 54, CARD.ink, 800);
  const sub = fmtDate(rec.ts) + (rec.vehicle ? `  ·  ${rec.vehicle}` : '') + (fromFile ? `  ·  ${rec.fileName}` : '');
  text(sub.length > 52 ? `${sub.slice(0, 51)}…` : sub, 64, 206, 34, CARD.sub, 500);

  const cols = [
    ['평균', rec.leq],
    ['최대', rec.lmax],
    ['최소', rec.lmin],
  ];
  cols.forEach(([label, v], i) => {
    const x = 64 + i * 330;
    text(label, x, 290, 32, CARD.sub, 600);
    text(fmtDb(v), x, 390, 104, i === 1 ? CARD.accent : CARD.ink, 800);
  });
  text(`${rec.unit || 'dB(A)'} · ${fromFile ? '길이' : '측정 시간'} ${fmtClock(rec.elapsed)}${rec.peaks?.length ? ` · 피크 ${rec.peaks.map((p) => fmtHz(p.hz)).join(', ')}` : ''}`, 64, 450, 32, CARD.sub, 500);

  g.fillStyle = CARD.panel;
  g.beginPath();
  g.roundRect ? g.roundRect(40, 500, W - 80, 720, 28) : g.rect(40, 500, W - 80, 720);
  g.fill();
  g.save();
  g.translate(56, 524);
  const sp = rec.spectrum;
  const line = settings.style === 'line';
  drawSpectrum(g, W - 112, 680, { freqs: Float32Array.from(sp.freqs), cur: Float32Array.from(sp.cur), max: Float32Array.from(sp.max), peaks: rec.peaks }, { scale: 'log', style: settings.style, range: sp.range, unit: rec.unit, fontScale: 2.2 });
  g.restore();

  const what = fromFile ? ['전체 평균', '전체 최대'] : ['저장 순간', '측정 중 최대'];
  text(`${line ? '노랑' : '빨강'}: ${what[0]} · ${line ? '분홍' : '회색'}: ${what[1]} · ${rec.calibrated ? '마이크 보정됨' : '보정 안 됨'} · 참고값`, 64, H - 70, 26, CARD.sub, 400);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

const CSV_HEAD = [
  '일시', '출처', '차량번호', '메모', '평균 Leq', '최대 Lmax', '최소 Lmin', '저장 순간', '단위', '측정·파일 길이(초)',
  '피크1 Hz', '피크1 dB(A)', '피크2 Hz', '피크2 dB(A)', 'FFT', '마이크 보정', '과부하', '소리(초)',
];

export function recordsCsv(records) {
  const rows = records.map((r) => [
    fmtDate(r.ts), r.source === 'file' ? r.fileName : '마이크', r.vehicle, r.memo, r.leq, r.lmax, r.lmin, r.laf, r.unit || 'dB(A)', Math.round(r.elapsed),
    r.peaks?.[0] && Math.round(r.peaks[0].hz), r.peaks?.[0]?.db, r.peaks?.[1] && Math.round(r.peaks[1].hz), r.peaks?.[1]?.db,
    r.fftSize, r.calibrated ? 'O' : 'X', r.clipped ? 'O' : '', r.audioSec || '',
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
