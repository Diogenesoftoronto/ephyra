import { expect, test } from "bun:test";
import fc from "fast-check";
import { createDemoRoom, DEMO_ROOM_KEY, mergeDemoOperations } from "../../../site/e/multiplayer.js";
import { renderConsole, renderDiscussion } from "../../../site/e/console.js";
import walkthrough from "../../../site/e/walkthrough.json";

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};
const operation = (id, extra = {}) => ({
  version: 1, id, actor: "local-person", trail: "T-checkout", seq: 1, at: 1234,
  kind: "comment", text: "Check the coupon path", ...extra,
});
function bus() {
  const channels = [];
  const pending = [];
  return {
    channel() {
      const listeners = new Set();
      const channel = {
        addEventListener: (_, listener) => listeners.add(listener),
        removeEventListener: (_, listener) => listeners.delete(listener),
        postMessage(data) {
          for (const target of channels) if (target !== channel) pending.push({ target, data: structuredClone(data) });
        },
        emit(data) { for (const listener of listeners) listener({ data }); },
      };
      channels.push(channel);
      return channel;
    },
    flush() {
      const sent = pending.splice(0).reverse();
      for (const { target, data } of sent) target.emit(data);
      return sent;
    },
  };
}

test("local comments remain plaintext, are bounded, and stay isolated by trail", () => {
  const db = storage();
  const room = createDemoRoom({ storage: db, channel: null });
  const hostile = '<img src=x onerror="alert(1)">';
  room.addComment("T-search", hostile);
  for (let i = 0; i < 25; i++) room.addComment("T-checkout", `Note ${i}`);
  const checkout = room.getSnapshot("T-checkout");
  expect(checkout.scope).toBe("local-demo");
  expect(checkout.comments).toHaveLength(20);
  expect(checkout.comments[0].text).toBe("Note 5");
  expect(checkout.comments.at(-1).text).toBe("Note 24");
  expect(room.getSnapshot("T-search").comments[0].text).toBe(hostile);
  expect(room.getSnapshot("T-missing").comments).toEqual([]);
  expect(JSON.parse(db.getItem(DEMO_ROOM_KEY)).operations).toHaveLength(21);
  const restored = createDemoRoom({ storage: db, channel: null });
  expect(restored.getSnapshot("T-checkout").comments).toEqual(checkout.comments);
  expect(Object.isFrozen(checkout.comments)).toBe(true);
  expect(Object.isFrozen(checkout.comments[0])).toBe(true);
  room.close(); restored.close();
});

test("concurrent comments converge under reversed and duplicated delivery", () => {
  const transport = bus();
  const a = createDemoRoom({ storage: storage(), channel: transport.channel() });
  const b = createDemoRoom({ storage: storage(), channel: transport.channel() });
  const notifications = [];
  const unsubscribe = a.subscribe((trail, snapshot) => notifications.push([trail, snapshot.comments.length]));
  const idA = a.addComment("T-checkout", "Check receipt rounding");
  const idB = b.addComment("T-checkout", "Check coupon rounding");
  const sent = transport.flush();
  expect(a.getSnapshot("T-checkout").comments).toEqual(b.getSnapshot("T-checkout").comments);
  expect(new Set(a.getSnapshot("T-checkout").comments.map((entry) => entry.id))).toEqual(new Set([idA, idB]));
  const before = notifications.length;
  for (const { target, data } of sent) { target.emit(data); target.emit(data); }
  expect(notifications).toHaveLength(before);
  unsubscribe();
  b.addComment("T-search", "A different investigation"); transport.flush();
  expect(notifications).toHaveLength(before);
  a.close(); b.close();
});

