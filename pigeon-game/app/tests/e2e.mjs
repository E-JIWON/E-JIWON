// 출근길 비둘기 게임 e2e 점검 (Playwright + 헤드리스 Chromium, 모바일 터치 에뮬레이션).
// 게임 코드는 보지 않는다. CONTRACT.md 의 디버그 훅(window.__game)과 index.html 의 DOM id만 믿고 계약대로 시험한다.
//
// 실행: npm run build 를 먼저 한 뒤  node tests/e2e.mjs   (또는 npm run e2e)
//   - 이 스크립트가 dist/ 를 node:http 정적 서버(127.0.0.1:4180)로 직접 띄운다. 빌드는 하지 않는다.
//   - 뷰포트 390x844, 터치·모바일 에뮬레이션, 기기 픽셀 비율 1. WebGL은 소프트웨어 GL(swiftshader)이라 20~30fps.
//   - 바깥 네트워크(구글 폰트 등)는 빈 응답으로 막는다(샌드박스 네트워크 실패가 콘솔 오류로 잡히지 않게).
// 결과: tests/out/e2e-report.json(시나리오별 통과/실패와 근거), tests/out/e2e-NN-이름.png(스크린숏), 콘솔 요약 표.
// 종료 코드: 0 = 1~11 전부 통과, 1 = 하나라도 실패(12 perf는 수치만 기록), 2 = 실행 준비 안 됨(dist 없음·포트 사용 중·Playwright 없음).
//
// 환경 변수(선택): E2E_HEADED=1 → 창 띄워 보기, E2E_SLOWMO=ms → 동작 사이 지연.
//
// 시간 기준(게임 코드와 원본 프로토타입 기준):
//   - 입력 판정(잡기 확정 180ms 등)은 실제 시간이고, 기준은 페이지의 pointerdown 핸들러가 실행된 시각이다(매 프레임 검사).
//   - 정 게이지·프리즈·컷신은 프레임 dt(최대 0.05초) 누적 게임 시간이다. 소프트웨어 GL 은 10fps 안팎이라 게임 시간이 실제보다 느리므로,
//     정 들기는 상태의 게임 시계(clock)로 게임 시간을 직접 잰다.
//   - 상태 변화 시각은 게임 프레임 콜백 직후와 입력 핸들러 직후에 읽는다. setInterval 은 이 환경에서 200ms 넘게 밀려 전환 시각이 늦게 찍힌다.

import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(here, '..');
const DIST = path.join(APP, 'dist');
const OUT = path.join(here, 'out');
const REPORT = path.join(OUT, 'e2e-report.json');
const require = createRequire(import.meta.url);

// ───────────────────────────── 수치 ─────────────────────────────
const PORT = 4180;
const HOST = '127.0.0.1';
const VIEW = { width: 390, height: 844 };
const GL_ARGS = ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'];
const REACH_Z = { far: -7.5, near: -3 };          // 시나리오 정의의 '리치 안' z 범위
const AIM_Y = [0.2, 0.08, 0.32];                  // 비둘기 겨냥 높이(월드 y). 계약에 히트 중심 높이가 없어 시도마다 바꿔 본다
const PIG_WAIT_MS = 8000;                         // 비둘기가 없으면 이만큼 기다린다
const PIG_POLL_MS = 200;
const MAX_TRIES = 3;                              // 다른 참사·빗나감으로 끊기면 다시 시도하는 횟수
const ADOPT_TRIES = 4;                            // 정 들기는 3초 넘게 서 있어야 해서 다른 비둘기와 부딪혀 끊기기 쉽다
const SCENARIO_TIMEOUT_MS = 120000;
const WATCHDOG_MS = 15 * 60 * 1000;
const CUT_TAP_AGE_MS = 1000;                      // 컷신 시작 후 이만큼 지나서 탭
const ADOPT_SPEC_MS = 3000;                       // '3초' 정 들기 시나리오
const ADOPT_GRACE_MS = 1500;                      // 소프트웨어 GL에서 게임 시간이 실제보다 느려 실제로 더 기다리는 여유(판정은 게임 시간 3초)
const ADOPT_MAX_MS = 9000;                        // 정 들기 대기 상한(실제 시간)
const PERF_MS = 10000;

const sleepRaw = (ms) => new Promise((r) => setTimeout(r, ms));
const r1 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const r3 = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1000) / 1000 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// ───────────────────────────── 시작 전 점검 ─────────────────────────────
if (!existsSync(path.join(DIST, 'index.html'))) {
  console.log('dist/index.html 이 없습니다. 먼저 npm run build');
  process.exit(2);
}

let chromium;
let pwVersion = '?';
try {
  ({ chromium } = require('playwright'));
  try { pwVersion = require('playwright/package.json').version; } catch { /* 버전 모름 */ }
} catch {
  try { ({ chromium } = await import('playwright')); } catch { /* 아래에서 처리 */ }
}
if (!chromium) {
  console.log('playwright 를 불러올 수 없습니다(전역 설치 또는 NODE_PATH 확인).');
  process.exit(2);
}

// 게임 시간을 재는 데 쓰는 기준 수치(게임 시계 배속 = gameSec/runSec). src/config.ts 에서 읽고, 못 읽으면 게임 시간 계산을 건너뛴다
const CFG_NUM = await (async () => {
  try {
    const t = await readFile(path.join(APP, 'src/config.ts'), 'utf8');
    const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
    return { meters: num(/meters:\s*([\d.]+)/), runSec: num(/runSec:\s*([\d.]+)/), gameSec: num(/gameSec:\s*([\d.]+)/), adoptAt: num(/adoptAt:\s*([\d.]+)/) };
  } catch { return { meters: null, runSec: null, gameSec: null, adoptAt: null }; }
})();

// ───────────────────────────── 정적 서버 ─────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};
const served404 = [];

function startServer() {
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url || '/', `http://${HOST}`);
      let rel = decodeURIComponent(u.pathname);
      if (rel.endsWith('/')) rel += 'index.html';
      let file = path.resolve(DIST, '.' + rel);
      if (file !== DIST && !file.startsWith(DIST + path.sep)) { res.writeHead(403); res.end(); return; }
      let st = await stat(file).catch(() => null);
      if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await stat(file).catch(() => null); }
      if (!st) {
        // 파비콘은 계약 밖이라 빈 응답(브라우저 자동 요청이 오류로 잡히지 않게)
        if (rel === '/favicon.ico') { res.writeHead(204); res.end(); return; }
        served404.push(rel);
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('없음');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (e) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(e));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(PORT, HOST, () => resolve(server));
  });
}

