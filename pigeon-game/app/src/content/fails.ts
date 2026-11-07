// 참사 정의(프로토타입 F3 문구 그대로). 자막 템플릿: {N}=콤보, {M}=남은 거리(m), {S}=남은 시간(초).
import type { Rarity } from '../config';

export type FailKey =
  | 'gugu' | 'fat' | 'follow' | 'chat' | 'self' | 'claps' | 'live'
  | 'adopt' | 'special' | 'legend' | 'nine' | 'clear';

export interface FailDef {
  /** 참사 이름(결과 줄). */
  n: string;
  /** 뉴스 바 라벨. */
  lb: string;
  /** 뉴스 자막 템플릿. */
  cap: string;
  /** 등급. */
  r: Rarity;
  /** 컷신 장식 HTML(고정 문자열, 사용자 입력 없음). */
  deco: string;
}

export const FAILS: Record<FailKey, FailDef> = {
  gugu: { n: '통행 우선권 양보', lb: '속보', cap: '출근길 시민, 비둘기에 통행 우선권 양보… “먼저 가시죠”', r: 'common', deco: '<span class="chip3">경로를 재탐색합니다</span>' },
  fat: { n: '눈싸움 패배', lb: '속보', cap: '시민, 비둘기와 눈싸움 0.3초 만에 패배… 비둘기 “상대가 안 됨”', r: 'common', deco: '<span class="big3">VS</span>' },
  follow: { n: '비둘기 1명 신규 입사', lb: '인사', cap: '비둘기 1명 신규 입사… 직급은 당신보다 높음', r: 'common', deco: '<span class="chip3">사원증 삐-빅 · 방문객</span>' },
  chat: { n: '구구 아카펠라', lb: '현장', cap: '출근길 합창 공연 성황리 종료… 지휘자도 지각', r: 'common', deco: '<span class="big3 sm">♪ 구구구 ♪</span>' },
  self: { n: '셀프 통행 제한', lb: '속보', cap: '시민, 본인이 배치한 비둘기에 길 막혀… “제가 두긴 했는데요”', r: 'common', deco: '<span class="chip3">여기 두신 분?</span>' },
  claps: { n: '출근길 즉석 공연', lb: '문화', cap: '출근길 게릴라 공연 성황… 관객 전원 비둘기, 출연료는 없음', r: 'common', deco: '<span class="big3 sm">앙코르!</span>' },
  live: { n: '생방송 출연', lb: '출연', cap: '비둘기 채널 첫 게스트 출연 완료. 출연료: 빵 부스러기 1개', r: 'rare', deco: '<span class="livebar"><b>LIVE</b> 구구TV · 시청자 12,904</span><span class="chat3"><i>ㅋㅋ 손 나옴</i><i>손가락님 구독함</i><i>인간 첨봄</i></span>' },
  adopt: { n: '비둘기가 나를 입양함', lb: '속보', cap: '출근길 시민, 비둘기 가족에 입양돼… 세대주 “구.”', r: 'rare', deco: '<span class="chip3">구구시 가족관계증명서 · 세대주: 구구</span>' },
  special: { n: '9시 특보', lb: '특보', cap: '콤보 {N}연속 시민, 회사 {M}m 앞에서 결국 비둘기에게 길 내줘… 전문가 “예견된 참사”', r: 'epic', deco: '<span class="livebar news"><b>특보</b> 구구 9시 뉴스</span>' },
  legend: { n: '서기 3026', lb: '고고학', cap: '서기 3026년 비둘기 고고학회 발표: “고대 인류는 매일 아침 출근이라는 고행을 했다”', r: 'legendary', deco: '<span class="big3 sm">AD 3026</span>' },
  nine: { n: '9시 땡', lb: '지각', cap: '지각 확정. 정문까지 {M}m, 시간으로는 {S}초.', r: 'common', deco: '<span class="big3">땡!</span>' },
  clear: { n: '정시 출근의 함정', lb: '사내공지', cap: '금일 창립기념일로 휴무입니다. (어제 전체 메일 발송)', r: 'legendary', deco: '<span class="notice3"><b>사내공지</b>금일 창립기념일 휴무</span>' },
};

/** 부딪힘이 아닌 참사(이 키들은 황금·특보·셀프로 승격되지 않는다). */
export const NON_COLLIDE: ReadonlySet<FailKey> = new Set<FailKey>(['nine', 'clear', 'adopt', 'live', 'claps']);

/** 등급 스탬프 라벨·색(원본 RAR 의 en·game). */
export const RARITY_LABEL: Record<Rarity, { en: string; ko: string; color: string }> = {
  common: { en: 'COMMON', ko: '일반', color: '#9AA0A6' },
  rare: { en: 'RARE', ko: '레어', color: '#4FC3F7' },
  epic: { en: 'EPIC', ko: '에픽', color: '#8E5CF7' },
  legendary: { en: 'LEGENDARY', ko: '전설', color: '#F5B700' },
};

/** 자막 템플릿 채우기. */
export function fillCaption(cap: string, combo: number, meters: number, secs: string): string {
  return cap.replace('{N}', String(combo)).replace('{M}', String(meters)).replace('{S}', secs);
}