test("concurrent claims converge and only the current local owner can release", () => {
  const transport = bus();
  const a = createDemoRoom({ storage: storage(), channel: transport.channel() });
  const b = createDemoRoom({ storage: storage(), channel: transport.channel() });
  a.claim("T-checkout"); b.claim("T-checkout"); transport.flush();
  const aState = a.getSnapshot("T-checkout");
  const bState = b.getSnapshot("T-checkout");
  expect(aState.ownerId).toBe(bState.ownerId);
  expect(Number(aState.isOwner) + Number(bState.isOwner)).toBe(1);
  const owner = aState.isOwner ? a : b;
  const other = aState.isOwner ? b : a;
  expect(other.release("T-checkout")).toBeNull();
  expect(owner.claim("T-checkout")).toBeNull();
  expect(owner.release("T-checkout")).toEqual(expect.any(String));
  transport.flush();
  expect(a.getSnapshot("T-checkout").claimed).toBe(false);
  expect(b.getSnapshot("T-checkout").claimed).toBe(false);
  expect(a.getSnapshot("T-search").claimed).toBe(false);
  a.close(); b.close();
});

test("storage failure degrades honestly to memory and closing detaches the room", () => {
  const unavailable = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("full"); } };
  const transport = bus();
  const channel = transport.channel();
  const room = createDemoRoom({ storage: unavailable, channel });
  room.addComment("T-checkout", "Still inspectable locally");
  expect(room.getSnapshot("T-checkout").persistence).toBe("memory");
  expect(room.getSnapshot("T-checkout").comments).toHaveLength(1);
  room.close(); room.close();
  channel.emit({ version: 1, operations: [operation("late", { seq: 9 })] });
  expect(room.getSnapshot("T-checkout").comments).toHaveLength(1);
  expect(() => room.addComment("T-checkout", "Late write")).toThrow("closed");
});

test("partial window shims support local state without browser event methods", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  let room;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true, writable: true, value: { localStorage: storage(), addEventListener: true },
    });
    room = createDemoRoom();
    room.addComment("T-checkout", "Works beside a CLI renderer");
    expect(room.getSnapshot("T-checkout").comments).toHaveLength(1);
    expect(() => room.close()).not.toThrow();
  } finally {
    room?.close();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});

test("closing removes the listener from the original browser event target", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const listeners = new Set();
  const target = {
    addEventListener(type, listener) { if (type === "storage") listeners.add(listener); },
    removeEventListener(type, listener) { if (type === "storage") listeners.delete(listener); },
  };
  let room;
  try {
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: target });
    room = createDemoRoom({ storage: storage(), channel: null });
    expect(listeners.size).toBe(1);
    globalThis.window = {};
    room.close();
    expect(listeners.size).toBe(0);
  } finally {
    room?.close();
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else delete globalThis.window;
  }
});

test("malformed messages and invalid local inputs cannot alter a room", () => {
  const transport = bus();
  const channel = transport.channel();
  const room = createDemoRoom({ storage: null, channel });
  for (const data of [null, "{", [], { version: 2, operations: [operation("wrong-version")] }]) channel.emit(data);
  const invalid = [
    operation("bad", { seq: NaN }), operation("bad", { seq: 0 }), operation("bad", { kind: "approve" }),
    operation("bad", { text: " " }), operation("bad", { text: "x".repeat(1001) }),
    operation("bad", { trail: "<script>" }), operation("bad", { at: -1 }), operation("bad", { actor: null }),
  ];
  channel.emit({ version: 1, operations: invalid });
  expect(room.getSnapshot("T-checkout").comments).toEqual([]);
  for (const text of ["", "   ", null, "x".repeat(1001)]) expect(() => room.addComment("T-checkout", text)).toThrow();
  expect(() => room.addComment("", "note")).toThrow();
  expect(() => room.claim("<script>")).toThrow();
  expect(() => room.subscribe(null)).toThrow();
  expect(room.getSnapshot("T-checkout").claimed).toBe(false);
  room.close();
});

test("an old snapshot cannot replace newer durable state", () => {
  const db = storage();
  const transport = bus();
  const channel = transport.channel();
  const room = createDemoRoom({ storage: db, channel });
  room.addComment("T-checkout", "First");
  const stale = db.getItem(DEMO_ROOM_KEY);
  room.addComment("T-checkout", "Second");
  db.setItem(DEMO_ROOM_KEY, stale);
  channel.emit(JSON.parse(stale));
  const restored = createDemoRoom({ storage: db, channel: null });
  expect(restored.getSnapshot("T-checkout").comments.map((entry) => entry.text)).toEqual(["First", "Second"]);
  room.close(); restored.close();
});