// ───────────────────────────── 페이지 안 관찰기 ─────────────────────────────
// addInitScript 로 게임보다 먼저 심는다. 게임 상태·효과음 기록을 8ms마다 읽어 시간표를 남긴다(게임에 손대지 않음).
function pageProbe() {
  if (window.__e2e) return;
  const E = { sfx: [], tl: [], ev: [], ph: {}, last: null, prevLog: null, frames: null, perfOn: false, fr: [] };
  window.__e2e = E;
  // 마지막 50개만 남는 sfxLog 의 이전·다음 사본에서 새로 붙은 이름만 골라낸다
  const diff = (prev, next) => {
    for (let s = 0; s <= prev.length; s++) {
      const k = prev.length - s;
      if (k > next.length) continue;
      let ok = true;
      for (let i = 0; i < k; i++) if (prev[s + i] !== next[i]) { ok = false; break; }
      if (ok) return next.slice(k);
    }
    return next.slice();
  };
  E.tick = () => {
    const g = window.__game;
    if (!g) return;
    const now = performance.now();
    try {
      const log = Array.from(g.sfxLog || []);
      const added = E.prevLog ? diff(E.prevLog, log) : log;
      for (const n of added) E.sfx.push({ n: String(n), t: now });
      if (E.sfx.length > 4000) E.sfx.splice(0, 1000);
      E.prevLog = log;
    } catch { /* 훅 미완성 */ }
    let s = null;
    try { s = g.state; } catch { /* 훅 미완성 */ }
    if (!s) return;
    // 비둘기별로 위치가 바뀐 시각을 남긴다(상태는 프레임마다만 바뀌므로 바뀐 시각 ≈ 프레임 시각)
    try {
      const seen = {};
      for (const p of s.pigs || []) {
        seen[p.id] = 1;
        const h = E.ph[p.id] || (E.ph[p.id] = []);
        const x = Number(p.x);
        const z = Number(p.z);
        const b = h[h.length - 1];
        if (!b || b.x !== x || b.z !== z) {
          h.push({ t: now, x, z });
          while (h.length > 2 && now - h[0].t > 450) h.shift();
        }
      }
      for (const id of Object.keys(E.ph)) if (!seen[id]) delete E.ph[id];
    } catch { /* 훅 미완성 */ }
    const snap = { phase: s.phase, held: !!s.held, lane: s.lane, combo: s.combo, failKey: s.failKey == null ? null : s.failKey };
    const l = E.last;
    if (!l || l.phase !== snap.phase || l.held !== snap.held || l.lane !== snap.lane || l.combo !== snap.combo || l.failKey !== snap.failKey) {
      E.tl.push({ t: now, ...snap, clock: Number(s.clock) });
      if (E.tl.length > 6000) E.tl.splice(0, 1000);
      E.last = snap;
    }
  };
  setInterval(E.tick, 8);
  // 게임 프레임 콜백이 끝난 직후에도 읽는다(콜백은 그대로 부르고 반환값도 그대로라 게임 동작은 바뀌지 않음).
  // 같은 프레임(같은 ts)의 콜백들 중 마지막이 끝난 시각을 프레임 끝으로 남겨, '몇 번째 프레임 안에' 판정에 쓴다.
  const raf0 = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) => raf0((ts) => {
    try { cb(ts); } finally {
      E.tick();
      const end = performance.now();
      const f = E.fr[E.fr.length - 1];
      if (f && f.ts === ts) f.end = end; else E.fr.push({ ts, end });
      if (E.fr.length > 4000) E.fr.splice(0, 1000);
    }
  });
  // 포인터 이벤트 기록(취소·길게 누름 메뉴 진단용). passive·capture 라 게임 동작에 영향 없음
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'contextmenu', 'touchcancel']) {
    window.addEventListener(type, (e) => {
      const tg = e.target;
      E.ev.push({
        type, t: performance.now(),
        x: typeof e.clientX === 'number' ? Math.round(e.clientX) : null,
        y: typeof e.clientY === 'number' ? Math.round(e.clientY) : null,
        pt: e.pointerType || '', tg: (tg && (tg.id || tg.tagName)) || '',
      });
      if (E.ev.length > 3000) E.ev.splice(0, 1000);
    }, { capture: true, passive: true });
  }
  // 입력 핸들러가 바꾼 상태(차선·일시정지 등)를 바로 읽는다. 버블 단계라 캔버스 핸들러가 끝난 뒤에 불린다
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'keydown', 'click']) {
    window.addEventListener(type, () => E.tick(), { passive: true });
  }
  // 비둘기 id 를 지금 읽고, 최근 속도로 leadMs 뒤 위치를 예측해 뷰포트 좌표로 돌려준다
  E.aim = (id, aimY, leadMs) => {
    E.tick();
    const g = window.__game;
    const now = performance.now();
    const p = (g.state.pigs || []).find((q) => q.id === id);
    if (!p) return null;
    const h = E.ph[id] || [];
    let vx = 0;
    let vz = 0;
    let tLast = now;
    if (h.length >= 2) {
      const a = h[0];
      const b = h[h.length - 1];
      const dt = (b.t - a.t) / 1000;
      // 250ms 넘게 안 바뀌었으면 멈춘 것으로 본다
      if (dt > 0.04 && now - b.t < 250) { vx = (b.x - a.x) / dt; vz = (b.z - a.z) / dt; tLast = b.t; }
    }
    const ahead = (now - tLast + leadMs) / 1000;
    const X = Number(p.x) + vx * ahead;
    const Z = Number(p.z) + vz * ahead;
    const r = g.toScreen(X, aimY + (Number(p.lift) || 0), Z);
    if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) return null;
    const c = document.getElementById('game').getBoundingClientRect();
    return {
      x: c.left + r[0], y: c.top + r[1], xAt: X, zAt: Z, vx, vz, tAim: now, samples: h.length,
      pig: { id: p.id, type: p.type, state: p.state, x: Number(p.x), z: Number(p.z), lift: Number(p.lift) || 0 },
      canvas: { x: c.left, y: c.top, w: c.width, h: c.height },
    };
  };
  E.firstDown = (t) => { const e = E.ev.find((v) => v.type === 'pointerdown' && v.t >= t); return e ? e.t : null; };
  // t 이후에 시작한 첫 프레임(rAF ts >= t)이 끝난 시각. 아직 없으면 null
  E.frameEndAfter = (t) => { const f = E.fr.find((v) => v.ts >= t); return f ? f.end : null; };
  E.perfStart = () => {
    E.frames = [];
    E.perfOn = true;
    const loop = (ts) => { if (!E.perfOn) return; E.frames.push(ts); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  };
  E.perfStop = () => { E.perfOn = false; return E.frames || []; };
}

// ───────────────────────────── 보고서 ─────────────────────────────
const T0 = Date.now();
const report = {
  title: '출근길 비둘기 e2e 점검',
  startedAt: new Date().toISOString(),
  url: `http://${HOST}:${PORT}/`,
  viewport: { ...VIEW, hasTouch: true, isMobile: true, deviceScaleFactor: 1 },
  env: { node: process.version, playwright: pwVersion, chromium: null, glRenderer: null, titleRafMs: null, playRafMs: null, timeScaleAtStart: null, inputLagMs: null, inputLagSamples: null, cfg: null },
  stubbedRequests: [],
  consoleErrors: [],
  pageErrors: [],
  requestFailed: [],
  served404,
  scenarios: [],
  summary: null,
  exitCode: null,
};
const consoleErrors = report.consoleErrors;
const pageErrors = report.pageErrors;

let server = null;
let browser = null;
let page = null;
let cdp = null;
let hookReady = false;
let frameMs = 40;          // 플레이 중 rAF 평균 간격(시작 직후 잰다). 상태는 프레임마다만 바뀌므로 판정 여유로 쓴다
let inputLagMs = null;     // 겨냥(상태 읽기)부터 페이지에 pointerdown 이 도착하기까지 걸린 시간(이동 평균)
let lastTimeScale = null;  // 가장 최근에 잰 게임 시간 비율(게임 초/실제 초)
const lagSamples = [];
let touchDown = false;
let CUR = null;            // 지금 시나리오의 중단 토큰

async function sleep(ms) {
  await sleepRaw(ms);
  if (CUR && CUR.aborted) throw new Error('시나리오 시간 초과로 중단');
}

async function writeReport() {
  try {
    await mkdir(OUT, { recursive: true });
    await writeFile(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');
  } catch (e) {
    console.log(`보고서 저장 실패: ${e.message}`);
  }
}

// 전체가 멈추면 지금까지의 결과라도 남기고 끝낸다
const watchdog = setTimeout(async () => {
  console.log(`전체 감시 시간(${WATCHDOG_MS / 1000}s) 초과 — 지금까지 결과를 저장하고 종료`);
  report.exitCode = 1;
  report.summary = { aborted: true };
  await writeReport();
  process.exit(1);
}, WATCHDOG_MS);
watchdog.unref();

// ───────────────────────────── 페이지 도우미 ─────────────────────────────
async function pnow() { return page.evaluate(() => performance.now()); }

/** 계약 필드만 골라 직렬화한 상태. 훅이 없으면 null. */
async function readState() {
  return page.evaluate(() => {
    const g = window.__game;
    if (!g) return null;
    let s;
    try { s = g.state; } catch { return null; }
    if (!s) return null;
    let mode = null;
    try { mode = g.mode; } catch { /* 없음 */ }
    const pigs = Array.isArray(s.pigs)
      ? s.pigs.map((p) => ({ id: p.id, type: p.type, state: p.state, x: Number(p.x), z: Number(p.z), lift: Number(p.lift) || 0 }))
      : [];
    return {
      t: performance.now(), phase: s.phase, lane: s.lane, combo: s.combo, best: s.best, views: s.views,
      dist: s.dist, clock: s.clock, held: !!s.held, gold: s.gold, failKey: s.failKey == null ? null : s.failKey, pigs, mode,
    };
  }).catch(() => null);
}

async function sfxSince(t0) {
  return page.evaluate((t) => { window.__e2e.tick(); return window.__e2e.sfx.filter((e) => e.t >= t).map((e) => e.n); }, t0).catch(() => []);
}

/** t0 시점 상태 + 그 뒤 변화들 */
async function tlSince(t0) {
  return page.evaluate((t) => {
    const E = window.__e2e;
    E.tick();
    let at = null;
    const after = [];
    for (const e of E.tl) { if (e.t < t) at = e; else after.push(e); }
    return { at, after: after.map((e) => ({ ...e, dt: Math.round(e.t - t) })) };
  }, t0).catch(() => ({ at: null, after: [] }));
}

async function heldEver(t0) {
  const { at, after } = await tlSince(t0);
  return !!(at && at.held) || after.some((e) => e.held);
}

async function pointerEventsSince(t0) {
  return page.evaluate((t) => window.__e2e.ev.filter((e) => e.t >= t).map((e) => ({ ...e, dt: Math.round(e.t - t), t: undefined })), t0).catch(() => []);
}

/** 지금 컷신이면 컷신 시작부터 지난 ms, 아니면 -1 */
async function phaseAge(phase) {
  return page.evaluate((ph) => {
    const E = window.__e2e;
    E.tick();
    if (!E.last || E.last.phase !== ph) return -1;
    let start = null;
    for (let i = E.tl.length - 1; i >= 0; i--) { if (E.tl[i].phase === ph) start = E.tl[i].t; else break; }
    return start == null ? -1 : performance.now() - start;
  }, phase).catch(() => -1);
}

/** 겨냥 앞당김 시간(ms). 잰 값이 없으면 프레임 간격으로 어림 */
function leadMs() { return inputLagMs != null ? inputLagMs : Math.max(40, 2.5 * frameMs); }
function frameGrace() { return Math.min(120, frameMs + 10); }

/** tFrom(페이지 시각) 뒤 첫 pointerdown 시각. 입력 지연 이동 평균도 갱신 */
async function waitPointerDown(tFrom, maxMs = 1500) {
  const end = Date.now() + maxMs;
  for (;;) {
    const t = await page.evaluate((x) => window.__e2e.firstDown(x), tFrom).catch(() => null);
    if (t != null) {
      const lag = t - tFrom;
      lagSamples.push(Math.round(lag));
      inputLagMs = inputLagMs == null ? lag : inputLagMs * 0.5 + lag * 0.5;
      return t;
    }
    if (Date.now() > end) return null;
    await sleep(15);
  }
}

/** 페이지 시각 tPage 가 될 때까지 기다린다 */
async function sleepUntil(tPage) {
  const now = await pnow();
  if (tPage > now) await sleep(tPage - now);
}

/** 게임 시계 배속(게임 시계 초 / 게임 초). 못 읽었으면 null */
const clockRate = () => (CFG_NUM.gameSec && CFG_NUM.runSec ? CFG_NUM.gameSec / CFG_NUM.runSec : null);

/** 플레이 중 게임 시계 증가 속도로 게임 시간 비율(게임 초/실제 초)을 잰다. 못 재면 null */
async function measureTimeScale(ms = 700) {
  if (!clockRate()) return null;
  const a = await readState();
  // 기다리는 동안 rAF 간격도 다시 잰다(장면이 무거워지면 프레임이 길어진다)
  const raf = await measureRaf(64, ms);
  if (CUR && CUR.aborted) throw new Error('시나리오 시간 초과로 중단');
  if (raf) frameMs = Math.min(150, Math.max(16, raf));
  const b = await readState();
  if (!a || !b || a.phase !== 'play' || b.phase !== 'play') return null;
  if (typeof a.clock !== 'number' || typeof b.clock !== 'number' || b.clock < a.clock) return null; // 횡단보도 확정으로 시계가 줄면 버린다
  const ts = ((b.clock - a.clock) / clockRate()) / ((b.t - a.t) / 1000);
  if (!(ts > 0.1 && ts < 1.5)) return null;
  lastTimeScale = ts;
  return ts;
}

async function canvasRect() {
  return page.$eval('#game', (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; }).catch(() => null);
}

async function visible(sel) { return page.isVisible(sel).catch(() => false); }

async function waitFor(fn, ms, step = 50) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() >= end) return null;
    await sleep(step);
  }
}

