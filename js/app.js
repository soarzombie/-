// Screens and navigation. Routes live in the URL hash so the phone's back button works:
// #/ (real-time analyzer), #/file (analyse an attached file), #/history, #/record/<id>, #/settings

import { APP_VERSION, getSettings, saveSettings, rememberVehicle } from './settings.js';
import { PRESETS, CUSTOM, presetOf, choosePreset, customize } from './presets.js';
import { micProfile, saveMicProfile, parseCalFile, calCorrection } from './mics.js';
import { trackSpeed, STALE_SEC } from './gps.js';
import { Meter, FFT_SIZES, MAX_RECORD_SEC } from './meter.js';
import { findPeaks, logGrid, rangeIndex, reduceRanges, unitOf, WEIGHTINGS, BANDS, bandIndex, bandLevels, newHolds, updateHolds } from './dsp.js';
import * as store from './store.js';
import { esc, fmtDb, fmtHz, fmtClock, fmtDate, fmtDay, fmtShortDate, fmtTime, fmtWhen, fileStamp, speedText } from './format.js';
import { SpectrumView, curveLook, checkFreqRange, checkDbRange, setChartTheme, FMIN, FMAX } from './spectrum.js';
import { SpectrogramView } from './spectrogram.js';
import { encodeWav, decodeAudioFile } from './audio.js';
import { analyzeSound, frameAt } from './analysis.js';
import { TimelineView, LiveTimelineView } from './timeline.js';
import { LevelBar } from './levelbar.js';
import { OctaveView } from './octave.js';
import { summaryText, renderCard, recordsCsv, deliverFile } from './share.js';

const view = document.getElementById('view');
let cleanup = null; // runs before the next screen renders
let adminUnlocked = false;

const svg = (body) => `<svg viewBox="0 0 24 24" aria-hidden="true">${body}</svg>`;
const ICON = {
  play: svg('<path class="fill" d="M8 5.5v13l10.5-6.5z"/>'),
  pause: svg('<path d="M9 5.5v13M15 5.5v13"/>'),
  reset: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/><circle class="fill" cx="12" cy="12" r="1.4"/>'),
  save: svg('<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 19.5h14"/>'),
  history: svg('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  settings: svg('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/>'),
  mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
  file: svg('<path d="M9 18V5l10-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5"/><circle class="fill" cx="12" cy="7.8" r="1.2"/>'),
  chevron: svg('<path d="M7 10l5 5 5-5"/>'),
  axes: svg('<path d="M4 4v16h16"/><path d="M8 8h3M8 12h6M8 16h9"/>'),
  timer: svg('<circle cx="12" cy="13.5" r="7.5"/><path d="M12 9.5v4l2.6 2M9.5 3h5M12 3v2.5"/>'),
  sliders: svg('<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>'),
};

const routes = {
  home: renderAnalyzer,
  file: renderFile,
  history: renderHistory,
  record: renderRecord,
  settings: renderSettings,
};

function route() {
  cleanup?.();
  cleanup = null;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = routes[name] ? name : 'home';
  document.body.dataset.view = key;
  const tab = key === 'record' ? 'history' : key;
  document.querySelectorAll('.tabbar a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  window.scrollTo(0, 0);
  Promise.resolve(routes[key](arg ? decodeURIComponent(arg) : undefined)).catch(showFatal);
}

function showFatal(err) {
  console.error(err);
  view.innerHTML = `<div class="page"><div class="alert">문제가 생겼습니다: ${esc(err?.message || err)}</div>
    <a class="btn btn-wide" href="#/">처음으로</a></div>`;
}

/* ---------- small UI helpers ---------- */

let toastTimer;
// action: { label, run } adds a button and keeps the message up longer
function toast(message, action = null) {
  const el = document.getElementById('toast');
  el.textContent = message;
  if (action) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => {
      el.hidden = true;
      action.run();
    };
    el.append(b);
  }
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), action ? 8000 : 2600);
}

function openSheet(html) {
  const dlg = document.createElement('dialog');
  dlg.className = 'sheet';
  dlg.innerHTML = `<div class="sheet-body">${html}</div>`;
  document.body.append(dlg);
  const close = () => (dlg.open && dlg.close ? dlg.close() : dlg.remove());
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('[data-close]')) close();
  });
  if (dlg.showModal) dlg.showModal();
  else dlg.setAttribute('open', '');
  return { dlg, close };
}

