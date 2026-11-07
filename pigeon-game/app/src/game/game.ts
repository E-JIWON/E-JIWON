// 게임 조립·흐름: 렌더러·거리·풀·이벤트·행동·시뮬·입력·데모·UI 를 묶고 프레임 루프와 모드(타이틀/데모/플레이)를 관리.
import type { Sfx } from '../audio/sfx';
import { CFG } from '../config';
import type { PigeonType } from '../content/pigeons';
import { createDemo } from '../ai/demo';
import { createPointerInput } from '../input/pointer';
import { createRenderer } from '../render/renderer';
import { buildWorld } from '../render/world';
import { animatePigeon, createPigeonPool, setHighlight, setIconFade } from '../render/pigeonModel';
import type { PigPose } from '../render/pigeonModel';
import { bindCutscene } from '../ui/cutscene';
import { bindFx } from '../ui/fx';
import { createHud } from '../ui/hud';
import type { HudRefs } from '../ui/hud';
import { createOverlays } from '../ui/overlays';
import type { OverlayRefs } from '../ui/overlays';
import { createSeedSeq } from '../util/rng';
import { createActions } from './actions';
import type { GameCtx } from './context';
import { createBus } from './events';
import type { GameEvents } from './events';
import { createSim } from './sim';
import { newRun } from './state';
import type { Mode, Phase } from './state';

/* 보조 상수 */
const WORLD_SEED = 11;          // 거리 배치 시드(원본과 같은 거리)
const MAX_DT = 0.05;            // 프레임 간격 상한(탭 전환 뒤 순간이동 방지)
const TITLE_POSE_T = 0.3;       // 타이틀 정지 화면 포즈 시각
/** 타이틀 정지 화면에 세워 둘 비둘기(타입, 차선, z). */
const TITLE_PIGS: ReadonlyArray<[PigeonType, number, number]> = [['gugu', 0, -6], ['fat', 1, -11]];

export interface UiRefs extends OverlayRefs, HudRefs {
  fx: HTMLElement;
  cut: HTMLElement;
}

export interface DebugPig { id: number; type: PigeonType; state: PigPose; x: number; z: number; lift: number }

export interface DebugState {
  phase: Phase;
  lane: number;
  combo: number;
  best: number;
  views: number;
  dist: number;
  clock: number;
  held: boolean;
  gold: boolean;
  failKey: string | null;
  pigs: DebugPig[];
}

export interface Game {
  readonly mode: Mode;
  /** 타이틀 숨기고 모드 시작('play' 직접 플레이, 'auto' 자동 데모, 'title' 타이틀 정지 화면). */
  begin(mode: Mode): void;
  /** HUD 일시정지 버튼(플레이 중에만). */
  togglePause(): void;
  resume(): void;
  snapshot(): DebugState;
  toScreen(x: number, y: number, z: number): [number, number];
}

