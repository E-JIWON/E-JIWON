# 1단계 작업 계약 (기반: 프로토타입 → 정식 TS 프로젝트)

원본 프로토타입(동작의 정답): `/tmp/claude-0/-home-user-E-JIWON/91b8b42b-97d8-5b7f-a765-a7e9af8365de/scratchpad/pigeon/part3d.js`
- `make3D()` 안에 텍스처·비둘기 모델(makePigeon)·포즈(animP)·풀(makePool)·뒷통수(makeHead)·거리(buildWorld)·fit/draw2·스냅샷(shot/portrait)·플레이 컨트롤러(live) 가 있다.
- live()가 쓰는 전역 도우미(rr, esc, RAR, FD/FB/FM 폰트 문자열)는 `.../scratchpad/pigeon/template.html` 의 마지막 <script>에 있다.
- 스냅샷(shot/portrait)과 스토리보드는 이번 범위가 아니다(기획 페이지 전용). 게임 빌드에는 live만 이식한다.

## 폴더 구조 (이 이름 그대로)
- `src/main.ts` 부팅: WebGL 감지 → 실패 시 `#noGl` 표시. 폰트 로드 대기(최대 1.5s) 후 게임 생성. 타이틀(`#title`) → `#btnStart`(sfx.unlock + 플레이 시작), `#btnDemo`(자동 데모), `#btnMute`/`#btnMute2`(음소거 토글, localStorage 'gugu.muted' try/catch), `#btnPause`/`#btnResume`.
- `src/config.ts` 모든 수치(이미 있음, 하드코딩 금지 — 여기서 읽어라).
- `src/content/pigeons.ts` 비둘기 타입 정의(gugu, fat, follow, live, chat, gold): 아이콘 문구, 스폰 조건(시간·확률), 충돌 시 참사 키.
- `src/content/fails.ts` 참사 정의(gugu, fat, follow, chat, self, claps, live, adopt, special, legend, nine, clear): 이름·라벨·자막(템플릿 {N}{M}{S})·등급·deco HTML. 문구는 프로토타입 F3 그대로.
- `src/render/materials.ts` 툰 그라데이션·재질 캐시·외곽선(인버티드 헐)·part() 도우미.
- `src/render/textures.ts` 보도블록·파사드·간판·차양·아이콘 캔버스 텍스처.
- `src/render/pigeonModel.ts` makePigeon(type) + animatePigeon(p, t, dt, still) + 풀. 방석 식빵 자세, 끄덕, 선 눈, 비둘기별 외곽선 재질(olMat).
- `src/render/headModel.ts` 뒷통수(오버레이 씬, hfov 연동 layoutHead).
- `src/render/world.ts` 거리(재활용 소품, 횡단보도, 타워, 드롭 링, 안개·조명·역광), advance(dz), setCam(x, roll, tilt).
- `src/render/renderer.ts` WebGLRenderer, 두 패스 렌더(거리 → 깊이 지움 → 뒷통수), 수평 화각 고정 resize, projector(toScreen), groundAt(px,py).
- `src/game/state.ts` 런 상태 타입과 newRun().
- `src/game/sim.ts` update(dt): 스폰, 이동, 따라구·구구 변칙, 차선 체류 후 퇴장, 충돌, 체크포인트, 타워, 9시/도착.
- `src/game/actions.ts` clap, grab, drag, release, outcome, ride, fail, showCut 트리거(이벤트로 UI에 알림).
- `src/input/pointer.ts` 포인터 상태 머신(pending/far/swipe/drag, 보조 포인터 취소, 패드·가장자리·HUD 띠 규칙) + 키보드(캔버스 포커스일 때만 ←/→/Space).
- `src/ai/demo.ts` 자동 데모(유령 손가락이 실제 입력 함수 호출).
- `src/ui/hud.ts` `src/ui/fx.ts`(toast/bubble, 실제 폭으로 화면 안 클램프) `src/ui/cutscene.ts` `src/ui/overlays.ts`(타이틀·일시정지·하트·가장자리·유령·자동 데모 태그).
- `src/audio/sfx.ts` 효과음(인터페이스 고정, 구현은 오디오 담당). 게임 코드는 아래 이벤트 시점에 `sfx.play()` 호출.
- `src/util/rng.ts`(시드 RNG), `src/util/math.ts`(clamp, lerp, damp).
- `src/game/events.ts` 아주 작은 이벤트 버스(타입 있는 emit/on). 게임 로직 → UI/오디오는 이벤트로만.

