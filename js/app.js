// Screens and navigation. Routes live in the URL hash so the phone's back button works:
// #/ (main screen: live spectrum + measuring), #/record/<id>, #/history, #/report, #/settings

import { MODES, MODE_BY_ID, APP_VERSION, getSettings, saveSettings, modeConfig, rememberVehicle } from './settings.js';
import { Meter } from './meter.js';
import { BANDS, judge, dominantZone, zoneOfFrequency } from './dsp.js';
import * as store from './store.js';
import {
  VERDICT,
  ZONE_INFO,
  METRIC_LABEL,
  TONAL_PROMINENCE,
  esc,
  fmtDb,
  fmtHz,
  fmtDate,
  fmtDay,
  fmtShortDate,
  fmtTime,
  fileStamp,
  criterionText,
  mapUrl,
  fmtLoc,
} from './format.js';
import { spectrumSvg, gauge, zoneBar } from './charts.js';
import { SpectrumChart } from './spectrum.js';
import { summaryText, renderCard, recordsCsv, deliverFile } from './share.js';

const view = document.getElementById('view');
let cleanup = null; // runs before the next screen renders
let freshRecordId = null; // the record just measured, to say it was saved
let adminUnlocked = false;
let installPrompt = null;
const historyFilter = { period: '7d', vehicle: '' };

const PERIODS = [
  { id: 'today', label: '오늘' },
  { id: '7d', label: '7일' },
  { id: '30d', label: '30일' },
  { id: 'all', label: '전체' },
];

const routes = {
  home: renderMeter,
  measure: selectMode,
  record: renderRecord,
  history: renderHistory,
  report: renderReport,
  settings: renderSettings,
};

function route() {
  cleanup?.();
  cleanup = null;
  const [name, arg] = location.hash.replace(/^#\/?/, '').split('/');
  const key = routes[name] ? name : 'home';
  document.body.dataset.view = key;
  document.getElementById('brand-company').textContent = getSettings().company;
  window.scrollTo(0, 0);
  Promise.resolve(routes[key](arg ? decodeURIComponent(arg) : undefined)).catch(showFatal);
}

function showFatal(err) {
  console.error(err);
  view.innerHTML = `<div class="alert">문제가 생겼습니다: ${esc(err?.message || err)}</div>
    <a class="btn btn-wide" href="#/">처음으로</a>`;
}

/* ---------- small UI helpers ---------- */

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2800);
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
  dlg.querySelector('input, textarea')?.focus();
  return { dlg, close };
}

function speak(text, volume = 1) {
  if (!('speechSynthesis' in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text || ' ');
    u.lang = 'ko-KR';
    u.volume = volume;
    speechSynthesis.speak(u);
  } catch {
    // Voice output is a convenience only.
  }
}

async function keepScreenOn() {
  try {
    return (await navigator.wakeLock?.request('screen')) || null;
  } catch {
    return null;
  }
}

function getLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

const withTimeout = (promise, ms) => Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]);
const round1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function verdictChip(verdict) {
  return `<span class="chip" data-verdict="${verdict}">${VERDICT[verdict].label}</span>`;
}

function recordRow(rec, { showDay = false } = {}) {
  return `<li><a class="record-row" href="#/record/${encodeURIComponent(rec.id)}">
    <span class="rr-time">${showDay ? `${fmtShortDate(rec.ts).slice(5)}<br>` : ''}${fmtTime(rec.ts)}</span>
    <span class="rr-main"><strong>${esc(rec.vehicle || '차량 미입력')}</strong><span>${esc(rec.modeName)}</span></span>
    <span class="rr-value">${fmtDb(rec.value)}<small>dB</small></span>
    ${verdictChip(rec.verdict)}
  </a></li>`;
}

/* ---------- main screen: live spectrum + measurement ---------- */

const NAV_ICONS = {
  history: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h10"/></svg>',
  settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/></svg>',
};

function currentMode() {
  const id = getSettings().lastMode;
  return modeConfig(MODE_BY_ID[id] ? id : MODES[0].id);
}

async function micPermission() {
  try {
    return (await navigator.permissions.query({ name: 'microphone' })).state;
  } catch {
    return 'prompt';
  }
}

function shortCriterion(mode) {
  return mode.limit != null ? `${METRIC_LABEL[mode.metric].replace(' 소음', '')} ${mode.limit} dB 이하` : '소리 종류 분석';
}

function showGuide(mode) {
  openSheet(`
    <div class="sheet-form">
      <h2>${mode.name} 측정 방법</h2>
      <ol class="guide">
        ${mode.guide.map((g) => `<li>${g}</li>`).join('')}
        <li>측정하는 동안에는 말하지 마세요.</li>
      </ol>
      ${mode.safety ? `<p class="safety">${mode.safety}</p>` : ''}
      <p class="fine">판정 기준: ${criterionText(mode)} · ${mode.delay ? `시작 ${mode.delay}초 뒤부터 ` : ''}${mode.duration}초 측정</p>
      <button type="button" class="btn btn-primary btn-wide" data-close>확인</button>
    </div>`);
}

function installOffer() {
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let hidden = false;
  try {
    hidden = localStorage.getItem('noise-meter:install-hint') === 'hidden';
  } catch {
    // ignore
  }
  if (standalone || hidden) return '';
  if (installPrompt) return '<p class="install-hint"><span>홈 화면에 추가하면 앱처럼 바로 열립니다.</span><button type="button" class="btn btn-small" data-act="install">추가</button></p>';
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return '<p class="install-hint"><span>사파리 공유 버튼 → <b>홈 화면에 추가</b>로 앱처럼 쓸 수 있습니다.</span></p>';
  return '';
}

