// Ephyra · cut C "Short film" — one pinned stage, scroll scrubs the jelly's state.
// Every state is a pure function of scroll position, so scrolling back really rewinds.
// Springs follow those targets so the jelly stays soft; impulses fire on threshold crossings.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const mobileMQ = matchMedia("(max-width: 760px)");
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const win = (a, b, c, d, t) => smooth(a, b, t) * (1 - smooth(c, d, t));

// ── Spring solver (from cut B) ──
const spring = (x = 0) => ({ x, v: 0 });
function step(s, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 120)), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (-k * (s.x - target) - c * s.v) * h; s.x += s.v * h; }
  return s.x;
}
const settle = (s, target) => { s.x = target; s.v = 0; return target; };

// ── Theme ──
(function theme() {
  const btn = $(".theme"); if (!btn) return;
  const modes = ["system", "dark", "light"];
  const apply = (m) => {
    if (m === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = m;
    btn.dataset.mode = m; btn.setAttribute("aria-label", `Color theme: ${m}`);
    try { if (m === "system") localStorage.removeItem("ephyra-c-theme"); else localStorage.setItem("ephyra-c-theme", m); } catch (e) {}
  };
  apply(document.documentElement.dataset.theme || "system");
  btn.addEventListener("click", () => apply(modes[(modes.indexOf(btn.dataset.mode) + 1) % modes.length]));
})();

// ── Scene definitions ──
// anchor: where the leader line points, in object space (0..1 of the jelly box).
const SCENES = [
  { anchor: [0.52, 0.37] },  // 0 calm, the ephyra
  { anchor: [0.5, 0.31] },   // 1 the droplet
  { anchor: [0.66, 0.3] },   // 2 the thread's last bead
  { anchor: [0.52, 0.37] },  // 3 the ephyra under the loupe
  { anchor: [0.5, 0.02] },   // 4 the keycap
  { anchor: [0.32, 0.24] },  // 5 the crisp highlight
  { anchor: [0.5, 0.86] },   // 6 the slumped base
  { anchor: [0.78, 0.2] },   // 7 a seed
  { anchor: [0.5, 0.86] },   // 8 the lightbox
  { anchor: [0.64, 0.83] },  // 9 the set rim
];
const N_SCENES = SCENES.length;

// The whole film as a function of p (continuous scene index). Scene i owns p ∈ [i-.5, i+.5).
function evaluate(p) {
  const i = clamp(Math.round(p), 0, N_SCENES - 1);
  const t = clamp(p - (i - 0.5), 0, 1);
  const S = {
    i, t,
    pulse: 0.3, squash: 0, cam: 1, sharp: 0, tint: 0, slump: 0, split: 0, firm: 0,
    drop: 0, ripple: 0, merge: 0, thread: 0, key: 0, press: 0, spec: 0,
  };
  switch (i) {
    case 0: S.pulse = 1; break;
    case 1:
      S.pulse = 0.5;
      S.drop = 1; S.dropY = lerp(-0.5, 0.31, smooth(0, 0.3, t)); S.landed = smooth(0.3, 0.34, t);
      S.ripple = win(0.3, 0.32, 0.5, 1, t); S.rippleR = smooth(0.3, 0.95, t);
      break;
    case 2:
      S.drop = 1; S.dropY = 0.31; S.landed = 1;
      S.merge = smooth(0, 0.3, t); S.thread = smooth(0.25, 0.62, t);
      break;
    case 3:
      S.cam = lerp(1, 1.55, smooth(0, 0.5, t)); S.sharp = smooth(0.15, 0.6, t);
      S.thread = 1 - smooth(0, 0.4, t);
      break;
    case 4:
      S.cam = lerp(1.55, 1.08, smooth(0, 0.3, t)); S.sharp = 1 - smooth(0, 0.3, t);
      S.key = win(0.02, 0.15, 0.8, 0.98, t); S.press = win(0.3, 0.4, 0.48, 0.56, t); S.squash = S.press;
      break;
    case 5: S.firm = smooth(0.15, 0.6, t); S.pulse = 0.3 * (1 - S.firm); S.spec = S.firm; break;
    case 6:
      S.tint = win(0.05, 0.3, 0.6, 0.9, t); S.slump = win(0.08, 0.38, 0.6, 0.92, t); S.pulse = 0.2;
      break;
    case 7: S.split = smooth(0.05, 0.5, t); S.pulse = 0; break;
    case 8: S.split = 1 - smooth(0, 0.45, t); S.pulse = 0.4 * smooth(0.3, 0.8, t); break;
    case 9: S.firm = 1; S.spec = 1; S.pulse = 0; break;
  }
  return S;
}

// ── Scroll model ──
const film = $(".film"), stage = $(".stage"), object = $(".object");
const root = document.documentElement;
const scroll = { p: 0, v: 0, lastY: 0, lastT: 0 };
let vh = innerHeight;
function readScroll() {
  vh = stage.getBoundingClientRect().height || innerHeight;
  const top = film.offsetTop;
  scroll.p = clamp((scrollY - top) / vh, 0, N_SCENES - 1);
}
addEventListener("scroll", () => {
  const now = performance.now(), dt = Math.max(1, now - scroll.lastT) / 1000;
  scroll.v = clamp((scrollY - scroll.lastY) / vh / dt, -12, 12);
  scroll.lastY = scrollY; scroll.lastT = now;
  readScroll(); kick();
}, { passive: true });
addEventListener("resize", () => { readScroll(); kick(); });

// Beads scroll to their scene; CSS scroll-snap (proximity) does the gentle settling.
$$(".bead").forEach((b) => b.addEventListener("click", () => {
  scrollTo({ top: film.offsetTop + Number(b.dataset.s) * vh, behavior: reduced ? "auto" : "smooth" });
}));

// ── Captions, beads, leader ──
const caps = $$(".cap"), beads = $$(".bead"), leaders = $(".leaders");
const leaderPath = document.createElementNS("http://www.w3.org/2000/svg", "path");
const leaderDot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
leaderDot.setAttribute("r", "3.5");
leaderPath.setAttribute("pathLength", "1");
leaders.append(leaderPath, leaderDot);
let shownScene = -1;
function showScene(i) {
  if (i === shownScene) return;
  const prev = shownScene; shownScene = i;
  caps.forEach((c, k) => { c.classList.toggle("is-now", k === i); c.classList.toggle("is-prev", k === prev && prev !== i); });
  beads.forEach((b, k) => { b.classList.toggle("is-now", k === i); b.classList.toggle("is-done", k < i); b.toggleAttribute("aria-current", k === i); });
  leaderDraw.x = 0; leaderDraw.v = 0;
}
const leaderDraw = spring(0);
function firstLineRect(el) {
  const range = document.createRange(); range.selectNodeContents(el);
  const rects = range.getClientRects(); return rects.length ? rects[0] : el.getBoundingClientRect();
}
function drawLeader(S, dt) {
  const cap = caps[S.i]; if (!cap) return;
  const st = stage.getBoundingClientRect(), or = object.getBoundingClientRect();
  const [ax, ay] = SCENES[S.i].anchor;
  let ex = or.left + ax * or.width - st.left, ey = or.top + ay * or.height - st.top;
  if (S.i === 6) ey += S.slump * or.height * 0.03;
  if (S.i === 4) ey -= S.press * or.height * 0.02;
  const line = firstLineRect($(".line", cap));
  const mobile = mobileMQ.matches, side = mobile ? "b" : cap.dataset.side;
  let sx, sy, mx, my;
  if (side === "l") { sx = line.right - st.left + 14; sy = line.top + line.height / 2 - st.top; mx = sx + 28; my = sy; }
  else if (side === "r") { sx = line.left - st.left - 14; sy = line.top + line.height / 2 - st.top; mx = sx - 28; my = sy; }
  else {
    const r = cap.getBoundingClientRect();
    sx = mobile ? line.left - st.left + 18 : r.left + r.width / 2 - st.left;
    sy = line.top - st.top - 12; mx = sx; my = sy - 22;
  }
  leaderPath.setAttribute("d", `M${sx.toFixed(1)} ${sy.toFixed(1)}L${mx.toFixed(1)} ${my.toFixed(1)}L${ex.toFixed(1)} ${ey.toFixed(1)}`);
  leaderDot.setAttribute("cx", ex.toFixed(1)); leaderDot.setAttribute("cy", ey.toFixed(1));
  const d = reduced ? settle(leaderDraw, 1) : step(leaderDraw, 1, 60, 12, dt);
  leaderPath.style.strokeDasharray = "1"; leaderPath.style.strokeDashoffset = String(1 - clamp(d, 0, 1));
  leaderDot.style.opacity = String(clamp((d - 0.85) / 0.15, 0, 1));
}

// ── Overlay (SVG): droplet, goo merge, thread with beads, keycap, highlight, seeds ──
const NS = "http://www.w3.org/2000/svg";
const overlay = $(".overlay");
const el = (tag, attrs = {}, parent = overlay) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, String(attrs[k])); parent.append(e); return e; };
const O = (u, v) => [((u + 0.3) / 1.6) * 1000, ((v + 0.3) / 1.6) * 1000];
const UNIT = 1000 / 1.6;
// goo filter
const defs = el("defs");
const goo = el("filter", { id: "goo", x: "-50%", y: "-50%", width: "200%", height: "200%" }, defs);
el("feGaussianBlur", { in: "SourceGraphic", stdDeviation: 9, result: "b" }, goo);
el("feColorMatrix", { in: "b", mode: "matrix", values: "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 24 -10", result: "g" }, goo);
el("feComposite", { in: "SourceGraphic", in2: "g", operator: "atop" }, goo);
const ripples = [0, 1, 2].map(() => el("ellipse", { class: "ripple" }));
const gooG = el("g", { filter: "url(#goo)" });
const drops = [0, 1, 2, 3].map(() => el("circle", { class: "drop", r: 0 }, gooG));
const threadGlow = el("path", { class: "thread-glow", pathLength: 1 });
const thread = el("path", { class: "thread", pathLength: 1 });
const P = [O(0.1, 0.56), O(0.22, 0.2), O(0.4, 0.6), O(0.52, 0.37), O(0.66, 0.18), O(0.72, 0.46), O(0.9, 0.52)];
const threadD = `M${P[0]}C${P[1]} ${P[2]} ${P[3]}S${P[4]} ${P[5]}S${P[6]} ${P[6]}`;
thread.setAttribute("d", threadD); threadGlow.setAttribute("d", threadD);
const threadLen = thread.getTotalLength();
const beadDots = [0.36, 0.68, 1].map((f) => ({ f, el: el("circle", { class: "tbead", r: 10 }) }));
const specEl = el("ellipse", { class: "spec", cx: O(0.33, 0.24)[0], cy: O(0.33, 0.24)[1], rx: 46, ry: 14, transform: `rotate(-22 ${O(0.33, 0.24)})` });
// keycap: an HTML element in object space; its glyph is CSS content so it never joins the page's text
const keyG = document.createElement("div"); keyG.className = "keycap"; keyG.setAttribute("aria-hidden", "true"); object.append(keyG);
// seeds in a loose ring, like the forge plate
const SEEDS = [[0.78, 0.2, 30], [0.22, 0.16, 24], [0.9, 0.56, 28], [0.1, 0.5, 22], [0.68, 0.86, 26], [0.32, 0.9, 20], [0.5, 0.46, 18]];
const seedC = O(0.5, 0.45);
const fils = [[0, 6], [1, 6], [2, 6], [3, 6], [4, 6], [5, 6], [0, 2], [1, 3], [4, 2], [5, 3], [0, 1], [4, 5]].map(([a, b]) => ({ a, b, el: el("line", { class: "fil", pathLength: 1 }) }));
const seedGrad = el("radialGradient", { id: "seedg", cx: "38%", cy: "32%", r: "70%" }, defs);
el("stop", { offset: "0", "stop-color": "#ffe9b8" }, seedGrad); el("stop", { offset: "0.45", "stop-color": "#eca139" }, seedGrad); el("stop", { offset: "1", "stop-color": "#9a541c" }, seedGrad);
const specGrad = el("radialGradient", { id: "specg" }, defs);
el("stop", { offset: "0", "stop-color": "#fff", "stop-opacity": "0.95" }, specGrad); el("stop", { offset: "1", "stop-color": "#fff", "stop-opacity": "0" }, specGrad);
specEl.setAttribute("fill", "url(#specg)");
const seeds = SEEDS.map(([u, v, r]) => { const g = el("g", { class: "seedg" }); return { x: O(u, v)[0], y: O(u, v)[1], r, g, el: el("circle", { class: "seed", r, fill: "url(#seedg)" }, g), hi: el("ellipse", { class: "seedhi", fill: "url(#specg)" }, g) }; });
const jellyLayers = [$(".jelly-img"), $(".jelly-canvas"), $(".jelly-css")];