// ── 터치 입력(CDP) ──
const tp = (x, y) => [{ x: r1(x), y: r1(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
async function tDown(x, y) { touchDown = true; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x, y) }); }
async function tMove(x, y) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(x, y) }); }
async function tUp() { touchDown = false; await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); }
async function tapAt(x, y, ms = 60) {
  await cdp.send('Input.synthesizeTapGesture', { x: r1(x), y: r1(y), duration: ms, tapCount: 1, gestureSourceType: 'touch' });
}
/** 손가락을 대고 일정 간격으로 움직인 뒤 뗀다 */
async function drag(x0, y0, x1, y1, ms, stepMs = 16) {
  const steps = Math.max(2, Math.round(ms / stepMs));
  await tDown(x0, y0);
  for (let i = 1; i <= steps; i++) {
    await sleep(stepMs);
    await tMove(lerp(x0, x1, i / steps), lerp(y0, y1, i / steps));
  }
  await sleep(stepMs);
  await tUp();
}
async function tapCanvasCenter() {
  const c = await canvasRect();
  if (!c) return;
  await tapAt(c.x + c.w / 2, c.y + c.h / 2, 60);
}

async function shot(name) {
  const file = path.join(OUT, `${name}.png`);
  try { await page.screenshot({ path: file, timeout: 15000 }); return path.relative(APP, file); } catch { return null; }
}

// ── 상태 복구 ──
/** 컷신이면 (1초 넘게 지난 뒤) 탭해서 재시작 */
async function restartFromCut(notes) {
  const age = await phaseAge('cut');
  if (age < 0) return false;
  if (age < CUT_TAP_AGE_MS + 100) await sleep(CUT_TAP_AGE_MS + 100 - age);
  await tapCanvasCenter();
  notes.push('컷신 탭 → 재시작');
  const ok = await waitFor(async () => { const s = await readState(); return s && s.phase !== 'cut'; }, 1500, 80);
  return !!ok;
}

/** 직접 플레이(phase 'play', mode 'play') 상태로 맞춘다 */
async function ensurePlay(notes = [], maxMs = 15000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const s = await readState();
    if (!s) { await sleep(200); continue; }
    if (s.phase === 'play' && s.mode !== 'auto') return { ok: true, notes };
    if (s.phase === 'title') {
      if (await visible('#btnStart')) { await page.tap('#btnStart', { timeout: 3000 }).catch(() => {}); notes.push('타이틀 → #btnStart 탭'); }
      else { await page.evaluate(() => window.__game.start('play')).catch(() => {}); notes.push('__game.start("play")'); }
      await sleep(500);
      continue;
    }
    if (s.phase === 'paused') {
      if (await visible('#btnResume')) { await page.click('#btnResume', { timeout: 3000 }).catch(() => {}); notes.push('일시정지 → #btnResume'); }
      await sleep(300);
      continue;
    }
    if (s.phase === 'freeze') { await sleep(120); continue; }
    if (s.phase === 'cut') { await restartFromCut(notes); continue; }
    if (s.phase === 'play' && s.mode === 'auto') {
      await page.evaluate(() => window.__game.start('play')).catch(() => {});
      notes.push('자동 데모 → __game.start("play")');
      await sleep(400);
      continue;
    }
    await sleep(150);
  }
  return { ok: false, notes };
}

/** 조건에 맞는 비둘기를 (최대 8초, 0.2초 간격) 기다려 찾고, 터치가 닿을 때의 위치를 예측해 화면 좌표를 돌려준다 */
async function acquirePig(pred, aimY, notes) {
  let end = Date.now() + PIG_WAIT_MS;
  while (Date.now() < end) {
    const s = await readState();
    if (!s) { await sleep(PIG_POLL_MS); continue; }
    if (s.phase !== 'play') {
      const t = Date.now();
      notes.push(`비둘기 대기 중 phase=${s.phase}${s.failKey ? `(${s.failKey})` : ''}`);
      await ensurePlay(notes);
      end += Date.now() - t; // 재시작에 쓴 시간은 대기 시간에서 빼 준다
      continue;
    }
    // 입력 지연 동안 더 다가오므로 조금 먼 비둘기까지 후보로 보고, 예측 위치로 리치 안인지 다시 거른다
    const cands = s.pigs.filter((p) => pred(p) && p.z >= REACH_Z.far - 1.5 && p.z <= REACH_Z.near);
    cands.sort((a, b) => (a.type === 'gugu' ? 0 : 1) - (b.type === 'gugu' ? 0 : 1) || Math.abs(a.z + 6.3) - Math.abs(b.z + 6.3));
    for (const c of cands.slice(0, 3)) {
      const aim = await aimPoint(c.id, aimY);
      if (!aim || !pred(aim.pig)) continue;
      // 리치 가까운 끝(-3) 바로 앞은 누르고 있는 사이 리치를 벗어나므로 여유(-3.8)를 둔다
      if (aim.zAt < REACH_Z.far || aim.zAt > REACH_Z.near - 0.8) continue;
      const cv = aim.canvas;
      // 터치 지점이 HUD 띠·하단 패드·좌우 16px 무시 구역이면 고르지 않는다
      const okSpot = aim.y > cv.y + cv.h * 0.13 && aim.y < cv.y + cv.h * 0.83 && aim.x > cv.x + 20 && aim.x < cv.x + cv.w - 20;
      if (!okSpot) { notes.push(`겨냥점이 판정 구역 밖(${r1(aim.x)},${r1(aim.y)}) → 다음 후보`); continue; }
      return { ...aim, aimY, lead: Math.round(leadMs()), lane: s.lane, combo: s.combo };
    }
    await sleep(PIG_POLL_MS);
  }
  return null;
}

/** 비둘기 위치를 지금 읽어 입력 지연만큼 뒤의 위치를 예측하고 화면(뷰포트) 좌표로 바꾼다 */
async function aimPoint(id, aimY) {
  return page.evaluate(([pid, ay, lead]) => window.__e2e.aim(pid, ay, lead), [id, aimY, leadMs()]).catch(() => null);
}

/** 겨냥 결과를 보고서용으로 줄인다 */
function targetInfo(f) {
  return { ...f.pig, px: r1(f.x), py: r1(f.y), zAt: r3(f.zAt), vx: r3(f.vx), vz: r3(f.vz), leadMs: f.lead, aimY: f.aimY };
}

/**
 * 손가락을 댄 뒤 held 확정 시각을 페이지 안 시간표로 잰다. 기준은 페이지의 pointerdown 핸들러가 실행된 시각.
 * 판정(시나리오 정의 '250ms(+1프레임)'): pointerdown 250ms 뒤 이후에 시작한 첫 게임 프레임이 끝날 때까지 held=true.
 * 프레임 간격 평균이 아니라 실제 프레임 시각으로 본다(프레임이 한 번 길게 늘어져도 기준은 그대로).
 * 상태 읽기 왕복 자체가 바쁜 메인 스레드에서 100ms 가까이 걸려, 읽은 시점이 아니라 시간표로 판정한다.
 */
