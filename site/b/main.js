// Ephyra · cut B "Lightbox" — jelly physics with no dependencies.
// Every motion maps to a product event: drop + squash = a signal lands, CASL 1→0 = it sets,
// slump = rollback, soft edges wobble more than the firm core.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const hoverless = matchMedia("(hover: none)").matches;
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wait = (ms) => new Promise((r) => setTimeout(r, reduced ? Math.min(ms, 250) : ms));

/* ───── One rAF for everything ───── */
const tickers = new Set();
let rafId = 0, lastT = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - lastT) / 1000 || 1 / 60);
  lastT = now;
  for (const f of [...tickers]) if (!f(dt, now / 1000)) tickers.delete(f);
  rafId = tickers.size ? requestAnimationFrame(frame) : 0;
}
function run(f) { tickers.add(f); if (!rafId) { lastT = performance.now(); rafId = requestAnimationFrame(frame); } }

/* ───── Springs (semi-implicit Euler, sub-stepped) ───── */
const spring = (x = 0) => ({ x, v: 0 });
function step(s, target, k, c, dt) {
  const n = Math.max(1, Math.ceil(dt * 240)), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (-k * (s.x - target) - c * s.v) * h; s.x += s.v * h; }
}
const near = (s, target, eps) => Math.abs(s.x - target) < eps && Math.abs(s.v) < eps * 8;

/* ───── Split text into words and letters ───── */
function splitChars(root) {
  const chars = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const tn of nodes) {
    const frag = document.createDocumentFragment();
    for (const part of tn.textContent.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) { frag.append(" "); continue; }
      const w = document.createElement("span");
      w.className = "word";
      for (const c of part) {
        const s = document.createElement("span");
        s.className = "ch"; s.textContent = c; w.append(s); chars.push(s);
      }
      frag.append(w);
    }
    tn.replaceWith(frag);
  }
  root.classList.add("split");
  return chars;
}

