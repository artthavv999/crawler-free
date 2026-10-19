// Motion layer, loaded only when the visitor hasn't asked for reduced motion. Without it every element is simply
// visible, so nothing here is needed to read the page or use the reader.
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ease } from "./ease.js";

const below = (el) => el.getBoundingClientRect().top > innerHeight * 0.92; // only hide what isn't on screen yet

export function start(setScroller) {
  gsap.registerPlugin(ScrollTrigger);
  gsap.defaults({ ease, duration: 0.9 });
  if (matchMedia("(pointer: fine)").matches) smoothScroll(setScroller);
  reveals();
  for (const el of document.querySelectorAll("[data-scramble]")) {
    if (below(el)) ScrollTrigger.create({ trigger: el, start: "top 90%", once: true, onEnter: () => scramble(el) });
    else scramble(el);
  }
  for (const card of document.querySelectorAll(".glowy")) {
    card.addEventListener("pointermove", (e) => {
      const r = card.getBoundingClientRect();
      card.style.setProperty("--mx", `${e.clientX - r.left}px`);
      card.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }
}

// Lenis on desktop pointers, driven by GSAP's ticker so ScrollTrigger stays in sync. Inner scroll boxes opt out
// with data-lenis-prevent; in-page links glide and still move keyboard focus to their target.
function smoothScroll(setScroller) {
  const lenis = new Lenis({ lerp: 0.1 });
  lenis.on("scroll", ScrollTrigger.update);
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  const to = (el) => lenis.scrollTo(el, { offset: -80, duration: 0.9, easing: ease });
  setScroller(to);
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (!target) return;
    e.preventDefault();
    to(target);
    target.focus({ preventScroll: true });
    history.pushState(null, "", a.getAttribute("href"));
  });
}

function reveals() {
  // Headings and short copy rise in.
  for (const el of document.querySelectorAll("[data-reveal]")) {
    if (!below(el)) continue;
    gsap.from(el, { opacity: 0, y: 32, scrollTrigger: { trigger: el, start: "top 90%", once: true } });
  }
  // Lists come in one item after another.
  for (const el of document.querySelectorAll("[data-stagger]")) {
    if (!below(el)) continue;
    gsap.from(el.children, { opacity: 0, y: 24, duration: 0.6, stagger: 0.08, scrollTrigger: { trigger: el, start: "top 88%", once: true } });
  }
  // The three steps open like curtains, top edge first, one after another.
  const steps = [...document.querySelectorAll("[data-curtain]")];
  if (steps.length && below(steps[0])) {
    gsap.fromTo(steps,
      { clipPath: "inset(0% 0% 100% 0% round 16px)", y: 40 },
      { clipPath: "inset(0% 0% 0% 0% round 16px)", y: 0, stagger: 0.12, clearProps: "clipPath",
        scrollTrigger: { trigger: steps[0].parentElement, start: "top 85%", once: true } });
  }
  // Large panels start tilted back and flatten as they scroll up (no opacity change, so text contrast never drops).
  for (const el of document.querySelectorAll("[data-tilt]")) {
    if (!below(el)) continue;
    gsap.fromTo(el,
      { rotateX: 12, y: 48, transformPerspective: 1400, transformOrigin: "50% 100%" },
      { rotateX: 0, y: 0, ease: "none", scrollTrigger: { trigger: el, start: "top 100%", end: "top 55%", scrub: 0.6 } });
  }
}

// Labels settle from random glyphs into their text (0.6 s). Screen readers get the real text from the start.
function scramble(el) {
  const text = el.textContent.trim();
  const real = document.createElement("span");
  real.className = "sr-only";
  real.textContent = text;
  const shown = document.createElement("span");
  shown.setAttribute("aria-hidden", "true");
  el.replaceChildren(real, shown);
  const glyphs = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789/<>+=";
  const t0 = performance.now();
  const tick = (now) => {
    const p = Math.min(1, (now - t0) / 600), n = Math.floor(ease(p) * text.length);
    let s = text.slice(0, n);
    for (let i = n; i < text.length; i++) s += text[i] === " " ? " " : glyphs[(Math.random() * glyphs.length) | 0];
    shown.textContent = s;
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
