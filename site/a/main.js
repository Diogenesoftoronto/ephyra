/* Ephyra landing · main.js (ES module, no dependencies)
   Jelly physics: a small damped-spring solver drives every motion, and every motion maps
   to a product event (BRAND.md §5). Reduced motion disables wobble, travel and video. */

const root = document.documentElement;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const RM = () => reduceMotion.matches;

/* ---------------- spring solver ---------------- */
const PRESETS = {
  wobbly: { stiffness: 180, damping: 14, mass: 1 },
  firm:   { stiffness: 260, damping: 22, mass: 1 },
  gentle: { stiffness: 90,  damping: 12, mass: 1 },
};
const active = new Set();
let rafId = 0, last = 0;
function tick(now) {
  const dt = Math.min(0.032, (now - last) / 1000 || 0.016);
  last = now;
  for (const s of active) s.step(dt);
  if (active.size) rafId = requestAnimationFrame(tick); else rafId = 0;
}
function wake() { if (!rafId) { last = performance.now(); rafId = requestAnimationFrame(tick); } }

class Spring {
  constructor(value, preset = 'wobbly', onUpdate) {
    Object.assign(this, PRESETS[preset] || preset);
    this.value = this.target = value; this.velocity = 0; this.onUpdate = onUpdate; this.onRest = null;
  }
  set(target) { this.target = target; active.add(this); wake(); return this; }
  kick(v) { this.velocity += v; active.add(this); wake(); return this; }
  jump(v) { this.value = this.target = v; this.velocity = 0; this.onUpdate?.(v); return this; }
  step(dt) {
    // semi-implicit Euler, sub-stepped for stability at high stiffness
    const n = 2, h = dt / n;
    for (let i = 0; i < n; i++) {
      const a = (-this.stiffness * (this.value - this.target) - this.damping * this.velocity) / this.mass;
      this.velocity += a * h; this.value += this.velocity * h;
    }
    if (Math.abs(this.velocity) < 0.0015 && Math.abs(this.value - this.target) < 0.0015) {
      this.value = this.target; this.velocity = 0; active.delete(this); this.onUpdate?.(this.value); this.onRest?.(); return;
    }
    this.onUpdate?.(this.value);
  }
}

/* ---------------- theme toggle (system → light → dark) ---------------- */
(() => {
  const btn = document.querySelector('[data-theme-toggle]');
  if (!btn) return;
  const order = ['system', 'light', 'dark'];
  let mode = 'system';
  try { const s = localStorage.getItem('ephyra-theme'); if (order.includes(s)) mode = s; } catch {}
  const apply = () => {
    if (mode === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode);
    root.setAttribute('data-theme-mode', mode);
    btn.setAttribute('aria-label', `Theme: ${mode}. Click to change.`); btn.title = `Theme: ${mode}`;
    try { if (mode === 'system') localStorage.removeItem('ephyra-theme'); else localStorage.setItem('ephyra-theme', mode); } catch {}
  };
  apply();
  btn.addEventListener('click', () => { mode = order[(order.indexOf(mode) + 1) % order.length]; apply(); });
})();

/* ---------------- asset swaps: fallbacks stay until the real file loads ---------------- */
(() => {
  for (const host of document.querySelectorAll('[data-swap-img]')) {
    const img = host.querySelector(':scope > img');
    if (!img) continue;
    const ok = () => host.classList.add('has-img');
    if (img.complete && img.naturalWidth > 0) ok();
    img.addEventListener('load', ok, { once: true });
    img.addEventListener('error', () => { img.removeAttribute('src'); img.setAttribute('aria-hidden', 'true'); }, { once: true });
  }
  // Videos: never block LCP (preload=none). Load when near, play only if the file exists and motion is allowed.
  const videos = [...document.querySelectorAll('video[data-video]')];
  if (RM() || !videos.length) return;
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target, host = v.closest('[data-swap-img]') || v.parentElement;
      if (e.isIntersecting) {
        if (!v.dataset.armed) {
          v.dataset.armed = '1'; v.preload = 'auto';
          v.addEventListener('canplay', () => { host.classList.add('has-video'); v.play().catch(() => {}); }, { once: true });
          v.addEventListener('error', () => host.classList.remove('has-video'), { once: true });
          const srcs = v.querySelectorAll('source');
          srcs[srcs.length - 1]?.addEventListener('error', () => { host.classList.remove('has-video'); v.removeAttribute('poster'); }, { once: true });
          v.load();
        } else if (host.classList.contains('has-video')) v.play().catch(() => {});
      } else if (!v.paused) v.pause();
    }
  }, { rootMargin: '200px 0px' });
  videos.forEach(v => io.observe(v));
  document.addEventListener('visibilitychange', () => {
    videos.forEach(v => document.hidden ? v.pause() : (v.closest('.has-video') && v.play().catch(() => {})));
  });
})();

