// 플레이어 행동과 결과: 차선 이동, 짝, 들기·끌기·놓기(모셔다 드림), 탑승, 참사, 컷신 트리거.
// UI·오디오에는 이벤트로만 알린다.
import type { GameCtx } from './context';
import type { BubbleHandle } from './events';
import type { FailInfo, Pig } from './state';
import { FOLLOW_RETARGET, LANE_TOL, LEAVE_X, PIG_BODY_Y, clockRate, routeSpeed } from './state';
import type { SfxName, SfxOpts } from '../audio/sfx';
import { CFG } from '../config';
import type { Rarity } from '../config';
import { FAILS, NON_COLLIDE, fillCaption } from '../content/fails';
import type { FailKey } from '../content/fails';
import { GUGU_SHIFT_CHANCE } from '../content/pigeons';
import type { PigeonType } from '../content/pigeons';
import { NOD_TIME, animatePigeon, makeRider } from '../render/pigeonModel';
import type { PigeonModel } from '../render/pigeonModel';
import type { RingKind } from '../render/world';
import { clamp } from '../util/math';

export type Outcome = RingKind;

/* CFG 에 없는 보조 상수(원본 값) */
const FAT_CLAPS = 3;               // 닭둘기는 세 번 쳐야 비킴
const MISS_CLAPS = 3;              // 빈 곳 헛박수 연속 → 'claps'
const CLAP_FOLLOW_LAG = -0.6;      // 짝으로 비킨 따라구가 다시 쫓아오기까지 추가 대기
const PICK_TIE = 0.05;             // 판정 원 안 거리 동률 허용(더 가까운 z 우선)
const PICK_PROBE = 0.4;            // 판정 반경 측정용 월드 폭
const LIVE_HIT_SCALE = 1;          // 구튜버는 판정을 넓히지 않는다
const DRAG_NO_MOVE = 99;           // 시작점 없을 때 '충분히 움직임'
const DRAG_MAX_X = 2.2;            // 손가락 목표 x 한계
const DRAG_NEAR_Z = -2.8;          // 손가락 목표 z 앞 한계
const HORIZON_PAD_PX = 2;
const YAWN_SEC = 1;                // '하암…' 둔화 시간
const PARK_VIEW_MARGIN = 0.88;     // 화단 착지점이 화면 안에 보이게(반화각 탄젠트 비율)
const CLEAR_VIEWS = 3;             // 정시 출근 엔딩 조회수(아무도 안 봄)
const BUBBLE_Y = 1.15, BUBBLE_LIFT_K = 1.2, TOAST_Y = 1.1;
const COLOR = { white: '#FFFFFF', gold: '#FFD23F', warn: '#FF8A80' };
const STING: Record<Rarity, SfxName> = { common: 'stingCommon', rare: 'stingRare', epic: 'stingEpic', legendary: 'stingLegend' };

export interface Actions {
  addPig(type: PigeonType, x: number, z: number): Pig;
  toast(text: string, color: string, x: number, y: number, size?: number): void;
  bubbleAt(p: Pig, text: string, dx?: number, sound?: SfxName | null): BubbleHandle;
  sfx(name: SfxName, opts?: SfxOpts): void;
  inReach(p: Pig): boolean;
  pick(px: number, py: number): Pig | null;
  pickFar(px: number, py: number): Pig | null;
  move(dir: number): void;
  clap(target: Pig | null): void;
  grab(p: Pig, px: number, py: number, off: number): boolean;
  drag(px: number, py: number, off: number): void;
  release(cancel: boolean): void;
  outcome(): Outcome;
  fail(key: FailKey, p?: Pig | null): void;
  showCut(): void;
  /** 정수리에 탄 황금 구구(없으면 null). */
  readonly rider: PigeonModel | null;
  /** 새 런 때 정수리 비우기. */
  clearRider(): void;
}

const now = () => performance.now();
const cooFor = (t: PigeonType): SfxName => (t === 'fat' ? 'cooLow' : t === 'gold' ? 'cooHigh' : 'coo');

