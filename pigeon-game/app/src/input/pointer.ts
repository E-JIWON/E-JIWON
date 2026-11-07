// 포인터 상태 머신 + 키보드.
// 누른 자리로 1차 분기 → 손 닿는 비둘기 위면 '잡기 보류(pending)'(시간 또는 느린 이동에 확정, 빠른 가로 플릭은 스와이프),
// 리치 밖 비둘기면 'far', 그 외(빈 곳·하단 패드)는 스와이프/탭. 보조 포인터가 들어오면 취소.
import type { GameCtx } from '../game/context';
import type { Actions } from '../game/actions';
import type { BubbleHandle } from '../game/events';
import type { Mode, Pig } from '../game/state';
import { CFG } from '../config';

/* CFG 에 없는 보조 상수(원본 값) */
const PENDING_TAP_MS = 200;      // 보류 상태에서 이 시간 안에 떼면 그 비둘기에 짝
const FAR_TELL_PX = 12;          // 리치 밖 비둘기를 누른 채 이만큼 움직이면 '손이 안 닿음' 말풍선
const PENDING_BUBBLE_DX = 40;

type PtrMode = 'pending' | 'far' | 'swipe' | 'drag';

interface Ptr {
  id: number;
  mode: PtrMode;
  /** 대상 비둘기(pending·far·drag). */
  p: Pig | null;
  x0: number;
  y0: number;
  t0: number;
  /** 마지막 위치(pending). */
  lx: number;
  ly: number;
  /** 터치 손가락 오프셋(px). */
  off: number;
  /** 스와이프 기준 x. */
  x: number;
  swiped: boolean;
  /** 화면 좌우 끝에서 시작한 스와이프(시스템 제스처와 겹침) 무시. */
  ignore: boolean;
  told: boolean;
  bub: BubbleHandle | null;
}

/** 입력이 게임 흐름에 요청하는 것들. */
export interface InputHost {
  mode(): Mode;
  paused(): boolean;
  /** 데모·타이틀 상태에서 누르면 직접 플레이로. */
  beginPlay(): void;
  resume(): void;
  /** 컷신에서 탭 → 다시 출근. */
  restart(): void;
  /** 첫 사용자 입력에서 오디오 잠금 해제. */
  unlock(): void;
}

export interface PointerInput {
  /** 프레임마다(원본 update 안 같은 위치) 보류 시간 확정 검사. */
  tick(): void;
  /** 진행 중인 포인터를 버린다(일시정지·참사·새 런). */
  cancel(): void;
}

const now = () => performance.now();

