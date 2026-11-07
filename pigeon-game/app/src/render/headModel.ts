// 주인공 뒷통수: 별도 오버레이 씬(거리 위에 깊이를 지우고 덧그림). 수평 화각에 맞춰 화면 하단 중앙에 배치.
import { Group, Mesh, PerspectiveCamera, Scene, TorusGeometry } from 'three';
import type { Object3D, Vector3 } from 'three';
import { GEO, PALETTE, addLights, part, toon } from './materials';
import { CFG } from '../config';

/* 아트 상수 */
const HEAD_DROP = 0.2;      // 윗선(topLine) 아래로 머리 중심을 더 내리는 양
const BOW_X = 0.45;         // 참사 때 고개 숙임
const BOW_DY = 0.05;
const CAM_NEAR = 0.05, CAM_FAR = 10;
const INIT_Y = -1.14;       // layout() 전 임시 높이

export interface HeadLayer {
  scene: Scene;
  cam: PerspectiveCamera;
  head: Group;
  /** 화각이 바뀌면 화면 하단에 맞게 기준 높이를 다시 잡는다. */
  layout(): void;
  /** 좌우 이동 때 고개 기울기. */
  setTilt(tilt: number): void;
  /** 기본 자세로. */
  reset(): void;
  /** 참사(정면 충돌) 때 고개 푹. */
  bow(): void;
  /** 정수리에 무언가 얹기/내리기(황금 구구 탑승). */
  attach(o: Object3D): void;
  detach(o: Object3D): void;
}

function makeHead(): Group {
  const C = PALETTE;
  const g = new Group();
  g.position.set(0, INIT_Y, -CFG.head.dist);
  g.scale.setScalar(CFG.head.scale);
  part(GEO.sph, C.hair, 0.27, 0.27, 0.25, 0, 0, 0, true, g);                      // 머리통
  const hl = part(GEO.sph, '#3B3547', 0.08, 0.035, 0.05, -0.1, 0.16, 0.17, false, g); hl.rotation.z = 0.5; // 머리 윤기
  for (const s of [-1, 1]) part(GEO.sph, C.skin, 0.04, 0.066, 0.05, s * 0.262, -0.04, 0.02, true, g);     // 귀
  const ck = new Mesh(new TorusGeometry(0.06, 0.014, 6, 14, Math.PI * 1.5), toon(C.hair));               // 정수리 삐침
  ck.position.set(0.03, 0.3, 0); ck.rotation.set(0, Math.PI / 2, 0.9); g.add(ck);
  part(GEO.cyl, C.skin, 0.12, 0.22, 0.12, 0, -0.3, 0.02, false, g);                // 목
  part(GEO.sph, C.jacket, 0.42, 0.18, 0.3, 0, -0.62, 0.06, true, g);               // 어깨
  for (const s of [-1, 1]) {                                                         // 가방끈
    const st = part(GEO.box, '#D7263D', 0.022, 0.2, 0.02, s * 0.09, -0.34, 0.12, false, g);
    st.rotation.z = s * 0.25;
  }
  return g;
}

export function createHeadLayer(): HeadLayer {
  const scene = new Scene();
  const cam = new PerspectiveCamera(52, 9 / 16, CAM_NEAR, CAM_FAR);
  scene.add(cam);
  addLights(scene);
  const head = makeHead();
  cam.add(head);
  const base: Vector3 = head.position.clone();
  return {
    scene, cam, head,
    layout() {
      const th = Math.tan(cam.fov * Math.PI / 360) * CFG.head.dist;
      base.y = -(CFG.head.topLine * th) - HEAD_DROP;
      head.position.y = base.y;
    },
    setTilt(tilt) { cam.rotation.set(0, 0, 0); head.rotation.z = tilt; },
    reset() { head.rotation.set(0, 0, 0); head.position.copy(base); },
    bow() { head.rotation.x = BOW_X; head.position.y -= BOW_DY; },
    attach(o) { head.add(o); },
    detach(o) { head.remove(o); },
  };
}