/* ---------------- icon sprite: swap inline fallbacks for ../assets/icons/sprite.svg ---------------- */
(async () => {
  try {
    const res = await fetch('../assets/icons/sprite.svg', { cache: 'force-cache' });
    if (!res.ok) return;
    const text = await res.text();
    if (!text.includes('<symbol')) return;
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return;
    const svg = doc.documentElement;
    const ids = new Set([...svg.querySelectorAll('symbol[id]')].map(s => s.id));
    svg.setAttribute('class', 'sr-defs'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    document.body.prepend(document.adoptNode(svg));
    for (const u of document.querySelectorAll('use[data-icon]')) {
      const id = `i-${u.dataset.icon}`;
      if (ids.has(id)) u.setAttribute('href', `#${id}`);
    }
  } catch { /* fallback symbols stay */ }
})();

/* ---------------- elastic display type: Anybody wdth springs 135 → 112 ---------------- */
(() => {
  const heads = document.querySelectorAll('[data-elastic]');
  if (!heads.length) return;
  if (RM()) { heads.forEach(h => h.style.setProperty('--wdth', '112')); return; }
  const fontsReady = document.fonts?.ready || Promise.resolve();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const h = e.target;
      const words = h.querySelectorAll('.w');
      const targets = words.length ? [...words] : [h];
      fontsReady.then(() => {
        targets.forEach((el, i) => {
          const s = new Spring(135, 'wobbly', v => el.style.setProperty('--wdth', v.toFixed(2)));
          el.__wdth = s;
          setTimeout(() => s.set(112), 80 + i * 70);
        });
        if (!words.length) h.__wdth = targets[0].__wdth;
      });
      // hover re-stretch: the type is still soft
      h.addEventListener('pointerenter', () => {
        const list = words.length ? [...words] : [h];
        list.forEach((el, i) => setTimeout(() => el.__wdth?.kick(90), i * 40));
      });
    }
  }, { threshold: 0.2 });
  heads.forEach(h => { h.style.setProperty('--wdth', '135'); io.observe(h); });
})();

/* ---------------- squash (press) and jiggle (hover): volume-preserving ---------------- */
(() => {
  if (RM()) return;
  const bind = (el, preset) => {
    const s = new Spring(1, preset, v => {
      const sx = Math.max(0.5, v);
      el.style.setProperty('--sx', sx.toFixed(4)); el.style.setProperty('--sy', (1 / sx).toFixed(4));
    });
    return s;
  };
  for (const el of document.querySelectorAll('[data-squash]')) {
    const s = bind(el, 'firm');
    const down = () => s.set(1.06), up = () => s.set(1);
    el.addEventListener('pointerdown', down); el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', up); el.addEventListener('pointercancel', up);
    el.addEventListener('keydown', e => { if (e.key === ' ' || e.key === 'Enter') down(); });
    el.addEventListener('keyup', up);
  }
  for (const el of document.querySelectorAll('[data-jiggle]')) {
    const s = bind(el, 'wobbly');
    el.addEventListener('pointerenter', () => { if (s.velocity === 0) s.kick(0.9); });
  }
})();

/* ---------------- devenv up copy-chip ---------------- */
(() => {
  const chip = document.querySelector('[data-copy]');
  if (!chip) return;
  chip.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(chip.dataset.copy); chip.classList.add('is-copied'); setTimeout(() => chip.classList.remove('is-copied'), 1800); } catch {}
  });
})();

