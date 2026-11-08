const KEY = "ephyra.pending-invitation";
const MAX_AGE = 30 * 60_000;

export function invitationToken(hash: string): string | null {
  if (!hash.startsWith("#/join/")) return null;
  try {
    const token = decodeURIComponent(hash.slice(7));
    return token.length >= 16 && token.length <= 2048 && !/[\s/?#]/.test(token) ? token : null;
  } catch { return null; }
}

/** A short-lived, tab-only handoff through OAuth. Never sent in request URLs or telemetry. */
export function pendingInvitation(hash: string, storage: Storage, now = Date.now()): string | null {
  const token = invitationToken(hash);
  try {
    if (token) {
      storage.setItem(KEY, JSON.stringify({ token, at: now }));
      return token;
    }
    if (hash.startsWith("#/join/")) { storage.removeItem(KEY); return null; }
    const saved = JSON.parse(storage.getItem(KEY) ?? "null");
    if (saved && typeof saved.at === "number" && now >= saved.at && now - saved.at < MAX_AGE
      && typeof saved.token === "string" && invitationToken(`#/join/${encodeURIComponent(saved.token)}`)) return saved.token;
    storage.removeItem(KEY);
  } catch { /* An invitation in the current URL still works without storage. */ }
  return token;
}

export function forgetInvitation(storage: Storage) {
  try { storage.removeItem(KEY); } catch { /* Memory-only connection. */ }
}
