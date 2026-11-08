// Ephyra · cut E "Immortal"
// Turritopsis dohrnii, the immortal jellyfish, doesn't die when it's hurt. It curls into a cyst, sinks, re-roots on the
// seabed as a polyp and buds a new jellyfish. That is the fix loop, so the page draws it. Up is production, down is git.
// The creatures are generated photographs (prompts and raw outputs in site/_sources/cut-e); the motion is code.
// The story is a pure function of the scroll position p, so scrolling back rewinds. Swimming, tentacles and impacts
// run on the clock.

(() => {
  const root = document.documentElement;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const darkMQ = matchMedia("(prefers-color-scheme: dark)");
  const stackMQ = matchMedia("(max-width: 47.5rem), (max-aspect-ratio: 5/6)");
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const reel = $(".reel"), stage = $(".stage"), bar = $(".bar");
  const copy = $(".copy"), stanza = $(".stanza"), cta = $(".cta"), cue = $(".cue");
  const canvas = $(".scene"), box = $(".scene-box");
  const tagProd = $(".tag-prod"), tagGit = $(".tag-git"), plate = $(".plate"), eventEl = $(".event");
  const lines = $$(".ln"), snaps = $$(".snaps i");
  const ctx0 = canvas.getContext && canvas.getContext("2d");
  if (!ctx0) { root.classList.remove("js", "motion"); return; }
  let ctx = ctx0;                                          // swapped to the background layer while that's painted
  const bg = document.createElement("canvas"), bgx = bg.getContext("2d");
  let bgKey = "";
  const N = lines.length;

  // ── Math ──
  const TAU = Math.PI * 2;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };
  const bump = (v, a, b, c, d) => smooth(a, b, v) * (1 - smooth(c, d, v));
  const hash = (i) => { const x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const pop = (k) => (k <= 0 ? 0 : k >= 1 ? 1 : k + 0.35 * Math.sin(Math.PI * k));   // overshoot, then settle
  const rotv = (x, y, r) => { const c = Math.cos(r), s = Math.sin(r); return { x: x * c - y * s, y: x * s + y * c }; };
  const motion = () => root.classList.contains("motion");

  // ── Timeline: p is the focus stop (0 … 6). Each step plays while you scroll from one line to the next. ──
  const T = {
    ping: [0.08, 0.35, 0.95, 1.2],    // it hunts: sonar (a bump, four numbers)
    sparkOn: [0.28, 0.42],            // one request in the traffic turns into a bug
    sparkFly: [0.45, 0.95],           // and hits the jellyfish
    hurt: [0.9, 1.04],
    curl: [1.06, 1.4],                // it curls into a cyst …
    sink: [1.34, 1.8],                // … and sinks along the trail, picking up evidence
    land: [1.76, 1.82],               // the cyst lands on git: the bug, reproduced
    branch: [1.8, 1.98],              // a runner grows from it (a branch) …
    polyp: [1.84, 2.02],              // … and a polyp rises on it: the patch
    bud: [2.04, 2.4],
    ring: [2.26, 2.48],               // proof runs around the bud
    ticks: [2.46, 2.7],
    pass: [2.68, 2.8],                // the repro now passes
    keyIn: [2.72, 2.84],              // C waits on you: the stop at "You approve what matters" holds here
    keyPress: [3.08, 3.16],           // scrolling on is the approval: a person presses a
    approved: [3.14, 3.24],
    proofOut: [3.3, 3.5],
    merge: [3.34, 3.62],              // the branch merges: it lands
    mergeNode: [3.6, 3.72],
    release: [3.72, 3.92],            // the bud lets go …
    unfurl: [3.8, 4.15],
    rise: [3.92, 4.55],               // … swims up to production …
    grow: [4.0, 4.68],
    set: [4.52, 4.74],                // … and sets
    ghostIn: [4.44, 4.58],            // a bad fix shows up …
    ghostCurl: [4.56, 4.72],
    ghostSink: [4.68, 4.9],           // … curls up and sinks back …
    ghostLand: [4.88, 4.92],
    revertNode: [4.89, 4.99],         // … onto a revert commit
    fadeUndo: [5.1, 5.45],
    loop: [5.12, 5.7],                // the cycle closes
    warm: [5.3, 6.0],
  };
  const w = (k, p) => smooth(T[k][0], T[k][1], p);

  // Impacts fire when the focus crosses a point going forward, then ring out on the clock.
  const EV = { hit: 0.95, land: 1.79, release: 3.76, set: 4.62, revert: 4.9 };
  const evAt = {};
  let prevP = 0;
  function fire(p, t) {
    for (const k in EV) if (prevP < EV[k] && p >= EV[k]) evAt[k] = t;
    prevP = p;
  }
  const since = (k, t) => (evAt[k] == null || prevP < EV[k] - 0.02 ? 1e9 : t - evAt[k]);   // only while still past it
  const ringOut = (s, f, d) => (s < 0 || s > 3 ? 0 : Math.exp(-d * s) * Math.sin(TAU * f * s));

  // ── Palette. Color is state: mint is a signal, amber is work that holds, cherry is an undo. ──
  const PAL = {
    dark: {
      ink: [0.95, 0.015, 85], jelly: [0.76, 0.16, 68], rim: [0.87, 0.12, 78],
      mint: [0.86, 0.13, 178], cherry: [0.72, 0.17, 24], bg: [0.2, 0.03, 242], ray: [0.86, 0.07, 205],
      rayA: 0.16, glowA: 0.13, washA: 0.11, snowA: 0.2, bokeh: "ink", bokehA: 0.05, glowOp: "lighter", glowK: 0.42,
    },
    light: {
      ink: [0.24, 0.03, 60], jelly: [0.76, 0.16, 70], rim: [0.55, 0.14, 55],
      mint: [0.58, 0.12, 180], cherry: [0.56, 0.19, 24], bg: [0.975, 0.012, 85], ray: [1, 0, 0],
      rayA: 0.7, glowA: 0.5, washA: 0.13, snowA: 0.16, bokeh: "ray", bokehA: 0.5, glowOp: "source-over", glowK: 0.32,
    },
  };
  let pal = PAL.dark;
  const col = (k, a = 1) => { const c = pal[k]; return `oklch(${c[0]} ${c[1]} ${c[2]} / ${clamp(a, 0, 1).toFixed(3)})`; };
  const mixc = (k1, k2, t, a = 1) => {
    const c1 = pal[k1], c2 = pal[k2];
    return `oklch(${lerp(c1[0], c2[0], t).toFixed(3)} ${lerp(c1[1], c2[1], t).toFixed(3)} ${lerp(c1[2], c2[2], t).toFixed(1)} / ${clamp(a, 0, 1).toFixed(3)})`;
  };
  const isDark = () => root.dataset.theme === "dark" || (root.dataset.theme !== "light" && darkMQ.matches);

  // ── Sprites. Anchors are fractions of each trimmed image, measured by _sources/cut-e/sprites.py. ──
  const SPR = {
    medusa: { src: "img/medusa.webp", ar: 0.8767, cx: 0.4999, rimY: 0.8798, apexY: 0.0115, coreY: 0.4608, rootY: 0.94 },
    cyst: { src: "img/cyst.webp", ar: 0.8281, cx: 0.4991, baseY: 0.9852, core: [0.5361, 0.6165] },
    polyp: { src: "img/polyp.webp", ar: 1.4588, stalkX: 0.5, baseY: 0.968, budY: 0.62 },
  };
  const M = SPR.medusa, C = SPR.cyst, PY = SPR.polyp;
  const IMG = {};
  let ready = false, readyAt = 0;
  const fadeIn = () => (motion() ? clamp((performance.now() / 1000 - readyAt) / 0.45, 0, 1) : 1);   // no pop when they arrive
  function tint(im, color) {                               // keep the photo's light, swap its hue
    const c = document.createElement("canvas");
    c.width = im.naturalWidth; c.height = im.naturalHeight;
    const x = c.getContext("2d");
    x.drawImage(im, 0, 0);
    x.globalCompositeOperation = "color"; x.fillStyle = color; x.fillRect(0, 0, c.width, c.height);
    x.globalCompositeOperation = "destination-in"; x.drawImage(im, 0, 0);
    return c;
  }
  const spritesLoaded = Promise.all(Object.entries(SPR).map(([k, s]) => new Promise((res) => {
    const im = new Image();
    im.decoding = "async";
    im.onload = () => { IMG[k] = im; res(true); };
    im.onerror = () => res(false);
    im.src = s.src;
  }))).then((ok) => {
    if (!ok.every(Boolean)) return false;
    IMG.medusaRed = tint(IMG.medusa, "#e2483c");
    IMG.cystRed = tint(IMG.cyst, "#e2483c");
    ready = true; readyAt = performance.now() / 1000;
    return true;
  });

  // ── Style writes are cached so a frame only touches what changed ──
  const written = new Map();
  function put(el, prop, value) {
    let c = written.get(el);
    if (!c) written.set(el, (c = {}));
    if (c[prop] === value) return;
    c[prop] = value;
    el.style.setProperty(prop, value);
  }
  function clearCopyStyles() {
    for (const el of [...lines, stanza, cta, cue, copy, plate]) {
      const c = written.get(el);
      if (!c) continue;
      for (const prop of Object.keys(c)) el.style.removeProperty(prop);
      written.delete(el);
    }
    lines.forEach((el) => el.classList.remove("is-focus"));
  }

  // ── Paths ──
  const cubic = (a, b, c, d) => (t) => {
    const m = 1 - t;
    return { x: m * m * m * a.x + 3 * m * m * t * b.x + 3 * m * t * t * c.x + t * t * t * d.x,
             y: m * m * m * a.y + 3 * m * m * t * b.y + 3 * m * t * t * c.y + t * t * t * d.y };
  };
  const quad = (a, b, c) => (t) => {
    const m = 1 - t;
    return { x: m * m * a.x + 2 * m * t * b.x + t * t * c.x, y: m * m * a.y + 2 * m * t * b.y + t * t * c.y };
  };
  const sample = (fn, n = 32) => Array.from({ length: n + 1 }, (_, i) => fn(i / n));
  function resample(pts, n = 48) {                         // even spacing, so a path grows at a steady speed
    const L = [0];
    for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
    const total = L[L.length - 1] || 1, out = [];
    for (let k = 0, j = 0; k <= n; k++) {
      const d = (k / n) * total;
      while (j < L.length - 2 && L[j + 1] < d) j++;
      const f = (d - L[j]) / (L[j + 1] - L[j] || 1);
      out.push({ x: lerp(pts[j].x, pts[j + 1].x, f), y: lerp(pts[j].y, pts[j + 1].y, f) });
    }
    return out;
  }
  function at(pts, t) {
    const f = clamp(t, 0, 1) * (pts.length - 1), i = Math.min(pts.length - 2, Math.floor(f)), k = f - i;
    return { x: lerp(pts[i].x, pts[i + 1].x, k), y: lerp(pts[i].y, pts[i + 1].y, k) };
  }
  function tracePart(pts, t1, t0 = 0) {
    if (t1 - t0 <= 0.001) return false;
    const n = pts.length - 1, s = at(pts, t0), e = at(pts, t1);
    ctx.moveTo(s.x, s.y);
    for (let i = Math.floor(t0 * n) + 1; i < t1 * n; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.lineTo(e.x, e.y);
    return true;
  }

  // ── Geometry, measured on layout changes ──
  let W = 1, H = 1, dpr = 1, stacked = false, sb = { x: 0, y: 0, w: 1, h: 1 };
  let yProd = 0, yGit = 0, D = 1, u = 1, BW = 1, BH = 1, CW = 1, PH = 1, TL = 1;
  const G = {};
  let reelTop = 0, step = 1, availH = 0, overflow = 0, centers = [], ends = [], stanzaX = 0, stanzaY = 0, glideY = 0;
  const place = (el, x, y) => { el.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`; };
  const coreToRim = (s, c = 0) => (M.rimY - M.coreY) * BH * s * (1 + 0.08 * c);   // stomach to rim, along the bell's axis
  const cystCore = (cw) => ({ x: (C.core[0] - C.cx) * cw, y: (C.baseY - C.core[1]) * cw * C.ar });   // stomach to base

  function measure() {
    eventText = ""; // Fonts and viewport changes can resize a caption.
    stacked = stackMQ.matches;
    W = stage.clientWidth;
    H = stage.clientHeight;
    dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1, Math.sqrt(3.2e6 / (W * H))));   // ≤ 3.2 MP of canvas
    const cw = Math.max(1, Math.round(W * dpr)), ch = Math.max(1, Math.round(H * dpr));
    if (canvas.width !== cw) canvas.width = cw;
    if (canvas.height !== ch) canvas.height = ch;

    sb = { x: box.offsetLeft, y: box.offsetTop, w: box.offsetWidth, h: box.offsetHeight };
    const headH = bar.offsetHeight;
    if (stacked) { yProd = sb.y + clamp(sb.h * 0.09, 20, 44); yGit = sb.y + sb.h - clamp(sb.h * 0.07, 16, 34); }
    else { yProd = headH + (sb.y - headH) * 0.5; yGit = sb.y + sb.h + (H - sb.y - sb.h) * 0.42; }
    D = yGit - yProd;
    // A phone's drawing is short, so creatures are sized by its width as well as its height: the working cluster
    // on the seabed (cyst, polyp, bud, proof, the approve key) stays big enough to read.
    u = stacked ? Math.max(14, Math.min(sb.w / 8, D / 7)) : Math.max(14, Math.min(sb.w, D) / 10);
    BW = 1.75 * u; BH = BW * M.ar; CW = 0.95 * u; PH = 2.3 * u; TL = 1.9 * u;

    const X = (f) => sb.x + f * sb.w, Y = (f) => yProd + f * D;
    G.a = { x: X(0.3), y: Y(0.2) };                        // stomachs: the jellyfish in production …
    G.b = { x: X(0.72), y: Y(0.2) };                       // … the one that rises after the fix …
    G.g = { x: X(0.92), y: Y(0.3) };                       // … and a bad fix
    G.xc = X(0.2); G.xp = X(0.42); G.xm = X(0.6); G.xr = X(0.91);
    G.yBr = yGit - 0.62 * u;
    const cc = cystCore(CW), ccr = cystCore(CW * 0.85);
    G.cystRest = { x: G.xc + cc.x, y: yGit - cc.y };
    G.attach = { x: G.xp + 0.012 * PH / PY.ar, y: G.yBr - (PY.baseY - PY.budY) * PH };
    G.budRel = { x: G.attach.x + 0.55 * u, y: G.attach.y - 0.07 * u };
    G.down = resample(sample(cubic(G.a, { x: G.a.x, y: G.a.y + 0.45 * D }, { x: G.cystRest.x, y: yGit - 0.45 * D }, G.cystRest)));
    G.branch = resample(sample(quad({ x: G.xc, y: yGit }, { x: G.xc, y: G.yBr }, { x: G.xc + 0.6 * u, y: G.yBr }), 12)
      .concat([{ x: G.xp + 0.85 * u, y: G.yBr }]), 40);
    G.brLen = G.xp + 0.85 * u - G.xc;
    G.mergeP = resample(sample(quad({ x: G.xp + 0.85 * u, y: G.yBr }, { x: G.xm, y: G.yBr }, { x: G.xm, y: yGit }), 16), 24);
    G.up = resample(sample(cubic(G.budRel, { x: G.budRel.x + 0.05 * sb.w, y: G.budRel.y - 0.35 * D }, { x: G.b.x - 0.03 * sb.w, y: G.b.y + 0.4 * D }, G.b)));
    G.gRest = { x: G.xr + ccr.x, y: yGit - ccr.y };
    G.gpath = resample(sample(cubic(G.g, { x: G.g.x, y: G.g.y + 0.4 * D }, { x: G.gRest.x, y: yGit - 0.3 * D }, G.gRest)));
    const top = Y(0.2) - (M.coreY - M.apexY) * BH;
    G.loop = resample(sample(quad({ x: G.b.x - 0.62 * BW, y: top - 0.25 * u }, { x: (G.a.x + G.b.x) / 2, y: Math.max(yProd + 8, top - 2.4 * u) },
      { x: G.a.x + 0.62 * BW, y: top - 0.25 * u })), 40);
    G.motes = [0, 1, 2, 3, 4].map((i) => {                 // evidence waiting in the water beside the trail
      const q = 0.16 + 0.17 * i, p0 = at(G.down, q), p1 = at(G.down, Math.min(1, q + 0.02));
      const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1, side = i % 2 ? 1 : -1;
      return { q, x: p0.x + (-(p1.y - p0.y) / len) * side * 0.8 * u, y: p0.y + ((p1.x - p0.x) / len) * side * 0.8 * u };
    });
    G.snow = Array.from({ length: Math.round(clamp(W * H / 26000, 18, 60)) }, (_, i) => ({
      x: hash(i + 1), y: hash(i + 101), r: 0.6 + hash(i + 201) * 1.1, v: 4 + hash(i + 301) * 8, ph: hash(i + 401) * TAU,
    }));
    G.bokeh = Array.from({ length: 6 }, (_, i) => ({
      x: hash(i + 501), y: hash(i + 601), r: (0.35 + 0.5 * hash(i + 701)) * u, v: 2 + 3 * hash(i + 801), ph: hash(i + 901) * TAU,
    }));
    for (const k in SK) SK[k].live = false;

    // Labels for the two lines, the specimen plate and the scroll cue.
    const right = W - (parseFloat(getComputedStyle(stage).paddingRight) || 16);
    place(tagProd, right - tagProd.offsetWidth, yProd + 9);
    place(tagGit, right - tagGit.offsetWidth, yGit - 19);
    if (stacked) place(plate, right - plate.offsetWidth, yGit + 8);
    else place(plate, sb.x, yProd + 18);
    plate.style.visibility = !stacked && D < 420 ? "hidden" : "";
    cue.style.left = `${(W / 2 - 11).toFixed(1)}px`;     // left/top, because the bob animation owns transform
    cue.style.top = `${(stacked ? H - 30 : yGit - 42).toFixed(1)}px`;

    // The stanza, for focus, gliding and leaders.
    reelTop = reel.getBoundingClientRect().top + scrollY;
    step = (snaps[1] && snaps[1].offsetTop - snaps[0].offsetTop) || innerHeight * 0.8;
    copy.classList.remove("overflows");
    availH = copy.clientHeight;
    const over = motion() && stanza.offsetHeight > availH + 1;
    copy.classList.toggle("overflows", over);
    overflow = over ? stanza.offsetHeight - availH : 0;
    centers = lines.map((el) => el.offsetTop + el.offsetHeight / 2);
    centers.push(cta.offsetTop + cta.offsetHeight / 2);
    // Rects, not offsetTop: a blurred line becomes its phrases' offsetParent in Chromium.
    const stR = stage.getBoundingClientRect(), szR = stanza.getBoundingClientRect();
    stanzaX = szR.left - stR.left;
    stanzaY = szR.top - stR.top - glideY;                  // minus the glide that's applied right now
    ends = lines.map((el) => {
      const ph = el.querySelectorAll(".ph"), r = (ph[ph.length - 1] || el).getBoundingClientRect();
      return { x: r.right - stR.left, y: r.top + r.height / 2 - szR.top };
    });
  }

  // ── Drawing primitives ──
  function disc(x, y, r, fill) { ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = fill; ctx.fill(); }
  function ring(x, y, r, stroke, lw = 1.3, fill) {
    ctx.beginPath(); ctx.arc(x, y, r, 0, TAU);
    if (fill) { ctx.fillStyle = fill; ctx.fill(); }
    ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke();
  }
  function check(x, y, s, stroke, lw = 2) {
    ctx.beginPath(); ctx.moveTo(x - 4 * s, y); ctx.lineTo(x - 1.2 * s, y + 3 * s); ctx.lineTo(x + 4.6 * s, y - 3.6 * s);
    ctx.lineWidth = lw; ctx.strokeStyle = stroke; ctx.stroke();
  }
  function rrect(x, y, w, h, r) {
    ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function wash(x, y, key, a) {
    if (a <= 0.003) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, Math.max(W, H) * 0.85);
    g.addColorStop(0, col(key, a)); g.addColorStop(1, col(key, 0));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }
  function halo(x, y, r, key, a) {
    if (a <= 0.003) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, col(key, a)); g.addColorStop(1, col(key, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
  }
  function spark(x, y, k, a, pulse = 0) {                  // the bug: mint while it fails, amber once its repro passes
    if (a <= 0.01) return;
    const r = (0.2 + 0.05 * pulse) * u + 4;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, mixc("mint", "jelly", k, 0.95 * a)); g.addColorStop(0.3, mixc("mint", "jelly", k, 0.4 * a)); g.addColorStop(1, mixc("mint", "jelly", k, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
    disc(x, y, 2.3, mixc("mint", "rim", k, a));
  }
  function puff(x, y, s, key, n, reach) {                  // sediment kicked up where something lands
    if (s < 0 || s > 1.5) return;
    const k = 1 - Math.exp(-s * 3.2), fade = 1 - s / 1.5;
    for (let i = 0; i < n; i++) {
      const dir = i % 2 ? 1 : -1, d = (0.35 + 0.65 * hash(i + 17)) * reach;
      const hgt = (0.2 + 0.6 * hash(i + 29)) * 0.45 * u;
      disc(x + dir * d * k, y - hgt * Math.sin(Math.PI * Math.min(1, s / 1.3)), 0.9 + 1.3 * hash(i + 41), col(key, 0.7 * fade));
    }
  }

  // ── One swim stroke: a quick squeeze, then a slower release that overshoots a little. c is about −0.07 … 1. ──
  function stroke(ph) {
    ph = ((ph % 1) + 1) % 1;
    if (ph < 0.3) return smooth(0, 0.3, ph);
    const r = (ph - 0.3) / 0.7;
    return 1 - 1.07 * smooth(0, 0.62, r) + 0.07 * smooth(0.62, 1, r);
  }
  // The lift from that stroke: it rises while squeezing, coasts, then sinks back slowly.
  function lift(ph) {
    ph = ((ph % 1) + 1) % 1;
    return ph < 0.45 ? smooth(0.04, 0.45, ph) : 1 - smooth(0.45, 1, ph);
  }

  // ── Tentacles: chains hung from the rim, so they trail when the bell jets and billow when it relaxes ──
  function skirt(n, segs, seed) {
    const S = segs + 1;
    return { n, S, P: new Float32Array(n * S * 2), Q: new Float32Array(n * S * 2), R: new Float32Array(n * 2), r0x: 0, r0y: 0,
             f: Float32Array.from({ length: n }, (_, i) => 0.6 + 0.4 * hash(i * 3.7 + seed)), live: false, acc: 0, kick: 0 };
  }
  const SK = { a: skirt(24, 10, 1), b: skirt(22, 10, 2), g: skirt(16, 9, 3) };

  function simulate(sk, len, dt, t) {
    const { n, S, P, Q, R, f } = sk, segs = S - 1;
    if (sk.live && Math.hypot(R[0] - sk.r0x, R[1] - sk.r0y) > 1.6 * u) sk.live = false;   // it jumped: don't whip
    sk.r0x = R[0]; sk.r0y = R[1];
    if (!sk.live) {                                        // lay them out hanging, with a little curl
      for (let i = 0; i < n; i++) {
        const sl = (len * f[i]) / segs;
        for (let j = 0; j < S; j++) {
          const k = (i * S + j) * 2, q = j / segs;
          P[k] = Q[k] = R[i * 2] + Math.sin(q * 2.2 + i * 1.7) * 0.05 * u * q;
          P[k + 1] = Q[k + 1] = R[i * 2 + 1] + j * sl * 0.98;
        }
      }
      sk.live = true; sk.acc = 0;
      return;
    }
    sk.acc = Math.min(sk.acc + dt, 0.1);
    // Gravity strong enough to hang them within a second, drag, and a gentle pull toward hanging straight down from
    // the root: water lines tentacles up with gravity, and it stops a growing tentacle from setting off sideways.
    // Water is thick: strong drag, and no piece of a tentacle outruns vmax, so a sudden stop gives a short
    // follow-through instead of a whip over the bell.
    const h = 1 / 60, g = 10 * u * h * h, damp = 0.88, pull = 0.008, vmax = 0.05 * u;
    while (sk.acc >= h) {
      sk.acc -= h;
      for (let i = 0; i < n; i++) {
        const b = i * S * 2, sl = (len * f[i]) / segs, rx = R[i * 2], ry = R[i * 2 + 1];
        P[b] = Q[b] = rx; P[b + 1] = Q[b + 1] = ry;
        for (let j = 1; j < S; j++) {
          const k = b + j * 2, q = j / segs;
          let vx = (P[k] - Q[k]) * damp, vy = (P[k + 1] - Q[k + 1]) * damp;
          const sp = Math.hypot(vx, vy);
          if (sp > vmax) { vx *= vmax / sp; vy *= vmax / sp; }
          Q[k] = P[k]; Q[k + 1] = P[k + 1];
          const sway = Math.sin(t * 1.6 + i * 1.31 - q * 2.8) * 0.35 * g * q;   // a slow wave down each one
          const hx = rx + Math.sin(q * 2.2 + i * 1.7) * 0.05 * u * q, hy = ry + j * sl, kq = pull * (0.5 + 0.5 * q);
          P[k] += vx + sway + sk.kick * q * q + (hx - P[k]) * kq;
          P[k + 1] += vy + g + (hy - P[k + 1]) * kq * 0.5;
        }
        for (let it = 0; it < 3; it++) {
          for (let j = 1; j < S; j++) {
            const a = b + (j - 1) * 2, c = b + j * 2;
            const dx = P[c] - P[a], dy = P[c + 1] - P[a + 1], d = Math.hypot(dx, dy) || 1e-6, e = (d - sl) / d;
            if (j === 1) { P[c] -= dx * e; P[c + 1] -= dy * e; }
            else { P[a] += dx * e * 0.5; P[a + 1] += dy * e * 0.5; P[c] -= dx * e * 0.5; P[c + 1] -= dy * e * 0.5; }
          }
        }
        for (let j = 1; j < S - 1; j++) {                  // a little stiffness, so they curve instead of kinking
          const a = b + (j - 1) * 2, c = b + j * 2, d = b + (j + 1) * 2;
          P[c] += (P[a] + P[d] - 2 * P[c]) * 0.06; P[c + 1] += (P[a + 1] + P[d + 1] - 2 * P[c + 1]) * 0.06;
        }
      }
      sk.kick = 0;
    }
  }
  function drawSkirt(sk, key, a, y0, len) {
    if (a <= 0.01 || !sk.live || len < 2) return;
    const { n, S, P } = sk;
    const g = ctx.createLinearGradient(0, y0, 0, y0 + len);
    g.addColorStop(0, col(key, 0.75 * a)); g.addColorStop(0.55, col(key, 0.35 * a)); g.addColorStop(1, col(key, 0));
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const b = i * S * 2;
      ctx.moveTo(P[b], P[b + 1]);
      for (let j = 1; j < S - 1; j++) {
        const k = b + j * 2;
        ctx.quadraticCurveTo(P[k], P[k + 1], (P[k] + P[k + 2]) / 2, (P[k + 1] + P[k + 3]) / 2);
      }
      const e = b + (S - 1) * 2;
      ctx.lineTo(P[e], P[e + 1]);
    }
    ctx.lineWidth = 1; ctx.strokeStyle = g; ctx.stroke();
  }

  // ── The bell, warped from the photograph in horizontal bands so the rim squeezes harder than the dome.
  // Bands are built offscreen on whole device-pixel rows, so they meet exactly: no overlap, no seams. ──
  const NS = 24, warpC = document.createElement("canvas"), warpX = warpC.getContext("2d");
  let warpW = 0, warpH = 0, warpRim = 0;
  function warpBell(im, bw, c, amp) {
    const bh = bw * M.ar, sy = 1 + 0.08 * c, sw = im.naturalWidth || im.width, sh = im.naturalHeight || im.height;
    warpW = Math.ceil(bw * dpr) + 4; warpH = Math.ceil(bh * sy * dpr) + 4;
    if (warpC.width < warpW) warpC.width = warpW;          // grow only, so it isn't reallocated every frame
    if (warpC.height < warpH) warpC.height = warpH;
    warpX.setTransform(1, 0, 0, 1, 0, 0);
    warpX.clearRect(0, 0, warpW, warpH);
    const cx = warpW / 2, row = (f) => Math.round(2 + f * bh * sy * dpr);
    for (let i = 0; i < NS; i++) {
      const f0 = i / NS, f1 = (i + 1) / NS;
      const k = 0.25 + 0.75 * Math.pow(Math.min(1, (f0 + f1) / 2 / M.rimY), 1.8);
      const ww = bw * dpr * (1 - amp * c * k), y0 = row(f0), y1 = row(f1);
      if (y1 > y0) warpX.drawImage(im, 0, f0 * sh, sw, (f1 - f0) * sh, cx - ww * M.cx, y0, ww, y1 - y0);
    }
    warpRim = 2 + M.rimY * bh * sy * dpr;
  }
  function bellSprite(im, x, y, bw, c, rot, a, amp, glow = 0) {   // (x, y) is the centre of the rim
    if (a <= 0.01) return;
    warpBell(im, bw, c, amp);
    ctx.save();
    ctx.translate(x, y); if (rot) ctx.rotate(rot);
    const dw = warpW / dpr, dh = warpH / dpr, ox = -warpW / 2 / dpr, oy = -warpRim / dpr;
    ctx.globalAlpha = clamp(a, 0, 1);
    ctx.drawImage(warpC, 0, 0, warpW, warpH, ox, oy, dw, dh);
    if (glow > 0.01) {                                     // a set jelly is denser, and in the dark it glows
      ctx.globalCompositeOperation = pal.glowOp;
      ctx.globalAlpha = clamp(a * glow * pal.glowK, 0, 1);
      ctx.drawImage(warpC, 0, 0, warpW, warpH, ox, oy, dw, dh);
    }
    ctx.restore();
  }
  function cystSprite(im, x, y, cw, rot, a, qx, qy) {      // (x, y) is where it touches down
    if (a <= 0.01 || cw < 1) return;
    const ch = cw * C.ar;
    ctx.save();
    ctx.translate(x, y); if (rot) ctx.rotate(rot); ctx.scale(qx, qy);
    ctx.globalAlpha *= clamp(a, 0, 1);
    ctx.drawImage(im, -C.cx * cw, -C.baseY * ch, cw, ch);
    ctx.restore();
  }

  // A creature, placed by its stomach (x, y), which survives every change of form. m: 0 a medusa … 1 a cyst.
  function creature(o, dt, t) {
    if (!ready || o.a <= 0.01) return;
    o = { ...o, a: o.a * fadeIn() };
    const m = o.m || 0, toCyst = smooth(0.4, 0.82, m);
    const s = o.s * lerp(1, 0.58, smooth(0, 0.7, m));
    const c = Math.max(o.c, smooth(0, 0.4, m)), amp = 0.2 + 0.26 * smooth(0.15, 0.8, m);
    const rot = (o.rot || 0) + 0.45 * bump(m, 0.05, 0.45, 0.55, 0.95);   // it rolls as it folds in
    const bw = BW * s, bh = bw * M.ar, sy = 1 + 0.08 * c;
    const rim = rotv(0, coreToRim(s, c), rot);
    const rx = o.x + rim.x, ry = o.y + rim.y;
    if (o.sk) {
      const sk = o.sk, hw = bw * 0.47 * (1 - amp * c);
      for (let i = 0; i < sk.n; i++) {
        const th = (Math.PI * (i + 0.5)) / sk.n;
        const q = rotv(-Math.cos(th) * hw, (M.rootY - M.rimY) * bh * sy + Math.sin(th) * 0.035 * bh, rot);
        sk.R[i * 2] = rx + q.x; sk.R[i * 2 + 1] = ry + q.y;
      }
      const len = TL * s * (o.lenK ?? 1) * (1 - smooth(0, 0.5, m));
      simulate(sk, Math.max(0.5, len), dt, t);
      drawSkirt(sk, o.red ? "cherry" : "rim", o.a * (1 - toCyst), ry, len + 0.1 * bh);
    }
    bellSprite(o.red ? IMG.medusaRed : IMG.medusa, rx, ry, bw, c, rot, o.a * (1 - toCyst), amp, o.glow || 0);
    if (toCyst > 0.01) {
      const cw = (o.cw || CW) * lerp(0.55, 1, smooth(0.35, 1, m)), cc = cystCore(cw);
      const cr = o.crot || 0, base = rotv(-cc.x, cc.y, cr);
      if (o.shadow > 0.01) {                               // grounded
        ctx.beginPath(); ctx.ellipse(o.x + base.x, o.y + base.y + 1, cw * 0.42 * (o.qx || 1), 3.2, 0, 0, TAU);
        ctx.fillStyle = `oklch(0.1 0.02 250 / ${(0.22 * o.shadow * o.a).toFixed(3)})`; ctx.fill();
      }
      cystSprite(o.red ? IMG.cystRed : IMG.cyst, o.x + base.x, o.y + base.y, cw, cr, o.a * toCyst, o.qx || 1, o.qy || 1);
    }
  }

  function ghostOutline(x, y, s, key, a) {                // where a version used to be (x, y: its stomach)
    if (a <= 0.01) return;
    const bw = BW * s, bh = bw * M.ar, hb = 0.05 * bh, yRim = y + coreToRim(s);
    const W2 = (bw * 0.98) / 0.88, ht = (M.rimY - M.apexY) * bh - hb, hc = 0.03 * bh;
    ctx.beginPath();
    const n = 40;
    for (let i = 0; i <= n; i++) {
      const th = (i / n) * TAU;
      let px, py;
      if (th <= Math.PI) { const sn = Math.sin(th); px = x + (W2 / 2) * Math.cos(th) * (0.88 + 0.12 * sn); py = yRim - (hb + ht) * Math.pow(sn, 0.55); }
      else { px = x + (W2 / 2) * 0.88 * Math.cos(th); py = yRim + hc * Math.sin(th) * -1; }
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.setLineDash([3, 5]); ctx.lineWidth = 1.2; ctx.strokeStyle = col(key, a); ctx.stroke(); ctx.setLineDash([]);
  }

  // The polyp rises from its runner on the branch and sways from its base. Returns where its bud hangs.
  function polypSprite(gr, t, a) {
    if (gr <= 0.001 || !ready) return null;
    const ph = PH, pw = ph / PY.ar, g = smooth(0, 1, gr);
    const rot = 0.026 * Math.sin(t * 0.7) * g, sy = pop(gr), sx = lerp(0.55, 1, g);
    ctx.save();
    ctx.translate(G.xp, G.yBr); ctx.rotate(rot); ctx.scale(sx, sy);
    ctx.globalAlpha = a * smooth(0, 0.35, gr) * fadeIn();
    ctx.drawImage(IMG.polyp, -PY.stalkX * pw, -PY.baseY * ph, pw, ph);
    ctx.restore();
    const q = rotv(0.012 * pw * sx, -(PY.baseY - PY.budY) * ph * sy, rot);
    return { x: G.xp + q.x, y: G.yBr + q.y };
  }

  function keycap(x, y, a, press, ok) {                    // the inbox's approve key
    if (a <= 0.01) return;
    ctx.save(); ctx.globalAlpha = a;
    const s = 30, top = y - s / 2 + 3 * press;
    rrect(x - s / 2, y - s / 2 + 4, s, s, 6); ctx.fillStyle = col("ink", 0.28); ctx.fill();
    rrect(x - s / 2, top, s, s, 6);
    ctx.fillStyle = ok > 0 ? mixc("bg", "jelly", ok * 0.9) : mixc("bg", "mint", 0.2); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = ok > 0.5 ? col("ink", 0.55) : col("mint", 0.95); ctx.stroke();
    ctx.fillStyle = col("ink", 0.9);
    ctx.font = '600 16px "Atkinson Hyperlegible Next", "Atkinson Hyperlegible", system-ui, sans-serif';
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("a", x, top + s / 2 + 0.5);
    if (ok > 0) check(x + s * 0.95, y + 1, 1.15 * ok, col("rim", ok), 2.2);
    ctx.restore();
  }

  // ── The water: light from production, drifting snow, a few soft motes close to the glass ──
  const wave = (x, t) => yProd + 2.2 * Math.sin(x * 0.018 + t * 1.1) + 1.2 * Math.sin(x * 0.043 - t * 0.7);
  function rays() {
    for (let i = 0; i < 3; i++) {
      const xb = (0.14 + 0.35 * i) * W + Math.sin(i * 2) * 20, w1 = 26 + 16 * i, w2 = 80 + 30 * i, len = D * 0.9, sk = 50 + 25 * i;
      const g = ctx.createLinearGradient(0, yProd, 0, yProd + len);
      g.addColorStop(0, col("ray", pal.rayA * 0.32)); g.addColorStop(1, col("ray", 0));
      ctx.fillStyle = g; ctx.beginPath();
      ctx.moveTo(xb - w1, yProd); ctx.lineTo(xb + w1, yProd); ctx.lineTo(xb + w2 + sk, yProd + len); ctx.lineTo(xb - w2 + sk, yProd + len);
      ctx.closePath(); ctx.fill();
    }
  }
  function snow(t) {
    const span = H - yProd;
    ctx.beginPath();
    for (const f of G.snow) {
      const y = yProd + ((f.y * span + t * f.v) % span), x = f.x * W + Math.sin(t * 0.4 + f.ph) * 6;
      ctx.moveTo(x + f.r, y); ctx.arc(x, y, f.r, 0, TAU);
    }
    ctx.fillStyle = col("ink", pal.snowA); ctx.fill();
  }
  function bokeh(t) {
    const span = yGit - yProd;
    for (const b of G.bokeh) {
      const x = sb.x + b.x * sb.w + Math.sin(t * 0.13 + b.ph) * 14, y = yProd + ((b.y * span - t * b.v) % span + span) % span;
      halo(x, y, b.r, pal.bokeh, pal.bokehA);
    }
  }
  function glowBand() {
    const g = ctx.createLinearGradient(0, yProd, 0, yProd + 0.16 * D);
    g.addColorStop(0, col("ray", pal.glowA)); g.addColorStop(1, col("ray", 0));
    ctx.fillStyle = g; ctx.fillRect(0, yProd, W, 0.16 * D);
  }
  // Production is the water's surface. Requests ride along it.
  function surface(t) {
    ctx.beginPath();
    for (let x = 0; x <= W + 8; x += 8) { const y = wave(x, t); if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.lineWidth = 1.25; ctx.strokeStyle = col("ink", 0.32); ctx.stroke();
    const sp = 30, off = (t * 34) % sp;
    ctx.beginPath();
    for (let x = -sp + off; x < W + sp; x += sp) { ctx.moveTo(x - 2.5, wave(x - 2.5, t)); ctx.lineTo(x + 2.5, wave(x + 2.5, t)); }
    ctx.lineWidth = 2.2; ctx.strokeStyle = col("ink", 0.5); ctx.stroke();
  }
  // Git is the seabed: main and its commits.
  function mainline() {
    ctx.beginPath(); ctx.moveTo(0, yGit); ctx.lineTo(W, yGit);
    ctx.lineWidth = 1.5; ctx.strokeStyle = col("ink", 0.36); ctx.stroke();
    const sp = clamp(u * 0.9, 34, 64), special = [G.xc, G.xm, G.xr];
    for (let x = (W % sp) / 2 + sp / 2; x < W; x += sp) {
      if (special.some((s) => Math.abs(s - x) < sp * 0.5)) continue;
      ring(x, yGit, 3.1, col("ink", 0.45), 1.3, col("bg", 1));
    }
    ring(G.xc, yGit, 3.1, col("ink", 0.45), 1.3, col("bg", 1));
  }
  // Everything that only changes with layout or theme, painted once into an offscreen layer.
  function background() {
    const key = `${canvas.width}x${canvas.height}:${pal === PAL.dark ? "d" : "l"}:${yProd.toFixed(1)}:${yGit.toFixed(1)}`;
    if (key !== bgKey) {
      bgKey = key;
      bg.width = canvas.width; bg.height = canvas.height;
      ctx = bgx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.lineCap = "round"; ctx.lineJoin = "round";
      rays(); glowBand(); mainline();
      ctx = ctx0;
    }
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.drawImage(bg, 0, 0); ctx.restore();
  }

  // The trail's branch is the cyst's runner (a stolon), so it's drawn as a living tube.
  function tube(pts, t1, a, acc = 1) {                     // acc: 0 unapproved work (neutral) … 1 approved (amber)
    ctx.beginPath(); if (!tracePart(pts, t1)) return;
    ctx.lineWidth = 3.4; ctx.strokeStyle = mixc("ink", "jelly", acc, (0.16 + 0.26 * acc) * a); ctx.stroke();
    ctx.lineWidth = 1.2; ctx.strokeStyle = mixc("ink", "rim", acc, (0.55 + 0.35 * acc) * a); ctx.stroke();
  }
  function seabed(p, t) {
    const br = w("branch", p), fade = 1 - 0.25 * w("warm", p), acc = w("approved", p);
    if (br > 0) {
      tube(G.branch, br, fade, acc);
      for (const nx of [G.xc + 1.0 * u]) {
        const k = pop(smooth((nx - G.xc) / G.brLen - 0.04, (nx - G.xc) / G.brLen + 0.06, br));
        if (k > 0) ring(nx, G.yBr, 3.1 * k, mixc("ink", "rim", acc, 0.9 * fade), 1.4, col("bg", 1));
      }
    }
    const mg = w("merge", p);
    if (mg > 0) tube(G.mergeP, mg, fade);
    const mk = pop(w("mergeNode", p));
    if (mk > 0) ring(G.xm, yGit, 5 * mk, col("rim", 1), 1.6, col("jelly", 1));
    const rv = bump(p, 3.62, 3.74, 4.35, 4.6);             // the landing spreads along git while you look at it
    if (rv > 0) {
      for (let k = 0; k < 2; k++) {
        const f = (t * 0.45 + k * 0.5) % 1, dx = 8 + f * W * 0.55;
        ctx.beginPath();
        for (const sd of [-1, 1]) { const x = G.xm + sd * dx; ctx.moveTo(x - 12, yGit); ctx.lineTo(x + 12, yGit); }
        ctx.lineWidth = 2.6; ctx.strokeStyle = col("rim", (1 - f) * rv * 0.9); ctx.stroke();
      }
    }
    const rk = pop(w("revertNode", p));
    if (rk > 0) ring(G.xr, yGit, 4.6 * rk, col("cherry", 1 - 0.4 * w("fadeUndo", p)), 1.6, col("cherry", 0.9 - 0.4 * w("fadeUndo", p)));
  }

  function dotted(pts, t1, key, a, t0 = 0, lw = 2.6) {
    if (a <= 0.01) return;
    ctx.beginPath();
    if (!tracePart(pts, t1, t0)) return;
    ctx.setLineDash([0.01, 7]); ctx.lineWidth = lw; ctx.strokeStyle = col(key, a); ctx.stroke(); ctx.setLineDash([]);
  }

  // ── The scene at focus p, clock t (s); dt (s) advances the tentacles ──
  const L = {};                                            // leader targets, one per line
  function drawScene(p, t, dt) {
    pal = isDark() ? PAL.dark : PAL.light;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.globalAlpha = 1;

    const curl = w("curl", p), sink = w("sink", p), landed = w("land", p), passK = w("pass", p), warm = w("warm", p);
    const sHit = since("hit", t), sLand = since("land", t), sRel = since("release", t), sSet = since("set", t), sRev = since("revert", t);

    // A: the jellyfish in production. It swims in place, is hit, folds into a cyst and sinks along the trail.
    const bobA = (1 - curl) * lift(t / 1.9) * 0.3 * u;
    const A = sink > 0 ? at(G.down, sink) : { x: G.a.x, y: G.a.y - bobA };
    const hurt = w("hurt", p) * (1 - curl), flinch = sHit < 2.5 ? Math.exp(-3.2 * sHit) : 0;
    const cA = Math.max(stroke(t / 1.9), 0.55 * hurt, 0.95 * flinch * (1 - curl));
    const rotA = (0.1 * hurt + 0.15 * ringOut(sHit, 1.5, 2.8)) * (1 - curl);
    if (sHit < 0.05) SK.a.kick = 3;                         // the hit flicks the tentacles

    // The bug: a request turns mint, dives, lodges in the bell, rides inside the cyst down to git.
    const impact = { x: -0.28 * BW, y: -0.18 * BH };
    const on = w("sparkOn", p), fly = w("sparkFly", p);
    let S = null;
    if (on > 0) {
      const s0x = sb.x + 0.035 * sb.w + (p - 0.28) * 20, s0 = { x: s0x, y: wave(s0x, t) };
      if (fly < 1) {
        const tgt = { x: G.a.x + impact.x, y: G.a.y - bobA + impact.y };
        S = quad(s0, { x: lerp(s0.x, tgt.x, 0.4), y: s0.y - 0.04 * D }, tgt)(fly);
      } else {
        S = { x: A.x + impact.x * (1 - curl), y: A.y + impact.y * (1 - curl) };
      }
    }

    // B: the bud on the polyp, then the young jellyfish swimming up to production.
    const budK = w("bud", p), release = w("release", p), unfurl = w("unfurl", p), rise = w("rise", p);
    const grow = w("grow", p), setK = w("set", p);
    // Gh: a bad fix that folds up and sinks back onto a revert.
    const gIn = w("ghostIn", p), gCurl = w("ghostCurl", p), gSink = w("ghostSink", p), gLand = w("ghostLand", p);
    const undoFade = 1 - 0.55 * w("fadeUndo", p);

    // Washes tint the whole page with the current state.
    if (S) wash(S.x, S.y, "mint", bump(p, 0.86, 1.0, 1.08, 1.6) * pal.washA);
    wash(G.xr, yGit, "cherry", bump(p, 4.78, 4.96, 5.05, 5.5) * pal.washA);
    wash(G.b.x, G.b.y, "jelly", warm * pal.washA);

    background();
    snow(t);
    surface(t);
    seabed(p, t);

    // Trails: down from the hurt jellyfish, up to the new one, the bad fix back down, and the loop closing.
    dotted(G.down, sink, "rim", 0.85 - 0.15 * warm);
    dotted(G.up, rise, "rim", 0.85 - 0.15 * warm);
    if (gSink > 0) {
      ctx.beginPath(); tracePart(G.gpath, gSink);
      ctx.setLineDash([5, 5]); ctx.lineWidth = 1.6; ctx.strokeStyle = col("cherry", 0.8 * undoFade); ctx.stroke(); ctx.setLineDash([]);
    }
    const lp = w("loop", p);
    if (lp > 0) {
      dotted(G.loop, lp, "rim", 0.75);
      if (lp > 0.97) {
        const e = at(G.loop, 1), q = at(G.loop, 0.94), ang = Math.atan2(e.y - q.y, e.x - q.x);
        ctx.beginPath();
        ctx.moveTo(e.x - 8 * Math.cos(ang - 0.55), e.y - 8 * Math.sin(ang - 0.55)); ctx.lineTo(e.x, e.y);
        ctx.lineTo(e.x - 8 * Math.cos(ang + 0.55), e.y - 8 * Math.sin(ang + 0.55));
        ctx.lineWidth = 2; ctx.strokeStyle = col("rim", 0.85); ctx.stroke();
      }
    }

    // Where versions used to be.
    ghostOutline(G.a.x, G.a.y, 1, "ink", 0.3 * smooth(1.32, 1.6, p));
    ghostOutline(G.g.x, G.g.y, 0.85, "cherry", 0.4 * smooth(4.72, 4.88, p) * undoFade);

    // Sonar: it hunts for bugs. Only under the surface.
    const ping = bump(p, ...T.ping);
    if (ping > 0) {
      ctx.save(); ctx.beginPath(); ctx.rect(0, yProd + 2, W, H); ctx.clip();
      for (let k = 0; k < 3; k++) {
        const f = (t * 0.45 + k / 3) % 1, r = 0.62 * BW + f * 2.6 * u;
        ctx.beginPath(); ctx.arc(G.a.x, G.a.y - bobA, r, 0, TAU);
        ctx.lineWidth = 1.2; ctx.strokeStyle = col("ink", (1 - f) ** 1.5 * 0.45 * ping); ctx.stroke();
      }
      ctx.restore();
    }

    // The polyp, its bud, and the proof and approval around the bud.
    const att = polypSprite(w("polyp", p), t, 1 - 0.2 * warm) || G.attach;
    let B;
    if (rise > 0) B = at(G.up, rise);
    else B = { x: att.x + lerp(0.38, 0.55, release) * u, y: att.y + lerp(0.12, -0.07, release) * u };
    const sB = lerp(lerp(0.26 * budK, 0.45, unfurl), 1, grow) * (1 + 0.14 * ringOut(sRel, 1.8, 4));
    const bobB = unfurl * lift(t / 1.5 + 0.37) * 0.28 * u * sB;
    let rotB = 0;
    if (rise > 0 && rise < 1) {
      const q0 = at(G.up, Math.max(0, rise - 0.03)), q1 = at(G.up, Math.min(1, rise + 0.03));
      rotB = clamp(Math.atan2(q1.x - q0.x, q0.y - q1.y), -0.6, 0.6) * Math.sin(Math.PI * rise);
    }
    const Bs = { x: B.x, y: B.y - bobB };
    if (budK > 0 && release < 1) {                         // the stalk it hangs from
      const apex = rotv(0, -(M.coreY - M.apexY) * BH * sB, 0);
      ctx.beginPath(); ctx.moveTo(att.x, att.y); ctx.quadraticCurveTo(lerp(att.x, Bs.x, 0.6), att.y, Bs.x + apex.x, Bs.y + apex.y);
      ctx.lineWidth = 1.6; ctx.strokeStyle = col("rim", 0.75 * (1 - release)); ctx.stroke();
    }
    const out = 1 - w("proofOut", p), ringK = w("ring", p) * out;
    if (ringK > 0) {
      const R = 0.32 * BW * sB + 0.36 * u;
      ctx.beginPath(); ctx.arc(Bs.x, Bs.y, R, -Math.PI / 2, -Math.PI / 2 + TAU * w("ring", p));
      ctx.setLineDash(passK > 0.5 ? [] : [3, 5]); ctx.lineWidth = 1.3;
      ctx.strokeStyle = mixc("ink", "rim", passK, (0.55 + 0.35 * passK) * out); ctx.stroke(); ctx.setLineDash([]);
      const tk = w("ticks", p);
      for (let i = 0; i < 5; i++) {
        const k = pop(smooth(i / 5, i / 5 + 0.2, tk)) * out;
        if (k > 0) { const ang = -Math.PI / 2 + (i * TAU) / 5; disc(Bs.x + Math.cos(ang) * R, Bs.y + Math.sin(ang) * R, 3 * k, col("rim", out)); }
      }
    }
    const keyAt = { x: Bs.x + 1.05 * u + 6, y: Bs.y - 0.95 * u - 6 };
    keycap(keyAt.x, keyAt.y, w("keyIn", p) * out, w("keyPress", p) * (1 - w("approved", p) * 0.6), w("approved", p));

    // A, then its evidence and the bug it carries.
    const sq = 0.26 * ringOut(sLand, 2.3, 4.2) * landed, br = w("branch", p);
    const breathe = 1 + 0.014 * Math.sin(t * 1.3) * landed;
    creature({
      x: A.x, y: A.y, s: 1, m: curl, c: cA, rot: rotA, a: 1 - 0.2 * warm * landed, sk: SK.a,
      crot: 0.22 * Math.sin(sink * Math.PI * 1.5) * (1 - landed), shadow: landed,
      qx: (1 + 0.8 * sq) * (1 + 0.06 * br) * breathe, qy: (1 - sq) * (1 - 0.1 * br) * breathe,
    }, dt, t);
    puff(G.xc, yGit - 2, sLand, "rim", 12, 1.3 * u);
    let kept = 0;
    for (let i = 0; i < G.motes.length; i++) {
      const m = G.motes[i], vis = smooth(1.02, 1.2, p), take = smooth(m.q - 0.06, m.q + 0.03, sink);
      if (take >= 1) { kept++; continue; }
      if (vis <= 0) continue;
      const x = lerp(m.x, A.x, take), y = lerp(m.y, A.y, take), r = 2.6;
      ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
      ctx.fillStyle = mixc("ink", "rim", take, (0.55 + 0.4 * take) * vis); ctx.fill();
    }
    if (kept && curl > 0.6) {
      for (let i = 0; i < kept; i++) {
        const ang = t * 0.5 + (i * TAU) / 5, rr = CW * 0.24;
        const x = A.x + Math.cos(ang) * rr, y = A.y - Math.sin(ang) * rr * 0.75, r = 2.2;
        ctx.beginPath(); ctx.moveTo(x, y - r); ctx.lineTo(x + r, y); ctx.lineTo(x, y + r); ctx.lineTo(x - r, y); ctx.closePath();
        ctx.fillStyle = col("rim", 0.9 * (1 - 0.2 * warm)); ctx.fill();
      }
    }
    if (S) {
      const repro = bump(p, 1.78, 1.9, 2.7, 2.8);
      spark(S.x, S.y, passK, on * (1 - 0.3 * warm), repro * (0.5 + 0.5 * Math.sin(t * 5)));
      if (passK > 0) check(A.x + CW * 0.62, A.y - CW * 0.55, 1.1 * passK, col("rim", passK), 2.2);
    }

    // B: bud, young jellyfish, then set. It wobbles once as it sets.
    if (budK > 0) {
      halo(Bs.x, Bs.y, 1.35 * BW, "jelly", setK * (0.2 + 0.05 * Math.sin(t * 1.5)) * (1 + 0.6 * warm));
      const cB = lerp(1, stroke(t / 1.5 + 0.37) * (1 - 0.45 * setK), unfurl) + 0.32 * ringOut(sSet, 2.1, 3.2);
      creature({ x: Bs.x, y: Bs.y, s: sB, m: 0, c: cB, rot: rotB, a: 1, sk: SK.b, lenK: smooth(0.25, 1, unfurl), glow: setK * (0.7 + 0.3 * warm) }, dt, t);
    }

    // Gh: the bad fix. It doesn't vanish: a rolled-back trail waits on git to be tried again.
    if (gIn > 0) {
      const Gh = gSink > 0 ? at(G.gpath, gSink) : { x: G.g.x, y: G.g.y - (1 - gCurl) * lift(t / 1.7 + 0.71) * 0.15 * u };
      const sr = 0.26 * ringOut(sRev, 2.3, 4.2) * gLand;
      creature({
        x: Gh.x, y: Gh.y, s: 0.85, m: gCurl, c: stroke(t / 1.7 + 0.71), a: gIn * undoFade, red: true, sk: SK.g, cw: CW * 0.85,
        crot: 0.2 * Math.sin(gSink * Math.PI * 1.5) * (1 - gLand), shadow: gLand, qx: 1 + 0.8 * sr, qy: 1 - sr,
      }, dt, t);
      puff(G.xr, yGit - 2, sRev, "cherry", 10, 1.1 * u);
    }

    bokeh(t);

    L[0] = { x: G.a.x - 0.2 * BW * (1 - curl), y: G.a.y - bobA };
    L[1] = S || L[0];
    L[2] = { x: A.x, y: A.y };
    L[3] = w("keyIn", p) * out > 0.5 ? keyAt : { x: Bs.x, y: Bs.y };
    L[4] = { x: G.xm, y: yGit };
    L[5] = { x: Bs.x - 0.2 * BW * sB, y: Bs.y };
    L[6] = at(G.loop, 0.5);
    if (!stacked && motion()) leader(p);
    caption(p, {
      a: { x: G.a.x, y: G.a.y - bobA, r: 0.55 * BW },
      spark: S ? { x: S.x, y: S.y, r: 10 } : { x: G.a.x, y: G.a.y - bobA, r: 0.55 * BW },
      cyst: { x: A.x, y: A.y, r: Math.max(0.6 * CW, 12) },
      bud: { x: Bs.x, y: Bs.y, r: 0.32 * BW * sB + 0.36 * u + 6 },
      key: { x: keyAt.x, y: keyAt.y, r: 22 },
      merge: { x: G.xm, y: yGit, r: 12 },
      young: { x: Bs.x, y: Bs.y, r: 0.55 * BW * sB },
      revert: { x: G.xr, y: yGit, r: 14 },
    });
  }

  // ── What the drawing is showing, in words: one short caption at a time, beside the thing it's about. ──
  // No numbers: the drawing is a diagram, not a measurement. Tones follow the colour contract.
  const CAPTIONS = [
    { a: -1, b: 0.4, text: "Your software, in production", at: "a", side: "right" },
    { a: 0.42, b: 1.12, text: "An error in production", tone: "mint", at: "spark", side: "right" },
    { a: 1.14, b: 1.76, text: "Its errors become one quest", at: "cyst", side: "right" },
    { a: 1.78, b: 2.12, text: "The repro fails on main", tone: "mint", at: "cyst", side: "above" },
    { a: 2.14, b: 2.5, text: "A patch, tested on that repro", at: "bud", side: "right" },
    { a: 2.5, b: 2.74, text: "The same repro passes", tone: "amber", at: "bud", side: "right" },
    { a: 2.74, b: 3.14, text: "C · waiting on you", tone: "mint", at: "key", side: "right" },
    { a: 3.14, b: 3.38, text: "Approved", tone: "amber", at: "key", side: "right" },
    { a: 3.4, b: 4.3, text: "Landed on git", tone: "amber", at: "merge", side: "above" },
    { a: 4.3, b: 4.56, text: "Back in production, watched", tone: "amber", at: "young", side: "left" },
    { a: 4.56, b: 4.76, text: "Watch clean: it sets", tone: "amber", at: "young", side: "left" },
    { a: 4.76, b: 5.2, text: "A bad fix, reverted", tone: "cherry", at: "revert", side: "above" },
  ];
  let eventText = "", eventW = 0, eventH = 0;
  function caption(p, pts) {
    if (!eventEl) return;
    const c = motion() ? CAPTIONS.find((x) => p >= x.a && p < x.b) : undefined;
    const at = c && pts[c.at];
    eventEl.classList.toggle("on", Boolean(at));
    if (!c || !at) return;
    if (c.text !== eventText) {                              // measure once per caption, not every frame
      eventText = c.text;
      eventEl.textContent = c.text;
      eventEl.dataset.tone = c.tone ?? "";
      eventW = eventEl.offsetWidth;
      eventH = eventEl.offsetHeight;
    }
    const gap = at.r + 10;
    let x = c.side === "above" ? at.x - eventW / 2 : c.side === "left" ? at.x - gap - eventW : at.x + gap;
    let y = c.side === "above" ? at.y - gap - eventH : at.y - eventH / 2;
    const x0 = sb.x + 2, x1 = sb.x + sb.w - 2, y0 = yProd + (stacked ? 30 : 10), y1 = yGit - 4;
    if (c.side === "right" && x + eventW > x1) x = at.x - gap - eventW;   // no room: the other side
    if (c.side === "left" && x < x0) x = at.x + gap;
    x = clamp(x, x0, Math.max(x0, x1 - eventW));
    y = clamp(y, y0, Math.max(y0, y1 - eventH));
    put(eventEl, "transform", `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`);
  }

  // A dotted line from the line in focus to the thing it describes.
  function leader(p) {
    const k = Math.round(p), a = 1 - smooth(0.18, 0.42, Math.abs(p - k));
    if (a <= 0.01 || !ends[k] || !L[k]) return;
    const s = { x: ends[k].x + 14, y: stanzaY + glideY + ends[k].y }, e = L[k];
    if (e.x - s.x < 40) return;
    ctx.beginPath(); ctx.moveTo(s.x, s.y);
    ctx.quadraticCurveTo(s.x + (e.x - s.x) * 0.55, s.y, e.x, e.y);
    ctx.setLineDash([1.5, 4.5]); ctx.lineWidth = 1.2; ctx.strokeStyle = col("ink", 0.42 * a); ctx.stroke(); ctx.setLineDash([]);
    disc(s.x, s.y, 2.2, col("ink", 0.55 * a));
    ring(e.x, e.y, 4, col("ink", 0.6 * a), 1.2);
  }

  // ── The stanza: rack focus down it, glide it when it's taller than its window, reveal the CTA at the end ──
  function renderCopy(p) {
    const t = smooth(N - 1.6, N - 1, p);
    const k = Math.min(Math.floor(p), N - 2), x = p - k;
    lines.forEach((el, i) => {
      const d = i - p;
      let blur, op;
      // The next line is always readable; lines further ahead soften, like a lens racking focus.
      if (d >= 0) { blur = d > 1 ? Math.min(0.14, 0.07 * (d - 1)) : 0; op = Math.max(0.24, 1 - 0.3 * d); }
      else { blur = 0; op = Math.max(0.5, 1 + 0.25 * d); }
      blur *= 1 - t;
      op = lerp(op, 1, t);
      put(el, "filter", blur > 0.002 ? `blur(${blur.toFixed(3)}em)` : "none");
      put(el, "opacity", op.toFixed(3));
      el.classList.toggle("is-focus", Math.abs(d) < 0.5);
    });
    glideY = 0;
    if (overflow > 0) {
      const c = lerp(lerp(centers[k], centers[k + 1], x), centers[N], t);
      glideY = clamp(availH * 0.45 - c, -overflow, 0);
      put(copy, "--fade-top", `${Math.min(availH * 0.2, 88, -glideY).toFixed(1)}px`);
      put(copy, "--fade-bot", `${Math.min(availH * 0.16, 64, overflow + glideY).toFixed(1)}px`);
    }
    put(stanza, "transform", glideY ? `translate3d(0, ${glideY.toFixed(1)}px, 0)` : "none");
    put(cta, "opacity", t.toFixed(3));
    put(cta, "transform", `translateY(${((1 - t) * 10).toFixed(1)}px)`);
    put(cta, "pointer-events", t > 0.5 ? "auto" : "none");
    put(cue, "opacity", (1 - smooth(0, 0.3, p)).toFixed(3));
    put(plate, "opacity", (0.7 + 0.3 * smooth(5.3, 6, p)).toFixed(3));
  }

  // ── Loop: scroll sets the target, focus eases toward it, the water keeps moving while it's on screen ──
  let target = 0, p = 0, raf = 0, lastT = 0, lastDraw = 0, onScreen = true;
  const readScroll = () => { target = clamp((scrollY - reelTop) / step, 0, N - 1); };
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    const settled = p === target;
    if (!settled) {
      p += (target - p) * (1 - Math.exp(-dt * 12));
      if (Math.abs(target - p) < 0.0004) p = target;
    }
    if (!settled || now - lastDraw >= 31) {               // the water idles at 30 fps; the story runs at full rate
      const t = now / 1000;
      fire(p, t);
      renderCopy(p);
      drawScene(p, t, lastDraw ? Math.min(0.1, (now - lastDraw) / 1000) : 0);
      lastDraw = now;
    }
    if (motion() && onScreen && !document.hidden) raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (raf || !motion() || !onScreen || document.hidden) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }
  const drawStill = () => drawScene(N - 1, 0.7, 0);        // no motion: the whole cycle, at rest

  addEventListener("scroll", () => { if (motion()) { readScroll(); kick(); } }, { passive: true });
  document.addEventListener("visibilitychange", () => { lastDraw = 0; kick(); });
  new IntersectionObserver(([en]) => { onScreen = en.isIntersecting; lastDraw = 0; kick(); }).observe(stage);
  let resizeRaf = 0;
  new ResizeObserver(() => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => { measure(); if (motion()) { readScroll(); kick(); } else drawStill(); });
  }).observe(stage);
  darkMQ.addEventListener("change", () => { if (!motion()) drawStill(); });

  lines.forEach((el, i) => el.addEventListener("click", () => {
    if (!motion() || el.classList.contains("is-focus")) return;
    if (String(getSelection && getSelection()).trim()) return;   // selecting text is not a request to jump
    scrollTo({ top: reelTop + i * step, behavior: "smooth" });
  }));
  cta.addEventListener("focusin", () => {
    if (motion() && target < N - 1) scrollTo({ top: reelTop + (N - 1) * step, behavior: "smooth" });
  });

  function enable(on) {
    root.classList.toggle("motion", on);
    cancelAnimationFrame(raf);
    raf = 0;
    if (!on) { clearCopyStyles(); copy.classList.remove("overflows"); }
    measure();
    if (on) { readScroll(); p = prevP = target; lastDraw = 0; renderCopy(p); drawScene(p, performance.now() / 1000, 0); kick(); }
    else drawStill();
  }
  reduceMQ.addEventListener("change", () => enable(!reduceMQ.matches));
  enable(!reduceMQ.matches);

  const remeasure = () => { measure(); if (motion()) { readScroll(); kick(); } else drawStill(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  addEventListener("load", remeasure);
  spritesLoaded.then(() => { if (!motion()) drawStill(); });
})();