function writeLetter(L) {
  const fall = L.y.v > 0 && L.y.x < -1 ? Math.min(0.16, L.y.v / 3200) : 0;
  const s = clamp(L.s.x - fall, -0.4, 0.5);
  const sx = 1 + s, sy = 1 / (1 + s);
  const rot = L.r ? L.r.x : 0;
  L.el.style.transform = `translate3d(0,${L.y.x.toFixed(2)}px,0) rotate(${rot.toFixed(2)}deg) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
  L.el.style.setProperty("--casl", clamp(L.c.x, 0, 1).toFixed(3));
}

/* ───── Theme ───── */
(function theme() {
  const btn = $(".theme");
  const icons = {
    system: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M12 3.8a8.2 8.2 0 0 0 0 16.4Z" fill="currentColor"/><circle cx="12" cy="12" r="8.2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
    light: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="12" r="4.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></g></svg>',
    dark: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z" fill="currentColor"/></svg>',
  };
  const order = ["system", "light", "dark"];
  let mode = document.documentElement.dataset.theme || "system";
  const apply = () => {
    if (mode === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = mode;
    btn.innerHTML = icons[mode];
    btn.dataset.mode = mode;
    btn.setAttribute("aria-label", `Color theme: ${mode}`);
    try { mode === "system" ? localStorage.removeItem("ephyra-b-theme") : localStorage.setItem("ephyra-b-theme", mode); } catch (e) {}
  };
  btn.addEventListener("click", () => { mode = order[(order.indexOf(mode) + 1) % 3]; apply(); });
  apply();
})();

/* ───── Scroll bookkeeping (shared velocity) ───── */
const scroll = { y: scrollY, v: 0, t: performance.now() };
const scrollListeners = [];
addEventListener("scroll", () => {
  const now = performance.now(), dy = scrollY - scroll.y;
  scroll.v = (dy / Math.max(8, now - scroll.t)) * 1000;
  scroll.y = scrollY; scroll.t = now;
  $(".nav").classList.toggle("scrolled", scrollY > 8);
  for (const f of scrollListeners) f();
}, { passive: true });

/* ───── Hero headline: letters drop in like jelly cubes, then set ───── */
(function headline() {
  const h = $(".headline");
  const chars = splitChars(h);
  if (reduced) { h.classList.add("is-set"); return; }
  const fs = parseFloat(getComputedStyle(h).fontSize);
  const L = chars.map((el, i) => ({ el, i, y: spring(-fs * 1.5), s: spring(0), c: spring(1), t0: 0.35 + i * 0.04, started: false }));
  L.forEach((l) => { l.el.style.opacity = "0"; writeLetter(l); });
  let time = 0, isSet = false;
  const setAt = 0.35 + L.length * 0.04 + 0.7;
  const tick = (dt) => {
    time += dt;
    let busy = !isSet;
    for (const l of L) {
      if (time < l.t0) { busy = true; continue; }
      if (!l.started) { l.started = true; l.el.style.opacity = ""; }
      step(l.y, 0, 150, 6, dt);
      if (l.y.x > 0) { // the floor: turn impact into squash, bounce a little
        if (l.y.v > 60) l.s.v += Math.min(4.2, l.y.v * 0.0021);
        l.y.x = 0; l.y.v *= -0.2;
      }
      step(l.s, 0, 280, 9, dt);
      step(l.c, isSet ? 0 : 1, 55, 10, dt);
      writeLetter(l);
      if (!(near(l.y, 0, 0.08) && near(l.s, 0, 0.002) && near(l.c, isSet ? 0 : 1, 0.003))) busy = true;
    }
    if (!isSet && time > setAt) { isSet = true; h.classList.add("is-set"); busy = true; }
    return busy;
  };
  run(tick);
  // Poke a letter: it jumps, stretches, goes soft for a moment, then sets again. Neighbours ripple.
  L.forEach((l) => l.el.addEventListener("pointerenter", () => {
    if (!isSet) return;
    for (const m of L) {
      const d = Math.abs(m.i - l.i);
      if (d > 2) continue;
      const f = [1, 0.45, 0.18][d];
      m.y.v -= 340 * f; m.s.v -= 2.4 * f; m.c.v += 5 * f;
    }
    run(tick);
  }));
})();

/* ───── The jelly: a WebGL soft body you can poke and drag ───── */
(function jelly() {
  const stage = $(".jelly-stage");
  const canvas = $(".jelly-canvas", stage), img = $(".jelly-img", stage);
  const pokeBtn = $(".poke");
  const noPoke = () => { pokeBtn.hidden = true; stage.closest(".specimen").classList.add("no-poke"); };
  if (reduced) { noPoke(); return; }
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
  if (!gl) { noPoke(); return; }

  const COLS = 22, ROWS = 22, NX = COLS + 1, NY = ROWS + 1, N = NX * NY;
  const rest = new Float32Array(N * 2), uv = new Float32Array(N * 2), pos = new Float32Array(N * 2);
  const dsp = new Float32Array(N * 2), vel = new Float32Array(N * 2), strain = new Float32Array(N);
  const pin = new Float32Array(N), mob = new Float32Array(N);
  for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
    const n = j * NX + i, u = i / COLS, v = j / ROWS;
    rest[n * 2] = uv[n * 2] = u; rest[n * 2 + 1] = uv[n * 2 + 1] = v;
    pin[n] = 1 + 60 * smooth(0.74, 0.93, v);       // the mould sits on the plate
    mob[n] = 1 - smooth(0.7, 0.93, v);             // and the base hardly moves
  }
  const idx = [];
  for (let j = 0; j < ROWS; j++) for (let i = 0; i < COLS; i++) {
    const a = j * NX + i, b = a + 1, c = a + NX, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }

  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `
    attribute vec2 a_p; attribute vec2 a_uv; attribute float a_s;
    varying vec2 v_uv; varying float v_s;
    void main() { v_uv = a_uv; v_s = a_s; vec2 c = ((a_p + 0.1) / 1.2) * 2.0 - 1.0; gl_Position = vec4(c.x, -c.y, 0.0, 1.0); }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `
    precision mediump float; uniform sampler2D u_t; varying vec2 v_uv; varying float v_s;
    void main() { vec4 c = texture2D(u_t, v_uv); c.rgb += c.a * v_s * vec3(0.26, 0.18, 0.05); gl_FragColor = c; }`));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { noPoke(); return; }
  gl.useProgram(prog);
  const buf = (data, usage) => { const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, usage); return b; };
  const bPos = buf(pos, gl.DYNAMIC_DRAW), bUv = buf(uv, gl.STATIC_DRAW), bS = buf(strain, gl.DYNAMIC_DRAW);
  const attr = (name, b, size) => { const l = gl.getAttribLocation(prog, name); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, size, gl.FLOAT, false, 0, 0); };
  attr("a_p", bPos, 2); attr("a_uv", bUv, 2); attr("a_s", bS, 1);
  const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
  gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const tex = gl.createTexture();
  let ready = false, visible = true, time = 0, nextTap = 2.6;
  const resize = () => {
    const dpr = Math.min(2, devicePixelRatio || 1), r = canvas.getBoundingClientRect();
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  new ResizeObserver(resize).observe(canvas);

  // Physics in image-normalised units (1 = image width).
  const KR = 250, KC = 2400, C = 3.0;
  const pointer = { x: 0, y: 0, vx: 0, vy: 0, t: 0, inside: false, down: false, gx: 0, gy: 0, ox: 0, oy: 0 };
  const bell = (t) => { // contract 0.35 s, relax 1.1 s, rest 0.6 s
    const p = t % 2.05;
    return p < 0.35 ? smooth(0, 0.35, p) : p < 1.45 ? 1 - smooth(0.35, 1.45, p) : 0;
  };
  function physics(h) {
    const pulse = 1 - 0.012 * bell(time);
    for (let j = 0; j < NY; j++) for (let i = 0; i < NX; i++) {
      const n = j * NX + i, n2 = n * 2;
      let sx = 0, sy = 0, cnt = 0;
      if (i > 0) { sx += dsp[n2 - 2]; sy += dsp[n2 - 1]; cnt++; }
      if (i < COLS) { sx += dsp[n2 + 2]; sy += dsp[n2 + 3]; cnt++; }
      if (j > 0) { sx += dsp[n2 - NX * 2]; sy += dsp[n2 - NX * 2 + 1]; cnt++; }
      if (j < ROWS) { sx += dsp[n2 + NX * 2]; sy += dsp[n2 + NX * 2 + 1]; cnt++; }
      const k = KR * pin[n];
      let ax = -k * dsp[n2] + KC * (sx - cnt * dsp[n2]) - C * vel[n2];
      let ay = -k * dsp[n2 + 1] + KC * (sy - cnt * dsp[n2 + 1]) - C * vel[n2 + 1];
      if (pointer.down) { // drag: nodes near the grab point follow the pointer
        const dx = rest[n2] - pointer.gx, dy = rest[n2 + 1] - pointer.gy;
        const w = Math.exp(-(dx * dx + dy * dy) / (2 * 0.11 * 0.11)) * mob[n];
        ax += (pointer.ox * w - dsp[n2]) * 900 * w; ay += (pointer.oy * w - dsp[n2 + 1]) * 900 * w;
      }
      vel[n2] += ax * h; vel[n2 + 1] += ay * h;
    }
    for (let n = 0; n < N; n++) {
      const n2 = n * 2;
      dsp[n2] += vel[n2] * h; dsp[n2 + 1] += vel[n2 + 1] * h;
      const cx = 0.5 + (rest[n2] - 0.5) * pulse, cy = 0.58 + (rest[n2 + 1] - 0.58) * (pulse + (1 - pulse) * 0.4);
      pos[n2] = cx + dsp[n2]; pos[n2 + 1] = cy + dsp[n2 + 1];
      strain[n] = Math.min(1, Math.hypot(dsp[n2], dsp[n2 + 1]) / 0.045);
    }
  }
  function impulse(px, py, fx, fy, sigma, toward) {
    for (let n = 0; n < N; n++) {
      const n2 = n * 2, dx = rest[n2] - px, dy = rest[n2 + 1] - py;
      const w = Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma)) * mob[n];
      if (w < 0.01) continue;
      vel[n2] += (fx - dx * toward) * w; vel[n2 + 1] += (fy - dy * toward) * w;
    }
  }
  const poke = (x, y, s = 1) => { impulse(x, y, 0, 0.35 * s, 0.12, 9 * s); };
  const toLocal = (e) => { const r = stage.getBoundingClientRect(); return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]; };
  const onJelly = (x, y) => x > 0.04 && x < 0.96 && y > 0.06 && y < 0.92;

  canvas.addEventListener("pointerdown", (e) => {
    const [x, y] = toLocal(e);
    if (!onJelly(x, y)) return;
    pointer.down = true; pointer.gx = x; pointer.gy = y; pointer.ox = pointer.oy = 0;
    canvas.setPointerCapture(e.pointerId); canvas.classList.add("grabbing");
    poke(x, y, 0.6);
  });
  canvas.addEventListener("pointermove", (e) => {
    const [x, y] = toLocal(e), now = performance.now();
    const dt = Math.max(8, now - pointer.t) / 1000;
    pointer.vx = (x - pointer.x) / dt; pointer.vy = (y - pointer.y) / dt;
    pointer.x = x; pointer.y = y; pointer.t = now;
    if (pointer.down) {
      let ox = x - pointer.gx, oy = y - pointer.gy; const m = Math.hypot(ox, oy), cap = 0.14;
      if (m > cap) { ox *= cap / m; oy *= cap / m; }
      pointer.ox = ox; pointer.oy = oy;
    } else if (onJelly(x, y) && e.pointerType === "mouse") {
      const sp = clamp(Math.hypot(pointer.vx, pointer.vy), 0, 6) / 6;
      impulse(x, y, pointer.vx * 0.05 * sp, pointer.vy * 0.05 * sp, 0.1, 0);
    }
  });
  const release = () => { if (!pointer.down) return; pointer.down = false; canvas.classList.remove("grabbing"); };
  canvas.addEventListener("pointerup", release); canvas.addEventListener("pointercancel", release);
  pokeBtn.addEventListener("click", () => { poke(0.5, 0.3, 1.4); });
  scrollListeners.push(() => { if (visible) impulse(0.5, 0.15, clamp(-scroll.v * 0.00012, -0.35, 0.35), 0, 0.4, 0); });

  const tick = (dt) => {
    if (!ready || !visible || document.hidden) return false;
    time += dt;
    if (time > nextTap && !pointer.down) { poke(0.5, 0.18, 0.55); nextTap = time + 3.2 + Math.random() * 2.4; }
    const n = Math.ceil(dt * 240), h = dt / n;
    for (let k = 0; k < n; k++) physics(h);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindBuffer(gl.ARRAY_BUFFER, bPos); gl.bufferSubData(gl.ARRAY_BUFFER, 0, pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, bS); gl.bufferSubData(gl.ARRAY_BUFFER, 0, strain);
    gl.drawElements(gl.TRIANGLES, idx.length, gl.UNSIGNED_SHORT, 0);
    return true;
  };
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) run(tick); }).observe(stage);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) run(tick); });
  canvas.addEventListener("webglcontextlost", () => { ready = false; stage.classList.remove("jelly-live"); });

  const go = () => {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    resize(); physics(0); ready = true; tick(1 / 60);
    stage.classList.add("jelly-live");
    setTimeout(() => poke(0.5, 0.2, 1.1), 900); // it arrives with a wobble
    run(tick);
  };
  (img.complete && img.naturalWidth ? Promise.resolve() : img.decode()).then(go, noPoke);
})();

