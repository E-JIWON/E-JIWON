// 비둘기 모델: makePigeon(type) + animatePigeon(포즈) + 풀(재사용).
// 들린 자세 = 방석 위 식빵 자세(다리 숨김·날개 접음·고개 두리번), 잡는 순간 0.3초 끄덕, 선 눈.
import { Group, Mesh, MeshBasicMaterial, Sprite, SpriteMaterial } from 'three';
import type { Object3D, Scene } from 'three';
import { GEO, OUTLINE, PALETTE, SHADOW, part } from './materials';
import { iconTex, sparkMat } from './textures';
import { PIGEONS } from '../content/pigeons';
import type { PigeonType } from '../content/pigeons';
import { CFG } from '../config';
import { clamp, followK } from '../util/math';

export type PigPose = 'walk' | 'held' | 'drop' | 'parked';

export interface PigeonModel {
  root: Group;
  type: PigeonType;
  /** 들어 올리는 부분(그림자 제외 전부). */
  lift: Group;
  head: Group;
  wings: [Group, Group];
  legs: Group;
  /** 노란 방석(들렸을 때만 보임). */
  cush: Mesh;
  shadow: Mesh;
  shBase: number;
  icon: Sprite | null;
  spark: Sprite[] | null;
  /** 이 비둘기 전용 외곽선 재질(손 닿는 거리면 흰색). */
  olMat: MeshBasicMaterial;
  /** 애니메이션 위상. */
  ph: number;
  /** 끄덕 남은 시간(초). */
  nodT: number;
  /** 고개 돌림(라디안, 구구 변칙 예고). */
  turn: number;
}

/* 아트 상수 */
const SCALE = 1.2;               // 거리 위 비둘기 크기 배율
const FAT_W = 1.38;              // 닭둘기 몸 폭 배율
const NOD_SEC = 0.3;             // 잡는 순간 끄덕 시간
const NOD_AMP = 0.32;
const LIFT_UP_K = 12;            // 들릴 때 추종 속도
const LIFT_DOWN_K = 4.5;         // 내려놓을 때
const UP_EPS = 0.04;             // 이 높이 넘으면 '들린 자세'
const ICON_Y = 0.95;
const ICON_FADE_FROM = -30;      // 아이콘이 나타나기 시작하는 z
const ICON_FADE_LEN = 12;
const HIGHLIGHT = '#FFFFFF';
const CHAT_SCREEN = new MeshBasicMaterial({ color: '#8FD3FF' });
/** 잡는 순간 끄덕 시간(초). */
export const NOD_TIME = NOD_SEC;

