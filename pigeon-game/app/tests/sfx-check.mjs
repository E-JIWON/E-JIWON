// 효과음 합성기 점검 스크립트.
// src/audio/sfx.ts 를 번들 없이 JS로 변환(vite에 들어 있는 변환기 사용)한 뒤
//  1) Node(오디오 API 없음)에서 모든 메서드가 예외 없이 무음으로 동작하는지,
//  2) 헤드리스 Chromium에서 AudioContext 자리에 OfflineAudioContext를 끼워 넣고
//     소리마다 길이·피크가 0이 아닌지, 클리핑·NaN이 없는지, 렌더 창 안에서 끝나는지,
//  3) 배경음 스케줄러(lookahead)·템포 변경·정지 페이드·음소거·40ms 중복 무시·동시 발음 상한·이상한 옵션,
//  4) AudioContext가 없거나 생성이 막힌 브라우저에서 예외가 없는지
// 를 확인한다. 실행: node tests/sfx-check.mjs  (실패가 있으면 종료 코드 1)
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(here, '../src/audio/sfx.ts');
const require = createRequire(import.meta.url);

let failures = 0;
const lines = [];
function check(ok, label, detail = '') {
  if (!ok) failures++;
  lines.push(`${ok ? '통과' : '실패'}  ${label}${detail ? `  (${detail})` : ''}`);
}
const db = (x) => (x > 0 ? `${(20 * Math.log10(x)).toFixed(1)}dBFS` : '-inf');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── TS → JS 변환 ──
async function toJs(ts) {
  try {
    const vite = await import('vite');
    if (typeof vite.transformWithOxc === 'function') {
      const r = await vite.transformWithOxc(ts, SRC, { lang: 'ts' });
      return { code: r.code, via: 'vite transformWithOxc' };
    }
    if (typeof vite.transformWithEsbuild === 'function') {
      const r = await vite.transformWithEsbuild(ts, SRC, { loader: 'ts', format: 'esm' });
      return { code: r.code, via: 'vite transformWithEsbuild' };
    }
  } catch { /* 아래 대안 */ }
  const tsc = require('typescript');
  const out = tsc.transpileModule(ts, { compilerOptions: { target: tsc.ScriptTarget.ES2022, module: tsc.ModuleKind.ESNext } });
  return { code: out.outputText, via: 'typescript transpileModule' };
}

const tsSrc = await readFile(SRC, 'utf8');
const NAMES = [...(tsSrc.match(/export type SfxName =([\s\S]*?);/)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);
const { code, via } = await toJs(tsSrc);
console.log(`변환: ${via} · 효과음 ${NAMES.length}종`);
check(NAMES.length === 27, 'SfxName 목록 27종 그대로', NAMES.join(','));

// ── 1) Node: 오디오 API 없는 환경 ──
{
  const mod = await import('data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  let err = null;
  try {
    const s = mod.createSfx();
    s.play('clap');
    s.unlock();
    s.startMusic();
    s.setTempo(1.15);
    for (let i = 0; i < 60; i++) s.play(NAMES[i % NAMES.length], { pan: 0.3, pitch: 1.1, volume: 0.8 });
    s.setMuted(true);
    s.play('coo');
    s.resume();
    s.stopMusic();
    check(s.muted === true, 'Node: muted 게터');
  } catch (e) { err = e; }
  check(!err, 'Node(AudioContext 없음): 모든 메서드 예외 없음', err ? String(err) : '');
  check(mod.sfxLog.length === 50 && mod.sfxLog[49] === 'coo', 'Node: sfxLog 최대 50개·마지막 호출 기록', `길이 ${mod.sfxLog.length}`);
}

// ── 브라우저 준비 ──
const { chromium } = require('playwright');
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist'] });
const ORIGIN = 'http://sfx.check';

async function openPage(initScript) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(`${ORIGIN}/**`, (route) => {
    const u = new URL(route.request().url());
    if (u.pathname === '/sfx.js') return route.fulfill({ status: 200, contentType: 'text/javascript; charset=utf-8', body: code });
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: '<!doctype html><meta charset="utf-8"><title>sfx-check</title>' });
  });
  if (initScript) await page.addInitScript(initScript);
  await page.goto(`${ORIGIN}/`);
  return { page, errors };
}