/* ───── Method: pinned strip, cards follow on springs (the train jiggles) ───── */
(function method() {
  const sec = $(".method"), track = $(".method-track", sec), steps = [...track.children];
  const bar = $(".method-progress", sec);
  const wide = matchMedia("(min-width: 900px)");
  const S = steps.map((el, i) => ({ el, x: spring(0), k: 230 - i * 24 }));
  let travel = 0, target = 0, pinned = false;
  const layout = () => {
    pinned = !reduced && wide.matches;
    document.documentElement.classList.toggle("pin-ready", pinned);
    if (!pinned) { steps.forEach((s) => (s.style.transform = "")); return; }
    travel = Math.max(0, track.scrollWidth - document.documentElement.clientWidth);
    sec.style.setProperty("--travel", `${travel}px`);
    update(); S.forEach((s) => { s.x.x = target; s.x.v = 0; write(s); });
  };
  const write = (s) => {
    const lag = s.x.x - target;
    s.el.style.transform = `translate3d(${s.x.x.toFixed(1)}px,0,0) skewX(${clamp(lag * 0.018, -5, 5).toFixed(2)}deg)`;
  };
  const update = () => {
    if (!pinned) return;
    const top = sec.getBoundingClientRect().top + scrollY;
    const p = travel ? clamp((scrollY - top) / travel, 0, 1) : 0;
    target = -p * travel;
    bar.style.setProperty("--p", p.toFixed(4));
  };
  const tick = (dt) => {
    if (!pinned) return false;
    let busy = false;
    for (const s of S) { step(s.x, target, s.k, 2 * Math.sqrt(s.k) * 0.5, dt); write(s); if (!near(s.x, target, 0.3)) busy = true; }
    return busy;
  };
  scrollListeners.push(() => { update(); run(tick); });
  addEventListener("resize", layout);
  wide.addEventListener("change", layout);
  document.fonts?.ready.then(layout);
  layout();
})();

