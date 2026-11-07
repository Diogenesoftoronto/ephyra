// A shared sample room for tabs in this browser. No server, real presence, or agent responses.
// Comments are plaintext. Consumers must escape them when rendering HTML.
export const DEMO_ROOM_KEY = 'ephyra:sample-room:v1';
const MAX_COMMENTS = 20;
const MAX_TEXT = 1000;
const key = (value, max) => typeof value === 'string' && value.length <= max && /^[A-Za-z0-9:_-]+$/.test(value);
const compare = (a, b) => a.seq - b.seq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const uuid = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

function operation(value) {
  if (!value || typeof value !== 'object' || value.version !== 1) return null;
  if (!key(value.id, 96) || !key(value.actor, 96) || !key(value.trail, 100)) return null;
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) return null;
  if (!Number.isSafeInteger(value.at) || value.at < 0 || value.at > 8640000000000000) return null;
  if (!['comment', 'claim', 'release'].includes(value.kind)) return null;
  if (value.kind === 'comment' && (typeof value.text !== 'string' || !value.text.trim() || value.text.length > MAX_TEXT)) return null;
  const result = {
    version: 1, id: value.id, actor: value.actor, trail: value.trail,
    seq: value.seq, at: value.at, kind: value.kind,
  };
  if (value.kind === 'comment') result.text = value.text;
  return result;
}

/** Merge stable operation IDs idempotently. Retain the newest 20 comments and control per trail. */
export function mergeDemoOperations(...batches) {
  const unique = new Map();
  for (const batch of batches) {
    if (!Array.isArray(batch)) continue;
    for (const value of batch) {
      const item = operation(value);
      if (!item) continue;
      const existing = unique.get(item.id);
      // Corrupt conflicting IDs also resolve deterministically, independent of arrival order.
      if (!existing || JSON.stringify(item) > JSON.stringify(existing)) unique.set(item.id, item);
    }
  }
  const trails = new Map();
  for (const item of [...unique.values()].sort(compare)) {
    let trail = trails.get(item.trail);
    if (!trail) trails.set(item.trail, trail = { comments: [], control: null });
    if (item.kind === 'comment') {
      trail.comments.push(item);
      if (trail.comments.length > MAX_COMMENTS) trail.comments.shift();
    } else trail.control = item;
  }
  return [...trails.values()].flatMap(({ comments, control }) => control ? [...comments, control] : comments).sort(compare);
}

function decode(value) {
  try {
    if (typeof value === 'string') {
      if (value.length > 2_000_000) return [];
      value = JSON.parse(value);
    }
    if (!value || value.version !== 1 || !Array.isArray(value.operations) || value.operations.length > 2000) return [];
    return mergeDemoOperations(value.operations);
  } catch { return []; }
}

function browserStorage() {
  try { return typeof window === 'undefined' ? null : window.localStorage; } catch { return null; }
}

/**
 * createDemoRoom({ storage?, channel? })
 * Omit adapters for browser localStorage/BroadcastChannel; pass null to disable them.
 * subscribe((trailId, snapshot) => ...) returns an unsubscribe function; it does not emit immediately.
 * Mutations return a stable operation ID (null when an already-satisfied control action is a no-op).
 * close() detaches listeners and closes a channel created by this room, not an injected channel.
 */
