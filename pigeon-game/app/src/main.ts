// 부팅: WebGL 감지 → 폰트 로드 대기(최대 1.5초) → 게임 생성. 타이틀·일시정지·음소거 버튼 연결, 디버그 훅(window.__game).
import './style.css';
import { createSfx, sfxLog } from './audio/sfx';
import { createGame } from './game/game';
import type { DebugState, Game } from './game/game';
import type { Mode } from './game/state';
import { FONT_PRELOAD } from './util/text';

/** e2e 테스트용 디버그 훅(이름 고정). */
export interface GameDebugHook {
  readonly state: DebugState;
  /** 월드 좌표 → 캔버스 CSS 픽셀(캔버스 좌상단 기준). */
  toScreen(x: number, y: number, z: number): [number, number];
  readonly mode: Mode;
  start(mode: Mode): void;
  /** 마지막 50개 효과음 호출 이름(음소거여도 기록). */
  readonly sfxLog: string[];
}

declare global {
  interface Window { __game?: GameDebugHook }
}

const FONT_WAIT_MS = 1500;
const MUTE_KEY = 'gugu.muted';

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} 요소가 없습니다`);
  return e as T;
}

/** three 0.186 은 WebGL2 필요. 시험 컨텍스트는 바로 반납한다. */
function hasWebGL2(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch {
    return false;
  }
}

function waitFonts(): Promise<void> {
  const fonts = document.fonts;
  const load = fonts && typeof fonts.load === 'function'
    ? Promise.all(FONT_PRELOAD.map(([font, text]) => fonts.load(font, text))).then(() => undefined, () => undefined)
    : Promise.resolve();
  return Promise.race([load, new Promise<void>((r) => setTimeout(r, FONT_WAIT_MS))]);
}

function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(v: boolean): void {
  try { localStorage.setItem(MUTE_KEY, v ? '1' : '0'); } catch { /* 저장 불가(사생활 보호 모드 등) 무시 */ }
}

async function boot(): Promise<void> {
  const canvas = el<HTMLCanvasElement>('game');
  const title = el('title'), hudEl = el('hud'), noGl = el('noGl');
  const btnStart = el<HTMLButtonElement>('btnStart'), btnDemo = el<HTMLButtonElement>('btnDemo');
  const muteBtns = [el<HTMLButtonElement>('btnMute'), el<HTMLButtonElement>('btnMute2')];
  const btnPause = el<HTMLButtonElement>('btnPause'), btnResume = el<HTMLButtonElement>('btnResume');

  // 효과음(호출 기록 sfxLog 는 sfx.ts 가 play 마다 남긴다. 음소거여도 기록)
  const sfx = createSfx();

  // 음소거(라벨은 그대로, 눌림 상태는 aria-pressed 와 style.css 로 표시)
  const renderMute = () => {
    for (const b of muteBtns) b.setAttribute('aria-pressed', String(sfx.muted));
  };
  sfx.setMuted(readMuted());
  renderMute();
  for (const b of muteBtns) {
    b.addEventListener('click', () => {
      sfx.unlock();
      const m = !sfx.muted;
      sfx.setMuted(m);
      writeMuted(m);
      renderMute();
      sfx.play('uiTap');
    });
  }

  // 게임이 준비되기 전에 누른 버튼은 기억했다가 실행
  let game: Game | null = null;
  let queued: Mode | null = null;
  const go = (m: Mode) => {
    sfx.unlock();
    if (game) game.begin(m); else queued = m;
  };
  btnStart.addEventListener('click', () => go('play'));
  btnDemo.addEventListener('click', () => { sfx.play('uiTap'); go('auto'); });
  btnPause.addEventListener('click', () => { sfx.unlock(); sfx.play('uiTap'); game?.togglePause(); });
  btnResume.addEventListener('click', () => { sfx.unlock(); sfx.play('uiTap'); game?.resume(); });

  const showNoGl = () => { noGl.hidden = false; title.hidden = true; hudEl.hidden = true; };
  if (!hasWebGL2()) { showNoGl(); return; }

  await waitFonts();
  try {
    game = createGame(canvas, {
      stage: el('stage'), title, pause: el('pause'), heart: el('heart'), heartBar: el('heartBar'),
      ghost: el('ghost'), autoTag: el('autoTag'), fx: el('fx'), cut: el('cut'),
      clock: el('hClock'), prog: el('hProg'), views: el('hViews'), combo: el('hCombo'),
    }, sfx);
  } catch (e) {
    console.error(e);
    showNoGl();
    return;
  }
  const g = game;
  window.__game = {
    get state() { return g.snapshot(); },
    toScreen: (x, y, z) => g.toScreen(x, y, z),
    get mode() { return g.mode; },
    start: (m) => g.begin(m),
    get sfxLog() { return sfxLog.slice(); },
  };
  if (queued) { const m = queued; queued = null; g.begin(m); }
}

void boot();
