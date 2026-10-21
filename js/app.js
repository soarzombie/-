// Screens and navigation. Routes live in the URL hash so the phone's back button works:
// #/ (real-time analyzer), #/file (analyse an attached file), #/history, #/record/<id>, #/settings

import { APP_VERSION, getSettings, saveSettings, rememberVehicle } from './settings.js';
import { Meter, FFT_SIZES, MAX_RECORD_SEC } from './meter.js';
import { findPeaks, logGrid, rangeIndex, reduceRanges, unitOf, WEIGHTINGS, BANDS, bandIndex, bandLevels } from './dsp.js';
import * as store from './store.js';
import { esc, fmtDb, fmtHz, fmtClock, fmtDate, fmtDay, fmtShortDate, fmtTime, fileStamp } from './format.js';
import { SpectrumView } from './spectrum.js';
import { SpectrogramView } from './spectrogram.js';
import { encodeWav, decodeAudioFile } from './audio.js';
import { analyzeSound, frameAt } from './analysis.js';
import { TimelineView } from './timeline.js';
import { Gauge, LevelBar } from './gauge.js';
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
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
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
function cursorText(values) {
  const parts = values.map((v, i) => `<span><b>${'AB'[i]}</b> ${fmtHz(v.hz)} <em>${fmtDb(v.cur)}</em></span>`);
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
  { id: 'spectrum', name: '스펙트럼', label: '스펙트럼', icon: svg('<path d="M2.5 12h3.5l2-5 3.5 11 3-14 2 8h5"/>') },
  { id: 'gram', name: '시간축', label: '시간축 (스펙트로그램)', icon: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M7 9h2.5M12 9h5M7 12h6M15.5 12h1.5M7 15h1.5M11 15h6"/>') },
  { id: 'both', name: '함께 보기', label: '스펙트럼과 시간축 함께', icon: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M3.5 12h17M6.5 10l2.5-2.5 2 1.5 2.5-3 2 2 2-1M7 15.8h3M12.5 15.8h4.5"/>') },
  { id: 'octave', name: '1/3 옥타브', label: '1/3 옥타브 막대', icon: svg('<path stroke-width="2.6" d="M5.5 19v-5M9.5 19v-9M13.5 19v-13M17.5 19v-7"/>') },
  { id: 'gauge', name: '게이지', label: '게이지', icon: svg('<path d="M3.5 16.5a8.5 8.5 0 0 1 17 0"/><path d="M12 16.5l4.2-5"/><circle class="fill" cx="12" cy="16.5" r="1.6"/>') },
];
const OCTAVE_FFT = 16384; // 2.9 Hz bins, so even the 25 Hz band has some
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
        <dt>큰 숫자</dt><dd>지금 소음 크기입니다 (0.125초 Fast). 색 막대는 초록 → 노랑 → 빨강, 빨강은 경고 기준 ${s.alertLevel} dB 이상입니다. 밝은 칸 하나는 최대값입니다.</dd>
        <dt>최소·평균·최대</dt><dd>측정을 시작하거나 ↻ 초기화를 누른 뒤의 값입니다. 평균은 에너지 평균(Leq)입니다.</dd>
        <dt>A · C · Z</dt><dd>주파수 가중치. <b>A</b> 보통 소음(사람 귀에 가깝게) · <b>C</b> 엔진·부밍음처럼 저음이 큰 소리 · <b>Z</b> 거르지 않은 소리. 그래프 오른쪽 위 설정 버튼에서 바꿉니다.</dd>
        <dt>그래프</dt><dd>가로는 주파수(20 Hz – 20 kHz), 세로는 소리 크기입니다. 누르면 십자선 커서가 그 주파수의 값을 보여 주고, 한 번 더 누르면 커서 B로 두 곳을 비교합니다. 끌어서 옮기고 × 로 지웁니다.</dd>
        <dt>보기</dt><dd>${MODES.map((m) => m.label).join(' · ')}. 맨 위 버튼으로 바꿉니다.</dd>
        <dt>● 녹음</dt><dd>누른 때부터 정지할 때까지 녹음하고(최대 ${MAX_RECORD_SEC / 60}분, 위 시계가 녹음 길이), 정지하면 파일 분석 화면에서 녹음 전체를 분석합니다.</dd>
        <dt>⬇ 저장</dt><dd>지금 그래프와 값, 방금 들린 소리를 차량번호·메모와 함께 기록에 남깁니다.</dd>
      </dl>
      <p class="fine">스마트폰 측정값은 참고값이며 정밀 소음계를 대신하지 않습니다.</p>
      <button type="button" class="btn btn-wide" data-close>닫기</button>
    </div>`);
}

async function renderAnalyzer() {
  const s = getSettings();
  view.innerHTML = `
    <section class="analyzer" data-state="off" data-rec="off">
      <div class="an-modes" role="group" aria-label="보기">
        ${MODES.map((m) => `<button type="button" class="mode" data-mode="${m.id}" aria-label="${m.label}" aria-pressed="${s.view === m.id}">${m.icon}</button>`).join('')}
      </div>
      <div class="an-sub">
        <span class="an-weight" id="a-weight">${s.weighting}특성</span>
        <p class="an-mode-name" id="a-mode-name">${MODES.find((m) => m.id === s.view)?.name || ''}</p>
        <p class="an-status"><i class="rec-dot"></i><span id="a-state">대기</span><b id="a-time">00:00</b></p>
      </div>
      <div class="an-level">
        <div class="led" id="a-led" aria-hidden="true"></div>
        <button type="button" class="round-btn lv-help" data-act="help" aria-label="도움말">${ICON.info}</button>
        <p class="lv-now"><b id="a-now">--.-</b><span id="a-unit">${unitOf(s.weighting)}</span></p>
        <button type="button" class="round-btn lv-reset" data-act="reset" aria-label="초기화">${ICON.reset}</button>
        <p class="lv-stats"><span>최소 <b id="a-min">–</b></span><span>평균 <b id="a-leq">–</b></span><span>최대 <b id="a-max">–</b></span></p>
      </div>
      <div class="an-chart" data-view="${s.view}">
        <div class="chart-plot" id="a-chart"></div>
        <div class="gram-plot" id="a-gram"></div>
        <div class="octave-plot" id="a-octave"></div>
        <div class="gauge-plot"><div class="gauge-host" id="a-gauge"></div>
          <p class="gauge-legend"><span class="gl-min">▲</span> 최소 <span class="gl-max">▲</span> 최대 · 주황색은 경고 기준 ${s.alertLevel} dB 이상</p></div>
        <div class="chart-tools">
          <p class="an-peak" id="a-peak">피크 –</p>
          <button type="button" class="tool-btn" data-act="chart-settings" aria-label="그래프 설정">${ICON.sliders}</button>
        </div>
        ${cursorBox('a-cursor')}
        <div class="chart-overlay" id="a-overlay">
          <button type="button" class="mic-button" data-act="mic">${ICON.mic}<strong>눌러서 측정 시작</strong></button>
          <p class="overlay-note" id="a-note">처음 한 번은 마이크 사용을 "허용"해 주세요.</p>
        </div>
      </div>
      <div class="an-controls">
        <button type="button" class="ctl ctl-rec" data-act="rec" aria-label="녹음 시작"><i class="rec-mark"></i><span class="ctl-cap" id="a-rec-cap">녹음</span></button>
        <button type="button" class="ctl ctl-main" data-act="toggle" aria-label="측정 시작">${ICON.play}<span class="ctl-cap" id="a-toggle-cap">시작</span></button>
        <button type="button" class="ctl ctl-save" data-act="save" aria-label="저장">${ICON.save}<span class="ctl-cap">저장</span></button>
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
  const chartBox = view.querySelector('.an-chart');
  const chart = new SpectrumView($('a-chart'), { cursor: true });
  chart.onCursor = bindCursorReadout($('a-cursor'));
  $('a-cursor').querySelector('.cr-close').onclick = () => chart.clearCursors();
  const gram = new SpectrogramView($('a-gram'));
  gram.configure({ scale: s.scale, xLabels: s.view === 'gram' });
  gram.unit = unitOf(s.weighting);
  const octave = new OctaveView($('a-octave'));
  const gauge = new Gauge($('a-gauge'), s.alertLevel);
  const led = new LevelBar($('a-led'), s.alertLevel);
  let meter = null;
  let raf = 0;
  let wake = null;
  let hold = null; // per-bin maximum since reset
  let avgPow = null; // slowly averaged spectrum, for steady peak labels
  let peaks = [];
  let bandIdx = null; // analyser bin -> 1/3-octave band
  let bandHold = null;
  let lastPeakAt = 0;
  let lastRowAt = 0;
  let range = [-20, 100];
  let octRange = [0, 100];

  const mode = () => getSettings().view;
  const unit = () => unitOf(getSettings().weighting);

  const draw = (cur) => {
    const st = getSettings();
    if (st.view === 'octave') {
      bandHold ||= new Float32Array(BANDS.length).fill(-Infinity);
      const bands = bandLevels(cur, bandIdx);
      for (let b = 0; b < bands.length; b++) if (bands[b] > bandHold[b]) bandHold[b] = bands[b];
      const top = Math.max(meter.laf, ...bandHold);
      if (top > octRange[1] - 4 && octRange[1] < 140) octRange = [octRange[0] + 20, octRange[1] + 20];
      octave.update({ bands, max: st.hold ? bandHold : null, total: meter.laf }, { range: octRange, unit: unit(), style: st.style });
    } else {
      chart.update({ freqs: meter.freqs, cur, max: st.hold ? hold : null, peaks }, { scale: st.scale, style: st.style, range, unit: unit() });
    }
  };

  function showRunning(paused) {
    root.dataset.state = paused ? 'pause' : 'run';
    toggleBtn.firstElementChild.outerHTML = paused ? ICON.play : ICON.pause;
    toggleBtn.setAttribute('aria-label', paused ? '다시 측정' : '일시정지');
    $('a-toggle-cap').textContent = paused ? '계속' : '일시정지';
    $('a-state').textContent = paused ? '일시정지' : meter?.recording ? '녹음 중' : '측정 중';
  }

  function resetDisplays() {
    hold = null;
    avgPow = null;
    peaks = [];
    bandHold = null;
    range = [-20, 100];
    octRange = [0, 100];
    $('a-peak').textContent = '피크 –';
  }

  function clearReadings() {
    resetDisplays();
    ['a-leq', 'a-max', 'a-min'].forEach((id) => ($(id).textContent = '–'));
    $('a-time').textContent = '00:00';
    gauge.marks(NaN, NaN);
    led.set(NaN, NaN);
    gram.clear();
  }

  // The analyser runs at the chosen FFT size, or at 16384 for the octave bars.
  function applyFft() {
    if (!meter) return;
    const want = mode() === 'octave' ? OCTAVE_FFT : getSettings().fftSize;
    if (meter.analyser.fftSize !== want) {
      meter.setFftSize(want);
      resetDisplays();
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
    if (!hold || hold.length !== cur.length) {
      hold = new Float32Array(cur.length).fill(-Infinity);
      avgPow = new Float64Array(cur.length);
    }
    let top = -Infinity;
    for (let k = 1; k < cur.length; k++) {
      if (cur[k] > hold[k]) hold[k] = cur[k];
      if (hold[k] > top) top = hold[k];
      avgPow[k] += (10 ** (cur[k] / 10) - avgPow[k]) * 0.1;
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
    if (mode() !== 'gauge') draw(cur);
  }

  function onLevel(db) {
    $('a-now').textContent = fmtDb(db);
    root.dataset.alert = String(db >= getSettings().alertLevel);
    $('a-leq').textContent = fmtDb(meter.leq);
    $('a-max').textContent = fmtDb(meter.lmax);
    $('a-min').textContent = fmtDb(meter.lmin);
    // while recording the clock shows the length of the recording
    $('a-time').textContent = fmtClock(meter.recording ? meter.recordedSec : meter.elapsed);
    led.set(db, meter.lmax);
    gauge.set(db);
    gauge.marks(meter.lmin, meter.lmax);
  }

  async function startMic() {
    if (meter) {
      if (!meter.running) await meter.wake();
      return true;
    }
    const st = getSettings();
    meter = new Meter(st.offset, st.weighting);
    try {
      await meter.start(st.view === 'octave' ? OCTAVE_FFT : st.fftSize, st.audioSec);
    } catch (err) {
      meter = null;
      if (err.code !== 'cancelled') {
        $('a-overlay').hidden = false;
        $('a-note').textContent = err.message;
        $('a-note').classList.add('is-error');
      }
      return false;
    }
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

  // Recorded sound -> a WAV file for the file analysis screen; `notice` instead of going there.
  function openRecording(samples, rate, notice) {
    showRecording(false);
    if (samples.length < rate * 0.5) return toast('녹음이 너무 짧습니다');
    const ts = Date.now();
    openedFile = new File([encodeWav(samples, rate)], `녹음_${fileStamp(ts)}.wav`, { type: 'audio/wav', lastModified: ts });
    if (notice) toast(notice);
    else location.hash = '#/file';
  }

  function showRecording(on) {
    root.dataset.rec = on ? 'on' : 'off';
    recBtn.setAttribute('aria-label', on ? '녹음 정지' : '녹음 시작');
    $('a-rec-cap').textContent = on ? '정지' : '녹음';
    if (meter) showRunning(meter.paused);
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
    openRecording(samples, rate);
  }

  function stopMic() {
    cancelAnimationFrame(raf);
    if (meter?.recording) {
      // leaving mid-recording keeps what was recorded, ready in the file tab
      const rate = meter.sampleRate;
      openRecording(meter.takeRecording(), rate, '녹음을 멈췄습니다. 녹음한 소리는 파일 탭에 있습니다.');
    }
    meter?.stop();
    meter = null;
    wake?.release?.().catch(() => {});
    wake = null;
    root.dataset.state = 'off';
    toggleBtn.firstElementChild.outerHTML = ICON.play;
    toggleBtn.setAttribute('aria-label', '측정 시작');
    $('a-toggle-cap').textContent = '시작';
    $('a-state').textContent = '대기';
    $('a-now').textContent = '--.-';
    $('a-overlay').hidden = false;
    gauge.set(NaN);
    led.set(NaN, NaN);
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
        max: keep(reduceRanges(hold, meter.freqs, idx, grid.centres)),
        range: [...range],
      },
      fftSize: meter.analyser.fftSize,
      sampleRate: meter.sampleRate,
      offset: meter.offset,
      weighting: meter.weighting,
      unit: meter.unit,
      calibrated: !!st.calibratedAt,
      vehicle: '',
      memo: '',
      app: APP_VERSION,
    };
  }

  function openSave(rec, audio) {
    const extra = getSettings().audioSec > 0 ? '<label class="check"><input type="checkbox" id="f-audio" checked> <span id="f-audio-label">방금 들린 소리도 함께 저장</span></label>' : '';
    const dlg = saveSheet({ title: '지금 측정 저장', rec, timeLabel: '측정 시간', extra }, async (form) => {
      const samples = form.querySelector('#f-audio')?.checked ? await audio : null;
      if (samples?.length) {
        rec.audio = encodeWav(samples, rec.sampleRate);
        rec.audioSec = round1(samples.length / rec.sampleRate);
      }
    });
    audio.then((samples) => {
      const label = dlg.querySelector('#f-audio-label');
      if (label) label.textContent = samples.length ? `방금 들린 소리 ${(samples.length / rec.sampleRate).toFixed(0)}초도 함께 저장` : '저장할 소리가 없습니다';
    });
  }

  function setMode(id) {
    saveSettings({ view: id });
    chartBox.dataset.view = id;
    view.querySelectorAll('.mode').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === id)));
    $('a-mode-name').textContent = MODES.find((m) => m.id === id).name;
    gram.configure({ xLabels: id === 'gram' });
    applyFft();
    if (meter?.paused && hold) draw(meter.levels);
  }

  function chartSettings() {
    const st = getSettings();
    const { dlg } = openSheet(`
      <div class="sheet-form chart-sheet">
        <h2>그래프 설정</h2>
        ${segRow('weighting', '주파수 가중치', WEIGHTINGS.map((w) => [w, `${w}특성`]), st.weighting, `<span id="f-weight-note">${WEIGHT_NOTE[st.weighting]}</span> 바꾸면 최소·평균·최대가 새로 시작합니다.`)}
        ${segRow('style', '그래프 모양', [['fill', '면'], ['line', '선']], st.style)}
        ${segRow('hold', '최대값', [['on', '표시'], ['off', '숨김']], st.hold ? 'on' : 'off')}
        ${segRow('fft', 'FFT 크기', FFT_SIZES.map((n) => [n, n]), st.fftSize, '클수록 주파수를 잘게 나누지만 반응이 느려집니다. 1/3 옥타브 보기는 늘 16384로 계산합니다.')}
        ${segRow('scale', '주파수 축', [['log', '로그'], ['linear', '선형']], st.scale)}
        <button type="button" class="btn btn-wide" data-close>닫기</button>
      </div>`);
    bindSegs(dlg, (key, v) => {
      if (key === 'weighting') {
        saveSettings({ weighting: v });
        dlg.querySelector('#f-weight-note').textContent = WEIGHT_NOTE[v];
        $('a-weight').textContent = `${v}특성`;
        $('a-unit').textContent = unitOf(v);
        gram.unit = unitOf(v);
        if (meter) meter.setWeighting(v);
        clearReadings();
      } else if (key === 'style') saveSettings({ style: v });
      else if (key === 'hold') saveSettings({ hold: v === 'on' });
      else if (key === 'fft') {
        saveSettings({ fftSize: Number(v) });
        applyFft();
      } else {
        saveSettings({ scale: v });
        gram.configure({ scale: v });
      }
      if (meter?.paused && hold) draw(meter.levels);
    });
  }

  const onVisibility = () => {
    if (document.hidden) stopMic();
    else micPermission().then((p) => p === 'granted' && !meter && startMic());
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup = () => {
    document.removeEventListener('visibilitychange', onVisibility);
    stopMic();
    chart.destroy();
    gram.destroy();
    octave.destroy();
  };

  view.querySelector('[data-act=mic]').onclick = () => startMic();
  toggleBtn.onclick = async () => {
    if (!meter || !meter.running) return startMic();
    meter.paused = !meter.paused;
    showRunning(meter.paused);
  };
  recBtn.onclick = async () => {
    if (meter?.recording) return stopRecording();
    if (!(await startMic())) return;
    meter.paused = false;
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
    if (!meter || !hold || meter.elapsed < 1) return toast('측정을 시작한 뒤에 저장할 수 있습니다');
    // grab the sound first: it is "what was just heard", before the sheet takes any time
    const audio = getSettings().audioSec > 0 ? meter.captureAudio() : Promise.resolve(new Float32Array(0));
    openSave(snapshot(), audio);
  };
  view.querySelector('[data-act=help]').onclick = helpSheet;
  view.querySelector('[data-act=chart-settings]').onclick = chartSettings;
  view.querySelectorAll('.mode').forEach((b) => (b.onclick = () => setMode(b.dataset.mode)));

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
    const a = analyzeSound(decoded.samples, decoded.rate, calibrated ? st.offset : 0, { weighting: st.weighting });
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
          <p class="legend" data-style="${st.style}"><i class="lg-cur"></i><span id="fa-cur-label">전체 평균</span> <i class="lg-max"></i>전체 최대
            <button type="button" class="link" id="fa-avg" hidden>전체 평균 보기</button></p>
        </section>
        <div class="an-options" role="group" aria-label="분석 설정">
          <button type="button" class="opt" data-opt="unit"><span>레벨 기준</span><b>${calibrated ? `보정 ${unitOf(st.weighting)}` : '파일 dBFS'}</b></button>
          <button type="button" class="opt" data-opt="weighting"><span>가중치</span><b>${st.weighting}특성</b></button>
          <button type="button" class="opt" data-opt="style"><span>모양</span><b>${st.style === 'line' ? '선' : '면'}</b></button>
          <button type="button" class="opt" data-opt="scale"><span>주파수 축</span><b>${st.scale === 'log' ? '로그' : '선형'}</b></button>
        </div>
        <section class="stats-grid">
          <div><span>평균 Leq</span><b>${fmtDb(a.leq)}</b><small>${unit}</small></div>
          <div><span>최대</span><b>${fmtDb(a.lmax)}</b><small>${unit}</small></div>
          <div><span>최소</span><b>${fmtDb(a.lmin)}</b><small>${unit}</small></div>
        </section>
        <section class="card">
          <h2>시간축 <small>누르면 그 시점부터 재생</small></h2>
          <div class="gram-box-rec"><div class="gram-plot" id="fa-gram"></div></div>
        </section>
        <section class="card">
          <h2>시간별 소음도 <small>누르면 그 시점으로 이동</small></h2>
          <div class="timeline-box"><div class="gram-plot" id="fa-time"></div></div>
        </section>
        <section class="card">
          <dl class="meta">
            <dt>피크</dt><dd>${a.peaks.length ? a.peaks.map((p) => `${fmtHz(p.hz)} <small>(${fmtDb(p.db)} ${unit})</small>`).join('<br>') : '뚜렷한 피크 없음'}</dd>
            <dt>가장 큰 순간</dt><dd>${fmtClock(loudestAt)} <button type="button" class="link" data-seek="${loudestAt}">여기 듣기</button></dd>
            <dt>레벨 기준</dt><dd>${calibrated ? `이 휴대폰 보정값(${st.offset} dB)을 적용했습니다. 다른 기기로 녹음한 파일이면 참고값입니다.` : `파일의 디지털 크기(0 dBFS = 최대)에 ${st.weighting}특성만 적용했습니다.`}</dd>
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
    gram.setStatic(a.frames, a.freqs, a.duration, { labels: 'absolute', unit });
    const timeline = new TimelineView($('fa-time'), { onSeek: seek });
    timeline.set(a.history, a.historyStep, a.leq, unit);

    function show() {
      const st2 = getSettings();
      const t = player.currentTime;
      chart.update(
        { freqs: a.freqs, cur: atPosition ? frameAt(a, t) : a.avg, max: a.max, peaks: atPosition ? [] : a.peaks },
        { scale: st2.scale, style: st2.style, range, unit },
      );
      $('fa-cur-label').textContent = atPosition ? `재생 위치 ${fmtClock(t)}` : '전체 평균';
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
          else saveSettings({ weighting: WEIGHTINGS[(WEIGHTINGS.indexOf(st2.weighting) + 1) % WEIGHTINGS.length] });
          teardown?.();
          teardown = await showAnalysis(file, decoded);
          return;
        }
        if (b.dataset.opt === 'style') {
          const style = st2.style === 'line' ? 'fill' : 'line';
          saveSettings({ style });
          b.querySelector('b').textContent = style === 'line' ? '선' : '면';
          result.querySelector('.legend').dataset.style = style;
        } else {
          const scale = st2.scale === 'log' ? 'linear' : 'log';
          saveSettings({ scale });
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
        spectrum: { freqs: avg.freqs, cur: avg.values, max: forRecord(a.max, a.freqs).values, range },
        fftSize: 4096,
        sampleRate: decoded.rate,
        offset: a.offset,
        weighting: a.weighting,
        unit,
        calibrated: calibrated && !!st.calibratedAt,
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
  return `<li><a class="record-row" href="#/record/${encodeURIComponent(r.id)}">
    <span class="rr-time">${fmtTime(r.ts)}</span>
    <span class="rr-main"><strong>${esc(r.vehicle || (r.source === 'file' ? r.fileName : '차량 미입력'))}</strong><span>${esc(r.memo || `${r.source === 'file' ? '파일' : '측정'} ${fmtClock(r.elapsed)}${r.peaks?.[0] ? ` · 피크 ${fmtHz(r.peaks[0].hz)}` : ''}`)}</span></span>
    <span class="rr-value"><small>평균</small>${fmtDb(r.leq)}<small>최대</small>${fmtDb(r.lmax)}</span>
  </a></li>`;
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
          <p>${fmtDate(rec.ts)} · ${fromFile ? `파일 ${fmtClock(rec.elapsed)}` : `측정 ${fmtClock(rec.elapsed)}`}</p>
        </header>
        <section class="card chart-card">
          <div class="chart-box-rec"><div class="chart-plot" id="rec-chart"></div></div>
          ${cursorBox('rec-cursor')}
          <p class="legend" data-style="${s.style}"><i class="lg-cur"></i>${fromFile ? '전체 평균' : '저장 순간'} <i class="lg-max"></i>${fromFile ? '전체 최대' : '측정 중 최대'} <span class="fine">· 그래프를 누르면 커서</span></p>
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
              <p class="fine">${fromFile ? '시간축 그래프는 아래가 처음, 위가 끝입니다.' : '시간축 그래프: 맨 위가 저장한 순간, 아래로 갈수록 그 전 소리입니다.'} 그래프를 누르면 그 시점부터 들을 수 있습니다.</p>
              <button type="button" class="btn btn-wide" data-act="share-audio">소리 파일 보내기</button>
            </section>`
          : ''}
        <section class="card">
          <dl class="meta">
            <dt>피크</dt><dd>${rec.peaks?.length ? rec.peaks.map((p) => `${fmtHz(p.hz)} <small>(${fmtDb(p.db)} ${unit})</small>`).join('<br>') : '뚜렷한 피크 없음'}</dd>
            <dt>메모</dt><dd class="memo">${esc(rec.memo) || '-'}</dd>
            ${fromFile ? `<dt>파일</dt><dd>${esc(rec.fileName)}</dd>` : `<dt>저장 순간</dt><dd>${fmtDb(rec.laf)} ${unit}</dd>`}
            <dt>분석 설정</dt><dd>${rec.weighting || 'A'}특성 · FFT ${rec.fftSize} · ${unit.startsWith('dBFS') ? '파일 디지털 레벨(dBFS) 기준' : rec.calibrated ? '마이크 보정됨' : '마이크 보정 안 됨 (참고값)'}</dd>
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
  chart.update(
    { freqs: Float32Array.from(sp.freqs), cur: Float32Array.from(sp.cur), max: Float32Array.from(sp.max), peaks: rec.peaks },
    { scale: 'log', style: s.style, range: sp.range, unit },
  );
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
        const a = analyzeSound(samples, rate, rec.offset ?? s.offset, { weighting: rec.weighting || 'A' });
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
          <label class="field field-num"><span>이 값부터 색 막대는 빨강, 게이지는 주황 (dB)</span>
            <input id="f-alert" type="number" inputmode="decimal" min="30" max="130" step="1" value="${s.alertLevel}"></label>
        </section>

        <section class="card">
          <h2>마이크 보정</h2>
          <p>현재 보정값 <strong id="cal-offset">${s.offset} dB</strong> · <span id="cal-date">${s.calibratedAt ? `${fmtShortDate(s.calibratedAt)} 보정` : '보정 안 됨'}</span></p>
          <p class="fine">휴대폰마다 마이크 감도가 달라 기기별로 한 번씩 보정해야 값이 맞습니다.</p>
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
            <label class="field field-num"><span>보정값 (dB)</span><input id="f-offset" type="number" inputmode="decimal" step="0.1" value="${s.offset}"></label>
          </details>
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

  view.querySelector('[data-act=cal-measure]').onclick = async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    calMeter = new Meter(getSettings().offset);
    try {
      await calMeter.start();
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
      btn.textContent = '보정 측정 다시 하기 (5초)';
    }
  };
  view.querySelector('[data-act=cal-apply]').onclick = () => {
    const ref = parseFloat($('f-cal-ref').value);
    if (!Number.isFinite(ref) || ref < 20 || ref > 140 || !Number.isFinite(calPhone)) return toast('소음계 값을 확인해 주세요');
    const offset = round1(getSettings().offset + (ref - calPhone));
    saveSettings({ offset, calibratedAt: Date.now() });
    $('cal-offset').textContent = `${offset} dB`;
    $('cal-date').textContent = `${fmtShortDate(Date.now())} 보정`;
    $('f-offset').value = offset;
    $('cal-result').hidden = true;
    toast(`보정했습니다 (보정값 ${offset} dB)`);
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
    saveSettings({
      company: $('f-company').value.trim() || before.company,
      audioSec: Number($('f-audio-sec').value),
      alertLevel: Math.round(alertLevel),
      offset: round1(offset),
      calibratedAt: round1(offset) !== before.offset ? Date.now() : before.calibratedAt,
      pin: newPin || before.pin,
    });
    err.hidden = true;
    toast('설정을 저장했습니다');
  };
}

/* ---------- boot ---------- */

window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