/* ---------------- the loop: scroll-linked signal → trail → proof → set ---------------- */
(() => {
  const section = document.querySelector('.loop');
  const stage = section?.querySelector('[data-loop-stage]');
  if (!stage) return;
  const path = stage.querySelector('[data-trail-path]');
  const blob = stage.querySelector('[data-blob]');
  const body = stage.querySelector('[data-blob-body]');
  const drops = [...stage.querySelectorAll('[data-drop]')];
  const beads = Object.fromEntries([...stage.querySelectorAll('[data-bead]')].map(b => [b.dataset.bead, b]));
  const caption = stage.querySelector('[data-loop-caption]');
  const steps = [...section.querySelectorAll('[data-step]')];
  const L = path.getTotalLength();
  const captions = [
    'A production error arrives as a signal.',
    'Two more signals share the root cause. They merge into one.',
    'The trail gathers evidence and travels: hypothesis at A, plan at B.',
    'Proof passes at C. The wobble decays. It sets, and goes on watch.',
  ];
  // springs
  const spDrop = drops.map(() => new Spring(0, 'wobbly'));
  const spMerge = new Spring(0, 'gentle');     // 0 = spread, 1 = fused
  const spTravel = new Spring(0, 'gentle');    // 0..1 along path
  const spWobble = new Spring(0, 'wobbly');    // squash amplitude
  const spBlob = new Spring(0, 'firm');        // blob opacity
  let setDone = false;

  const DROP_HOME = [[70, 300], [30, 330], [95, 345]];
  function render() {
    // droplets
    drops.forEach((d, i) => {
      const r = Math.max(0, spDrop[i].value);
      const m = spMerge.value;
      d.setAttribute('r', Math.max(0, r * (i === 0 ? 1 + m * 0.6 : 1 - m)).toFixed(2));
      d.setAttribute('cx', (DROP_HOME[i][0] + (DROP_HOME[0][0] - DROP_HOME[i][0]) * m).toFixed(2));
      d.setAttribute('cy', (DROP_HOME[i][1] + (DROP_HOME[0][1] - DROP_HOME[i][1]) * m).toFixed(2));
    });
    // trail blob along the path
    const t = Math.min(1, Math.max(0, spTravel.value));
    const p = path.getPointAtLength(t * L);
    const w = spWobble.value;
    const sx = 1 + w, sy = 1 / sx;
    blob.setAttribute('transform', `translate(${p.x.toFixed(2)} ${p.y.toFixed(2)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)})`);
    blob.setAttribute('opacity', spBlob.value.toFixed(3));
    path.setAttribute('stroke-dashoffset', (1 - t).toFixed(4));
    beads.A.classList.toggle('is-lit', t > 0.33); beads.B.classList.toggle('is-lit', t > 0.66); beads.C.classList.toggle('is-lit', t >= 0.985);
    // the signal droplet dims as it becomes the trail
    drops[0].setAttribute('fill-opacity', (1 - spBlob.value * 0.85).toFixed(3));
  }
  [...spDrop, spMerge, spTravel, spWobble, spBlob].forEach(s => s.onUpdate = render);

  let current = -1;
  function go(step, instant) {
    if (step === current) return;
    current = step;
    steps.forEach((li, i) => li.classList.toggle('is-active', i === step));
    if (caption) caption.textContent = captions[step];
    stage.setAttribute('data-phase', String(step));
    const S = (s, v) => instant ? s.jump(v) : s.set(v);
    // phase 0: one droplet
    S(spDrop[0], step >= 0 ? 11 : 0);
    if (!instant && step === 0) spDrop[0].kick(60);
    // phase 1: two more droplets appear and merge (dedupe)
    S(spDrop[1], step >= 1 ? 8 : 0); S(spDrop[2], step >= 1 ? 6 : 0);
    if (step >= 1) setTimeout(() => S(spMerge, 1), instant ? 0 : 700); else S(spMerge, 0);
    // phase 2: the trail starts and travels to B
    S(spBlob, step >= 2 ? 1 : 0);
    S(spTravel, step >= 3 ? 1 : step >= 2 ? 0.66 : 0);
    // phase 3: proof; wobble decays to stillness ("set")
    blob.classList.toggle('is-set', step >= 3);
    if (step >= 3 && !instant) { setDone = false; spWobble.kick(1.4); setTimeout(() => { spWobble.set(0); }, 50); }
    else S(spWobble, 0);
  }

  // scroll-link: which step is nearest the middle of the viewport
  if (RM()) {
    // reduced motion: snap states, no travel
    const io = new IntersectionObserver(es => { es.forEach(e => { if (e.isIntersecting) go(steps.indexOf(e.target), true); }); }, { rootMargin: '-45% 0px -45% 0px' });
    steps.forEach(s => io.observe(s)); go(0, true); return;
  }
  const sticky = section.querySelector('.loop-sticky');
  const pick = () => {
    // the reading zone is the viewport below the sticky stage (all of it on wide screens, where the stage sits beside the steps)
    const sb = sticky.getBoundingClientRect();
    const wide = innerWidth >= 1024;
    const top = wide ? 0 : Math.max(0, sb.bottom);
    const mid = top + (innerHeight - top) * 0.5;
    let best = 0, bestD = Infinity;
    steps.forEach((li, i) => { const r = li.getBoundingClientRect(); const c = (r.top + r.bottom) / 2; const d = Math.abs(c - mid); if (d < bestD) { bestD = d; best = i; } });
    const first = steps[0].getBoundingClientRect();
    if (first.top > innerHeight * 0.9) best = 0;
    go(best);
  };
  let armed = false;
  const vis = new IntersectionObserver(es => {
    es.forEach(e => {
      if (e.isIntersecting && !armed) { armed = true; addEventListener('scroll', pick, { passive: true }); pick(); }
      else if (!e.isIntersecting && armed) { armed = false; removeEventListener('scroll', pick); }
    });
  });
  vis.observe(section);
  go(0, true);
})();

