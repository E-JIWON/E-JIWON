// 비둘기 타입 정의: 머리 위 아이콘 문구, 스폰 조건, 부딪혔을 때의 참사 키.
import type { FailKey } from './fails';

export type PigeonType = 'gugu' | 'fat' | 'follow' | 'live' | 'chat' | 'gold';

export interface PigeonDef {
  /** 머리 위 아이콘 말풍선 문구(먼 거리에서 무엇을 해야 하는지 알려 줌). */
  icon: string;
  /** 정면 충돌 시 참사 키. */
  failKey: FailKey;
  /** 이름(디버그·접근성용). */
  name: string;
}

export const PIGEONS: Record<PigeonType, PigeonDef> = {
  gugu: { name: '구구', icon: '↔  ✋', failKey: 'gugu' },
  fat: { name: '닭둘기', icon: '✋ 무거움', failKey: 'fat' },
  follow: { name: '따라구', icon: '✋ 길 밖으로', failKey: 'follow' },
  live: { name: '구튜버', icon: '🚫✋', failKey: 'live' },
  chat: { name: '단톡구', icon: '↔ 피하기', failKey: 'chat' },
  gold: { name: '황금 구구', icon: '✋ → 머리 위', failKey: 'gugu' },
};

/**
 * 스폰 표: 난수 r 하나로 위에서부터 차례로 검사한다(원본 if-else 사슬과 같은 순서·임계값).
 * after = 런 시작 후 이 시간(초)이 지나야 등장, below = r 이 이 값보다 작으면 이 타입.
 * 어느 줄에도 걸리지 않으면 기본 구구.
 */
export const SPAWN_TABLE: ReadonlyArray<{ type: PigeonType; after: number; below: number }> = [
  { type: 'gold', after: 16, below: 0.06 },
  { type: 'live', after: 14, below: 0.2 },
  { type: 'follow', after: 9, below: 0.35 },
  { type: 'fat', after: 5, below: 0.5 },
  { type: 'chat', after: 20, below: 0.62 },
];

/** 구구 중 이 비율은 다가오다 고개를 돌리고 한 칸 옆으로 비켜 선다(변칙). */
export const GUGU_SHIFT_CHANCE = 0.3;

export function pickSpawnType(t: number, r: number): PigeonType {
  for (const e of SPAWN_TABLE) if (t > e.after && r < e.below) return e.type;
  return 'gugu';
}