/* ───── Videos play only when seen ───── */
(function videos() {
  const io = new IntersectionObserver((ens) => {
    for (const en of ens) {
      const v = en.target;
      if (en.isIntersecting && en.intersectionRatio > 0.35 && !reduced) { v.preload = "auto"; v.play().catch(() => {}); }
      else v.pause();
    }
  }, { threshold: [0, 0.35, 0.7] });
  $$("video").forEach((v) => io.observe(v));
})();

/* ───── Watch: a simulated post-landing watch that sets, slumps, and sets again ───── */
(function watch() {
  const demo = $(".watch-demo"), word = $(".watch-word", demo), log = $(".watch-log", demo);
  const btn = $("#watch-run"), status = $("#watch-status");
  let L = [], mode = "set";
  const setWord = (text, m) => {
    mode = m;
    word.textContent = text;
    const chars = splitChars(word);
    const prev = L;
    L = chars.map((el, i) => ({ el, i, y: spring(m === "set" ? -60 : 0), s: spring(0), c: spring(m === "set" ? 1 : 0), r: spring(0), seed: Math.random() }));
    if (m === "slumped" && prev.length) L.forEach((l) => { l.c.x = 0; });
    L.forEach(writeLetter);
    if (!reduced) run(tick);
  };
  let t = 0;
  const tick = (dt) => {
    t += dt;
    let busy = mode === "watching";
    for (const l of L) {
      let ty = 0, ts = 0, tc = 0, tr = 0;
      if (mode === "watching") { ty = Math.sin(t * 3 + l.i * 0.7) * 3; tc = 1; }
      if (mode === "slumped") { ty = 3 + l.seed * 9; ts = 0.16 + l.seed * 0.12; tc = 1; tr = (l.seed - 0.5) * 12; }
      step(l.y, ty, mode === "slumped" ? 40 : 160, mode === "slumped" ? 7 : 9, dt);
      if (mode === "set" && l.y.x > 0) { if (l.y.v > 40) l.s.v += Math.min(3, l.y.v * 0.004); l.y.x = 0; l.y.v *= -0.2; }
      step(l.s, ts, mode === "slumped" ? 30 : 260, mode === "slumped" ? 6 : 9, dt);
      step(l.c, tc, 50, 10, dt);
      step(l.r, tr, 30, 6, dt);
      writeLetter(l);
      if (!(near(l.y, ty, 0.1) && near(l.s, ts, 0.002) && near(l.c, tc, 0.003) && near(l.r, tr, 0.05))) busy = true;
    }
    return busy;
  };
  const add = (text, cls = "") => {
    const li = document.createElement("li");
    li.textContent = text; if (cls) li.className = cls;
    log.append(li);
    while (log.children.length > 6) log.firstElementChild.remove();
  };
  setWord("Set.", "set"); L.forEach((l) => { l.y.x = 0; l.c.x = 0; writeLetter(l); });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    log.innerHTML = "";
    demo.dataset.state = "watching"; setWord("Watching", "watching"); status.textContent = "Watching the landed change.";
    add("T-0193 · rev 1 · landed as trail_ref · watch 2h");
    await wait(1200); add("fingerprint 7f3a·cart recurred · 1", "bad");
    await wait(700); add("fingerprint 7f3a·cart recurred · 3 in 6 min", "bad");
    await wait(700); add("errors on /cart · 2.1× baseline", "bad");
    await wait(800);
    demo.dataset.state = "slumped"; setWord("Slumped.", "slumped");
    add("rollback · reverted through trail_ref", "bad"); status.textContent = "Slumped. The change reverted itself.";
    await wait(1700); add("trail reopened at rev 2 · researching, with the watch data");
    await wait(1300); add("rev 2 · repro fails at base, passes on the patch");
    await wait(1100); add("rev 2 · proof passed · landed · watching");
    await wait(1200);
    demo.dataset.state = "set"; setWord("Set.", "set");
    add("window survived · trail closed · repro kept as a regression probe", "good"); status.textContent = "Set. The fix held.";
    btn.disabled = false; btn.textContent = "Land another bad patch";
  });
})();

