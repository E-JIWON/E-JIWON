// 작은 수학 도우미(원본 프로토타입의 clamp와 'x += (목표-x)*min(1, dt*k)' 지수 추종을 이름 붙여 모음).

/** v를 [a, b] 범위로 자른다. */
export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** 선형 보간. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/** 프레임 독립 추종 비율. 원본의 Math.min(1, dt*k)와 같다. */
export const followK = (k: number, dt: number): number => Math.min(1, dt * k);

/** cur를 target 쪽으로 k 속도로 끌어당긴 값(원본 지수 추종식 그대로). */
export const damp = (cur: number, target: number, k: number, dt: number): number =>
  cur + (target - cur) * followK(k, dt);
