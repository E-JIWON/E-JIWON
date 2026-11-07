// 캔버스로 굽는 텍스처: 보도블록·파사드·간판·차양·쇼윈도·반짝이·아이콘.
// 폰트가 로드된 뒤 처음 쓸 때 만들도록 전부 지연 생성(모듈 import 시점엔 아무것도 굽지 않음).
import { CanvasTexture, LinearFilter, NoColorSpace, RepeatWrapping, SpriteMaterial } from 'three';
import { PALETTE } from './materials';
import { roundRect } from '../util/canvas';
import { FONT_BODY, FONT_DISPLAY } from '../util/text';

const ANISO = 8;

/** 색 맵용 캔버스 텍스처(색 관리 끔 → 원본처럼 값 그대로). */
export function canvasTex(w: number, h: number, draw: (x: CanvasRenderingContext2D, w: number, h: number) => void): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new CanvasTexture(c);
  t.colorSpace = NoColorSpace;
  t.anisotropy = ANISO;
  return t;
}

/** 반복 텍스처를 복제해 반복 횟수만 바꾼다(이미지는 공유). */
export function repeatClone(src: CanvasTexture, rx: number, ry: number): CanvasTexture {
  const t = src.clone();
  t.needsUpdate = true;
  t.wrapS = t.wrapT = RepeatWrapping;
  t.repeat.set(rx, ry);
  t.anisotropy = ANISO;
  return t;
}

function lazy<T>(make: () => T): () => T {
  let v: T | undefined;
  return () => (v ??= make());
}

/** 보도블록: 엇갈린 벽돌 + 차선 구분 홈 두 줄(폭 3등분). */
export const roadTex = lazy(() => {
  const t = canvasTex(512, 512, (x, w, h) => {
    x.fillStyle = '#D9CBB5'; x.fillRect(0, 0, w, h);
    const bw = 64, bh = 32, tones = ['#EFE5D6', '#EADFCD', '#F3EADD', '#E6DAC6'];
    for (let r = 0; r < h / bh; r++) {
      for (let k = -1; k < w / bw + 1; k++) {
        const ox = (r % 2) * bw / 2;
        x.fillStyle = tones[(r * 7 + k * 3) & 3]!;
        x.fillRect(k * bw + ox + 2, r * bh + 2, bw - 4, bh - 4);
      }
    }
    x.fillStyle = 'rgba(132,108,78,.6)'; x.fillRect(w / 3 - 3, 0, 6, h); x.fillRect(2 * w / 3 - 3, 0, 6, h);
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
});

const FACADE_COLORS: ReadonlyArray<[string, string]> = [
  ['#F3C9A8', '#FFF4E6'], ['#E8B690', '#FFF0DD'], ['#F7D9BE', '#FFFFFF'], ['#D9E2EC', '#F6FAFF'], ['#E0A982', '#FFF1DE'],
];
/** 건물 외벽(창문 격자) 5종. */
export const facadeTex = lazy(() => FACADE_COLORS.map(([b, wn]) => {
  const t = canvasTex(128, 128, (x, w, h) => {
    x.fillStyle = b; x.fillRect(0, 0, w, h);
    x.fillStyle = 'rgba(42,38,51,.1)'; x.fillRect(0, 0, w, 4);
    for (let yy = 18; yy < h; yy += 64) {
      for (let xx = 10; xx < w; xx += 64) {
        x.fillStyle = wn; x.fillRect(xx, yy, 44, 34);
        x.fillStyle = 'rgba(42,38,51,.18)'; x.fillRect(xx, yy + 34, 44, 4); x.fillRect(xx + 21, yy, 2, 34);
      }
    }
  });
  t.wrapS = t.wrapT = RepeatWrapping;
  return t;
}));
/** 쇼윈도가 있는 가게 번갈아 이름. */
export const SHOPS = ['24시 구구마트', '구구 김밥', '카페 구구', '구구 세탁', '구구 분식', '구구 약국'];

/** 간판(테두리 + 디스플레이 폰트 글자). */
export function signTex(txt: string, bg: string, fg: string): CanvasTexture {
  return canvasTex(512, 128, (x, w, h) => {
    x.fillStyle = bg; x.fillRect(0, 0, w, h);
    x.strokeStyle = PALETTE.ink; x.lineWidth = 8; x.strokeRect(4, 4, w - 8, h - 8);
    x.fillStyle = fg; x.font = `64px ${FONT_DISPLAY}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(txt, w / 2, h / 2 + 4);
  });
}

/** 줄무늬 차양. */
export const awningTex = lazy(() => canvasTex(128, 32, (x, _w, h) => {
  for (let k = 0; k < 8; k++) { x.fillStyle = k % 2 ? '#FFFFFF' : '#23C29A'; x.fillRect(k * 16, 0, 16, h); }
}));

/** 쇼윈도·출입문 유리. */
export const frontTex = lazy(() => canvasTex(256, 128, (x, w, h) => {
  x.fillStyle = '#BFD9E8'; x.fillRect(0, 0, w, h);
  x.fillStyle = 'rgba(255,255,255,.55)'; x.fillRect(20, 10, 60, h - 20);
  x.fillStyle = '#2A2633'; x.fillRect(0, 0, w, 6); x.fillRect(w / 2 - 3, 0, 6, h);
  x.fillStyle = '#8FB4C8'; x.fillRect(w * 0.62, 24, w * 0.28, h - 24);
}));

/** 황금 구구 주위 반짝이 스프라이트 재질(공유). */
export const sparkMat = lazy(() => new SpriteMaterial({
  map: canvasTex(64, 64, (x, w, h) => {
    x.fillStyle = '#FFFFFF'; x.font = '52px sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText('✦', w / 2, h / 2);
  }),
  transparent: true, depthWrite: false,
}));

const ICON_CACHE = new Map<string, CanvasTexture>();
const LIVE_RED = '#D7263D';
/**
 * 비둘기 머리 위 아이콘 알약. live 는 앞에 빨간 LIVE 배지가 붙는다.
 * key 별로 캐시(같은 타입은 텍스처 공유).
 */
export function iconTex(key: string, txt: string, live: boolean): CanvasTexture {
  const hit = ICON_CACHE.get(key);
  if (hit) return hit;
  const t = canvasTex(320, 96, (x, w, h) => {
    x.font = `700 42px ${FONT_BODY}`;
    const lw = live ? 92 : 0;
    const pw = Math.min(w - 8, x.measureText(txt).width + 44 + lw), x0 = (w - pw) / 2;
    x.fillStyle = 'rgba(255,255,255,.96)'; x.strokeStyle = PALETTE.ink; x.lineWidth = 5;
    roundRect(x, x0, 12, pw, h - 24, (h - 24) / 2); x.fill(); x.stroke();
    if (live) {
      x.fillStyle = LIVE_RED; roundRect(x, x0 + 12, 22, 82, h - 44, 10); x.fill();
      x.fillStyle = '#fff'; x.font = `30px ${FONT_DISPLAY}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.fillText('LIVE', x0 + 53, h / 2 + 1);
      x.font = `700 42px ${FONT_BODY}`;
    }
    x.fillStyle = PALETTE.ink; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillText(txt, x0 + lw + (pw - lw) / 2, h / 2 + 2);
  });
  t.minFilter = LinearFilter; t.generateMipmaps = false;
  ICON_CACHE.set(key, t);
  return t;
}