// Small menu that drops from a button (like a phone's context menu). Tapping outside or Esc closes it.
function openMenu(anchor, html, onClose = null, className = '') {
  const layer = document.createElement('div');
  layer.className = 'menu-layer';
  const menu = document.createElement('div');
  menu.className = `menu ${className}`.trim();
  menu.setAttribute('role', 'menu');
  menu.innerHTML = html;
  document.body.append(layer, menu);
  const a = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(a.right - m.width, window.innerWidth - m.width - 8))}px`;
  menu.style.top = `${Math.max(8, Math.min(a.bottom + 6, window.innerHeight - m.height - 8))}px`;
  const onKey = (e) => e.key === 'Escape' && close();
  const close = () => {
    if (!menu.isConnected) return;
    layer.remove();
    menu.remove();
    document.removeEventListener('keydown', onKey);
    anchor.setAttribute('aria-expanded', 'false');
    onClose?.();
  };
  document.addEventListener('keydown', onKey);
  layer.addEventListener('click', close); // the whole tap lands on the layer, not on what is under it
  anchor.setAttribute('aria-expanded', 'true');
  return { menu, close };
}

// 'dark' | 'light' (the bright screen for sunlight): page colours and chart colours.
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme === 'light' ? 'light' : 'dark';
  setChartTheme(theme);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', theme === 'light' ? '#eef0f3' : '#0b0d10');
}

// A setting changed by hand: a chosen measurement situation (presets.js) becomes 사용자 지정.
function changeSettings(patch) {
  return saveSettings(customize(getSettings(), patch));
}

// Names phones give their own microphone; an external one keeps its own calibration.
const BUILT_IN_MIC = /iphone|ipad|built-?in|internal|default|내장|기본|휴대폰|phone|microphone array|bottom|front|back/i;
// ...and names of plugged-in microphones (USB-C / Lightning / headset), never taken for the phone's own.
const EXTERNAL_MIC = /usb|imm-?\d|umik|dayton|minidsp|headset|external|외부|lightning|type-?c/i;

// The microphone now open: remember it, and (the first time) which one is the phone's own.
function noteMic(meter) {
  const st = getSettings();
  const label = meter.inputLabel;
  const patch = { lastMic: label };
  if (!st.baseMic && label && !EXTERNAL_MIC.test(label) && (BUILT_IN_MIC.test(label) || !st.calibratedAt)) patch.baseMic = label;
  saveSettings(patch);
  return micProfile(getSettings(), label);
}

const micName = (label) => label || '휴대폰 마이크';
const calDate = (p) => (p.calibratedAt ? `${fmtShortDate(p.calibratedAt)} 보정` : '보정 안 됨');
const calFileState = (p) =>
  p.cal
    ? [p.calName, `${p.cal.length}점`, `${fmtHz(p.cal[0][0])} – ${fmtHz(p.cal.at(-1)[0])}`, p.calSerial && `S/N ${p.calSerial}`, Number.isFinite(p.calSens) && `감도 ${p.calSens} dB (1 kHz)`].filter(Boolean).join(' · ')
    : '보정 파일 없음';

async function audioInputs() {
  try {
    return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && !['default', 'communications'].includes(d.deviceId));
  } catch {
    return [];
  }
}

async function keepScreenOn() {
  try {
    return (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    return null;
  }
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

// One-line cursor read-out: "A 1,250 Hz 62.3  B 125 Hz 47.6  B−A −14.7 dB" (levels in dB(A)).
// A saved record as a comparison reference: its average spectrum (a measurement's average since reset,
// a file's overall average; older measurements only have the moment of saving).
function refCurve(rec) {
  const sp = rec?.spectrum;
  if (!sp?.freqs) return null;
  return {
    id: rec.id,
    name: rec.vehicle || (rec.source === 'file' ? rec.fileName : '') || fmtWhen(rec.ts),
    when: fmtWhen(rec.ts),
    freqs: Float32Array.from(sp.freqs),
    values: Float32Array.from(sp.avg || sp.cur),
    leq: rec.leq,
    weighting: rec.weighting || 'A',
    unit: rec.unit || 'dB(A)',
  };
}

const signed = (d) => `${d >= 0 ? '+' : '−'}${fmtDb(Math.abs(d))}`;

function cursorText(values) {
  const parts = values.map((v, i) => `<span><b>${'AB'[i]}</b> ${fmtHz(v.hz)} <em>${fmtDb(v.cur)}</em>${Number.isFinite(v.ref) && Number.isFinite(v.cur) ? ` <i class="cr-ref">기준 ${fmtDb(v.ref)} (${signed(v.cur - v.ref)})</i>` : ''}</span>`);
  if (values.length === 2) {
    const d = values[1].cur - values[0].cur;
    parts.push(`<span class="cr-diff">B−A ${d >= 0 ? '+' : ''}${fmtDb(d)} dB</span>`);
  }
  return parts.join('');
}

function bindCursorReadout(el) {
  let shown = '';
  return (values) => {
    const html = values.length ? cursorText(values) : '';
    if (html === shown) return;
    shown = html;
    el.hidden = !html;
    el.querySelector('.cr-lines').innerHTML = html;
  };
}

// Legend: [curve, text] pairs in the style's colours (see curveLook).
function legendHtml(style, items) {
  const look = curveLook(style);
  return items.map(([key, text]) => `<span class="lg"><i class="sw sw-${look[key][1]}" style="--c:${look[key][0]}" aria-hidden="true"></i>${text}</span>`).join('');
}

const cursorBox = (id) =>
  `<div class="cursor-readout" id="${id}" hidden><div class="cr-lines"></div><button type="button" class="cr-close" aria-label="커서 지우기">×</button></div>`;

const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MISSING = -999; // stored for empty spectrum points (JSON has no -Infinity)

// Bottom sheet for vehicle number and memo; `beforeSave(form)` can add to the record, then it is stored.
function saveSheet({ title, rec, timeLabel, extra = '' }, beforeSave) {
  const st = getSettings();
  const { dlg, close } = openSheet(`
    <form class="sheet-form">
      <h2>${title}</h2>
      <dl class="save-summary">
        <div><dt>평균</dt><dd>${fmtDb(rec.leq)}</dd></div>
        <div><dt>최대</dt><dd>${fmtDb(rec.lmax)}</dd></div>
        <div><dt>최소</dt><dd>${fmtDb(rec.lmin)}</dd></div>
        <div><dt>${timeLabel}</dt><dd>${fmtClock(rec.elapsed)}</dd></div>
      </dl>
      <label class="field"><span>차량번호 <small>(선택)</small></span>
        <input id="f-vehicle" value="${esc(st.vehicle)}" placeholder="예: 12가 3456" autocomplete="off"></label>
      ${st.recentVehicles.length ? `<div class="chips">${st.recentVehicles.map((v) => `<button type="button" class="chip-pick" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>` : ''}
      <label class="field"><span>메모 <small>(선택)</small></span>
        <textarea id="f-memo" rows="3" placeholder="예: 시속 80km, 오른쪽 뒤에서 윙 소리"></textarea></label>
      ${extra}
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" data-close>취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
  const input = dlg.querySelector('#f-vehicle');
  dlg.querySelectorAll('.chip-pick').forEach((b) => (b.onclick = () => (input.value = b.dataset.v)));
  dlg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    e.submitter && (e.submitter.disabled = true);
    rec.vehicle = input.value.trim();
    rec.memo = dlg.querySelector('#f-memo').value.trim();
    if (rec.vehicle) rememberVehicle(rec.vehicle);
    await beforeSave?.(dlg);
    await store.putRecord(rec);
    close();
    toast('기록에 저장했습니다');
  };
  return dlg;
}

/* ---------- real-time analyzer ---------- */

const MODES = [
  { id: 'spectrum', name: '주파수 + 시간축', label: '주파수 그래프와 시간축 그래프', icon: svg('<path d="M2.5 12h3.5l2-5 3.5 11 3-14 2 8h5"/>') },
  { id: 'gram', name: '스펙트로그램', label: '스펙트로그램 (주파수별 시간 변화)', icon: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7 9h2.5M12 9h5M7 12h6M15.5 12h1.5M7 15h1.5M11 15h6"/>') },
  { id: 'octave', name: '1/3 옥타브', label: '1/3 옥타브 막대', icon: svg('<path stroke-width="2.6" d="M5.5 19v-5M9.5 19v-9M13.5 19v-13M17.5 19v-7"/>') },
];
const OCTAVE_FFT = 32768; // 1.46 Hz bins, so even the 10 Hz band has some
const CHART_STYLES = [['fill', '면'], ['line', '선'], ['bar', '막대']];
const TW_NAME = { F: 'Fast', S: 'Slow' };
const TIMED_SECS = [5, 10, 30, 60]; // "N초 측정" choices
// quick frequency ranges for the "축 범위" sheet
const FREQ_QUICK = [['전체', 20, 20000], ['저주파', 10, 200], ['저음', 20, 500], ['중음', 200, 5000], ['고음', 2000, 20000]];
const fmtHzShort = (f) => (f >= 1000 ? `${f / 1000}k` : String(f));
const STYLE_ORDER = CHART_STYLES.map(([v]) => v);
const STYLE_NAME = Object.fromEntries(CHART_STYLES);
// setting, menu text, curve (for the colour swatch)
const OVERLAYS = [
  ['maxTrack', '최대값 추적', 'maxTrack'],
  ['minTrack', '최소값 추적', 'minTrack'],
  ['peakHold', '피크 홀드', 'max'],
  ['minHold', '미니멈 홀드', 'min'],
];
const WEIGHT_NOTE = {
  A: '사람 귀에 가깝게 저음·고음을 줄여서 잽니다. 보통 소음은 A.',
  C: '저음까지 거의 그대로 잽니다. 엔진·부밍음처럼 저음이 큰 소리, 아주 큰 소리.',
  Z: '거르지 않은 원래 소리입니다.',
};

// Bottom-sheet row of choices; tapping one calls onPick(key, value).
function segRow(key, label, options, current, note = '') {
  return `<div class="seg-field"><span>${label}</span>
    <div class="seg" role="group" aria-label="${label}" data-key="${key}">
      ${options.map(([v, text]) => `<button type="button" data-v="${v}" aria-pressed="${String(v) === String(current)}">${text}</button>`).join('')}
    </div>${note ? `<p class="fine seg-note">${note}</p>` : ''}</div>`;
}

function bindSegs(dlg, onPick) {
  dlg.querySelectorAll('.seg').forEach((seg) =>
    seg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onPick(seg.dataset.key, b.dataset.v, seg);
    }),
  );
}

function helpSheet() {
  const s = getSettings();
  openSheet(`
    <div class="sheet-form help">
      <h2>화면 보는 법</h2>
      <dl class="meta">
        <dt>측정 상황</dt><dd>왼쪽 위 버튼. <b>공회전</b>·<b>주행</b>·<b>실내</b>·<b>저주파</b>를 고르면 가중치·FFT·그래프 모양·추적·홀드·시간축 길이가 그 상황에 맞게 한 번에 바뀝니다. 그 뒤에 직접 바꾸면 <b>사용자 지정</b>이 되고, 사용자 지정을 다시 고르면 직접 맞춰 둔 설정으로 돌아옵니다.</dd>
        <dt>큰 숫자</dt><dd>지금 소음 크기입니다. 숫자 옆 Fast(0.125초)는 빠른 변화를 따라가고, Slow(1초)는 덜 흔들려 읽기 쉽습니다. 설정에서 바꿉니다. 색 막대는 초록 → 노랑 → 빨강, 빨강은 경고 기준 ${s.alertLevel} dB 이상입니다. 밝은 칸 하나는 최대값입니다.</dd>
        <dt>최소·평균·최대</dt><dd>측정을 시작하거나 ↻ 초기화를 누른 뒤의 값입니다. 평균은 에너지 평균(Leq)입니다.</dd>
        <dt>A · C · Z</dt><dd>주파수 가중치. <b>A</b> 보통 소음(사람 귀에 가깝게) · <b>C</b> 엔진·부밍음처럼 저음이 큰 소리 · <b>Z</b> 거르지 않은 소리. 그래프 오른쪽 위 설정 버튼에서 바꿉니다.</dd>
        <dt>주파수 그래프</dt><dd>위쪽 큰 그래프. 가로는 주파수(20 Hz – 20 kHz), 세로는 dB입니다. 누르면 십자선 커서가 그 주파수의 값을 보여 주고, 한 번 더 누르면 커서 B로 두 곳을 비교합니다. 끌어서 옮기고 × 로 지웁니다.</dd>
        <dt>⚙ 차트 메뉴</dt><dd>그래프 오른쪽 위 버튼. 차트 스타일(면 · 선 · 막대), <b>최대값 추적</b>·<b>최소값 추적</b>(최근 큰·작은 값을 따라가다 초당 12 dB씩 돌아오는 점선), <b>피크 홀드</b>(초기화 뒤 가장 큰 값), <b>미니멈 홀드</b>(초기화 뒤 가장 작은 값, 주황), 홀드 재설정(이 선들만 새로 시작), 가중치·시간축·FFT·축 설정.</dd>
        <dt>축 범위</dt><dd>차트 메뉴의 "축 범위"에서 주파수 범위(전체 · 저음 · 중음 · 고음 또는 직접 입력)와 각 그래프의 dB 범위(자동 / 직접)를 정합니다. "처음대로"로 되돌립니다.</dd>
        <dt>시간축 그래프</dt><dd>아래쪽 작은 그래프. 가로는 측정 시간, 세로는 dB(큰 숫자와 같은 값), 점선은 평균입니다. 보이는 시간(30초 · 1분 · 5분)은 그래프 설정에서 바꿉니다.</dd>
        <dt>보기</dt><dd>${MODES.map((m) => m.label).join(' · ')}. 맨 위 버튼으로 바꿉니다.</dd>
        <dt>● 녹음</dt><dd>측정 버튼과 따로 움직입니다. 누른 때부터 정지할 때까지 녹음하고(최대 ${MAX_RECORD_SEC / 60}분, 그래프 위 빨간 시계가 녹음 길이), 측정을 일시정지해도 녹음은 계속됩니다. 정지해도 측정은 그대로 이어지고, 녹음은 파일 탭에 들어가 "분석 보기"로 바로 열 수 있습니다.</dd>
        <dt>▶ ⏸ 측정</dt><dd>측정 시작과 일시정지(화면과 값 고정). 녹음에는 영향을 주지 않습니다.</dd>
        <dt>마이크</dt><dd>평소에는 휴대폰 마이크로 잽니다. 외부 측정 마이크(iMM-6C 등)는 꽂은 뒤 그래프 설정의 "마이크"에서 고르면 되고, 쓰는 동안 이름이 화면 위에 보입니다. 외부 마이크는 설정 → 마이크 보정에서 따로 보정하고, 함께 받은 보정 파일을 넣으면 저음·고음 오차도 바로잡습니다.</dd>
        <dt>⏱ 정해진 시간 측정</dt><dd>누르면 처음부터 ${s.timedSec}초(그래프 설정에서 5초 · 10초 · 30초 · 1분)만큼 재고 저절로 멈춘 뒤 저장 창을 엽니다. 버튼 둘레가 차오르고, 다시 누르거나 일시정지하면 취소됩니다.</dd>
        <dt>속도 (GPS)</dt><dd>그래프 설정에서 켜면 차 속도가 그래프 위(노란 숫자)와 시간축 그래프(노란 선)에 나오고, 저장 기록에 평균·최고 속도가 남습니다. 위치 자체는 저장하지 않습니다.</dd>
        <dt>전후 비교</dt><dd>기록 화면의 "실시간과 비교"를 누르면 그 기록의 평균 스펙트럼이 보라 점선(기준)으로 실시간 그래프에 겹쳐지고, 평균 차이가 함께 나옵니다. "다른 기록과 비교"는 기록끼리 겹쳐 봅니다.</dd>
        <dt>⬇ 저장</dt><dd>지금 그래프와 값, 방금 들린 소리를 차량번호·메모와 함께 기록에 남깁니다.</dd>
      </dl>
      <p class="fine">스마트폰 측정값은 참고값이며 정밀 소음계를 대신하지 않습니다.</p>
      <button type="button" class="btn btn-wide" data-close>닫기</button>
    </div>`);
}

async function renderAnalyzer() {
  if (!MODES.some((m) => m.id === getSettings().view)) saveSettings({ view: 'spectrum' }); // e.g. the old gauge or "both" view
  const s = getSettings();
  view.innerHTML = `
    <section class="analyzer" data-state="off" data-rec="off" data-timed="off">
      <div class="an-modes" role="group" aria-label="보기">
        ${MODES.map((m) => `<button type="button" class="mode" data-mode="${m.id}" aria-label="${m.label}" aria-pressed="${s.view === m.id}">${m.icon}</button>`).join('')}
      </div>
      <div class="an-sub">
        <button type="button" class="an-preset" id="a-preset" aria-haspopup="menu" aria-expanded="false" aria-label="측정 상황: ${presetOf(s.preset).name}"><span>${presetOf(s.preset).name}</span>${ICON.chevron}</button>
        <span class="an-mic" id="a-mic" hidden></span>
        <p class="an-mode-name" id="a-mode-name">${MODES.find((m) => m.id === s.view)?.name || ''}</p>
        <p class="an-status"><i class="rec-dot"></i><span id="a-state">대기</span><b id="a-time">00:00</b></p>
      </div>
      <div class="an-level">
        <div class="led" id="a-led" aria-hidden="true"></div>
        <button type="button" class="round-btn lv-help" data-act="help" aria-label="도움말">${ICON.info}</button>
        <p class="lv-now"><b id="a-now">--.-</b><span id="a-unit">${unitOf(s.weighting)}</span><small class="lv-tw" id="a-tw">${TW_NAME[s.timeWeighting]}</small></p>
        <button type="button" class="round-btn lv-reset" data-act="reset" aria-label="초기화">${ICON.reset}</button>
        <p class="lv-stats"><span>최소 <b id="a-min">–</b></span><span>평균 <b id="a-leq">–</b></span><span>최대 <b id="a-max">–</b></span></p>
      </div>
      <div class="an-chart" data-view="${s.view}">
        <div class="chart-plot" id="a-chart"></div>
        <div class="gram-plot" id="a-gram"></div>
        <div class="octave-plot" id="a-octave"></div>
        <div class="trace-plot" id="a-trace"></div>
        <div class="chart-tools">
          <p class="rec-badge" id="a-rec-badge" hidden><i></i>녹음 <b id="a-rec-time">00:00</b></p>
          <button type="button" class="zoom-chip" data-act="zoom-reset" id="a-zoom" hidden>전체 보기</button>
          <p class="speed-badge" id="a-speed" hidden>– km/h</p>
          <p class="ref-chip" id="a-ref" hidden><i aria-hidden="true"></i><span id="a-ref-name"></span><b id="a-ref-diff"></b><button type="button" class="ref-close" data-act="ref-off" aria-label="기준 비교 끄기">×</button></p>
          <p class="an-peak" id="a-peak">피크 –</p>
          <button type="button" class="tool-btn" data-act="chart-settings" aria-label="그래프 설정" aria-haspopup="menu" aria-expanded="false">${ICON.sliders}</button>
        </div>
        ${cursorBox('a-cursor')}
        <div class="chart-overlay" id="a-overlay">
          <button type="button" class="mic-button" data-act="mic">${ICON.mic}<strong>눌러서 측정 시작</strong></button>
          <p class="overlay-note" id="a-note">처음 한 번은 마이크 사용을 "허용"해 주세요.</p>
        </div>
      </div>
      <div class="an-controls">
        <div class="ctl-group rec-group" role="group" aria-label="녹음">
          <button type="button" class="ctl ctl-rec" data-act="rec" aria-label="녹음 시작"><i class="rec-mark"></i><span class="ctl-cap" id="a-rec-cap">녹음</span></button>
        </div>
        <div class="ctl-group run-group" role="group" aria-label="측정">
          <button type="button" class="ctl ctl-timed" data-act="timed" aria-label="${s.timedSec}초 측정">${ICON.timer}<span class="ctl-cap" id="a-timed-cap">${s.timedSec}초 측정</span></button>
          <button type="button" class="ctl ctl-main" data-act="toggle" aria-label="측정 시작">${ICON.play}<span class="ctl-cap" id="a-toggle-cap">측정 시작</span></button>
          <button type="button" class="ctl ctl-save" data-act="save" aria-label="저장">${ICON.save}<span class="ctl-cap">저장</span></button>
        </div>
      </div>
      <nav class="an-nav" aria-label="메뉴">
        <a href="#/file" aria-label="파일 분석">${ICON.file}</a>
        <a href="#/history" aria-label="기록">${ICON.history}</a>
        <a href="#/settings" aria-label="설정">${ICON.settings}</a>
      </nav>
    </section>`;

  const $ = (id) => view.querySelector(`#${id}`);
  const root = view.querySelector('.analyzer');
  const toggleBtn = view.querySelector('[data-act=toggle]');
  const recBtn = view.querySelector('[data-act=rec]');
  const timedBtn = view.querySelector('[data-act=timed]');
  const chartBox = view.querySelector('.an-chart');
  const chart = new SpectrumView($('a-chart'), { cursor: true });
  chart.onCursor = bindCursorReadout($('a-cursor'));
  $('a-cursor').querySelector('.cr-close').onclick = () => chart.clearCursors();
  // two fingers pinch the frequency axis; "전체 보기" goes back to 20 Hz – 20 kHz
  let pinchAxis = null;
  chart.onZoom = ([fmin, fmax], done) => {
    pinchAxis = done ? null : [fmin, fmax];
    if (done) change({ freqMin: fmin, freqMax: fmax });
  };
  const gram = new SpectrogramView($('a-gram'));
  gram.configure({ scale: s.scale, fmin: s.freqMin, fmax: s.freqMax, colorRange: s.gramDb });
  gram.unit = unitOf(s.weighting);
  const octave = new OctaveView($('a-octave'));
  const trace = new LiveTimelineView($('a-trace'), { windowSec: s.traceSec || 30 }); // 0 was "hidden" before
  trace.configure({ unit: unitOf(s.weighting), yRange: s.traceDb, speed: s.gps });
  let traced = 0; // measured samples already in the trace
  const led = new LevelBar($('a-led'), s.alertLevel);
  let meter = null;
  let raf = 0;
  let wake = null;
  let holds = null; // per-bin peak / minimum hold and max / min tracking (newHolds)
  let avgPow = null; // slowly averaged spectrum, for steady peak labels
  let peaks = [];
  let bandIdx = null; // analyser bin -> 1/3-octave band
  let bandHolds = null; // { max, min } per band
  let lastFrameAt = 0;
  let holdFrom = 0; // no hold updates before this time (the analyser settles after an FFT size change)
  let lastPeakAt = 0;
  let menu = null; // the open chart menu
  let micProf = null; // calibration of the microphone in use (mics.js)
  let ref = null; // a saved record shown as a dashed reference (refCurve)
  let powSum = null; // per-bin power summed since reset, for the saved average spectrum
  let powN = 0;
  let geoWatch = null; // navigator.geolocation watch while measuring with 속도 on
  let gpsState = null; // trackSpeed state
  let speedNow = null; // km/h, with the time it was known
  let speedAt = 0;
  let spd = { sum: 0, n: 0, max: -Infinity }; // speed since reset, one value per level block
  let knownInputs = null; // microphones seen, to notice one being plugged in
  let lastRowAt = 0;
  let range = [-20, 100];
  let octRange = [0, 100];

  const mode = () => getSettings().view;
  const unit = () => unitOf(getSettings().weighting);

  const draw = (cur) => {
    const st = getSettings();
    if (st.view === 'octave') {
      bandHolds ||= { max: new Float32Array(BANDS.length).fill(-Infinity), min: new Float32Array(BANDS.length).fill(Infinity) };
      const bands = bandLevels(cur, bandIdx);
      if (holds) {
        // (holds exists once the warm-up is over)
        for (let b = 0; b < bands.length; b++) {
          if (bands[b] > bandHolds.max[b]) bandHolds.max[b] = bands[b];
          if (bands[b] < bandHolds.min[b]) bandHolds.min[b] = bands[b];
        }
      }
      const top = Math.max(meter.laf, ...bandHolds.max);
      if (top > octRange[1] - 4 && octRange[1] < 140) octRange = [octRange[0] + 20, octRange[1] + 20];
      octave.update(
        { bands, max: st.peakHold ? bandHolds.max : null, min: st.minHold ? bandHolds.min : null, total: meter.laf },
        { range: st.octDb || octRange, unit: unit(), style: st.style },
      );
    } else {
      const h = holds || {};
      chart.update(
        {
          freqs: meter.freqs,
          cur,
          max: st.peakHold ? h.max : null,
          min: st.minHold ? h.min : null,
          maxTrack: st.maxTrack ? h.maxTrack : null,
          minTrack: st.minTrack ? h.minTrack : null,
          ref,
          peaks,
        },
        { scale: st.scale, fmin: pinchAxis?.[0] ?? st.freqMin, fmax: pinchAxis?.[1] ?? st.freqMax, style: st.style, range: st.specDb || range, unit: unit() },
      );
    }
  };

  function showRunning(paused) {
    root.dataset.state = paused ? 'pause' : 'run';
    toggleBtn.firstElementChild.outerHTML = paused ? ICON.play : ICON.pause;
    toggleBtn.setAttribute('aria-label', paused ? '다시 측정' : '일시정지');
    $('a-toggle-cap').textContent = paused ? '측정 계속' : '일시정지';
    $('a-state').textContent = paused ? '일시정지' : meter?.timed ? `${Math.round(meter.limit / meter.sampleRate)}초 측정 중` : '측정 중';
  }

  // "홀드 재설정": the curves over the spectrum start again; levels and the time axis go on
  function resetHolds() {
    holds = null;
    bandHolds = null;
    range = [-20, 100];
    octRange = [0, 100];
  }

  function resetDisplays() {
    resetHolds();
    avgPow = null;
    powSum = null;
    powN = 0;
    peaks = [];
    $('a-peak').textContent = '피크 –';
  }

  function clearReadings() {
    resetDisplays();
    ['a-leq', 'a-max', 'a-min'].forEach((id) => ($(id).textContent = '–'));
    $('a-time').textContent = '00:00';
    led.set(NaN, NaN);
    gram.clear();
    traced = 0;
    spd = { sum: 0, n: 0, max: -Infinity };
    trace.configure({ leq: NaN, unit: unit() });
    trace.clear();
  }

  // 속도 (GPS): watched only while the microphone is on; only the speed is kept, never the position.
  const speed = () => (speedNow != null && Date.now() - speedAt < STALE_SEC * 1000 ? speedNow : null);
  function startGps() {
    if (!getSettings().gps || geoWatch != null || !meter) return;
    if (!navigator.geolocation) return toast('이 브라우저는 위치(속도)를 지원하지 않습니다');
    geoWatch = navigator.geolocation.watchPosition(
      (pos) => {
        const c = pos.coords;
        const r = trackSpeed(gpsState, { lat: c.latitude, lon: c.longitude, accuracy: c.accuracy, speed: c.speed, t: pos.timestamp || Date.now() });
        gpsState = r.state;
        if (r.kmh != null) {
          speedNow = r.kmh;
          speedAt = Date.now();
        }
        showSpeed();
      },
      (err) => {
        if (err.code !== 1) return showSpeed(); // no fix yet: keep trying
        toast('위치 사용이 허용되지 않아 속도를 표시할 수 없습니다');
        stopGps();
        saveSettings({ gps: false });
        trace.configure({ speed: false });
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 },
    );
    showSpeed();
  }

  function stopGps() {
    if (geoWatch != null) navigator.geolocation.clearWatch(geoWatch);
    geoWatch = null;
    gpsState = null;
    speedNow = null;
    showSpeed();
  }

  function showSpeed() {
    $('a-speed').hidden = geoWatch == null;
    const v = speed();
    $('a-speed').textContent = v == null ? '– km/h' : `${Math.round(v)} km/h`;
  }

  // The analyser runs at the chosen FFT size, or at 16384 for the octave bars.
  function applyFft() {
    if (!meter) return;
    const want = mode() === 'octave' ? OCTAVE_FFT : getSettings().fftSize;
    if (meter.analyser.fftSize !== want) {
      meter.setFftSize(want);
      resetDisplays();
      holdFrom = performance.now() + 400;
    }
    bandIdx = bandIndex(meter.freqs);
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!meter) return;
    if (!meter.running) {
      $('a-overlay').hidden = false;
      return;
    }
    if (!$('a-overlay').hidden) {
      $('a-overlay').hidden = true;
      showRunning(meter.paused);
    }
    if (meter.paused) return;
    const cur = meter.spectrum();
    if (!avgPow || avgPow.length !== cur.length) avgPow = new Float64Array(cur.length);
    // holds start after the warm-up, like the levels, so start-up silence is not the minimum
    const settled = !meter.warming && now >= holdFrom;
    if (settled) {
      if (!holds || holds.max.length !== cur.length) holds = newHolds(cur.length);
      updateHolds(holds, cur, Math.min(0.25, (now - lastFrameAt) / 1000));
      if (!powSum || powSum.length !== cur.length) {
        powSum = new Float64Array(cur.length);
        powN = 0;
      }
      powN++;
    }
    lastFrameAt = now;
    let top = -Infinity;
    for (let k = 1; k < cur.length; k++) {
      const v = holds ? holds.max[k] : cur[k];
      if (v > top) top = v;
      const p = 10 ** (cur[k] / 10);
      avgPow[k] += (p - avgPow[k]) * 0.1;
      if (settled) powSum[k] += p;
    }
    if (top > range[1] - 4 && range[1] < 140) range = [range[0], range[1] + 20];
    if (now - lastPeakAt > 300) {
      lastPeakAt = now;
      const avgDb = Float32Array.from(avgPow, (p) => 10 * Math.log10(p));
      peaks = findPeaks(avgDb, meter.binHz, { count: 2 });
      const main = peaks[0] || findPeaks(avgDb, meter.binHz, { count: 1, minProminence: -Infinity })[0];
      $('a-peak').textContent = main ? `피크 ${fmtHz(main.hz)}` : '피크 –';
    }
    if (now - lastRowAt >= 50) {
      lastRowAt = now;
      gram.push(cur, meter.freqs);
    }
    draw(cur);
  }

  function onLevel(db) {
    $('a-now').textContent = fmtDb(db);
    root.dataset.alert = String(db >= getSettings().alertLevel);
    $('a-leq').textContent = fmtDb(meter.leq);
    $('a-max').textContent = fmtDb(meter.lmax);
    $('a-min').textContent = fmtDb(meter.lmin);
    $('a-time').textContent = fmtClock(meter.elapsed);
    led.set(db, meter.lmax);
    if (ref) showRef();
    if (geoWatch != null) showSpeed();
    // the trace follows the measured time: nothing while warming up after a start or reset
    if (meter.stats.n > traced) {
      traced = meter.stats.n;
      const v = geoWatch != null ? speed() : null;
      if (v != null) {
        spd.sum += v;
        spd.n++;
        spd.max = Math.max(spd.max, v);
      }
      trace.push(db, v ?? NaN);
      trace.configure({ leq: meter.leq, unit: unit() });
      if (mode() === 'spectrum') trace.draw();
    }
  }

  async function startMic() {
    if (meter) {
      if (!meter.running) await meter.wake();
      return true;
    }
    const st = getSettings();
    meter = new Meter(st.offset, st.weighting, st.timeWeighting);
    try {
      // the sound buffer also holds a whole timed measurement (up to a minute)
      await meter.start(st.view === 'octave' ? OCTAVE_FFT : st.fftSize, st.audioSec > 0 ? Math.max(st.audioSec, ...TIMED_SECS) : 0, st.micId);
    } catch (err) {
      meter = null;
      if (err.code !== 'cancelled') {
        $('a-overlay').hidden = false;
        $('a-note').textContent = err.message;
        $('a-note').classList.add('is-error');
      }
      return false;
    }
    // this microphone's own calibration (offset, and the frequency response from its file)
    micProf = noteMic(meter);
    meter.setCalibration(micProf.offset, calCorrection(micProf.cal));
    showMic();
    if (meter.fellBack) toast('고른 마이크가 없어 휴대폰 기본 마이크로 측정합니다');
    meter.onInputLost = () => {
      toast('마이크 연결이 끊겨 다시 시작합니다');
      restartMic();
    };
    audioInputs().then((list) => (knownInputs = list));
    startGps();
    meter.onLevel = onLevel;
    meter.onRecordFull = () => {
      if (!stopping) toast(`녹음은 최대 ${MAX_RECORD_SEC / 60}분입니다`);
      stopRecording();
    };
    $('a-note').textContent = '';
    clearReadings();
    applyFft();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    keepScreenOn().then((w) => (wake = w));
    return true;
  }

  // An external microphone shows its name (and whether it is calibrated) in place of the view name.
  function showMic() {
    const st = getSettings();
    const label = meter?.inputLabel || '';
    const external = !!label && label !== st.baseMic;
    $('a-mic').hidden = !external;
    view.querySelector('.an-sub').classList.toggle('has-mic', external);
    if (!external) return;
    $('a-mic').textContent = `🎤 ${label}${micProf?.calibratedAt ? '' : ' · 보정 안 됨'}`;
    $('a-mic').classList.toggle('is-warn', !micProf?.calibratedAt);
  }

  async function restartMic() {
    if (meter?.recording) return toast('녹음 중에는 마이크를 바꿀 수 없습니다');
    stopMic();
    await startMic();
  }

  function useMic(d) {
    saveSettings({ micId: d.deviceId, micLabel: d.label });
    restartMic().then(() => meter && toast(`마이크: ${micName(meter.inputLabel)}`));
  }

  // A microphone plugged in while measuring: offer it.
  const onDeviceChange = async () => {
    const list = await audioInputs();
    const before = knownInputs;
    knownInputs = list;
    if (!before || !meter) return;
    const added = list.find((d) => d.label && !before.some((b) => b.deviceId === d.deviceId));
    if (added && added.label !== meter.inputLabel) toast(`새 마이크: ${added.label}`, { label: '이 마이크 쓰기', run: () => useMic(added) });
  };
  navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange);

  // Recorded sound -> a WAV file in the file tab. Measuring goes on; the message offers to open it.
  function keepRecording(samples, rate, leaving = false) {
    showRecording(false);
    if (samples.length < rate * 0.5) return toast('녹음이 너무 짧습니다');
    const ts = Date.now();
    openedFile = new File([encodeWav(samples, rate)], `녹음_${fileStamp(ts)}.wav`, { type: 'audio/wav', lastModified: ts });
    const len = fmtClock(samples.length / rate);
    if (leaving) toast(`녹음을 멈췄습니다 (${len}). 녹음한 소리는 파일 탭에 있습니다.`);
    else toast(`녹음 완료 ${len}`, { label: '분석 보기', run: () => (location.hash = '#/file') });
  }

  // The recording has its own clock (it runs on while measuring is paused).
  let recTimer = 0;
  function showRecording(on) {
    root.dataset.rec = on ? 'on' : 'off';
    recBtn.setAttribute('aria-label', on ? '녹음 정지' : '녹음 시작');
    $('a-rec-cap').textContent = on ? '녹음 정지' : '녹음';
    $('a-rec-badge').hidden = !on;
    clearInterval(recTimer);
    if (!on) return;
    $('a-rec-time').textContent = '00:00';
    recTimer = setInterval(() => meter?.recording && ($('a-rec-time').textContent = fmtClock(meter.recordedSec)), 250);
  }

  let stopping = false;
  async function stopRecording() {
    if (!meter?.recording || stopping) return;
    stopping = true;
    const rate = meter.sampleRate;
    recBtn.disabled = true;
    const samples = await meter.stopRecording();
    recBtn.disabled = false;
    stopping = false;
    keepRecording(samples, rate);
  }

  function stopMic() {
    cancelAnimationFrame(raf);
    showTimed(0);
    stopGps();
    if (meter?.recording) {
      // leaving mid-recording keeps what was recorded, ready in the file tab
      const rate = meter.sampleRate;
      keepRecording(meter.takeRecording(), rate, true);
    }
    meter?.stop();
    meter = null;
    wake?.release?.().catch(() => {});
    wake = null;
    root.dataset.state = 'off';
    toggleBtn.firstElementChild.outerHTML = ICON.play;
    toggleBtn.setAttribute('aria-label', '측정 시작');
    $('a-toggle-cap').textContent = '측정 시작';
    $('a-state').textContent = '대기';
    $('a-now').textContent = '--.-';
    $('a-overlay').hidden = false;
    led.set(NaN, NaN);
  }

  // Timed measurement: start again from zero, measure exactly N seconds, pause, then offer to save.
  // Tapping the button again or pausing cancels it; ↻ reset starts the N seconds again.
  let timedTimer = 0;
  async function startTimed() {
    if (!(await startMic()) || !meter.running) return;
    const sec = getSettings().timedSec;
    meter.resetStats();
    clearReadings();
    meter.paused = false;
    showRunning(false);
    meter.measureFor(sec, () => timedDone(sec));
    showTimed(sec);
  }

  // sec > 0: show the countdown on the button and in the status line; 0: back to the plain button.
  function showTimed(sec) {
    clearInterval(timedTimer);
    root.dataset.timed = sec ? 'on' : 'off';
    timedBtn.style.setProperty('--p', 0);
    const idle = `${getSettings().timedSec}초 측정`;
    timedBtn.setAttribute('aria-label', sec ? `${sec}초 측정 취소` : idle);
    $('a-timed-cap').textContent = sec ? `남은 ${sec}초` : idle;
    if (!sec) return;
    $('a-state').textContent = `${sec}초 측정 중`;
    timedTimer = setInterval(() => {
      if (!meter?.timed) return;
      timedBtn.style.setProperty('--p', Math.min(1, meter.elapsed / sec).toFixed(3));
      $('a-timed-cap').textContent = `남은 ${Math.max(0, Math.ceil(sec - meter.elapsed - 1e-6))}초`;
    }, 100);
  }

  function cancelTimed() {
    meter?.cancelTimed();
    showTimed(0);
    if (meter) showRunning(meter.paused);
    toast('정해진 시간 측정을 취소했습니다');
  }

  function timedDone(sec) {
    onLevel(meter.laf); // the last block: the clock reads the full N seconds
    showTimed(0);
    showRunning(true);
    $('a-state').textContent = `${sec}초 측정 끝`;
    holds ||= newHolds(meter.levels.length);
    draw(meter.levels);
    const audio = getSettings().audioSec > 0 ? meter.captureAudio(sec) : Promise.resolve(new Float32Array(0));
    openSave({ ...snapshot(), timedSec: sec }, audio);
  }

  // Everything needed to look at this moment again later.
  function snapshot() {
    const grid = logGrid(241, 20, 20000);
    const idx = rangeIndex(meter.freqs, grid.edges);
    const keep = (arr) => Array.from(arr, (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : MISSING));
    const st = getSettings();
    return {
      id: store.newId(),
      ts: Date.now(),
      leq: round1(meter.leq),
      lmax: round1(meter.lmax),
      lmin: round1(meter.lmin),
      laf: round1(meter.laf),
      elapsed: round1(meter.elapsed),
      clipped: meter.stats.clipped,
      peaks: peaks.map((p) => ({ hz: Math.round(p.hz), db: round1(p.db) })),
      spectrum: {
        freqs: Array.from(grid.centres, (f) => Math.round(f * 10) / 10),
        cur: keep(reduceRanges(meter.levels, meter.freqs, idx, grid.centres)),
        max: keep(reduceRanges(holds.max, meter.freqs, idx, grid.centres)),
        ...(powN ? { avg: keep(reduceRanges(Float32Array.from(powSum, (p) => 10 * Math.log10(p / powN)), meter.freqs, idx, grid.centres)) } : {}),
        ...(st.minHold ? { min: keep(reduceRanges(holds.min, meter.freqs, idx, grid.centres)) } : {}),
        range: [...(st.specDb || range)],
      },
      fftSize: meter.analyser.fftSize,
      sampleRate: meter.sampleRate,
      offset: meter.offset,
      weighting: meter.weighting,
      timeWeighting: meter.timeWeighting,
      unit: meter.unit,
      calibrated: !!micProf?.calibratedAt,
      mic: meter.inputLabel,
      micCal: micProf?.calName || '',
      ...(ref ? { refId: ref.id } : {}),
      ...(geoWatch != null ? { speed: round1(speed()), speedAvg: spd.n ? round1(spd.sum / spd.n) : null, speedMax: spd.n ? round1(spd.max) : null } : {}),
      vehicle: '',
      memo: '',
      app: APP_VERSION,
    };
  }

  // The reference chip: its name and how the average since reset compares (same weighting only).
  function showRef() {
    $('a-ref').hidden = !ref;
    chartBox.classList.toggle('has-ref', !!ref);
    if (!ref) return;
    $('a-ref-name').textContent = `기준 ${ref.name}`;
    const same = ref.weighting === getSettings().weighting;
    const d = meter && meter.elapsed > 0 && Number.isFinite(ref.leq) ? meter.leq - ref.leq : NaN;
    $('a-ref-diff').textContent = !same ? `${ref.weighting}특성 기록` : Number.isFinite(d) ? `${signed(d)} dB` : '';
    $('a-ref').classList.toggle('is-warn', !same);
  }

  function refOff() {
    ref = null;
    saveSettings({ refId: '' });
    showRef();
    if (meter?.paused && holds) draw(meter.levels);
  }

  function openSave(rec, audio) {
    const what = rec.timedSec ? `측정한 ${rec.timedSec}초 소리` : '방금 들린 소리';
    const extra = getSettings().audioSec > 0 ? `<label class="check"><input type="checkbox" id="f-audio" checked> <span id="f-audio-label">${what}도 함께 저장</span></label>` : '';
    const title = rec.timedSec ? `${rec.timedSec}초 측정 저장` : '지금 측정 저장';
    const dlg = saveSheet({ title, rec, timeLabel: '측정 시간', extra }, async (form) => {
      const samples = form.querySelector('#f-audio')?.checked ? await audio : null;
      if (samples?.length) {
        rec.audio = encodeWav(samples, rec.sampleRate);
        rec.audioSec = round1(samples.length / rec.sampleRate);
      }
    });
    audio.then((samples) => {
      const label = dlg.querySelector('#f-audio-label');
      if (label) label.textContent = samples.length ? `${rec.timedSec ? '측정한' : '방금 들린'} 소리 ${(samples.length / rec.sampleRate).toFixed(0)}초도 함께 저장` : '저장할 소리가 없습니다';
    });
  }

  function setMode(id) {
    saveSettings({ view: id });
    chartBox.dataset.view = id;
    view.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === id)));
    $('a-mode-name').textContent = MODES.find((m) => m.id === id).name;
    applyFft();
    if (meter?.paused && holds) draw(meter.levels);
  }

  function chartSettings() {
    const st = getSettings();
    const { dlg } = openSheet(`
      <div class="sheet-form chart-sheet">
        <h2>측정 · 그래프 설정</h2>
        <h3 class="sheet-sub">측정</h3>
        <div class="seg-field mic-field"><span>마이크</span>
          <select id="f-mic" aria-label="마이크"><option value="">휴대폰 기본 마이크</option></select>
          <p class="fine seg-note" id="f-mic-note"></p></div>
        ${segRow('weighting', '주파수 가중치', WEIGHTINGS.map((w) => [w, `${w}특성`]), st.weighting, `<span id="f-weight-note">${WEIGHT_NOTE[st.weighting]}</span> 바꾸면 최소·평균·최대가 새로 시작합니다.`)}
        ${segRow('timeWeighting', '시간 가중 (큰 숫자)', [['F', 'Fast 0.125초'], ['S', 'Slow 1초']], st.timeWeighting, 'Slow는 숫자가 덜 흔들려 읽기 쉽습니다. 바꾸면 최소·평균·최대가 새로 시작합니다.')}
        ${segRow('timed', '정해진 시간 측정 (⏱ 버튼)', TIMED_SECS.map((n) => [n, n < 60 ? `${n}초` : '1분']), st.timedSec, '누르면 처음부터 이 시간만큼 재고 멈춘 뒤 저장 창을 엽니다.')}
        ${segRow('gps', '속도 (GPS)', [['off', '끔'], ['on', '켬']], st.gps ? 'on' : 'off', '켜면 위치 권한을 묻고, 차 속도를 그래프 위와 시간축 그래프(노란 선), 저장 기록에 함께 남깁니다. 위치는 저장하지 않습니다.')}
        <h3 class="sheet-sub">그래프</h3>
        ${segRow('trace', '시간축 그래프 길이', [[30, '30초'], [60, '1분'], [300, '5분']], st.traceSec || 30)}
        ${segRow('fft', 'FFT 크기', FFT_SIZES.map((n) => [n, n]), st.fftSize, '클수록 주파수를 잘게 나누지만 반응이 느려집니다. 1/3 옥타브 보기는 늘 32768로 계산합니다.')}
        ${segRow('scale', '주파수 축', [['log', '로그'], ['linear', '선형']], st.scale, '주파수 그래프를 두 손가락으로 벌리거나 좁혀도 범위가 바뀝니다.')}
        ${segRow('theme', '화면 밝기', [['dark', '어둡게'], ['light', '밝게 (햇빛 아래)']], st.theme)}
        <button type="button" class="btn btn-wide" data-close>닫기</button>
      </div>`);
    const micSel = dlg.querySelector('#f-mic');
    const micNote = () => {
      const label = meter?.inputLabel || getSettings().lastMic;
      const p = micProfile(getSettings(), label);
      dlg.querySelector('#f-mic-note').textContent = `지금: ${micName(label)} · ${p.calibratedAt ? `${fmtShortDate(p.calibratedAt)} 보정 (${p.offset} dB)` : '보정 안 됨'}${p.cal ? ` · 보정 파일 ${p.calName}` : ''}. 외부 측정 마이크(iMM-6C 등)는 꽂으면 목록에 나오고, 보정은 설정 → 마이크 보정에서 따로 합니다.`;
    };
    micNote();
    audioInputs().then((list) => {
      const st2 = getSettings();
      for (const d of list) {
        const o = document.createElement('option');
        o.value = d.deviceId;
        o.textContent = d.label || '이름 없는 마이크';
        micSel.append(o);
      }
      micSel.value = list.some((d) => d.deviceId === st2.micId) ? st2.micId : '';
    });
    micSel.onchange = () => {
      const opt = micSel.selectedOptions[0];
      useMic({ deviceId: micSel.value, label: micSel.value ? opt.textContent : '' });
      setTimeout(micNote, 1500);
    };
    bindSegs(dlg, (key, v) => {
      const numeric = { trace: 'traceSec', fft: 'fftSize', timed: 'timedSec' };
      change(key === 'gps' ? { gps: v === 'on' } : numeric[key] ? { [numeric[key]]: Number(v) } : { [key]: v });
      if (key === 'weighting') dlg.querySelector('#f-weight-note').textContent = WEIGHT_NOTE[v];
    });
  }

  // Settings changed (by hand, from a menu, or by a measurement situation): the live view follows.
  function applyLive(prev) {
    const st = getSettings();
    if (st.weighting !== prev.weighting) {
      $('a-unit').textContent = unitOf(st.weighting);
      gram.unit = unitOf(st.weighting);
      if (meter) meter.setWeighting(st.weighting);
      clearReadings();
    }
    if (st.timeWeighting !== prev.timeWeighting) {
      $('a-tw').textContent = TW_NAME[st.timeWeighting];
      if (meter) meter.setTimeWeighting(st.timeWeighting);
      clearReadings();
    }
    if (st.fftSize !== prev.fftSize) applyFft();
    if (st.timedSec !== prev.timedSec && !meter?.timed) showTimed(0);
    if (st.theme !== prev.theme) {
      applyTheme(st.theme);
      trace.draw();
      gram.draw();
      octave.draw();
    }
    if (st.gps !== prev.gps) {
      if (st.gps) startGps();
      else stopGps();
      trace.configure({ speed: st.gps });
      trace.draw();
    }
    if (ref) showRef();
    gram.configure({ scale: st.scale, fmin: st.freqMin, fmax: st.freqMax, colorRange: st.gramDb });
    if (st.traceSec !== prev.traceSec || st.traceDb !== prev.traceDb) {
      trace.configure({ windowSec: st.traceSec || 30, yRange: st.traceDb });
      trace.draw();
    }
    $('a-zoom').hidden = st.freqMin === FMIN && st.freqMax === FMAX;
    const p = presetOf(st.preset);
    $('a-preset').firstElementChild.textContent = p.name;
    $('a-preset').setAttribute('aria-label', `측정 상황: ${p.name}`);
    if (meter?.paused && holds) draw(meter.levels);
  }

  function change(patch) {
    const prev = getSettings();
    changeSettings(patch);
    applyLive(prev);
  }

  // "축 범위": the frequency range (spectrum and spectrogram) and, per graph, an automatic or fixed dB range.
  function rangeSheet() {
    const st = getSettings();
    const dbAxes = [
      ['specDb', '주파수 그래프 · 세로', () => range],
      ['traceDb', '시간축 그래프 · 세로', () => trace.shown || [40, 100]],
      ['gramDb', '스펙트로그램 · 색 범위', () => (gram.top != null ? [Math.round(gram.top - 60), Math.round(gram.top)] : [20, 80])],
      ['octDb', '1/3 옥타브 · 세로', () => octRange],
    ];
    const numIn = (attr, v, label) => `<input type="number" ${attr} value="${v}" aria-label="${label}">`;
    const { dlg, close } = openSheet(`
      <div class="sheet-form range-sheet">
        <h2>축 범위</h2>
        <section class="range-block range-freq">
          <h3>가로: 주파수 <small>주파수 그래프 · 스펙트로그램</small></h3>
          <div class="chips">${FREQ_QUICK.map(([t, lo, hi]) => `<button type="button" class="chip-pick" data-f="${lo},${hi}">${t} <small>${fmtHzShort(lo)}–${fmtHzShort(hi)}</small></button>`).join('')}</div>
          <div class="range-row">${numIn('id="r-fmin" step="1"', st.freqMin, '시작 주파수 (Hz)')}<span>~</span>${numIn('id="r-fmax" step="1"', st.freqMax, '끝 주파수 (Hz)')}<span>Hz</span></div>
        </section>
        ${dbAxes.map(([key, title]) => `<section class="range-block" data-range="${key}">
          <h3>${title} <small>dB</small></h3>
          <div class="range-line">
            <div class="seg" role="group" aria-label="${title}" data-key="${key}">
              <button type="button" data-v="auto" aria-pressed="${!st[key]}">자동</button><button type="button" data-v="manual" aria-pressed="${!!st[key]}">직접</button>
            </div>
            <div class="range-row"${st[key] ? '' : ' hidden'}>${numIn('data-lo step="5"', st[key]?.[0] ?? '', `${title} 아래 (dB)`)}<span>~</span>${numIn('data-hi step="5"', st[key]?.[1] ?? '', `${title} 위 (dB)`)}</div>
          </div>
        </section>`).join('')}
        <p class="alert" id="r-error" hidden></p>
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" data-act="r-reset">처음대로</button>
          <button type="button" class="btn btn-primary" data-close>닫기</button>
        </div>
      </div>`);
    const err = dlg.querySelector('#r-error');
    const fail = (msg) => {
      err.textContent = msg;
      err.hidden = false;
    };
    const setFreq = (lo, hi) => {
      const ok = checkFreqRange(lo, hi);
      if (typeof ok === 'string') return fail(ok);
      err.hidden = true;
      dlg.querySelector('#r-fmin').value = lo;
      dlg.querySelector('#r-fmax').value = hi;
      change({ freqMin: lo, freqMax: hi });
    };
    const readFreq = () => setFreq(parseFloat(dlg.querySelector('#r-fmin').value), parseFloat(dlg.querySelector('#r-fmax').value));
    dlg.querySelector('#r-fmin').addEventListener('change', readFreq);
    dlg.querySelector('#r-fmax').addEventListener('change', readFreq);
    dlg.querySelectorAll('[data-f]').forEach((b) => (b.onclick = () => setFreq(...b.dataset.f.split(',').map(Number))));
    const readDb = (block) => {
      const lo = parseFloat(block.querySelector('[data-lo]').value);
      const hi = parseFloat(block.querySelector('[data-hi]').value);
      const ok = checkDbRange(lo, hi);
      if (typeof ok === 'string') return fail(ok);
      err.hidden = true;
      change({ [block.dataset.range]: ok });
    };
    dlg.querySelectorAll('[data-range]').forEach((block) => block.querySelectorAll('input').forEach((i) => i.addEventListener('change', () => readDb(block))));
    bindSegs(dlg, (key, v) => {
      const block = dlg.querySelector(`[data-range=${key}]`);
      block.querySelector('.range-row').hidden = v === 'auto';
      err.hidden = true;
      if (v === 'auto') return change({ [key]: null });
      // a fixed range starts from what the graph shows now
      const [lo, hi] = dbAxes.find(([k]) => k === key)[2]().map((x) => Math.round(x));
      block.querySelector('[data-lo]').value = lo;
      block.querySelector('[data-hi]').value = hi;
      change({ [key]: [lo, hi] });
    });
    dlg.querySelector('[data-act=r-reset]').onclick = () => {
      change({ freqMin: 20, freqMax: 20000, specDb: null, traceDb: null, gramDb: null, octDb: null });
      close();
      toast('축 범위를 처음대로 돌렸습니다');
    };
  }

  // "측정 상황" (the reference app's "사용자 지정 ⌄"): one choice sets several settings at once.
  function presetMenu() {
    if (menu) return menu.close();
    const st = getSettings();
    menu = openMenu(
      $('a-preset'),
      `<div class="menu-group"><p class="menu-head">측정 상황</p>
        ${[...PRESETS, CUSTOM].map((p) => `<button type="button" role="menuitemradio" aria-checked="${st.preset === p.id}" data-preset="${p.id}"><span class="mi-text">${p.name}<small>${p.note}</small></span></button>`).join('')}
      </div>
      <p class="menu-foot">고른 뒤에 설정을 직접 바꾸면 '사용자 지정'이 됩니다.</p>`,
      () => (menu = null),
      'menu-preset',
    );
    menu.menu.addEventListener('click', (e) => {
      const b = e.target.closest('[data-preset]');
      if (!b) return;
      const prev = getSettings();
      saveSettings(choosePreset(prev, b.dataset.preset));
      menu.close();
      applyLive(prev);
      toast(`측정 상황: ${presetOf(b.dataset.preset).name}`);
    });
  }

  // The chart button's menu, after the reference app: chart style, tracking / hold curves, hold reset,
  // and the rest of the graph settings.
  function chartMenu() {
    if (menu) return menu.close();
    const anchor = view.querySelector('[data-act=chart-settings]');
    const html = () => {
      const st = getSettings();
      const look = curveLook(st.style);
      const sw = (key) => `<i class="sw sw-${look[key][1]}" style="--c:${look[key][0]}" aria-hidden="true"></i>`;
      return `
        <div class="menu-group"><p class="menu-head">차트 스타일</p>
          ${CHART_STYLES.map(([v, t]) => `<button type="button" role="menuitemradio" aria-checked="${st.style === v}" data-style="${v}">${t}</button>`).join('')}
        </div>
        <div class="menu-group"><p class="menu-head">추적 · 홀드</p>
          ${OVERLAYS.map(([key, t, curve]) => `<button type="button" role="menuitemcheckbox" aria-checked="${!!st[key]}" data-toggle="${key}">${t}${sw(curve)}</button>`).join('')}
        </div>
        <div class="menu-group menu-wide">
          <button type="button" role="menuitem" data-act="hold-reset">${ICON.reset}홀드 재설정</button>
          <button type="button" role="menuitem" data-act="ranges">${ICON.axes}축 범위</button>
          <button type="button" role="menuitem" data-act="more">${ICON.sliders}<span class="mi-text">측정 · 그래프 설정<small>마이크 · 가중치 · 정해진 시간 · 속도 · FFT · 화면 밝기</small></span></button>
        </div>`;
    };
    menu = openMenu(anchor, html(), () => (menu = null), 'menu-chart');
    menu.menu.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.style) change({ style: b.dataset.style });
      else if (b.dataset.toggle) change({ [b.dataset.toggle]: !getSettings()[b.dataset.toggle] });
      else if (b.dataset.act === 'hold-reset') {
        resetHolds();
        menu.close();
        toast('홀드를 다시 시작합니다');
      } else if (b.dataset.act === 'more') {
        menu.close();
        chartSettings();
      } else if (b.dataset.act === 'ranges') {
        menu.close();
        rangeSheet();
      }
      if (menu) menu.menu.innerHTML = html(); // ticks and colour swatches follow the choice
      if (meter?.paused && holds) draw(meter.levels);
    });
  }

  const onVisibility = () => {
    if (document.hidden) stopMic();
    else micPermission().then((p) => p === 'granted' && !meter && startMic());
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange);
    menu?.close();
    stopMic();
    chart.destroy();
    gram.destroy();
    octave.destroy();
    trace.destroy();
  };

  view.querySelector('[data-act=mic]').onclick = () => startMic();
  toggleBtn.onclick = async () => {
    if (!meter || !meter.running) return startMic();
    if (meter.timed) cancelTimed();
    meter.paused = !meter.paused;
    showRunning(meter.paused);
  };
  timedBtn.onclick = () => (meter?.timed ? cancelTimed() : startTimed());
  // Recording is separate from measuring: it does not resume a paused measurement, pausing does not
  // stop it, and stopping it leaves the measurement running. It only turns the microphone on if needed.
  recBtn.onclick = async () => {
    if (meter?.recording) return stopRecording();
    if (!(await startMic())) return;
    meter.startRecording();
    showRecording(true);
  };
  view.querySelector('[data-act=reset]').onclick = () => {
    if (!meter) return;
    meter.resetStats();
    clearReadings();
    if (meter.paused) draw(meter.levels);
  };
  view.querySelector('[data-act=save]').onclick = () => {
    if (!meter || !holds || meter.elapsed < 1) return toast('측정을 시작한 뒤에 저장할 수 있습니다');
    // grab the sound first: it is "what was just heard", before the sheet takes any time
    const audio = getSettings().audioSec > 0 ? meter.captureAudio(getSettings().audioSec) : Promise.resolve(new Float32Array(0));
    openSave(snapshot(), audio);
  };
  view.querySelector('[data-act=help]').onclick = helpSheet;
  view.querySelector('[data-act=ref-off]').onclick = refOff;
  $('a-zoom').hidden = s.freqMin === FMIN && s.freqMax === FMAX;
  $('a-zoom').onclick = () => change({ freqMin: FMIN, freqMax: FMAX });
  view.querySelector('[data-act=chart-settings]').onclick = chartMenu;
  $('a-preset').onclick = presetMenu;
  view.querySelectorAll('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

  if (s.refId) {
    ref = refCurve(await store.getRecord(s.refId).catch(() => null));
    if (!ref) saveSettings({ refId: '' });
    showRef();
  }
  if ((await micPermission()) === 'granted') startMic();
}

