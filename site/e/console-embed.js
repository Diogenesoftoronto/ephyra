const STEPS = new Set(["triaged", "hypothesis", "explain", "revise", "plan", "proof", "watching", "set", "rollback"]);

/** Only the configured console receives sample data. Neither query strings nor messages choose a service. */
export function consoleAppUrl(value, parentOrigin) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    if (url.username || url.password || url.pathname !== "/app/" || url.hash
      || url.searchParams.get("demo") !== "1" || url.searchParams.get("walkthrough") !== "1"
      || url.searchParams.get("parentOrigin") !== parentOrigin) return null;
    return url;
  } catch { return null; }
}

/** The same recorded trail drives the terminal output and the actual console components. */
export function walkthroughSelection(step, data) {
  const moment = STEPS.has(step) && data?.gui?.moments?.[step];
  if (!moment?.trail || !Array.isArray(moment.events)) return null;
  const artefacts = [];
  const checkout = moment.trail.id === data.gui.moments.triaged?.trail.id;
  if (checkout && moment.events.some(event => event.type === "research_completed"))
    artefacts.push({ path: "hypothesis.md", content: data.gui.hypothesis });
  if (checkout && ["plan", "proof", "watching", "set"].includes(step))
    artefacts.push({ path: "plan.md", content: data.gui.plan });
  const evidence = checkout ? data.gui.evidence : moment.events.filter(event => /regression|rollback|rolled_back/.test(event.type));
  artefacts.push({ path: "evidence/index.json", content: JSON.stringify(evidence, null, 2) });
  return { type: "ephyra.walkthrough.select", step, detail: { trail: moment.trail, events: moment.events, artefacts } };
}

export function isConsoleFrameMessage(event, frameWindow, origin) {
  return Boolean(event.source === frameWindow && event.origin === origin && event.data && typeof event.data === "object"
    && ["ephyra.walkthrough.ready", "ephyra.walkthrough.applied"].includes(event.data.type));
}

/** One iframe per surface. Scroll and resize update its sample without recreating its application or forms. */
export function createConsoleEmbed(container, value, browser = window) {
  const url = consoleAppUrl(value, browser.location.origin);
  if (!url) {
    container.dataset.consoleStatus = "unavailable";
    return null;
  }
  const document = container.ownerDocument;
  const frame = document.createElement("iframe");
  frame.className = "console-app-frame";
  frame.title = "Ephyra console, interactive sample workspace";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-downloads");
  frame.setAttribute("referrerpolicy", "no-referrer");
  const status = document.createElement("p");
  status.className = "console-app-status";
  status.setAttribute("role", "status");
  status.textContent = "Loading the sample console…";
  container.replaceChildren(status, frame);
  container.dataset.consoleStatus = "loading";
  let selected = null;
  const send = () => { if (selected) frame.contentWindow?.postMessage(selected, url.origin); };
  frame.addEventListener("load", send);
  const timeout = browser.setTimeout(() => {
    if (container.dataset.consoleStatus === "ready") return;
    const link = document.createElement("a");
    const sample = new URL("/app/?demo=1", url.origin);
    link.href = sample.href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open the sample workspace";
    status.replaceChildren(document.createTextNode("The embedded console is taking longer to load. "), link);
  }, 12_000);
  const receive = event => {
    if (!isConsoleFrameMessage(event, frame.contentWindow, url.origin)) return;
    if (event.data.type === "ephyra.walkthrough.ready") { send(); return; }
    if (!selected || event.data.step !== selected.step || event.data.trailId !== selected.detail.trail.id
      || event.data.state !== selected.detail.trail.state) return;
    browser.clearTimeout(timeout);
    status.hidden = true;
    container.dataset.consoleStatus = "ready";
    container.dataset.consoleStep = event.data.step;
    container.dataset.consoleTrail = event.data.trailId;
    container.dataset.consoleState = event.data.state;
  };
  browser.addEventListener("message", receive);
  frame.src = url.href;
  return {
    frame,
    select(step, data) {
      const next = walkthroughSelection(step, data);
      if (!next) return;
      selected = next;
      container.dataset.consoleSelectedStep = step;
      send();
    },
    close() {
      browser.clearTimeout(timeout);
      browser.removeEventListener("message", receive);
      frame.removeEventListener("load", send);
    },
  };
}
