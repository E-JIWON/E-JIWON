// 떠오르는 글자(toast)와 비둘기 말풍선(bubble). 실제 폭을 재서 화면 안으로 클램프.
import type { Bus, GameEvents } from '../game/events';
import type { View } from '../render/renderer';
import { clamp } from '../util/math';

const TOAST_MS = 950;      // style.css t3up 길이
const BUBBLE_MS = 1100;    // style.css b3 길이
const ANIM_SCALE = 1.06;   // 애니메이션 중 최대 확대
const SIDE_PAD = 6, TOP_MIN = 40, BOTTOM_PAD = 30;
const BASE_FONT = 16;

export function bindFx(el: HTMLElement, view: View, bus: Bus<GameEvents>): void {
  function place(d: HTMLElement, x: number, y: number): void {
    const hw = d.offsetWidth * ANIM_SCALE / 2 + SIDE_PAD;
    d.style.left = clamp(x, hw, view.w - hw) + 'px';
    d.style.top = clamp(y, TOP_MIN, view.h - BOTTOM_PAD) + 'px';
  }
  bus.on('toast', ({ text, color, x, y, size }) => {
    const d = document.createElement('div');
    d.className = 'toast3';
    d.textContent = text;
    d.style.color = color;
    d.style.fontSize = Math.round(BASE_FONT * (size || 1)) + 'px';
    el.appendChild(d);
    place(d, x, y);
    setTimeout(() => d.remove(), TOAST_MS);
  });
  bus.on('bubble', ({ x, y, text, handle }) => {
    const d = document.createElement('div');
    d.className = 'bub3';
    d.textContent = text;
    el.appendChild(d);
    place(d, x, y);
    setTimeout(() => d.remove(), BUBBLE_MS);
    handle.remove = () => d.remove();
  });
  bus.on('reset', () => { el.innerHTML = ''; });
}