/* ───── Autonomy rings: the core barely moves, the edges wobble ───── */
(function rings() {
  const svg = $(".rings");
  const paths = [0, 1, 2].map((i) => $(`.ring[data-ring="${i}"]`, svg));
  const tabs = $$(".ring-tabs [role=tab]"), panel = $("#policy");
  const R = [118, 200, 280], idle = [1.2, 4.5, 8.5];
  const bump = R.map(() => ({ a: spring(0), ang: 0 }));
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const hl = (s) => esc(s).replace(/^(\w[\w ]*?):/gm, '<span class="k">$1:</span>').replace(/(#.*)$/gm, '<span class="c">$1</span>');
  const policies = [
`## area: payments
paths: src/payments/**, src/checkout/**
risk: critical
user_facing: true
Nothing lands here without a named human approving C. Patches must come with a traffic-replay proof. Never touch schemas. Copy or flow changes need a real-respondent voxq test before C; persona runs alone never count.`,
`## area: cart
paths: src/cart/**
risk: medium
Agents may reproduce and patch. B is advisory; C is blocking unless the change is under 40 lines, touches no exported types, and the regression probes pass. Then auto-land as trail_ref + devenv_live and watch for 2h.`,
`## area: marketing-site
paths: apps/site/**
risk: low
voxq_budget_usd: 60/month   # signed by a named human
Loose edge. Auto-land to main with a 1h watch. Roll back on any new error fingerprint. Copy changes carry a persona study; ask real people only about the signup path.`];
  let active = 0;
  const select = (i, focus) => {
    active = i;
    tabs.forEach((t, k) => { t.setAttribute("aria-selected", String(k === i)); t.tabIndex = k === i ? 0 : -1; });
    panel.setAttribute("aria-labelledby", tabs[i].id);
    panel.innerHTML = hl(policies[i]);
    paths.forEach((p, k) => p.classList.toggle("active", k === i));
    bump[i].a.v += 90; bump[i].ang = -Math.PI / 2;
    if (focus) tabs[i].focus();
    run(tick);
  };
  tabs.forEach((t, k) => {
    t.addEventListener("click", () => select(k));
    t.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); select((k + (e.key === "ArrowRight" ? 1 : 2)) % 3, true); }
    });
  });
  paths.forEach((p, k) => p.addEventListener("click", () => select(k)));

  const shape = (k, t) => {
    const pts = [], n = 120, b = bump[k];
    for (let i = 0; i < n; i++) {
      const th = (i / n) * Math.PI * 2;
      let d = th - b.ang; d = Math.atan2(Math.sin(d), Math.cos(d));
      const r = R[k]
        + idle[k] * (Math.sin(3 * th + t * (0.9 + k * 0.2) + k) * 0.6 + Math.sin(5 * th - t * 1.3) * 0.4)
        + b.a.x * Math.exp(-(d * d) / (2 * 0.32 * 0.32)) * (k === 0 ? 0.25 : 1);
      pts.push(`${(300 + r * Math.cos(th)).toFixed(1)},${(300 + r * Math.sin(th)).toFixed(1)}`);
    }
    return `M${pts.join("L")}Z`;
  };
  let visible = false, t = 0;
  const tick = (dt) => {
    if (!visible || reduced) return false;
    t += dt;
    bump.forEach((b) => { step(b.a, 0, 70, 3.6, dt); b.a.x = clamp(b.a.x, -20, 20); });
    paths.forEach((p, k) => p.setAttribute("d", shape(k, t)));
    return true;
  };
  let lastAng = 0, lastT = 0;
  svg.addEventListener("pointermove", (e) => {
    const r = svg.getBoundingClientRect(), sc = 600 / r.width;
    const x = (e.clientX - r.left) * sc - 300, y = (e.clientY - r.top) * sc - 300;
    const dist = Math.hypot(x, y), ang = Math.atan2(y, x), now = performance.now();
    const spd = Math.abs(Math.atan2(Math.sin(ang - lastAng), Math.cos(ang - lastAng))) / Math.max(0.008, (now - lastT) / 1000);
    lastAng = ang; lastT = now;
    R.forEach((rad, k) => {
      if (Math.abs(dist - rad) < 46) { bump[k].ang = ang; bump[k].a.v = clamp(bump[k].a.v + clamp(spd, 0, 10) * (k === 0 ? 1 : 2.4), -160, 160); }
    });
  });
  paths.forEach((p, k) => p.setAttribute("d", shape(k, 0)));
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) run(tick); }).observe(svg);
  select(0);
})();

