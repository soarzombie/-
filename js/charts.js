// SVG / HTML charts. Colours come from CSS classes so both themes and print work.

import { BANDS, ZONE_NAMES, zoneOfFrequency } from './dsp.js';
import { ZONE_INFO, fmtDb } from './format.js';

const W = 360;
const H = 200;
const LEFT = 30;
const RIGHT = 6;
const TOP = 26;
const BOTTOM = 170;

// Vector version of the spectrum (for the printed report): 1/3-octave dB(A) bars with
// the low / mid / high groups shaded and octave centres labelled.
export function spectrumSvg(levels) {
  const values = (levels || []).filter(Number.isFinite);
  if (!values.length) return '<p class="fine">주파수 데이터가 없습니다.</p>';
  const max = Math.max(...values);
  const top = Math.ceil((max + 4) / 10) * 10;
  // 40–60 dB of range: enough to compare bands, without very quiet bands squashing the rest.
  const bottom = Math.max(top - 60, Math.min(top - 40, Math.floor((Math.min(...values) - 2) / 10) * 10));
  const y = (v) => BOTTOM - ((Math.max(bottom, Math.min(top, v)) - bottom) / (top - bottom)) * (BOTTOM - TOP);
  const slot = (W - LEFT - RIGHT) / BANDS.length;
  const peak = levels.indexOf(max);

  let zones = '';
  let start = 0;
  for (let i = 1; i <= BANDS.length; i++) {
    const zone = zoneOfFrequency(BANDS[start].exact);
    if (i < BANDS.length && zoneOfFrequency(BANDS[i].exact) === zone) continue;
    const x = LEFT + start * slot;
    const w = (i - start) * slot;
    zones += `<rect class="ch-zone ch-zone-${zone}" x="${x}" y="${TOP - 18}" width="${w}" height="${BOTTOM - TOP + 18}"/>
      <text class="ch-zone-label" x="${x + w / 2}" y="${TOP - 5}" text-anchor="middle">${ZONE_INFO[zone].name}</text>`;
    start = i;
  }

  let grid = '';
  for (let v = bottom; v <= top; v += 10) {
    grid += `<line class="ch-grid" x1="${LEFT}" x2="${W - RIGHT}" y1="${y(v)}" y2="${y(v)}"/>`;
    grid += `<text class="ch-axis" x="${LEFT - 5}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }

  const bars = levels
    .map((v, i) => {
      const cx = LEFT + slot * (i + 0.5);
      const label = BANDS[i].major ? `<text class="ch-axis" x="${cx}" y="${BOTTOM + 15}" text-anchor="middle">${BANDS[i].label}</text>` : '';
      if (!Number.isFinite(v)) return label;
      const by = y(v);
      const value = i === peak ? `<text class="ch-value" x="${cx}" y="${by - 5}" text-anchor="middle">${BANDS[i].label}Hz</text>` : '';
      return `<rect class="ch-bar${i === peak ? ' ch-bar-peak' : ''}" x="${cx - slot * 0.35}" y="${by}" width="${slot * 0.7}" height="${Math.max(1, BOTTOM - by)}"/>${value}${label}`;
    })
    .join('');

  return `<svg class="octave-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="1/3옥타브 주파수별 소음도, 가장 큰 대역 ${BANDS[peak].label}Hz ${fmtDb(max)} dB(A)">
    ${zones}${grid}${bars}
    <text class="ch-axis" x="2" y="${TOP - 5}">dB(A)</text>
    <text class="ch-axis" x="${W - RIGHT}" y="${H - 2}" text-anchor="end">주파수 (Hz)</text>
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
  const parts = ZONE_NAMES
    .map((zone, i) => {
      const v = shares?.[zone] || 0;
      return v > 0 ? `<span class="zone-seg zone-seg-${i}" style="flex-grow:${v}">${v >= 12 ? `${ZONE_INFO[zone].name} ${v}%` : ''}</span>` : '';
    })
    .join('');
  const legend = ZONE_NAMES
    .map((zone, i) => `<li><i class="zone-dot zone-seg-${i}"></i>${ZONE_INFO[zone].name} ${shares?.[zone] ?? 0}% <small>${ZONE_INFO[zone].range}</small></li>`)
    .join('');
  return `<div class="zone-bar">${parts}</div><ul class="zone-legend">${legend}</ul>`;
}
