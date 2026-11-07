// 문자열·폰트 도우미(원본 template.html 전역 도우미 중 게임에 필요한 것만).

/** HTML 이스케이프. */
export const esc = (s: unknown): string =>
  String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

/** 캔버스 텍스처용 폰트 스택(style.css 의 --f-display / --f-body 와 같은 순서). */
export const FONT_DISPLAY = '"Black Han Sans","Apple SD Gothic Neo","Malgun Gothic",sans-serif';
export const FONT_BODY = '"IBM Plex Sans KR","Apple SD Gothic Neo","Malgun Gothic",sans-serif';

/** 부팅 시 미리 불러 둘 폰트(캔버스 텍스처가 대체 폰트로 구워지지 않게). */
export const FONT_PRELOAD: ReadonlyArray<[string, string?]> = [
  ['20px "Black Han Sans"'],
  ['700 20px "Gaegu"', '구?…(끄덕)정들어버림하암★2.3영차무대인사화단으로손이안닿음짝1/3♥'],
  ['600 20px "IBM Plex Mono"'],
  ['700 42px "IBM Plex Sans KR"', '↔✋→무거움길밖으로피하기머리위'],
  ['600 20px "IBM Plex Sans KR"'],
];