export function createActions(ctx: GameCtx): Actions {
  const { bus, world: W, view } = ctx;
  const L = CFG.lane.width;
  const rnd = () => ctx.st.rng.next();
  let rider: PigeonModel | null = null;
  let nextId = 1;

  const pan = (x: number) => clamp(x / view.w * 2 - 1, -1, 1);
  const sfx = (name: SfxName, opts?: SfxOpts) => bus.emit('sfx', opts ? { name, opts } : { name });
  const toast = (text: string, color: string, x: number, y: number, size = 1) => bus.emit('toast', { text, color, x, y, size });
  function bubbleAt(p: Pig, text: string, dx = 0, sound: SfxName | null = cooFor(p.type)): BubbleHandle {
    const [x, y] = view.toScreen(p.pos.x, BUBBLE_Y + p.m.lift.position.y * BUBBLE_LIFT_K, p.pos.z);
    const handle: BubbleHandle = { remove() {} };
    bus.emit('bubble', { x: x + dx, y, text, handle });
    if (sound) sfx(sound, { pan: pan(x) });
    return handle;
  }

  function addPig(type: PigeonType, x: number, z: number): Pig {
    const m = ctx.pool.get(type);
    m.root.position.set(x, 0, z);
    const p: Pig = {
      id: nextId++, type, m, pos: m.root.position, state: 'walk', tx: x, tz: null, next: 'walk',
      claps: 0, lag: 0, shift: type === 'gugu' && rnd() < GUGU_SHIFT_CHANCE, shifted: false, turnT: 0, dir: 0,
      chatDone: false, placed: false, placedT: 0, leaving: false, mine: false, ox: x, oz: z, rate: false,
    };
    ctx.st.pigs.push(p);
    return p;
  }

  const inReach = (p: Pig) => p.pos.z > CFG.reach.far && p.pos.z < CFG.reach.near;
  const bumpCombo = (n: number) => { const st = ctx.st; st.combo += n; st.best = Math.max(st.best, st.combo); };

  /** 손 닿는 비둘기 중 판정 원 안에서 가장 가까운 것(동률이면 더 앞의 것). */
  function pick(px: number, py: number): Pig | null {
    const I = CFG.input;
    let best: Pig | null = null, bd = 1e9;
    for (const p of ctx.st.pigs) {
      if (p.state !== 'walk' || !inReach(p)) continue;
      const [sx, sy] = view.toScreen(p.pos.x, PIG_BODY_Y, p.pos.z), [ex] = view.toScreen(p.pos.x + PICK_PROBE, PIG_BODY_Y, p.pos.z);
      const k = p.type === 'live' ? LIVE_HIT_SCALE : (p.type === 'gold' ? I.hitGoldScale : I.hitScale);
      const rad = clamp(Math.abs(ex - sx) * k, I.hitMinPx, p.type === 'gold' ? I.hitGoldMaxPx : I.hitMaxPx);
      const d = Math.hypot(px - sx, py - sy) / rad;
      if (d < 1 && (d < bd - PICK_TIE || (best && Math.abs(d - bd) <= PICK_TIE && p.pos.z > best.pos.z))) { bd = d; best = p; }
    }
    return best;
  }

  /** 리치 밖(멀리) 비둘기를 누른 경우. */
  function pickFar(px: number, py: number): Pig | null {
    for (const p of ctx.st.pigs) {
      if (p.state !== 'walk' || inReach(p) || p.pos.z > CFG.reach.near) continue;
      const [sx, sy] = view.toScreen(p.pos.x, PIG_BODY_Y, p.pos.z);
      if (Math.hypot(px - sx, py - sy) < CFG.input.farHitPx) return p;
    }
    return null;
  }

  function move(dir: number): void {
    const st = ctx.st;
    if (st.phase !== 'play') return;
    const nl = clamp(st.lane + dir, -1, 1);
    if (nl === st.lane) {
      toast('툭', COLOR.white, view.w / 2 + dir * view.w * 0.3, view.h * 0.62, 0.8);
      sfx('bump', { pan: dir });
      return;
    }
    st.lane = nl;
    sfx('swipe', { pan: dir * 0.5 });
  }

  /** 탭 = 짝: 한 칸 옆으로 비켜 달라는 부탁(보조 동사). */
  function clap(target: Pig | null): void {
    const st = ctx.st;
    if (st.phase !== 'play') return;
    let p = target;
    if (!p) {
      p = st.pigs
        .filter((q) => q.state === 'walk' && inReach(q) && Math.abs(q.pos.x - st.lane * L) < LANE_TOL)
        .sort((a, b) => b.pos.z - a.pos.z)[0] ?? null;
    }
    toast('짝!', COLOR.white, view.w / 2, view.h * 0.7, 1);
    if (!p) {
      sfx('clapMiss');
      st.claps++;
      if (st.claps >= MISS_CLAPS) fail('claps');
      return;
    }
    sfx('clap', { pan: pan(view.toScreen(p.pos.x, PIG_BODY_Y, p.pos.z)[0]) });
    st.claps = 0;
    if (p.type === 'live') { fail('live', p); return; }
    if (p.type === 'fat') {
      p.claps++;
      if (p.claps < FAT_CLAPS) { bubbleAt(p, `짝 ${p.claps}/${FAT_CLAPS}`); return; }
      p.claps = 0;
      bubbleAt(p, '(무대 인사)');
    }
    const cur = clamp(Math.round(p.pos.x / L), -1, 1);
    const opts = [cur - 1, cur + 1].filter((l) => l >= -1 && l <= 1 && l !== st.lane);
    if (!opts.length) {
      // 남는 칸이 내 차선뿐 → 화단으로 퇴장
      p.tx = (cur < 0 ? -1 : 1) * LEAVE_X; p.leaving = true; p.placed = false; p.shift = false;
      bumpCombo(CFG.combo.tap);
      bubbleAt(p, '구… (화단으로)');
      return;
    }
    p.tx = opts[Math.floor(rnd() * opts.length)]! * L; p.shift = false; p.placed = true; p.placedT = 0; p.mine = true;
    if (p.type === 'follow') p.lag = CLAP_FOLLOW_LAG;
    bumpCombo(CFG.combo.tap);
    bubbleAt(p, '구…');
  }

  /** 드래그 = 모셔다 드림. 구튜버는 손대는 순간 생방송 출연. */
  function grab(p: Pig, px: number, py: number, off: number): boolean {
    const st = ctx.st;
    if (p.type === 'live') { fail('live', p); return false; }
    p.state = 'held'; p.ox = p.pos.x; p.oz = p.pos.z; p.m.nodT = NOD_TIME;
    st.held = p; st.holdDur = 0; st.adoptT = 0; st.lastMove = now(); st.g0 = [px, py]; st.anc = null;
    st.dpx = px; st.dpy = py; st.drag = { x: p.pos.x, z: p.pos.z }; st.rev = []; st.lastDir = 0; st.yawn = 0; st.heartOn = false;
    bus.emit('holding', true);
    W.ring.visible = true;
    sfx('grab', { pan: pan(px) });
    drag(px, py, off);
    if (p.type === 'chat' && !p.chatDone) {
      p.chatDone = true;
      for (let k = 0; k < 3; k++) addPig('chat', [-1, 0, 1][k]! * L, -21 - k * 1.8);
      toast('🔔 구구구님이 구구님 외 3마리를 초대했습니다', COLOR.white, view.w / 2, view.h * 0.26, 0.8);
      sfx('chatPing');
    }
    bubbleAt(p, p.type === 'fat' ? '구. (영차…)' : (p.type === 'gold' ? '구♪' : '(끄덕)'), 44);
    return true;
  }

  const headHit = (px: number, py: number) =>
    Math.hypot(px - view.w / 2, py - view.h * CFG.drop.headY) < CFG.drop.headRadiusPx;

  /** 지금 놓으면 어떻게 되는지(링 색 미리보기와 같은 판정). */
  function outcome(): Outcome {
    const st = ctx.st, p = st.held;
    if (!p) return 'lane';
    const fat = p.type === 'fat';
    if (p.type === 'gold' && headHit(st.dpx, st.dpy)) return 'head';
    // 닭둘기는 손가락이 아니라 실제 위치로 판정
    const gx = fat ? p.pos.x : st.drag.x;
    if ((!fat && st.edge) || Math.abs(gx) > CFG.drop.outX) return 'out';
    return clamp(Math.round(gx / L), -1, 1) === st.lane ? 'block' : 'lane';
  }

  function drag(px: number, py: number, off: number): void {
    const st = ctx.st, H = CFG.hold, I = CFG.input;
    if (!st.held) return;
    // 터치 손가락 오프셋: 움직인 거리 비율로만 적용
    const mv = st.g0 ? Math.hypot(px - st.g0[0], py - st.g0[1]) : DRAG_NO_MOVE;
    let q = py - (off || 0) * Math.min(1, mv / I.liftRampPx);
    // 지평선 위로 못 가게 리치 먼 경계에서 클램프
    q = Math.max(q, view.toScreen(0, 0, CFG.reach.far - 1)[1] + HORIZON_PAD_PX);
    if (!st.anc || Math.hypot(px - st.anc[0], q - st.anc[1]) > H.stillPx) { st.anc = [px, q]; st.lastMove = now(); }
    // 좌우 흔들기 감지 → '하암…'
    const dir = Math.sign(px - st.dpx);
    if (dir && st.lastDir && dir !== st.lastDir) {
      st.rev.push(now());
      st.rev = st.rev.filter((t0) => now() - t0 < H.shakeWindowMs);
      if (st.rev.length > H.shakeReversals) { st.rev = []; st.yawn = YAWN_SEC; bubbleAt(st.held, '하암…', 44, 'yawn'); }
    }
    if (dir) st.lastDir = dir;
    st.dpx = px; st.dpy = q;
    // 교점이 없으면 직전 값 유지
    const g = view.groundAt(px, q);
    if (g) { st.drag.x = clamp(g.x, -DRAG_MAX_X, DRAG_MAX_X); st.drag.z = clamp(g.z, CFG.reach.far - 1, DRAG_NEAR_Z); }
    st.edge = px < view.w * I.edgeBand ? -1 : (px > view.w * (1 - I.edgeBand) ? 1 : 0);
    bus.emit('edge', st.edge);
  }

  function release(cancel: boolean): void {
    const st = ctx.st, p = st.held;
    if (!p) return;
    const res = cancel ? 'cancel' : outcome();
    st.held = null;
    bus.emit('holding', false);
    W.ring.visible = false;
    bus.emit('heart', null);
    const x = p.pos.x, [tx, ty] = view.toScreen(x, TOAST_Y, p.pos.z);
    if (res === 'cancel') { p.tx = p.ox; p.tz = p.oz; p.next = 'walk'; p.state = 'drop'; return; }
    if (res === 'head') { ride(p); return; }
    sfx('drop', { pan: pan(tx) });
    if (res === 'out') {
      const sd = (p.type === 'fat' ? Math.sign(x) : st.edge) || Math.sign(x) || 1;
      p.tx = sd * CFG.drop.parkX;
      // 착지점이 화면 안에 보이도록 z 를 앞으로 당긴다
      const dmin = Math.abs(p.tx - st.camX) / (Math.tan(CFG.camera.hfovDeg / 2 * Math.PI / 180) * PARK_VIEW_MARGIN);
      p.tz = Math.min(p.pos.z, CFG.camera.z - dmin);
      p.next = 'parked'; p.state = 'drop';
      bumpCombo(CFG.combo.park);
      st.shuttle++;
      toast(st.shuttle % CFG.combo.shuttleEvery === 0 ? `셔틀 기사 보너스! · 콤보 ×${st.combo}` : `모셔다 드림 +${CFG.combo.park} · 콤보 ×${st.combo}`, COLOR.gold, tx, ty, 1);
      p.rate = true;
      return;
    }
    p.tx = clamp(Math.round(x / L), -1, 1) * L; p.tz = null; p.next = 'walk'; p.state = 'drop';
    p.shift = false; p.placed = true; p.placedT = 0; p.mine = true;
    if (p.type === 'follow') p.lag = FOLLOW_RETARGET - CFG.drop.followReturn;
    if (res === 'lane') {
      bumpCombo(CFG.combo.lane);
      toast(`살포시 · 콤보 ×${st.combo}`, COLOR.white, tx, ty, 0.9);
      sfx('lane', { pan: pan(tx) });
    } else {
      toast('살포시… 근데 내 앞인데?', COLOR.warn, tx, ty, 0.85);
      sfx('block', { pan: pan(tx) });
    }
  }

  /** 황금 구구 정수리 탑승. */
  function ride(p: Pig): void {
    const st = ctx.st;
    const i = st.pigs.indexOf(p);
    if (i >= 0) st.pigs.splice(i, 1);
    ctx.pool.put(p.m);
    if (!rider) rider = makeRider();
    W.headLayer.attach(rider.root);
    st.gold = true;
    toast(`황금 구구 탑승! 조회수 ×${CFG.views.goldMult}`, COLOR.gold, view.w / 2, view.h * 0.5, 1.15);
    sfx('ride');
  }

  function fail(key: FailKey, p: Pig | null = null): void {
    const st = ctx.st;
    if (st.phase !== 'play') return;
    if (st.held && key !== 'adopt') {
      // 들린 비둘기는 원위치에 착지
      const h = st.held;
      st.held = null; h.state = 'walk'; h.tx = h.ox; h.pos.x = h.ox; h.m.lift.position.y = 0;
      animatePigeon(h.m, h.state, st.t, 0, true);
    }
    bus.emit('holding', false);
    W.ring.visible = false;
    bus.emit('heart', null);
    // 충돌 키 우선순위: 황금 탑승 중 → legend, 콤보 ≥ 특보 기준 → special, 내가 놓은 비둘기 → self
    const collide = !NON_COLLIDE.has(key);
    if (collide && st.gold) key = 'legend';
    else if (collide && st.combo >= CFG.views.specialCombo) key = 'special';
    else if (collide && p && p.mine) key = 'self';
    const def = FAILS[key];
    const left = CFG.route.meters - st.dist;
    const m = Math.max(0, Math.round(left));
    const s = Math.max(0, left / routeSpeed() * clockRate()).toFixed(1);
    const mult = CFG.views.mult[def.r] ?? 1;
    st.views = key === 'clear' ? CLEAR_VIEWS
      : Math.round(st.dist * Math.max(1, st.best) * mult * CFG.views.firstTime * (st.gold ? CFG.views.goldMult : 1));
    const info: FailInfo = { key, def, cap: fillCaption(def.cap, st.combo, m, s) };
    st.fail = info;
    st.phase = 'freeze'; st.fz = 0;
    for (const q of st.pigs) if (q.m.icon) q.m.icon.visible = false;
    bus.emit('freeze', info);
    bus.emit('music', { cmd: 'stop' });
    sfx('freeze');
    if (p) bubbleAt(p, '…구?', 0, null);
    if (key === 'gugu' || key === 'self') W.headLayer.bow();
  }

  function showCut(): void {
    const st = ctx.st, info = st.fail;
    if (!info) return;
    st.phase = 'cut'; st.cutT = 0;
    bus.emit('cut', { info, views: st.views, auto: ctx.mode() === 'auto' });
    sfx(STING[info.def.r]);
  }

  return {
    addPig, toast, bubbleAt, sfx, inReach, pick, pickFar, move, clap, grab, drag, release, outcome, fail, showCut,
    get rider() { return rider; },
    clearRider() { if (rider) W.headLayer.detach(rider.root); },
  };
}
