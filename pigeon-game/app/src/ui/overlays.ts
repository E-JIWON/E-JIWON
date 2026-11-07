// 겹 레이어: 타이틀·일시정지·하트(정 게이지)·가장자리 화단 띠·유령 손가락·자동 데모 태그, 무대 상태 클래스.
import type { Bus, GameEvents } from '../game/events';
import type { View } from '../render/renderer';
import { clamp } from '../util/math';

export interface OverlayRefs {
  stage: HTMLElement;
  title: HTMLElement;
  pause: HTMLElement;
  heart: HTMLElement;
  heartBar: HTMLElement;
  ghost: HTMLElement;
  autoTag: HTMLElement;
}

export interface Overlays {
  setTitle(visible: boolean): void;
  setPaused(visible: boolean): void;
  setAutoTag(visible: boolean): void;
}

const HEART_PAD_X = 6, HEART_PAD_Y = 40;   // 하트 칩을 화면 안에 둘 여백(실제 크기 기준)
const GHOST_DX = -8, GHOST_DY = -4;   // 손가락 이모지 끝이 좌표에 오게
const STAGE_STATES = ['freeze', 'cut', 'sepia', 'holding', 'edge-l', 'edge-r'];

export function createOverlays(r: OverlayRefs, view: View, bus: Bus<GameEvents>): Overlays {
  const cls = r.stage.classList;
  bus.on('holding', (on) => {
    cls.toggle('holding', on);
    if (!on) cls.remove('edge-l', 'edge-r');
  });
  bus.on('edge', (side) => { cls.toggle('edge-l', side < 0); cls.toggle('edge-r', side > 0); });
  // 하트 칩은 가운데 아래 기준(translate -50%,-100%)이라, 보일 때 한 번 잰 실제 폭·높이로 화면 안에 가둔다
  let heartHalfW = 0, heartH = 0;
  bus.on('heart', (h) => {
    if (!h) { r.heart.hidden = true; return; }
    if (r.heart.hidden) {
      r.heart.hidden = false;
      heartHalfW = r.heart.offsetWidth / 2;
      heartH = r.heart.offsetHeight;
    }
    const minX = heartHalfW + HEART_PAD_X, maxX = view.w - heartHalfW - HEART_PAD_X;
    r.heart.style.left = (minX < maxX ? clamp(h.x, minX, maxX) : view.w / 2) + 'px';
    r.heart.style.top = clamp(h.y, Math.max(HEART_PAD_Y, heartH + HEART_PAD_X), view.h - HEART_PAD_Y) + 'px';
    r.heartBar.style.width = Math.min(100, h.ratio * 100) + '%';
  });
  bus.on('freeze', () => { cls.add('freeze'); });
  bus.on('cut', ({ info }) => {
    cls.remove('freeze');
    cls.add('cut');
    if (info.key === 'legend') cls.add('sepia');
  });
  bus.on('ghost', (g) => {
    if (!g) { r.ghost.style.opacity = '0'; return; }
    r.ghost.style.opacity = '1';
    r.ghost.style.transform = `translate(${g.x + GHOST_DX}px,${g.y + GHOST_DY}px)`;
  });
  bus.on('reset', () => {
    cls.remove(...STAGE_STATES);
    r.heart.hidden = true;
    r.ghost.style.opacity = '0';
    r.pause.hidden = true;
  });
  return {
    setTitle(v) { r.title.hidden = !v; r.stage.classList.toggle('title', v); },
    setPaused(v) { r.pause.hidden = !v; },
    setAutoTag(v) { r.autoTag.hidden = !v; },
  };
}
