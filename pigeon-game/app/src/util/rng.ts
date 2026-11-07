// 시드 RNG. 원본 프로토타입의 선형 합동식(seed*9301+49297)%233280 을 그대로 쓴다(재현성 유지).

const MUL = 9301;
const ADD = 49297;
const MOD = 233280;

export interface Rng {
  /** 현재 시드(디버그용). */
  readonly seed: number;
  /** [0, 1) 난수. */
  next(): number;
}

export function createRng(seed: number): Rng {
  let s = seed;
  return {
    get seed() { return s; },
    next() { s = (s * MUL + ADD) % MOD; return s / MOD; },
  };
}

/** 런마다 다른 시드를 주는 수열(원본: seedN = seedN*7 % 9973 + 11, 시작 1). */
export function createSeedSeq(start = 1): () => number {
  let n = start;
  return () => (n = (n * 7) % 9973 + 11);
}