export function createDemoRoom(options = {}) {
  const storage = Object.hasOwn(options, 'storage') ? options.storage : browserStorage();
  // CLI renderers may expose a partial window shim. Subscribe only to a complete event target,
  // and retain that target so teardown does not depend on a later replacement of global window.
  const browserEvents = typeof window !== 'undefined'
    && typeof window.addEventListener === 'function' && typeof window.removeEventListener === 'function' ? window : null;
  const viewerId = uuid();
  let ownsChannel = false;
  let channel = options.channel ?? null;
  if (!Object.hasOwn(options, 'channel') && browserEvents && typeof BroadcastChannel === 'function') {
    try { channel = new BroadcastChannel(DEMO_ROOM_KEY); ownsChannel = true; } catch { /* Memory/storage still work. */ }
  }
  let persistence = storage ? 'browser' : 'memory';
  let operations = [];
  let clock = 0;
  let closed = false;
  const listeners = new Set();
  const envelope = () => ({ version: 1, operations });
  const read = () => {
    if (!storage) return [];
    try { return decode(storage.getItem(DEMO_ROOM_KEY)); }
    catch { persistence = 'memory'; return []; }
  };
  const persist = () => {
    if (!storage) return;
    try {
      const serialized = JSON.stringify(envelope());
      if (storage.getItem(DEMO_ROOM_KEY) !== serialized) storage.setItem(DEMO_ROOM_KEY, serialized);
      persistence = 'browser';
    } catch { persistence = 'memory'; }
  };
  const assertTrail = (trail) => { if (!key(trail, 100)) throw new TypeError('A valid trail ID is required.'); };
  const assertOpen = () => { if (closed) throw new Error('The sample room is closed.'); };

  function getSnapshot(trailId) {
    assertTrail(trailId);
    const items = operations.filter((item) => item.trail === trailId);
    const control = items.find((item) => item.kind !== 'comment');
    const ownerId = control?.kind === 'claim' ? control.actor : null;
    return Object.freeze({
      scope: 'local-demo', trailId, viewerId, persistence,
      claimed: ownerId !== null, ownerId, isOwner: ownerId === viewerId,
      comments: Object.freeze(items.filter((item) => item.kind === 'comment').map((item) => Object.freeze({
        id: item.id, authorId: item.actor, text: item.text, at: item.at,
      }))),
    });
  }

  function merge(incoming, announce = true) {
    const before = operations;
    const joined = mergeDemoOperations(operations, incoming, read());
    if (JSON.stringify(joined) === JSON.stringify(before)) {
      // A delayed storage event may have overwritten the durable copy with an older snapshot.
      persist();
      return false;
    }
    operations = joined;
    clock = operations.reduce((max, item) => Math.max(max, item.seq), clock);
    persist();
    if (announce) {
      const trails = new Set([...before, ...operations].map((item) => item.trail));
      for (const trail of trails) {
        const previous = before.filter((item) => item.trail === trail);
        const next = operations.filter((item) => item.trail === trail);
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        for (const listener of listeners) listener(trail, getSnapshot(trail));
      }
    }
    return true;
  }

  function write(trail, kind, text) {
    assertOpen(); assertTrail(trail);
    merge(read());
    if (clock >= Number.MAX_SAFE_INTEGER) throw new Error('The sample room clock is exhausted.');
    const item = { version: 1, id: uuid(), actor: viewerId, trail, seq: ++clock, at: Date.now(), kind };
    if (kind === 'comment') item.text = text;
    merge([item]);
    try { channel?.postMessage(envelope()); } catch { /* No network fallback or claimed delivery. */ }
    return item.id;
  }

  const onMessage = (event) => { if (!closed) merge(decode(event.data)); };
  const onStorage = (event) => {
    if (!closed && event.key === DEMO_ROOM_KEY && (!event.storageArea || event.storageArea === storage)) merge(decode(event.newValue));
  };
  merge(read(), false);
  channel?.addEventListener?.('message', onMessage);
  if (storage && browserEvents) browserEvents.addEventListener('storage', onStorage);

  return {
    getSnapshot,
    subscribe(listener) {
      assertOpen();
      if (typeof listener !== 'function') throw new TypeError('A subscriber must be a function.');
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addComment(trail, text) {
      if (typeof text !== 'string' || !text.trim() || text.length > MAX_TEXT) {
        throw new RangeError(`Write a comment between 1 and ${MAX_TEXT} characters.`);
      }
      return write(trail, 'comment', text.trim());
    },
    claim(trail) {
      assertOpen(); assertTrail(trail); merge(read());
      if (getSnapshot(trail).isOwner) return null;
      return write(trail, 'claim');
    },
    release(trail) {
      assertOpen(); assertTrail(trail); merge(read());
      if (!getSnapshot(trail).isOwner) return null;
      return write(trail, 'release');
    },
    close() {
      if (closed) return;
      closed = true; listeners.clear();
      channel?.removeEventListener?.('message', onMessage);
      if (ownsChannel) channel.close();
      if (storage && browserEvents) browserEvents.removeEventListener('storage', onStorage);
    },
  };
}