/* ---------------- inbox demo: a/r/x/t/o are firm presses ---------------- */
(() => {
  const box = document.querySelector('[data-inbox]');
  if (!box) return;
  const items = [...box.querySelectorAll('[data-inbox-item]')];
  const log = box.querySelector('[data-inbox-log]');
  const count = box.querySelector('[data-inbox-count]');
  let cur = 0;
  const springs = items.map(li => RM() ? null : new Spring(1, 'firm', v => { li.style.setProperty('--sx', v.toFixed(4)); li.style.setProperty('--sy', (1 / v).toFixed(4)); }));
  const press = i => { const s = springs[i]; if (!s) return; s.jump(1.06); s.set(1); };
  const refresh = () => {
    items.forEach((li, i) => li.classList.toggle('is-current', i === cur));
    const open = items.filter(li => !li.classList.contains('is-done') && !li.classList.contains('is-rejected')).length;
    if (count) count.textContent = open ? `${open} waiting` : 'inbox clear';
  };
  const titles = items.map(li => li.querySelector('.title')?.textContent.split(' ')[0] || 'trail');
  const act = key => {
    const li = items[cur]; const id = titles[cur];
    switch (key) {
      case 'j': cur = Math.min(items.length - 1, cur + 1); log.textContent = `Moved to ${titles[cur]}.`; break;
      case 'k': cur = Math.max(0, cur - 1); log.textContent = `Moved to ${titles[cur]}.`; break;
      case 'a': press(cur); li.classList.remove('is-rejected'); li.classList.add('is-done');
        log.textContent = li.querySelector('.sev')?.textContent === 'spend'
          ? `${id}: spend approved. The real-respondent study starts; results land in the proof bundle.`
          : `${id}: checkpoint approved. The trail lands through its landing mode and goes on watch.`; break;
      case 'r': press(cur); log.textContent = `${id}: revision requested. The trail returns to the producing state with your note as a constraint.`; break;
      case 'x': press(cur); li.classList.remove('is-done'); li.classList.add('is-rejected'); log.textContent = `${id}: killed. Reason recorded; the fingerprint stays in regression memory.`; break;
      case 't': press(cur); log.textContent = `${id}: claimed. The agent stops, the worktree and evidence are yours. Release it to hand back.`; break;
      case 'o': press(cur); log.textContent = `${id}: would open the landing: a devenv portal, the patch, the pull, or the stack in ISL.`; break;
      default: return;
    }
    refresh();
  };
  box.querySelectorAll('[data-key]').forEach(b => b.addEventListener('click', () => act(b.dataset.key)));
  box.tabIndex = 0;
  box.addEventListener('keydown', e => {
    if (e.target.closest('button') && (e.key === ' ' || e.key === 'Enter')) return;
    if ('jkarxto'.includes(e.key) && e.key.length === 1) { e.preventDefault(); act(e.key); }
  });
  refresh();
})();

