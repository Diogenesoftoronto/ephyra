import { expect, test } from "bun:test";
import { consoleAppUrl, createConsoleEmbed, isConsoleFrameMessage, walkthroughSelection } from "../../../site/e/console-embed.js";
import data from "../../../site/e/walkthrough.json";

const parentOrigin = "https://ephyra.example";
const childOrigin = "https://console.example";
const url = `${childOrigin}/app/?demo=1&walkthrough=1&parentOrigin=${encodeURIComponent(parentOrigin)}`;

test("sample console URLs require an exact origin binding and cannot carry credentials or enter live mode", () => {
  expect(consoleAppUrl(url, parentOrigin)?.origin).toBe(childOrigin);
  expect(consoleAppUrl(url.replace(childOrigin, "http://localhost:4173"), parentOrigin)?.origin).toBe("http://localhost:4173");
  for (const invalid of [undefined, "/app/?demo=1", "javascript:alert(1)",
    url.replace("https:", "http:"), url.replace("console.example", "user:secret@console.example"),
    url.replace("demo=1", "demo=0"), url.replace("walkthrough=1", "walkthrough=0"),
    url.replace("/app/", "/auth/login"), `${url}#real-account`, url.replace(encodeURIComponent(parentOrigin), "https%3A%2F%2Fother.example")]) {
    expect(consoleAppUrl(invalid, parentOrigin)).toBeNull();
  }
});

test("guided selections retain the actual trail identity and only the documents available at that stage", () => {
  for (const { id } of data.steps) {
    const selection = walkthroughSelection(id, data);
    expect(selection.type).toBe("ephyra.walkthrough.select");
    expect(selection.detail.trail).toEqual(data.gui.moments[id].trail);
    expect(selection.detail.events).toEqual(data.gui.moments[id].events);
  }
  expect(walkthroughSelection("triaged", data).detail.artefacts.some(item => item.path === "hypothesis.md")).toBe(false);
  expect(walkthroughSelection("hypothesis", data).detail.artefacts.map(item => item.path)).toEqual(["hypothesis.md", "evidence/index.json"]);
  expect(walkthroughSelection("plan", data).detail.artefacts.map(item => item.path)).toEqual(["hypothesis.md", "plan.md", "evidence/index.json"]);
  const rollback = walkthroughSelection("rollback", data);
  expect(rollback.detail.trail.short).toBe("T-738495");
  expect(JSON.stringify(rollback.detail.artefacts)).not.toContain("TotalMismatch");
  expect(rollback.detail.artefacts.some(item => item.path === "hypothesis.md" || item.path === "plan.md")).toBe(false);
  expect(walkthroughSelection("unrecognized", data)).toBeNull();
});

function fixture(value = url) {
  const listeners = new Map();
  const timers = new Map();
  const browser = { location: { origin: parentOrigin },
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    addEventListener: (kind, callback) => { const handlers = listeners.get(kind) ?? new Set(); handlers.add(callback); listeners.set(kind, handlers); },
    removeEventListener: (kind, callback) => listeners.get(kind)?.delete(callback),
  };
  const sent = [];
  const document = { createElement: tag => ({ tag, attrs: {}, dataset: {}, children: [], handlers: new Map(),
    contentWindow: tag === "iframe" ? { postMessage: (message, target) => sent.push({ message, target }) } : undefined,
    setAttribute(key, value) { this.attrs[key] = value; },
    addEventListener(key, value) { this.handlers.set(key, value); },
    removeEventListener(key) { this.handlers.delete(key); },
    replaceChildren(...children) { this.children = children; },
  }), createTextNode: value => value };
  const container = { ownerDocument: document, dataset: {}, children: [], replaceChildren(...children) { this.children = children; } };
  const embed = createConsoleEmbed(container, value, browser);
  const message = (data, source = embed?.frame.contentWindow, origin = childOrigin) => {
    for (const handler of listeners.get("message") ?? []) handler({ data, source, origin });
  };
  return { container, embed, sent, message, timers, listeners };
}

test("one stable iframe synchronizes all nine stages without recreating the application", () => {
  const f = fixture();
  const frame = f.embed.frame;
  expect(frame.attrs.sandbox).toBe("allow-scripts allow-same-origin allow-downloads");
  expect(frame.attrs.referrerpolicy).toBe("no-referrer");
  expect(frame.src).toBe(url);
  expect(frame.title).toContain("sample workspace");
  for (const { id } of data.steps) f.embed.select(id, data);
  expect(f.sent).toHaveLength(9);
  expect(f.sent.every(item => item.target === childOrigin)).toBe(true);
  expect(f.container.children[1]).toBe(frame);
  f.embed.select("rollback", data);
  expect(f.container.children[1]).toBe(frame);
  f.message({ type: "ephyra.walkthrough.ready" });
  expect(f.sent.at(-1).message.step).toBe("rollback");
  f.embed.close();
  expect(f.timers.size).toBe(0);
  expect(f.listeners.get("message").size).toBe(0);
});

test("only an acknowledgement from this iframe and origin can establish the selected sample", () => {
  const f = fixture();
  f.embed.select("hypothesis", data);
  const selected = walkthroughSelection("hypothesis", data);
  const acknowledgement = { type: "ephyra.walkthrough.applied", step: selected.step,
    trailId: selected.detail.trail.id, state: selected.detail.trail.state };
  f.message(acknowledgement, {}, childOrigin);
  f.message(acknowledgement, f.embed.frame.contentWindow, "https://other.example");
  f.message({ ...acknowledgement, step: "proof" });
  f.message({ ...acknowledgement, trailId: "another-trail" });
  f.message({ ...acknowledgement, state: "closed" });
  expect(f.container.dataset.consoleStatus).toBe("loading");
  f.message(acknowledgement);
  expect(f.container.dataset).toMatchObject({ consoleStatus: "ready", consoleStep: "hypothesis",
    consoleTrail: selected.detail.trail.id, consoleState: "hypothesised" });
  expect(f.container.children[0].hidden).toBe(true);
  expect(f.timers.size).toBe(0);
  expect(isConsoleFrameMessage({ data: null }, f.embed.frame.contentWindow, childOrigin)).toBe(false);
});

test("a missing connection remains unavailable and a slow frame offers the actual sample workspace", () => {
  const invalid = fixture("");
  expect(invalid.embed).toBeNull();
  expect(invalid.container.dataset.consoleStatus).toBe("unavailable");
  expect(invalid.container.children).toEqual([]);
  const slow = fixture();
  for (const callback of slow.timers.values()) callback();
  const link = slow.container.children[0].children[1];
  expect(link.href).toBe(`${childOrigin}/app/?demo=1`);
  expect(link.rel).toBe("noopener noreferrer");
  slow.embed.close();
});