async function heldAfter250(tAim, A) {
  const tPd = await waitPointerDown(tAim);
  A.inputLagMs = tPd == null ? null : Math.round(tPd - tAim);
  const base = tPd == null ? await pnow() : tPd;
  await sleepUntil(base + 250);
  // 250ms 뒤 첫 프레임이 끝나기를 기다린다(소프트웨어 GL 은 프레임이 100~200ms 걸릴 수 있어 넉넉히 1.5초)
  const frameEnd = await waitFor(() => page.evaluate((t) => window.__e2e.frameEndAfter(t), base + 250).catch(() => null), 1500, 30);
  const tl = await tlSince(base);
  const e = tl.after.find((v) => v.held);
  const heldByMs = e ? Math.round(e.t - base) : null;
  const limit = frameEnd == null ? null : Math.round(frameEnd - base);
  const held = heldByMs != null && limit != null && e.t <= frameEnd + 0.5;
  Object.assign(A, { heldByMs, heldLimitMs: limit });
  return { held, heldByMs, limit, tPd };
}

const isWalkType = (types) => (p) => p.state === 'walk' && types.includes(p.type);

/** 시도 구간 동안 다른 참사나 콤보 감소(횡단보도 확정 등)로 판정이 흐려졌는지 */
function interruption(tl, expectFail = null) {
  for (const e of tl.after) {
    if ((e.phase === 'freeze' || e.phase === 'cut') && e.failKey !== expectFail) return `참사(${e.failKey ?? '?'}) 발생`;
  }
  let prev = tl.at ? tl.at.combo : null;
  for (const e of tl.after) {
    if (prev != null && typeof e.combo === 'number' && e.combo < prev) return `콤보 감소 ${prev}→${e.combo}`;
    prev = e.combo;
  }
  return null;
}

/** 비둘기를 잡고 손가락을 멈춘다. 참사가 나거나 budgetMs 가 되면 뗀다. 시나리오 7·컷신 만들기에서 같이 쓴다 */
async function grabAndHoldStill(A, budgetMs) {
  const found = await acquirePig(isWalkType(['gugu', 'follow', 'fat']), A.aimY, A.notes);
  if (!found) { A.note = `${PIG_WAIT_MS / 1000}초 안에 리치 안 비둘기 없음`; return { status: 'noPig' }; }
  A.target = targetInfo(found);
  await tDown(found.x, found.y);
  const { held, tPd } = await heldAfter250(found.tAim, A);
  if (!held) {
    await sleep(80);
    await tUp();
    A.sfx = await sfxSince(found.tAim);
    A.note = `pointerdown 250ms 뒤 첫 프레임(${A.heldLimitMs}ms)까지 held=false (확정 ${A.heldByMs ?? '없음'}ms)`;
    return { status: 'noHold', t0: found.tAim };
  }
  // 이제부터 손가락은 그대로. pointerdown 기준 실제 시간으로 잰다
  const wall0 = Date.now() - Math.max(0, (await pnow()) - tPd);
  let heartSeen = false;
  let failState = null;
  while (Date.now() - wall0 < budgetMs) {
    await sleep(100);
    const s = await readState();
    if (!heartSeen && Date.now() - wall0 > 1000) heartSeen = await visible('#heart');
    if (s && (s.phase === 'freeze' || s.phase === 'cut')) { failState = s; break; }
  }
  const releaseT = await pnow();
  await tUp();
  let failAt = null;
  if (failState) {
    const tl = await tlSince(tPd);
    const e = tl.after.find((v) => v.phase === 'freeze' || v.phase === 'cut');
    failAt = e ? Math.round(e.t - tPd) : Date.now() - wall0;
  }
  A.heartSeen = heartSeen;
  A.failAtMs = failAt;
  // 들고 있던 동안의 게임 시간: held 확정 프레임과 참사 프레임의 게임 시계 차이
  let heldGameSec = null;
  if (failState && clockRate()) {
    const tl = await tlSince(tPd);
    const h = tl.after.find((v) => v.held);
    const f = tl.after.find((v) => v.phase === 'freeze' || v.phase === 'cut');
    if (h && f && f.clock >= h.clock) heldGameSec = (f.clock - h.clock) / clockRate();
  }
  A.heldGameSec = heldGameSec == null ? null : r3(heldGameSec);
  return { status: failState ? 'fail' : 'noFail', t0: found.tAim, tPd, releaseT, failAt, failState, heldGameSec };
}

/** 컷신 상태를 만든다: 정 들기(adopt) → 빈 곳 헛박수 3번 → 그냥 기다려 충돌 */
async function makeCut(notes) {
  const s0 = await readState();
  if (s0 && (s0.phase === 'cut' || s0.phase === 'freeze')) {
    await waitFor(async () => (await readState())?.phase === 'cut', 2000, 60);
    return 'already';
  }
  await ensurePlay(notes);
  const A = { aimY: AIM_Y[0], notes };
  const r = await grabAndHoldStill(A, ADOPT_MAX_MS);
  if (r.status === 'fail') {
    await waitFor(async () => (await readState())?.phase === 'cut', 2500, 60);
    return `잡고 멈춤(${r.failState.failKey})`;
  }
  // 빈 하늘 쪽 헛박수 3연속('claps')
  const c = await canvasRect();
  await ensurePlay(notes);
  for (let i = 0; i < 3; i++) { await tapAt(c.x + c.w * 0.5, c.y + c.h * 0.2, 60); await sleep(320); }
  if (await waitFor(async () => { const s = await readState(); return s && (s.phase === 'freeze' || s.phase === 'cut'); }, 1500, 60)) {
    await waitFor(async () => (await readState())?.phase === 'cut', 2500, 60);
    return 'claps';
  }
  // 마지막 수단: 가만히 서서 부딪히기를 기다린다
  if (await waitFor(async () => { const s = await readState(); return s && s.phase === 'cut'; }, 25000, 200)) return 'natural';
  return null;
}

// ───────────────────────────── 시나리오 실행 틀 ─────────────────────────────
function finish(sc, pass, reason, evidence = {}) {
  sc.pass = pass;
  sc.reason = reason;
  Object.assign(sc.evidence, evidence);
}

async function scenario(id, key, title, fn, { infoOnly = false, needHook = true } = {}) {
  const sc = { id, key, title, pass: false, infoOnly, reason: '', evidence: {}, attempts: [], warnings: [], screenshot: null, ms: 0 };
  report.scenarios.push(sc);
  const started = Date.now();
  if (needHook && !hookReady) {
    sc.pass = infoOnly ? null : false;
    sc.reason = '디버그 훅 window.__game 이 없어 실행하지 못함';
    sc.screenshot = page ? await shot(`e2e-${String(id).padStart(2, '0')}-${key}`) : null;
    printLine(sc);
    return sc;
  }
  const token = { aborted: false };
  CUR = token;
  const run = fn(sc);
  let timer = null;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve('timeout'), SCENARIO_TIMEOUT_MS); });
  try {
    const r = await Promise.race([run.then(() => 'done'), timeout]);
    if (r === 'timeout') {
      token.aborted = true;
      await Promise.race([run.catch(() => {}), sleepRaw(15000)]);
      sc.pass = infoOnly ? null : false;
      sc.reason = `시간 초과(${SCENARIO_TIMEOUT_MS / 1000}s)`;
    }
  } catch (e) {
    sc.pass = infoOnly ? null : false;
    sc.reason = `예외: ${String(e && e.message ? e.message : e).slice(0, 300)}`;
  } finally {
    clearTimeout(timer);
    CUR = null;
  }
  if (touchDown) await tUp().catch(() => {});
  if (infoOnly && sc.pass === false) sc.pass = null;
  sc.screenshot = await shot(`e2e-${String(id).padStart(2, '0')}-${key}`);
  sc.ms = Date.now() - started;
  printLine(sc);
  await writeReport();
  return sc;
}

function verdict(sc) { return sc.pass === true ? '통과' : sc.pass === false ? '실패' : '기록'; }
function printLine(sc) { console.log(`  [${verdict(sc)}] ${sc.id}. ${sc.key} — ${sc.reason}`); }

// ───────────────────────────── 시나리오 ─────────────────────────────
/** rAF 간격 평균(ms). n 프레임 또는 maxMs 동안 */
async function measureRaf(n = 16, maxMs = 1500) {
  const ts = await page.evaluate(([cnt, lim]) => new Promise((res) => {
    const out = [];
    const t0 = performance.now();
    const loop = (t) => { out.push(t); if (out.length < cnt && t - t0 < lim) requestAnimationFrame(loop); else res(out); };
    requestAnimationFrame(loop);
  }), [n, maxMs]).catch(() => []);
  return ts.length > 2 ? (ts[ts.length - 1] - ts[0]) / (ts.length - 1) : null;
}