export function makePigeon(type: PigeonType): PigeonModel {
  const root = new Group();
  const gold = type === 'gold', fat = type === 'fat', bw = fat ? FAT_W : 1;
  const C = PALETTE;
  const cB = gold ? C.gold : C.pigeon, cD = gold ? C.goldD : C.pigeonD, cL = gold ? C.goldL : C.pigeonL;
  const shadow = new Mesh(GEO.circ, SHADOW);
  shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.014;
  const shBase = fat ? 0.36 : 0.26;
  shadow.scale.setScalar(shBase); root.add(shadow);
  const lift = new Group(); root.add(lift);
  part(GEO.sph, cB, 0.2 * bw, 0.19 * (fat ? 1.05 : 1), 0.23, 0, 0.24, 0, true, lift);
  part(GEO.sph, cL, 0.14 * bw, 0.13, 0.09, 0, 0.22, 0.15, false, lift);
  part(GEO.sph, gold ? '#FFC933' : C.neckP, 0.13 * (fat ? 1.18 : 1), 0.1, 0.12, 0, 0.37, 0, true, lift);
  part(GEO.sph, gold ? '#FFE27A' : C.neckG, 0.105 * (fat ? 1.18 : 1), 0.08, 0.07, 0, 0.37, 0.068, false, lift);
  const head = new Group(); head.position.set(0, 0.5, 0.05); lift.add(head);
  part(GEO.sph, cB, 0.115, 0.11, 0.115, 0, 0, 0, true, head);
  for (const s of [-1, 1]) {
    part(GEO.sph, C.eye, 0.03, 0.016, 0.012, s * 0.066, 0, 0.099, false, head);
    // 선 눈(눈꺼풀 반쯤 감은 무표정)
    const ln = part(GEO.sph, C.ink, 0.043, 0.0095, 0.012, s * 0.066, 0.011, 0.106, false, head);
    ln.rotation.z = s * -0.12;
  }
  const bk = part(GEO.cone, C.beak, 0.026, 0.08, 0.026, 0, -0.02, 0.135, false, head); bk.rotation.x = Math.PI / 2;
  part(GEO.sph, '#F1EEF5', 0.024, 0.014, 0.02, 0, 0.008, 0.113, false, head);
  const wings: Group[] = [];
  for (const s of [-1, 1]) {
    const pv = new Group(); pv.position.set(s * 0.175 * bw, 0.34, -0.01); lift.add(pv);
    part(GEO.sph, cD, 0.06, 0.16, 0.2, s * 0.015, -0.1, -0.02, true, pv);
    wings.push(pv);
  }
  const tl = part(GEO.box, cD, 0.17, 0.035, 0.22, 0, 0.2, -0.28, true, lift); tl.rotation.x = -0.4;
  const cush = part(GEO.cyl, '#FFD23F', 0.27 * bw, 0.05, 0.25, 0, 0.025, 0, true, lift); cush.visible = false;
  const legs = new Group(); lift.add(legs);
  for (const s of [-1, 1]) {
    part(GEO.cyl, C.feet, 0.017, 0.06, 0.017, s * 0.06, 0.055, 0.02, false, legs);
    part(GEO.sph, C.feet, 0.035, 0.012, 0.05, s * 0.06, 0.012, 0.05, false, legs);
  }
  if (type === 'follow') {
    // 깃털 하나 + 테이크아웃 커피
    const f = part(GEO.cone, C.pigeonD, 0.022, 0.14, 0.022, 0.02, 0.16, 0, false, head); f.rotation.z = -0.5;
    const cup = new Group(); cup.position.set(0.25, 0.3, 0.1); lift.add(cup);
    part(GEO.cyl, '#FFFFFF', 0.045, 0.11, 0.045, 0, 0, 0, true, cup);
    part(GEO.cyl, '#6B3E26', 0.047, 0.03, 0.047, 0, 0.012, 0, false, cup);
    const s2 = part(GEO.cyl, '#D7263D', 0.008, 0.09, 0.008, 0.015, 0.09, 0, false, cup); s2.rotation.z = -0.3;
  }
  if (type === 'live') {
    // 셀카봉 + 폰 + 링라이트
    const stick = part(GEO.cyl, '#2A2633', 0.012, 0.75, 0.012, 0.27, 0.62, 0.13, false, lift); stick.rotation.z = -0.32; stick.rotation.x = 0.25;
    const ph = part(GEO.box, '#2A2633', 0.12, 0.18, 0.022, 0.39, 0.98, 0.23, true, lift); ph.rotation.y = -0.35;
    const ring = part(GEO.sph, '#FFF7C2', 0.05, 0.05, 0.02, 0.47, 1.01, 0.2, true, lift); ring.rotation.y = -0.35;
  }
  if (type === 'chat') {
    // 폰 보며 걷는 단톡구
    const ph = part(GEO.box, '#2A2633', 0.085, 0.14, 0.016, -0.23, 0.32, 0.15, true, lift); ph.rotation.z = 0.3;
    const sc = new Mesh(GEO.plane, CHAT_SCREEN); sc.scale.set(0.78, 0.8, 1); sc.position.z = 0.6; ph.add(sc);
  }
  let spark: Sprite[] | null = null;
  if (gold) {
    // 왕관 + 반짝이
    const cr = new Group(); cr.position.set(0, 0.115, 0); head.add(cr);
    part(GEO.cyl, '#FFE27A', 0.075, 0.04, 0.075, 0, 0, 0, true, cr);
    for (let k = 0; k < 5; k++) {
      const a = k / 5 * Math.PI * 2;
      part(GEO.cone, '#FFE27A', 0.022, 0.065, 0.022, Math.cos(a) * 0.06, 0.05, Math.sin(a) * 0.06, false, cr);
    }
    spark = [];
    for (let k = 0; k < 4; k++) { const sp = new Sprite(sparkMat()); sp.scale.set(0.1, 0.1, 1); lift.add(sp); spark.push(sp); }
  }
  const def = PIGEONS[type];
  const icon = new Sprite(new SpriteMaterial({
    map: iconTex(type, def.icon, type === 'live'), transparent: true, depthWrite: false, sizeAttenuation: false,
  }));
  icon.scale.set(0.2, 0.06, 1); icon.position.y = ICON_Y; root.add(icon);
  // 외곽선 재질을 비둘기마다 복제(하이라이트 색을 개별로 바꾸기 위해)
  const olMat = OUTLINE.clone();
  root.traverse((o: Object3D) => { if (o instanceof Mesh && o.material === OUTLINE) o.material = olMat; });
  return {
    root, type, lift, head, wings: [wings[0]!, wings[1]!], legs, cush, shadow, shBase, icon, spark, olMat,
    ph: Math.random() * 6.28, nodT: 0, turn: 0,
  };
}