## 효과음 호출 지점 (SfxName)
swipe(차선 이동) · bump(벽 툭) · clap(짝 성공) · clapMiss(헛박수) · coo/cooLow/cooHigh(비둘기 말풍선: 일반/닭둘기/황금) · grabPending(보류 '구?') · grab(방석 퐁) · drop(살포시) · park(화단 착지 띵) · lane(다른 차선) · block(내 앞에 놓음 경고) · yawn · heart(정 게이지 1초 넘을 때 1회) · comboConfirm(횡단보도 도장) · goldAppear · ride · chatPing(단톡방 초대) · freeze(프리즈 시작 레코드 스크래치) · stingCommon/Rare/Epic/Legend(컷신 등급 사인) · tick(마지막 10초 매 초) · uiTap · start.
음악: 플레이 시작 시 startMusic, 참사·일시정지 시 stopMusic, 남은 게임 시간 30초 이하에서 setTempo(1.15).

## 디버그·테스트 훅 (e2e가 쓴다, 이름 고정)
`window.__game = { get state(), toScreen(x,y,z): [px,py], get mode(): 'title'|'auto'|'play', start(mode), get sfxLog(): string[] }`
- state 노출 필드: `phase('title'|'play'|'freeze'|'cut'|'paused')`, `lane(-1|0|1)`, `combo`, `best`, `views`, `dist`, `clock`, `held(boolean)`, `gold`, `failKey(string|null)`, `pigs: {id,type,state,x,z,lift}[]`.
- toScreen은 캔버스 CSS 픽셀 좌표(캔버스 좌상단 기준).
- sfxLog: 마지막 50개 play 호출 이름(테스트용, 음소거여도 기록).

## 반드시 지킬 동작(프로토타입 + 리뷰 수정 반영)
1. 누른 위치로 1차 분기: 하단 16% 패드 시작은 절대 잡기 아님 / 리치 안 비둘기면 pending / 리치 밖 비둘기면 far / 그 외 swipe. 좌우 16px 시작 스와이프 무시. 상단 12% HUD 띠 시작 탭은 헛박수로 안 셈.
2. pending: 180ms(구튜버 200ms) 누르고 있거나 10px(14px) 이상 1px/ms 이하로 움직이면 잡기 확정. 150ms 안 가로 우세 이동은 판정 보류, 180ms 안 30px·0.7px/ms 초과 가로 플릭은 스와이프. 10px 미만·200ms 미만에 떼면 그 비둘기에 짝. drag 상태에서 180ms 미만·10px 미만에 떼면 취소 후 짝.
3. 터치 손가락 오프셋 70px은 움직인 거리/40px 비율로만 적용, 지평선 위로 못 가게 리치 먼 경계에서 클램프, 교점 없으면 직전 값 유지.
4. 들기: 방석 식빵 자세(다리 숨김·날개 접음·고개 두리번), 잡는 순간 0.3초 끄덕. 이동 속도 상한 9u/s(닭둘기 1.4u/s, 느린 추종). 600ms 안 방향 반전 5회면 '하암…' 1초 둔화.
5. 정 게이지: 5px 앵커 기준 100ms 이상 정지일 때만 누적, 1초부터 하트 표시, 2.5초면 'adopt' 참사.
6. 드롭 판정(링 색 미리보기): 황금 구구가 정수리 64px 원 안 → 탑승(조회수 ×2) / 가장자리 띠(16%) 또는 |x|>2.1 → 화단(콤보 +2, 착지 지점이 화면 안에 보이게 z 보정, 착지 후 '★2.3 구.') / 다른 차선 → 콤보 +1 / 내 차선 → 경고만. 닭둘기는 손가락이 아니라 비둘기 실제 위치로 판정·링 표시. 차선에 놓인 비둘기는 2.5초 뒤 스스로 화단으로 퇴장(따라구는 0.6초 뒤 다시 추종).
7. 취소(보조 포인터·pointercancel·앱 전환·일시정지)면 x·z 모두 원위치로 240ms 복귀, 벌점 없음.
8. 짝: 대상이 내 차선이 아닌 칸으로만 비킴, 남는 칸이 내 차선뿐이면 화단으로 퇴장(콤보 +1). 닭둘기는 3박수(1/3, 2/3 말풍선) 후 비킴. 구튜버 짝/잡기 = 'live' 참사. 빈 곳 헛박수 3연속 = 'claps'.
9. 참사: 0.5초 프리즈(캔버스 흑백·확대, 아이콘 숨김, 들린 비둘기는 원위치 착지) → 컷신(레터박스, deco, 등급 스탬프, 뉴스 바, 결과 줄, 힌트). 충돌 키 우선순위: 황금 탑승 중 → legend, 콤보 ≥8 → special, 내가 놓은 비둘기 → self.
10. 일시정지 버튼·앱 전환·화면 밖이면 루프 정지. reduce-motion이면 자동 데모 자동재생 없음.
11. 카메라 롤 ±0.026rad 이내, 기울기는 뒷통수 모델(±0.14rad). 헤드밥 없음.
12. 문구 금지어: 잡았다·처리·치웠다·포획 등. '모셔다 드림·탑승·이동 도움'을 쓴다.
