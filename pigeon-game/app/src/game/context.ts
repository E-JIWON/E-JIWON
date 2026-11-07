// 게임 모듈들이 공유하는 문맥. st 는 새 런마다 통째로 바뀌므로 항상 ctx.st 로 읽는다.
import type { Bus, GameEvents } from './events';
import type { Mode, RunState } from './state';
import type { View } from '../render/renderer';
import type { World } from '../render/world';
import type { PigeonPool } from '../render/pigeonModel';

export interface GameCtx {
  st: RunState;
  readonly view: View;
  readonly world: World;
  readonly pool: PigeonPool;
  readonly bus: Bus<GameEvents>;
  mode(): Mode;
}