// OfflineAudioContext를 AudioContext 자리에 끼우는 가짜 생성자 + 분석 도우미
function offlineHarness() {
  window.__renderSec = 3.5;
  window.__made = [];
  const Real = window.OfflineAudioContext;
  function FakeAudioContext() {
    const ctx = new Real(2, Math.ceil(window.__renderSec * 44100), 44100);
    // 렌더 전 오프라인 컨텍스트는 suspended로 보이므로, 돌아가는 실시간 컨텍스트처럼 보이게 한다
    Object.defineProperty(ctx, 'state', { get: () => 'running', configurable: true });
    const n = { osc: 0, src: 0 };
    const co = ctx.createOscillator.bind(ctx);
    const cb = ctx.createBufferSource.bind(ctx);
    ctx.createOscillator = () => { n.osc++; return co(); };
    ctx.createBufferSource = () => { n.src++; return cb(); };
    ctx.__n = n;
    window.__made.push(ctx);
    return ctx;
  }
  window.AudioContext = FakeAudioContext;
  try { delete window.webkitAudioContext; } catch { /* 없음 */ }

  window.__nodes = (ctx) => ctx.__n.osc + ctx.__n.src;
  window.__analyze = (buf, from = 0, to = buf.duration) => {
    const sr = buf.sampleRate;
    const a = Math.max(0, Math.floor(from * sr));
    const b = Math.min(buf.length, Math.floor(to * sr));
    const TH = 0.001; // -60dBFS 위를 '소리 있음'으로 본다
    let peak = 0, first = -1, last = -1, nan = false;
    for (let ch = 0; ch < buf.numberOfChannels; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = a; i < b; i++) {
        const x = d[i];
        if (x !== x) { nan = true; continue; }
        const ax = Math.abs(x);
        if (ax > peak) peak = ax;
        if (ax > TH) { if (first < 0 || i < first) first = i; if (i > last) last = i; }
      }
    }
    let sum = 0, cnt = 0;
    if (first >= 0) {
      for (let ch = 0; ch < buf.numberOfChannels; ch++) {
        const d = buf.getChannelData(ch);
        for (let i = first; i <= last; i++) { const x = d[i]; if (x === x) { sum += x * x; cnt++; } }
      }
    }
    return {
      peak, nan,
      rms: cnt ? Math.sqrt(sum / cnt) : 0,
      start: first < 0 ? null : first / sr,
      end: last < 0 ? null : last / sr,
      dur: first < 0 ? 0 : (last - first) / sr,
    };
  };
}

// ── 2) 효과음 하나씩 오프라인 렌더 ──
const RENDER_SEC = 3.5;
{
  const { page, errors } = await openPage(offlineHarness);
  const res = await page.evaluate(async ({ names, sec }) => {
    const m = await import('/sfx.js');
    const out = [];
    for (const name of names) {
      window.__renderSec = sec;
      const s = m.createSfx();
      s.unlock();
      s.play(name);
      const ctx = window.__made.at(-1);
      const nodes = window.__nodes(ctx);
      const buf = await ctx.startRendering();
      out.push({ name, nodes, ...window.__analyze(buf) });
    }
    return out;
  }, { names: NAMES, sec: RENDER_SEC });

  console.log('\n이름            길이(ms)  피크        RMS        노드');
  for (const r of res) {
    console.log(`${r.name.padEnd(14)}  ${String(Math.round(r.dur * 1000)).padStart(7)}  ${db(r.peak).padEnd(10)}  ${db(r.rms).padEnd(10)}  ${r.nodes}`);
    const ok = r.peak >= 0.003 && r.dur >= 0.02 && r.peak < 0.98 && !r.nan && r.end !== null && r.end < RENDER_SEC - 0.05;
    check(ok, `효과음 ${r.name}: 길이·피크 > 0, 클리핑 없음, 창 안에서 끝남`,
      `${Math.round(r.dur * 1000)}ms, 피크 ${db(r.peak)}${r.nan ? ', NaN' : ''}`);
  }
  check(errors.length === 0, '효과음 렌더 중 페이지 오류 없음', errors.join(' | '));
  await page.close();
}

