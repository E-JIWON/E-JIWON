// 효과음·배경음 합성기. 외부 오디오 파일 없이 Web Audio API로 전부 만든다.
// 톤 가이드(기획서 v0.2 sound): 무음 플레이가 기본 전제(소리에만 있는 정보 없음) · 때리는 타격음 금지 ·
// 짧고 경쾌하게 · 마스터 -6dB 기본. 게임 코드는 아래 Sfx 인터페이스만 쓴다(계약, 시그니처 고정).
// AudioContext가 없거나 막힌 환경(구형 브라우저·테스트·Node)에서는 예외 없이 조용히 아무 소리도 내지 않는다.

export type SfxName =
  | 'swipe' | 'bump' | 'clap' | 'clapMiss' | 'coo' | 'cooLow' | 'cooHigh'
  | 'grabPending' | 'grab' | 'drop' | 'park' | 'lane' | 'block' | 'yawn' | 'heart'
  | 'comboConfirm' | 'goldAppear' | 'ride' | 'chatPing'
  | 'freeze' | 'stingCommon' | 'stingRare' | 'stingEpic' | 'stingLegend'
  | 'tick' | 'uiTap' | 'start';

export interface SfxOpts { pan?: number; pitch?: number; volume?: number }

export interface Sfx {
  /** 첫 사용자 입력 핸들러 안에서 호출(iOS 오디오 잠금 해제). 여러 번 불러도 안전. */
  unlock(): void;
  play(name: SfxName, opts?: SfxOpts): void;
  /** 배경 루프(로파이 출근 행진). 템포 배율은 1 기본, 9시 임박 시 1.15. */
  startMusic(): void;
  stopMusic(): void;
  setTempo(mult: number): void;
  setMuted(muted: boolean): void;
  readonly muted: boolean;
  /** 앱 전환 후 복귀 시 AudioContext 재개. */
  resume(): void;
}

/**
 * 마지막 50개 play 호출 이름(테스트·디버그 훅 window.__game.sfxLog 용).
 * 음소거 중이든, 오디오를 못 쓰는 환경이든, 중복으로 무시된 호출이든 play가 불리면 기록한다.
 */
export const sfxLog: string[] = [];

// ───────────────────────────── 수치 ─────────────────────────────
const LOG_MAX = 50;
const MASTER_GAIN = Math.pow(10, -2 / 20); // 마스터 -2dB(리미터가 -4dB에서 막음, 폰 스피커 기준 상향)
const SFX_BUS_GAIN = 1;
const MUSIC_BUS_GAIN = 0.2;                // 배경음은 효과음 아래에 깔리게
const MUSIC_FADE_IN = 0.6;                 // 음악 시작 페이드인(초)
const MUSIC_FADE_OUT = 0.25;               // stopMusic 페이드아웃(초)
const DEDUPE_MS = 40;                      // 같은 이름이 이 시간 안에 다시 오면 무시
const MAX_VOICES = 16;                     // 동시에 울리는 효과음 상한(넘치면 새 소리 생략)
const START_DELAY = 0.006;                 // 예약 여유(초). 너무 붙이면 첫 샘플이 잘린다
const BASE_BPM = 120;
const STEPS_PER_BAR = 16;                  // 16분음 격자
const LOOP_BARS = 8;
const LOOP_STEPS = STEPS_PER_BAR * LOOP_BARS;
const SWING = 0.16;                        // 엇박 8분음을 16분음 길이의 이 비율만큼 뒤로(로파이 흔들림)
const LOOKAHEAD = 0.2;                     // 음악 미리 예약 구간(초)
const TIMER_MS = 40;                       // 스케줄러 깨우는 주기(ms)
const TEMPO_MIN = 0.5;
const TEMPO_MAX = 2;
const EPS = 0.0001;                        // 지수 램프 바닥값(-80dB)

// ───────────────────────────── 작은 도우미 ─────────────────────────────
const clamp = (x: number, a: number, b: number): number => (x < a ? a : x > b ? b : x);
const finite = (x: number | undefined, d: number): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const rnd = (a: number, b: number): number => a + Math.random() * (b - a);
/** MIDI 번호 → 주파수(Hz). 69 = A4 = 440Hz. */
const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const nowMs = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** 한 소리를 만들 때 쓰는 문맥: 컨텍스트, 출력 노드, 시작 시각, 피치 배율. */
interface V { c: BaseAudioContext; out: AudioNode; t: number; p: number }

/** [이 음 시작 기준 상대 시각(초), 값] */
type Pt = readonly [number, number];

/** 지수 램프 경로. 첫 값은 t에 고정, 이후 점마다 지수 램프. */
function setPath(param: AudioParam, t: number, v0: number, path: readonly Pt[] | undefined, mul: number): void {
  param.setValueAtTime(Math.max(v0, 1), t);
  if (!path) return;
  for (const [dt, val] of path) param.exponentialRampToValueAtTime(Math.max(val * mul, 1), t + dt);
}

/** 볼륨 엔벌로프: 0 → (어택) peak → (유지) → (지수 감쇠) 거의 0. */
function envelope(param: AudioParam, t: number, a: number, peak: number, hold: number, d: number): void {
  const pk = Math.max(peak, 0.001);
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(pk, t + a);
  if (hold > 0) param.setValueAtTime(pk, t + a + hold);
  param.exponentialRampToValueAtTime(EPS, t + a + hold + d);
  param.setValueAtTime(0, t + a + hold + d + 0.002);
}

