// 참사 컷신: 레터박스, 장식(deco), 등급 스탬프, 뉴스 바, 결과 줄, 힌트.
import type { Bus, GameEvents } from '../game/events';
import { RARITY_LABEL } from '../content/fails';
import { esc } from '../util/text';
import { fmtViews } from './hud';

export function bindCutscene(el: HTMLElement, bus: Bus<GameEvents>): void {
  bus.on('cut', ({ info, views, auto }) => {
    const f = info.def, lbl = RARITY_LABEL[f.r];
    // deco 는 content/fails.ts 의 고정 마크업, 나머지 문자열은 이스케이프
    el.innerHTML =
      '<i class="lb t"></i><i class="lb b"></i>' +
      `<div class="deco3">${f.deco}</div>` +
      `<span class="stamp3" style="color:${lbl.color}">${esc(lbl.en)}</span>` +
      `<div class="news3"><b>${esc(f.lb)}</b><p>${esc(info.cap)}</p></div>` +
      `<p class="res3">${esc(f.n)} · 조회수 ${esc(fmtViews(views))}</p>` +
      `<p class="hint3">${auto ? '잠시 후 다시 출근' : '탭해서 다시 출근하기'}</p>`;
    el.hidden = false;
  });
  bus.on('reset', () => { el.hidden = true; el.innerHTML = ''; });
}