async function renderMeter() {
  const s = getSettings();
  let mode = currentMode();
  view.innerHTML = `
    <section class="meter" data-state="off">
      <div class="meter-head">
        <button type="button" class="vehicle-chip" data-act="vehicle">
          <span class="eyebrow">차량</span>
          <strong class="${s.vehicle ? '' : 'is-empty'}">${s.vehicle ? esc(s.vehicle) : '차량번호 입력'}</strong>
          ${s.driver ? `<span class="driver">${esc(s.driver)}</span>` : ''}
        </button>
        <nav class="meter-nav" aria-label="메뉴">
          <a href="#/history">${NAV_ICONS.history}<span>기록</span></a>
          <a href="#/settings">${NAV_ICONS.settings}<span>설정</span></a>
        </nav>
      </div>
      <div class="readout">
        <div class="readout-main" id="r-main">
          <span class="readout-label">현재 소음</span>
          <span class="readout-value"><b id="r-value">--.-</b><small>dB(A)</small></span>
        </div>
        <dl class="readout-stats">
          <div><dt>평균</dt><dd id="r-leq">–</dd></div>
          <div><dt>최대</dt><dd id="r-max">–</dd></div>
          <div><dt>주요 소리</dt><dd id="r-peak">–</dd></div>
        </dl>
      </div>
      <div class="status">
        <p class="status-text" id="r-status"></p>
        <div class="progress" id="r-progress" hidden><div class="progress-fill" id="r-progress-fill"></div></div>
      </div>
      <div class="chart-box">
        <div class="chart-plot" id="r-chart"></div>
        <div class="chart-overlay" id="r-overlay">
          <button type="button" class="mic-button" data-act="mic">${NAV_ICONS.mic}<strong>눌러서 측정 화면 켜기</strong></button>
          <p class="overlay-note" id="r-overlay-note">처음 한 번은 마이크 사용을 "허용"해 주세요.</p>
          ${installOffer()}
        </div>
      </div>
      <div class="controls">
        <div class="mode-select" role="radiogroup" aria-label="측정 항목">
          ${MODES.map((m) => `<button type="button" role="radio" data-mode="${m.id}" aria-checked="false">${m.short}</button>`).join('')}
        </div>
        <button type="button" class="btn btn-primary btn-start" id="r-start"></button>
      </div>
    </section>`;

  const $ = (id) => view.querySelector(`#${id}`);
  const root = view.querySelector('.meter');
  const chart = new SpectrumChart($('r-chart'));
  let meter = null;
  let wake = null;
  let raf = 0;
  let run = 0; // bumps on every start / cancel so a stale countdown stops itself
  let laf = null;
  let holds = null;
  let lastPeakUpdate = 0;

  const setState = (state) => (root.dataset.state = state);
  const busy = () => ['countdown', 'recording'].includes(root.dataset.state);

  function showIdle(message) {
    $('r-start').innerHTML = `측정 시작<small>${mode.duration}초 · ${shortCriterion(mode)}</small>`;
    $('r-start').classList.remove('is-cancel');
    $('r-progress').hidden = true;
    $('r-status').classList.toggle('is-error', !!message);
    $('r-status').innerHTML = message
      ? esc(message)
      : `${mode.guide[0]} <button type="button" class="link" data-act="guide">측정 방법</button>`;
    view.querySelectorAll('[data-mode]').forEach((b) => {
      b.setAttribute('aria-checked', String(b.dataset.mode === mode.id));
      b.disabled = false;
    });
  }

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!meter) return;
    if (!meter.running) {
      $('r-overlay').hidden = false;
      return;
    }
    if (!$('r-overlay').hidden) {
      $('r-overlay').hidden = true;
      if (root.dataset.state === 'off') setState('live');
    }
    const levels = meter.liveBands();
    if (holds) levels.forEach((v, i) => (holds[i] = Math.max(holds[i], v)));
    chart.update({ levels, holds, overall: laf, verdict: judge(laf, mode.warn, mode.limit) });
    if (now - lastPeakUpdate > 300) {
      lastPeakUpdate = now;
      let peak = 0;
      levels.forEach((v, i) => v > levels[peak] && (peak = i));
      $('r-peak').textContent = Number.isFinite(levels[peak]) ? `${BANDS[peak].label}Hz` : '–';
    }
  }

  async function startMic() {
    if (meter) {
      if (!meter.running) await meter.resume();
      return true;
    }
    meter = new Meter(getSettings().offset);
    try {
      await meter.start();
    } catch (err) {
      meter = null;
      if (err.code !== 'cancelled') {
        $('r-overlay').hidden = false;
        $('r-overlay-note').textContent = err.message;
        $('r-overlay-note').classList.add('is-error');
      }
      return false;
    }
    meter.onLevel = (db) => {
      laf = db;
      $('r-value').textContent = fmtDb(db);
      $('r-main').dataset.verdict = judge(db, mode.warn, mode.limit);
    };
    $('r-overlay-note').textContent = '';
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(frame);
    return true;
  }

  function stopMic() {
    cancelAnimationFrame(raf);
    meter?.stop();
    meter = null;
    laf = null;
    $('r-value').textContent = '--.-';
    $('r-main').dataset.verdict = '';
    $('r-overlay').hidden = false;
    setState('off');
  }

  function cancelMeasurement(message) {
    run++;
    meter?.cancel();
    holds = null;
    wake?.release?.().catch(() => {});
    wake = null;
    setState(meter ? 'live' : 'off');
    showIdle(message);
  }

  async function startMeasurement() {
    if (!getSettings().vehicle) {
      editVehicle(() => route());
      return;
    }
    const s = getSettings();
    // Speak once inside the tap so the result can be announced later (iOS); silent when it would be recorded.
    const talk = s.voice && mode.delay >= 3;
    speak(talk ? '곧 측정을 시작합니다' : '', talk ? 1 : 0);
    if (!(await startMic())) return;
    const my = ++run;
    setState('countdown');
    view.querySelectorAll('[data-mode]').forEach((b) => (b.disabled = true));
    $('r-start').innerHTML = '취소';
    $('r-start').classList.add('is-cancel');
    $('r-status').classList.remove('is-error');
    $('r-leq').textContent = '–';
    $('r-max').textContent = '–';
    wake = await keepScreenOn();
    const locating = s.location ? getLocation() : Promise.resolve(null);

    for (let left = mode.delay; left > 0; left--) {
      $('r-status').textContent = `${left}초 뒤 측정을 시작합니다. 휴대폰을 제자리에 두세요.`;
      await sleep(1000);
      if (run !== my) return;
    }
    setState('recording');
    holds = new Array(BANDS.length).fill(-Infinity);
    $('r-progress').hidden = false;
    $('r-progress-fill').style.width = '0%';
    $('r-status').textContent = '측정 중';
    try {
      const result = await meter.record(mode.duration, ({ elapsed, leq, lmax }) => {
        $('r-progress-fill').style.width = `${Math.min(100, (elapsed / mode.duration) * 100)}%`;
        $('r-status').textContent = `측정 중 · ${Math.max(0, Math.ceil(mode.duration - elapsed))}초 남음`;
        $('r-leq').textContent = fmtDb(leq);
        $('r-max').textContent = fmtDb(lmax);
      });
      if (run !== my) return;
      $('r-status').textContent = '저장 중…';
      const rec = buildRecord(mode, result, getSettings(), await withTimeout(locating, 3000));
      await store.putRecord(rec);
      announce(rec);
      freshRecordId = rec.id;
      location.hash = `#/record/${encodeURIComponent(rec.id)}`;
    } catch (err) {
      if (err?.code !== 'cancelled') cancelMeasurement(err?.message || '측정에 실패했습니다.');
    }
  }

  const onVisibility = () => {
    if (document.hidden) {
      if (busy()) cancelMeasurement('화면이 꺼지거나 다른 앱으로 바뀌어 측정을 멈췄습니다. 다시 시작해 주세요.');
      stopMic();
    } else {
      micPermission().then((p) => p === 'granted' && !meter && startMic());
    }
  };
  document.addEventListener('visibilitychange', onVisibility);
  cleanup = () => {
    run++;
    document.removeEventListener('visibilitychange', onVisibility);
    wake?.release?.().catch(() => {});
    cancelAnimationFrame(raf);
    meter?.stop();
    chart.destroy();
  };

  view.querySelector('[data-act=vehicle]').onclick = () => !busy() && editVehicle(() => route());
  view.querySelector('[data-act=mic]').onclick = () => startMic();
  $('r-start').onclick = () => (busy() ? cancelMeasurement() : startMeasurement());
  $('r-status').addEventListener('click', (e) => e.target.closest('[data-act=guide]') && showGuide(mode));
  view.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      if (busy()) return;
      mode = modeConfig(b.dataset.mode);
      saveSettings({ lastMode: mode.id });
      showIdle();
    }),
  );
  view.querySelector('[data-act=install]')?.addEventListener('click', async () => {
    installPrompt.prompt();
    await installPrompt.userChoice.catch(() => null);
    installPrompt = null;
    view.querySelector('.install-hint')?.remove();
  });

  showIdle();
  chart.update({ levels: null });
  if ((await micPermission()) === 'granted') startMic();
}

