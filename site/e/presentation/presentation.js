(() => {
  "use strict";
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const asset = (name) => window.EPHYRA_MEDIA?.[name] ?? `media/${name}`;
  const slides = all(".slide");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let index = 0;
  let persona = "bell";
  let currentSound = null;
  let gestureOperation = 0;
  const dialogOpeners = new WeakMap();
  const video = $("#persona-video");
  const notes = [
    ["Ephyra is for people who build and operate applications and want agents to take on the work of keeping them healthy. Start with the intended outcome, then show the actual product. It is pre-alpha: do not describe the full autonomous repair loop as production-proven.", "README.md · Implemented application and MVP; design/07-self-driving-setup.md"],
    ["A quest is the durable unit of work. The lifecycle carries observations, hypotheses, failed attempts, exact revisions, proof, and landing outcomes. Cheap decision models are intended to triage; coding agents run where code must change. Watching and recovery matter as much as producing a patch. The diagram is explanatory, not a running job.", "README.md · The loop and Key decisions; design/01-product-and-loop.md"],
    ["The original proposal featured human checkpoints A/B/C. The current product direction is autonomous by default, with model evaluations and optional supervised review. A factual question can unblock one bounded attempt; it does not bypass budgets or authority. Full landing readiness is separate from active investigation.", "design/07-self-driving-setup.md · Implemented paths and Activation and evidence boundaries"],
    ["These are fresh captures of the deployed walkthrough, which renders the production App components with fake adapters. Numbers, accounts, costs, run states, and proof in these views are fictional. The walkthrough makes no provider call and creates no invitation or repository. Usage and Inbox also exist in the console; the six tabs are the public tour views.", "apps/console/README.md · Public app walkthrough; presentation/provenance.json"],
    ["Not Organic handles account identity. Ephyra provides its own entrance and an open, textured onboarding flow. Public GitHub discovery is credential-free; private repository access is a distinct credential flow. Native Radicle and Tangled resolution also have implemented paths. Setup can be explored before connecting, and unavailable tools remain blockers.", "apps/console/README.md · Onboarding, settings and controls; design/07-self-driving-setup.md"],
    ["The logo identifies the recorded harness, not the hosting provider or model. A run can offer an actual Amp orb, session, or preview URL when supplied. Ephyra membership does not grant an Amp account. Saved interactive HTML appears in an isolated frame beside the transcript. Visuals and portal links are not health evidence. Active-agent takeover is not implemented.", "apps/console/README.md · Agent activity and From the agent; public/engines/README.md"],
    ["Owners create Viewer or Approver invitations. Approvers also have the drafting and model-assisted permissions allowed by workspace policy; settings, setup, and invitations remain owner-only. Invitations are single-use and expire after seven days. QR codes encode the invitation link locally. Acceptance and revocation have local real-server tests with fake OAuth, not a claimed new live-account acceptance. Role buttons here only explain access.", "apps/console/README.md · Team access and Shared reviews"],
    ["Velum helps with intent and policy drafts, including optional Ampersand support. Not Organic keeps connection grants and shared knowledge authority. Ephyra uses selected resources and eligible MCP tools with permission rechecks. Voice supports conversations, editable dictation, drafting, and narration. &Tutor explains a particular recorded revision and evidence. Speech requires a configured service. Publishing a policy ref is not activation.", "README.md · Implemented application; apps/console/README.md · Voice; design/08-account-knowledge.md"],
    ["A persona is a role, not a model. Rho listens, Bell researches, Nema proves, Lappet mends, Turri watches, and Velum drafts. The material set retained fifteen of sixteen Ideogram tile studies. Modern motion exploration produced twenty-two comparisons and six Sonilo sound cues, documented in the manifests. This slide uses existing selected media; it triggers no generation. Selections are subjective design decisions, not model benchmarks. Decorative gestures never report work status.", "design/brand/PERSONAS.md; apps/console/public/materials/README.md; apps/console/public/juice/selection.json"],
    ["Keep the architecture story at the level of ownership: account authority, durable evidence, replaceable execution. Git holds the quest record. The current account setup requires Convex for durable account settings and queues. The original design also discusses Postgres/DBOS; do not substitute that proposal for the current runtime. Adapters do not establish live remote write or cleanup success without receipts.", "README.md · Key decisions; design/07-self-driving-setup.md · Activation and evidence boundaries"],
    ["This is the proof boundary. UI delivery and local tests are evidence for those surfaces and contracts. They are not proof of provider availability, live remote authority, cleanup, rollback, or a completed production repair. The screenshot's test counts belong to the recorded example. Physical mobile performance and Safari are also separate verification work.", "design/07-self-driving-setup.md · Verification scope; apps/console/README.md · Storybook and checks"],
    ["Invite users to try the public walkthrough and bring a repository they understand. Invite collaborators to help with real repair acceptance, forge and runner integration, evidence quality, accessibility, and the feel of the app. The QR code shares this public presentation; it is not a workspace invitation. No customer, traction, pricing, or reliability claim is implied.", "Current product intent from this project; README.md; design/07-self-driving-setup.md"],
  ];
  const questSteps = {
    signal: ["rho", "Rho · Listener", "Start with something observed.", "An error, regression, or failed intent probe gives the investigation a concrete starting point.", "The original signal, source, and triage decision."],
    evidence: ["bell", "Bell · Researcher", "Find the context behind the symptom.", "Gather scoped traces, code, previous work, and any account knowledge shared with this workspace.", "Source references, coverage gaps, and what was actually read."],
    hypothesis: ["bell", "Bell · Researcher", "Make the proposed cause explicit.", "Describe why the failure happens and what would disprove the explanation. A failed hypothesis remains part of the record.", "The hypothesis, its evidence, and the evaluation for this revision."],
    repro: ["nema", "Nema · Prover", "Show the failure before changing it.", "Run a bounded reproduction in the prepared environment. A command that could not run stays unverified.", "Commands, outputs, exit codes, and the failing reproduction."],
    patch: ["lappet", "Lappet · Mender", "Make a change you can inspect.", "Work on the relevant revision in an isolated runner, with the plan and scope visible beside the patch.", "The proposed change, code revision, tool results, and failed attempts."],
    proof: ["nema", "Nema · Prover", "Check that the change earns its way in.", "Compare the reproduction before and after, run the required checks, and preserve evidence of what did and did not pass.", "Revision-bound repro, tests, probes, and proof results."],
    landing: ["turri", "Turri · Watcher", "Land only with the required authority.", "Use the configured forge and policy. Missing remote authority or watch coverage prevents a successful landing claim.", "The landing operation and its confirmed result, or a reconciliation blocker."],
    watch: ["turri", "Turri · Watcher", "Keep watching after the patch.", "The intended loop watches for recurrence, can recover or roll back under policy, and preserves the outcome for future regressions.", "Observed watch coverage, recurrence, recovery, and the final outcome."],
  };
  const screenCopy = {
    overview: "Overview brings recorded activity, waiting decisions, and spend into the same workspace. Unknown costs remain unknown.",
    onboarding: "An open setup flow connects the repository, selects the operation mode, and reveals preparation steps and blockers.",
    runs: "Runs show the recorded agent harness, transcript, tool calls, saved visuals, and available session or preview links.",
    workspace: "Workspace keeps the application map, intent, and autonomy documents together. Draft changes with Velum before publishing a proposal.",
    personas: "Personas make the six roles recognizable while keeping their recorded engines, activity, and costs inspectable.",
    team: "Team access begins with an explicit Viewer or Approver choice, followed by a single-use link or QR invitation.",
  };
  const personas = {
    rho: ["Rho", "Listener", "Notice what needs attention.", "Extract and triage signals before a coding investigation begins."],
    bell: ["Bell", "Researcher", "Gather the evidence.", "Bring traces, code, and previous work into an investigation."],
    nema: ["Nema", "Prover", "Put the change to the test.", "Reproduce the failure and assemble the required proof."],
    lappet: ["Lappet", "Mender", "Work on the repair.", "Turn a plan into an inspectable patch, with the surrounding context in view."],
    turri: ["Turri", "Watcher", "Care about what happens next.", "Follow landing, watch for recurrence, and handle recovery under policy."],
    velum: ["Velum", "Scribe", "Give intent a clear shape.", "Help draft the documents that describe how your application should work."],
  };

  function pressed(selector, button) {
    all(selector).forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
  }
  function stopSound() {
    currentSound?.pause();
    currentSound = null;
    $("#sound-stop").hidden = true;
  }
  function stopGesture(message = "One short gesture. Silent. No loop.") {
    gestureOperation++;
    video.pause();
    video.hidden = true;
    $("#persona-still").style.visibility = "visible";
    $("#gesture-play").textContent = `Play ${personas[persona][0]}’s greeting`;
    $("#gesture-status").textContent = message;
  }
  function syncMotion() {
    stopGesture(reduced.matches ? "Reduced motion is on. The still stays visible." : undefined);
    $("#gesture-play").disabled = reduced.matches;
  }
  function show(nextIndex, updateHash = true) {
    index = Math.max(0, Math.min(slides.length - 1, nextIndex));
    stopGesture(); stopSound();
    slides.forEach((slide, i) => { slide.hidden = i !== index; slide.classList.toggle("entering", i === index); });
    $("#previous").disabled = index === 0;
    $("#next").disabled = index === slides.length - 1;
    $("#chapter-counter").textContent = `${index + 1} / ${slides.length}`;
    $("#chapter-label").textContent = slides[index].dataset.title;
    $("#progress-fill").style.width = `${((index + 1) / slides.length) * 100}%`;
    $(".progress-track").setAttribute("aria-valuenow", String(index + 1));
    $(".progress-track").setAttribute("aria-valuemax", String(slides.length));
    $("#note-copy").textContent = notes[index][0];
    $("#note-source").textContent = notes[index][1];
    all("[data-chapter]").forEach((item, i) => i === index ? item.setAttribute("aria-current", "step") : item.removeAttribute("aria-current"));
    $("#announcement").textContent = `Chapter ${index + 1} of ${slides.length}: ${slides[index].dataset.title}`;
    if (updateHash) { try { history.replaceState(null, "", `#${slides[index].id}`); } catch { /* opaque file previews still navigate locally */ } }
    if (slides[index].id === "living") syncMotion();
  }
  function fromHash() {
    const chosen = slides.findIndex((slide) => `#${slide.id}` === location.hash);
    show(chosen < 0 ? 0 : chosen, false);
  }
  function openDialog(id, opener) {
    const dialog = $(id);
    dialogOpeners.set(dialog, opener);
    dialog.showModal();
  }
  all("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      const opener = dialogOpeners.get(dialog);
      if (!$("dialog[open]")) opener?.focus({ preventScroll: true });
      dialogOpeners.delete(dialog);
    });
    dialog.addEventListener("click", (event) => { if (event.target === dialog) { const r = dialog.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close(); } });
  });
  slides.forEach((slide, i) => {
    const li = document.createElement("li"); const button = document.createElement("button");
    button.type = "button"; button.dataset.chapter = String(i);
    const number = document.createElement("span"); number.textContent = String(i + 1).padStart(2, "0");
    button.append(number, document.createTextNode(slide.dataset.title)); li.append(button); $("#chapters-list").append(li);
    button.addEventListener("click", () => { show(i); $("#chapters-dialog").close(); });
  });
  $("#chapters-open").addEventListener("click", (event) => openDialog("#chapters-dialog", event.currentTarget));
  all("[data-close]").forEach((button) => button.addEventListener("click", () => $(`#${button.dataset.close}`).close()));
  $("#previous").addEventListener("click", () => show(index - 1));
  $("#next").addEventListener("click", () => show(index + 1));
  all("[data-next]").forEach((button) => button.addEventListener("click", () => { show(index + 1); $("#next").focus({ preventScroll: true }); }));
  $("#notes-toggle").addEventListener("click", () => {
    const notesPanel = $("#speaker-notes"); notesPanel.hidden = !notesPanel.hidden;
    $("#notes-toggle").setAttribute("aria-expanded", String(!notesPanel.hidden));
  });
  addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || $("dialog[open]") || event.target.closest("input,textarea,select,[contenteditable=true]")) return;
    if (event.target.closest("[role=group]")) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") { event.preventDefault(); show(index + 1); }
    else if (event.key === "ArrowLeft" || event.key === "PageUp") { event.preventDefault(); show(index - 1); }
    else if (event.key === "Home") { event.preventDefault(); show(0); }
    else if (event.key === "End") { event.preventDefault(); show(slides.length - 1); }
    else if (event.key.toLowerCase() === "n") { event.preventDefault(); $("#notes-toggle").click(); }
  });
  // Arrow keys within an explorable group stay in that group, rather than changing chapters.
  all("[role=group]").forEach((group) => group.addEventListener("keydown", (event) => {
    const buttons = [...group.querySelectorAll("button")]; const current = buttons.indexOf(event.target);
    if (current < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (current + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next].focus({ preventScroll: true }); buttons[next].click();
  }));
  all("[data-quest]").forEach((button) => button.addEventListener("click", () => {
    pressed("[data-quest]", button); const [id, name, title, description, record] = questSteps[button.dataset.quest];
    $("#quest-persona").src = asset(`${id}.webp`); $("#quest-persona").alt = name;
    $("#quest-owner").textContent = name; $("#quest-detail-title").textContent = title;
    $("#quest-description").textContent = description; $("#quest-record").textContent = record;
  }));
  all("[data-mode]").forEach((button) => button.addEventListener("click", () => {
    pressed("[data-mode]", button); const supervised = button.dataset.mode === "supervised";
    $("#mode-title").textContent = supervised ? "Pause at the checkpoints you configure." : "Progress within the agreed policy.";
    $("#mode-copy").textContent = supervised ? "Approvers review the bound revision and evidence before allowing the configured steps to proceed. The work and its blockers stay visible." : "Models evaluate recorded checkpoints. Ephyra asks a specific question when missing information or authority blocks progress.";
  }));
  all("[data-screen]").forEach((button) => button.addEventListener("click", () => {
    pressed("[data-screen]", button); const name = button.dataset.screen;
    $("#product-image").src = asset(`${name}.png`); $("#product-image").alt = `Actual Ephyra ${button.textContent} screen with fictional sample data`;
    $("#screen-description").textContent = screenCopy[name];
  }));
  all("[data-entrance]").forEach((button) => button.addEventListener("click", () => {
    pressed("[data-entrance]", button); const isSignIn = button.dataset.entrance === "signin-mobile";
    $("#entrance-image").src = asset(`${button.dataset.entrance}.png`);
    $("#entrance-image").alt = isSignIn ? "Ephyra's custom Not Organic sign-in entrance" : "Ephyra's actual repository onboarding screen with fictional sample data";
    $("#entrance-caption").textContent = isSignIn ? "Actual sign-in entrance" : "Actual app · fictional sample data";
  }));
  all("[data-role]").forEach((button) => button.addEventListener("click", () => {
    pressed("[data-role]", button); const approver = button.dataset.role === "approver";
    $("#role-title").textContent = approver ? "Help with the decisions." : "See the same work.";
    $("#role-description").textContent = approver ? "Everything a Viewer can do, plus approvals, drafting, and model-assisted work allowed by the workspace policy." : "Read quests, follow runs, inspect evidence, and see recorded costs.";
  }));
  const intentCopy = {
    draft: "Draft intent or policy in writing or conversation. Review the changes before publishing. A published policy ref does not itself change the live policy.",
    knowledge: "Choose shared Not Organic resources and eligible MCP search tools for this workspace. Research rechecks permissions and records the evidence it reads.",
    voice: "Talk with Velum, dictate an editable draft, or ask &Tutor to explain the recorded revision and evidence. Voice requires a configured speech service, with captions and text available.",
  };
  all("[data-intent]").forEach((button) => button.addEventListener("click", () => { pressed("[data-intent]", button); $("#intent-description").textContent = intentCopy[button.dataset.intent]; }));
  all("[data-persona]").forEach((button) => button.addEventListener("click", () => {
    stopGesture(); persona = button.dataset.persona; pressed("[data-persona]", button);
    const [name, role, title, description] = personas[persona];
    $("#persona-still").src = asset(`${persona}.webp`); $("#persona-still").alt = `${name}, the ${role}`;
    $("#persona-material").src = asset(`${persona}-tile.webp`);
    $("#persona-role").textContent = `${name} · ${role}`; $("#persona-title").textContent = title; $("#persona-description").textContent = description;
    video.removeAttribute("src"); video.load(); video.setAttribute("aria-label", `${name} greeting animation`); syncMotion();
  }));
  $("#gesture-play").addEventListener("click", async () => {
    if (reduced.matches) return;
    if (!video.paused) { stopGesture("Paused. Play the greeting again whenever you like."); return; }
    const operation = ++gestureOperation;
    const source = asset(`${persona}.webm`);
    if (video.getAttribute("src") !== source) video.src = source;
    video.currentTime = 0;
    $("#gesture-status").textContent = "Loading the greeting…";
    try {
      await video.play();
      if (operation !== gestureOperation) return;
      video.hidden = false; $("#persona-still").style.visibility = "hidden";
      $("#gesture-play").textContent = "Pause greeting"; $("#gesture-status").textContent = "One short gesture. Silent. No loop.";
    } catch { if (operation === gestureOperation) stopGesture("This browser cannot play the greeting. The approved still is shown."); }
  });
  video.addEventListener("ended", () => stopGesture("Greeting finished. Play it again whenever you like."));
  video.addEventListener("error", () => stopGesture("This browser cannot play the greeting. The approved still is shown."));
  all("[data-sound]").forEach((button) => button.addEventListener("click", async () => {
    stopSound(); const sound = new Audio(asset(`${button.dataset.sound}.mp3`)); sound.volume = .35; currentSound = sound;
    $("#sound-stop").hidden = false;
    sound.addEventListener("ended", () => { if (currentSound === sound) stopSound(); });
    sound.addEventListener("error", () => { if (currentSound === sound) { stopSound(); $("#gesture-status").textContent = "The sound could not be played in this browser."; } });
    try { await sound.play(); } catch { if (currentSound === sound) { stopSound(); $("#gesture-status").textContent = "The sound could not be played in this browser."; } }
  }));
  $("#sound-stop").addEventListener("click", stopSound);
  addEventListener("visibilitychange", () => { if (document.hidden) { stopGesture(); stopSound(); } });
  if ("IntersectionObserver" in window) new IntersectionObserver(([entry]) => {
    if (!entry.isIntersecting) { stopGesture(); stopSound(); }
  }).observe($("#persona-detail"));
  reduced.addEventListener("change", syncMotion);
  all("[data-zoom-target]").forEach((button) => button.addEventListener("click", () => {
    const source = document.getElementById(button.dataset.zoomTarget);
    $("#enlarged-image").src = source.src; $("#enlarged-image").alt = source.alt;
    $("#image-description").textContent = source.alt;
    openDialog("#image-dialog", button);
  }));
  addEventListener("hashchange", fromHash);
  fromHash(); syncMotion();
})();