function drawOverlay(S) {
  // droplet + ripples (scenes 1–2)
  const dropOn = S.drop > 0;
  const [dx, dy] = O(0.5, S.dropY ?? 0.31);
  drops[0].setAttribute("cx", dx); drops[0].setAttribute("cy", dy);
  drops[0].setAttribute("r", dropOn ? (18 - 6 * (S.landed || 0)) : 0);
  ripples.forEach((r, k) => {
    const rr = S.ripple * (0.08 + 0.1 * k + 0.22 * (S.rippleR || 0)) * UNIT;
    r.setAttribute("cx", dx); r.setAttribute("cy", O(0.5, 0.31)[1]);
    r.setAttribute("rx", rr); r.setAttribute("ry", rr * 0.42);
    r.style.opacity = String(S.ripple * (1 - (S.rippleR || 0)) * (1 - k * 0.25));
  });
  // goo merge (scene 2): three stray droplets travel to the centre one and fuse
  const starts = [[0.25, 0.22], [0.76, 0.24], [0.62, 0.6]];
  starts.forEach(([u, v], k) => {
    const on = S.merge > 0 || S.i === 2;
    const uu = lerp(u, 0.5, S.merge), vv = lerp(v, 0.31, S.merge);
    const [x, y] = O(uu, vv);
    drops[k + 1].setAttribute("cx", x); drops[k + 1].setAttribute("cy", y);
    drops[k + 1].setAttribute("r", on ? 11 * (1 - 0.6 * smooth(0.8, 1, S.merge)) : 0);
  });
  gooG.style.opacity = String(S.i === 2 ? 1 - smooth(0.3, 0.45, S.t) : S.i === 1 ? 1 : 0);
  // thread with beads (scene 2 → fades in 3)
  const tdraw = S.thread;
  for (const pth of [thread, threadGlow]) { pth.style.strokeDasharray = "1"; pth.style.strokeDashoffset = String(1 - tdraw); pth.style.opacity = tdraw > 0 ? "1" : "0"; }
  beadDots.forEach(({ f, el: b }) => {
    const on = tdraw >= f - 0.001; const pt = thread.getPointAtLength(threadLen * Math.min(f, 0.999));
    b.setAttribute("cx", pt.x); b.setAttribute("cy", pt.y);
    b.setAttribute("r", on ? 10 : 0); b.style.opacity = on ? String(Math.min(1, tdraw)) : "0";
  });
  // keycap (scene 4)
  keyG.style.opacity = String(S.key);
  keyG.style.translate = `-50% calc(-50% + ${(S.press * 12).toFixed(2)}%)`;
  // crisp highlight (scenes 5, 9)
  specEl.style.opacity = String(0.9 * S.spec);
  // constellation (scenes 7–8)
  const sp = S.split;
  seeds.forEach((s) => {
    const x = lerp(seedC[0], s.x, sp), y = lerp(seedC[1], s.y, sp);
    const rr = s.r * smooth(0, 0.5, sp);
    s.el.setAttribute("cx", x); s.el.setAttribute("cy", y); s.el.setAttribute("r", rr);
    s.hi.setAttribute("cx", x - rr * 0.3); s.hi.setAttribute("cy", y - rr * 0.38); s.hi.setAttribute("rx", rr * 0.42); s.hi.setAttribute("ry", rr * 0.26);
    s.g.style.opacity = String(smooth(0, 0.3, sp));
    s._x = x; s._y = y;
  });
  fils.forEach(({ a, b, el: l }) => {
    l.setAttribute("x1", seeds[a]._x); l.setAttribute("y1", seeds[a]._y); l.setAttribute("x2", seeds[b]._x); l.setAttribute("y2", seeds[b]._y);
    l.style.strokeDasharray = "1"; l.style.strokeDashoffset = String(1 - smooth(0.35, 1, sp)); l.style.opacity = String(0.8 * smooth(0.3, 0.6, sp));
  });
  const jellyAlpha = 1 - smooth(0.2, 0.75, sp);
  jellyLayers.forEach((l) => { if (l) l.style.opacity = String(jellyAlpha); });
  root.style.setProperty("--plate", (sp * 1).toFixed(3));
}