interface ToneSpec {
  type?: OscillatorType;
  f: number;                       // 시작 주파수(Hz, 피치 배율 적용 전)
  path?: readonly Pt[];            // 주파수 경로(Hz, 피치 배율 적용 전)
  at?: number;                     // 소리 안에서의 시작 오프셋(초)
  a?: number;                      // 어택(초)
  hold?: number;                   // 유지(초)
  d: number;                       // 감쇠(초)
  v: number;                       // 최대 볼륨
  detune?: number;                 // cent
  vib?: readonly [number, number]; // 비브라토 [속도 Hz, 깊이 cent]
  vibAt?: number;                  // 비브라토가 다 들어오는 시각(초, 지연 비브라토)
  am?: readonly [number, number];  // 진폭 떨림 [속도 Hz, 깊이 0~1] (비둘기 목 울림)
  lp?: number;                     // 로우패스 컷오프(Hz, 절대값)
  lpPath?: readonly Pt[];          // 로우패스 경로(Hz, 절대값)
  q?: number;
}

/** 오실레이터 한 음. 반환값은 소리 안에서 이 음이 끝나는 상대 시각(초). */
function tone(v: V, s: ToneSpec): number {
  const c = v.c;
  const at = s.at ?? 0, a = s.a ?? 0.005, hold = s.hold ?? 0;
  const len = a + hold + s.d;
  const f0 = s.f * v.p;
  if (f0 > c.sampleRate * 0.45) return at; // 나이퀴스트 근처 배음은 생략(접힘 방지)
  const t = v.t + at, end = t + len + 0.03;

  const o = c.createOscillator();
  o.type = s.type ?? 'sine';
  setPath(o.frequency, t, f0, s.path, v.p);
  if (s.detune) o.detune.setValueAtTime(s.detune, t);
  const extra: AudioScheduledSourceNode[] = [];

  if (s.vib) {
    const lfo = c.createOscillator();
    lfo.frequency.setValueAtTime(s.vib[0], t);
    const depth = c.createGain();
    if (s.vibAt) {
      depth.gain.setValueAtTime(0, t);
      depth.gain.linearRampToValueAtTime(s.vib[1], t + s.vibAt);
    } else depth.gain.setValueAtTime(s.vib[1], t);
    lfo.connect(depth);
    depth.connect(o.detune);
    extra.push(lfo);
  }

  let node: AudioNode = o;
  if (s.lp) {
    const bq = c.createBiquadFilter();
    bq.type = 'lowpass';
    setPath(bq.frequency, t, s.lp, s.lpPath, 1);
    bq.Q.setValueAtTime(s.q ?? 0.7, t);
    node.connect(bq);
    node = bq;
  }
  if (s.am) {
    const amg = c.createGain();
    const half = clamp(s.am[1], 0, 1) / 2;
    amg.gain.setValueAtTime(1 - half, t);
    const lfo = c.createOscillator();
    lfo.frequency.setValueAtTime(s.am[0], t);
    const dg = c.createGain();
    dg.gain.setValueAtTime(half, t);
    lfo.connect(dg);
    dg.connect(amg.gain);
    node.connect(amg);
    node = amg;
    extra.push(lfo);
  }
  const g = c.createGain();
  envelope(g.gain, t, a, s.v, hold, s.d);
  node.connect(g);
  g.connect(v.out);

  o.start(t);
  o.stop(end);
  for (const x of extra) { x.start(t); x.stop(end); }
  return at + len;
}