// Old links (#/measure/<mode>) pick the mode on the main screen.
function selectMode(modeId) {
  if (MODE_BY_ID[modeId]) saveSettings({ lastMode: modeId });
  location.replace('#/');
}

function editVehicle(after) {
  const s = getSettings();
  const { dlg, close } = openSheet(`
    <form class="sheet-form" id="vehicle-form">
      <h2>차량 정보</h2>
      <label class="field"><span>차량번호</span>
        <input id="f-vehicle" value="${esc(s.vehicle)}" placeholder="예: 12가 3456" autocomplete="off" required></label>
      ${s.recentVehicles.length
        ? `<div class="chips">${s.recentVehicles.map((v) => `<button type="button" class="chip chip-pick" data-v="${esc(v)}">${esc(v)}</button>`).join('')}</div>`
        : ''}
      <label class="field"><span>기사 이름 <small>(선택)</small></span>
        <input id="f-driver" value="${esc(s.driver)}" placeholder="예: 홍길동" autocomplete="name"></label>
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" data-close>취소</button>
        <button class="btn btn-primary" type="submit">확인</button>
      </div>
    </form>`);
  const input = dlg.querySelector('#f-vehicle');
  dlg.querySelectorAll('.chip-pick').forEach((b) => (b.onclick = () => (input.value = b.dataset.v)));
  dlg.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return input.focus();
    rememberVehicle(v);
    saveSettings({ driver: dlg.querySelector('#f-driver').value.trim() });
    close();
    after?.();
  };
}