/* ---------------- current section in nav ---------------- */
(() => {
  const links = [...document.querySelectorAll('.site-nav a')];
  if (!links.length) return;
  const map = new Map(links.map(a => [a.getAttribute('href').slice(1), a]));
  const io = new IntersectionObserver(es => {
    es.forEach(e => { if (e.isIntersecting) { links.forEach(a => a.removeAttribute('aria-current')); map.get(e.target.id)?.setAttribute('aria-current', 'true'); } });
  }, { rootMargin: '-40% 0px -55% 0px' });
  map.forEach((a, id) => { const s = document.getElementById(id); if (s) io.observe(s); });
})();

/* ---------------- gel canvas: the one canvas. Backlit honey, paused offscreen ---------------- */
(() => {
  const canvas = document.querySelector('[data-gel]');
  if (!canvas) return;
  const ctx = canvas.getContext('2d', { alpha: true });
  if (!ctx) { canvas.remove(); return; }
  const isDark = () => root.getAttribute('data-theme') === 'dark' || (root.getAttribute('data-theme') !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
  let W = 0, H = 0, dpr = 1, running = false, raf = 0, t0 = performance.now();
  const blobs = Array.from({ length: 7 }, (_, i) => ({
    x: 0.45 + Math.cos(i * 2.1) * 0.28, y: 0.5 + Math.sin(i * 1.7) * 0.3,
    r: 0.16 + (i % 3) * 0.06, ph: i * 1.3, sp: 0.12 + (i % 4) * 0.03,
  }));
  const drop = { ph: 0 }; // one mint signal droplet, pulsing once per bell
  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(1.5, devicePixelRatio || 1);
    W = Math.max(1, Math.floor(rect.width * dpr / 2)); H = Math.max(1, Math.floor(rect.height * dpr / 2)); // half-res, blurred anyway
    canvas.width = W; canvas.height = H;
  }
  function frame(now) {
    const t = (now - t0) / 1000;
    const dark = isDark();
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = `blur(${Math.round(Math.min(W, H) * 0.09)}px)`;
    for (const b of blobs) {
      const x = (b.x + Math.sin(t * b.sp + b.ph) * 0.06) * W;
      const y = (b.y + Math.cos(t * b.sp * 0.8 + b.ph) * 0.07) * H;
      const r = b.r * Math.max(W, H) * (1 + 0.05 * Math.sin(t * 0.9 + b.ph));
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, dark ? 'oklch(0.72 0.16 68 / 0.55)' : 'oklch(0.8 0.16 72 / 0.55)');
      g.addColorStop(1, 'oklch(0.74 0.162 68 / 0)');
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill();
    }
    // mint signal droplet: bell rhythm, contract 0.35 s, relax 1.1 s, rest 0.6 s
    const cyc = (t % 2.05);
    const pulse = cyc < 0.35 ? cyc / 0.35 : cyc < 1.45 ? 1 - (cyc - 0.35) / 1.1 : 0;
    const dx = W * 0.72, dy = H * 0.42, dr = Math.min(W, H) * (0.05 + 0.03 * pulse);
    ctx.filter = `blur(${Math.round(Math.min(W, H) * 0.02)}px)`;
    const mg = ctx.createRadialGradient(dx, dy, 0, dx, dy, dr);
    mg.addColorStop(0, dark ? `oklch(0.86 0.13 178 / ${0.35 + 0.35 * pulse})` : `oklch(0.7 0.12 180 / ${0.25 + 0.3 * pulse})`);
    mg.addColorStop(1, 'oklch(0.62 0.11 180 / 0)');
    ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(dx, dy, dr, 0, Math.PI * 2); ctx.fill();
    ctx.filter = 'none';
    if (running) raf = requestAnimationFrame(frame);
  }
  function start() { if (running || RM()) return; running = true; raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); raf = 0; }
  resize(); frame(performance.now()); // one static frame always (reduced motion keeps just this)
  if (!RM()) {
    const io = new IntersectionObserver(es => es.forEach(e => e.isIntersecting && !document.hidden ? start() : stop()));
    io.observe(canvas);
    document.addEventListener('visibilitychange', () => document.hidden ? stop() : (canvas.getBoundingClientRect().bottom > 0 && start()));
    let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { resize(); if (!running) frame(performance.now()); }, 120); });
  }
  new MutationObserver(() => { if (!running) frame(performance.now()); }).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
})();