// 백색 잡음 버퍼(컨텍스트마다 1초짜리 하나를 돌려 쓴다)
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();
function noiseBuffer(c: BaseAudioContext): AudioBuffer {
  let b = noiseCache.get(c);
  if (!b) {
    b = c.createBuffer(1, Math.max(1, Math.floor(c.sampleRate)), c.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    noiseCache.set(c, b);
  }
  return b;
}

interface NoiseSpec {
  at?: number;
  a?: number;
  hold?: number;
  d: number;
  v: number;
  type?: BiquadFilterType;   // 기본 bandpass
  f: number;                 // 필터 주파수(Hz, 피치 배율 적용)
  path?: readonly Pt[];      // 필터 스윕 경로(Hz, 피치 배율 적용)
  q?: number;
  hp?: number;               // 추가 하이패스(Hz). 저역 '퍽' 소리를 걷어 낸다
}

/** 필터 거친 잡음 한 덩이. 반환값은 끝나는 상대 시각(초). */
function noise(v: V, s: NoiseSpec): number {
  const c = v.c;
  const at = s.at ?? 0, a = s.a ?? 0.003, hold = s.hold ?? 0;
  const len = a + hold + s.d;
  const t = v.t + at, end = t + len + 0.03;
  const nyq = c.sampleRate * 0.45;

  const src = c.createBufferSource();
  src.buffer = noiseBuffer(c);
  src.loop = true;
  const bq = c.createBiquadFilter();
  bq.type = s.type ?? 'bandpass';
  setPath(bq.frequency, t, Math.min(s.f * v.p, nyq), s.path?.map(([dt, f]) => [dt, Math.min(f, nyq / v.p)] as const), v.p);
  bq.Q.setValueAtTime(s.q ?? 1, t);
  src.connect(bq);
  let node: AudioNode = bq;
  if (s.hp) {
    const hp = c.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(Math.min(s.hp, nyq), t);
    node.connect(hp);
    node = hp;
  }
  const g = c.createGain();
  envelope(g.gain, t, a, s.v, hold, s.d);
  node.connect(g);
  g.connect(v.out);
  src.start(t, Math.random() * 0.8);
  src.stop(end);
  return at + len;
}

// ───────────────────────────── 악기(조합) ─────────────────────────────

/** 맑은 종소리. 비정수 배음을 높을수록 빨리 사라지게. */
const BELL_PARTIALS: readonly (readonly [number, number, number])[] = [
  [1, 1, 1], [2, 0.36, 0.55], [3.01, 0.15, 0.38], [4.2, 0.07, 0.26], [5.43, 0.04, 0.18],
];
function bell(v: V, f: number, at: number, d: number, vol: number): number {
  let e = at;
  for (const [m, g, dd] of BELL_PARTIALS) e = Math.max(e, tone(v, { f: f * m, at, a: 0.004, d: d * dd, v: vol * g }));
  return e;
}

/** 통통 튀는 뜯는 소리(삼각파 + 짧은 2배음). */
function pluck(v: V, f: number, at: number, d: number, vol: number): number {
  return Math.max(
    tone(v, { type: 'triangle', f, at, a: 0.004, d, v: vol, lp: 4000 }),
    tone(v, { f: f * 2, at, a: 0.003, d: d * 0.45, v: vol * 0.25 }),
  );
}

/** 짧은 금관(톱니파 2개 + 필터 엔벌로프). 둥글게 열리고 닫힌다. */
function brass(v: V, f: number, at: number, hold: number, vol: number): number {
  const fp = f * v.p;
  const a = 0.03, d = 0.16;
  const lpPath: Pt[] = [[a, fp * 5], [a + hold, fp * 3], [a + hold + d, fp * 1.4]];
  let e = at;
  for (const det of [-7, 7]) {
    e = Math.max(e, tone(v, { type: 'sawtooth', f, detune: det, at, a, hold, d, v: vol * 0.5, lp: fp * 1.3, lpPath, q: 1.1 }));
  }
  return e;
}

/** 비둘기 '구' 한 펄스: 저역 사인 + 2배음, 살짝 올라갔다 내려오는 음정, 비브라토, 목 떨림. */
function cooPulse(v: V, f: number, at: number, len: number, vol: number, bend: number): number {
  const a = Math.min(0.035, len * 0.25);
  const up = len * 0.3;
  return Math.max(
    tone(v, { f, path: [[up, f * 1.06], [len, f * bend]], at, a, hold: len * 0.35, d: len * 0.65, v: vol,
      vib: [6.5, 22], am: [31, 0.4], lp: 950 }),
    tone(v, { type: 'triangle', f: f * 2, path: [[up, f * 2.12], [len, f * 2 * bend]], at, a, hold: len * 0.3, d: len * 0.55,
      v: vol * 0.16, lp: 1500 }),
  );
}

/** '구구' 두 펄스. speed가 클수록 느리고 길다. */
function coo(v: V, f0: number, speed: number, vol: number): number {
  const f = f0 * rnd(0.95, 1.05); // 매번 피치 변주
  const l1 = 0.12 * speed, gap = 0.05 * speed, l2 = 0.21 * speed;
  return Math.max(
    cooPulse(v, f, 0, l1, vol * 0.85, 0.97),
    cooPulse(v, f * 0.95, l1 + gap, l2, vol, 0.86),
  );
}

/** 합창 '아—' 패드 한 음: 톱니파 3개(디튠) → '아' 모음 포먼트 3개 + 저역 몸통. */
const FORMANT_A: readonly (readonly [number, number, number])[] = [[800, 6, 1], [1150, 7, 0.55], [2900, 9, 0.2]];
function choir(v: V, f: number, at: number, hold: number, rel: number, vol: number): number {
  const c = v.c;
  const fp = f * v.p;
  if (fp > c.sampleRate * 0.45) return at;
  const a = 0.4;
  const t = v.t + at, end = t + a + hold + rel + 0.05;
  const mix = c.createGain();
  mix.gain.setValueAtTime(1, t);
  const lfo = c.createOscillator();
  lfo.frequency.setValueAtTime(5.1, t);
  const depth = c.createGain();
  depth.gain.setValueAtTime(0, t);
  depth.gain.linearRampToValueAtTime(15, t + 0.6);
  lfo.connect(depth);
  const oscs: OscillatorNode[] = [];
  for (const det of [-11, 0, 11]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(fp, t);
    o.detune.setValueAtTime(det, t);
    depth.connect(o.detune);
    o.connect(mix);
    oscs.push(o);
  }
  const env = c.createGain();
  envelope(env.gain, t, a, vol, hold, rel);
  for (const [ff, q, g] of FORMANT_A) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.setValueAtTime(ff, t);
    bp.Q.setValueAtTime(q, t);
    const gg = c.createGain();
    gg.gain.setValueAtTime(g, t);
    mix.connect(bp);
    bp.connect(gg);
    gg.connect(env);
  }
  const body = c.createBiquadFilter();
  body.type = 'lowpass';
  body.frequency.setValueAtTime(600, t);
  const bg = c.createGain();
  bg.gain.setValueAtTime(0.18, t);
  mix.connect(body);
  body.connect(bg);
  bg.connect(env);
  env.connect(v.out);
  for (const o of oscs) { o.start(t); o.stop(end); }
  lfo.start(t);
  lfo.stop(end);
  return at + a + hold + rel;
}

const mx = Math.max;

