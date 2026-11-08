import { renderConsole, setupConsoleSelector } from "./console.js";
import { createDemoRoom } from "./multiplayer.js";
import { showProductScreen } from "./product-tour.js";

// Ephyra · cut E, below the hero: one example trail, start to finish, in the real terminal inbox.
// The screens come from walkthrough.json, which apps/cli/scripts/walkthrough.ts renders with the inbox's own view,
// so this page shows what the terminal shows. As each step scrolls into view, the terminal switches to that
// moment, outlines what the step is about and lights up the key it talks about.

(() => {
  const tour = document.querySelector(".tour");
  if (!tour || !window.fetch) return;
  const root = document.documentElement;
  const tuiPanel = document.getElementById("tui-panel");
  const guiPanel = document.getElementById("gui-panel");
  let view = "gui";
  let guiTool = "review";
  const viewingTerminal = () => view === "tui";
  const switchHeight = () => tour.querySelector(".console-switch")?.offsetHeight ?? 0;
  const motion = () => root.classList.contains("motion");
  const steps = [...tour.querySelectorAll(".step")];
  const term = tour.querySelector(".term");
  const screen = tour.querySelector(".term-screen");
  const pre = tour.querySelector(".term-pre");
  const focusBox = tour.querySelector(".term-focus");
  const cmd = tour.querySelector(".term-cmd");
  const count = tour.querySelector(".term-count");
  const prev = tour.querySelector(".term-prev");
  const next = tour.querySelector(".term-next");
  const strip = tour.querySelector(".term-strip");
  const reader = document.querySelector(".screen-dialog");
  const readerContent = reader.querySelector(".screen-content");
  const readerPre = reader.querySelector("pre");
  let readerStep = 0;
  const bar = document.querySelector(".bar");
  const reel = document.querySelector(".reel");
  const splitMQ = matchMedia("(min-width: 70rem)");
  const compactMQ = matchMedia("(max-width: 69.99rem) and (max-height: 700px)");

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
  const room = createDemoRoom();
  const drafts = new Map();

  function rememberDraft() {
    const field = guiPanel.querySelector("[data-room-draft]");
    if (field) drafts.set(field.dataset.roomDraft, field.value);
  }

  function guiOptions(id, extra = {}) {
    const trailId = data.gui.moments[id].trail.id;
    return { tool: guiTool, room: room.getSnapshot(trailId), draft: drafts.get(trailId) ?? "", ...extra };
  }

  function renderGui(id, preserve = false) {
    showProductScreen(guiPanel, id);
  }

  // Remote updates replace only discussion output. Keep the live form node, draft, selection, and caret intact.
  function refreshRoomSurface(container, id, isReader = false) {
    const workspace = container.querySelector(".g-workspace");
    if (!workspace) return;
    const template = document.createElement("template");
    template.innerHTML = renderConsole(id, data, guiOptions(id, { reader: isReader, tool: workspace.dataset.guiTool }));
    const oldRoom = container.querySelector(".g-room");
    const nextRoom = template.content.querySelector(".g-room");
    const scroll = container.querySelector(".g-scroll");
    const scrollTop = scroll?.scrollTop ?? 0;
    const focusedControl = oldRoom?.contains(document.activeElement) && document.activeElement.matches("[data-room-action]");
    if (oldRoom && nextRoom) {
      for (const selector of [".g-section-head", ".g-room-scope", ".g-room-storage", ".g-room-control", ".g-room-messages", ".g-room-empty"]) {
        const existing = oldRoom.querySelector(selector);
        const replacement = nextRoom.querySelector(selector);
        if (existing && replacement) existing.replaceWith(replacement);
        else if (existing) existing.remove();
        else if (replacement) oldRoom.insertBefore(replacement, oldRoom.querySelector(".g-room-form, .g-room-update"));
      }
      if (focusedControl) oldRoom.querySelector("[data-room-action]")?.focus({ preventScroll: true });
      oldRoom.querySelector(".g-room-update").textContent = "Local discussion updated.";
    }
    const oldPreview = container.querySelector(".g-room-preview");
    const nextPreview = template.content.querySelector(".g-room-preview");
    if (oldPreview && nextPreview) {
      const focused = oldPreview.contains(document.activeElement);
      oldPreview.replaceWith(nextPreview);
      if (focused) nextPreview.querySelector("button")?.focus({ preventScroll: true });
    }
    if (scroll) scroll.scrollTop = scrollTop;
  }

  room.subscribe((trailId) => {
    if (!data || current < 0) return;
    const id = steps[current].dataset.step;
    if (data.gui.moments[id].trail.id === trailId) refreshRoomSurface(guiPanel, id);
    if (reader.open && reader.classList.contains("gui-reading")) {
      const readId = steps[readerStep].dataset.step;
      if (data.gui.moments[readId].trail.id === trailId) {
        const top = readerContent.scrollTop;
        refreshRoomSurface(reader.querySelector(".gui-reader"), readId, true);
        readerContent.scrollTop = top;
      }
    }
  });
  addEventListener("pagehide", (event) => { if (!event.persisted) room.close(); });

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  // Anything outside ASCII and box drawing gets its own one-column cell, so a fallback glyph can't shift the grid.
  const cells = (s) => esc(s).replace(/[^\x00-\x7f─-╿]/gu, (ch) => `<i>${ch}</i>`);
  const rowText = (row) => row.map((seg) => seg[0]).join("");

  function frameOf(step) {
    const s = data.steps.find((x) => x.id === step.dataset.step);
    return s ? { step: s, rows: s[size] } : null;
  }

  function html(id, rows, variant = size) {
    const key = `${id}:${variant}`;
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
    if (!viewingTerminal()) return;
    const inner = screen.clientWidth - parseFloat(getComputedStyle(screen).paddingLeft) - parseFloat(getComputedStyle(screen).paddingRight);
    const wideFs = inner / (data.cols * chRatio);
    size = wideFs >= 12.5 ? "wide" : "narrow";
    const cols = size === "wide" ? data.cols : data.narrowCols;
    // At the smallest widths keep readable type and allow horizontal scrolling.
    fs = Math.max(13, Math.min(size === "wide" ? 15.5 : 14, Math.floor((inner / (cols * chRatio)) * 10) / 10));
    pre.style.fontSize = `${fs}px`;
  }

  function show(k, force = false) {
    if (!data || k < 0 || k >= steps.length || (k === current && !force)) return;
    const changed = k !== current;
    if (changed) guiTool = steps[k].dataset.step === "explain" ? "evidence" : "review";
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
    screen.setAttribute("aria-label", `Terminal, step ${k + 1} of ${steps.length}: ${el.querySelector("h3")?.textContent ?? ""}. Use Read the full screen for the text.`);
    const focused = document.activeElement;
    prev.disabled = k === 0;
    next.disabled = k === steps.length - 1;
    if (focused === prev && prev.disabled) next.focus({ preventScroll: true });
    if (focused === next && next.disabled) prev.focus({ preventScroll: true });
    steps.forEach((s, i) => {
      if (i === k) s.setAttribute("aria-current", "step");
      else s.removeAttribute("aria-current");
    });

    tour.querySelector(".tag-long").textContent = viewingTerminal() ? "Sample data · real CLI output" : "Sample data · guided console";
    tour.querySelector(".term-read").textContent = viewingTerminal() ? "Read the full screen" : "Read full details";
    if (!viewingTerminal()) {
      cmd.textContent = "ephyra / " + data.gui.moments[step.id].trail.short;
      strip.hidden = true;
      renderGui(step.id, !changed);
      return;
    }

    // Use the real wide hint row, grouped by key so it can wrap without losing a label.
    // It stays outside the panning window, and never inherits the context rows' dimming.
    hints(step);
    const lines = pre.children;
    if (step.command === "ephyra inbox") lines[lines.length - 1].style.visibility = "hidden";

    // Outline what the step is about, dim the rest, and on narrow screens pan the window to it.
    const lineH = fs * 1.32;
    const chW = fs * chRatio;
    const p = pane(rows);
    const f = focusRows(step.id, rows, p);
    const padL = parseFloat(getComputedStyle(screen).paddingLeft);
    const padT = parseFloat(getComputedStyle(screen).paddingTop);
    let offset = 0;
    const available = Math.max(120, innerHeight - bar.offsetHeight - switchHeight() - 160);
    const budget = splitMQ.matches ? available : Math.min(available, (innerHeight - bar.offsetHeight - switchHeight()) * 0.43);
    const visible = Math.max(5, Math.min(rows.length, Math.floor(budget / lineH)));
    screen.style.height = `${(visible * lineH + padT + 12).toFixed(1)}px`;
    if (f) offset = Math.max(0, Math.min(rows.length - visible, Math.floor((f.i0 + f.i1 + 1 - visible) / 2)));
    // Native scrolling makes every row reachable, including on short or zoomed viewports.
    screen.scrollTop = offset * lineH;
    screen.scrollLeft = 0;
    if (f) {
      for (let i = 0; i < lines.length; i++) lines[i].classList.toggle("dim", i < f.i0 || i > f.i1);
      focusBox.style.left = `${(padL + f.x0 * chW - 3).toFixed(1)}px`;
      focusBox.style.top = `${(padT + f.i0 * lineH - 3).toFixed(1)}px`;
      focusBox.style.width = `${((f.x1 - f.x0) * chW + 5).toFixed(1)}px`;
      focusBox.style.height = `${((f.i1 - f.i0 + 1) * lineH + 6).toFixed(1)}px`;
      focusBox.classList.add("on");
    } else focusBox.classList.remove("on");
  }

  function hints(step) {
    strip.replaceChildren();
    strip.hidden = step.command !== "ephyra inbox";
    if (strip.hidden) return;
    const groups = [];
    for (const [text, tone, bold] of step.wide.at(-1)) {
      if (bold && (tone === "key" || tone === "mint")) groups.push({ key: text, tone, label: "" });
      else if (groups.length) groups.at(-1).label += text;
    }
    const visible = size === "narrow" && step.id !== "revise"
      ? groups.filter((g) => ["a", "r", "?", PRESS[step.id]].includes(g.key)) : groups;
    for (const g of visible) {
      const hint = document.createElement("span");
      hint.className = "term-hint";
      const pressed = g.key === PRESS[step.id];
      hint.innerHTML = `<b class="t-${g.tone}${pressed ? " press" : ""}">${esc(g.key)}</b> ${esc(g.label.trim())}`;
      strip.appendChild(hint);
    }
  }

  function readScreen(k) {
    const step = data.steps.find((s) => s.id === steps[k].dataset.step);
    if (!step) return;
    readerStep = k;
    reader.querySelector("h2").textContent = `${k + 1}. ${steps[k].querySelector("h3").textContent}`;
    // Full selectable output, not an image. A narrow frame preserves all proof and activity on phones.
    const graphical = !viewingTerminal();
    reader.classList.toggle("gui-reading", graphical);
    readerPre.hidden = graphical;
    const guiReader = reader.querySelector(".gui-reader");
    guiReader.hidden = !graphical;
    if (graphical) {
      showProductScreen(guiReader, step.id);
      if (!reader.open) reader.showModal();
      readerContent.scrollTop = 0;
      return;
    }
    const variant = innerWidth < 800 ? "narrow" : "wide";
    readerPre.innerHTML = html(step.id, step[variant], variant);
    if (!reader.open) reader.showModal();
    const cols = variant === "wide" ? data.cols : data.narrowCols;
    const available = readerContent.clientWidth - 32;
    readerPre.style.fontSize = `${Math.max(13, Math.min(14, available / (cols * chRatio)))}px`;
    readerContent.scrollTop = 0;
    readerContent.scrollLeft = 0;
  }
  tour.querySelector(".term-read").addEventListener("click", () => { if (data) readScreen(current); });
  reader.addEventListener("click", (e) => { if (e.target === reader) reader.close(); });
  // Native dialog handles Escape, focus containment, and restoring focus to the opener.

  /** The step whose heading has crossed the reading line. */
  function active() {
    if (compactMQ.matches) return Math.max(0, current);
    let line = innerHeight * 0.5;
    if (!splitMQ.matches) {
      const bottom = term.getBoundingClientRect().bottom;
      line = bottom + (innerHeight - bottom) * 0.32;
    }
    let k = 0;
    steps.forEach((s, i) => {
      if (s.querySelector("h3").getBoundingClientRect().top <= line) k = i;
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
      show(current < 0 ? active() : current, true);
      if (reader.open) readScreen(readerStep);
    });
  };
  addEventListener("resize", onResize);
  splitMQ.addEventListener("change", onResize);
  compactMQ.addEventListener("change", onResize);


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

  function go(k) {
    if (!data) return;
    k = Math.max(0, Math.min(steps.length - 1, k));
    guiTool = steps[k].dataset.step === "explain" ? "evidence" : "review";
    show(k, true);
    if (compactMQ.matches) {
      term.scrollIntoView({ block: "start", behavior: "instant" });
      return;
    }
    const line = splitMQ.matches ? innerHeight * 0.5 : bar.offsetHeight + switchHeight() + term.offsetHeight + 32;
    const top = scrollY + steps[k].querySelector("h3").getBoundingClientRect().top - line + 8;
    // An explicit step selection should settle on that step, without intermediate scroll selections.
    scrollTo({ top, behavior: "instant" });
  }
  prev.addEventListener("click", () => go(current - 1));
  next.addEventListener("click", () => go(current + 1));
  tour.addEventListener("keydown", (e) => {
    if (!data || e.target.closest(".console-switch") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey ||
      e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    const k = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: steps.length - 1 }[e.key];
    if (k === undefined) return;
    e.preventDefault();
    go(k);
  });
  steps.forEach((s, i) => s.addEventListener("click", (e) => {
    if (!data || i === current || e.target.closest("a, button") || String(getSelection()).trim()) return;
    go(i);
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
    const dl = document.querySelector(".all-keys dl");
    if (dl && Array.isArray(data.keys)) {
      dl.closest("details").hidden = false;
      dl.innerHTML = data.keys.map(([k, v]) =>
        `<dt>${k.split(" ").map((x) => `<kbd>${esc(x)}</kbd>`).join("")}</dt><dd>${esc(v)}</dd>`).join("");
    }
  }

  // Keep the exact moment when changing interfaces. The navigation and story are shared.
  const originalCopy = new Map(steps.map((step) => [step.dataset.step, step.querySelector("p:last-child").innerHTML]));
  const guiCopy = {
    hypothesis: "The agent writes down what it thinks is wrong, and why. You read a page, not a diff. In checkout, policy waits for a person to approve the cause before code is written.",
    explain: "Open the evidence behind the hypothesis: the error stream, the commit that started it, past trails, and the agent session that wrote that commit.",
    revise: "Ask for changes and leave a note. The agent gets it with the trail and tries again. Here, nothing is built until someone approves.",
  };
  setupConsoleSelector(tour, (nextView) => {
    view = nextView;
    tuiPanel.hidden = !viewingTerminal();
    guiPanel.hidden = viewingTerminal();
    tour.querySelector(".gui-example-note").hidden = viewingTerminal();
    steps.forEach((step) => {
      const p = step.querySelector("p:last-child");
      p.innerHTML = !viewingTerminal() && guiCopy[step.dataset.step] ? guiCopy[step.dataset.step] : originalCopy.get(step.dataset.step);
    });
    if (data) { measure(); fit(); show(current < 0 ? 0 : current, true); }
  });
  guiPanel.addEventListener("click", (e) => {
    const control = e.target.closest("[data-room-action]");
    if (control && data && current >= 0) {
      const trailId = data.gui.moments[steps[current].dataset.step].trail.id;
      const action = control.dataset.roomAction;
      if (action === "claim") room.claim(trailId);
      else if (action === "release") room.release(trailId);
      guiPanel.querySelector("[data-room-action]")?.focus({ preventScroll: true });
      return;
    }
    const tool = e.target.closest("[data-console-tool]");
    if (tool) {
      guiTool = tool.dataset.consoleTool;
      renderGui(steps[current].dataset.step);
      guiPanel.querySelector(`[data-console-tool="${guiTool}"]`).focus({ preventScroll: true });
      return;
    }
    const button = e.target.closest("[data-preview-go]");
    if (!button) return;
    const k = steps.findIndex((step) => step.dataset.step === button.dataset.previewGo);
    if (k < 0) return;
    go(k);
    tour.querySelector(k === steps.length - 1 ? ".term-prev" : ".term-next").focus({ preventScroll: true });
  });
  guiPanel.addEventListener("input", (e) => {
    const field = e.target.closest("[data-room-draft]");
    if (!field) return;
    drafts.set(field.dataset.roomDraft, field.value);
    field.removeAttribute("aria-invalid");
    const feedback = field.closest("form").querySelector(".g-room-feedback");
    feedback.textContent = "";
  });
  guiPanel.addEventListener("submit", (e) => {
    const form = e.target.closest(".g-room-form");
    if (!form) return;
    e.preventDefault();
    const field = form.querySelector("[data-room-draft]");
    const feedback = form.querySelector(".g-room-feedback");
    try {
      room.addComment(form.dataset.roomTrail, field.value);
      drafts.set(form.dataset.roomTrail, "");
      field.value = "";
      field.removeAttribute("aria-invalid");
      feedback.textContent = "Note added in this browser.";
    } catch (error) {
      field.setAttribute("aria-invalid", "true");
      feedback.textContent = error.message;
    }
    field.focus({ preventScroll: true });
  });

  fetch("walkthrough.json", { credentials: "omit" })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then((d) => {
      data = d;
      for (const [k, v] of Object.entries(d.palette ?? {})) {
        term.style.setProperty(`--t-${k}`, v);
        reader.style.setProperty(`--t-${k}`, v);
      }
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
