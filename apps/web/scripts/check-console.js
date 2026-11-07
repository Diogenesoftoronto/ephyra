// Evaluate in the served landing page at desktop and phone widths, in both themes.
// Checks the actual tools, sample navigation, full reader, and preservation of the story across GUI/TUI.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const active = () => $(".step.is-on")?.dataset.step;
  const key = (value) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  await document.fonts.ready;
  assert($(".tour.live"), "Walkthrough did not load");
  const data = await fetch(new URL("walkthrough.json", document.baseURI)).then((r) => r.json());
  $("#gui-choice").click();
  $(".term-next").focus({ preventScroll: true }); key("Home"); await settle();
  const checked = [];
  for (let i = 0; i < data.steps.length; i++) {
    const id = data.steps[i].id;
    if (i) $(".term-next").click();
    await settle();
    assert(active() === id, `GUI navigation selected ${active()}, expected ${id}`);
    assert($("#gui-panel .g-workspace").dataset.guiMoment === id, "GUI moment is out of sync");
    for (const tool of ["review", "evidence", "files", "discuss", "activity"]) {
      $(`#gui-panel [data-console-tool=${tool}]`).click();
      assert($("#gui-panel .g-workspace").dataset.guiTool === tool, `${tool} did not open`);
      assert($("#gui-panel [aria-pressed=true]").dataset.consoleTool === tool, "Tool selection is not exposed");
      assert(active() === id, "Inspecting a tool advanced the story");
      const scroll = $("#gui-panel .g-scroll");
      assert(scroll.clientHeight >= 70, `${id}/${tool} content window is too short: ${scroll.clientHeight}`);
      assert(scroll.scrollWidth <= scroll.clientWidth + 1, `${id}/${tool} overflows horizontally`);
      assert($("#gui-panel").scrollWidth <= $("#gui-panel").clientWidth + 1, `${id}/${tool} tools extend past the workspace`);
      assert($("#gui-panel .g-actions").getBoundingClientRect().bottom <= $("#gui-panel").getBoundingClientRect().bottom + 1,
        "Checkpoint actions are outside the workspace");
    }
    $("#tui-choice").click(); await settle();
    assert(active() === id, `Switching to TUI lost ${id}`);
    assert($("#gui-panel").hidden && !$("#tui-panel").hidden, "TUI is not exclusively visible");
    $("#gui-choice").click(); await settle();
    assert(active() === id, `Switching to GUI lost ${id}`);
    assert(!$("#gui-panel").hidden && $("#tui-panel").hidden, "GUI is not exclusively visible");
    assert($("#gui-panel .g-workspace").dataset.guiTool === "activity", "Switching views lost the selected tool");
    $(".term-read").focus({ preventScroll: true }); $(".term-read").click();
    assert($("dialog").open && !$(".gui-reader").hidden && $(".screen-content pre").hidden, "GUI reader did not open");
    assert($(".gui-reader .g-workspace").dataset.guiTool === "activity", "Reader opened the wrong tool");
    assert($(".gui-reader .g-activity").children.length === data.gui.moments[id].events.length, "Reader omitted activity");
    $(".screen-close").click();
    assert(document.activeElement === $(".term-read"), "Reader lost focus on close");
    checked.push(id);
  }
  $(".term-prev").focus({ preventScroll: true }); key("Home"); await settle();
  for (const target of ["hypothesis", "explain", "revise", "plan", "proof", "watching", "set", "rollback", "triaged"]) {
    const action = $(`#gui-panel [data-preview-go=${target}]`);
    assert(action, `No action leading to ${target}`);
    action.click(); await settle();
    assert(active() === target, `Action did not navigate to ${target}`);
  }
  $(".terminal-invite").focus({ preventScroll: true }); $(".terminal-invite").click();
  assert($("#tui-choice").getAttribute("aria-pressed") === "true", "Terminal invitation did not select TUI");
  assert(document.activeElement === $("#tui-choice"), "Terminal invitation lost focus");
  key("ArrowLeft"); await settle();
  assert($("#gui-choice").getAttribute("aria-pressed") === "true", "Keyboard view selection failed");
  assert(document.documentElement.scrollWidth <= innerWidth, "Page has horizontal overflow");
  return { passed: true, viewport: [innerWidth, innerHeight], theme: getComputedStyle(document.documentElement).colorScheme, steps: checked, tools: 5 };
})();