// ───────────────────────────── 효과음 레시피 ─────────────────────────────
// 각 레시피는 소리를 예약하고 전체 길이(초)를 돌려준다. 볼륨은 마스터 -6dB 앞 기준.
const RECIPES: Record<SfxName, (v: V) => number> = {
  // 휙: 밴드패스 잡음이 위로 쓸려 올라간다
  swipe: (v) => noise(v, { type: 'bandpass', f: 450, path: [[0.13, 2600]], q: 1.3, a: 0.04, d: 0.1, v: 2.0 }),

  // 툭: 저역 짧게(폰 스피커용 2배음 살짝)
  bump: (v) => mx(
    tone(v, { f: 170, path: [[0.08, 85]], a: 0.005, d: 0.1, v: 0.65 }),
    tone(v, { type: 'triangle', f: 340, path: [[0.06, 170]], a: 0.005, d: 0.06, v: 0.15 }),
    noise(v, { type: 'lowpass', f: 700, a: 0.003, d: 0.035, v: 0.18 }),
    noise(v, { type: 'bandpass', f: 720, q: 2, a: 0.001, d: 0.025, v: 0.5 }), // 폰 스피커용 클릭
  ),

  // 짝: 아주 짧은 잡음 3겹 + 꼬리(밴드패스)
  clap: (v) => {
    const f = rnd(1250, 1600);
    let e = 0;
    for (let i = 0; i < 3; i++) e = mx(e, noise(v, { at: i * 0.009, f, q: 1.1, a: 0.001, d: 0.013, v: 1.9, hp: 500 }));
    return mx(e, noise(v, { at: 0.027, f: f * 0.9, q: 0.9, a: 0.002, d: 0.09, v: 1.6, hp: 500 }));
  },

  // 헛박수: 먹먹한 바람 소리 + 작게 내려가는 '퓨'
  clapMiss: (v) => mx(
    noise(v, { type: 'lowpass', f: 1100, q: 0.7, a: 0.004, d: 0.06, v: 0.5 }),
    tone(v, { type: 'triangle', f: 560, path: [[0.12, 380]], at: 0.03, a: 0.01, d: 0.12, v: 0.16 }),
  ),

  // 비둘기 말풍선: 일반 / 닭둘기(낮고 느리게) / 황금(높게 + 반짝)
  coo: (v) => coo(v, 330, 1, 0.36),
  cooLow: (v) => mx(coo(v, 215, 1.35, 0.42), tone(v, { type: 'triangle', f: 430, path: [[0.2, 400]], a: 0.03, hold: 0.12, d: 0.2, v: 0.3, lp: 1400 })),
  cooHigh: (v) => mx(coo(v, 470, 0.85, 0.32), bell(v, mtof(96), 0.3, 0.35, 0.06)),

  // 보류 '구?': 끝이 올라가는 한 펄스
  grabPending: (v) => {
    const f = 330 * rnd(0.97, 1.03);
    return mx(
      tone(v, { f, path: [[0.05, f * 0.96], [0.2, f * 1.42]], a: 0.02, hold: 0.1, d: 0.1, v: 0.34, vib: [7, 20], am: [30, 0.35], lp: 1000 }),
      tone(v, { type: 'triangle', f: f * 2, path: [[0.05, f * 1.92], [0.2, f * 2.84]], a: 0.02, hold: 0.08, d: 0.08, v: 0.06, lp: 1600 }),
    );
  },

  // 방석 '퐁': 사인 피치 업
  grab: (v) => mx(
    tone(v, { f: 300, path: [[0.07, 720]], a: 0.005, hold: 0.03, d: 0.12, v: 0.5 }),
    tone(v, { type: 'triangle', f: 600, path: [[0.07, 1440]], a: 0.005, d: 0.08, v: 0.08 }),
  ),

  // 살포시: 부드러운 잡음(위에서 아래로) + 저역
  drop: (v) => mx(
    noise(v, { type: 'lowpass', f: 1500, path: [[0.16, 300]], q: 0.5, a: 0.015, d: 0.16, v: 0.42 }),
    tone(v, { f: 190, path: [[0.12, 110]], a: 0.012, d: 0.15, v: 0.55 }),
    tone(v, { type: 'triangle', f: 380, path: [[0.1, 220]], a: 0.012, d: 0.08, v: 0.09 }),
    noise(v, { type: 'bandpass', f: 1000, path: [[0.14, 620]], q: 0.9, a: 0.01, d: 0.13, v: 0.32 }), // 폰 스피커용 중역
  ),

  // 화단 착지: 맑은 '띵'
  park: (v) => bell(v, mtof(88), 0, 0.9, 0.42),

  // 다른 차선: 짧은 상행 2음
  lane: (v) => mx(pluck(v, mtof(84), 0, 0.08, 0.4), pluck(v, mtof(88), 0.07, 0.14, 0.4)),

  // 내 앞에 놓음: 낮은 경고 2음(부드러운 사각파)
  block: (v) => mx(
    tone(v, { type: 'square', f: 330, a: 0.008, hold: 0.06, d: 0.07, v: 0.16, lp: 900 }),
    tone(v, { type: 'square', f: 247, at: 0.15, a: 0.008, hold: 0.08, d: 0.1, v: 0.16, lp: 800 }),
  ),

  // 하암…: 살짝 올랐다 길게 내려가는 글라이드 + 숨소리
  yawn: (v) => mx(
    tone(v, { type: 'sawtooth', f: 300, path: [[0.12, 440], [0.75, 170]], a: 0.08, hold: 0.3, d: 0.4, v: 0.2, lp: 1100, vib: [5, 18], vibAt: 0.3 }),
    noise(v, { f: 900, path: [[0.7, 500]], q: 1.2, a: 0.1, hold: 0.25, d: 0.4, v: 0.08 }),
  ),

  // 두근: 저역 2펄스(두 번째가 약하게)
  heart: (v) => {
    const beat = (at: number, vol: number): number => mx(
      tone(v, { f: 120, path: [[0.09, 62]], at, a: 0.008, d: 0.13, v: vol }),
      tone(v, { type: 'triangle', f: 240, path: [[0.08, 130]], at, a: 0.008, d: 0.08, v: vol * 0.5 }),
      tone(v, { type: 'triangle', f: 480, path: [[0.06, 300]], at, a: 0.006, d: 0.06, v: vol * 0.3 }),
      noise(v, { type: 'bandpass', f: 1000, q: 1.4, at, a: 0.003, d: 0.04, v: vol * 0.5 }),
    );
    return mx(beat(0, 0.65), beat(0.17, 0.45));
  },

  // 횡단보도 도장 '쾅': 둥근 저역 + 짧은 종이 잡음 + 작은 확정 반짝
  comboConfirm: (v) => mx(
    tone(v, { f: 150, path: [[0.16, 62]], a: 0.007, d: 0.24, v: 0.7 }),
    tone(v, { type: 'triangle', f: 300, path: [[0.1, 140]], a: 0.007, d: 0.1, v: 0.2 }),
    noise(v, { type: 'lowpass', f: 900, path: [[0.06, 400]], q: 0.6, a: 0.005, d: 0.06, v: 0.42 }),
    bell(v, mtof(91), 0.09, 0.35, 0.13),
    bell(v, mtof(96), 0.15, 0.4, 0.11),
  ),

  // 황금 구구 등장: 반짝 아르페지오 + 높은 반짝이
  goldAppear: (v) => {
    let e = 0;
    [84, 88, 91, 96].forEach((m, i) => { e = mx(e, bell(v, mtof(m), i * 0.055, 0.35, 0.22)); });
    return mx(e, noise(v, { type: 'highpass', f: 6500, at: 0.05, a: 0.05, hold: 0.1, d: 0.2, v: 0.06 }));
  },

  // 탑승: 짧은 팡파르(빠-빠-빠-빰)
  ride: (v) => {
    let e = 0;
    ([[67, 0], [72, 0.085], [76, 0.17]] as const).forEach(([m, at]) => { e = mx(e, brass(v, mtof(m), at, 0.04, 0.25)); });
    for (const m of [72, 76, 79]) e = mx(e, brass(v, mtof(m), 0.26, 0.3, 0.18));
    return e;
  },

  // 단톡방 초대: 오리지널 '구구띵'(짧은 구 두 번 + 종)
  chatPing: (v) => mx(
    cooPulse(v, 440, 0, 0.07, 0.3, 0.92),
    cooPulse(v, 415, 0.1, 0.07, 0.3, 0.9),
    bell(v, mtof(91), 0.21, 0.6, 0.26),
  ),

  // 프리즈: 레코드 스크래치(필터 스윕 잡음 + 늘어지는 음) 후 정적
  freeze: (v) => mx(
    noise(v, { f: 400, path: [[0.06, 2600], [0.13, 700], [0.2, 2200], [0.32, 300]], q: 3, a: 0.01, hold: 0.18, d: 0.12, v: 0.7 }),
    tone(v, { type: 'sawtooth', f: 280, path: [[0.06, 520], [0.13, 210], [0.2, 420], [0.34, 55]], a: 0.01, hold: 0.2, d: 0.12, v: 0.1, lp: 1500 }),
  ),

  // 컷신 등급 사인 ─ 일반: 3음 뉴스 징글(오리지널)
  stingCommon: (v) => mx(
    bell(v, mtof(84), 0, 0.5, 0.2), pluck(v, mtof(84), 0, 0.12, 0.12),
    bell(v, mtof(79), 0.13, 0.5, 0.2), pluck(v, mtof(79), 0.13, 0.12, 0.12),
    bell(v, mtof(88), 0.26, 0.9, 0.24), pluck(v, mtof(88), 0.26, 0.3, 0.12),
  ),

  // 레어: 짧은 팡파르(빠빠빠-빰)
  stingRare: (v) => {
    let e = 0;
    ([[67, 0], [67, 0.12], [72, 0.24]] as const).forEach(([m, at]) => { e = mx(e, brass(v, mtof(m), at, 0.05, 0.22)); });
    for (const m of [72, 76, 79]) e = mx(e, brass(v, mtof(m), 0.36, 0.35, 0.15));
    return mx(e, bell(v, mtof(96), 0.36, 0.6, 0.08));
  },

  // 에픽: 긴 징글(상행 아르페지오 → 화음 + 저음 + 반짝 상행 + 바람 부풀기)
  stingEpic: (v) => {
    let e = 0;
    [62, 66, 69, 74].forEach((m, i) => { e = mx(e, brass(v, mtof(m), i * 0.11, 0.04, 0.2)); });
    for (const m of [74, 78, 81]) e = mx(e, brass(v, mtof(m), 0.46, 0.75, 0.14));
    e = mx(e, brass(v, mtof(50), 0.46, 0.75, 0.16));
    [86, 90, 93, 98].forEach((m, i) => { e = mx(e, bell(v, mtof(m), 0.5 + i * 0.08, 0.6, 0.06)); });
    return mx(e, noise(v, { type: 'highpass', f: 5000, at: 0.15, a: 0.35, d: 0.6, v: 0.05 }));
  },

  // 전설: 합창 '아—' 패드 + 저음 + 반짝이
  stingLegend: (v) => {
    let e = 0;
    for (const m of [60, 64, 67, 72]) e = mx(e, choir(v, mtof(m), 0, 1.2, 0.8, 0.21));
    e = mx(e, tone(v, { f: mtof(48), a: 0.4, hold: 1.2, d: 0.8, v: 0.16 }));
    [84, 88, 91, 96].forEach((m, i) => { e = mx(e, bell(v, mtof(m), 0.3 + i * 0.25, 0.7, 0.05)); });
    return e;
  },

  // 초침: 짧고 가벼운 '똑'
  tick: (v) => mx(
    tone(v, { f: 1900, a: 0.001, d: 0.05, v: 0.75 }),
    tone(v, { type: 'triangle', f: 950, a: 0.001, d: 0.03, v: 0.2 }),
    noise(v, { type: 'highpass', f: 3000, a: 0.001, d: 0.015, v: 0.45 }),
  ),

  // 버튼 클릭
  uiTap: (v) => tone(v, { type: 'triangle', f: 880, path: [[0.03, 1250]], a: 0.003, d: 0.05, v: 0.4 }),

  // 출발: 경쾌한 2음(솔→도) + 아래 옥타브 몸통 + 반짝
  start: (v) => mx(
    pluck(v, mtof(79), 0, 0.12, 0.36),
    pluck(v, mtof(84), 0.11, 0.32, 0.4),
    tone(v, { type: 'square', f: mtof(67), a: 0.005, d: 0.1, v: 0.07, lp: 1400 }),
    tone(v, { type: 'square', f: mtof(72), at: 0.11, a: 0.005, d: 0.25, v: 0.07, lp: 1400 }),
    bell(v, mtof(96), 0.11, 0.4, 0.07),
  ),
};

