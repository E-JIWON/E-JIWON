// 거리: 보도·연석·화단·건물(재활용 소품 루프)·가로수·가로등·벤치·원경·구구타워·횡단보도·드롭 링·안개·조명.
import { Color, Fog, Group, Mesh, MeshBasicMaterial, PerspectiveCamera, RingGeometry, Scene } from 'three';
import { GEO, PALETTE, addLights, edged, part, toon, toonMap } from './materials';
import { SHOPS, awningTex, facadeTex, frontTex, repeatClone, roadTex, signTex } from './textures';
import { createHeadLayer } from './headModel';
import type { HeadLayer } from './headModel';
import { CFG } from '../config';
import { createRng } from '../util/rng';

/* 아트 상수(배치·치수) */
const ROAD_LEN = 96, ROAD_Z = -44;            // 보도 길이·중심 z
const LOOP = 88;                               // 소품 재활용 루프 길이
const PROP_START = 7, PROP_RESET = 9;          // 소품 시작 z, 이 z 를 넘으면 루프 뒤로
const CURB_X = 2.04, GRASS_X = 2.81, COURT_X = 4.1, BLDG_X = 4.72;
const TREE_X = 2.86, LAMP_X = 2.3, BENCH_X = 3.2;
const CAM_NEAR = 0.05, CAM_FAR = 140;
const CROSS_STRIPES = 6;

/** 드롭 링 색(판정 미리보기). */
export type RingKind = 'out' | 'lane' | 'block' | 'head';
const RING_COLOR: Record<RingKind, string> = { out: '#23C29A', lane: '#FFD23F', block: '#E8473C', head: '#F5B700' };

export interface Crosswalk { group: Group; done: boolean }

export interface World {
  scene: Scene;
  cam: PerspectiveCamera;
  headLayer: HeadLayer;
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  tower: Group;
  crosswalks: Crosswalk[];
  crosswalk(z: number): Crosswalk;
  clearCross(): void;
  /** 세상을 dz 만큼 앞(+z)으로 흘린다. */
  advance(dz: number): void;
  /** 카메라 x·롤, 뒷통수 기울기. */
  setCam(x: number, roll: number, tilt: number): void;
  setRing(kind: RingKind, x: number, z: number): void;
}

