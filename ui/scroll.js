// "Scroll to this element": native by default; motion.js swaps in Lenis on desktop.
const reduce = matchMedia("(prefers-reduced-motion: reduce)");
let impl = (el) => el.scrollIntoView({ behavior: reduce.matches ? "auto" : "smooth", block: "start" });

export const setScroller = (fn) => { impl = fn; };
export const scrollToEl = (el) => impl(el);

// Brings an element near the top of the screen, unless it's already comfortably in view.
export function bringIntoView(el) {
  const top = el.getBoundingClientRect().top;
  if (top < 64 || top > innerHeight * 0.7) impl(el);
}
