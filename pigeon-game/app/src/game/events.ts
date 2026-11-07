// 아주 작은 타입 있는 이벤트 버스. 게임 로직 → UI·오디오는 이것으로만 알린다(동기 호출).
import type { SfxName, SfxOpts } from '../audio/sfx';
import type { FailInfo } from './state';

/** 말풍선 핸들: UI 가 만든 뒤 remove 를 채워 준다(입력 쪽에서 '구?' 보류 말풍선을 지울 때 사용). */
export interface BubbleHandle { remove(): void }

export interface GameEvents {
  /** 효과음 한 번. */
  sfx: { name: SfxName; opts?: SfxOpts };
  /** 배경 음악 제어. */
  music: { cmd: 'start' } | { cmd: 'stop' } | { cmd: 'tempo'; mult: number };
  /** 떠오르는 큰 글자(캔버스 CSS 픽셀 좌표). */
  toast: { text: string; color: string; x: number; y: number; size: number };
  /** 비둘기 말풍선(캔버스 CSS 픽셀 좌표, 아래 중앙 기준). */
  bubble: { x: number; y: number; text: string; handle: BubbleHandle };
  /** 들고 있는 중(가장자리 화단 띠 표시). false 면 가장자리 강조도 끈다. */
  holding: boolean;
  /** 손가락이 가장자리 띠 위(-1 왼쪽, 1 오른쪽, 0 아님). */
  edge: number;
  /** 정 게이지(null 이면 숨김). ratio 0~1. */
  heart: { x: number; y: number; ratio: number } | null;
  /** 참사 프리즈 시작. */
  freeze: FailInfo;
  /** 컷신 표시. */
  cut: { info: FailInfo; views: number; auto: boolean };
  /** 새 런(화면 정리). */
  reset: null;
  /** 자동 데모 유령 손가락(null 이면 숨김). */
  ghost: { x: number; y: number } | null;
}

type Handler<T> = (payload: T) => void;

export interface Bus<E> {
  on<K extends keyof E>(key: K, h: Handler<E[K]>): () => void;
  emit<K extends keyof E>(key: K, payload: E[K]): void;
}

export function createBus<E>(): Bus<E> {
  const map = new Map<keyof E, Set<Handler<never>>>();
  return {
    on(key, h) {
      let set = map.get(key);
      if (!set) { set = new Set(); map.set(key, set); }
      set.add(h as Handler<never>);
      return () => { set.delete(h as Handler<never>); };
    },
    emit(key, payload) {
      const set = map.get(key);
      if (set) for (const h of set) (h as Handler<typeof payload>)(payload);
    },
  };
}