// ── 3) 배경음·음소거·중복 무시·동시 발음·옵션 ──
{
  const { page, errors } = await openPage(offlineHarness);
  await page.evaluate(async () => { window.__m = await import('/sfx.js'); });

  // 음악: 18초 렌더(8마디 루프 16초 전체), 16.5초에 stopMusic → 페이드 후 정적
  // 오프라인 렌더를 0.1초마다 멈추고 실제 시간 55ms를 기다려 스케줄러 타이머가 돌게 한다
  const renderMusic = async (sec, tempo, stopAt) => page.evaluate(async ({ sec, tempo, stopAt }) => {
    const m = window.__m;
    window.__renderSec = sec;
    const s = m.createSfx();
    s.unlock();
    if (tempo !== 1) s.setTempo(tempo);
    s.startMusic();
    const ctx = window.__made.at(-1);
    const STEP = 0.1;
    for (let i = 1; i * STEP < sec - 0.05; i++) {
      const t = i * STEP;
      ctx.suspend(t).then(async () => {
        if (stopAt !== null && Math.abs(t - stopAt) < STEP / 2) s.stopMusic();
        await new Promise((r) => setTimeout(r, 55));
        ctx.resume();
      });
    }
    const buf = await ctx.startRendering();
    s.stopMusic();
    const A = window.__analyze;
    return {
      nodes: window.__nodes(ctx),
      all: A(buf),
      intro: A(buf, 0.5, 8),            // 앞 4마디(반주)
      melody: A(buf, 8, 16),            // 뒤 4마디(멜로디)
      after: stopAt === null ? null : A(buf, stopAt + 0.45, sec),
    };
  }, { sec, tempo, stopAt });

  const mus = await renderMusic(18, 1, 16.5);
  console.log(`\n배경음 18초: 피크 ${db(mus.all.peak)}, 앞 4마디 RMS ${db(mus.intro.rms)}, 뒤 4마디 RMS ${db(mus.melody.rms)}, 정지 후 피크 ${db(mus.after.peak)}`);
  check(mus.intro.rms > 0.003 && mus.melody.rms > 0.003, '배경음: 루프 전 구간에 소리 있음(스케줄러 동작)');
  check(mus.melody.rms > mus.intro.rms, '배경음: 뒤 4마디에 멜로디가 얹혀 더 꽉 참', `${db(mus.intro.rms)} → ${db(mus.melody.rms)}`);
  check(mus.all.peak < 0.98 && !mus.all.nan, '배경음: 클리핑·NaN 없음', db(mus.all.peak));
  check(mus.after.peak < 0.001, 'stopMusic: 0.25초 페이드 후 정적', `정지 0.45초 뒤 피크 ${db(mus.after.peak)}`);

  // 템포: 같은 6초면 1.15배가 더 많이 예약하고, 4마디(1.0배 8초 = 1.15배 8/1.15초)를 맞추면 예약량이 거의 같아야 한다
  const t1 = await renderMusic(6, 1, null);
  const t2 = await renderMusic(6, 1.15, null);
  const ratio = t2.nodes / t1.nodes;
  const b1 = await renderMusic(8, 1, null);
  const b2 = await renderMusic(8 / 1.15, 1.15, null);
  const same = b2.nodes / b1.nodes;
  console.log(`템포: 같은 6초 노드 수 1.0배 ${t1.nodes} / 1.15배 ${t2.nodes} (비율 ${ratio.toFixed(3)}), `
    + `같은 4마디 노드 수 ${b1.nodes} / ${b2.nodes} (비율 ${same.toFixed(3)})`);
  check(ratio > 1.05, 'setTempo(1.15): 같은 시간에 더 많은 스텝 예약', ratio.toFixed(3));
  check(Math.abs(same - 1) < 0.04, 'setTempo(1.15): 4마디가 8/1.15초 안에 같은 양으로 들어감(정확히 1.15배)', same.toFixed(3));

  // 음소거: 소리 없음 + 이름은 기록
  const mute = await page.evaluate(async (names) => {
    const m = window.__m;
    window.__renderSec = 1.5;
    m.sfxLog.length = 0;
    const s = m.createSfx();
    s.unlock();
    s.setMuted(true);
    for (const n of names) s.play(n);
    s.startMusic();
    const ctx = window.__made.at(-1);
    const nodes = window.__nodes(ctx);
    const buf = await ctx.startRendering();
    s.stopMusic();
    return { muted: s.muted, log: m.sfxLog.slice(), peak: window.__analyze(buf).peak, nodes };
  }, NAMES);
  check(mute.muted === true && mute.peak === 0, '음소거: 출력 완전 무음', `피크 ${db(mute.peak)}, 노드 ${mute.nodes}`);
  check(mute.log.length === NAMES.length && mute.log.every((n, i) => n === NAMES[i]), '음소거 중에도 sfxLog에 이름 기록');

  // 음소거 해제 후 다시 소리
  const unmute = await page.evaluate(async () => {
    const m = window.__m;
    window.__renderSec = 1.5;
    const s = m.createSfx();
    s.unlock();
    s.setMuted(true);
    s.setMuted(false);
    s.play('park');
    const buf = await window.__made.at(-1).startRendering();
    return window.__analyze(buf).peak;
  });
  check(unmute > 0.003, '음소거 해제 후 다시 소리 남', db(unmute));

  // 40ms 중복 무시 + sfxLog 최대 50개
  const dd = await page.evaluate(async () => {
    const m = window.__m;
    window.__renderSec = 1;
    m.sfxLog.length = 0;
    const s = m.createSfx();
    s.unlock();
    const ctx = window.__made.at(-1);
    const base = window.__nodes(ctx);
    s.play('clap');
    const one = window.__nodes(ctx) - base;
    s.play('clap');
    const two = window.__nodes(ctx) - base;
    await new Promise((r) => setTimeout(r, 60));
    s.play('clap');
    const three = window.__nodes(ctx) - base;
    const logged = m.sfxLog.length;
    for (let i = 0; i < 80; i++) s.play('tick');
    return { one, two, three, logged, logLen: m.sfxLog.length };
  });
  check(dd.one > 0 && dd.two === dd.one, '같은 이름 40ms 안 두 번째 호출 무시', `노드 ${dd.one} → ${dd.two}`);
  check(dd.three === dd.one * 2, '40ms 지나면 다시 재생', `노드 ${dd.three}`);
  check(dd.logged === 3 && dd.logLen === 50, 'sfxLog: 무시된 호출도 기록 · 최대 50개', `${dd.logged}, ${dd.logLen}`);

  // 동시 발음 상한 + 이상한 옵션 값
  const cap = await page.evaluate(async (names) => {
    const m = window.__m;
    window.__renderSec = 3;
    const s = m.createSfx();
    s.unlock();
    const ctx = window.__made.at(-1);
    let made = 0;
    for (const n of names) {
      const b = window.__nodes(ctx);
      s.play(n, { pan: n.length % 2 ? 0.6 : -0.6 });
      if (window.__nodes(ctx) > b) made++;
    }
    const buf = await ctx.startRendering();
    const a = window.__analyze(buf);
    return { made, peak: a.peak, nan: a.nan };
  }, NAMES);
  check(cap.made === 16, '동시 발음 상한 16(넘치면 새 소리 생략)', `${NAMES.length}종 동시 호출 → ${cap.made}종 합성`);
  check(cap.peak < 1 && !cap.nan, '16개 동시 발음에도 리미터로 클리핑 없음', db(cap.peak));

  const odd = await page.evaluate(async () => {
    const m = window.__m;
    window.__renderSec = 2;
    const s = m.createSfx();
    s.unlock();
    let err = null;
    try {
      s.play('park', { pitch: NaN, volume: 99, pan: -5 });
      s.play('coo', { pitch: 8, pan: 0.7 });
      s.play('swipe', { pitch: 0, volume: -1 });
      s.play('nope');
      s.play('goldAppear', { pitch: 4 });
      s.setTempo(Infinity);
      s.setTempo(-3);
    } catch (e) { err = String(e); }
    const buf = await window.__made.at(-1).startRendering();
    const a = window.__analyze(buf);
    return { err, peak: a.peak, nan: a.nan };
  });
  check(!odd.err && odd.peak > 0 && odd.peak < 1 && !odd.nan, '이상한 옵션(NaN·범위 밖·없는 이름)에도 예외·클리핑 없음', odd.err ?? db(odd.peak));
  check(errors.length === 0, '배경음·옵션 점검 중 페이지 오류 없음', errors.join(' | '));
  await page.close();
}