/* ───── Forge names: soft until you pick one, then it sets ───── */
(function forge() {
  $$(".forge-list .wobble").forEach((el) => {
    const s = spring(0), c = spring(1);
    let hot = false;
    const tick = (dt) => {
      step(s, 0, 260, 8, dt); step(c, hot ? 0 : 1, 70, 11, dt);
      el.style.transform = `scale(${(1 + s.x).toFixed(4)},${(1 / (1 + s.x)).toFixed(4)})`;
      el.style.setProperty("--casl", clamp(c.x, 0, 1).toFixed(3));
      return !(near(s, 0, 0.002) && near(c, hot ? 0 : 1, 0.003));
    };
    if (reduced) return;
    el.parentElement.addEventListener("pointerenter", () => { hot = true; s.v += 2.6; run(tick); });
    el.parentElement.addEventListener("pointerleave", () => { hot = false; s.v -= 1.2; run(tick); });
  });
})();

/* ───── Jellyware: words go soft where your attention is ───── */
(function manifesto() {
  const p = $(".manifesto");
  const words = [];
  const walk = (node) => {
    for (const ch of [...node.childNodes]) {
      if (ch.nodeType === 3) {
        const frag = document.createDocumentFragment();
        for (const part of ch.textContent.split(/(\s+)/)) {
          if (!part) continue;
          if (/^\s+$/.test(part)) { frag.append(" "); continue; }
          const w = document.createElement("span"); w.className = "w"; w.textContent = part; frag.append(w); words.push(w);
        }
        ch.replaceWith(frag);
      } else walk(ch);
    }
  };
  walk(p);
  if (reduced) return;
  const W = words.map((el) => ({ el, c: spring(0), s: spring(0) }));
  const at = { x: -9999, y: -9999 };
  let visible = false;
  const tick = (dt) => {
    if (!visible) return false;
    if (hoverless) { at.x = innerWidth * 0.5; at.y = innerHeight * 0.55; }
    let busy = false;
    for (const w of W) {
      const r = w.el.getBoundingClientRect();
      const d = Math.hypot(r.left + r.width / 2 - at.x, r.top + r.height / 2 - at.y);
      const target = Math.pow(clamp(1 - d / (hoverless ? 260 : 210), 0, 1), 1.6);
      step(w.c, target, 90, 13, dt); step(w.s, -11 * target, 90, 13, dt);
      w.el.style.setProperty("--casl", clamp(w.c.x, 0, 1).toFixed(3));
      w.el.style.setProperty("--slnt", clamp(w.s.x, -15, 0).toFixed(2));
      if (!(near(w.c, target, 0.003))) busy = true;
    }
    return busy || hoverless;
  };
  addEventListener("pointermove", (e) => { at.x = e.clientX; at.y = e.clientY; if (visible) run(tick); }, { passive: true });
  scrollListeners.push(() => { if (visible) run(tick); });
  new IntersectionObserver(([en]) => { visible = en.isIntersecting; if (visible) run(tick); }).observe(p);
})();