export function buildWorld(seed: number): World {
  const rng = createRng(seed), rnd = () => rng.next();
  const C = PALETTE;
  const scene = new Scene();
  scene.background = new Color(C.sky);
  scene.fog = new Fog(C.sky, CFG.fog.near, CFG.fog.far);
  const cam = new PerspectiveCamera(52, 9 / 16, CAM_NEAR, CAM_FAR);
  scene.add(cam);
  addLights(scene);

  const flat = (col: string, w: number, l: number, x: number, y: number, z: number) => {
    const m = new Mesh(GEO.plane, toon(col));
    m.scale.set(w, l, 1); m.rotation.x = -Math.PI / 2; m.position.set(x, y, z);
    scene.add(m);
    return m;
  };
  flat('#DACDBA', 70, 160, 0, -0.02, -60);

  // 3차선 보도(텍스처 한 장 = 차선 3개, 길이 방향 반복)
  const roadW = CFG.lane.width * CFG.lane.count;
  const rt = repeatClone(roadTex(), 1, ROAD_LEN / roadW);
  const road = new Mesh(GEO.plane, toonMap(rt));
  road.scale.set(roadW, ROAD_LEN, 1); road.rotation.x = -Math.PI / 2; road.position.set(0, 0, ROAD_Z);
  scene.add(road);
  for (const s of [-1, 1]) {
    const cb = part(GEO.box, C.curb, 0.18, 0.14, ROAD_LEN, s * CURB_X, 0.07, ROAD_Z, false, scene); edged(cb, scene);
    flat(C.grass, 1.36, ROAD_LEN, s * GRASS_X, 0.012, ROAD_Z);   // 화단
    flat(C.court, 1.25, ROAD_LEN, s * COURT_X, 0.008, ROAD_Z);   // 건물 앞 마당
  }

  const props: Group[] = [];
  const FACADE = facadeTex();
  for (const s of [-1, 1]) {
    // 건물 줄(3채마다 쇼윈도·차양·간판)
    let z = PROP_START, n = 0;
    while (z > PROP_START - LOOP) {
      const len = 3.4 + rnd() * 3.4, dep = 2.6 + rnd() * 2.4, hgt = 3.2 + rnd() * 8, b = new Group();
      const t = repeatClone(FACADE[Math.floor(rnd() * FACADE.length)]!, len / 3.2, hgt / 3.2);
      const m = new Mesh(GEO.box, toonMap(t));
      m.scale.set(dep, hgt, len); m.position.set(0, hgt / 2, 0); b.add(m); edged(m, b);
      if (n % 3 === 1) {
        const face = -s * dep / 2 - s * 0.012, ry = s < 0 ? Math.PI / 2 : -Math.PI / 2;
        const fr = new Mesh(GEO.plane, toonMap(frontTex()));
        fr.scale.set(len * 0.86, 2.1, 1); fr.position.set(face, 1.05, 0); fr.rotation.y = ry; b.add(fr);
        const aw = new Mesh(GEO.box, toonMap(awningTex()));
        aw.scale.set(0.9, 0.06, len * 0.9); aw.position.set(face - s * 0.42, 2.3, 0); aw.rotation.z = s * -0.35; b.add(aw); edged(aw, b);
        const sg = new Mesh(GEO.plane, new MeshBasicMaterial({ map: signTex(SHOPS[(n + (s > 0 ? 3 : 0)) % SHOPS.length]!, '#FFFDF6', C.ink) }));
        sg.scale.set(Math.min(len * 0.8, 3.2), 0.8, 1); sg.position.set(face - s * 0.01, 2.95, 0); sg.rotation.y = ry; b.add(sg);
      }
      b.position.set(s * (BLDG_X + dep / 2), 0, z - len / 2);
      scene.add(b); props.push(b);
      z -= len + 0.22; n++;
    }
    // 가로수(화분 + 줄기 + 다면체 잎)
    for (let tz = 1.5; tz > PROP_START - LOOP; tz -= 7.2) {
      const tr = new Group();
      const pb = part(GEO.box, '#C9B49A', 0.72, 0.26, 0.72, 0, 0.13, 0, false, tr); edged(pb, tr);
      part(GEO.cyl, C.trunk, 0.07, 1.1, 0.07, 0, 0.75, 0, true, tr);
      const cn = part(GEO.ico, C.leaf, 0.62, 0.58, 0.62, 0, 1.62, 0, true, tr); cn.rotation.y = rnd() * 3;
      tr.position.set(s * TREE_X, 0, tz - rnd() * 1.6);
      scene.add(tr); props.push(tr);
    }
    // 가로등
    for (let lz = -2.5; lz > PROP_START - LOOP; lz -= 14.4) {
      const lp = new Group();
      part(GEO.cyl, '#5C6478', 0.045, 3.1, 0.045, 0, 1.55, 0, true, lp);
      part(GEO.box, '#5C6478', 0.5, 0.05, 0.05, -s * 0.22, 3.05, 0, false, lp);
      const bulb = new Mesh(GEO.sph, new MeshBasicMaterial({ color: '#FFF2C8' }));
      bulb.scale.setScalar(0.11); bulb.position.set(-s * 0.45, 2.97, 0); lp.add(bulb);
      lp.position.set(s * LAMP_X, 0, lz);
      scene.add(lp); props.push(lp);
    }
    // 벤치
    for (let bz = -6; bz > PROP_START - LOOP; bz -= 21.6) {
      const bn = new Group();
      const seat = part(GEO.box, C.bench, 0.46, 0.06, 1.3, 0, 0.42, 0, false, bn); edged(seat, bn);
      const back = part(GEO.box, C.bench, 0.06, 0.34, 1.3, s * 0.22, 0.66, 0, false, bn); edged(back, bn);
      for (const zz of [-0.55, 0.55]) part(GEO.box, '#5C6478', 0.4, 0.4, 0.05, 0, 0.2, zz, false, bn);
      bn.position.set(s * BENCH_X, 0, bz);
      scene.add(bn); props.push(bn);
    }
  }
  // 원경 빌딩 줄
  for (let k = 0; k < 9; k++) {
    const w = 5 + rnd() * 8, h = 9 + rnd() * 16;
    const m = part(GEO.box, ['#F2CDB0', '#EDC2A0', '#F5D8C0'][k % 3]!, w, h, 4, -26 + k * 6.5, h / 2, -74 - rnd() * 6, false, scene);
    edged(m, scene);
  }
  // 구구타워(회사). 진행 70%부터 다가온다.
  const tower = new Group();
  {
    const t = repeatClone(FACADE[3]!, 7 / 3.2, 18 / 3.2);
    const m = new Mesh(GEO.box, toonMap(t)); m.scale.set(7.4, 18, 5); m.position.set(0, 9, -2.5); tower.add(m); edged(m, tower);
    const sg = new Mesh(GEO.plane, new MeshBasicMaterial({ map: signTex('구구타워', '#2A2633', '#FFD23F') }));
    sg.scale.set(3.6, 0.9, 1); sg.position.set(0, 3.4, 0.02); tower.add(sg);
    const dr = new Mesh(GEO.plane, toonMap(frontTex())); dr.scale.set(3.2, 2.4, 1); dr.position.set(0, 1.2, 0.02); tower.add(dr);
    tower.visible = false;
    scene.add(tower);
  }
  const headLayer = createHeadLayer();

  // 드롭 링(놓을 자리 미리보기)
  const ring = new Mesh(new RingGeometry(0.3, 0.42, 40), new MeshBasicMaterial({ color: RING_COLOR.out, transparent: true, opacity: 0.95, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2; ring.position.y = 0.03; ring.visible = false;
  scene.add(ring);

  const crosswalks: Crosswalk[] = [];
  function crosswalk(z: number): Crosswalk {
    const g = new Group();
    for (let k = 0; k < CROSS_STRIPES; k++) {
      const m = new Mesh(GEO.plane, toon('#FFFFFF'));
      m.scale.set(3.6, 0.42, 1); m.rotation.x = -Math.PI / 2; m.position.set(0, 0.006, -k * 0.8); g.add(m);
    }
    part(GEO.cyl, '#5C6478', 0.05, 2.6, 0.05, 2.25, 1.3, -4.4, true, g);   // 신호등 기둥
    part(GEO.box, '#2A2633', 0.3, 0.62, 0.22, 2.25, 2.7, -4.4, true, g);   // 신호등 함
    const red = new Mesh(GEO.sph, new MeshBasicMaterial({ color: '#FF4A4A' }));
    red.scale.setScalar(0.09); red.position.set(2.25, 2.85, -4.28); g.add(red);
    g.position.z = z;
    scene.add(g);
    const c: Crosswalk = { group: g, done: false };
    crosswalks.push(c);
    return c;
  }
  function clearCross() { crosswalks.forEach((c) => scene.remove(c.group)); crosswalks.length = 0; }
  function advance(dz: number) {
    rt.offset.y += dz / roadW;
    for (const p of props) { p.position.z += dz; if (p.position.z > PROP_RESET) p.position.z -= LOOP; }
    for (const c of crosswalks) c.group.position.z += dz;
  }
  function setCam(x: number, roll: number, tilt: number) {
    cam.position.set(x, CFG.camera.height, CFG.camera.z);
    cam.lookAt(x, CFG.camera.lookY, CFG.camera.lookZ);
    if (roll) cam.rotateZ(roll);
    headLayer.setTilt(tilt || 0);
  }
  function setRing(kind: RingKind, x: number, z: number) {
    ring.position.set(x, 0.03, z);
    ring.material.color.set(RING_COLOR[kind]);
  }
  return { scene, cam, headLayer, ring, tower, crosswalks, crosswalk, clearCross, advance, setCam, setRing };
}