/* ---------- attached file ---------- */

const AUDIO_ACCEPT = 'audio/*,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.aac,.wav,.ogg,.oga,.opus,.flac,.webm,.amr,.3gp,.caf';
const MAX_SEC = 300;
const KEEP_AUDIO_BYTES = 30 * 1024 * 1024; // bigger files are analysed but not stored with the record
let openedFile = null; // the last file, so coming back to the tab shows it again

// y range that fits a spectrum: 120 dB ending a little above its loudest point
function rangeFor(levels) {
  let top = -Infinity;
  for (const v of levels) if (v > top) top = v;
  const hi = Number.isFinite(top) ? Math.ceil((top + 10) / 20) * 20 : 100;
  return [hi - 120, hi];
}

// 241-point copy of a spectrum for storing with a record (same grid as live snapshots)
function forRecord(levels, freqs) {
  const grid = logGrid(241, 20, 20000);
  const out = reduceRanges(levels, freqs, rangeIndex(freqs, grid.edges), grid.centres);
  return {
    freqs: Array.from(grid.centres, (f) => Math.round(f * 10) / 10),
    values: Array.from(out, (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : MISSING)),
  };
}

async function renderFile() {
  view.innerHTML = `
    <div class="page file-page">
      <h1 class="page-title">파일 분석</h1>
      <label class="file-drop" id="fa-drop">
        <input type="file" id="fa-input" accept="${AUDIO_ACCEPT}">
        ${ICON.file}
        <strong>음원·녹음 파일 열기</strong>
        <span>mp3 · m4a · wav · aac · ogg · 동영상 소리 등 · 처음 ${MAX_SEC / 60}분까지 분석</span>
      </label>
      <p class="fine file-hint">휴대폰 녹음 앱으로 녹음한 파일, 카톡·메신저로 받은 파일(먼저 휴대폰에 저장)을 열 수 있습니다. 파일은 이 휴대폰 안에서만 분석되고 어디에도 올라가지 않습니다.</p>
      <div id="fa-result"></div>
    </div>`;
  const $ = (id) => view.querySelector(`#${id}`);
  const result = $('fa-result');
  let teardown = null;
  cleanup = () => teardown?.();

  async function open(file) {
    teardown?.();
    teardown = null;
    openedFile = file;
    $('fa-drop').classList.add('is-compact');
    view.querySelector('.file-hint')?.remove();
    result.innerHTML = '<p class="busy">파일 여는 중…</p>';
    let decoded;
    try {
      decoded = await decodeAudioFile(file, { maxSec: MAX_SEC });
    } catch {
      result.innerHTML = '<p class="alert">이 파일은 열 수 없습니다. mp3, m4a, wav 같은 소리 파일인지 확인해 주세요.</p>';
      return;
    }
    if (!decoded.samples.length) {
      result.innerHTML = '<p class="alert">소리가 없는 파일입니다.</p>';
      return;
    }
    teardown = await showAnalysis(file, decoded);
  }

  async function showAnalysis(file, decoded) {
    result.innerHTML = '<p class="busy">소리 분석 중…</p>';
    await sleep(30); // let the message paint before the number crunching
    const st = getSettings();
    const calibrated = st.fileUnit !== 'fs';
    const unit = unitOf(st.weighting, !calibrated);
    const prof = micProfile(st, st.lastMic);
    const a = analyzeSound(decoded.samples, decoded.rate, calibrated ? prof.offset : 0, {
      weighting: st.weighting,
      timeWeighting: st.timeWeighting,
      correction: calibrated ? calCorrection(prof.cal) : null,
    });
    const range = rangeFor(a.max);
    const loudestAt = a.history.length ? a.history.indexOf(Math.max(...a.history)) * a.historyStep + a.historyStep : 0;
    const url = URL.createObjectURL(file);
    result.innerHTML = `
      <div class="file-layout">
      <section class="card file-head">
        <h2 class="file-name">${esc(file.name)}</h2>
        <p class="fine">${fmtClock(decoded.duration)} · ${decoded.rate / 1000} kHz · ${decoded.channels === 1 ? '모노' : `${decoded.channels}채널 → 모노로 분석`} · ${(file.size / 1048576).toFixed(1)} MB${decoded.capped ? ` · 처음 ${MAX_SEC / 60}분만 분석` : ''}</p>
        <audio controls preload="auto" id="fa-audio" src="${url}"></audio>
      </section>
        <section class="card chart-card fa-chart">
          <div class="chart-box-rec"><div class="chart-plot" id="fa-chart"></div></div>
          ${cursorBox('fa-cursor')}
          <p class="legend"><span class="lg-items" id="fa-legend"></span>
            <button type="button" class="link" id="fa-avg" hidden>전체 평균 보기</button></p>
        </section>
        <div class="an-options" role="group" aria-label="분석 설정">
          <button type="button" class="opt" data-opt="unit"><span>레벨 기준</span><b>${calibrated ? `보정 ${unitOf(st.weighting)}` : '파일 dBFS'}</b></button>
          <button type="button" class="opt" data-opt="weighting"><span>가중치</span><b>${st.weighting}특성</b></button>
          <button type="button" class="opt" data-opt="style"><span>모양</span><b>${STYLE_NAME[st.style]}</b></button>
          <button type="button" class="opt" data-opt="scale"><span>주파수 축</span><b>${st.scale === 'log' ? '로그' : '선형'}</b></button>
        </div>
        <section class="stats-grid">
          <div><span>평균 Leq</span><b>${fmtDb(a.leq)}</b><small>${unit}</small></div>
          <div><span>최대</span><b>${fmtDb(a.lmax)}</b><small>${unit}</small></div>
          <div><span>최소</span><b>${fmtDb(a.lmin)}</b><small>${unit}</small></div>
        </section>
        <section class="card">
          <h2>스펙트로그램 <small>누르면 그 시점부터 재생</small></h2>
          <div class="gram-box-rec"><div class="gram-plot" id="fa-gram"></div></div>
        </section>
        <section class="card">
          <h2>시간축 그래프 <small>누르면 그 시점으로 이동</small></h2>
          <div class="timeline-box"><div class="gram-plot" id="fa-time"></div></div>
        </section>
        <section class="card">
          <dl class="meta">
            <dt>피크</dt><dd>${a.peaks.length ? a.peaks.map((p) => `${fmtHz(p.hz)} <small>(${fmtDb(p.db)} ${unit})</small>`).join('<br>') : '뚜렷한 피크 없음'}</dd>
            <dt>가장 큰 순간</dt><dd>${fmtClock(loudestAt)} <button type="button" class="link" data-seek="${loudestAt}">여기 듣기</button></dd>
            <dt>레벨 기준</dt><dd>${calibrated ? `${esc(micName(st.lastMic))} 보정값(${prof.offset} dB${prof.cal ? ', 보정 파일' : ''})을 적용했습니다. 다른 기기·마이크로 녹음한 파일이면 참고값입니다.` : `파일의 디지털 크기(0 dBFS = 최대)에 ${st.weighting}특성만 적용했습니다.`}</dd>
            ${a.clipped ? '<dt>주의</dt><dd>소리가 파일의 최대 크기(0 dBFS)에 닿은 곳이 있어 실제보다 작게 나왔을 수 있습니다.</dd>' : ''}
          </dl>
        </section>
      </div>
      <div class="action-bar">
        <label class="btn" for="fa-input">다른 파일 열기</label>
        <button class="btn btn-primary" data-act="fa-save">기록에 저장</button>
      </div>`;

    const player = $('fa-audio');
    const chart = new SpectrumView($('fa-chart'), { cursor: true });
    chart.onCursor = bindCursorReadout($('fa-cursor'));
    $('fa-cursor').querySelector('.cr-close').onclick = () => chart.clearCursors();
    let atPosition = false; // false: whole-file average, true: spectrum at the playback position
    let raf = 0;
    const seek = (t) => {
      player.currentTime = t;
      atPosition = true;
      show();
    };
    const gram = new SpectrogramView($('fa-gram'), { onSeek: seek });
    gram.configure({ scale: st.scale, fmin: st.freqMin, fmax: st.freqMax, colorRange: st.gramDb });
    gram.setStatic(a.frames, a.freqs, a.duration, { labels: 'absolute', unit });
    const timeline = new TimelineView($('fa-time'), { onSeek: seek });
    timeline.set(a.history, a.historyStep, a.leq, unit);

    function show() {
      const st2 = getSettings();
      const t = player.currentTime;
      chart.update(
        { freqs: a.freqs, cur: atPosition ? frameAt(a, t) : a.avg, max: a.max, min: st2.minHold ? a.min : null, peaks: atPosition ? [] : a.peaks },
        { scale: st2.scale, fmin: st2.freqMin, fmax: st2.freqMax, style: st2.style, range: st2.specDb || range, unit },
      );
      $('fa-legend').innerHTML = legendHtml(st2.style, [
        ['cur', atPosition ? `재생 위치 ${fmtClock(t)}` : '전체 평균'],
        ['max', '전체 최대'],
        ...(st2.minHold ? [['min', '전체 최소']] : []),
      ]);
      $('fa-avg').hidden = !atPosition;
      gram.setPlayhead(atPosition ? t : null);
      timeline.setPlayhead(atPosition ? t : null);
    }
    const follow = () => {
      show();
      if (!player.paused) raf = requestAnimationFrame(follow);
    };
    player.addEventListener('play', () => {
      atPosition = true;
      cancelAnimationFrame(raf);
      follow();
    });
    player.addEventListener('seeked', show);
    player.addEventListener('pause', show);
    player.addEventListener('ended', () => {
      atPosition = false;
      show();
    });
    $('fa-avg').onclick = () => {
      player.pause();
      atPosition = false;
      show();
    };
    result.querySelectorAll('[data-seek]').forEach((b) => (b.onclick = () => {
      seek(Number(b.dataset.seek));
      player.play().catch(() => {});
    }));
    result.querySelectorAll('[data-opt]').forEach((b) =>
      b.addEventListener('click', async () => {
        const st2 = getSettings();
        if (b.dataset.opt === 'unit' || b.dataset.opt === 'weighting') {
          if (b.dataset.opt === 'unit') saveSettings({ fileUnit: st2.fileUnit === 'fs' ? 'cal' : 'fs' });
          else changeSettings({ weighting: WEIGHTINGS[(WEIGHTINGS.indexOf(st2.weighting) + 1) % WEIGHTINGS.length] });
          teardown?.();
          teardown = await showAnalysis(file, decoded);
          return;
        }
        if (b.dataset.opt === 'style') {
          const style = STYLE_ORDER[(STYLE_ORDER.indexOf(st2.style) + 1) % STYLE_ORDER.length];
          changeSettings({ style });
          b.querySelector('b').textContent = STYLE_NAME[style];
        } else {
          const scale = st2.scale === 'log' ? 'linear' : 'log';
          changeSettings({ scale });
          b.querySelector('b').textContent = scale === 'log' ? '로그' : '선형';
          gram.configure({ scale });
        }
        show();
      }),
    );
    result.querySelector('[data-act=fa-save]').onclick = () => {
      const avg = forRecord(a.avg, a.freqs);
      const rec = {
        id: store.newId(),
        ts: Date.now(),
        source: 'file',
        fileName: file.name,
        leq: round1(a.leq),
        lmax: round1(a.lmax),
        lmin: round1(a.lmin),
        laf: null,
        elapsed: round1(a.duration),
        clipped: a.clipped,
        peaks: a.peaks.map((p) => ({ hz: Math.round(p.hz), db: round1(p.db) })),
        spectrum: {
          freqs: avg.freqs,
          cur: avg.values,
          max: forRecord(a.max, a.freqs).values,
          ...(getSettings().minHold ? { min: forRecord(a.min, a.freqs).values } : {}),
          range,
        },
        fftSize: 4096,
        sampleRate: decoded.rate,
        offset: a.offset,
        weighting: a.weighting,
        unit,
        calibrated: calibrated && !!prof.calibratedAt,
        mic: calibrated ? st.lastMic : '',
        micCal: calibrated && prof.cal ? prof.calName : '',
        vehicle: '',
        memo: '',
        app: APP_VERSION,
      };
      const keep = file.size <= KEEP_AUDIO_BYTES;
      saveSheet(
        { title: '파일 분석 저장', rec, timeLabel: '길이', extra: keep ? '' : '<p class="fine">파일이 커서(30MB 초과) 분석 결과만 저장합니다.</p>' },
        () => {
          if (keep) {
            rec.audio = file;
            rec.audioSec = round1(a.duration);
          }
        },
      );
    };
    show();
    return () => {
      cancelAnimationFrame(raf);
      player.pause();
      chart.destroy();
      gram.destroy();
      timeline.destroy();
      URL.revokeObjectURL(url);
    };
  }

  $('fa-input').onchange = (e) => e.target.files[0] && open(e.target.files[0]);
  const drop = $('fa-drop');
  drop.addEventListener('dragover', (e) => {
    e.preventDefault();
    drop.classList.add('is-over');
  });
  drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('is-over');
    if (e.dataTransfer.files[0]) open(e.dataTransfer.files[0]);
  });
  if (openedFile) open(openedFile);
}

