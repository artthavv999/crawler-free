// The one easing curve used by every timed animation (CSS --ease, GSAP, Lenis scrollTo).
export const CURVE = [0.65, 0.05, 0.36, 1];

// cubic-bezier(x1, y1, x2, y2) as a function of progress: Newton steps, bisection if they wander.
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t;
  const sy = (t) => ((ay * t + by) * t + cy) * t;
  const dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const e = sx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-5 || Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    if (t < 0 || t > 1 || Math.abs(sx(t) - x) > 1e-3) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 24; i++) { t = (lo + hi) / 2; if (sx(t) < x) lo = t; else hi = t; }
    }
    return sy(t);
  };
}

export const ease = bezier(...CURVE);