// ───────────────────────────── 배경음: 로파이 출근 행진 ─────────────────────────────
// 다장조 8마디 루프(약 120BPM). 앞 4마디는 반주만, 뒤 4마디는 휘파람 멜로디가 얹힌다.
// 행진 느낌: 베이스는 1·3박(근음·5음), 코드는 2·4박 스탭, 하이햇 8분음(엇박 강조 + 살짝 스윙).
interface Chord { root: number; fifth: number; keys: readonly number[] }
const CHORDS: readonly Chord[] = [
  { root: 36, fifth: 43, keys: [64, 67, 71, 74] }, // Cmaj9
  { root: 45, fifth: 40, keys: [60, 64, 67, 71] }, // Am9
  { root: 41, fifth: 48, keys: [57, 60, 64, 67] }, // Fmaj9
  { root: 43, fifth: 38, keys: [59, 62, 65, 69] }, // G9
];
/** 휘파람 멜로디 [뒤 4마디 기준 시작 스텝, MIDI, 길이(스텝)] — 이 게임용 오리지널. */
const MELODY: readonly (readonly [number, number, number])[] = [
  [0, 76, 2], [2, 79, 2], [4, 84, 4], [8, 83, 2], [10, 79, 2], [12, 81, 4],
  [16, 79, 6], [22, 76, 2], [24, 74, 2], [26, 76, 2], [28, 72, 4],
  [32, 81, 2], [34, 84, 2], [36, 81, 2], [38, 79, 2], [40, 77, 4], [44, 76, 2], [46, 77, 2],
  [48, 79, 8], [56, 74, 2], [58, 76, 2], [60, 77, 2], [62, 71, 2],
];
const MELODY_AT = new Map<number, readonly [number, number]>();
for (const [s, m, l] of MELODY) MELODY_AT.set(4 * STEPS_PER_BAR + s, [m, l]);

