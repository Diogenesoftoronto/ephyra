// Browser regression check. Evaluate this file in the served landing page after fonts and tour data load.
// Run at desktop and phone widths, in light and dark. It uses only local fixture data and leaves step 1 selected.
(async () => {
  const $ = (selector) => document.querySelector(selector);
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100));
  const key = (value) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
  assert($(".tour.live"), "Walkthrough did not load");
  await document.fonts.ready;
  const data = await fetch(new URL("walkthrough.json", document.baseURI)).then((r) => r.json());
  $("#tui-choice").click();
  await settle();
  const ids = data.steps.map((step) => step.id);
  const active = () => $(".step.is-on")?.dataset.step;
  $(".term-next").focus({ preventScroll: true });
  key("Home");
  await settle();
  assert($(".term-prev").disabled, "Previous should be disabled at the first step");
  const checked = [];
  for (let i = 0; i < ids.length; i++) {
    if (i) $(".term-next").click();
    await settle();
    assert(active() === ids[i], `Navigation selected ${active()}, expected ${ids[i]}`);
    assert($(".step[aria-current=step]")?.dataset.step === ids[i], "Current step is not exposed to assistive technology");
    const label = [...$(".term-tag").children].find((e) => getComputedStyle(e).display !== "none");
    assert(label?.textContent.toLowerCase().includes("sample data"), "Sample-data label is hidden");
    assert(parseFloat(getComputedStyle($(".term-pre")).fontSize) >= 13, "Terminal type is too small");
    if (ids[i] === "proof") {
      const review = [...document.querySelectorAll(".term-pre .r")].find((e) => e.textContent.includes("no findings"));
      const screen = $(".term-screen").getBoundingClientRect();
      // On a normal-height phone the entire proof fits; shorter devices have native scroll and the reader.
      if (innerHeight >= 800) assert(review.getBoundingClientRect().bottom <= screen.bottom, "Review is cropped");
      assert($(".term-strip .press")?.textContent === "a", "Approve key lost its highlight");
      assert($(".term-strip").textContent.includes("approve and land"), "Checkpoint C consequence is missing");
    }
    if (ids[i] === "revise") {
      assert($(".term-strip").textContent.includes("esc cancel"), "Note cancellation is missing");
      assert(!$(".term-strip").textContent.includes("approve"), "Action hints leaked into note mode");
    }
    $(".term-read").focus({ preventScroll: true });
    $(".term-read").click();
    assert($("dialog").open, "Full-screen reader did not open");
    assert(document.activeElement === $(".screen-close"), "Reader did not focus its close button");
    const variant = innerWidth < 800 ? "narrow" : "wide";
    const rows = [...$(".screen-content pre").children].map((e) => e.textContent);
    assert(JSON.stringify(rows) === JSON.stringify(data.steps[i][variant].map((row) => row.map((s) => s[0]).join(""))),
      `Reader omitted or changed CLI output for ${ids[i]}`);
    $(".screen-close").click();
    assert(!$("dialog").open && document.activeElement === $(".term-read"), "Reader did not restore focus");
    checked.push(ids[i]);
  }
  assert($(".term-next").disabled, "Next should be disabled at the last step");
  $(".term-prev").focus({ preventScroll: true });
  key("Home"); await settle();
  assert(active() === ids[0], "Home did not return to the beginning");
  key("ArrowRight"); await settle();
  assert(active() === ids[1], "Right arrow did not advance");
  key("ArrowLeft"); await settle();
  assert(active() === ids[0], "Left arrow did not go back");
  key("End"); await settle();
  assert(active() === ids.at(-1), "End did not go to the final step");
  key("Home"); await settle();
  assert(active() === ids[0], "Focus was lost at a navigation boundary");
  assert($(".primary-keys").querySelectorAll("dt").length === 5, "Primary key summary was overwritten");
  assert($(".all-keys").querySelectorAll("dt").length === data.keys.length, "Full key list does not match CLI");
  assert(document.documentElement.scrollWidth <= innerWidth, "Page has horizontal overflow");
  return { passed: true, viewport: [innerWidth, innerHeight], steps: checked, theme: getComputedStyle(document.documentElement).colorScheme };
})();
