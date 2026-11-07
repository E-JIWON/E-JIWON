// 공용 지오메트리·툰 재질·외곽선(인버티드 헐)·part() 도우미.
import {
  BackSide, BoxGeometry, DirectionalLight, HemisphereLight, CanvasTexture, CircleGeometry, ConeGeometry, CylinderGeometry, EdgesGeometry,
  IcosahedronGeometry, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial, MeshToonMaterial,
  NearestFilter, NoColorSpace, Object3D, PlaneGeometry, SphereGeometry, ColorManagement,
} from 'three';
import type { BufferGeometry, Material } from 'three';

// 원본(r128)과 같은 색: 색 관리 끄고(16진 색을 그대로) 출력도 선형 → 감마 공간 툰 계단과 같은 결과.
ColorManagement.enabled = false;

/** 아트 팔레트(원본 C 그대로). */
export const PALETTE = {
  sky: '#FFE3C6', ink: '#2A2633',
  pigeon: '#7686A3', pigeonD: '#5C6985', pigeonL: '#AEB8CD', neckG: '#46B48E', neckP: '#9270CF',
  eye: '#F28C28', beak: '#3A3440', feet: '#E88A9A',
  gold: '#F5B700', goldD: '#C98800', goldL: '#FFE27A',
  hair: '#2E2A38', skin: '#F2C29C', jacket: '#3C4A66',
  curb: '#D4CABC', grass: '#B9D3A0', court: '#E6DACA', trunk: '#8B6448', leaf: '#83BF72', bench: '#B07A4F',
} as const;

/** 외곽선 헐 배율(원본 1.1). */
const OUTLINE_SCALE = 1.1;
/** 툰 3단 밝기(어두움·중간·밝음). */
const TOON_STEPS = ['#5e5e5e', '#b4b4b4', '#ffffff'];

/** 단위 크기 공용 지오메트리(스케일로 모양을 만든다). */
export const GEO = {
  sph: new SphereGeometry(1, 18, 14),
  box: new BoxGeometry(1, 1, 1),
  cyl: new CylinderGeometry(1, 1, 1, 12),
  cone: new ConeGeometry(1, 1, 12),
  circ: new CircleGeometry(1, 24),
  plane: new PlaneGeometry(1, 1),
  ico: new IcosahedronGeometry(1, 0),
};
const EDGE_BOX = new EdgesGeometry(GEO.box);

/** 툰 그라데이션 맵: 색 데이터가 아니라 밝기 계단이므로 NoColorSpace + Nearest. */
export const GRADIENT: CanvasTexture = (() => {
  const c = document.createElement('canvas');
  c.width = TOON_STEPS.length; c.height = 1;
  const x = c.getContext('2d')!;
  TOON_STEPS.forEach((col, i) => { x.fillStyle = col; x.fillRect(i, 0, 1, 1); });
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.minFilter = NearestFilter; t.magFilter = NearestFilter; t.generateMipmaps = false;
  return t;
})();

const TOON_CACHE = new Map<string, MeshToonMaterial>();
/** 색 하나당 툰 재질 하나(캐시). */
export function toon(col: string): MeshToonMaterial {
  let m = TOON_CACHE.get(col);
  if (!m) { m = new MeshToonMaterial({ color: col, gradientMap: GRADIENT }); TOON_CACHE.set(col, m); }
  return m;
}

/** 텍스처를 입힌 툰 재질(캐시하지 않음). */
export function toonMap(map: CanvasTexture, color = '#FFFFFF'): MeshToonMaterial {
  return new MeshToonMaterial({ color, map, gradientMap: GRADIENT });
}

/** 외곽선 헐 기본 재질. 비둘기는 이 재질을 복제해 개별 색(손 닿음 하이라이트)을 쓴다. */
export const OUTLINE = new MeshBasicMaterial({ color: PALETTE.ink, side: BackSide });
const EDGE_LINE = new LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.5 });
/** 바닥 그림자 원판 재질. */
export const SHADOW = new MeshBasicMaterial({ color: 0x2a2633, transparent: true, opacity: 0.2, depthWrite: false });

/**
 * 단위 지오메트리로 조각 하나를 만든다(원본 part).
 * col 이 문자열이면 툰 재질, 아니면 주어진 재질. ol=true 면 인버티드 헐 외곽선을 자식으로 붙인다.
 */
export function part(
  geo: BufferGeometry, col: string | Material,
  sx: number, sy: number, sz: number, x: number, y: number, z: number,
  ol: boolean, parent?: Object3D | null,
): Mesh {
  const m = new Mesh(geo, typeof col === 'string' ? toon(col) : col);
  m.scale.set(sx, sy, sz); m.position.set(x, y, z);
  if (ol) { const o = new Mesh(geo, OUTLINE); o.scale.setScalar(OUTLINE_SCALE); m.add(o); }
  if (parent) parent.add(m);
  return m;
}

/** 상자 메시에 맞춘 모서리 선(만화풍 윤곽). */
export function edged(mesh: Mesh, parent: Object3D): LineSegments {
  const e = new LineSegments(EDGE_BOX, EDGE_LINE);
  e.scale.copy(mesh.scale); e.position.copy(mesh.position); e.rotation.copy(mesh.rotation);
  parent.add(e);
  return e;
}

/** 거리·뒷통수 공용 조명. r155+ 물리 단위라 원본(r128 레거시) 밝기에 맞춰 강도에 π 를 곱한다. */
const LIGHT = {
  hemiSky: '#FFF4E6', hemiGround: '#BBA996', hemi: 0.64,
  sun: '#FFFFFF', sunI: 0.46, sunPos: [-4, 8, 5] as const,
  back: '#FFD9B0', backI: 0.18, backPos: [0, 3, -12] as const,
};
export function addLights(scene: Object3D): void {
  scene.add(new HemisphereLight(LIGHT.hemiSky, LIGHT.hemiGround, LIGHT.hemi * Math.PI));
  const sun = new DirectionalLight(LIGHT.sun, LIGHT.sunI * Math.PI);
  sun.position.set(...LIGHT.sunPos);
  scene.add(sun);
  const back = new DirectionalLight(LIGHT.back, LIGHT.backI * Math.PI);
  back.position.set(...LIGHT.backPos);
  scene.add(back);
}
