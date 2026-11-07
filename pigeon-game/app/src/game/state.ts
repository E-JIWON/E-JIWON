// 런 상태 타입과 newRun(). 판정·이동 수치는 config.ts(CFG), 여기는 CFG 에 없는 보조 상수만.
import type { Vector3 } from 'three';
import type { PigeonType } from '../content/pigeons';
import type { FailDef, FailKey } from '../content/fails';
import type { PigeonModel, PigPose } from '../render/pigeonModel';
import { CFG } from '../config';
import { createRng } from '../util/rng';
import type { Rng } from '../util/rng';

export type Mode = 'title' | 'auto' | 'play';
export type RunPhase = 'play' | 'freeze' | 'cut';
/** 외부(디버그 훅)에 보이는 단계. */
export type Phase = 'title' | RunPhase | 'paused';

/* CFG 에 없는 보조 상수(원본 프로토타입 값) */
/** 첫 스폰 타이머(초). */
export const FIRST_SPAWN_TIMER = 1.2;
/** 경로 진행 속도 = 경로/(runSec + 이 값). 9시 전에 도착할 여유. */
export const ROUTE_SLACK_SEC = 3;
/** 차선 일치 허용 오차(월드 단위). */
export const LANE_TOL = 0.7;
/** 따라구가 내 차선을 다시 노리는 주기(초). */
export const FOLLOW_RETARGET = 0.45;
/** 화단으로 걸어 나갈 때 목표 x, 화단 도착으로 치는 |x|. */
export const LEAVE_X = 2.6;
export const PARKED_AT_X = 2.25;
/** 음악 빨라지는 남은 시간(초)·배율, 마지막 초읽기 시작(초). */
export const HURRY_SEC = 30;
export const HURRY_TEMPO = 1.15;
export const TICK_SEC = 10;
/** 비둘기 몸 중심 높이(화면 판정·유령 손가락 조준점). */
export const PIG_BODY_Y = 0.36;

export interface Pig {
  id: number;
  type: PigeonType;
  m: PigeonModel;
  /** m.root.position 참조. */
  pos: Vector3;
  state: PigPose;
  /** 목표 x / 목표 z(드롭 중에만). */
  tx: number;
  tz: number | null;
  /** 드롭 착지 후 상태. */
  next: PigPose;
  /** 닭둘기 박수 횟수. */
  claps: number;
  /** 따라구 재추종 타이머. */
  lag: number;
  /** 구구 변칙(고개 돌린 뒤 한 칸 비킴) 예정·완료. */
  shift: boolean;
  shifted: boolean;
  turnT: number;
  dir: number;
  /** 단톡구 초대 발동 여부. */
  chatDone: boolean;
  /** 차선에 놓임(체류 후 화단 퇴장). */
  placed: boolean;
  placedT: number;
  leaving: boolean;
  /** 내가 옮기거나 비키게 한 비둘기(부딪히면 '셀프'). */
  mine: boolean;
  /** 잡은 자리(취소 시 복귀). */
  ox: number;
  oz: number;
  /** 화단 착지 후 '★2.3 구.' 평점 말풍선. */
  rate: boolean;
}

export interface FailInfo {
  key: FailKey;
  def: FailDef;
  cap: string;
}

export interface RunState {
  t: number;
  dist: number;
  /** 게임 시계(초, 0 = 08:57:00). */
  clock: number;
  lane: number;
  camX: number;
  pigs: Pig[];
  spawn: number;
  combo: number;
  best: number;
  views: number;
  phase: RunPhase;
  held: Pig | null;
  /** 손가락이 가리키는 지면 목표. */
  drag: { x: number; z: number };
  /** 손가락 화면 좌표(오프셋 반영). */
  dpx: number;
  dpy: number;
  edge: number;
  cps: number[];
  gold: boolean;
  /** 연속 헛박수. */
  claps: number;
  shuttle: number;
  rng: Rng;
  /* 들기 */
  holdDur: number;
  adoptT: number;
  lastMove: number;
  g0: [number, number] | null;
  anc: [number, number] | null;
  rev: number[];
  lastDir: number;
  yawn: number;
  heartOn: boolean;
  /* 참사 */
  fz: number;
  cutT: number;
  fail: FailInfo | null;
  /* 오디오 상태 */
  lastTick: number;
  hurry: boolean;
}

export function newRun(seed: number): RunState {
  return {
    t: 0, dist: 0, clock: 0, lane: 0, camX: 0, pigs: [], spawn: FIRST_SPAWN_TIMER,
    combo: 0, best: 0, views: 0, phase: 'play', held: null, drag: { x: 0, z: -4 }, dpx: 0, dpy: 0, edge: 0,
    cps: [...CFG.checkpoints], gold: false, claps: 0, shuttle: 0, rng: createRng(seed),
    holdDur: 0, adoptT: 0, lastMove: 0, g0: null, anc: null, rev: [], lastDir: 0, yawn: 0, heartOn: false,
    fz: 0, cutT: 0, fail: null, lastTick: 0, hurry: false,
  };
}

/** 경로 진행 속도(m/s, 들기 둔화 전). */
export const routeSpeed = (): number => CFG.route.meters / (CFG.route.runSec + ROUTE_SLACK_SEC);
/** 게임 시계 배속(게임 초 / 실제 초). */
export const clockRate = (): number => CFG.route.gameSec / CFG.route.runSec;
