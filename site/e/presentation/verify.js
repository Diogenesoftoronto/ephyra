/* Inject after presentation.js in T3 html_preview. No server or provider calls. */
(async () => {
  await document.fonts.ready;
  const failures = [];
  const checks = [];
  const assert = (condition, label) => { checks.push(label); if (!condition) failures.push(label); };
  const $ = (selector) => document.querySelector(selector);
  const all = (selector) => [...document.querySelectorAll(selector)];
  const chapter = (number) => $(`[data-chapter="${number}"]`).click();
  const visible = () => all(".slide").filter((node) => !node.hidden);
  // html_preview inlines local <img> sources. These hidden reference images also make tab changes available offline.
  all("[data-preview-asset]").forEach((img) => { window.EPHYRA_MEDIA ??= {}; window.EPHYRA_MEDIA[img.dataset.previewAsset] = img.src; });
  const layout = [];
  for (let i = 0; i < 12; i++) {
    chapter(i);
    assert(visible().length === 1, `Exactly one visible chapter at ${i + 1}`);
    assert($(".progress-track").getAttribute("aria-valuenow") === String(i + 1), `Progress at ${i + 1}`);
    const slide = visible()[0];
    const rect = slide.getBoundingClientRect();
    const overflow = [...slide.querySelectorAll("h1,h2,h3,h4,p,button,li,figure")].filter((node) => {
      if (!node.getClientRects().length) return false;
      const r = node.getBoundingClientRect();
      return r.left < rect.left - 1 || r.right > rect.right + 1;
    }).map((node) => node.id || node.className || node.textContent.slice(0, 50));
    assert(overflow.length === 0, `Chapter ${i + 1} fits width: ${overflow.join(",")}`);
    assert(document.documentElement.scrollWidth <= innerWidth, `No page overflow at ${i + 1}`);
    layout.push({ id: slide.id, height: Math.ceil(rect.height), overflow });
  }
  chapter(0); assert($("#previous").disabled, "Previous disabled at beginning");
  $("#next").click(); assert(visible()[0].id === "quest", "Next opens quest chapter");
  $("#previous").click(); assert(visible()[0].id === "hello", "Previous returns to cover");
  chapter(11); assert($("#next").disabled, "Next disabled at ending");
  chapter(1); $("[data-quest=proof]").click();
  assert($("#quest-record").textContent.includes("Revision-bound"), "Quest exploration changes evidence requirements");
  $("[data-quest=proof]").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
  assert($("[data-quest=landing]").getAttribute("aria-pressed") === "true" && visible()[0].id === "quest", "Group arrows select locally without changing chapter");
  chapter(2); $("[data-mode=supervised]").click();
  assert($("#mode-title").textContent.includes("Pause"), "Supervised mode explanation");
  chapter(3);
  for (const button of all("[data-screen]")) { button.click(); assert($("#product-image").alt.includes(button.textContent), `Screen ${button.textContent} updates`); }
  const zoom = $("[data-zoom-target=product-image]"); zoom.focus(); zoom.click();
  assert($("#image-dialog").open && $("#enlarged-image").src === $("#product-image").src, "Enlarged image matches selection");
  await new Promise((resolve) => { $("#image-dialog").addEventListener("close", resolve, { once: true }); $("#image-dialog").close(); });
  assert(document.activeElement === zoom, "Zoom restores focus without moving chapters");
  chapter(6); $("[data-role=approver]").click();
  assert($("#role-description").textContent.includes("workspace policy"), "Approver access remains policy scoped");
  chapter(7); $("[data-intent=knowledge]").click();
  assert($("#intent-description").textContent.includes("rechecks permissions"), "Knowledge explanation retains access boundary");
  chapter(8);
  const video = $("#persona-video");
  assert(!video.hasAttribute("src") && !video.autoplay && !video.loop, "Character video is lazy and finite");
  $("[data-persona=nema]").click(); assert($("#persona-role").textContent === "Nema · Prover", "Persona choice updates role");
  video.dispatchEvent(new Event("error"));
  assert(video.hidden && $("#persona-still").style.visibility === "visible", "Failed media keeps the still");
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) assert($("#gesture-play").disabled, "Reduced motion disables video playback");
  $("#notes-toggle").click(); assert(!$("#speaker-notes").hidden, "Presenter notes open");
  $("#notes-toggle").click(); assert($("#speaker-notes").hidden, "Presenter notes close");
  chapter(0); $("#chapters-open").focus(); $("#chapters-open").click();
  assert($("#chapters-dialog").open, "Chapter chooser opens");
  await new Promise((resolve) => { $("#chapters-dialog").addEventListener("close", resolve, { once: true }); $("#chapters-dialog").close(); });
  assert(document.activeElement === $("#chapters-open"), "Chapter chooser restores focus");
  $("#chapters-open").blur();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
  assert(visible()[0].id === "join", "End key opens final chapter");
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
  assert(visible()[0].id === "hello", "Home key opens cover");
  const report = { width: innerWidth, checks: checks.length, failures, layout, mediaScope: "Lazy loading, finite flags, and failure fallback; live decoding checked separately" };
  window.ephyraPresentationReport = report;
  console.log("EPHYRA_PRESENTATION_QA " + JSON.stringify({ width: innerWidth, checks: checks.length, failures, heights: layout.map((item) => item.height) }));
})();