function mKick(v: V): void {
  tone(v, { f: 115, path: [[0.09, 48]], a: 0.005, d: 0.2, v: 0.55 });
}
function mSnap(v: V): void {
  noise(v, { f: 1900, q: 0.8, a: 0.002, d: 0.07, v: 0.22, hp: 400 });
}
function mHat(v: V, vol: number, open: boolean): void {
  noise(v, { type: 'highpass', f: 7500, a: 0.001, d: open ? 0.13 : 0.035, v: vol });
}
function mBass(v: V, m: number, len: number, vol: number): void {
  const f = mtof(m);
  tone(v, { type: 'triangle', f, a: 0.006, hold: len * 0.45, d: len * 0.6, v: vol, lp: 700 });
  tone(v, { type: 'sawtooth', f: f * 2, a: 0.006, hold: len * 0.2, d: len * 0.4, v: vol * 0.2, lp: 900 }); // 폰 스피커용 윗배음
}
function mKeys(v: V, ms: readonly number[], len: number, vol: number, drift: number, tine: boolean): void {
  for (const m of ms) {
    const f = mtof(m);
    tone(v, { type: 'triangle', f, detune: drift + rnd(-4, 4), a: 0.012, hold: len * 0.25, d: len * 0.85, v: vol, lp: 1500 });
    if (tine) tone(v, { f: f * 2, detune: drift, a: 0.003, d: 0.1, v: vol * 0.3 });
  }
}
function mLead(v: V, m: number, len: number): void {
  tone(v, { f: mtof(m), a: 0.03, hold: len * 0.55, d: len * 0.5 + 0.05, v: 0.13, vib: [5.5, 16], vibAt: 0.15 });
  tone(v, { type: 'triangle', f: mtof(m) * 2, a: 0.03, hold: len * 0.3, d: len * 0.4, v: 0.012 });
}

