// 상단 HUD: 시계(08:57→09:00), 진행 막대, 조회수, 콤보. 바뀐 게 있을 때만 DOM 갱신.
import type { RunState } from '../game/state';
import { HURRY_SEC } from '../game/state';
import { CFG } from '../config';

const START_SEC = 8 * 3600 + 57 * 60;   // 08:57:00
const PROG_STEPS = 200;                  // 진행 막대 갱신 해상도

export interface HudRefs { clock: HTMLElement; prog: HTMLElement; views: HTMLElement; combo: HTMLElement }

/** 조회수 표기(1만 이상은 '1.2만'). */
export const fmtViews = (n: number): string =>
  n >= 10000 ? (n / 10000).toFixed(1) + '만' : Math.round(n).toLocaleString('ko-KR');

/** 게임 시계 → 'HH:MM:SS'. */
export function clockText(clock: number): string {
  const s = Math.min(CFG.route.gameSec, clock), tot = START_SEC + Math.floor(s);
  return [Math.floor(tot / 3600), Math.floor(tot % 3600 / 60), tot % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

export interface Hud { update(st: RunState): void }

export function createHud(r: HudRefs): Hud {
  let cache = '';
  return {
    update(st) {
      const prog = Math.min(1, st.dist / CFG.route.meters), c = clockText(st.clock);
      const key = c + '|' + st.combo + '|' + st.views + '|' + Math.round(prog * PROG_STEPS);
      if (key === cache) return;
      cache = key;
      r.clock.textContent = c;
      r.clock.classList.toggle('red', st.clock > CFG.route.gameSec - HURRY_SEC);
      r.prog.style.width = (prog * 100).toFixed(1) + '%';
      r.views.textContent = '조회수 ' + fmtViews(st.views);
      r.combo.textContent = st.combo ? '×' + st.combo : '';
    },
  };
}