async function scBoot(sc) {
  const ok = await page.waitForFunction(() => {
    const g = window.__game;
    try { return !!(g && g.state && typeof g.state.phase === 'string'); } catch { return false; }
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  hookReady = ok;
  await sleepRaw(1200); // 부팅 직후 늦게 나는 오류까지 모은다
  const noGl = await visible('#noGl');
  if (!ok) {
    finish(sc, false, `15초 안에 window.__game.state 가 생기지 않음${noGl ? ' (#noGl 표시됨: WebGL 실패)' : ''}`,
      { noGl, consoleErrors: consoleErrors.length, pageErrors: pageErrors.length });
    return;
  }
  const titleRaf = await measureRaf(30, 2000);
  report.env.titleRafMs = r1(titleRaf);
  const s = await readState();
  const titleShown = await visible('#title');
  const ts = await page.evaluate(() => { try { const r = window.__game.toScreen(0, 0, -5); return Array.isArray(r) ? r.map(Number) : r; } catch (e) { return String(e); } }).catch(() => null);
  const errs = consoleErrors.length + pageErrors.length;
  const pass = errs === 0 && titleShown && s && s.phase === 'title';
  const why = [];
  if (errs) why.push(`콘솔 오류 ${consoleErrors.length}·페이지 오류 ${pageErrors.length}`);
  if (!titleShown) why.push('#title 안 보임');
  if (!s || s.phase !== 'title') why.push(`phase=${s && s.phase}`);
  if (noGl) why.push('#noGl 표시됨');
  finish(sc, !!pass, pass ? `오류 0, #title 보임, phase=title (mode=${s.mode})` : why.join(', '), {
    phase: s && s.phase, mode: s && s.mode, titleShown, noGl, consoleErrors: consoleErrors.slice(0, 10), pageErrors: pageErrors.slice(0, 10),
    toScreen_0_0_m5: ts, titleRafMs: r1(titleRaf), served404: served404.slice(),
  });
}

async function scStart(sc) {
  const s0 = await readState();
  if (!s0 || s0.phase !== 'title') sc.warnings.push(`시작 전 phase=${s0 && s0.phase}`);
  const t0 = await pnow();
  const tapped = await page.tap('#btnStart', { timeout: 5000 }).then(() => true).catch((e) => String(e.message).slice(0, 200));
  const s = await waitFor(async () => { const v = await readState(); return v && v.phase === 'play' ? v : null; }, 3000, 80);
  await sleep(300);
  const titleHidden = !(await visible('#title'));
  const sfx = await sfxSince(t0);
  const pass = !!s && titleHidden && sfx.includes('start');
  const why = [];
  if (tapped !== true) why.push(`탭 실패: ${tapped}`);
  if (!s) why.push(`3초 안에 phase=play 아님(지금 ${(await readState())?.phase})`);
  if (!titleHidden) why.push('#title 여전히 보임');
  if (!sfx.includes('start')) why.push(`sfxLog에 start 없음 [${sfx.join(',')}]`);
  finish(sc, pass, pass ? `phase=play, #title 숨김, sfx [${sfx.join(',')}]` : why.join(', '), {
    phase: s && s.phase, mode: s && s.mode, titleHidden, sfx,
  });
  // 플레이 중 프레임 간격·게임 시간 비율을 재 둔다(이후 판정 여유·겨냥 앞당김의 기준)
  if (s) {
    const raf = await measureRaf(16, 1500);
    if (raf) frameMs = Math.min(150, Math.max(16, raf));
    report.env.playRafMs = r1(frameMs);
    report.env.timeScaleAtStart = r3(await measureTimeScale());
  }
}

async function scSwipe(sc) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const A = { attempt, notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    const c = await canvasRect();
    const cx = c.x + c.w * 0.5;
    const py = c.y + c.h * 0.9;
    let s = await readState();
    if (s.lane <= -1) {
      // 이미 왼쪽 끝이면 먼저 오른쪽으로 한 칸
      await drag(cx, py, cx + 80, py, 140);
      await waitFor(async () => (await readState())?.lane > s.lane, 1000, 50);
      A.notes.push('왼쪽 끝이라 먼저 오른쪽 스와이프');
      s = await readState();
    }
    const before = s.lane;
    const t0 = await pnow();
    await drag(cx, py, cx - 80, py, 140);
    await waitPointerDown(t0, 800); // 입력 지연 첫 측정
    const after = await waitFor(async () => { const v = await readState(); return v && v.lane < before ? v : null; }, 1000, 50);
    const tl = await tlSince(t0);
    const sfx = await sfxSince(t0);
    const intr = interruption(tl);
    Object.assign(A, { laneBefore: before, laneAfter: after ? after.lane : (await readState())?.lane, sfx, interruption: intr });
    if (!after && intr) { A.note = `중단: ${intr}`; continue; }
    finish(sc, !!after, after ? `lane ${before} → ${after.lane} (패드 90% 높이에서 왼쪽 80px, sfx [${sfx.join(',')}])` : `lane 그대로 ${before} → ${A.laneAfter}`, {
      laneBefore: before, laneAfter: A.laneAfter, start: [r1(cx), r1(py)], sfx,
    });
    return;
  }
  finish(sc, false, `${MAX_TRIES}회 시도 모두 중단·준비 실패`);
}

async function scGrabPark(sc) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const A = { attempt, aimY: AIM_Y[(attempt - 1) % AIM_Y.length], notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    A.timeScale = r3(await measureTimeScale(500));
    const found = await acquirePig(isWalkType(['gugu']), A.aimY, A.notes);
    if (!found) { A.note = `${PIG_WAIT_MS / 1000}초 안에 리치 안 구구 없음`; continue; }
    A.target = targetInfo(found);
    const t0 = found.tAim;
    const comboBefore = found.combo;
    await tDown(found.x, found.y);
    const { held } = await heldAfter250(t0, A);
    if (!held) {
      await sleep(80);
      await tUp();
      A.sfx = await sfxSince(t0);
      A.pointer = await pointerEventsSince(t0);
      A.note = `pointerdown 250ms 뒤 첫 프레임(${A.heldLimitMs}ms)까지 held=false (확정 ${A.heldByMs ?? '없음'}ms) → 겨냥 높이 바꿔 재시도`;
      const intr = interruption(await tlSince(t0));
      if (intr) A.note = `중단: ${intr}`;
      continue;
    }
    // 화면 오른쪽 가장자리(폭 96%)로 천천히(약 0.4px/ms) 이동
    const cv = found.canvas;
    const tx = cv.x + cv.w * 0.96;
    const ty = found.y;
    const steps = Math.max(12, Math.ceil(Math.abs(tx - found.x) / 10));
    for (let i = 1; i <= steps; i++) {
      await tMove(lerp(found.x, tx, i / steps), lerp(found.y, ty, i / steps));
      await sleep(25);
    }
    await sleep(60);
    const heldAtEdge = (await readState())?.held === true;
    await tUp();
    await waitFor(async () => { const v = await readState(); return v && v.combo - comboBefore >= 2; }, 2500, 60);
    await sleep(500); // 착지 소리(park)는 내려앉은 뒤에 난다
    const s2 = await readState();
    const sfx = await sfxSince(t0);
    const tl = await tlSince(t0);
    const intr = interruption(tl);
    const delta = s2.combo - comboBefore;
    const maxCombo = Math.max(comboBefore, ...tl.after.map((e) => (typeof e.combo === 'number' ? e.combo : -Infinity)));
    Object.assign(A, { heldAtEdge, comboBefore, comboAfter: s2.combo, comboDelta: delta, maxComboDelta: maxCombo - comboBefore, sfx, interruption: intr });
    if (intr) { A.note = `중단: ${intr}`; continue; }
    const hasGrab = sfx.includes('grab');
    const hasLand = sfx.includes('park') || sfx.includes('drop');
    const pass = delta === 2 && hasGrab && hasLand;
    const why = [];
    if (delta !== 2) why.push(`콤보 ${comboBefore}→${s2.combo} (+${delta}, 기대 +2)`);
    if (!hasGrab) why.push('sfx에 grab 없음');
    if (!hasLand) why.push('sfx에 park/drop 없음');
    // 근거용: 화단 착지음(park)이 늦게라도 나는지 조금 더 본다(판정에는 안 씀)
    let parkSeen = sfx.includes('park');
    if (pass && !parkSeen) parkSeen = !!(await waitFor(async () => (await sfxSince(t0)).includes('park'), 2000, 100));
    const sfxAll = await sfxSince(t0);
    finish(sc, pass, pass
      ? `held 확정 ${A.heldByMs}ms(기준 ${A.heldLimitMs}ms 안), 콤보 +2, sfx [${sfxAll.join(',')}] (시도 ${attempt})`
      : `${why.join(', ')}; sfx [${sfx.join(',')}]`, {
      target: A.target, inputLagMs: A.inputLagMs, heldByMs: A.heldByMs, heldLimitMs: A.heldLimitMs, timeScale: r3(lastTimeScale), heldAtEdge,
      comboBefore, comboAfter: s2.combo, sfx: sfxAll, parkSeen, timeline: tl.after.slice(0, 30),
    });
    if (pass && !parkSeen) sc.warnings.push('화단(콤보 +2)으로 갔는데 sfxLog에 park 없음(drop만) — 계약의 park(화단 착지 띵) 호출 지점 확인 필요');
    return;
  }
  const last = sc.attempts[sc.attempts.length - 1] || {};
  finish(sc, false, `${MAX_TRIES}회 시도 모두 실패(마지막: ${last.note || '?'})`);
}

