// 자동 데모: 유령 손가락이 실제 입력 함수(clap·grab·drag·release·move)를 그대로 호출한다.
import type { GameCtx } from '../game/context';
import type { Actions } from '../game/actions';
import type { Pig } from '../game/state';
import { LANE_TOL, PIG_BODY_Y } from '../game/state';
import { CFG } from '../config';

/* 데모 튜닝(원본 값) */
const AI = {
  startCd: 0.6,           // 런 시작 후 첫 판단까지
  aimSec: 0.28,           // 손가락이 비둘기까지 가는 시간
  afterTapCd: 0.35, afterDropCd: 0.3,
  goldMaxZ: -3.6,         // 황금 구구는 이보다 멀 때만 노림(정수리까지 끌 시간)
  aheadFar: -7.6, aheadNear: -3.2,   // '내 앞' 판단 구간
  idleChance: 0.09, idleCd: 1.5,     // 가끔 멍때림
  freeHalf: 0.75, freeFar: -7, freeNear: 0.5,   // 피할 차선이 비었는지
  dodgeCd: 0.45, noDodgeCd: 0.3,
  tapChance: 0.3,         // 구구는 가끔 짝으로
  sideX: 0.3,
  goldDur: 0.65, fatDur: 1.3, dragDur: 0.55,
  headTargetY: 0.86, edgeLeft: 0.07, edgeRight: 0.93, dropDy: 0.02, arc: 26,
  ghostX: 0.75, ghostY: 0.92,
};

interface Task {
  p: Pig;
  tap: boolean;
  side: number;
  toHead: boolean;
  t: number;
  gx: number;
  gy: number;
  dur: number;
  grabbed: boolean;
  sx: number; sy: number; t0: number; tx: number; ty: number;
}

export interface Demo {
  tick(dt: number): void;
  reset(): void;
}

export function createDemo(ctx: GameCtx, A: Actions): Demo {
  const view = ctx.view, L = CFG.lane.width;
  const rnd = () => ctx.st.rng.next();
  let task: Task | null = null;
  let cd = AI.startCd;
  let g: [number, number] = [view.w * AI.ghostX, view.h * AI.ghostY];
  let shown = false;

  function ghost(x: number, y: number): void {
    g = [x, y]; shown = true;
    ctx.bus.emit('ghost', { x, y });
  }
  function hideGhost(): void {
    if (shown) { shown = false; ctx.bus.emit('ghost', null); }
  }
  const newTask = (p: Pig, o: Partial<Task>): Task => ({
    p, tap: false, side: 0, toHead: false, t: 0, gx: g[0], gy: g[1], dur: AI.dragDur, grabbed: false,
    sx: 0, sy: 0, t0: 0, tx: 0, ty: 0, ...o,
  });

  function tick(dt: number): void {
    const st = ctx.st;
    if (task) {
      const k = task; k.t += dt;
      const p = k.p;
      if (!k.grabbed) {
        // 손가락을 비둘기 위로
        const [sx, sy] = view.toScreen(p.pos.x, PIG_BODY_Y, p.pos.z), f = Math.min(1, k.t / AI.aimSec);
        ghost(k.gx + (sx - k.gx) * f, k.gy + (sy - k.gy) * f);
        if (f >= 1) {
          if (p.state !== 'walk' || !A.inReach(p)) { task = null; return; }
          if (k.tap) { A.clap(p); task = null; cd = AI.afterTapCd; return; }
          k.grabbed = A.grab(p, sx, sy, 0);
          if (!k.grabbed) { task = null; return; }
          k.sx = sx; k.sy = sy; k.t0 = k.t;
          if (k.toHead) { k.tx = view.w / 2; k.ty = view.h * AI.headTargetY; }
          else { k.tx = k.side < 0 ? view.w * AI.edgeLeft : view.w * AI.edgeRight; k.ty = sy + view.h * AI.dropDy; }
        }
      } else {
        // 포물선으로 끌어 화단(또는 정수리)에
        const f = Math.min(1, (k.t - k.t0) / k.dur), e = f < 0.5 ? 2 * f * f : 1 - Math.pow(-2 * f + 2, 2) / 2;
        const x = k.sx + (k.tx - k.sx) * e, y = k.sy + (k.ty - k.sy) * e - Math.sin(f * Math.PI) * AI.arc;
        ghost(x, y);
        A.drag(x, y, 0);
        if (f >= 1) { A.release(false); task = null; cd = AI.afterDropCd; }
      }
      return;
    }
    hideGhost();
    cd -= dt;
    if (cd > 0) return;
    const gold = st.pigs.find((p) => p.type === 'gold' && p.state === 'walk' && A.inReach(p) && p.pos.z < AI.goldMaxZ);
    if (gold && !st.gold) { task = newTask(gold, { toHead: true, dur: AI.goldDur }); return; }
    const ahead = st.pigs
      .filter((p) => p.state === 'walk' && Math.abs(p.pos.x - st.lane * L) < LANE_TOL && p.pos.z > AI.aheadFar && p.pos.z < AI.aheadNear)
      .sort((a, b) => b.pos.z - a.pos.z)[0];
    if (!ahead) return;
    if (rnd() < AI.idleChance) { cd = AI.idleCd; return; }
    const ty = ahead.type;
    const free = [-1, 0, 1].filter((l) => l !== st.lane && !st.pigs.some((p) =>
      p.state !== 'parked' && Math.abs(p.pos.x - l * L) < AI.freeHalf && p.pos.z > AI.freeFar && p.pos.z < AI.freeNear));
    if (ty === 'live' || ty === 'chat') {
      // 구튜버·단톡구는 피한다
      if (free.length) {
        const l = free.sort((a, b) => Math.abs(a - st.lane) - Math.abs(b - st.lane))[0]!;
        A.move(l > st.lane ? 1 : -1);
        cd = AI.dodgeCd;
      } else cd = AI.noDodgeCd;
      return;
    }
    if (ty === 'gugu' && rnd() < AI.tapChance) { task = newTask(ahead, { tap: true }); return; }
    const side = ahead.pos.x < -AI.sideX ? -1 : (ahead.pos.x > AI.sideX ? 1 : (rnd() < 0.5 ? -1 : 1));
    task = newTask(ahead, { side, dur: ty === 'fat' ? AI.fatDur : AI.dragDur });
  }

  return {
    tick,
    reset() {
      task = null; cd = AI.startCd;
      g = [view.w * AI.ghostX, view.h * AI.ghostY];
      hideGhost();
    },
  };
}
