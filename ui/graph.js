// A made-up "website": a start page, the pages it links to, and so on four links deep, plus some cross links.
// Each node has `t`, the moment a crawl starting at the start page would reach it. Deterministic, so the WebGL hero
// and the static fallback image (public/web.svg) draw the same web.

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => scale(a, 1 / (len(a) || 1));
function dir(r) {
  const z = r() * 2 - 1, a = r() * Math.PI * 2, s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), s * Math.sin(a), z];
}

export function makeGraph(seed = 11) {
  const r = rng(seed);
  const nodes = [{ p: [0, 0, 0], depth: 0, t: 0 }];
  const edges = [];
  const children = [6, 3, 2, 2]; // most links followed from a page at each depth
  const reach = [1.6, 1.2, 0.95, 0.75];
  let frontier = [0];
  for (let d = 0; d < children.length; d++) {
    const next = [];
    for (const i of frontier) {
      const parent = nodes[i];
      const n = d === 0 ? children[0] : 1 + Math.floor(r() * children[d]);
      for (let k = 0; k < n; k++) {
        const out = d === 0 ? dir(r) : norm(add(scale(norm(parent.p), 1.2), dir(r)));
        const p = add(parent.p, scale(out, reach[d] * (0.75 + r() * 0.5)));
        p[2] *= 0.7; // a flatter web reads better on screen
        nodes.push({ p, depth: d + 1, t: parent.t + 0.7 + r() * 0.5 });
        edges.push([i, nodes.length - 1]);
        next.push(nodes.length - 1);
      }
    }
    frontier = next;
  }
  const linked = new Set(edges.map(([a, b]) => `${a}-${b}`));
  for (let k = 0, extra = 0; k < 400 && extra < 18; k++) {
    const a = 1 + Math.floor(r() * (nodes.length - 1)), b = 1 + Math.floor(r() * (nodes.length - 1));
    const d = len(add(nodes[a].p, scale(nodes[b].p, -1)));
    if (a === b || d > 1.5 || linked.has(`${a}-${b}`) || linked.has(`${b}-${a}`)) continue;
    linked.add(`${a}-${b}`);
    edges.push([a, b]);
    extra++;
  }
  return { nodes, edges, maxT: Math.max(...nodes.map((n) => n.t)) };
}

// Static fallback for phones, reduced motion and no WebGL: the same web, seen from a fixed angle.
export function webSvg() {
  const { nodes, edges } = makeGraph();
  const rx = 0.45, ry = 0.6;
  const at = ([x, y, z]) => {
    const x1 = x * Math.cos(ry) + z * Math.sin(ry), z1 = -x * Math.sin(ry) + z * Math.cos(ry);
    const y1 = y * Math.cos(rx) - z1 * Math.sin(rx);
    return [(500 + x1 * 105).toFixed(1), (500 - y1 * 105).toFixed(1)];
  };
  const pts = nodes.map((n) => at(n.p));
  const lines = edges.map(([a, b]) => {
    const lit = Math.max(nodes[a].t, nodes[b].t) < 2.2;
    return `<line x1="${pts[a][0]}" y1="${pts[a][1]}" x2="${pts[b][0]}" y2="${pts[b][1]}" stroke="${lit ? "#6E9BFF" : "#8FA3C4"}" stroke-opacity="${lit ? 0.75 : 0.28}"/>`;
  });
  const dots = nodes.map((n, i) => {
    const lit = n.t < 2.2;
    return `<circle cx="${pts[i][0]}" cy="${pts[i][1]}" r="${Math.max(2, 6 - n.depth)}" fill="${lit ? "#9DBBFF" : "#8FA3C4"}" fill-opacity="${lit ? 1 : 0.55}"/>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 1000"><defs><radialGradient id="g"><stop offset="0" stop-color="#6E9BFF" stop-opacity="0.35"/><stop offset="1" stop-color="#6E9BFF" stop-opacity="0"/></radialGradient></defs><circle cx="${pts[0][0]}" cy="${pts[0][1]}" r="220" fill="url(#g)"/><g stroke-width="1.5">${lines.join("")}</g>${dots.join("")}</svg>\n`;
}
