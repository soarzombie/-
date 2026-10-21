// SVG / HTML charts. Colours come from CSS classes so both themes and print work.

import { OCTAVES, ZONES } from './dsp.js';
import { ZONE_INFO, fmtDb } from './format.js';

const W = 340;
const H = 190;
const LEFT = 30;
const RIGHT = 6;
const TOP = 26;
const BOTTOM = 160;

// 1/1-octave A-weighted band levels as bars, with the low / mid / high groups shaded.
export function octaveChart(bands) {
  const values = bands.filter(Number.isFinite);
  if (!values.length) return '<p class="fine">주파수 데이터가 없습니다.</p>';
  const max = Math.max(...values);
  const top = Math.ceil((max + 4) / 10) * 10;
  // 40–60 dB of range: enough to compare bands, without very quiet bands squashing the rest.
  const bottom = Math.max(top - 60, Math.min(top - 40, Math.floor((Math.min(...values) - 2) / 10) * 10));
  const y = (v) => BOTTOM - ((Math.max(bottom, Math.min(top, v)) - bottom) / (top - bottom)) * (BOTTOM - TOP);
  const slot = (W - LEFT - RIGHT) / OCTAVES.length;
  const peak = bands.indexOf(max);

  let grid = '';
  for (let v = bottom; v <= top; v += 10) {
    grid += `<line class="ch-grid" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="ch-axis" x="${LEFT - 5}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }

  const zones = Object.entries(ZONES)
    .map(([zone, idx], i) => {
      const x = LEFT + idx[0] * slot;
      const w = idx.length * slot;
      return `<rect class="ch-zone ch-zone-${i}" x="${x}" y="${TOP - 18}" width="${w}" height="${BOTTOM - TOP + 18}"/>
        <text class="ch-zone-label" x="${x + w / 2}" y="${TOP - 5}" text-anchor="middle">${ZONE_INFO[zone].name}</text>`;
    })
    .join('');

  const bars = bands
    .map((v, i) => {
      const cx = LEFT + slot * (i + 0.5);
      const label = `<text class="ch-axis" x="${cx}" y="${BOTTOM + 16}" text-anchor="middle">${OCTAVES[i].label}</text>`;
      if (!Number.isFinite(v)) return label;
      const by = y(v);
      const value = i === peak ? `<text class="ch-value" x="${cx}" y="${by - 5}" text-anchor="middle">${fmtDb(v)}</text>` : '';
      return `<rect class="ch-bar${i === peak ? ' ch-bar-peak' : ''}" x="${cx - slot * 0.32}" y="${by}" width="${slot * 0.64}" height="${Math.max(1, BOTTOM - by)}" rx="2"/>${value}${label}`;
    })
    .join('');

  return `<svg class="octave-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="주파수 대역별 소음도, 가장 큰 대역 ${OCTAVES[peak].label}Hz ${fmtDb(max)} dB(A)">
    ${zones}${grid}${bars}
    <text class="ch-axis" x="${W - RIGHT}" y="${H - 2}" text-anchor="end">Hz · dB(A)</text>
  </svg>`;
}

// Horizontal scale with ok / warn / over segments and a marker at the measured value.
export function gauge(value, warn, limit) {
  const w = warn ?? limit;
  let lo = Math.floor((w - 20) / 10) * 10;
  let hi = Math.ceil((limit + 10) / 10) * 10;
  if (Number.isFinite(value)) {
    lo = Math.min(lo, Math.floor((value - 3) / 10) * 10);
    hi = Math.max(hi, Math.ceil((value + 3) / 10) * 10);
  }
  const pct = (v) => ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * 100;
  const marker = Number.isFinite(value) ? `<span class="gauge-marker" style="left:${pct(value)}%"></span>` : '';
  return `<div class="gauge" aria-hidden="true">
    <div class="gauge-track">
      <span class="gauge-seg gauge-ok" style="width:${pct(w)}%"></span>
      <span class="gauge-seg gauge-warn" style="width:${pct(limit) - pct(w)}%"></span>
      <span class="gauge-seg gauge-over" style="width:${100 - pct(limit)}%"></span>
      ${marker}
    </div>
    <div class="gauge-ticks">
      <span style="left:0%">${lo}</span>
      ${warn != null && warn !== limit ? `<span style="left:${pct(warn)}%">${warn}</span>` : ''}
      <span style="left:${pct(limit)}%">${limit}</span>
      <span style="left:100%">${hi}</span>
    </div>
  </div>`;
}

// Stacked bar of low / mid / high energy share.
export function zoneBar(shares) {
  const parts = Object.keys(ZONES)
    .map((zone, i) => {
      const v = shares?.[zone] || 0;
      return v > 0 ? `<span class="zone-seg zone-seg-${i}" style="flex-grow:${v}">${v >= 12 ? `${ZONE_INFO[zone].name} ${v}%` : ''}</span>` : '';
    })
    .join('');
  const legend = Object.keys(ZONES)
    .map((zone, i) => `<li><i class="zone-dot zone-seg-${i}"></i>${ZONE_INFO[zone].name} ${shares?.[zone] ?? 0}% <small>${ZONE_INFO[zone].range}</small></li>`)
    .join('');
  return `<div class="zone-bar">${parts}</div><ul class="zone-legend">${legend}</ul>`;
}