/* ---------- history ---------- */

async function renderHistory() {
  const all = (await store.allRecords()).filter((r) => r.spectrum);
  view.innerHTML = `
    <div class="page">
      <h1 class="page-title">측정 기록</h1>
      <input type="search" id="f-search" placeholder="차량번호·메모로 찾기" aria-label="차량번호·메모로 찾기">
      <div id="h-list"></div>
      <div class="action-bar"><button class="btn" data-act="csv">엑셀 파일로 받기</button></div>
    </div>`;
  let current = all;
  const update = () => {
    const q = view.querySelector('#f-search').value.replace(/\s/g, '');
    current = all.filter((r) => !q || `${r.vehicle}${r.memo}`.replace(/\s/g, '').includes(q));
    const groups = new Map();
    current.forEach((r) => {
      const day = fmtDay(r.ts);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(r);
    });
    view.querySelector('#h-list').innerHTML = current.length
      ? [...groups].map(([day, rows]) => `<h2 class="day-head">${day}</h2><ul class="record-list">${rows.map(recordRow).join('')}</ul>`).join('')
      : `<p class="empty-hint">${all.length ? '찾는 기록이 없습니다.' : '측정 화면에서 저장 버튼을 누르면 여기에 쌓입니다.'}</p>`;
  };
  update();
  view.querySelector('#f-search').addEventListener('input', update);
  view.querySelector('[data-act=csv]').onclick = async () => {
    if (!current.length) return toast('내보낼 기록이 없습니다');
    const result = await deliverFile(recordsCsv(current), `소음분석기록_${fileStamp(Date.now())}.csv`, { title: '소음 분석 기록' });
    if (result === 'downloaded') toast('엑셀에서 열 수 있는 파일(CSV)을 저장했습니다');
  };
}

