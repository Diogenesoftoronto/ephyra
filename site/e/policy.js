// Ephyra · cut E, the policy board: the sample ephyra/autonomy.md as the interface that edits it.
// Map shows one row per area with a five-step ladder; Raw shows the file those selections write. Both come from the
// same table, so they cannot disagree. The table mirrors LEVEL_SETTINGS and AUTO_WATCH in packages/policy/src/sketch.ts
// and the text mirrors renderAutonomy in packages/policy/src/autonomy.ts; apps/web/test/policy-board.test.js pins both.
// This is a sample on a marketing page: nothing is saved and nothing is sent.

export const LEVELS = [
  { id: "watch", label: "Watch", mode: "shadow", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"],
    means: "Notice and report. No quests are worked." },
  { id: "research", label: "Research", mode: "enforce", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"],
    means: "Gather evidence and write a hypothesis. Nothing is changed." },
  { id: "propose", label: "Propose", mode: "enforce", checkpoints: { A: "advisory", B: "blocking", C: "blocking" }, landing: ["trail_ref"],
    means: "Reproduce and plan a fix; a person approves every step." },
  { id: "patch", label: "Patch", mode: "enforce", checkpoints: { A: "advisory", B: "advisory", C: "blocking" }, landing: ["trail_ref"],
    means: "Write and prove the fix; a person approves landing." },
  { id: "auto", label: "Auto-land", mode: "enforce", checkpoints: { A: "advisory", B: "advisory", C: "advisory" }, landing: ["trail_ref", "auto_land"],
    means: "Land proven small fixes alone, watch them, roll back on regression." },
];
/** Watch window after an auto-landed change: the riskier the area, the longer Ephyra watches. */
export const AUTO_WATCH = { low: "1h", medium: "2h", high: "4h", critical: "4h" };
export const GATES = ["A", "B", "C"];
/** The three points where a quest can wait for a person, by what is decided there. The file calls them A, B and C. */
export const STOPS = { A: "cause", B: "plan", C: "landing" };

/** Who decides at a level, in a sentence: "You approve the plan and the landing." */
export function approves(level, watch) {
  if (level.mode === "shadow") return "Ephyra only reports here. Nothing is done without you.";
  const yours = GATES.filter((g) => level.checkpoints[g] === "blocking").map((g) => `the ${STOPS[g]}`);
  if (!yours.length) return `Nothing waits for you. Each fix is watched for ${watch} and rolled back if it regresses.`;
  return `You approve ${yours.length > 1 ? `${yours.slice(0, -1).join(", ")} and ${yours.at(-1)}` : yours[0]}.`;
}

export const SAMPLE = {
  defaults: { mode: "shadow", checkpoints: { A: "blocking", B: "blocking", C: "blocking" }, landing: ["trail_ref"], watch: "2h", decide: "judgement" },
  areas: [
    { name: "checkout", paths: ["services/checkout/**"], risk: "medium", userFacing: true, level: "research",
      intent: "Money moves here. A person reads the\nhypothesis and the plan before any code." },
    { name: "docs", paths: ["docs/**", "**/*.md"], risk: "low", userFacing: false, level: "auto", intent: "" },
  ],
};

export const levelOf = (id) => LEVELS.find((l) => l.id === id);
/** Critical areas never auto-land, so the top level is applied as Patch there (effectiveLevel in sketch.ts). */
const effective = (area) => (area.level === "auto" && area.risk === "critical" ? "patch" : area.level);
const checkpoints = (values) => GATES.map((g) => `${g}=${values[g]}`).join(" ");

/** The lines one area is written as, in renderAutonomy's order. */
export function areaLines(area) {
  const id = effective(area), level = levelOf(id);
  const lines = [`## area: ${area.name}`, `paths: ${area.paths.join(", ")}`, `risk: ${area.risk}`, `user_facing: ${area.userFacing}`,
    `mode: ${level.mode}`, `checkpoints: ${checkpoints(level.checkpoints)}`, `landing: ${level.landing.join(", ")}`];
  if (id === "auto") lines.push(`watch: ${AUTO_WATCH[area.risk]}`);
  const prose = area.intent.trim();
  return prose ? lines.concat(prose.split("\n")) : lines;
}

export function defaultsLines(d) {
  return ["## defaults", `mode: ${d.mode}`, `checkpoints: ${checkpoints(d.checkpoints)}`, `landing: ${d.landing.join(", ")}`, `watch: ${d.watch}`, `decide: ${d.decide}`];
}