/** 한 스텝(16분음)을 예약. t는 이 스텝의 시각, sd는 16분음 길이(초). */
function scheduleStep(c: BaseAudioContext, bus: AudioNode, step: number, t: number, sd: number): void {
  const bar = Math.floor(step / STEPS_PER_BAR) % LOOP_BARS;
  const s = step % STEPS_PER_BAR;
  const ch = CHORDS[bar % CHORDS.length];
  const next = CHORDS[(bar + 1) % CHORDS.length];
  const v: V = { c, out: bus, t, p: 1 };
  const drift = Math.sin(t * 2.3) * 6; // 테이프 흔들림(cent)

  // 드럼: 1·3박 둥근 킥, 2·4박 가벼운 스냅, 8분음 하이햇(엇박 강조)
  if (s === 0 || s === 8) mKick(v);
  if (s === 4 || s === 12) mSnap(v);
  if (s % 2 === 0) mHat(v, s % 4 === 2 ? 0.2 : 0.11, s === 14 && bar % 2 === 1);

  // 베이스: 근음 · (짝수 마디) 옥타브 통통 · 5음 · (4마디 끝) 다음 근음 반음 아래 접근
  if (s === 0) mBass(v, ch.root, sd * 3.2, 0.55);
  if (s === 6 && bar % 2 === 0) mBass(v, ch.root + 12, sd * 1.2, 0.3);
  if (s === 8) mBass(v, ch.fifth, sd * 3.2, 0.5);
  if (s === 14 && bar % 4 === 3) mBass(v, next.root - 1, sd * 1.5, 0.4);

  // 코드: 마디 첫 박 은은하게 길게, 2·4박 스탭, 홀수 마디 엇박 고스트
  if (s === 0) mKeys(v, ch.keys, sd * 7, 0.045, drift, false);
  if (s === 4 || s === 12) mKeys(v, ch.keys, sd * 2.2, 0.07, drift, true);
  if (s === 10 && bar % 2 === 1) mKeys(v, ch.keys, sd * 1.5, 0.04, drift, false);

  // 휘파람 멜로디(뒤 4마디)
  const mel = MELODY_AT.get(step % LOOP_STEPS);
  if (mel) mLead(v, mel[0], mel[1] * sd);
}

// ───────────────────────────── 엔진 ─────────────────────────────
type CtxCtor = new () => AudioContext;

function audioCtor(): CtxCtor | null {
  const g = globalThis as unknown as { AudioContext?: CtxCtor; webkitAudioContext?: CtxCtor };
  return g.AudioContext ?? g.webkitAudioContext ?? null;
}

/** 페이지에서 사용자 입력이 한 번이라도 있었는지(있으면 제스처 밖에서도 컨텍스트를 만들어도 된다). */
function hadUserActivation(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator as unknown as { userActivation?: { hasBeenActive?: boolean } }).userActivation;
  return !!ua && ua.hasBeenActive === true;
}

