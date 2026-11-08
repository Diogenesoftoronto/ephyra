// Evaluate in the served landing page. Checks the actual-console frame protocol and the retained terminal tour.
// Console controls are exercised separately through browser frame locators; no live account is used.
(async () => {
  const $ = selector => document.querySelector(selector);
  const checks = [];
  const check = (name, passed) => { checks.push({ name, passed: Boolean(passed) }); };
  const wait = async predicate => {
    for (let i = 0; i < 60; i++) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 50)); }
    return false;
  };
  const data = await fetch(new URL("walkthrough.json", document.baseURI), { credentials: "omit" }).then(response => response.json());
  if (!await wait(() => $(".tour.live"))) throw new Error("Walkthrough data did not load.");
  $("#gui-choice").click();
  const panel = $("#gui-panel");
  const frame = panel.querySelector("iframe");
  check("actual console iframe replaces the separate GUI renderer", frame && !panel.querySelector(".g-workspace"));
  if (!frame) throw new Error("Console application iframe is unavailable.");
  check("console is explicitly isolated sample mode", new URL(frame.src).searchParams.get("demo") === "1"
    && new URL(frame.src).searchParams.get("walkthrough") === "1" && frame.title.includes("sample"));
  const steps = [];
  for (const step of data.steps) {
    $(`.step[data-step="${step.id}"]`).click();
    const expected = data.gui.moments[step.id].trail;
    const applied = await wait(() => panel.dataset.consoleStep === step.id && panel.dataset.consoleTrail === expected.id
      && panel.dataset.consoleState === expected.state && panel.dataset.consoleStatus === "ready");
    check(`actual console accepts ${step.id} with its exact trail and state`, applied);
    check(`frame stays mounted through ${step.id}`, panel.querySelector("iframe") === frame);
    steps.push({ step: step.id, applied, state: panel.dataset.consoleState });
  }
  const selected = panel.dataset.consoleStep;
  $("#tui-choice").click();
  check("terminal view exclusively replaces graphical view", panel.hidden && !$("#tui-panel").hidden);
  check("real CLI output remains populated", $(".term-pre").textContent.length > 200);
  $("#gui-choice").click();
  check("switching back preserves the sample step and frame", !panel.hidden && $("#tui-panel").hidden
    && panel.querySelector("iframe") === frame && panel.dataset.consoleStep === selected);
  $(".term-read").focus({ preventScroll: true });
  $(".term-read").click();
  const reader = $(".screen-dialog");
  const full = reader.querySelector(".gui-reader");
  const ready = await wait(() => full.dataset.consoleStatus === "ready" && full.dataset.consoleStep === selected);
  check("expanded view uses the actual console with the same selected step", reader.open && ready && full.querySelector("iframe"));
  reader.querySelector(".screen-close").click();
  check("native dialog closes", !reader.open);
  check("parent page has no horizontal overflow", document.documentElement.scrollWidth <= innerWidth);
  // Leave the review step ready for direct interaction checks.
  $('.step[data-step="hypothesis"]').click();
  check("review step is ready for interaction", await wait(() => panel.dataset.consoleStep === "hypothesis"));
  if (innerWidth < 1120 && innerHeight > 700) {
    check("selected story label clears the pinned console controls",
      $('.step.is-on .step-n').getBoundingClientRect().top >= $('.term-tools').getBoundingClientRect().bottom + 8);
  }
  return { passed: checks.filter(check => check.passed).length, failed: checks.filter(check => !check.passed).length,
    viewport: [innerWidth, innerHeight], checks, steps, scope: "Actual console components with fictional sample data; no provider or account actions." };
})();