async function scTapClap(sc) {
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const A = { attempt, aimY: AIM_Y[(attempt - 1) % AIM_Y.length], notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    const found = await acquirePig(isWalkType(['gugu']), A.aimY, A.notes);
    if (!found) { A.note = `${PIG_WAIT_MS / 1000}초 안에 리치 안 구구 없음`; continue; }
    A.target = targetInfo(found);
    const t0 = found.tAim;
    const comboBefore = found.combo;
    const x0 = found.pig.x;
    await tapAt(found.x, found.y, 60);
    const tPd = await waitPointerDown(t0);
    A.inputLagMs = tPd == null ? null : Math.round(tPd - t0);
    // 300ms 간격으로 그 비둘기 x 변화를 본다(지나쳐 사라지기 전까지)
    let maxDx = 0;
    let seen = 0;
    for (let i = 0; i < 4; i++) {
      await sleep(300);
      const s = await readState();
      const p = s && s.pigs.find((q) => q.id === found.pig.id);
      if (p) { seen++; maxDx = Math.max(maxDx, Math.abs(p.x - x0)); }
    }
    const s2 = await readState();
    const sfx = await sfxSince(t0);
    const tl = await tlSince(t0);
    const everHeld = !!(tl.at && tl.at.held) || tl.after.some((e) => e.held);
    const intr = interruption(tl);
    const delta = s2.combo - comboBefore;
    Object.assign(A, { everHeld, comboBefore, comboAfter: s2.combo, comboDelta: delta, maxDx: r3(maxDx), samples: seen, sfx, interruption: intr });
    if (intr) { A.note = `중단: ${intr}`; continue; }
    if (!sfx.includes('clap') && sfx.includes('clapMiss')) { A.note = '헛박수(clapMiss) → 겨냥 높이 바꿔 재시도'; continue; }
    const moved = delta === 1 || maxDx >= 0.4;
    const pass = !everHeld && moved && sfx.includes('clap');
    const why = [];
    if (everHeld) why.push('held가 true가 된 적 있음');
    if (!moved) why.push(`콤보 +${delta}, x 변화 ${r3(maxDx)}`);
    if (!sfx.includes('clap')) why.push('sfx에 clap 없음');
    finish(sc, pass, pass ? `held 없음, 콤보 +${delta}, x 변화 ${r3(maxDx)}, sfx [${sfx.join(',')}] (시도 ${attempt})` : `${why.join(', ')}; sfx [${sfx.join(',')}]`, {
      target: A.target, inputLagMs: A.inputLagMs, everHeld, comboBefore, comboAfter: s2.combo, maxDx: r3(maxDx), sfx,
    });
    return;
  }
  const last = sc.attempts[sc.attempts.length - 1] || {};
  finish(sc, false, `${MAX_TRIES}회 시도 모두 실패(마지막: ${last.note || '?'})`);
}

async function scPadNoGrab(sc) {
  const notes = [];
  const pr = await ensurePlay(notes);
  if (!pr.ok) { finish(sc, false, '플레이 상태로 못 돌아감', { notes }); return; }
  const c = await canvasRect();
  const py = c.y + c.h * 0.9;
  // 패드 근처에 비둘기가 그려져 있으면 그 x에 누른다(그래도 잡히면 안 됨)
  const near = await page.evaluate(([padTop]) => {
    const g = window.__game;
    const cv = document.getElementById('game').getBoundingClientRect();
    let best = null;
    for (const p of g.state.pigs || []) {
      const r = g.toScreen(p.x, 0.2, p.z);
      if (!r || !Number.isFinite(r[0]) || !Number.isFinite(r[1])) continue;
      if (r[1] > padTop * cv.height && r[1] < cv.height && r[0] > 24 && r[0] < cv.width - 24 && (!best || r[1] > best.y)) best = { x: r[0] + cv.left, y: r[1] + cv.top, id: p.id, type: p.type };
    }
    return best;
  }, [0.8]).catch(() => null);
  const px = near && near.type !== 'live' ? near.x : c.x + c.w * 0.5;
  const t0 = await pnow();
  await tDown(px, py);
  const tPd = await waitPointerDown(t0);
  if (tPd != null) await sleepUntil(tPd + 250 + frameGrace()); else await sleep(250 + frameGrace());
  const heldNow = (await readState())?.held === true;
  const ever = await heldEver(t0);
  await tUp();
  await sleep(150);
  const sfx = await sfxSince(t0);
  const pass = !heldNow && !ever;
  finish(sc, pass, pass ? `패드(90%) 누르고 250ms → held=false${near ? ` (근처 비둘기 ${near.type} 위)` : ''}` : 'held=true 됨(패드에서 잡힘)', {
    touch: [r1(px), r1(py)], pigNearPad: near, heldNow, heldEver: ever, pointerDownSeen: tPd != null, sfx,
  });
}

async function scAdopt(sc) {
  for (let attempt = 1; attempt <= ADOPT_TRIES; attempt++) {
    const A = { attempt, aimY: AIM_Y[(attempt - 1) % AIM_Y.length], notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    // 게임 시간이 실제보다 느리면(소프트웨어 GL) 그만큼 더 기다린다
    const ts = await measureTimeScale(600);
    const budget = Math.round(Math.min(ADOPT_MAX_MS, Math.max(ADOPT_SPEC_MS + ADOPT_GRACE_MS, ADOPT_SPEC_MS / (ts || 1) + ADOPT_GRACE_MS)));
    Object.assign(A, { timeScale: r3(ts), budgetMs: budget });
    const r = await grabAndHoldStill(A, budget);
    if (r.status === 'noPig' || r.status === 'noHold') continue;
    const tl = await tlSince(r.t0);
    A.timeline = tl.after.slice(0, 20);
    A.pointer = await pointerEventsSince(r.t0);
    // 손 떼기 전에 held가 true였다가 false로 풀렸는지(포인터 취소 등)
    const beforeRelease = tl.after.filter((e) => e.t < r.releaseT);
    const firstHeld = beforeRelease.findIndex((e) => e.held);
    const heldDropped = firstHeld >= 0 && beforeRelease.slice(firstHeld + 1).some((e) => !e.held && e.phase === 'play');
    if (r.status === 'noFail') {
      finish(sc, false, `${budget}ms 동안 멈춰 있었는데 참사 없음${heldDropped ? ' (중간에 held=false로 풀림 — 포인터 취소·길게 누름 메뉴 의심)' : ''}`, {
        target: A.target, timeScale: A.timeScale, budgetMs: budget, heartSeen: A.heartSeen, heldDropped, timeline: A.timeline, pointer: A.pointer.slice(0, 20),
      });
      return;
    }
    const fk = r.failState.failKey;
    if (fk !== 'adopt') { A.note = `다른 참사(${fk}) → 재시도`; continue; }
    if (r.heldGameSec == null) { A.note = '게임 시계로 게임 시간을 못 잼(횡단보도 확정 등으로 시계가 줄었음) → 재시도'; continue; }
    const gameMs = Math.round(r.heldGameSec * 1000);
    // 판정: 손가락을 멈추고 게임 시간 3초 안에 adopt(소프트웨어 GL 은 게임 시간이 실제보다 느려 실제 시간은 더 걸린다)
    const inTime = gameMs <= ADOPT_SPEC_MS;
    if (r.failAt > ADOPT_SPEC_MS) sc.warnings.push(`adopt까지 실제 ${r.failAt}ms, 게임 시간 ${gameMs}ms(프레임 dt 상한 0.05초 때문에 게임 시간이 실제보다 느림)`);
    finish(sc, inTime, inTime
      ? `손가락 멈춤 게임 시간 ${gameMs}ms(실제 ${r.failAt}ms) 뒤 phase=${r.failState.phase}, failKey=adopt${A.heartSeen ? ', 하트 표시 확인' : ''}`
      : `adopt까지 게임 시간 ${gameMs}ms(3초 초과)`, {
      target: A.target, inputLagMs: A.inputLagMs, failAtMs: r.failAt, heldGameMs: gameMs, timeScale: A.timeScale, budgetMs: budget,
      phase: r.failState.phase, failKey: fk, heartSeen: A.heartSeen, timeline: A.timeline,
    });
    // 컷신까지 기다려 둔다(다음 시나리오가 컷신에서 시작)
    await waitFor(async () => (await readState())?.phase === 'cut', 2500, 60);
    return;
  }
  const last = sc.attempts[sc.attempts.length - 1] || {};
  finish(sc, false, `${ADOPT_TRIES}회 시도 모두 실패(마지막: ${last.note || '?'})`);
}

async function scCutRestart(sc) {
  const notes = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    const A = { attempt, notes };
    sc.attempts.push(A);
    let s = await readState();
    if (!s || s.phase !== 'cut') {
      const how = await makeCut(notes);
      A.madeCutBy = how;
      if (!how) { A.note = '컷신을 만들지 못함'; continue; }
    } else A.madeCutBy = '앞 시나리오(adopt)';
    let age = await phaseAge('cut');
    if (age < 0) { A.note = '컷신 상태가 아님'; continue; }
    if (age > CUT_TAP_AGE_MS + 1200) { A.note = `컷신이 이미 ${Math.round(age)}ms 지남 → 새로 만들기`; await ensurePlay(notes); continue; }
    if (age < CUT_TAP_AGE_MS) await sleep(CUT_TAP_AGE_MS - age);
    age = await phaseAge('cut');
    const failKey = (await readState())?.failKey;
    const t0 = await pnow();
    await tapCanvasCenter();
    const s2 = await waitFor(async () => { const v = await readState(); return v && v.phase === 'play' ? v : null; }, 1500, 50);
    const tl = await tlSince(t0);
    const playAt = tl.after.find((e) => e.phase === 'play');
    s = s2 || (await readState());
    const pass = !!s2 && s2.combo === 0;
    finish(sc, pass, pass
      ? `컷신 ${Math.round(age)}ms 뒤 탭 → ${playAt ? playAt.dt : '?'}ms 만에 phase=play, combo=0 (참사 ${failKey})`
      : (!s2 ? `탭 뒤 1.5초 안에 play로 안 돌아감(phase=${s && s.phase})` : `재시작했지만 combo=${s2.combo}`), {
      cutAgeAtTapMs: Math.round(age), restartMs: playAt ? playAt.dt : null, combo: s && s.combo, phase: s && s.phase, failKey, madeCutBy: A.madeCutBy, notes,
    });
    return;
  }
  finish(sc, false, '컷신을 만들거나 맞추지 못함', { notes });
}