// ── 4) AudioContext 없는/막힌 브라우저 ──
for (const [label, init] of [
  ['AudioContext 없음', () => { delete window.AudioContext; delete window.webkitAudioContext; }],
  ['AudioContext 생성 예외', () => { window.AudioContext = function Blocked() { throw new Error('blocked'); }; delete window.webkitAudioContext; }],
]) {
  const { page, errors } = await openPage(init);
  const r = await page.evaluate(async (names) => {
    const m = await import('/sfx.js');
    let err = null;
    try {
      const s = m.createSfx();
      s.play('start');
      s.unlock();
      s.unlock();
      s.startMusic();
      s.setTempo(1.15);
      for (let i = 0; i < 60; i++) s.play(names[i % names.length]);
      s.setMuted(true);
      s.setMuted(false);
      s.resume();
      s.stopMusic();
    } catch (e) { err = String(e); }
    await new Promise((res) => setTimeout(res, 120));
    return { err, logLen: m.sfxLog.length };
  }, NAMES);
  check(!r.err && errors.length === 0, `${label}: 예외 없이 무음 동작`, r.err ?? errors.join(' | '));
  check(r.logLen === 50, `${label}: sfxLog는 계속 기록`, `길이 ${r.logLen}`);
  await page.close();
}

await browser.close();

console.log('\n' + lines.join('\n'));
console.log(`\n결과: ${lines.length - failures}/${lines.length} 통과`);
process.exit(failures ? 1 : 0);