function recordRow(r) {
  return `<li><a class="record-row" href="#/record/${encodeURIComponent(r.id)}">${recordRowInner(r, fmtTime(r.ts))}</a></li>`;
}

function recordRowInner(r, when = fmtWhen(r.ts)) {
  return `<span class="rr-time">${when}</span>
    <span class="rr-main"><strong>${esc(r.vehicle || (r.source === 'file' ? r.fileName : '차량 미입력'))}</strong><span>${esc(r.memo || `${r.source === 'file' ? '파일' : r.timedSec ? `${r.timedSec}초 측정` : '측정'} ${fmtClock(r.elapsed)}${r.peaks?.[0] ? ` · 피크 ${fmtHz(r.peaks[0].hz)}` : ''}`)}</span></span>
    <span class="rr-value"><small>평균</small>${fmtDb(r.leq)}<small>최대</small>${fmtDb(r.lmax)}</span>`;
}

/* ---------- saved analysis ---------- */

async function renderRecord(id) {
  const rec = await store.getRecord(id);
  if (!rec?.spectrum) {
    view.innerHTML = '<div class="page"><p class="alert">기록을 찾을 수 없습니다.</p><a class="btn btn-wide" href="#/history">기록 목록</a></div>';
    return;
  }
  const s = getSettings();
  const fromFile = rec.source === 'file';
  const unit = rec.unit || 'dB(A)';
  view.innerHTML = `
    <div class="page">
      <a class="back" href="#/history">← 기록 목록</a>
      <div class="rec-layout">
        <header class="rec-head">
          <h1>${esc(rec.vehicle || (fromFile ? rec.fileName : '차량 미입력'))}</h1>
          <p>${fmtDate(rec.ts)} · ${fromFile ? `파일 ${fmtClock(rec.elapsed)}` : `${rec.timedSec ? `${rec.timedSec}초 측정` : '측정'} ${fmtClock(rec.elapsed)}`}</p>
        </header>
        <section class="card chart-card">
          <div class="chart-box-rec"><div class="chart-plot" id="rec-chart"></div></div>
          ${cursorBox('rec-cursor')}
          <p class="legend">${legendHtml(s.style, [
            ['cur', fromFile ? '전체 평균' : '저장 순간'],
            ['max', fromFile ? '전체 최대' : '측정 중 최대'],
            ...(rec.spectrum.avg ? [['avg', '측정 평균']] : []),
            ...(rec.spectrum.min ? [['min', fromFile ? '전체 최소' : '측정 중 최소']] : []),
          ])}<span id="rec-ref-legend"></span> <span class="fine">· 그래프를 누르면 커서</span></p>
          <div class="ref-line" id="rec-ref" hidden><p id="rec-ref-text"></p><button type="button" class="ref-close" data-act="ref-clear" aria-label="비교 끄기">×</button></div>
          <div class="inline-actions compare-actions">
            <button type="button" class="btn" data-act="ref-pick">다른 기록과 비교</button>
            <button type="button" class="btn" data-act="ref-live">실시간과 비교</button>
          </div>
        </section>
        <section class="stats-grid">
          <div><span>평균</span><b>${fmtDb(rec.leq)}</b><small>${unit}</small></div>
          <div><span>최대</span><b>${fmtDb(rec.lmax)}</b><small>${unit}</small></div>
          <div><span>최소</span><b>${fmtDb(rec.lmin)}</b><small>${unit}</small></div>
        </section>
        ${rec.clipped ? `<p class="alert">${fromFile ? '소리가 파일의 최대 크기(0 dBFS)에 닿은 곳이 있어 실제보다 작게 나왔을 수 있습니다.' : '소리가 휴대폰 마이크의 측정 한계를 넘은 순간이 있었습니다. 실제 최대값은 더 클 수 있습니다.'}</p>` : ''}
        ${rec.audio
          ? `<section class="card audio-card">
              <h2>${fromFile ? '파일 소리' : '저장된 소리'} <small>${fmtClock(rec.audioSec)}</small></h2>
              <audio controls preload="metadata" id="rec-audio"></audio>
              <div class="gram-box-rec"><div class="gram-plot" id="rec-gram"></div><p class="gram-wait" id="rec-gram-wait">소리 분석 중…</p></div>
              <div class="timeline-box"><div class="gram-plot" id="rec-time"></div></div>
              <p class="fine">${fromFile ? '스펙트로그램은 아래가 처음, 위가 끝입니다.' : '스펙트로그램: 맨 위가 저장한 순간, 아래로 갈수록 그 전 소리입니다.'} 아래 시간축 그래프는 시간별 dB입니다. 그래프를 누르면 그 시점부터 들을 수 있습니다.</p>
              <button type="button" class="btn btn-wide" data-act="share-audio">소리 파일 보내기</button>
            </section>`
          : ''}
        <section class="card">
          <dl class="meta">
            <dt>피크</dt><dd>${rec.peaks?.length ? rec.peaks.map((p) => `${fmtHz(p.hz)} <small>(${fmtDb(p.db)} ${unit})</small>`).join('<br>') : '뚜렷한 피크 없음'}</dd>
            <dt>메모</dt><dd class="memo">${esc(rec.memo) || '-'}</dd>
            ${fromFile ? `<dt>파일</dt><dd>${esc(rec.fileName)}</dd>` : `<dt>저장 순간</dt><dd>${fmtDb(rec.laf)} ${unit}</dd>`}
            ${'speedAvg' in rec || 'speed' in rec ? `<dt>속도</dt><dd>${speedText(rec)}</dd>` : ''}
            <dt>분석 설정</dt><dd>${rec.weighting || 'A'}특성 · ${TW_NAME[rec.timeWeighting || 'F']} · FFT ${rec.fftSize} · ${unit.startsWith('dBFS') ? '파일 디지털 레벨(dBFS) 기준' : `${esc(micName(rec.mic))} ${rec.calibrated ? '보정됨' : '보정 안 됨 (참고값)'}${rec.micCal ? ' · 보정 파일' : ''}`}</dd>
          </dl>
        </section>
      </div>
      <div class="action-bar">
        <button class="btn" data-act="note">메모 수정</button>
        <button class="btn btn-primary" data-act="share">결과 보내기</button>
      </div>
      <button class="btn btn-danger-quiet btn-wide" data-act="delete">이 기록 삭제</button>
    </div>`;

  const chart = new SpectrumView(view.querySelector('#rec-chart'), { cursor: true });
  chart.onCursor = bindCursorReadout(view.querySelector('#rec-cursor'));
  view.querySelector('#rec-cursor .cr-close').onclick = () => chart.clearCursors();
  const sp = rec.spectrum;
  const recData = {
    freqs: Float32Array.from(sp.freqs),
    cur: Float32Array.from(sp.cur),
    max: Float32Array.from(sp.max),
    avg: sp.avg ? Float32Array.from(sp.avg) : null,
    min: sp.min ? Float32Array.from(sp.min) : null,
    peaks: rec.peaks,
  };
  const recOpts = { scale: 'log', style: s.style, range: sp.range, unit };
  chart.update(recData, recOpts);

  // Comparison with another record: its average spectrum dashed over this one, and the two averages.
  const compareWith = (other) => {
    const r = refCurve(other);
    chart.update({ ...recData, ref: r }, recOpts);
    view.querySelector('#rec-ref').hidden = !r;
    view.querySelector('#rec-ref-legend').innerHTML = r ? legendHtml(s.style, [['ref', `비교: ${esc(r.name)}`]]) : '';
    if (!r) return;
    const same = r.weighting === (rec.weighting || 'A');
    const d = rec.leq - r.leq;
    view.querySelector('#rec-ref-text').innerHTML = `비교 기록 <b>${esc(r.name)}</b>${r.name !== r.when ? ` <small>${r.when}</small>` : ''}<br>평균 ${fmtDb(r.leq)} → 이 기록 ${fmtDb(rec.leq)} ${unit}${same && Number.isFinite(d) ? ` <b class="${d > 0 ? 'up' : 'down'}">${signed(d)} dB</b>` : ` <span class="warn">(${r.weighting}특성 기록이라 직접 비교하기 어렵습니다)</span>`}`;
  };
  if (rec.refId) store.getRecord(rec.refId).then((other) => other && compareWith(other)).catch(() => {});
  view.querySelector('[data-act=ref-clear]').onclick = () => compareWith(null);
  view.querySelector('[data-act=ref-live]').onclick = () => {
    saveSettings({ refId: rec.id });
    location.hash = '#/';
  };
  view.querySelector('[data-act=ref-pick]').onclick = async () => {
    const others = (await store.allRecords()).filter((r) => r.id !== rec.id && r.spectrum).slice(0, 30);
    if (!others.length) return toast('비교할 다른 기록이 없습니다');
    const { dlg, close } = openSheet(`
      <div class="sheet-form">
        <h2>비교할 기록</h2>
        <ul class="record-list pick-list">${others.map((r) => `<li><button type="button" class="record-row" data-id="${esc(r.id)}">${recordRowInner(r)}</button></li>`).join('')}</ul>
        <button type="button" class="btn btn-wide" data-close>닫기</button>
      </div>`);
    dlg.querySelectorAll('[data-id]').forEach((b) => {
      b.onclick = () => {
        compareWith(others.find((r) => r.id === b.dataset.id));
        close();
      };
    });
  };
  let gram = null;
  let timeline = null;
  let audioUrl = null;
  let raf = 0;
  cleanup = () => {
    chart.destroy();
    gram?.destroy();
    timeline?.destroy();
    cancelAnimationFrame(raf);
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  };

  if (rec.audio) {
    const player = view.querySelector('#rec-audio');
    audioUrl = URL.createObjectURL(rec.audio);
    player.src = audioUrl;
    const seek = (t) => {
      player.currentTime = t;
      follow();
    };
    gram = new SpectrogramView(view.querySelector('#rec-gram'), { onSeek: seek });
    timeline = new TimelineView(view.querySelector('#rec-time'), { onSeek: seek });
    // the time-axis views are worked out from the stored sound itself
    setTimeout(async () => {
      try {
        const { samples, rate } = await decodeAudioFile(rec.audio);
        const a = analyzeSound(samples, rate, rec.offset ?? s.offset, {
          weighting: rec.weighting || 'A',
          timeWeighting: rec.timeWeighting || 'F',
          correction: rec.micCal ? calCorrection(micProfile(s, rec.mic).cal) : null,
        });
        gram?.setStatic(a.frames, a.freqs, a.duration, { labels: fromFile ? 'absolute' : 'relative', unit });
        timeline?.set(a.history, a.historyStep, a.leq, unit);
        view.querySelector('#rec-gram-wait')?.remove();
      } catch {
        const wait = view.querySelector('#rec-gram-wait');
        if (wait) wait.textContent = '이 소리는 분석할 수 없습니다';
      }
    }, 30);
    function follow() {
      gram?.setPlayhead(player.currentTime);
      timeline?.setPlayhead(player.currentTime);
      cancelAnimationFrame(raf);
      if (!player.paused) raf = requestAnimationFrame(follow);
    }
    player.addEventListener('play', follow);
    player.addEventListener('seeked', follow);
    player.addEventListener('ended', () => {
      gram?.setPlayhead(null);
      timeline?.setPlayhead(null);
    });
    const audioName = fromFile && rec.fileName ? rec.fileName : `소음분석_${(rec.vehicle || '기록').replace(/\s/g, '')}_${fileStamp(rec.ts)}.wav`;
    view.querySelector('[data-act=share-audio]').onclick = async () => {
      const result = await deliverFile(rec.audio, audioName, { title: '저장된 소리', text: summaryText(rec, s) });
      if (result === 'downloaded') toast('소리 파일을 저장했습니다');
    };
  }

  // Render the card now so the share sheet opens straight from the tap (iOS needs that).
  const card = renderCard(rec, s);
  view.querySelector('[data-act=share]').onclick = async () => {
    const result = await deliverFile(await card, `소음분석_${(rec.vehicle || '기록').replace(/\s/g, '')}_${fileStamp(rec.ts)}.png`, {
      title: '실시간 소음 분석',
      text: summaryText(rec, s),
    });
    if (result === 'downloaded') {
      await navigator.clipboard?.writeText(summaryText(rec, s)).catch(() => {});
      toast('이미지를 저장했습니다. 내용은 복사되어 붙여넣기 할 수 있습니다.');
    }
  };
  view.querySelector('[data-act=note]').onclick = () => {
    const { dlg, close } = openSheet(`
      <form class="sheet-form">
        <h2>메모 수정</h2>
        <label class="field"><span>차량번호</span><input id="f-vehicle" value="${esc(rec.vehicle)}" autocomplete="off"></label>
        <label class="field"><span>메모</span><textarea id="f-memo" rows="4">${esc(rec.memo)}</textarea></label>
        <div class="sheet-actions">
          <button type="button" class="btn btn-quiet" data-close>취소</button>
          <button class="btn btn-primary" type="submit">저장</button>
        </div>
      </form>`);
    dlg.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      await store.putRecord({ ...rec, vehicle: dlg.querySelector('#f-vehicle').value.trim(), memo: dlg.querySelector('#f-memo').value.trim() });
      close();
      route();
    };
  };
  const del = view.querySelector('[data-act=delete]');
  del.onclick = async () => {
    if (del.dataset.armed !== 'yes') {
      del.dataset.armed = 'yes';
      del.textContent = '한 번 더 누르면 삭제됩니다';
      return;
    }
    await store.deleteRecord(rec.id);
    toast('기록을 삭제했습니다');
    location.replace('#/history');
  };
}