function buildRecord(mode, r, s, loc) {
  const value = mode.metric === 'lmax' ? r.lmax : r.leq;
  return {
    id: store.newId(),
    ts: Date.now(),
    mode: mode.id,
    modeName: mode.name,
    vehicle: s.vehicle,
    driver: s.driver,
    leq: round1(r.leq),
    lmax: round1(r.lmax),
    metric: mode.metric,
    value: round1(value),
    warn: mode.warn,
    limit: mode.limit,
    verdict: judge(value, mode.warn, mode.limit),
    bands: r.bands,
    bandsMax: r.bandsMax,
    zones: r.zones,
    peakHz: r.peakHz,
    peakProminence: r.peakProminence,
    durationSec: r.durationSec,
    clipped: r.clipped,
    calibrated: !!s.calibratedAt,
    offset: s.offset,
    loc,
    memo: '',
    photo: null,
    app: APP_VERSION,
  };
}

function announce(rec) {
  navigator.vibrate?.([180, 90, 180]);
  if (!getSettings().voice) return;
  const what = rec.verdict === 'none'
    ? `${ZONE_INFO[dominantZone(rec.zones)].name}이 가장 큽니다.`
    : `${VERDICT[rec.verdict].speak} ${METRIC_LABEL[rec.metric]} ${fmtDb(rec.value)} 데시벨.`;
  speak(`측정이 끝났습니다. ${what}`);
}

/* ---------- result / record detail ---------- */

function inspectMessage(rec) {
  if (rec.peakHz && rec.peakProminence >= TONAL_PROMINENCE) {
    return `약 ${fmtHz(rec.peakHz)}에서 뚜렷한 소리가 납니다.`;
  }
  return `특정한 음 없이 ${ZONE_INFO[dominantZone(rec.zones)].name} 위주의 소리입니다.`;
}