async function scPause(sc) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const A = { attempt, notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    const t0 = await pnow();
    const clicked = await page.click('#btnPause', { timeout: 3000 }).then(() => true).catch((e) => String(e.message).slice(0, 160));
    const paused = await waitFor(async () => {
      const s = await readState();
      if (s && s.phase === 'paused') return 'phase';
      if (await visible('#pause')) return '#pause';
      return null;
    }, 1000, 50);
    const intr = interruption(await tlSince(t0));
    if (!paused && intr) { A.note = `중단: ${intr}`; continue; }
    // 일시정지 중 루프가 멈췄는지(근거만)
    const d1 = (await readState())?.dist;
    await sleep(600);
    const d2 = (await readState())?.dist;
    const phaseWhilePaused = (await readState())?.phase;
    const pauseShown = await visible('#pause');
    const resumed = await page.click('#btnResume', { timeout: 3000 }).then(() => true).catch((e) => String(e.message).slice(0, 160));
    const back = await waitFor(async () => { const s = await readState(); return s && s.phase === 'play' ? s : null; }, 1500, 50);
    const pass = !!paused && !!back;
    const why = [];
    if (clicked !== true) why.push(`#btnPause 클릭 실패: ${clicked}`);
    if (!paused) why.push('1초 안에 paused/#pause 아님');
    if (resumed !== true) why.push(`#btnResume 클릭 실패: ${resumed}`);
    if (!back) why.push(`재개 후 phase=${(await readState())?.phase}`);
    if (paused && d1 !== d2) sc.warnings.push(`일시정지 중에도 dist가 변함(${d1} → ${d2})`);
    finish(sc, pass, pass ? `일시정지 확인(${paused}, 표시 ${pauseShown}) → 다시 걷기 → play` : why.join(', '), {
      pausedBy: paused, phaseWhilePaused, pauseShown, distWhilePaused: [d1, d2], resumedPhase: back && back.phase,
    });
    return;
  }
  finish(sc, false, '2회 시도 모두 중단·준비 실패');
}

async function scKeyboard(sc) {
  // (가) 캔버스 포커스 + ArrowRight → lane 증가
  let partA = null;
  for (let attempt = 1; attempt <= MAX_TRIES && !partA; attempt++) {
    const A = { attempt, part: '가', notes: [] };
    sc.attempts.push(A);
    const pr = await ensurePlay(A.notes);
    if (!pr.ok) { A.note = '플레이 상태로 못 돌아감'; continue; }
    await page.focus('#game').catch(() => {});
    A.active = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
    let s = await readState();
    if (s.lane >= 1) {
      await page.keyboard.press('ArrowLeft');
      await waitFor(async () => (await readState())?.lane < s.lane, 1000, 50);
      A.notes.push('오른쪽 끝이라 먼저 ArrowLeft');
      s = await readState();
    }
    const before = s.lane;
    const t0 = await pnow();
    await page.keyboard.press('ArrowRight');
    const after = await waitFor(async () => { const v = await readState(); return v && v.lane > before ? v : null; }, 1000, 50);
    const intr = interruption(await tlSince(t0));
    Object.assign(A, { laneBefore: before, laneAfter: after ? after.lane : (await readState())?.lane, interruption: intr });
    if (!after && intr) { A.note = `중단: ${intr}`; continue; }
    partA = { ok: !!after, laneBefore: before, laneAfter: A.laneAfter, active: A.active };
  }
  if (!partA) partA = { ok: false, note: '시도 모두 중단' };

  // (나) 포커스가 버튼일 때 Space가 게임을 재시작하지 않는다.
  //      재시작이 실제로 일어날 수 있는 컷신 상태에서, 아무 동작도 없는 시험용 버튼에 포커스를 두고 Space.
  let partB = null;
  const notes = [];
  for (let attempt = 1; attempt <= 2 && !partB; attempt++) {
    const B = { attempt, part: '나', notes };
    sc.attempts.push(B);
    const how = await makeCut(notes);
    B.madeCutBy = how;
    if (!how) { B.note = '컷신을 만들지 못함'; continue; }
    let age = await phaseAge('cut');
    if (age < 0) { B.note = '컷신 상태가 아님'; continue; }
    if (age > CUT_TAP_AGE_MS + 1200) { B.note = `컷신이 이미 ${Math.round(age)}ms 지남 → 다시`; await ensurePlay(notes); continue; }
    if (age < CUT_TAP_AGE_MS) await sleep(CUT_TAP_AGE_MS - age);
    age = await phaseAge('cut');
    await page.evaluate(() => {
      const b = document.createElement('button');
      b.id = '__e2eBtn';
      b.type = 'button';
      b.textContent = '시험용 버튼';
      b.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;opacity:0;';
      document.body.appendChild(b);
      b.focus();
    });
    const active = await page.evaluate(() => document.activeElement && (document.activeElement.id || document.activeElement.tagName));
    const t0 = await pnow();
    await page.keyboard.press('Space');
    await sleep(700);
    const tl = await tlSince(t0);
    const s = await readState();
    await page.evaluate(() => { const b = document.getElementById('__e2eBtn'); if (b) b.remove(); }).catch(() => {});
    const restarted = tl.after.some((e) => e.phase === 'play');
    partB = { ok: !restarted && active === '__e2eBtn', active, cutAgeAtSpaceMs: Math.round(age), phaseAfter: s && s.phase, restarted, madeCutBy: how };
  }
  if (!partB) partB = { ok: false, note: '컷신을 만들지 못해 시험 못 함' };
  await ensurePlay(notes);
  const pass = partA.ok && partB.ok;
  const why = [];
  if (!partA.ok) why.push(`ArrowRight: lane ${partA.laneBefore} → ${partA.laneAfter}${partA.note ? ` (${partA.note})` : ''} (포커스 ${partA.active})`);
  if (!partB.ok) why.push(partB.note || (partB.restarted ? `버튼 포커스 Space에 컷신이 재시작됨` : `버튼 포커스가 안 잡힘(${partB.active})`));
  finish(sc, pass, pass ? `캔버스 포커스 ArrowRight lane ${partA.laneBefore}→${partA.laneAfter}, 버튼 포커스 Space 뒤 phase=${partB.phaseAfter}(재시작 없음)` : why.join(' / '), {
    arrowRight: partA, spaceOnButton: partB,
  });
}

async function scNoScroll(sc) {
  const notes = [];
  const pr = await ensurePlay(notes);
  if (!pr.ok) { finish(sc, false, '플레이 상태로 못 돌아감', { notes }); return; }
  const readScroll = () => page.evaluate(() => ({
    scrollY: window.scrollY,
    docTop: (document.scrollingElement || document.documentElement).scrollTop,
    vvTop: window.visualViewport ? Math.round(window.visualViewport.pageTop * 10) / 10 : null,
  }));
  const before = await readScroll();
  const c = await canvasRect();
  const cx = c.x + c.w * 0.5;
  const samples = [];
  // 위로 쓸기(패드에서 시작) → 아래로 쓸기 → 빠르게 위로 한 번 더
  await drag(cx, c.y + c.h * 0.9, cx, c.y + c.h * 0.45, 220);
  samples.push(await readScroll());
  await sleep(150);
  await drag(cx + 30, c.y + c.h * 0.55, cx + 30, c.y + c.h * 0.97, 220);
  samples.push(await readScroll());
  await sleep(150);
  await drag(cx - 30, c.y + c.h * 0.95, cx - 30, c.y + c.h * 0.3, 90);
  await sleep(250);
  const after = await readScroll();
  samples.push(after);
  const pass = samples.every((v) => v.scrollY === before.scrollY && v.docTop === before.docTop);
  if (before.vvTop != null && samples.some((v) => v.vvTop !== before.vvTop)) sc.warnings.push(`visualViewport.pageTop 변화: ${before.vvTop} → ${after.vvTop}`);
  finish(sc, pass, pass ? `세로 드래그 3번 뒤 scrollY ${before.scrollY} 그대로` : `scrollY ${before.scrollY} → ${samples.map((v) => v.scrollY).join('/')}`, {
    before, samples,
  });
}