export function createSfx(): Sfx {
  let muted = false;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let broken = false; // 컨텍스트를 만들 수 없는 환경 → 이후 시도 생략

  const lastAt = new Map<SfxName, number>();
  let voiceEnds: number[] = [];

  // 음악 상태
  let musicWanted = false;   // startMusic이 불렸고 stopMusic 전
  let musicBus: GainNode | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let tempo = 1;
  let step = 0;
  let nextT = 0;

  function ensureCtx(gesture: boolean): AudioContext | null {
    if (ctx && ctx.state === 'closed') { ctx = null; master = null; sfxBus = null; musicBus = null; }
    if (ctx) return ctx;
    if (broken) return null;
    if (!gesture && !hadUserActivation()) return null;
    const Ctor = audioCtor();
    if (!Ctor) { broken = true; return null; }
    try {
      const c = new Ctor();
      const m = c.createGain();
      m.gain.setValueAtTime(muted ? 0 : MASTER_GAIN, c.currentTime);
      // 안전 리미터: 여러 소리가 겹쳐도 깨지지 않게(평소엔 거의 동작 안 함)
      let tail: AudioNode = c.destination;
      if (typeof c.createDynamicsCompressor === 'function') {
        const lim = c.createDynamicsCompressor();
        lim.threshold.setValueAtTime(-4, c.currentTime);
        lim.knee.setValueAtTime(4, c.currentTime);
        lim.ratio.setValueAtTime(12, c.currentTime);
        lim.attack.setValueAtTime(0.002, c.currentTime);
        lim.release.setValueAtTime(0.12, c.currentTime);
        lim.connect(c.destination);
        tail = lim;
      }
      m.connect(tail);
      const sb = c.createGain();
      sb.gain.setValueAtTime(SFX_BUS_GAIN, c.currentTime);
      sb.connect(m);
      ctx = c; master = m; sfxBus = sb;
      voiceEnds = []; // 새 컨텍스트는 시계가 0부터 다시 간다
      return c;
    } catch {
      broken = true;
      ctx = null; master = null; sfxBus = null;
      return null;
    }
  }

  function tryResume(): void {
    const c = ctx;
    if (!c || c.state === 'running' || c.state === 'closed') return;
    try { Promise.resolve(c.resume()).catch(() => { /* 제스처 밖이면 거절될 수 있다 */ }); } catch { /* 무시 */ }
  }

  /** iOS: 제스처 안에서 무음 1샘플을 한 번 재생해야 이후 소리가 난다. */
  function playSilence(c: AudioContext): void {
    try {
      const b = c.createBuffer(1, 1, c.sampleRate);
      const s = c.createBufferSource();
      s.buffer = b;
      s.connect(c.destination);
      s.start(0);
    } catch { /* 무시 */ }
  }

  function voiceFree(now: number): boolean {
    if (voiceEnds.length) voiceEnds = voiceEnds.filter((e) => e > now);
    return voiceEnds.length < MAX_VOICES;
  }

  // ── 음악 스케줄러(lookahead): 타이머가 깨어날 때마다 앞으로 LOOKAHEAD초 안의 스텝을 미리 예약 ──
  function tick(): void {
    const c = ctx, bus = musicBus;
    if (!c || !bus) return;
    try {
      const now = c.currentTime;
      if (c.state !== 'running') { nextT = now + 0.05; return; }
      if (nextT < now - 0.05) nextT = now + 0.03; // 타이머가 밀렸으면 놓친 스텝은 건너뜀(몰아치기 방지)
      while (nextT < now + LOOKAHEAD) {
        const sd = 60 / (BASE_BPM * tempo) / 4;
        const s = step % STEPS_PER_BAR;
        const swing = s % 4 === 2 ? sd * SWING : 0;
        if (!muted) scheduleStep(c, bus, step, nextT + swing, sd);
        nextT += sd;
        step = (step + 1) % LOOP_STEPS;
      }
    } catch { /* 무음으로 계속 */ }
  }

  function beginMusic(): void {
    const c = ctx, m = master;
    if (!c || !m || musicBus) return;
    try {
      const bus = c.createGain();
      const t = c.currentTime;
      bus.gain.setValueAtTime(0, t);
      bus.gain.linearRampToValueAtTime(MUSIC_BUS_GAIN, t + MUSIC_FADE_IN);
      bus.connect(m);
      musicBus = bus;
      step = 0;
      nextT = t + 0.06;
      if (timer === null) timer = setInterval(tick, TIMER_MS);
      tick();
    } catch {
      musicBus = null;
    }
  }

  function endMusic(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
    const c = ctx, bus = musicBus;
    musicBus = null;
    if (!c || !bus) return;
    try {
      const t = c.currentTime;
      bus.gain.cancelScheduledValues(t);
      bus.gain.setValueAtTime(bus.gain.value, t);
      bus.gain.linearRampToValueAtTime(0, t + MUSIC_FADE_OUT);
      // 미리 예약해 둔 음표는 이 버스와 함께 사라진다
      setTimeout(() => { try { bus.disconnect(); } catch { /* 무시 */ } }, (MUSIC_FADE_OUT + 0.15) * 1000);
    } catch { /* 무시 */ }
  }

  return {
    unlock() {
      const c = ensureCtx(true);
      if (!c) return;
      tryResume();
      playSilence(c);
      if (musicWanted && !musicBus) beginMusic();
    },

    play(name: SfxName, opts?: SfxOpts) {
      sfxLog.push(name);
      if (sfxLog.length > LOG_MAX) sfxLog.splice(0, sfxLog.length - LOG_MAX);

      const ms = nowMs();
      const last = lastAt.get(name);
      if (last !== undefined && ms - last < DEDUPE_MS) return; // 같은 이름 40ms 안 중복 무시
      lastAt.set(name, ms);
      if (muted) return;

      const c = ensureCtx(false);
      const bus = sfxBus;
      if (!c || !bus) return;
      if (c.state !== 'running') { tryResume(); return; } // 멈춘 컨텍스트에 쌓아 두면 재개 때 몰아서 터진다
      try {
        const now = c.currentTime;
        if (!voiceFree(now)) return;
        const recipe = RECIPES[name];
        if (!recipe) return;
        const vol = clamp(finite(opts?.volume, 1), 0, 2);
        if (vol <= 0) return;
        const pitch = clamp(finite(opts?.pitch, 1), 0.25, 4);
        const pan = clamp(finite(opts?.pan, 0), -1, 1);

        const g = c.createGain();
        g.gain.setValueAtTime(vol, now);
        if (pan !== 0 && typeof c.createStereoPanner === 'function') {
          const pn = c.createStereoPanner();
          pn.pan.setValueAtTime(pan, now);
          g.connect(pn);
          pn.connect(bus);
        } else g.connect(bus);

        const t = now + START_DELAY;
        const len = recipe({ c, out: g, t, p: pitch });
        voiceEnds.push(t + len);
      } catch { /* 합성 실패는 무음으로 */ }
    },

    startMusic() {
      musicWanted = true;
      if (musicBus) return;
      if (!ensureCtx(false)) return; // 아직 잠금 해제 전이면 unlock 때 시작
      beginMusic();
    },

    stopMusic() {
      musicWanted = false;
      endMusic();
    },

    setTempo(mult: number) {
      tempo = clamp(finite(mult, 1), TEMPO_MIN, TEMPO_MAX);
    },

    setMuted(m: boolean) {
      muted = !!m;
      const c = ctx, g = master;
      if (!c || !g) return;
      try {
        const t = c.currentTime;
        g.gain.cancelScheduledValues(t);
        g.gain.setValueAtTime(g.gain.value, t);
        g.gain.linearRampToValueAtTime(muted ? 0 : MASTER_GAIN, t + 0.03);
      } catch { /* 무시 */ }
    },

    get muted() { return muted; },

    resume() {
      if (!ctx) return;              // 아직 잠금 해제 전이면 할 일 없음
      if (!ensureCtx(false)) return; // 닫혀 버린 컨텍스트면 새로 만든다
      tryResume();
      if (musicWanted && !musicBus) beginMusic();
    },
  };
}