async function renderRecord(id) {
  const rec = await store.getRecord(id);
  if (!rec) {
    view.innerHTML = '<p class="alert">기록을 찾을 수 없습니다.</p><a class="btn btn-wide" href="#/history">기록 목록</a>';
    return;
  }
  const s = getSettings();
  const fresh = freshRecordId === id;
  freshRecordId = null;
  const v = VERDICT[rec.verdict];
  const dz = dominantZone(rec.zones);
  const tonal = rec.peakHz && rec.peakProminence >= TONAL_PROMINENCE;
  const photoUrl = rec.photo ? URL.createObjectURL(rec.photo) : null;

  view.innerHTML = `
    <a class="back" href="${fresh ? '#/' : '#/history'}">← ${fresh ? '측정 화면' : '기록 목록'}</a>
    <div class="result-layout">
    <section class="verdict" data-verdict="${rec.verdict}">
      <div class="verdict-top">
        <span class="verdict-label">${v.label}</span>
        <span class="verdict-mode">${esc(rec.modeName)}<br>${esc(rec.vehicle)}</span>
      </div>
      <p class="verdict-msg">${rec.verdict === 'none' ? inspectMessage(rec) : v.msg}</p>
      <div class="headline">
        <span class="headline-label">${METRIC_LABEL[rec.metric]}</span>
        <span class="headline-value">${fmtDb(rec.value)}</span><span class="headline-unit">dB(A)</span>
      </div>
      ${rec.limit != null ? gauge(rec.value, rec.warn, rec.limit) : ''}
    </section>
    <section class="card chart-card">
      <h2>주파수별 소리 크기 <small>막대: 평균 · 가로선: 최대</small></h2>
      <div class="chart-box chart-box-result"><div class="chart-plot" id="rec-chart"></div></div>
    </section>
    ${rec.clipped ? '<p class="alert">소리가 휴대폰 마이크의 측정 한계를 넘었습니다. 실제 소음은 표시된 값보다 클 수 있습니다.</p>' : ''}
    <section class="figures">
      <div class="figure"><span class="eyebrow">평균</span><strong>${fmtDb(rec.leq)}</strong><span>dB(A)</span></div>
      <div class="figure"><span class="eyebrow">최대</span><strong>${fmtDb(rec.lmax)}</strong><span>dB(A)</span></div>
      <div class="figure"><span class="eyebrow">주요 소리</span><strong>${rec.peakHz ? Math.round(rec.peakHz).toLocaleString('ko-KR') : '–'}</strong><span>Hz${rec.peakHz ? ` · ${ZONE_INFO[zoneOfFrequency(rec.peakHz)].name}` : ''}</span></div>
    </section>
    <section class="card">
      <h2>어떤 소리인가요?</h2>
      ${zoneBar(rec.zones)}
      <p class="lead"><strong>${ZONE_INFO[dz].name}</strong>(${ZONE_INFO[dz].sound})이 가장 큽니다. ${ZONE_INFO[dz].causes}</p>
      ${tonal ? `<p>약 <strong>${fmtHz(rec.peakHz)}</strong>에서 뚜렷하게 튀는 소리가 있습니다. ${ZONE_INFO[zoneOfFrequency(rec.peakHz)].sound}가 들렸다면 이 소리입니다.</p>` : ''}
      <p class="fine">참고용 안내입니다. 정확한 원인은 정비 점검으로 확인하세요.</p>
    </section>
    <section class="card">
      <h2>메모·사진</h2>
      ${rec.memo ? `<p class="memo">${esc(rec.memo)}</p>` : ''}
      ${photoUrl ? `<img class="photo" src="${photoUrl}" alt="측정 현장 사진">` : ''}
      ${!rec.memo && !photoUrl ? '<p class="fine">소리 상태나 차량 상황을 적어 두면 정비할 때 도움이 됩니다.</p>' : ''}
      <button class="btn btn-wide" data-act="note">${rec.memo || photoUrl ? '메모·사진 수정' : '메모·사진 추가'}</button>
    </section>
    <section class="card">
      <dl class="meta">
        <dt>측정 일시</dt><dd>${fmtDate(rec.ts)}</dd>
        <dt>차량번호</dt><dd>${esc(rec.vehicle || '-')}</dd>
        <dt>기사</dt><dd>${esc(rec.driver || '-')}</dd>
        <dt>판정 기준</dt><dd>${criterionText(rec)}</dd>
        <dt>측정 시간</dt><dd>${rec.durationSec}초</dd>
        <dt>위치</dt><dd>${rec.loc ? `<a href="${mapUrl(rec.loc)}" target="_blank" rel="noopener">지도에서 보기</a> <small>${fmtLoc(rec.loc)}</small>` : '기록 안 됨'}</dd>
        <dt>마이크 보정</dt><dd>${rec.calibrated ? '보정됨' : '보정 안 됨 (참고값)'}</dd>
      </dl>
    </section>
    </div>
    <div class="action-bar">
      <a class="btn" href="#/measure/${rec.mode}">다시 측정</a>
      <button class="btn btn-primary" data-act="share">결과 보내기</button>
    </div>
    <button class="btn btn-danger-quiet btn-wide" data-act="delete">이 기록 삭제</button>
  `;

  if (fresh) toast('측정 결과를 저장했습니다');
  const chart = new SpectrumChart(view.querySelector('#rec-chart'));
  chart.update({ levels: rec.bands, holds: rec.bandsMax, overall: rec.value, verdict: rec.verdict });
  cleanup = () => {
    chart.destroy();
    if (photoUrl) URL.revokeObjectURL(photoUrl);
  };

  // Render the card now so the share sheet opens straight from the tap (iOS needs that).
  const card = renderCard(rec, s);
  view.querySelector('[data-act=share]').onclick = async () => {
    const blob = await card;
    const result = await deliverFile(blob, `소음측정_${(rec.vehicle || '차량').replace(/\s/g, '')}_${fileStamp(rec.ts)}.png`, {
      title: '차량 소음 측정 결과',
      text: summaryText(rec, s),
    });
    if (result === 'downloaded') {
      await navigator.clipboard?.writeText(summaryText(rec, s)).catch(() => {});
      toast('결과 이미지를 저장했습니다. 내용은 복사되어 붙여넣기 할 수 있습니다.');
    }
  };
  view.querySelector('[data-act=note]').onclick = () => editNote(rec);
  const del = view.querySelector('[data-act=delete]');
  del.onclick = async () => {
    if (del.dataset.armed !== 'yes') {
      del.dataset.armed = 'yes';
      del.textContent = '한 번 더 누르면 삭제됩니다';
      setTimeout(() => {
        if (del.isConnected) {
          del.dataset.armed = '';
          del.textContent = '이 기록 삭제';
        }
      }, 4000);
      return;
    }
    await store.deleteRecord(rec.id);
    toast('기록을 삭제했습니다');
    location.replace('#/history');
  };
}

function editNote(rec) {
  const { dlg, close } = openSheet(`
    <form class="sheet-form">
      <h2>메모·사진</h2>
      <label class="field"><span>메모</span>
        <textarea id="f-memo" rows="4" placeholder="예: 시속 80km에서 오른쪽 뒤에서 윙 소리">${esc(rec.memo)}</textarea></label>
      <label class="field"><span>사진</span>
        <input id="f-photo" type="file" accept="image/*" capture="environment"></label>
      ${rec.photo ? '<label class="check"><input type="checkbox" id="f-photo-remove"> 기존 사진 지우기</label>' : ''}
      <div class="sheet-actions">
        <button type="button" class="btn btn-quiet" data-close>취소</button>
        <button class="btn btn-primary" type="submit">저장</button>
      </div>
    </form>`);
  dlg.querySelector('form').onsubmit = async (e) => {
    e.preventDefault();
    const submit = dlg.querySelector('[type=submit]');
    submit.disabled = true;
    const file = dlg.querySelector('#f-photo').files[0];
    let photo = rec.photo;
    if (dlg.querySelector('#f-photo-remove')?.checked) photo = null;
    if (file) photo = (await compressPhoto(file).catch(() => null)) || photo;
    await store.putRecord({ ...rec, memo: dlg.querySelector('#f-memo').value.trim(), photo });
    close();
    toast('저장했습니다');
    route();
  };
}

async function compressPhoto(file) {
  const max = 1280;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
}

/* ---------- history ---------- */

function periodStart(id) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  const day = 864e5;
  return { today: d.getTime(), '7d': d.getTime() - 6 * day, '30d': d.getTime() - 29 * day }[id] ?? 0;
}

function filterRecords(all, f) {
  const from = periodStart(f.period);
  const q = f.vehicle.replace(/\s/g, '');
  return all.filter((r) => r.ts >= from && (!q || (r.vehicle || '').replace(/\s/g, '').includes(q)));
}

