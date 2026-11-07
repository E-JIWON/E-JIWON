// 효과음 인터페이스(계약). 1단계 오디오 담당이 구현을 채운다. 게임 코드는 이 인터페이스만 쓴다.
export type SfxName =
  | 'swipe' | 'bump' | 'clap' | 'clapMiss' | 'coo' | 'cooLow' | 'cooHigh'
  | 'grabPending' | 'grab' | 'drop' | 'park' | 'lane' | 'block' | 'yawn' | 'heart'
  | 'comboConfirm' | 'goldAppear' | 'ride' | 'chatPing'
  | 'freeze' | 'stingCommon' | 'stingRare' | 'stingEpic' | 'stingLegend'
  | 'tick' | 'uiTap' | 'start';

export interface SfxOpts { pan?: number; pitch?: number; volume?: number }

export interface Sfx {
  /** 첫 사용자 입력 핸들러 안에서 호출(iOS 오디오 잠금 해제). 여러 번 불러도 안전. */
  unlock(): void;
  play(name: SfxName, opts?: SfxOpts): void;
  /** 배경 루프(로파이 출근 행진). 템포 배율은 1 기본, 9시 임박 시 1.15. */
  startMusic(): void;
  stopMusic(): void;
  setTempo(mult: number): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /** 앱 전환 후 복귀 시 AudioContext 재개. */
  resume(): void;
}

export function createSfx(): Sfx {
  let muted = false;
  return {
    unlock() {}, play() {}, startMusic() {}, stopMusic() {}, setTempo() {},
    setMuted(m: boolean) { muted = m; }, get muted() { return muted; }, resume() {},
  };
}
