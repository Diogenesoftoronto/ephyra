// Ephyra · cut E, below the hero: one example trail, start to finish, in the real terminal inbox.
// The screens come from walkthrough.json, which apps/cli/scripts/walkthrough.ts renders with the inbox's own view,
// so this page shows what the terminal shows. As each step scrolls into view, the terminal switches to that
// moment, outlines what the step is about and lights up the key it talks about.

(() => {
  const tour = document.querySelector(".tour");
  if (!tour || !window.fetch) return;
  const root = document.documentElement;
  const motion = () => root.classList.contains("motion");
  const steps = [...tour.querySelectorAll(".step")];
  const term = tour.querySelector(".term");
  const screen = tour.querySelector(".term-screen");
  const pre = tour.querySelector(".term-pre");
  const focusBox = tour.querySelector(".term-focus");
  const cmd = tour.querySelector(".term-cmd");
  const count = tour.querySelector(".term-count");
  const bar = document.querySelector(".bar");
  const reel = document.querySelector(".reel");
  const splitMQ = matchMedia("(min-width: 70rem)");

  // What each step is about: the rows from `from` to `to` (matched against the pane's text, or the whole row).
  const FOCUS = {
    triaged: { from: /^triage /, to: /^evidence / },
    hypothesis: { from: /^hypothesis\.md/, to: /^Reproduce with/ },
    explain: { from: /^explain /, to: /^entire / },
    revise: { from: /^ revise T-/, to: /^ revise T-/, whole: true },
    plan: { from: /^✓ repro/, to: /^Not touching/ },
    proof: { from: /^proof  rev/, to: /^✓ review/ },
    watching: { from: /^landed /, to: /^watch / },
    set: { from: /^landed /, to: /^set / },
    rollback: { from: /^landed /, to: /^undone / },
  };
  // The key each step talks about; it lights up in the inbox's hint bar.
  const PRESS = { hypothesis: "a", explain: "e", revise: "r", plan: "a", proof: "a" };

  let data = null;
  let current = -1;
  let size = "wide";
  let fs = 13;
  let chRatio = 0.6;
  const cache = new Map();

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  // Anything outside ASCII and box drawing gets its own one-column cell, so a fallback glyph can't shift the grid.
  const cells = (s) => esc(s).replace(/[^\x00-\x7f─-╿]/gu, (ch) => `<i>${ch}</i>`);
  const rowText = (row) => row.map((seg) => seg[0]).join("");

  function frameOf(step) {
    const s = data.steps.find((x) => x.id === step.dataset.step);
    return s ? { step: s, rows: s[size] } : null;
  }

  function html(id, rows) {
    const key = `${id}:${size}`;
    if (!cache.has(key)) {
      cache.set(key, rows.map((row) => `<span class="r">${row.map(([text, tone, bold]) =>
        `<span class="t-${tone}${bold ? " b" : ""}">${cells(text)}</span>`).join("")}</span>`).join(""));
    }
    return cache.get(key);
  }

  /** Which columns hold the pane a step is about: the inbox's right box, its lower box on phones, or everything. */
  function pane(rows) {
    const r1 = rowText(rows[1] ?? []);
    const first = r1.indexOf("┌");
    const second = r1.indexOf("┌", first + 1);
    const cols = Array.from(rowText(rows[0] ?? [])).length;
    if (first === 0 && second > 0) return { x0: second + 1, x1: cols - 1, cols };
    if (first === 0) return { x0: 1, x1: cols - 1, cols };
    return { x0: 0, x1: cols, cols };
  }

  function focusRows(id, rows, p) {
    const f = FOCUS[id];
    if (!f) return null;
    const text = (i) => {
      const t = Array.from(rowText(rows[i]));
      return f.whole ? t.join("") : t.slice(p.x0, p.x1).join("");
    };
    let i0 = -1;
    for (let i = 0; i < rows.length; i++) if (f.from.test(text(i))) { i0 = i; break; }
    if (i0 < 0) return null;
    let i1 = i0;
    for (let i = i0; i < rows.length; i++) if (f.to.test(text(i))) { i1 = i; break; }
    i1 = Math.min(rows.length - 1, i1 + (f.extra ?? 0));
    // A block ends at a blank line: take the rest of a wrapped paragraph or an evidence hit with it.
    if (!f.whole) while (i1 + 1 < rows.length && text(i1 + 1).trim()) i1++;
    return { i0, i1, x0: f.whole ? 0 : p.x0, x1: f.whole ? p.cols : p.x1 };
  }

  function measure() {
    const probe = document.createElement("span");
    probe.textContent = "0".repeat(100);
    probe.style.cssText = `position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;font-size:100px;font-family:${getComputedStyle(pre).fontFamily}`;
    document.body.appendChild(probe);
    chRatio = probe.getBoundingClientRect().width / 100 / 100 || 0.6;
    probe.remove();
  }

  /** Pick the frame size and the font size that fit the terminal's width. */
  function fit() {
    const inner = screen.clientWidth - parseFloat(getComputedStyle(screen).paddingLeft) - parseFloat(getComputedStyle(screen).paddingRight);
    const wideFs = inner / (data.cols * chRatio);
    size = wideFs >= 9.5 ? "wide" : "narrow";
    const cols = size === "wide" ? data.cols : data.narrowCols;
    fs = Math.max(8, Math.min(size === "wide" ? 15.5 : 14, Math.floor((inner / (cols * chRatio)) * 10) / 10));
    pre.style.fontSize = `${fs}px`;
  }

  function show(k, force = false) {
    if (!data || (k === current && !force)) return;
    const changed = k !== current;
    current = k;
    steps.forEach((s, i) => {
      s.classList.toggle("is-on", i === k);
      s.classList.toggle("is-past", i < k);
    });
    const el = steps[k];
    const got = frameOf(el);
    if (!got) return;
    const { step, rows } = got;
    pre.innerHTML = html(step.id, rows);
    if (changed && motion()) {
      pre.classList.remove("term-swap");
      void pre.offsetWidth;
      pre.classList.add("term-swap");
    }
    cmd.textContent = step.command;
    count.innerHTML = `<b>${String(k + 1).padStart(2, "0")}</b> / ${String(steps.length).padStart(2, "0")}`;
    term.setAttribute("aria-label", `Terminal, step ${k + 1} of ${steps.length}: ${el.querySelector("h3")?.textContent ?? ""}`);

    // Light up the key this step talks about, in the inbox's hint bar (its last row).
    const press = PRESS[step.id];
    const lines = pre.children;
    if (press && lines.length) {
      const hint = lines[lines.length - 1];
      for (const span of hint.querySelectorAll(".t-key")) if (span.textContent === press) span.classList.add("press");
    }

    // Outline what the step is about, dim the rest, and on narrow screens pan the window to it.
    const lineH = fs * 1.32;
    const chW = fs * chRatio;
    const p = pane(rows);
    const f = focusRows(step.id, rows, p);
    const padL = parseFloat(getComputedStyle(screen).paddingLeft);
    const padT = parseFloat(getComputedStyle(screen).paddingTop);
    let offset = 0;
    if (!splitMQ.matches) {
      const visible = Math.max(8, Math.min(rows.length, Math.floor((innerHeight - bar.offsetHeight) * 0.42 / lineH)));
      screen.style.height = `${(visible * lineH + padT + 12).toFixed(1)}px`;
      if (f) offset = Math.max(0, Math.min(rows.length - visible, Math.round((f.i0 + f.i1) / 2 - visible / 2)));
    } else screen.style.height = "";
    pre.style.transform = offset ? `translateY(${(-offset * lineH).toFixed(1)}px)` : "none";
    if (f) {
      for (let i = 0; i < lines.length; i++) lines[i].classList.toggle("dim", i < f.i0 || i > f.i1);
      focusBox.style.left = `${(padL + f.x0 * chW - 3).toFixed(1)}px`;
      focusBox.style.top = `${(padT + (f.i0 - offset) * lineH - 3).toFixed(1)}px`;
      focusBox.style.width = `${((f.x1 - f.x0) * chW + 5).toFixed(1)}px`;
      focusBox.style.height = `${((f.i1 - f.i0 + 1) * lineH + 6).toFixed(1)}px`;
      focusBox.classList.add("on");
    } else focusBox.classList.remove("on");
  }

  /** The step whose top has crossed the reading line: mid-screen on wide layouts, below the terminal otherwise. */
  function active() {
    let line = innerHeight * 0.5;
    if (!splitMQ.matches) {
      const bottom = term.getBoundingClientRect().bottom;
      line = bottom + (innerHeight - bottom) * 0.32;
    }
    let k = 0;
    steps.forEach((s, i) => {
      if (s.getBoundingClientRect().top <= line) k = i;
    });
    return k;
  }

  let raf = 0;
  const onScroll = () => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (bar && reel) bar.classList.toggle("solid", reel.getBoundingClientRect().bottom <= bar.offsetHeight + 1);
      if (data) show(active());
    });
  };
  addEventListener("scroll", onScroll, { passive: true });

  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (!data) return;
      const before = size;
      fit();
      if (before !== size) cache.clear();
      show(active(), true);
    });
  };
  addEventListener("resize", onResize);
  splitMQ.addEventListener("change", onResize);

  // In-page links. The served home page has <base href="/e/">, which would send "#how" to /e/#how and reload;
  // scroll instead, and put the fragment on the URL the reader is actually on.
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = document.getElementById(a.getAttribute("href").slice(1));
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: motion() ? "smooth" : "auto", block: "start" });
    history.replaceState(null, "", `${location.pathname}${location.search}#${target.id}`);
  });

  // Clicking a step jumps to it.
  steps.forEach((s, i) => s.addEventListener("click", (e) => {
    if (!data || i === current || e.target.closest("a")) return;
    const line = splitMQ.matches ? innerHeight * 0.5 : term.getBoundingClientRect().bottom + 40;
    scrollTo({ top: scrollY + s.getBoundingClientRect().top - line + 8, behavior: motion() ? "smooth" : "auto" });
  }));

  function policy() {
    const file = document.querySelector(".file pre");
    if (file && data.autonomy) {
      file.innerHTML = data.autonomy.split("\n").map((line) => {
        if (/^#/.test(line)) return `<span class="md-h">${esc(line)}</span>`;
        const kv = /^([a-z_]+):(\s*)(.*)$/.exec(line);
        if (kv) return `<span class="md-k">${esc(kv[1])}:</span>${kv[2]}<span class="md-v">${esc(kv[3])}</span>`;
        return line ? `<span class="md-p">${esc(line)}</span>` : "";
      }).join("\n");
    }
    const dl = document.querySelector(".keys dl");
    if (dl && Array.isArray(data.keys)) {
      dl.innerHTML = data.keys.map(([k, v]) =>
        `<dt>${k.split(" ").map((x) => `<kbd>${esc(x)}</kbd>`).join("")}</dt><dd>${esc(v)}</dd>`).join("");
    }
  }

  fetch("walkthrough.json", { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      data = d;
      for (const [k, v] of Object.entries(d.palette ?? {})) term.style.setProperty(`--t-${k}`, v);
      tour.classList.add("live");
      measure();
      fit();
      show(active(), true);
      policy();
      // Fonts can change the column width; measure again once they've loaded.
      if (document.fonts?.ready) document.fonts.ready.then(() => { measure(); onResize(); });
    })
    .catch(() => {
      // Without the screens the steps still read on their own; the terminal just stays hidden.
      tour.classList.remove("live");
    });
})();