function countVerdicts(list) {
  const c = { ok: 0, warn: 0, over: 0, none: 0 };
  list.forEach((r) => c[r.verdict]++);
  return c;
}

async function renderHistory() {
  const all = await store.allRecords();
  view.innerHTML = `
    <a class="back" href="#/">← 처음으로</a>
    <h1 class="page-title">측정 기록</h1>
    <div class="filters">
      <div class="segmented" role="group" aria-label="기간">
        ${PERIODS.map((p) => `<button type="button" data-period="${p.id}" aria-pressed="${historyFilter.period === p.id}">${p.label}</button>`).join('')}
      </div>
      <input type="search" id="f-search" placeholder="차량번호로 찾기" value="${esc(historyFilter.vehicle)}" aria-label="차량번호로 찾기">
    </div>
    <div id="h-summary" class="summary"></div>
    <div id="h-list"></div>
    <div class="action-bar">
      <button class="btn" data-act="csv">엑셀 파일로 받기</button>
      <a class="btn btn-primary" href="#/report">보고서 만들기</a>
    </div>`;

  let current = [];
  const update = () => {
    current = filterRecords(all, historyFilter);
    const c = countVerdicts(current);
    view.querySelector('#h-summary').innerHTML = current.length
      ? `<strong>${current.length}건</strong> <span class="chip" data-verdict="ok">정상 ${c.ok}</span> <span class="chip" data-verdict="warn">주의 ${c.warn}</span> <span class="chip" data-verdict="over">초과 ${c.over}</span>${c.none ? ` <span class="chip" data-verdict="none">분석 ${c.none}</span>` : ''}`
      : '';
    const groups = new Map();
    current.forEach((r) => {
      const day = fmtDay(r.ts);
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(r);
    });
    view.querySelector('#h-list').innerHTML = current.length
      ? [...groups].map(([day, rows]) => `<h2 class="day-head">${day}</h2><ul class="record-list">${rows.map((r) => recordRow(r)).join('')}</ul>`).join('')
      : `<p class="empty-hint">${all.length ? '조건에 맞는 기록이 없습니다.' : '아직 측정 기록이 없습니다.'}</p>`;
    view.querySelectorAll('.action-bar .btn').forEach((b) => b.classList.toggle('is-disabled', !current.length));
  };
  update();

  view.querySelectorAll('[data-period]').forEach((b) =>
    b.addEventListener('click', () => {
      historyFilter.period = b.dataset.period;
      view.querySelectorAll('[data-period]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      update();
    }),
  );
  view.querySelector('#f-search').addEventListener('input', (e) => {
    historyFilter.vehicle = e.target.value;
    update();
  });
  view.querySelector('[data-act=csv]').onclick = async () => {
    if (!current.length) return toast('내보낼 기록이 없습니다');
    const result = await deliverFile(recordsCsv(current), `소음측정기록_${fileStamp(Date.now())}.csv`, { title: '소음 측정 기록' });
    if (result === 'downloaded') toast('엑셀에서 열 수 있는 파일(CSV)을 저장했습니다');
  };
  view.querySelector('a[href="#/report"]').addEventListener('click', (e) => {
    if (!current.length) {
      e.preventDefault();
      toast('보고서에 넣을 기록이 없습니다');
    }
  });
}

/* ---------- report ---------- */

async function renderReport() {
  const s = getSettings();
  const list = filterRecords(await store.allRecords(), historyFilter).reverse(); // oldest first
  const c = countVerdicts(list);
  const vehicles = [...new Set(list.map((r) => r.vehicle).filter(Boolean))];
  const drivers = [...new Set(list.map((r) => r.driver).filter(Boolean))];
  const flagged = list.filter((r) => r.verdict !== 'ok');
  const photos = [];
  cleanup = () => photos.forEach((u) => URL.revokeObjectURL(u));
  const period = list.length ? `${fmtShortDate(list[0].ts)} ~ ${fmtShortDate(list[list.length - 1].ts)}` : '-';

  view.innerHTML = `
    <div class="report-controls no-print">
      <a class="back" href="#/history">← 기록 목록</a>
      <p>기록 화면에서 고른 기간·차량의 <strong>${list.length}건</strong>으로 만든 보고서입니다.</p>
      <button class="btn btn-primary btn-wide" data-act="print">PDF로 저장 · 인쇄</button>
      <p class="fine">인쇄 화면에서 프린터를 <b>PDF로 저장</b>으로 고르면 파일로 저장됩니다.</p>
    </div>
    <article class="report">
      <header class="report-head">
        <div>
          <p class="report-company">${esc(s.company)}${s.team ? ` · ${esc(s.team)}` : ''}</p>
          <h1>차량 소음 측정 보고서</h1>
        </div>
        <table class="approval">
          <tr><th>담당</th><th>검토</th><th>승인</th></tr>
          <tr><td></td><td></td><td></td></tr>
        </table>
      </header>
      <table class="report-info">
        <tr><th>측정 기간</th><td>${period}</td><th>작성일</th><td>${fmtShortDate(Date.now())}</td></tr>
        <tr><th>대상 차량</th><td>${esc(vehicles.join(', ') || '-')}</td><th>측정자</th><td>${esc(drivers.join(', ') || '-')}</td></tr>
      </table>
      <div class="report-summary">
        <div><span>전체</span><strong>${list.length}</strong></div>
        <div data-verdict="ok"><span>정상</span><strong>${c.ok}</strong></div>
        <div data-verdict="warn"><span>주의</span><strong>${c.warn}</strong></div>
        <div data-verdict="over"><span>초과</span><strong>${c.over}</strong></div>
        ${c.none ? `<div data-verdict="none"><span>이상음 분석</span><strong>${c.none}</strong></div>` : ''}
      </div>
      <h2>측정 결과</h2>
      <div class="table-scroll">
        <table class="report-table">
          <thead><tr><th>No</th><th>일시</th><th>차량번호</th><th>측정 항목</th><th>평균</th><th>최대</th><th>기준</th><th>판정</th><th>주요 소리</th><th>메모</th></tr></thead>
          <tbody>
            ${list.map((r, i) => `<tr>
              <td>${i + 1}</td>
              <td>${fmtShortDate(r.ts).slice(2)} ${fmtTime(r.ts)}</td>
              <td>${esc(r.vehicle)}</td>
              <td>${esc(r.modeName)}</td>
              <td class="num${r.metric === 'leq' ? ' is-metric' : ''}">${fmtDb(r.leq)}</td>
              <td class="num${r.metric === 'lmax' ? ' is-metric' : ''}">${fmtDb(r.lmax)}</td>
              <td class="num">${r.limit != null ? `${r.limit} 이하` : '-'}</td>
              <td>${verdictChip(r.verdict)}</td>
              <td class="num">${fmtHz(r.peakHz)}</td>
              <td>${esc(r.memo)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <p class="fine">단위 dB(A). 굵게 표시한 값이 판정에 쓰인 값입니다.</p>
      ${flagged.length ? `<h2>확인이 필요한 측정 (${flagged.length}건)</h2>` : ''}
      ${flagged.map((r) => {
        const url = r.photo ? URL.createObjectURL(r.photo) : null;
        if (url) photos.push(url);
        return `<section class="report-detail">
          <div class="report-detail-head">
            ${verdictChip(r.verdict)}
            <strong>${esc(r.vehicle)} · ${esc(r.modeName)}</strong>
            <span>${fmtDate(r.ts)}</span>
          </div>
          <div class="report-detail-body">
            <div>${spectrumSvg(r.bands)}</div>
            <dl class="meta">
              <dt>${METRIC_LABEL[r.metric]}</dt><dd>${fmtDb(r.value)} dB(A)</dd>
              <dt>판정 기준</dt><dd>${criterionText(r)}</dd>
              <dt>소리 분포</dt><dd>저음 ${r.zones.low}% · 중음 ${r.zones.mid}% · 고음 ${r.zones.high}%</dd>
              <dt>주요 소리</dt><dd>${fmtHz(r.peakHz)}${r.peakProminence >= TONAL_PROMINENCE ? ' (뚜렷함)' : ''}</dd>
              <dt>위치</dt><dd>${fmtLoc(r.loc)}</dd>
              ${r.memo ? `<dt>메모</dt><dd>${esc(r.memo)}</dd>` : ''}
            </dl>
            ${url ? `<img class="photo" src="${url}" alt="현장 사진">` : ''}
          </div>
        </section>`;
      }).join('')}
      <footer class="report-foot">
        <p>본 결과는 스마트폰 마이크로 측정한 참고값으로, 「소음·진동 공정시험기준」에 따른 법정 측정을 대신하지 않습니다.
        마이크 보정: ${list.every((r) => r.calibrated) ? '모든 측정 보정됨' : '보정 안 된 측정 포함'} · 차량 소음 측정 v${APP_VERSION}</p>
      </footer>
    </article>`;
  view.querySelector('[data-act=print]').onclick = () => window.print();
}

/* ---------- admin settings ---------- */

async function renderSettings() {
  if (!adminUnlocked) {
    view.innerHTML = `
      <a class="back" href="#/">← 처음으로</a>
      <form class="pin-gate" id="pin-form">
        <h1 class="page-title">관리자 설정</h1>
        <p>판정 기준, 마이크 보정, 회사 정보는 관리자만 바꿀 수 있습니다.</p>
        <label class="field"><span>관리자 비밀번호</span>
          <input id="f-pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12"></label>
        <p class="alert" id="pin-error" hidden>비밀번호가 맞지 않습니다.</p>
        <button class="btn btn-primary btn-wide" type="submit">확인</button>
      </form>`;
    view.querySelector('#pin-form').onsubmit = (e) => {
      e.preventDefault();
      if (view.querySelector('#f-pin').value === getSettings().pin) {
        adminUnlocked = true;
        route();
      } else {
        view.querySelector('#pin-error').hidden = false;
      }
    };
    view.querySelector('#f-pin').focus();
    return;
  }

  const s = getSettings();
  const count = (await store.allRecords()).length;
  const num = (id, value, { min, max, step = 1, suffix }) =>
    `<label class="field field-num"><span>${suffix}</span><input id="${id}" type="number" inputmode="decimal" min="${min}" max="${max}" step="${step}" value="${value ?? ''}" required></label>`;

  view.innerHTML = `
    <a class="back" href="#/">← 처음으로</a>
    <h1 class="page-title">관리자 설정</h1>
    <form id="settings-form" class="settings" novalidate>
      <section class="card">
        <h2>회사 정보</h2>
        <label class="field"><span>회사 이름</span><input id="f-company" value="${esc(s.company)}" required></label>
        <label class="field"><span>부서·팀 <small>(보고서에 표시, 선택)</small></span><input id="f-team" value="${esc(s.team)}"></label>
      </section>

      <section class="card">
        <h2>판정 기준</h2>
        <p class="fine">단위는 dB(A)입니다. 처음 값은 예시이니 회사 기준이나 관련 법규에 맞게 바꿔 주세요.</p>
        ${MODES.map((m) => {
          const c = s.modes[m.id];
          return `<fieldset class="mode-fields">
            <legend>${m.name} <small>${m.defaults.limit != null ? `${METRIC_LABEL[m.metric]}으로 판정` : '판정 없음'}</small></legend>
            <div class="num-grid">
              ${m.defaults.limit != null ? num(`f-${m.id}-warn`, c.warn, { min: 20, max: 140, step: 0.5, suffix: '주의 시작' }) + num(`f-${m.id}-limit`, c.limit, { min: 20, max: 140, step: 0.5, suffix: '초과 기준' }) : ''}
              ${num(`f-${m.id}-duration`, c.duration, { min: 3, max: 120, suffix: '측정 시간(초)' })}
              ${num(`f-${m.id}-delay`, c.delay, { min: 0, max: 60, suffix: '시작 전 대기(초)' })}
            </div>
          </fieldset>`;
        }).join('')}
      </section>

      <section class="card" id="cal">
        <h2>마이크 보정</h2>
        <p>현재 보정값 <strong id="cal-offset">${s.offset} dB</strong> · <span id="cal-date">${s.calibratedAt ? `${fmtShortDate(s.calibratedAt)} 보정` : '보정 안 됨'}</span></p>
        <p class="fine">휴대폰마다 마이크 감도가 달라 기기별로 한 번씩 보정해야 값이 맞습니다.</p>
        <ol class="guide guide-small">
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
        <h2>기능</h2>
        <label class="check"><input type="checkbox" id="f-voice" ${s.voice ? 'checked' : ''}> 측정이 끝나면 결과를 소리로 알려 주기</label>
        <label class="check"><input type="checkbox" id="f-location" ${s.location ? 'checked' : ''}> 측정 위치(GPS) 함께 저장</label>
      </section>

      <section class="card">
        <h2>관리자 비밀번호</h2>
        <label class="field"><span>새 비밀번호 <small>(바꿀 때만 입력, 숫자 4자리 이상)</small></span>
          <input id="f-newpin" type="password" inputmode="numeric" autocomplete="new-password" maxlength="12"></label>
      </section>

      <section class="card">
        <h2>데이터</h2>
        <p>이 휴대폰에 저장된 기록 <strong>${count}건</strong>. 기록은 이 휴대폰 안에만 있으니, 정기적으로 엑셀 파일이나 보고서로 보내 두세요.</p>
        <button type="button" class="btn btn-danger-quiet btn-wide" data-act="clear">모든 기록 삭제</button>
      </section>

      <p class="alert" id="settings-error" hidden></p>
      <div class="save-bar"><button class="btn btn-primary btn-wide" type="submit">설정 저장</button></div>
    </form>
    <p class="fine about">차량 소음 측정 v${APP_VERSION}. 스마트폰 측정값은 참고용이며 법정 측정을 대신하지 않습니다.</p>`;

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
      btn.textContent = '측정 중…';
      const r = await calMeter.record(5, ({ elapsed }) => (btn.textContent = `측정 중… ${Math.ceil(5 - elapsed)}초`));
      calPhone = r.leq;
      $('cal-phone').textContent = fmtDb(r.leq);
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
    const val = (id) => parseFloat($(id).value);
    const modes = {};
    for (const m of MODES) {
      const c = { duration: val(`f-${m.id}-duration`), delay: val(`f-${m.id}-delay`), warn: null, limit: null };
      if (m.defaults.limit != null) {
        c.warn = val(`f-${m.id}-warn`);
        c.limit = val(`f-${m.id}-limit`);
        if (![c.warn, c.limit].every((x) => x >= 20 && x <= 140) || c.warn > c.limit) {
          return showError(`${m.name}: 주의 시작은 초과 기준보다 작거나 같아야 하고, 20–140 dB 사이여야 합니다.`);
        }
      }
      if (!(c.duration >= 3 && c.duration <= 120) || !(c.delay >= 0 && c.delay <= 60)) {
        return showError(`${m.name}: 측정 시간은 3–120초, 대기 시간은 0–60초로 입력해 주세요.`);
      }
      modes[m.id] = c;
    }
    const offset = val('f-offset');
    if (!(offset > 0 && offset < 200)) return showError('보정값을 확인해 주세요.');
    const newPin = $('f-newpin').value.trim();
    if (newPin && !/^\d{4,12}$/.test(newPin)) return showError('비밀번호는 숫자 4–12자리로 입력해 주세요.');
    const before = getSettings();
    saveSettings({
      company: $('f-company').value.trim() || before.company,
      team: $('f-team').value.trim(),
      modes,
      offset: round1(offset),
      calibratedAt: offset !== before.offset ? Date.now() : before.calibratedAt,
      voice: $('f-voice').checked,
      location: $('f-location').checked,
      pin: newPin || before.pin,
    });
    err.hidden = true;
    document.getElementById('brand-company').textContent = getSettings().company;
    toast('설정을 저장했습니다');

    function showError(msg) {
      err.textContent = msg;
      err.hidden = false;
      err.scrollIntoView({ block: 'center' });
    }
  };
}

/* ---------- boot ---------- */

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
});
window.addEventListener('hashchange', route);
route();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