/** 포즈 애니메이션. still=true 면 시간 진행(높이 추종·끄덕 감소) 없이 그 순간 자세만 맞춘다. */
export function animatePigeon(m: PigeonModel, pose: PigPose, t: number, dt: number, still: boolean): void {
  const lift = m.lift;
  const fat = m.type === 'fat';
  const held = pose === 'held';
  const want = held ? (fat ? CFG.hold.fatLift : CFG.hold.liftHeight) : 0;
  if (!still) lift.position.y += (want - lift.position.y) * followK(held ? LIFT_UP_K : LIFT_DOWN_K, dt);
  const ly = lift.position.y, up = held || ly > UP_EPS;
  m.shadow.scale.setScalar(m.shBase * Math.max(0.35, 1 - ly * 1.1));
  const wingX = fat ? -0.5 : 0;
  m.wings[0].rotation.set(wingX, 0, 0); m.wings[1].rotation.set(wingX, 0, 0);
  if (up) {
    // 방석 식빵 자세: 다리 숨김, 몸 살랑, 고개 두리번(+ 잡는 순간 끄덕)
    m.legs.visible = false; m.cush.visible = true;
    lift.rotation.z = Math.sin(t * 1.6 + m.ph) * 0.06;
    m.head.position.z = 0.05;
    let nod = 0;
    if (m.nodT > 0) { nod = Math.sin((NOD_SEC - m.nodT) / NOD_SEC * Math.PI) * NOD_AMP; if (!still) m.nodT -= dt; }
    m.head.rotation.set(nod, Math.sin(t * 1.2 + m.ph) * 0.26, 0);
  } else {
    // 걷기: 뒤뚱 + 고개 앞뒤(앉아 쉬는 중이면 고개 고정)
    m.legs.visible = true; m.cush.visible = false;
    const ph = t * 8 + m.ph;
    m.legs.rotation.x = 0;
    lift.rotation.z = Math.sin(ph * 0.5) * 0.05;
    m.head.position.z = 0.05 + (pose === 'parked' ? 0 : Math.max(0, Math.sin(ph)) * 0.035);
    m.head.rotation.set(0, m.turn, 0);
  }
  if (m.icon) m.icon.visible = pose === 'walk';
  if (m.spark) m.spark.forEach((s, i) => {
    const a = t * 2 + i * Math.PI / 2;
    s.position.set(Math.cos(a) * 0.33, 0.35 + Math.sin(t * 3 + i) * 0.08, Math.sin(a) * 0.33);
  });
}

/** 손 닿는 거리 하이라이트(흰 외곽선). */
export function setHighlight(m: PigeonModel, on: boolean): void {
  m.olMat.color.set(on ? HIGHLIGHT : PALETTE.ink);
}

/** 멀리서 아이콘이 서서히 나타나게. */
export function setIconFade(m: PigeonModel, z: number): void {
  if (m.icon) m.icon.material.opacity = clamp((z - ICON_FADE_FROM) / ICON_FADE_LEN, 0, 1);
}

/** 정수리에 얹는 황금 구구(탑승). 아이콘 없이 작게, 앞을 보게. */
export function makeRider(): PigeonModel {
  const m = makePigeon('gold');
  if (m.icon) m.icon.visible = false;
  m.root.scale.setScalar(0.42);
  m.root.rotation.y = Math.PI;
  m.root.position.set(0, 0.235, 0);
  return m;
}

export interface PigeonPool {
  get(type: PigeonType): PigeonModel;
  put(m: PigeonModel): void;
}

/** 타입별 재사용 풀. get 은 걷기 자세로 초기화해 씬에 넣는다. */
export function createPigeonPool(scene: Scene): PigeonPool {
  const bins = new Map<PigeonType, PigeonModel[]>();
  const bin = (t: PigeonType) => { let a = bins.get(t); if (!a) { a = []; bins.set(t, a); } return a; };
  return {
    get(type) {
      const m = bin(type).pop() ?? makePigeon(type);
      m.lift.position.y = 0; m.lift.rotation.set(0, 0, 0); m.turn = 0; m.nodT = 0;
      m.root.rotation.set(0, 0, 0); m.root.scale.setScalar(SCALE); m.root.visible = true;
      m.olMat.color.set(PALETTE.ink);
      scene.add(m.root);
      return m;
    },
    put(m) { scene.remove(m.root); bin(m.type).push(m); },
  };
}