async function scPerf(sc) {
  const notes = [];
  const pr = await ensurePlay(notes);
  if (!pr.ok) { finish(sc, null, '플레이 상태로 못 돌아감', { notes }); return; }
  const t0 = await pnow();
  await page.evaluate(() => window.__e2e.perfStart());
  const end = Date.now() + PERF_MS;
  let restarts = 0;
  while (Date.now() < end) {
    await sleep(250);
    const s = await readState();
    // 참사가 나면 컷신을 탭해 계속 플레이
    if (s && s.phase === 'cut' && (await phaseAge('cut')) > CUT_TAP_AGE_MS + 100) { await tapCanvasCenter(); restarts++; }
  }
  const frames = await page.evaluate(() => window.__e2e.perfStop());
  const tl = await tlSince(t0);
  const iv = [];
  for (let i = 1; i < frames.length; i++) iv.push(frames[i] - frames[i - 1]);
  iv.sort((a, b) => a - b);
  const q = (p) => (iv.length ? iv[Math.min(iv.length - 1, Math.max(0, Math.ceil(p * iv.length) - 1))] : null);
  const mean = iv.length ? iv.reduce((a, b) => a + b, 0) / iv.length : null;
  // 구간 중 play 였던 시간 비율
  let playMs = 0;
  {
    const spanEnd = frames.length ? frames[frames.length - 1] : t0;
    let cur = tl.at ? tl.at.phase : null;
    let from = t0;
    for (const e of tl.after) { if (cur === 'play') playMs += e.t - from; cur = e.phase; from = e.t; }
    if (cur === 'play') playMs += spanEnd - from;
  }
  const ev = {
    frames: frames.length, mean: r1(mean), p50: r1(q(0.5)), p90: r1(q(0.9)), p99: r1(q(0.99)), max: r1(iv.length ? iv[iv.length - 1] : null),
    fps: mean ? r1(1000 / mean) : null, playRatio: r3(playMs / PERF_MS), restarts,
  };
  finish(sc, null, `rAF 간격 p90 ${ev.p90}ms (평균 ${ev.mean}ms ≈ ${ev.fps}fps, p99 ${ev.p99}ms, 프레임 ${ev.frames}, 재시작 ${restarts}) — 소프트웨어 GL이라 판정 없이 기록만`, ev);
}

// ───────────────────────────── 요약 표 ─────────────────────────────
function cellWidth(str) {
  let w = 0;
  for (const ch of str) {
    const c = ch.codePointAt(0);
    w += (c >= 0x1100 && c <= 0x115f) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xfe30 && c <= 0xfe4f) || (c >= 0xff00 && c <= 0xff60) || (c >= 0xffe0 && c <= 0xffe6) ? 2 : 1;
  }
  return w;
}
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - cellWidth(s)));
function clip(s, n) {
  let out = '';
  let w = 0;
  for (const ch of s) { const cw = cellWidth(ch); if (w + cw > n - 1) return out + '…'; out += ch; w += cw; }
  return out;
}
function printTable() {
  const rows = report.scenarios.map((sc) => [String(sc.id), sc.key, verdict(sc), clip(sc.reason || '', 86)]);
  const head = ['번호', '시나리오', '결과', '근거'];
  const w = [0, 1, 2].map((i) => Math.max(cellWidth(head[i]), ...rows.map((r) => cellWidth(r[i]))));
  const line = (r) => `${pad(r[0], w[0])}  ${pad(r[1], w[1])}  ${pad(r[2], w[2])}  ${r[3]}`;
  console.log('');
  console.log(line(head));
  console.log('-'.repeat(w[0] + w[1] + w[2] + 6 + 40));
  for (const r of rows) console.log(line(r));
  const s = report.summary;
  console.log('');
  console.log(`필수(1~11) 통과 ${s.passed}/${s.required}, 실패 ${s.failed}${s.failedIds.length ? ` [${s.failedIds.join(', ')}]` : ''} · 콘솔 오류 ${consoleErrors.length} · 페이지 오류 ${pageErrors.length} · ${s.seconds}s`);
  console.log(`보고서: ${path.relative(APP, REPORT)}`);
}

// ───────────────────────────── 실행 ─────────────────────────────
async function main() {
  await mkdir(OUT, { recursive: true });
  try {
    server = await startServer();
  } catch (e) {
    console.log(`정적 서버를 ${HOST}:${PORT} 에 띄우지 못했습니다(${e.code || e.message}). 포트를 쓰는 다른 프로세스를 확인하세요.`);
    process.exit(2);
  }
  browser = await chromium.launch({
    args: GL_ARGS,
    headless: process.env.E2E_HEADED !== '1',
    slowMo: Number(process.env.E2E_SLOWMO) || 0,
  });
  report.env.chromium = browser.version();
  const context = await browser.newContext({
    viewport: VIEW, hasTouch: true, isMobile: true, deviceScaleFactor: 1, locale: 'ko-KR',
  });
  page = await context.newPage();
  cdp = await context.newCDPSession(page);
  await page.addInitScript(pageProbe);
  // 바깥 네트워크는 빈 응답(폰트 CSS 등). 시험은 dist 안 파일만 본다
  await page.route('**/*', (route) => {
    const req = route.request();
    let u;
    try { u = new URL(req.url()); } catch { return route.continue(); }
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.hostname === HOST || u.hostname === 'localhost') return route.continue();
    report.stubbedRequests.push(req.url().slice(0, 200));
    const type = req.resourceType();
    const contentType = type === 'stylesheet' ? 'text/css' : type === 'script' ? 'text/javascript' : 'text/plain';
    return route.fulfill({ status: 200, contentType, body: '' });
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const loc = m.location();
    consoleErrors.push({ atMs: Date.now() - T0, text: m.text().slice(0, 500), url: loc && loc.url ? `${loc.url}:${loc.lineNumber}` : '' });
  });
  page.on('pageerror', (e) => pageErrors.push({ atMs: Date.now() - T0, text: String(e && e.stack ? e.stack : e).slice(0, 800) }));
  page.on('requestfailed', (r) => report.requestFailed.push({ url: r.url().slice(0, 200), error: r.failure() && r.failure().errorText }));
  page.on('crash', () => pageErrors.push({ atMs: Date.now() - T0, text: '페이지 크래시' }));

  console.log(`e2e 시작 — ${report.url} (Chromium ${report.env.chromium}, Playwright ${pwVersion})`);
  const nav = await page.goto(report.url, { waitUntil: 'load', timeout: 30000 }).then(() => true).catch((e) => String(e.message).slice(0, 200));
  if (nav !== true) pageErrors.push({ atMs: Date.now() - T0, text: `페이지 열기 실패: ${nav}` });

  await scenario(1, 'boot', '부팅: 오류 0, 타이틀', scBoot, { needHook: false });
  await scenario(2, 'start', '시작 버튼 탭 → 플레이', scStart);
  await scenario(3, 'swipe', '하단 패드 왼쪽 스와이프 → 차선 이동', scSwipe);
  await scenario(4, 'grabPark', '구구 잡아 오른쪽 화단으로 → 콤보 +2', scGrabPark);
  await scenario(5, 'tapClap', '구구 톡 → 짝', scTapClap);
  await scenario(6, 'padNoGrab', '하단 패드 길게 눌러도 안 잡힘', scPadNoGrab);
  await scenario(7, 'adopt', '잡고 멈춰 3초 → adopt 참사', scAdopt);
  await scenario(8, 'cutRestart', '컷신 1초 뒤 탭 → 재시작', scCutRestart);
  await scenario(9, 'pause', '일시정지 → 다시 걷기', scPause);
  await scenario(10, 'keyboard', '캔버스 포커스 방향키 / 버튼 포커스 Space', scKeyboard);
  await scenario(11, 'noScroll', '세로 드래그에 페이지 스크롤 없음', scNoScroll);
  await scenario(12, 'perf', '10초 플레이 rAF 간격', scPerf, { infoOnly: true });
  // 렌더러 이름(소프트웨어 GL 확인용). 부팅 판정에 섞이지 않게 맨 끝에 따로 잰다
  report.env.glRenderer = await page.evaluate(() => {
    try {
      const gl = document.createElement('canvas').getContext('webgl');
      if (!gl) return 'WebGL 없음';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    } catch (e) { return `확인 실패: ${e}`; }
  }).catch(() => null);
  report.env.inputLagMs = r1(inputLagMs);
  report.env.inputLagSamples = lagSamples.slice(0, 40);
  report.env.cfg = CFG_NUM;
}

let fatal = null;
try {
  await main();
} catch (e) {
  fatal = String(e && e.stack ? e.stack : e);
  console.log(`실행 중 오류: ${fatal}`);
}
const required = report.scenarios.filter((s) => s.id >= 1 && s.id <= 11);
const failedIds = required.filter((s) => s.pass !== true).map((s) => s.id);
// 실행 도중 끊겨 기록되지 않은 필수 시나리오도 실패로 센다
for (let id = 1; id <= 11; id++) if (!report.scenarios.some((s) => s.id === id)) failedIds.push(id);
report.summary = {
  required: 11,
  passed: required.filter((s) => s.pass === true).length,
  failed: failedIds.length,
  failedIds,
  perf: (report.scenarios.find((s) => s.id === 12) || {}).evidence || null,
  consoleErrors: consoleErrors.length,
  pageErrors: pageErrors.length,
  fatal,
  seconds: Math.round((Date.now() - T0) / 100) / 10,
};
report.exitCode = failedIds.length || fatal ? 1 : 0;
report.finishedAt = new Date().toISOString();
await writeReport();
printTable();
try { if (browser) await browser.close(); } catch { /* 이미 닫힘 */ }
try { if (server) server.close(); } catch { /* 이미 닫힘 */ }
clearTimeout(watchdog);
process.exit(report.exitCode);