// ── Jelly: WebGL mesh warp (adapted from cut B) ──
const canvas = $(".jelly-canvas");
const img = $(".jelly-img");
let gl = null, jelly = null;
function initJelly() {
  if (reduced) return;
  gl = canvas.getContext("webgl", { alpha: true, premultipliedAlpha: true, antialias: true });
  if (!gl) return;
  const COLS = 24, ROWS = 24, NX = COLS + 1, NY = ROWS + 1, N = NX * NY;
  const rest = new Float32Array(N * 2), pos = new Float32Array(N * 2), uv = new Float32Array(N * 2);
  const dsp = new Float32Array(N * 2), vel = new Float32Array(N * 2), strain = new Float32Array(N);
  const pin = new Float32Array(N), mob = new Float32Array(N);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const n = j * NX + i, u = i / COLS, v = j / ROWS;
    rest[n * 2] = u; rest[n * 2 + 1] = v; uv[n * 2] = u; uv[n * 2 + 1] = v;
    pin[n] = 1 + 60 * smooth(0.74, 0.93, v); mob[n] = 1 - smooth(0.7, 0.93, v);
  }
  const idx = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) { const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1; idx.push(a, b, c, b, d, c); }
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
    attribute vec2 a_p; attribute vec2 a_uv; attribute float a_s;
    varying vec2 v_uv; varying float v_s;
    void main() { v_uv = a_uv; v_s = a_s; vec2 c = (a_p + 0.2) / 1.4; gl_Position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0); }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
    precision mediump float; uniform sampler2D u_t; uniform float u_tint; uniform vec3 u_cherry; varying vec2 v_uv; varying float v_s;
    void main() {
      vec4 c = texture2D(u_t, v_uv);
      vec3 rgb = c.rgb + vec3(0.9, 0.85, 0.7) * v_s * c.a;
      float lum = dot(c.rgb, vec3(0.3, 0.5, 0.2));
      rgb = mix(rgb, u_cherry * (0.25 + 1.45 * lum) * c.a, 0.82 * u_tint * c.a);
      gl_FragColor = vec4(rgb, c.a);
    }`));
  gl.linkProgram(prog); gl.useProgram(prog);
  const buf = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage); return b; };
  const bPos = buf(pos, gl.DYNAMIC_DRAW), bUv = buf(uv, gl.STATIC_DRAW), bS = buf(strain, gl.DYNAMIC_DRAW);
  const attr = (name, b, size) => { const l = gl.getAttribLocation(prog, name); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); };
  attr("a_p", bPos, 2); attr("a_uv", bUv, 2); attr("a_s", bS, 1);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  const uTint = gl.getUniformLocation(prog, "u_tint"), uCherry = gl.getUniformLocation(prog, "u_cherry");
  const tex = gl.createTexture();
  let ready = false;
  const resize = () => {
    const dpr = Math.min(2, (devicePixelRatio || 1) * 1.3), r = canvas.getBoundingClientRect();
    canvas.width = Math.round(Math.min(2048, r.width * dpr)); canvas.height = Math.round(Math.min(2048, r.height * dpr));
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  new ResizeObserver(resize).observe(canvas);
  const upload = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    ready = true; object.classList.add("has-gl"); resize();
  };
  if (img.complete && img.naturalWidth) upload(); else img.addEventListener("load", upload, { once: true });
  const KR = 250, KC = 2400;
  const bell = (t) => { const p = t % 2.05; return p < 0.35 ? smooth(0, 0.35, p) : p < 1.45 ? 1 - smooth(0.35, 1.45, p) : 0; };
  let time = 0;
  function physics(h, S, damp) {
    const b = bell(time) * S.pulse;
    const sag = S.slump;
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const n = j * NX + i, n2 = n * 2, u = rest[n2], v = rest[n2 + 1];
      // target rest: bell contraction (narrower, taller around the top centre) + slump sag
      let tx = (u - 0.5) * (-0.03 * b * (1 - v)) ;
      let ty = -0.02 * b * (1 - v) + sag * (0.035 * (1 - v) * (1 - Math.abs(u - 0.5) * 1.2));
      tx += sag * 0.09 * (u - 0.5) * smooth(0.3, 1, v) * 2;
      const dx = dsp[n2] - tx, dy = dsp[n2 + 1] - ty;
      let ax = -KR * pin[n] * dx - damp * vel[n2], ay = -KR * pin[n] * dy - damp * vel[n2 + 1];
      let lx = 0, ly = 0, c = 0;
      if (i > 0) { lx += dsp[n2 - 2]; ly += dsp[n2 - 1]; c++; }
      if (i < COLS) { lx += dsp[n2 + 2]; ly += dsp[n2 + 3]; c++; }
      if (j > 0) { lx += dsp[n2 - NX * 2]; ly += dsp[n2 - NX * 2 + 1]; c++; }
      if (j < ROWS) { lx += dsp[n2 + NX * 2]; ly += dsp[n2 + NX * 2 + 1]; c++; }
      ax += KC * (lx / c - dsp[n2]); ay += KC * (ly / c - dsp[n2 + 1]);
      vel[n2] += ax * h; vel[n2 + 1] += ay * h;
    }
    for (let n = 0; n < N; n++) { const n2 = n * 2; dsp[n2] += vel[n2] * h; dsp[n2 + 1] += vel[n2 + 1] * h; }
  }
  function impulse(px, py, fx, fy, sigma, toward) {
    for (let n = 0; n < N; n++) {
      const n2 = n * 2, dx = rest[n2] - px, dy = rest[n2 + 1] - py;
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * mob[n];
      if (w < 0.01) continue;
      vel[n2] += (fx - dx * toward) * w; vel[n2 + 1] += (fy - dy * toward) * w;
    }
  }
  const cherryRGB = () => {
    const c = getComputedStyle(root).getPropertyValue("--cherry").trim();
    const cv = document.createElement("canvas").getContext("2d"); cv.fillStyle = c; cv.fillRect(0, 0, 1, 1);
    const d = cv.getImageData(0, 0, 1, 1).data; return [d[0] / 255, d[1] / 255, d[2] / 255];
  };
  let cherry = cherryRGB();
  new MutationObserver(() => { cherry = cherryRGB(); }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { cherry = cherryRGB(); });
  function draw(dt, S) {
    if (!ready) return;
    time += dt;
    const damp = 3 + 10 * S.firm;
    const n = Math.ceil(dt * 240), h = dt / n;
    for (let k = 0; k < n; k++) physics(h, S, damp);
    for (let i = 0; i < N; i++) {
      pos[i * 2] = rest[i * 2] + dsp[i * 2]; pos[i * 2 + 1] = rest[i * 2 + 1] + dsp[i * 2 + 1];
      strain[i] = clamp(Math.hypot(dsp[i * 2], dsp[i * 2 + 1]) * 3.2, 0, 0.5) * mob[i];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bS); gl.bufferSubData(gl.ARRAY_BUFFER, 0, strain);
    gl.uniform1f(uTint, S.tint); gl.uniform3f(uCherry, cherry[0], cherry[1], cherry[2]);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
  }
  jelly = { draw, impulse, get ready() { return ready; } };
}
img.addEventListener("error", () => object.classList.add("no-img"), { once: true });
if (img.complete && img.naturalWidth === 0) object.classList.add("no-img");
const mark = $(".mark");
if (mark) { const hide = () => { mark.style.display = "none"; }; mark.addEventListener("error", hide, { once: true }); if (mark.complete && mark.naturalWidth === 0) hide(); }
try { initJelly(); } catch (e) { gl = null; jelly = null; }

// ── Main loop: scrub → targets → springs → DOM ──
const sq = spring(0), cam = spring(1), ox = spring(0), oy = spring(0), skew = spring(0), slumpS = spring(0), sharpS = spring(0);
let lastP = 0, lastT = 0, rafId = 0, visible = true, idleFrames = 0;
function kick() { idleFrames = 0; if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); } }
function frame(now) {
  rafId = 0;
  const dt = Math.min(0.05, (now - lastT) / 1000 || 1 / 60); lastT = now;
  const S = evaluate(scroll.p);
  showScene(S.i);
  // threshold crossings → impulses (both directions, so a rewind re-splashes)
  const pPrev = lastP, p = scroll.p;
  const crossed = (x) => (pPrev < x && p >= x) || (pPrev > x && p <= x);
  if (jelly) {
    if (crossed(0.5 + 0.3)) jelly.impulse(0.5, 0.31, 0, 0.5, 0.1, 10);          // droplet lands
    if (crossed(3.5 + 0.4) || crossed(3.5 + 0.56)) jelly.impulse(0.5, 0.2, 0, 0.9, 0.22, 4); // keycap press / release
    if (crossed(5.5 + 0.08)) jelly.impulse(0.5, 0.5, 0, 0.3, 0.3, 0);          // slump begins
    if (crossed(7.5 + 0.45)) jelly.impulse(0.5, 0.4, 0, 0.0, 0.2, 6);         // seeds re-fuse
    // scroll velocity → wobble
    const sv = scroll.v; scroll.v *= Math.pow(0.001, dt);
    if (Math.abs(sv) > 0.05) jelly.impulse(0.5, 0.25, 0, clamp(sv * 0.045, -0.5, 0.5), 0.2, 0);
  } else scroll.v *= Math.pow(0.001, dt);
  lastP = p;

  // springs following the scrubbed targets (instant under reduced motion)
  const F = reduced ? settle : (s, t, k, c) => step(s, t, k, c, dt);
  const side = mobileMQ.matches ? 0 : caps[S.i].dataset.side === "l" ? 1 : caps[S.i].dataset.side === "r" ? -1 : 0;
  const upward = !mobileMQ.matches && caps[S.i].dataset.side === "b" ? -0.09 : 0;
  F(sq, S.squash, 180, 14); F(cam, S.cam, 90, 14); F(ox, side * vh * 0.045, 60, 11); F(oy, upward * vh, 60, 11);
  F(slumpS, S.slump, 90, 12); F(sharpS, S.sharp, 120, 16); F(skew, clamp(scroll.v * 1.4, -5, 5), 120, 10);
  const sx = 1 + 0.08 * clamp(sq.x, -0.5, 1.2) + 0.1 * slumpS.x, sy = 1 / sx;
  root.style.setProperty("--cam", cam.x.toFixed(4));
  root.style.setProperty("--ox", ox.x.toFixed(1) + "px");
  root.style.setProperty("--oy", oy.x.toFixed(1) + "px");
  root.style.setProperty("--sharp", clamp(sharpS.x, 0, 1).toFixed(3));
  root.style.setProperty("--firm", S.firm.toFixed(3));
  root.style.setProperty("--p", (p / (N_SCENES - 1)).toFixed(4));
  object.style.transform = `scale(${cam.x.toFixed(4)}) translateY(${(slumpS.x * 3).toFixed(2)}%) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`;
  caps[S.i].style.transform = reduced ? "" : `skewX(${skew.x.toFixed(2)}deg)`;
  if (!reduced && caps[S.i].classList.contains("firmable")) caps[S.i].style.setProperty("--firm", S.firm.toFixed(3));

  drawOverlay(S);
  drawLeader(S, dt);
  if (jelly && visible && !document.hidden) jelly.draw(dt, S);

  const moving = Math.abs(scroll.v) > 0.01 || Math.abs(sq.v) + Math.abs(cam.v) + Math.abs(ox.v) + Math.abs(oy.v) + Math.abs(slumpS.v) > 0.01 || leaderDraw.x < 0.999;
  const alive = jelly && visible && !document.hidden && S.pulse > 0; // the bell keeps pulsing while on screen
  idleFrames = moving ? 0 : idleFrames + 1;
  if (!reduced && (alive || idleFrames < 90)) rafId = requestAnimationFrame(frame);
  else if (reduced && (moving || idleFrames < 20)) rafId = requestAnimationFrame(frame);
}
new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) kick(); }).observe(stage);
document.addEventListener("visibilitychange", () => { if (!document.hidden) kick(); });
mobileMQ.addEventListener("change", kick);
document.fonts?.ready.then(kick);
readScroll(); kick();