/** The whole file, exactly as the product writes it for these selections. */
export function renderPolicy(policy) {
  return defaultsLines(policy.defaults).concat(...policy.areas.map(areaLines)).join("\n") + "\n";
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
/** One raw line as markup, coloured like tour.js colours the file. `fresh` marks a line the last selection rewrote. */
export function lineHtml(line, fresh) {
  let html;
  const kv = /^([a-z_]+):(\s*)(.*)$/.exec(line);
  if (/^#/.test(line)) html = `<span class="md-h">${esc(line)}</span>`;
  else if (kv) html = `<span class="md-k">${esc(kv[1])}:</span>${kv[2]}<span class="md-v">${esc(kv[3])}</span>`;
  else html = line ? `<span class="md-p">${esc(line)}</span>` : "";
  return fresh ? `<span class="md-new">${html}</span>` : html;
}

/** The board's markup for a policy, complete as written: it reads correctly before any script runs and without one. */
function boardHtml(policy) {
  const rows = policy.areas.map((area, i) => {
    const at = LEVELS.findIndex((l) => l.id === area.level), level = LEVELS[at];
    const steps = LEVELS.map((l, n) =>
      `<label class="pb-step${n < at ? " below" : ""}"><input type="radio" name="pb-level-${esc(area.name)}" value="${l.id}"${n === at ? " checked" : ""}><span>${l.label}</span></label>`).join("");
    const stops = GATES.map((g) =>
      `<span class="pb-stop${level.checkpoints[g] === "blocking" ? " yours" : ""}" data-gate="${g}">${STOPS[g][0].toUpperCase()}${STOPS[g].slice(1)}</span>`).join("");
    const pips = LEVELS.map((_, n) => `<i${n <= at ? ' class="on"' : ""}></i>`).join("");
    return `<div class="pb-area" data-area="${esc(area.name)}">
      <button type="button" class="pb-row" aria-expanded="${i === 0}" aria-controls="pb-detail-${esc(area.name)}">
        <span class="pb-name">${esc(area.name)}</span>
        <span class="pb-risk">${esc(area.risk)} risk</span>
        <span class="pb-level"><span class="pb-pips" aria-hidden="true">${pips}</span><span class="pb-level-name">${esc(level.label)}</span></span>
        <span class="pb-paths">${esc(area.paths.join(", "))}</span>
      </button>
      <div class="pb-detail" id="pb-detail-${esc(area.name)}"${i === 0 ? "" : " hidden"}>
        <fieldset class="pb-ladder"><legend>How far Ephyra goes in ${esc(area.name)}</legend><div class="pb-steps">${steps}</div></fieldset>
        <p class="pb-means" aria-live="polite">${esc(level.means)}</p>
        <p class="pb-who"><span class="pb-stops" aria-hidden="true">${stops}</span><span class="pb-you" aria-live="polite">${esc(approves(level, AUTO_WATCH[area.risk]))}</span></p>
      </div>
    </div>`;
  }).join("");
  return rows;
}

/** The sample board as it ships inside index.html. apps/web/test/policy-board.test.js holds the page to this. */
export const staticBoard = () => `<div class="pb-map">${boardHtml(SAMPLE)}</div>`;

/** What each view is, in a line. The page shows one policy three ways: the app, the terminal and the file they both write. */
export const VIEWS = [
  { id: "map", label: "App", note: "The Workspace page in the app. Pick a level; your changes go through a draft you publish." },
  { id: "term", label: "Terminal", note: "The same board in your terminal. `ephyra policy edit` drives it with keys; `set` changes one area from a script." },
  { id: "raw", label: "File", note: "The file both of them write. Edit it by hand whenever you would rather. In it, A is the cause, B the plan and C the landing." },
];

/**
 * The terminal view: what `ephyra policy` prints for this policy, or `ephyra policy set …` after a change, in the CLI's own layout
 * (apps/cli/src/policy/board.ts: a change mark, the name, risk, five pips, the level, the paths, then who decides in the area).
 * Returns lines of [text, class] segments.
 */
export function terminalLines(policy, changed) {
  const nameW = Math.max(6, ...policy.areas.map((a) => a.name.length)) + 2;
  const focus = policy.areas.find((a) => a.name === changed) ?? policy.areas[0];
  const lines = [[["$ ", "dim"], [changed ? `ephyra policy set ${changed} --level ${focus.level}` : "ephyra policy", "strong"]], []];
  lines.push([["    " + "area".padEnd(nameW) + "risk".padEnd(10) + "autonomy".padEnd(17), "dim"], ["paths", "dim paths"]]);
  for (const area of policy.areas) {
    const at = LEVELS.findIndex((l) => l.id === area.level);
    lines.push([
      [area.name === changed ? "  ~ " : "    ", "amber"], [area.name.padEnd(nameW), "strong"], [area.risk.padEnd(10), "muted"],
      ["●".repeat(at + 1), at === LEVELS.length - 1 ? "mint" : "amber"], ["○".repeat(LEVELS.length - 1 - at), "dim"],
      [` ${LEVELS[at].label.padEnd(11)}`, ""], [area.paths.join(", "), "muted paths"],
    ]);
  }
  const level = levelOf(focus.level);
  const track = [[`  ${focus.name}  `, "strong"]];
  GATES.forEach((g, i) => {
    const yours = level.checkpoints[g] === "blocking";
    if (i) track.push([" ── ", "dim"]);
    track.push([yours ? "● " : "○ ", yours ? "mint" : "dim"], [STOPS[g], yours ? "strong" : "dim"]);
  });
  lines.push([], track, [[`  ${approves(level, AUTO_WATCH[focus.risk])}`, "muted wrap"]]);
  return lines;
}
const termHtml = (lines) =>
  lines.map((line) => line.map(([text, cls]) => (cls ? `<span class="${cls.split(" ").map((c) => `t-${c}`).join(" ")}">${esc(text)}</span>` : esc(text))).join("")).join("\n");

function mount(figure) {
  const pre = figure.querySelector("pre"), caption = figure.querySelector("figcaption");
  if (!pre || !caption) return;
  const policy = structuredClone(SAMPLE);
  let lastLines = renderPolicy(policy).split("\n");

  // The page ships the board and keeps the file in a disclosure, so both read without a script. Here the file moves
  // out of the disclosure and becomes one of the three views.
  const disclosure = pre.closest("details");
  if (disclosure) disclosure.replaceWith(pre);
  const map = figure.querySelector(".pb-map") ?? document.createElement("div");
  map.className = "pb-map";
  map.innerHTML = boardHtml(policy);
  if (!map.parentNode) figure.insertBefore(map, pre);
  const term = document.createElement("div");
  term.className = "pb-term";
  term.setAttribute("role", "img");
  figure.insertBefore(term, pre);
  const note = document.createElement("p");
  note.className = "pb-note";
  figure.append(note);
  let changed = "";

  const views = document.createElement("span");
  views.className = "pb-switch";
  views.setAttribute("role", "group");
  views.setAttribute("aria-label", "Show the policy as");
  views.innerHTML = VIEWS.map((v) => `<button type="button" data-view="${v.id}">${v.label}</button>`).join("");
  caption.append(views);

  function show(view) {
    figure.dataset.view = view;
    map.hidden = view !== "map";
    term.hidden = view !== "term";
    note.innerHTML = esc(`A sample. ${VIEWS.find((v) => v.id === view).note}`).replace(/`([^`]+)`/g, "<code>$1</code>");
    pre.hidden = view !== "raw";
    for (const b of views.children) b.setAttribute("aria-pressed", String(b.dataset.view === view));
  }
  views.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) show(b.dataset.view); });

  function paintRaw(markChanges) {
    const lines = renderPolicy(policy).split("\n");
    // A line is fresh when the last selection wrote it and the file before that selection did not have it.
    const before = new Map();
    for (const l of lastLines) before.set(l, (before.get(l) || 0) + 1);
    pre.innerHTML = lines.map((line) => {
      const seen = before.get(line) || 0;
      if (seen) before.set(line, seen - 1);
      return lineHtml(line, markChanges && !seen && line !== "");
    }).join("\n");
    lastLines = lines;
  }

  function paintTerm() {
    const lines = terminalLines(policy, changed);
    term.innerHTML = termHtml(lines);
    term.setAttribute("aria-label", lines.map((l) => l.map(([text]) => text).join("")).join("\n"));
  }

  function paintArea(area) {
    const el = map.querySelector(`[data-area="${area.name}"]`);
    const at = LEVELS.findIndex((l) => l.id === area.level), level = LEVELS[at];
    el.querySelectorAll(".pb-pips i").forEach((pip, i) => pip.classList.toggle("on", i <= at));
    el.querySelectorAll(".pb-step").forEach((step, i) => step.classList.toggle("below", i < at));
    el.querySelector(".pb-level-name").textContent = level.label;
    el.querySelector(".pb-means").textContent = level.means;
    for (const g of GATES)
      el.querySelector(`[data-gate="${g}"]`).classList.toggle("yours", level.checkpoints[g] === "blocking");
    el.querySelector(".pb-you").textContent = approves(level, AUTO_WATCH[area.risk]);
  }

  map.addEventListener("change", (e) => {
    const area = policy.areas.find((a) => a.name === e.target.closest(".pb-area")?.dataset.area);
    if (!area || !levelOf(e.target.value)) return;
    area.level = e.target.value;
    changed = area.name;
    paintArea(area);
    paintRaw(true);
    paintTerm();
  });
  map.addEventListener("click", (e) => {
    const row = e.target.closest(".pb-row");
    if (!row) return;
    const open = row.getAttribute("aria-expanded") !== "true";
    row.setAttribute("aria-expanded", String(open));
    row.nextElementSibling.hidden = !open;
  });

  policy.areas.forEach(paintArea);
  paintRaw(false);
  paintTerm();
  figure.dataset.board = "on";   // tour.js leaves the file alone once the board owns it
  show("map");
}

if (typeof document !== "undefined") {
  const figure = document.querySelector(".policy .file");
  if (figure) mount(figure);
}
