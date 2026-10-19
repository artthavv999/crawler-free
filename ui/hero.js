// WebGL hero (desktop, WebGL, no reduced-motion only): a web of pages and links. The links draw themselves out from
// the start page, then a crawl pulse travels the web again and again, lighting each link as it reaches it.
// The camera leans toward the pointer and pulls back as the page scrolls. Rendering stops when the hero is
// off screen or the tab is hidden.
import { Camera, Geometry, Mesh, Program, Renderer, Transform } from "ogl";
import { makeGraph } from "./graph.js";

const LINE_VERT = /* glsl */ `
attribute vec3 position;
attribute float aT;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
varying float vT;
varying float vDepth;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vT = aT;
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;

const LINE_FRAG = /* glsl */ `
precision mediump float;
uniform float uBuild;
uniform float uWave;
uniform float uAlpha;
uniform vec3 uBase;
uniform vec3 uAccent;
varying float vT;
varying float vDepth;
void main() {
  float shown = smoothstep(vT - 0.15, vT, uBuild);
  float w = uWave - vT;
  float head = w >= 0.0 ? exp(-w * 2.2) : 0.0;
  float fog = clamp(1.2 - (vDepth - 6.0) / 8.0, 0.25, 1.0);
  float a = shown * uAlpha * fog * (0.22 + head * 0.95);
  vec3 col = mix(uBase, uAccent * 1.3, clamp(head * 1.4, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);
}`;

const POINT_VERT = /* glsl */ `
attribute vec3 position;
attribute float aT;
attribute float aSize;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform vec2 uMouse;
uniform float uAspect;
uniform float uDpr;
uniform float uWave;
uniform float uBuild;
varying float vLit;
varying float vShown;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vec2 ndc = gl_Position.xy / gl_Position.w;
  float near = smoothstep(0.3, 0.0, distance(ndc * vec2(uAspect, 1.0), uMouse * vec2(uAspect, 1.0)));
  float w = uWave - aT;
  float head = w >= 0.0 ? exp(-w * 1.8) : 0.0;
  vLit = max(head, near);
  vShown = smoothstep(aT - 0.1, aT + 0.1, uBuild);
  gl_PointSize = aSize * (1.0 + head * 0.8 + near * 1.6) * uDpr * (11.0 / -mv.z);
}`;

const POINT_FRAG = /* glsl */ `
precision mediump float;
uniform vec3 uBase;
uniform vec3 uAccent;
uniform float uAlpha;
varying float vLit;
varying float vShown;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float a = smoothstep(0.5, 0.15, r) * vShown * uAlpha * (0.5 + vLit * 0.6);
  vec3 col = mix(uBase * 0.8, uAccent * 1.4, vLit);
  gl_FragColor = vec4(col * a, a);
}`;

const BUILD = 1.2; // seconds for the web to draw itself
const SPEED = 1.4; // crawl pulse speed, in graph time units per second
const REST = 2.2;  // pause between pulses, seconds

export function start(host) {
  const { nodes, edges, maxT } = makeGraph();
  const renderer = new Renderer({ dpr: Math.min(window.devicePixelRatio || 1, 2), alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: "low-power" });
  const gl = renderer.gl;
  gl.clearColor(0, 0, 0, 0);
  gl.canvas.setAttribute("aria-hidden", "true");
  host.append(gl.canvas);

  const camera = new Camera(gl, { fov: 35, near: 0.1, far: 100 });
  camera.position.set(0, 0, 11);
  const scene = new Transform();
  const web = new Transform();
  web.setParent(scene);
  web.scale.set(0.8, 0.8, 0.8);

  const linePos = new Float32Array(edges.length * 6), lineT = new Float32Array(edges.length * 2);
  edges.forEach(([a, b], i) => {
    linePos.set(nodes[a].p, i * 6);
    linePos.set(nodes[b].p, i * 6 + 3);
    lineT[i * 2] = nodes[a].t;
    lineT[i * 2 + 1] = nodes[b].t;
  });
  const pointPos = new Float32Array(nodes.length * 3), pointT = new Float32Array(nodes.length), pointSize = new Float32Array(nodes.length);
  nodes.forEach((n, i) => {
    pointPos.set(n.p, i * 3);
    pointT[i] = n.t;
    pointSize[i] = n.depth === 0 ? 10 : Math.max(3, 7 - n.depth);
  });

  const uniforms = {
    uBuild: { value: 0 }, uWave: { value: -10 }, uAlpha: { value: 1 },
    uMouse: { value: [9, 9] }, uAspect: { value: 1 }, uDpr: { value: renderer.dpr },
    uBase: { value: [0.56, 0.64, 0.77] }, uAccent: { value: [0.43, 0.61, 1] },
  };
  const program = (vertex, fragment) => {
    const p = new Program(gl, { vertex, fragment, uniforms, transparent: true, depthTest: false, depthWrite: false });
    p.setBlendFunc(gl.ONE, gl.ONE); // additive: overlapping links glow
    return p;
  };
  const lines = new Mesh(gl, { mode: gl.LINES, geometry: new Geometry(gl, { position: { size: 3, data: linePos }, aT: { size: 1, data: lineT } }), program: program(LINE_VERT, LINE_FRAG) });
  const points = new Mesh(gl, { mode: gl.POINTS, geometry: new Geometry(gl, { position: { size: 3, data: pointPos }, aT: { size: 1, data: pointT }, aSize: { size: 1, data: pointSize } }), program: program(POINT_VERT, POINT_FRAG) });
  lines.setParent(web);
  points.setParent(web);

  let shift = 0;
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h);
    camera.perspective({ aspect: w / h });
    uniforms.uAspect.value = w / h;
    shift = w / h > 1.3 ? 3.1 : 0; // keep the web beside the reader, not behind it
  }
  new ResizeObserver(resize).observe(host);
  resize();

  const aim = { x: 0, y: 0 }, lean = { x: 0, y: 0 }, mouse = [9, 9];
  addEventListener("pointermove", (e) => {
    const r = gl.canvas.getBoundingClientRect();
    aim.x = (e.clientX / innerWidth) * 2 - 1;
    aim.y = -((e.clientY / innerHeight) * 2 - 1);
    mouse[0] = ((e.clientX - r.left) / r.width) * 2 - 1;
    mouse[1] = -(((e.clientY - r.top) / r.height) * 2 - 1);
  }, { passive: true });

  let raf = 0, last = 0, t = 0, onScreen = true, shown = false;
  const cycle = (maxT + 1.5) / SPEED + REST;
  function frame(now) {
    raf = 0;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 0;
    last = now;
    t += dt;
    uniforms.uBuild.value = Math.min(t / BUILD, 1) * (maxT + 0.6);
    const wt = t - BUILD - 0.2;
    uniforms.uWave.value = wt < 0 ? -10 : (wt % cycle) * SPEED - 0.5;
    const k = 1 - Math.exp(-dt * 2.5); // damped: the camera trails the pointer by about a second
    lean.x += (aim.x - lean.x) * k;
    lean.y += (aim.y - lean.y) * k;
    const u = uniforms.uMouse.value;
    u[0] += (mouse[0] - u[0]) * Math.min(1, k * 3);
    u[1] += (mouse[1] - u[1]) * Math.min(1, k * 3);
    web.position.x = shift;
    web.rotation.y = t * 0.035 + lean.x * 0.105; // ±6°
    web.rotation.x = 0.25 - lean.y * 0.105;
    const p = Math.min(Math.max(window.scrollY / host.clientHeight, 0), 1);
    camera.position.z = 11 + p * 5;
    uniforms.uAlpha.value = 1 - p * 0.85;
    renderer.render({ scene, camera });
    if (!shown) { shown = true; host.classList.add("live"); }
    run();
  }
  function run() {
    if (raf || !onScreen || document.hidden) { if (!onScreen || document.hidden) last = 0; return; }
    raf = requestAnimationFrame(frame);
  }
  new IntersectionObserver(([e]) => { onScreen = e.isIntersecting; run(); }).observe(host);
  document.addEventListener("visibilitychange", run);
  run();
}
