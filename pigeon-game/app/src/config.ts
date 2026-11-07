// 플레이테스트로 바꿀 수치는 전부 여기 모은다(기획서 v0.2 · 패널 튜닝값 · 리뷰 반영값).
export const CFG = {
  route: { meters: 1000, runSec: 58, gameSec: 180, worldSpeed: 6.4 },
  lane: { width: 1.3, count: 3 },
  camera: { height: 2.1, z: 1.0, lookY: 0, lookZ: -5, hfovDeg: 40, maxRoll: 0.026, headTilt: 0.14, follow: 9 },
  head: { dist: 2.2, scale: 0.74, topLine: 0.66 },
  fog: { near: 17, far: 46 },
  spawn: { z: -34, firstAfter: 1.6, base: 1.3, min: 0.62, jitter: 0.35, accel: 0.012 },
  reach: { far: -8, near: -2.4 },
  collide: { far: -1.6, near: -0.4, halfWidth: 0.62 },
  input: {
    padBottom: 0.84, edgeBand: 0.16, edgeIgnorePx: 16, hudTop: 0.12,
    holdConfirmMs: 180, holdConfirmLiveMs: 200, moveConfirmPx: 10, moveConfirmLivePx: 14, slowSpeed: 1.0,
    flickMs: 180, flickPx: 30, flickSpeed: 0.7, horizRatio: 1.5, flickDeferMs: 150,
    tapMs: 180, tapPx: 10, emptyTapMs: 250, emptyTapPx: 30, swipePx: 34,
    fingerLiftPx: 70, liftRampPx: 40,
    hitMinPx: 22, hitMaxPx: 48, hitGoldMaxPx: 60, hitScale: 1.3, hitGoldScale: 1.5, farHitPx: 26,
  },
  hold: { worldSlow: 0.6, slowFor: 1.2, recover: 0.3, maxSpeed: 9, fatFollow: 2.4, fatMaxSpeed: 1.4, follow: 16, yawnFollow: 5,
    adoptShowAt: 1.0, adoptAt: 2.5, stillPx: 5, stillMs: 100, shakeReversals: 4, shakeWindowMs: 600, liftHeight: 0.55, fatLift: 0.1 },
  drop: { outX: 2.1, parkX: 2.45, laneStay: 2.5, followReturn: 0.6, headRadiusPx: 64, headY: 0.87 },
  combo: { tap: 1, lane: 1, park: 2, shuttleEvery: 3, confirmViews: 310, confirmBonusSec: 1.2 },
  checkpoints: [0.3, 0.62],
  tower: { from: 0.7, startZ: -66, travel: 52 },
  views: { mult: { common: 1, rare: 2, epic: 4, legendary: 10 } as Record<string, number>, firstTime: 3, goldMult: 2, specialCombo: 8 },
  freezeSec: 0.5, autoRestartSec: 3.4, cutTapAfter: 0.6,
  render: { maxDpr: 2 },
} as const;
export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
