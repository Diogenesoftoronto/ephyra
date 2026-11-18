// Ephyra · cut D "Rack focus"
// One pinned stanza. Scroll moves the focal plane down it a line at a time and racks the lens between
// specimens. Every frame is a pure function of the scroll position, so scrolling back rewinds.
// On the last line the whole stanza comes into focus at once: the page sets.

(() => {
  const root = document.documentElement;
  const reduceMQ = matchMedia("(prefers-reduced-motion: reduce)");
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];

  const reel = $(".reel");
  const copy = $(".copy");
  const stanza = $(".stanza");
  const cta = $(".cta");
  const lens = $(".lens");
  const optics = $(".optics");
  const arc = $(".arc");
  const cue = $(".cue");
  const video = $(".slide video");
  const lines = $$(".ln");
  const slides = $$(".slide");
  const beads = $$(".bead");
  const snaps = $$(".snaps i");

  const N = lines.length;                                  // focus stops
  const slideFor = (i) => (i === N - 1 ? 0 : i);           // the last line closes the loop on the first specimen
  const MAX_PULL = 14;                                     // px of lens blur at the middle of a focus pull

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, v) => { const x = clamp((v - a) / (b - a), 0, 1); return x * x * (3 - 2 * x); };

  // Style writes are cached so a frame only touches what changed.
  const written = new Map();
  function put(el, prop, value) {
    let c = written.get(el);
    if (!c) written.set(el, (c = {}));
    if (c[prop] === value) return;
    c[prop] = value;
    el.style.setProperty(prop, value);
  }
  function clearStyles() {
    for (const [el, c] of written) for (const prop of Object.keys(c)) el.style.removeProperty(prop);
    written.clear();
    lines.forEach((el) => el.classList.remove("is-focus"));
    beads.forEach((b) => b.classList.remove("on"));
  }

  // ── Geometry ──
  let reelTop = 0, step = 1, availH = 0, overflow = 0, centers = [];
  function measure() {
    reelTop = reel.getBoundingClientRect().top + scrollY;
    step = (snaps[1] && snaps[1].offsetTop - snaps[0].offsetTop) || innerHeight * 0.8;
    copy.classList.remove("overflows");
    availH = copy.clientHeight;
    const over = stanza.offsetHeight > availH + 1;
    copy.classList.toggle("overflows", over);              // adds top/bottom padding, so measure again
    overflow = over ? stanza.offsetHeight - availH : 0;
    centers = lines.map((el) => el.offsetTop + el.offsetHeight / 2);
    centers.push(cta.offsetTop + cta.offsetHeight / 2);
  }

  // ── The film as a function of p, the continuous focus index (0 … N-1) ──
  let wobbleStart = -1, wasSet = false;
  function render(p, now) {
    const t = smooth(N - 1.6, N - 1, p);                   // the set: everything comes into focus on the last line
    const k = Math.min(Math.floor(p), N - 2);
    const x = p - k;                                       // progress between stop k and stop k+1

    // Lines: the future is out of focus, the past is soft but legible, the present is sharp.
    // Blur is in em so a phone's smaller type defocuses by the same proportion.
    lines.forEach((el, i) => {
      const d = i - p;
      let blur, op;
      if (d >= 0) { blur = Math.min(0.3, 0.115 * d); op = Math.max(0.16, 1 - 0.42 * d); }
      else { blur = Math.min(0.035, 0.03 * -d); op = Math.max(0.42, 1 + 0.34 * d); }
      blur *= 1 - t;
      op = lerp(op, 1, t);
      put(el, "filter", blur > 0.002 ? `blur(${blur.toFixed(3)}em)` : "none");
      put(el, "opacity", op.toFixed(3));
      el.classList.toggle("is-focus", Math.abs(d) < 0.5);
    });

    // When the stanza is taller than its window (phones, short laptops), glide it so the focus sits a bit above centre.
    if (overflow > 0) {
      const c = lerp(lerp(centers[k], centers[k + 1], x), centers[N], t);
      const y = clamp(availH * 0.45 - c, -overflow, 0);
      put(stanza, "transform", `translate3d(0, ${y.toFixed(1)}px, 0)`);
      put(copy, "--fade-top", `${Math.min(availH * 0.2, 88, -y).toFixed(1)}px`);
      put(copy, "--fade-bot", `${Math.min(availH * 0.16, 64, overflow + y).toFixed(1)}px`);
    } else {
      put(stanza, "transform", "none");
    }

    put(cta, "opacity", t.toFixed(3));
    put(cta, "transform", `translateY(${((1 - t) * 10).toFixed(1)}px)`);
    put(cta, "pointer-events", t > 0.5 ? "auto" : "none");
    put(cue, "opacity", (1 - smooth(0, 0.3, p)).toFixed(3));

    // Lens: a focus pull. Defocus, swap specimens while they're soft, refocus. Lenses breathe slightly as they focus.
    const pull = smooth(0, 0.5, x) * (1 - smooth(0.5, 1, x));
    const mix = smooth(0.4, 0.6, x);
    const a = slideFor(k), b = slideFor(k + 1);
    slides.forEach((s, i) => put(s, "opacity", (i === a ? 1 - mix : i === b ? mix : 0).toFixed(3)));
    put(optics, "filter", pull > 0.002 ? `blur(${(MAX_PULL * pull).toFixed(2)}px)` : "none");
    put(optics, "transform", `scale(${(1 + 0.045 * pull).toFixed(4)})`);

    // The trail around the rim. It closes when the page sets.
    put(arc, "stroke-dashoffset", (100 * (1 - p / (N - 1))).toFixed(2));
    beads.forEach((bead, i) => bead.classList.toggle("on", p >= i - 0.12));
    put(lens, "--set", t.toFixed(3));

    // When it sets, the specimen wobbles once, like a jelly settling.
    const isSet = t > 0.985;
    if (isSet && !wasSet) wobbleStart = now;
    wasSet = isSet;
    let wob = 0;
    if (wobbleStart >= 0) {
      const s = (now - wobbleStart) / 1000;
      if (s < 1.3) wob = 0.026 * Math.exp(-s * 5) * Math.sin(s * Math.PI * 2 * 3.1);
      else wobbleStart = -1;
    }
    put(lens, "transform", wob ? `scale(${(1 + wob).toFixed(4)}, ${(1 - wob * 0.85).toFixed(4)})` : "none");

    playVideo((mix < 0.5 ? a : b) === 0);
  }

  let videoBlocked = false;                                // e.g. iOS Low Power Mode: the poster stays, stop asking
  function playVideo(visible) {
    if (!video || videoBlocked) return;
    if (visible && !document.hidden) {
      if (video.paused) video.play().catch((e) => { if (e && e.name === "NotAllowedError") videoBlocked = true; });
    } else if (!video.paused) video.pause();
  }

  // ── Scroll → target → eased focus → frame ──
  let target = 0, p = 0, raf = 0, lastT = 0;
  const readScroll = () => { target = clamp((scrollY - reelTop) / step, 0, N - 1); };
  function frame(now) {
    const dt = Math.min(0.05, (now - lastT) / 1000 || 0.016);
    lastT = now;
    p += (target - p) * (1 - Math.exp(-dt * 14));         // smooths mouse-wheel steps; scroll still owns the timeline
    if (Math.abs(target - p) < 0.0004) p = target;
    render(p, now);
    raf = p !== target || wobbleStart >= 0 ? requestAnimationFrame(frame) : 0;
  }
  function kick() {
    if (!root.classList.contains("js") || raf) return;
    lastT = performance.now();
    raf = requestAnimationFrame(frame);
  }

  addEventListener("scroll", () => { readScroll(); kick(); }, { passive: true });
  addEventListener("resize", () => { if (!root.classList.contains("js")) return; measure(); readScroll(); kick(); });
  document.addEventListener("visibilitychange", () => { if (root.classList.contains("js")) render(p, performance.now()); });

  // Click a soft line to pull focus to it.
  lines.forEach((el, i) => el.addEventListener("click", () => {
    if (!root.classList.contains("js") || el.classList.contains("is-focus")) return;
    if (String(getSelection && getSelection()).trim()) return;   // selecting text is not a request to jump
    scrollTo({ top: reelTop + i * step, behavior: "smooth" });
  }));

  // Tabbing to the CTA before the end jumps to the set state, so focus never lands on something invisible.
  cta.addEventListener("focusin", () => {
    if (root.classList.contains("js") && target < N - 1) scrollTo({ top: reelTop + (N - 1) * step, behavior: "smooth" });
  });

  // ── Motion preference: the reel exists only with full motion ──
  function enable(on) {
    root.classList.toggle("js", on);
    cancelAnimationFrame(raf);
    raf = 0;
    if (!on) { clearStyles(); copy.classList.remove("overflows"); if (video) video.pause(); return; }
    measure();
    readScroll();
    p = target;
    render(p, performance.now());
  }
  reduceMQ.addEventListener("change", () => enable(!reduceMQ.matches));
  enable(!reduceMQ.matches);

  // Fonts and images change line heights; re-measure once they land.
  const remeasure = () => { if (root.classList.contains("js")) { measure(); readScroll(); render(p, performance.now()); } };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);
  addEventListener("load", remeasure);
})();