export function createGame(canvas: HTMLCanvasElement, ui: UiRefs, sfx: Sfx): Game {
  const world = buildWorld(WORLD_SEED);
  const renderer = createRenderer(canvas, world);
  const pool = createPigeonPool(world.scene);
  const bus = createBus<GameEvents>();
  const nextSeed = createSeedSeq();
  const S = { mode: 'title' as Mode, running: false, raf: 0, last: 0, paused: false, inView: true };
  const ctx: GameCtx = { st: newRun(nextSeed()), view: renderer.view, world, pool, bus, mode: () => S.mode };

  // 오디오: 게임 이벤트 → 효과음·음악
  bus.on('sfx', ({ name, opts }) => sfx.play(name, opts));
  bus.on('music', (m) => {
    if (m.cmd === 'start') sfx.startMusic();
    else if (m.cmd === 'stop') sfx.stopMusic();
    else sfx.setTempo(m.mult);
  });

  // 화면 요소(HUD·겹 레이어·효과 글자·컷신)
  const hud = createHud(ui);
  const overlays = createOverlays(ui, renderer.view, bus);
  bindFx(ui.fx, renderer.view, bus);
  bindCutscene(ui.cut, bus);

  // 게임 로직·입력·데모
  const A = createActions(ctx);
  const input = createPointerInput(canvas, ctx, A, {
    mode: () => S.mode,
    paused: () => S.paused,
    beginPlay: () => begin('play'),
    resume: () => setPaused(false),
    restart: () => startRun(),
    unlock: () => sfx.unlock(),
  });
  const demo = createDemo(ctx, A);
  const sim = createSim(ctx, A, { restart: () => startRun(), inputTick: () => input.tick() });

  /** 새 런: 거리·비둘기·UI 정리(원본 newRun). */
  function resetRun(): void {
    for (const p of ctx.st.pigs) pool.put(p.m);
    world.clearCross();
    world.tower.visible = false;
    world.ring.visible = false;
    world.headLayer.reset();
    A.clearRider();
    ctx.st = newRun(nextSeed());
    input.cancel();
    S.paused = false;
    demo.reset();
    bus.emit('reset', null);
  }
  /** 새 런 + (직접 플레이면) 출발 신호·음악. */
  function startRun(): void {
    resetRun();
    if (S.mode === 'play') {
      bus.emit('sfx', { name: 'start' });
      bus.emit('music', { cmd: 'tempo', mult: 1 });
      bus.emit('music', { cmd: 'start' });
    }
  }
  /** 타이틀 뒤 정지 화면: 비둘기 1~2마리와 뒷통수. */
  function showTitleScene(): void {
    world.setCam(0, 0, 0);
    for (const [type, lane, z] of TITLE_PIGS) A.addPig(type, lane * CFG.lane.width, z);
    for (const p of ctx.st.pigs) {
      animatePigeon(p.m, p.state, TITLE_POSE_T, 0, true);
      // 머리 위 안내 아이콘은 플레이용 힌트라 타이틀에서는 숨긴다(제목 칩과 겹침). 플레이 중엔 매 프레임 다시 켜진다
      if (p.m.icon) p.m.icon.visible = false;
    }
    hud.update(ctx.st);
    renderer.draw();
  }

  function frame(ts: number): void {
    if (!S.running) return;
    const dt = Math.min(MAX_DT, (ts - (S.last || ts)) / 1000);
    S.last = ts;
    if (S.mode === 'auto' && ctx.st.phase === 'play') demo.tick(dt);
    sim.update(dt);
    const st = ctx.st;   // 자동 재시작으로 바뀌었을 수 있다
    if (st.phase === 'play') {
      for (const p of st.pigs) {
        animatePigeon(p.m, p.state, st.t, dt, false);
        setHighlight(p.m, p.state === 'walk' && A.inReach(p) && p.type !== 'live');
        setIconFade(p.m, p.pos.z);
      }
    }
    if (A.rider && st.gold) animatePigeon(A.rider, 'parked', st.t, dt, true);
    hud.update(st);
    renderer.draw();
    S.raf = requestAnimationFrame(frame);
  }
  function start(): void {
    if (S.running) return;
    S.running = true; S.last = 0;
    S.raf = requestAnimationFrame(frame);
  }
  function stop(): void {
    S.running = false;
    cancelAnimationFrame(S.raf);
  }
  // 타이틀이 아니고, 보이고, 일시정지가 아닐 때만 루프를 돌린다(자동 재생 없음: 데모도 버튼을 눌러야 시작).
  const REDUCE = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canRun = () => S.mode !== 'title' && S.inView && !document.hidden && !S.paused && (!REDUCE || S.mode === 'play');
  const musicWanted = () => S.mode === 'play' && ctx.st.phase === 'play' && !S.paused && !document.hidden;

  function setPaused(v: boolean): void {
    if (S.paused === v) return;
    S.paused = v;
    overlays.setPaused(v);
    if (v) {
      // 들고 있던 비둘기는 원위치(벌점 없음)
      if (ctx.st.held) A.release(true);
      input.cancel();
      stop();
      bus.emit('music', { cmd: 'stop' });
    } else {
      sfx.resume();
      if (canRun()) start();
      if (musicWanted()) bus.emit('music', { cmd: 'start' });
    }
  }

  function setMode(m: Mode): void {
    S.mode = m;
    overlays.setAutoTag(m === 'auto');
    overlays.setTitle(m === 'title');
    if (m !== 'play') bus.emit('music', { cmd: 'stop' });
    if (m === 'title') {
      stop();
      resetRun();
      showTitleScene();
      return;
    }
    startRun();
    if (canRun()) start(); else if (m === 'auto') showTitleScene();
  }

  function begin(m: Mode): void {
    setMode(m);
    if (m === 'play') { try { canvas.focus({ preventScroll: true }); } catch { /* 포커스 실패 무시 */ } }
  }

  // 앱 전환: 들고 있던 것 취소 + 루프 정지, 돌아오면 재개
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (ctx.st.held) A.release(true);
      input.cancel();
      stop();
      bus.emit('music', { cmd: 'stop' });
    } else {
      sfx.resume();
      if (canRun()) start();
      if (musicWanted()) bus.emit('music', { cmd: 'start' });
    }
  });
  // 화면 밖이면 정지
  if (typeof IntersectionObserver === 'function') {
    new IntersectionObserver((es) => es.forEach((en) => {
      S.inView = en.isIntersecting;
      if (canRun()) start(); else stop();
    })).observe(canvas);
  }
  // 크기 변화: 화각·뒷통수 위치 다시 잡고, 루프가 멈춰 있으면 한 장 다시 그림
  const onResize = () => { if (renderer.resize() && !S.running) renderer.draw(); };
  if (typeof ResizeObserver === 'function') new ResizeObserver(onResize).observe(canvas);
  else addEventListener('resize', onResize);

  // 부팅: 타이틀 정지 화면
  renderer.resize();
  overlays.setTitle(true);
  overlays.setAutoTag(false);
  showTitleScene();

  return {
    get mode() { return S.mode; },
    begin,
    togglePause() { if (S.mode === 'play' && ctx.st.phase === 'play') setPaused(!S.paused); },
    resume() { setPaused(false); try { canvas.focus({ preventScroll: true }); } catch { /* 포커스 실패 무시 */ } },
    snapshot() {
      const st = ctx.st;
      return {
        phase: S.mode === 'title' ? 'title' : (S.paused ? 'paused' : st.phase),
        lane: st.lane, combo: st.combo, best: st.best, views: st.views, dist: st.dist, clock: st.clock,
        held: !!st.held, gold: st.gold, failKey: st.fail ? st.fail.key : null,
        pigs: st.pigs.map((p) => ({ id: p.id, type: p.type, state: p.state, x: p.pos.x, z: p.pos.z, lift: p.m.lift.position.y })),
      };
    },
    toScreen: (x, y, z) => renderer.view.toScreen(x, y, z),
  };
}