/* ---------- admin settings ---------- */

async function renderSettings() {
  if (!adminUnlocked) {
    view.innerHTML = `
      <div class="page">
        <form class="pin-gate" id="pin-form">
          <h1 class="page-title">설정</h1>
          <p>마이크 보정과 회사 정보는 관리자만 바꿀 수 있습니다.</p>
          <label class="field"><span>관리자 비밀번호</span>
            <input id="f-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
          <p class="alert" id="pin-error" hidden>비밀번호가 맞지 않습니다.</p>
          <button class="btn btn-primary btn-wide" type="submit">확인</button>
        </form>
      </div>`;
    view.querySelector('#pin-form').onsubmit = (e) => {
      e.preventDefault();
      if (view.querySelector('#f-pin').value === getSettings().pin) {
        adminUnlocked = true;
        route();
      } else {
        view.querySelector('#pin-error').hidden = false;
      }
    };
    return;
  }

  const s = getSettings();
  const count = (await store.allRecords()).length;
  let calTarget = s.micLabel || s.lastMic || s.baseMic || ''; // calibrate this microphone (by name)
  let calDevice = s.micId; // ...opened by this device id ('' = the phone's default)
  let calProf = micProfile(s, calTarget);
  view.innerHTML = `
    <div class="page">
      <h1 class="page-title">설정</h1>
      <form id="settings-form" class="settings" novalidate>
        <section class="card">
          <h2>회사 정보</h2>
          <label class="field"><span>회사 이름 <small>(공유 이미지에 표시)</small></span><input id="f-company" value="${esc(s.company)}"></label>
        </section>

        <section class="card">
          <h2>저장할 때 남길 소리</h2>
          <label class="field"><span>저장 버튼을 누르기 직전 몇 초를 함께 남길까요?</span>
            <select id="f-audio-sec">
              ${[0, 5, 10, 20, 30].map((n) => `<option value="${n}"${s.audioSec === n ? ' selected' : ''}>${n ? `${n}초` : '남기지 않음'}</option>`).join('')}
            </select></label>
          <p class="fine">10초에 약 1MB입니다. 바꾼 값은 분석 화면을 다시 열 때부터 적용됩니다.</p>
        </section>

        <section class="card">
          <h2>경고 기준</h2>
          <label class="field field-num"><span>이 값부터 색 막대가 빨강 (dB)</span>
            <input id="f-alert" type="number" inputmode="decimal" min="30" max="130" step="1" value="${s.alertLevel}"></label>
        </section>

        <section class="card">
          <h2>마이크 보정</h2>
          <label class="field"><span>보정할 마이크</span>
            <select id="f-cal-mic"><option value="">휴대폰 기본 마이크</option></select></label>
          <p><strong id="cal-mic">${esc(micName(calTarget))}</strong> · 보정값 <strong id="cal-offset">${calProf.offset} dB</strong> · <span id="cal-date">${calDate(calProf)}</span></p>
          <p class="fine">휴대폰·마이크마다 감도가 달라 하나씩 보정해야 값이 맞습니다. 평소에는 휴대폰 마이크로 재고, 외부 측정 마이크(iMM-6C 등)는 꽂은 뒤 위에서 골라 따로 보정합니다.</p>
          <ol class="guide">
            <li>정밀 소음계(기준기)와 휴대폰을 나란히 두세요.</li>
            <li>공회전 소리처럼 일정한 소리가 나게 하세요.</li>
            <li>아래 버튼을 누르고, 같은 5초 동안 소음계의 평균값(Leq, A특성)을 읽으세요.</li>
            <li>소음계 값을 입력하고 적용을 누르세요.</li>
          </ol>
          <button type="button" class="btn btn-wide" data-act="cal-measure">보정 측정 (5초)</button>
          <div class="cal-result" id="cal-result" hidden>
            <p>휴대폰 측정값 <strong id="cal-phone">-</strong> dB(A)</p>
            <div class="inline-form">
              <label class="field field-num"><span>소음계 값</span><input id="f-cal-ref" type="number" inputmode="decimal" step="0.1"></label>
              <button type="button" class="btn btn-primary" data-act="cal-apply">적용</button>
            </div>
          </div>
          <details>
            <summary>보정값 직접 입력</summary>
            <label class="field field-num"><span>보정값 (dB)</span><input id="f-offset" type="number" inputmode="decimal" step="0.1" value="${calProf.offset}"></label>
          </details>
          <div class="cal-file">
            <h3>마이크 보정 파일 <small>(외부 측정 마이크, 선택)</small></h3>
            <p class="fine">UMIK·iMM-6C 등 측정 마이크와 함께 받은 주파수 특성 파일(.txt)을 넣으면 스펙트럼의 저음·고음 오차를 바로잡습니다. 큰 숫자(전체 dB)는 위 보정값으로 맞춥니다.</p>
            <p id="cal-file-state">${esc(calFileState(calProf))}</p>
            <div class="inline-actions">
              <label class="btn" for="f-cal-file">보정 파일 열기</label>
              <input type="file" id="f-cal-file" accept=".txt,.cal,.frd,.csv,text/plain" hidden>
              <button type="button" class="btn btn-quiet" data-act="cal-file-clear"${calProf.cal ? '' : ' hidden'}>지우기</button>
            </div>
          </div>
        </section>

        <section class="card">
          <h2>관리자 비밀번호</h2>
          <label class="field"><span>새 비밀번호 <small>(바꿀 때만 입력, 숫자 4자리 이상)</small></span>
            <input id="f-newpin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
        </section>

        <section class="card">
          <h2>데이터</h2>
          <p>이 휴대폰에 저장된 기록 <strong>${count}건</strong>. 기록은 이 휴대폰 안에만 있으니 필요하면 엑셀 파일로 보내 두세요.</p>
          <button type="button" class="btn btn-danger-quiet btn-wide" data-act="clear">모든 기록 삭제</button>
        </section>

        <p class="alert" id="settings-error" hidden></p>
        <div class="action-bar"><button class="btn btn-primary btn-wide" type="submit">설정 저장</button></div>
      </form>
      <p class="fine about">실시간 소음 분석 v${APP_VERSION}. 스마트폰 측정값은 참고용이며 법정 측정을 대신하지 않습니다.</p>
    </div>`;

  const $ = (id) => view.querySelector(`#${id}`);
  let calMeter = null;
  let calPhone = null;
  cleanup = () => calMeter?.stop();

  function showCal() {
    $('cal-mic').textContent = micName(calTarget);
    $('cal-offset').textContent = `${calProf.offset} dB`;
    $('cal-date').textContent = calDate(calProf);
    $('f-offset').value = calProf.offset;
    $('cal-file-state').textContent = calFileState(calProf);
    view.querySelector('[data-act=cal-file-clear]').hidden = !calProf.cal;
  }
  const calMic = $('f-cal-mic');
  audioInputs().then((list) => {
    for (const d of list) {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || '이름 없는 마이크';
      calMic.append(o);
    }
    if (!list.some((d) => d.deviceId === calDevice)) calDevice = '';
    calMic.value = calDevice;
  });
  calMic.onchange = () => {
    calDevice = calMic.value;
    const st = getSettings();
    calTarget = calDevice ? calMic.selectedOptions[0].textContent : st.baseMic || '';
    calProf = micProfile(st, calTarget);
    calPhone = null;
    $('cal-result').hidden = true;
    showCal();
  };

  view.querySelector('[data-act=cal-measure]').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    calMic.disabled = true;
    calMeter = new Meter(calProf.offset);
    try {
      await calMeter.start(4096, 0, calDevice);
      // the microphone that actually opened is the one being calibrated
      calTarget = calMeter.inputLabel;
      calProf = noteMic(calMeter);
      calMeter.setCalibration(calProf.offset, null);
      showCal();
      if (calMeter.fellBack) {
        calMic.value = calDevice = '';
        toast('고른 마이크가 없어 휴대폰 기본 마이크를 보정합니다');
      }
      if (!calMeter.running) await calMeter.wake();
      const until = Date.now() + 12000;
      while (calMeter.elapsed < 5) {
        if (Date.now() > until) throw new Error('마이크 입력이 없습니다. 다시 시도해 주세요.');
        btn.textContent = `측정 중… ${Math.ceil(5 - calMeter.elapsed)}초`;
        await sleep(100);
      }
      calPhone = calMeter.leq;
      $('cal-phone').textContent = fmtDb(calPhone);
      $('cal-result').hidden = false;
      $('f-cal-ref').focus();
    } catch (err) {
      if (err?.code !== 'cancelled') toast(err.message);
    } finally {
      calMeter?.stop();
      calMeter = null;
      btn.disabled = false;
      calMic.disabled = false;
      btn.textContent = '보정 측정 다시 하기 (5초)';
    }
  };
  view.querySelector('[data-act=cal-apply]').onclick = () => {
    const ref = parseFloat($('f-cal-ref').value);
    if (!Number.isFinite(ref) || ref < 20 || ref > 140 || !Number.isFinite(calPhone)) return toast('소음계 값을 확인해 주세요');
    const offset = round1(calProf.offset + (ref - calPhone));
    saveSettings(saveMicProfile(getSettings(), calTarget, { offset, calibratedAt: Date.now() }));
    calProf = micProfile(getSettings(), calTarget);
    showCal();
    $('cal-result').hidden = true;
    toast(`보정했습니다 (보정값 ${offset} dB)`);
  };
  $('f-cal-file').onchange = async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const { points, serial, sens1k } = parseCalFile(await file.text());
      saveSettings(saveMicProfile(getSettings(), calTarget, { cal: points, calName: file.name, calSerial: serial || '', calSens: sens1k }));
      calProf = micProfile(getSettings(), calTarget);
      showCal();
      toast(`${micName(calTarget)}에 보정 파일을 넣었습니다`);
    } catch (err) {
      toast(err.message || '보정 파일을 읽지 못했습니다');
    }
  };
  view.querySelector('[data-act=cal-file-clear]').onclick = (e) => {
    saveSettings(saveMicProfile(getSettings(), calTarget, { cal: null, calName: '', calSerial: '', calSens: null }));
    calProf = micProfile(getSettings(), calTarget);
    showCal();
    e.currentTarget.blur();
  };
  const clear = view.querySelector('[data-act=clear]');
  clear.onclick = async () => {
    if (clear.dataset.armed !== 'yes') {
      clear.dataset.armed = 'yes';
      clear.textContent = `한 번 더 누르면 ${count}건이 모두 삭제됩니다`;
      return;
    }
    await store.clearRecords();
    toast('모든 기록을 삭제했습니다');
    route();
  };

  view.querySelector('#settings-form').onsubmit = (e) => {
    e.preventDefault();
    const err = $('settings-error');
    const showError = (msg) => {
      err.textContent = msg;
      err.hidden = false;
      err.scrollIntoView({ block: 'center' });
    };
    const alertLevel = parseFloat($('f-alert').value);
    if (!(alertLevel >= 30 && alertLevel <= 130)) return showError('경고 기준은 30–130 dB 사이로 입력해 주세요.');
    const offset = parseFloat($('f-offset').value);
    if (!(offset > 0 && offset < 200)) return showError('보정값을 확인해 주세요.');
    const newPin = $('f-newpin').value.trim();
    if (newPin && !/^\d{4,12}$/.test(newPin)) return showError('비밀번호는 숫자 4–12자리로 입력해 주세요.');
    const before = getSettings();
    if (round1(offset) !== calProf.offset) saveSettings(saveMicProfile(before, calTarget, { offset: round1(offset), calibratedAt: Date.now() }));
    saveSettings({
      company: $('f-company').value.trim() || before.company,
      audioSec: Number($('f-audio-sec').value),
      alertLevel: Math.round(alertLevel),
      pin: newPin || before.pin,
    });
    calProf = micProfile(getSettings(), calTarget);
    err.hidden = true;
    toast('설정을 저장했습니다');
  };
}

/* ---------- boot ---------- */

applyTheme(getSettings().theme);
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