export function createPointerInput(canvas: HTMLCanvasElement, ctx: GameCtx, A: Actions, host: InputHost): PointerInput {
  const I = CFG.input;
  const view = ctx.view;
  let ptr: Ptr | null = null;

  ctx.bus.on('freeze', () => { ptr = null; });
  ctx.bus.on('reset', () => { ptr = null; });

  /** 이벤트 → 캔버스 CSS 픽셀(프리즈 확대 같은 CSS 변형이 있어도 레이아웃 좌표로 환산). */
  const local = (e: PointerEvent): [number, number] => {
    const r = canvas.getBoundingClientRect();
    const sx = r.width ? view.w / r.width : 1, sy = r.height ? view.h / r.height : 1;
    return [(e.clientX - r.left) * sx, (e.clientY - r.top) * sy];
  };

  function confirmPending(): void {
    const P = ptr;
    if (!P || P.mode !== 'pending' || !P.p) return;
    if (P.p.state !== 'walk' || !A.inReach(P.p)) { P.mode = 'swipe'; P.x = P.lx; return; }
    if (A.grab(P.p, P.lx, P.ly, P.off)) {
      if (P.bub) { P.bub.remove(); P.bub = null; }
      P.mode = 'drag';
    } else ptr = null;
  }

  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { canvas.focus({ preventScroll: true }); } catch { /* 포커스 실패 무시 */ }
    host.unlock();
    if (!e.isPrimary) {
      // 두 번째 손가락 = 취소(벌점 없음)
      if (ptr && ptr.mode === 'drag') A.release(true);
      else if (ptr && ptr.mode === 'pending') { ptr.bub?.remove(); ptr = null; }
      return;
    }
    if (host.paused()) { host.resume(); return; }
    const [px, py] = local(e);
    if (host.mode() !== 'play') { host.beginPlay(); return; }
    const st = ctx.st;
    if (st.phase === 'cut') { if (st.cutT > CFG.cutTapAfter) host.restart(); return; }
    if (st.phase !== 'play') return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* 캡처 실패 무시 */ }
    const off = e.pointerType === 'touch' ? I.fingerLiftPx : 0;
    // 하단 패드에서 시작한 입력은 절대 잡기가 아니다
    const inField = py < view.h * I.padBottom;
    const p = inField ? A.pick(px, py) : null;
    const far = !p && inField ? A.pickFar(px, py) : null;
    const base = { id: e.pointerId, x0: px, y0: py, t0: now(), lx: px, ly: py, off, x: px, swiped: false, told: false, bub: null };
    if (p) ptr = { ...base, mode: 'pending', p, ignore: false };
    else if (far) ptr = { ...base, mode: 'far', p: far, ignore: false };
    else ptr = { ...base, mode: 'swipe', p: null, ignore: px < I.edgeIgnorePx || px > view.w - I.edgeIgnorePx };
    if (p) ptr.bub = A.bubbleAt(p, '구?', PENDING_BUBBLE_DX, 'grabPending');
  });

  canvas.addEventListener('pointermove', (e) => {
    const P = ptr;
    if (!P || P.id !== e.pointerId) return;
    const [px, py] = local(e);
    if (P.mode === 'pending') {
      P.lx = px; P.ly = py;
      const dx = px - P.x0, dy = py - P.y0, dtm = now() - P.t0, dist = Math.hypot(dx, dy);
      const strict = P.p?.type === 'live';
      const horiz = Math.abs(dx) > I.horizRatio * Math.abs(dy);
      // 빠른 가로 플릭 = 스와이프
      if (dtm <= I.flickMs && Math.abs(dx) >= I.flickPx && horiz && dist / Math.max(dtm, 1) > I.flickSpeed) {
        P.bub?.remove();
        P.mode = 'swipe'; P.x = px; P.swiped = true;
        A.move(dx > 0 ? 1 : -1);
        return;
      }
      // 초반 가로 우세 이동은 판정 보류
      if (dtm <= I.flickDeferMs && horiz && Math.abs(dx) < I.flickPx) return;
      // 느리게 일정 거리 이상 = 잡기 확정
      if (dist >= (strict ? I.moveConfirmLivePx : I.moveConfirmPx) && dist / Math.max(dtm, 1) <= I.slowSpeed) confirmPending();
      return;
    }
    if (P.mode === 'drag') A.drag(px, py, P.off);
    else if (P.mode === 'far') {
      if (!P.told && P.p && Math.hypot(px - P.x0, py - P.y0) > FAR_TELL_PX) { P.told = true; A.bubbleAt(P.p, '구? (손이 안 닿음)'); }
    } else if (!P.ignore) {
      const dx = px - P.x;
      if (Math.abs(dx) >= I.swipePx) { A.move(dx > 0 ? 1 : -1); P.x = px; P.swiped = true; }
    }
  });

  const end = (e: PointerEvent, cancel: boolean) => {
    const P = ptr;
    if (!P || P.id !== e.pointerId) return;
    ptr = null;
    if (ctx.st.phase !== 'play') return;
    const [px, py] = local(e), dtm = now() - P.t0, dist = Math.hypot(px - P.x0, py - P.y0);
    if (P.mode === 'drag') {
      // 잡자마자 떼면 잡기 취소 후 짝
      if (!cancel && dtm < PENDING_TAP_MS && dist < I.tapPx) { A.release(true); A.clap(P.p); }
      else A.release(cancel);
      return;
    }
    if (cancel) return;
    // 확정 전에 뗐으면(느린 프레임 포함) 의도는 '톡' → 시간과 무관하게 짝
    if (P.mode === 'pending') { P.bub?.remove(); if (dist < I.tapPx) A.clap(P.p); return; }
    if (P.mode === 'far') { if (!P.told && dtm < I.emptyTapMs) A.clap(null); return; }
    // 상단 HUD 띠에서 시작한 탭은 헛박수로 세지 않는다
    if (P.y0 < view.h * I.hudTop) return;
    if (!P.swiped && !P.ignore && dist < I.emptyTapPx && dtm < I.emptyTapMs) A.clap(null);
  };
  canvas.addEventListener('pointerup', (e) => end(e, false));
  canvas.addEventListener('pointercancel', (e) => end(e, true));

  // 키보드: 캔버스에 포커스가 있을 때만 ←/→/Space
  canvas.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== ' ') return;
    e.preventDefault();
    host.unlock();
    if (host.paused()) { host.resume(); return; }
    if (host.mode() !== 'play') { host.beginPlay(); return; }
    const st = ctx.st;
    if (st.phase === 'cut') { if (st.cutT > CFG.cutTapAfter) host.restart(); return; }
    if (e.key === ' ') A.clap(null);
    else A.move(e.key === 'ArrowLeft' ? -1 : 1);
  });

  return {
    tick() {
      const P = ptr;
      if (P && P.mode === 'pending' && P.p && now() - P.t0 >= (P.p.type === 'live' ? I.holdConfirmLiveMs : I.holdConfirmMs)) confirmPending();
    },
    cancel() { ptr?.bub?.remove(); ptr = null; },
  };
}