test("stable operations merge commutatively, associatively, and idempotently with bounded history", () => {
  fc.assert(fc.property(fc.array(fc.record({
    trail: fc.constantFrom("T-checkout", "T-search", "T-docs"),
    kind: fc.constantFrom("comment", "claim", "release"),
    seq: fc.integer({ min: 1, max: 100 }),
  }), { minLength: 60, maxLength: 100 }), (values) => {
    const records = values.map((value, index) => operation(`op-${index}`, value));
    const groups = [0, 1, 2].map((partition) => records.filter((_, index) => index % 3 === partition));
    const all = mergeDemoOperations(...groups);
    expect(mergeDemoOperations(groups[2], groups[0], groups[1])).toEqual(all);
    expect(mergeDemoOperations(mergeDemoOperations(groups[0], groups[1]), groups[2])).toEqual(all);
    expect(mergeDemoOperations(groups[0], mergeDemoOperations(groups[1], groups[2]))).toEqual(all);
    expect(mergeDemoOperations(all, all, all)).toEqual(all);
    const comments = records.map((entry) => ({ ...entry, trail: "T-checkout", kind: "comment" }));
    const oldest = comments.slice(0, 30), newest = comments.slice(30);
    expect(mergeDemoOperations(mergeDemoOperations(oldest), newest)).toEqual(mergeDemoOperations(comments));
    for (const trail of ["T-checkout", "T-search", "T-docs"]) {
      const local = all.filter((entry) => entry.trail === trail);
      expect(local.filter((entry) => entry.kind === "comment").length).toBeLessThanOrEqual(20);
      expect(local.filter((entry) => entry.kind !== "comment").length).toBeLessThanOrEqual(1);
    }
  }));
});

test("conflicting duplicate IDs resolve consistently in either delivery order", () => {
  const a = operation("duplicate", { text: "First" });
  const b = operation("duplicate", { text: "Second" });
  expect(mergeDemoOperations([a], [b])).toEqual(mergeDemoOperations([b], [a]));
  expect(mergeDemoOperations([a, b])).toHaveLength(1);
});

test("discussion preserves recorded reviewer text and distinguishes local plaintext notes", () => {
  const room = createDemoRoom({ storage: null, channel: null });
  const { trail, events } = walkthrough.gui.moments.proof;
  room.addComment(trail.id, '<img src=x onerror="alert(1)"> Check coupons.');
  const html = renderConsole("proof", walkthrough, { tool: "discuss", room: room.getSnapshot(trail.id), draft: "A draft" });
  expect(html).toContain("Keep the receipt rounding as is; finance reads those.");
  expect(html).toContain("Reviewer");
  expect(html).toContain("Recorded sample");
  expect(html).toContain("Local note");
  expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; Check coupons.");
  expect(html).not.toContain("<img src=x");
  expect(html).toContain("A draft</textarea>");
  expect(html).toContain('maxlength="1000"');
  expect(html).toContain("Browser storage is unavailable");
  expect(html).toContain("No agent is started or stopped");
  expect(html).not.toContain("online");
  expect(renderDiscussion(events, null)).not.toContain("<form");
  room.close();
});

test("the reader has discussion without forms or actions, and cross-trail snapshots cannot leak", () => {
  const room = createDemoRoom({ storage: null, channel: null });
  const trail = walkthrough.gui.moments.proof.trail;
  room.addComment(trail.id, "Private to this sample trail");
  room.claim(trail.id);
  const snapshot = room.getSnapshot(trail.id);
  const reader = renderConsole("proof", walkthrough, { tool: "discuss", room: snapshot, reader: true });
  expect(reader).toContain("Private to this sample trail");
  expect(reader).toContain("You hold demo control");
  expect(reader).not.toContain("<form");
  expect(reader).not.toContain("<button");
  expect(reader).not.toContain("<textarea");
  const rollback = renderConsole("rollback", walkthrough, { tool: "discuss", room: snapshot });
  expect(rollback).not.toContain("Private to this sample trail");
  expect(rollback).not.toContain("You hold demo control");
  room.close();
});
