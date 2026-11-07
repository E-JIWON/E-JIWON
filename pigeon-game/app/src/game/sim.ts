// update(dt): 스폰, 이동, 따라구·구구 변칙, 차선 체류 후 퇴장, 충돌, 체크포인트(횡단보도), 타워, 9시/도착.
import type { GameCtx } from './context';
import type { Actions } from './actions';
import {
  FOLLOW_RETARGET, HURRY_SEC, HURRY_TEMPO, LANE_TOL, LEAVE_X, PARKED_AT_X, TICK_SEC, clockRate, routeSpeed,
} from './state';
import { CFG } from '../config';
import { PIGEONS, pickSpawnType } from '../content/pigeons';
import { clamp, damp, followK } from '../util/math';

/* CFG 에 없는 보조 상수(원본 값) */
const ROLL_GAIN = 0.02;            // 카메라 x 오차 → 롤
const TILT_GAIN = 0.12;            // 카메라 x 오차 → 뒷통수 기울기
const BUSY_FAR = -44, BUSY_NEAR = -5;   // 이 구간에 횡단보도가 있으면 스폰 쉼
const SPAWN_CLEAR_Z = -27;         // 이 z 보다 먼 곳에 이미 있는 차선엔 스폰하지 않음
const DESPAWN_Z = 2.6;             // 카메라 뒤로 지나간 비둘기 정리
const CROSSWALK_Z = -40;           // 체크포인트 횡단보도 등장 z
const CROSS_DONE_Z = -1.1;         // 횡단보도 도장 찍히는 z
const DROP_X_K = 8, DROP_Z_K = 12, LAND_Y = 0.03;
const WALK_X_K = 5, LEAVE_X_K = 2.5;
const FOLLOW_FAR = -24;            // 따라구가 쫓기 시작하는 z(가까운 쪽 끝은 리치 앞 경계)
const SHIFT_AT_Z = -12, SHIFT_EDGE_X = 0.5, SHIFT_TURN = 0.7, SHIFT_TURN_SEC = 0.5;
const HEART_Y = 1.5;
const COLOR = { gold: '#FFD23F', mint: '#23C29A', white: '#FFFFFF' };

export interface SimHooks {
  /** 자동 데모 컷신이 끝나면 새 런. */
  restart(): void;
  /** 보류 중인 포인터의 시간 확정 검사(원본과 같은 위치에서 호출). */
  inputTick(): void;
}

export interface Sim {
  update(dt: number): void;
}

