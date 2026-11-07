// WebGL 렌더러: 두 패스(거리 → 깊이 지움 → 뒷통수), 수평 화각 고정 리사이즈, 화면 투영·지면 교점.
import { Plane, Raycaster, Vector2, Vector3, WebGLRenderer, LinearSRGBColorSpace } from 'three';
import type { PerspectiveCamera } from 'three';
import type { World } from './world';
import { PALETTE } from './materials';
import { CFG } from '../config';

export interface View {
  /** 캔버스 CSS 픽셀 크기. */
  readonly w: number;
  readonly h: number;
  /** 월드 좌표 → 캔버스 CSS 픽셀(좌상단 기준). */
  toScreen(x: number, y: number, z: number): [number, number];
  /** 화면 점에서 지면(y=0)으로 쏜 광선의 교점. 하늘을 가리키면 null. */
  groundAt(px: number, py: number): Vector3 | null;
}

export interface GameRenderer {
  readonly view: View;
  /** 캔버스 크기에 맞춰 버퍼·화각을 다시 잡는다. 크기가 0이면 false. */
  resize(): boolean;
  draw(): void;
}

/** 수평 화각을 고정하고 세로 화각을 화면비에 맞춘다(폰 비율이 달라도 3차선이 꽉 차게). */
function fitCam(c: PerspectiveCamera, aspect: number): void {
  c.aspect = aspect;
  c.fov = 2 * Math.atan(Math.tan(CFG.camera.hfovDeg / 2 * Math.PI / 180) / aspect) * 180 / Math.PI;
  c.updateProjectionMatrix();
}

export function createRenderer(canvas: HTMLCanvasElement, world: World): GameRenderer {
  const R = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  R.outputColorSpace = LinearSRGBColorSpace;
  R.setClearColor(PALETTE.sky);
  const size = { w: 300, h: 533 };
  const V3 = new Vector3(), ndc = new Vector2(), ray = new Raycaster(), GP = new Plane(new Vector3(0, 1, 0), 0), hit = new Vector3();
  const view: View = {
    get w() { return size.w; },
    get h() { return size.h; },
    toScreen(x, y, z) {
      V3.set(x, y, z).project(world.cam);
      return [(V3.x + 1) / 2 * size.w, (1 - V3.y) / 2 * size.h];
    },
    groundAt(px, py) {
      ndc.set(px / size.w * 2 - 1, -(py / size.h * 2 - 1));
      ray.setFromCamera(ndc, world.cam);
      return ray.ray.intersectPlane(GP, hit);
    },
  };
  return {
    view,
    resize() {
      // CSS 변형(프리즈 확대)에 영향받지 않는 레이아웃 크기를 쓴다.
      const w = canvas.clientWidth, h = canvas.clientHeight;
      if (!w || !h) return false;
      size.w = w; size.h = h;
      R.setPixelRatio(Math.min(CFG.render.maxDpr, window.devicePixelRatio || 1));
      R.setSize(w, h, false);
      fitCam(world.cam, w / h);
      fitCam(world.headLayer.cam, w / h);
      world.headLayer.layout();
      return true;
    },
    draw() {
      R.autoClear = true;
      R.render(world.scene, world.cam);
      R.autoClear = false;
      R.clearDepth();
      R.render(world.headLayer.scene, world.headLayer.cam);
      R.autoClear = true;
    },
  };
}