export function createSim(ctx: GameCtx, A: Actions, hooks: SimHooks): Sim {
  const W = ctx.world, view = ctx.view;
  const L = CFG.lane.width;
  const rnd = () => ctx.st.rng.next();
  const now = () => performance.now();

  function spawn(): void {
    const st = ctx.st;
    const r = rnd();
    const type = pickSpawnType(st.t, r);
    const lanes = [-1, 0, 1].filter((l) => !st.pigs.some((p) => Math.abs(p.pos.x - l * L) < LANE_TOL && p.pos.z < SPAWN_CLEAR_Z));
    if (!lanes.length) return;
    A.addPig(type, lanes[Math.floor(rnd() * lanes.length)]! * L, CFG.spawn.z);
    if (type === 'gold') {
      A.toast('✦ 황금 구구 출현 ✦', COLOR.gold, view.w / 2, view.h * 0.3, 1.1);
      A.sfx('goldAppear');
    }
  }

  function update(dt: number): void {
    const st = ctx.st, H = CFG.hold;
    if (st.phase === 'freeze') { st.fz += dt; if (st.fz >= CFG.freezeSec) A.showCut(); return; }
    if (st.phase === 'cut') { st.cutT += dt; if (ctx.mode() === 'auto' && st.cutT > CFG.autoRestartSec) hooks.restart(); return; }
    // 들고 있는 동안 세상이 느려진다(잠깐 뒤 회복)
    let k = 1;
    if (st.held) {
      st.holdDur += dt;
      k = st.holdDur < H.slowFor ? H.worldSlow : Math.min(1, H.worldSlow + (st.holdDur - H.slowFor) / H.recover * (1 - H.worldSlow));
    }
    st.t += dt;
    st.clock += dt * clockRate();
    st.dist += routeSpeed() * dt * k;
    const dz = CFG.route.worldSpeed * dt * k;
    W.advance(dz);
    const tx = st.lane * L;
    st.camX = damp(st.camX, tx, CFG.camera.follow, dt);
    W.setCam(
      st.camX,
      clamp((st.camX - tx) * ROLL_GAIN, -CFG.camera.maxRoll, CFG.camera.maxRoll),
      clamp((st.camX - tx) * TILT_GAIN, -CFG.camera.headTilt, CFG.camera.headTilt),
    );
    hooks.inputTick();
    const busy = W.crosswalks.some((c) => c.group.position.z > BUSY_FAR && c.group.position.z < BUSY_NEAR);
    st.spawn -= dt;
    if (st.spawn <= 0) {
      if (st.t > CFG.spawn.firstAfter && !busy) spawn();
      st.spawn = Math.max(CFG.spawn.min, CFG.spawn.base - st.t * CFG.spawn.accel) + rnd() * CFG.spawn.jitter;
    }
    for (const p of st.pigs) {
      if (p.state === 'held') {
        // 손가락을 따라가되 속도 상한(닭둘기는 무겁게, 하품 중엔 둔하게)
        const fat = p.type === 'fat';
        if (st.yawn) st.yawn = Math.max(0, st.yawn - dt);
        const kk = followK(fat ? H.fatFollow : (st.yawn ? H.yawnFollow : H.follow), dt);
        let ddx = (st.drag.x - p.pos.x) * kk, ddz = (st.drag.z - p.pos.z) * kk;
        const mx = (fat ? H.fatMaxSpeed : H.maxSpeed) * dt, len = Math.hypot(ddx, ddz);
        if (len > mx) { ddx *= mx / len; ddz *= mx / len; }
        p.pos.x += ddx; p.pos.z += ddz;
        const ringX = fat ? p.pos.x : st.drag.x, ringZ = fat ? p.pos.z : st.drag.z;
        W.setRing(A.outcome(), ringX, ringZ);
        // 정 게이지: 손가락이 멈춰 있을 때만 쌓인다
        if (now() - st.lastMove > H.stillMs) st.adoptT += dt;
        if (st.adoptT > H.adoptShowAt) {
          if (!st.heartOn) { st.heartOn = true; A.sfx('heart'); }
          const [hx, hy] = view.toScreen(p.pos.x, HEART_Y, p.pos.z);
          ctx.bus.emit('heart', { x: hx, y: hy, ratio: Math.min(1, (st.adoptT - H.adoptShowAt) / (H.adoptAt - H.adoptShowAt)) });
        }
        if (st.adoptT >= H.adoptAt) { A.fail('adopt', p); return; }
        continue;
      }
      p.pos.z += dz;
      if (p.state === 'drop') {
        p.pos.x = damp(p.pos.x, p.tx, DROP_X_K, dt);
        if (p.tz != null) { p.tz += dz; p.pos.z = damp(p.pos.z, p.tz, DROP_Z_K, dt); }
        if (p.m.lift.position.y < LAND_Y) {
          p.m.lift.position.y = 0; p.tz = null; p.state = p.next;
          if (p.rate) { p.rate = false; A.bubbleAt(p, '★2.3 구.', 0, 'park'); }
        }
        continue;
      }
      if (p.state !== 'walk') continue;
      // 차선에 놓인 비둘기는 잠시 뒤 스스로 화단으로(따라구 제외)
      if (p.placed && p.type !== 'follow') {
        p.placedT += dt;
        if (p.placedT > CFG.drop.laneStay) { p.placed = false; p.leaving = true; p.tx = (p.pos.x < 0 ? -1 : 1) * LEAVE_X; }
      }
      if (p.leaving && Math.abs(p.pos.x) > PARKED_AT_X) { p.leaving = false; p.state = 'parked'; continue; }
      // 따라구: 주기적으로 내 차선을 다시 노린다
      if (p.type === 'follow' && p.pos.z > FOLLOW_FAR && p.pos.z < CFG.reach.near) {
        p.lag += dt;
        if (p.lag > FOLLOW_RETARGET) { p.tx = st.lane * L; p.lag = 0; }
      }
      // 구구 변칙: 고개를 돌려 예고한 뒤 한 칸 비킴
      if (p.shift && !p.shifted && p.pos.z > SHIFT_AT_Z) {
        if (!p.turnT) {
          p.dir = p.pos.x < -SHIFT_EDGE_X ? 1 : (p.pos.x > SHIFT_EDGE_X ? -1 : (rnd() < 0.5 ? -1 : 1));
          p.m.turn = p.dir * SHIFT_TURN;
        }
        p.turnT += dt;
        if (p.turnT > SHIFT_TURN_SEC) { p.shifted = true; p.m.turn = 0; p.tx = clamp(p.pos.x + p.dir * L, -L, L); }
      }
      p.pos.x = damp(p.pos.x, p.tx, p.leaving ? LEAVE_X_K : WALK_X_K, dt);
      const C = CFG.collide;
      if (Math.abs(p.pos.x - st.camX) < C.halfWidth && p.pos.z > C.far && p.pos.z < C.near) {
        A.fail(PIGEONS[p.type].failKey, p);
        return;
      }
    }
    for (let i = st.pigs.length - 1; i >= 0; i--) {
      const p = st.pigs[i]!;
      if (p.pos.z > DESPAWN_Z && p.state !== 'held') { ctx.pool.put(p.m); st.pigs.splice(i, 1); }
    }
    // 체크포인트 횡단보도: 지나가면 콤보 확정(시간 여유 + 조회수)
    const prog = st.dist / CFG.route.meters;
    if (st.cps.length && prog >= st.cps[0]!) { st.cps.shift(); W.crosswalk(CROSSWALK_Z); }
    for (const c of W.crosswalks) {
      if (!c.done && c.group.position.z > CROSS_DONE_Z) {
        c.done = true;
        if (st.combo > 0) {
          const b = st.combo * CFG.combo.confirmBonusSec;
          st.clock = Math.max(0, st.clock - b * clockRate());
          st.views += st.combo * CFG.combo.confirmViews;
          A.toast(`콤보 ×${st.combo} 확정! 여유 +${Math.round(b * clockRate())}초`, COLOR.mint, view.w / 2, view.h * 0.34, 1.05);
          A.sfx('comboConfirm');
        } else {
          A.toast('횡단보도 · 숨 고르기', COLOR.white, view.w / 2, view.h * 0.34, 0.9);
        }
      }
    }
    // 회사(구구타워)가 다가온다
    const T = CFG.tower;
    if (prog > T.from) { W.tower.visible = true; W.tower.position.z = T.startZ + (prog - T.from) / (1 - T.from) * T.travel; }
    // 남은 시간: 30초 이하 음악 빨라짐, 마지막 10초 매 초 틱
    const remain = CFG.route.gameSec - st.clock;
    const hurry = remain <= HURRY_SEC;
    if (hurry !== st.hurry) { st.hurry = hurry; ctx.bus.emit('music', { cmd: 'tempo', mult: hurry ? HURRY_TEMPO : 1 }); }
    const sec = Math.ceil(remain);
    if (remain <= TICK_SEC && sec >= 1 && sec !== st.lastTick) { st.lastTick = sec; A.sfx('tick'); }
    if (st.dist >= CFG.route.meters) { st.dist = CFG.route.meters; A.fail('clear'); return; }
    if (st.clock >= CFG.route.gameSec) A.fail('nine');
  }

  return { update };
}
