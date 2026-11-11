// Display identities from the Not Organic account authority. Ephyra never guesses a handle, never sends a DID to a
// third-party avatar service, and never edits profiles: the Not Organic portal owns those changes.
import type { OwnProfile, PersonProfile } from "@ephyra/core";
import { SignInError, type NotOrganicSignIn } from "./notorganic.ts";

const TTL_MS = 10 * 60_000;
const MAX_AVATAR_BYTES = 1_000_000;
const text = (v: unknown) => typeof v === "string" && v.trim() && v.length <= 256 && !/[\u0000-\u001f]/.test(v) ? v.trim() : null;
const HANDLE = /^[a-z0-9][a-z0-9.-]{0,252}[a-z0-9]$/i;

/** Same rules the Not Organic gateway applies before returning a public profile: a getBlob URL for this DID only. */
export function validAvatarUrl(value: unknown, did: string): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash) return null;
    if (url.pathname !== "/xrpc/com.atproto.sync.getBlob" || [...url.searchParams].length !== 2) return null;
    if (url.searchParams.get("did") !== did || !/^[a-zA-Z0-9]{20,200}$/.test(url.searchParams.get("cid") ?? "")) return null;
    return url.href;
  } catch {
    return null;
  }
}

/** Parse the authority's `/v1/account` body. Only fields bound to the requested DID are used. */
export function profileFromAccount(did: string, body: unknown, checkedAt: string): { profile: PersonProfile; avatarUrl: string | null } {
  const account = (body as { account?: Record<string, unknown> } | null)?.account;
  if (!account || account.did !== did) return { profile: unavailable(did), avatarUrl: null };
  const handle = text(account.handle);
  const avatarUrl = validAvatarUrl(account.avatarUrl, did);
  return {
    profile: { did, status: "verified", handle: handle && HANDLE.test(handle) ? handle : null, displayName: text(account.displayName), avatar: avatarUrl !== null, checkedAt },
    avatarUrl,
  };
}
export const unavailable = (did: string): PersonProfile => ({ did, status: "unavailable", handle: null, displayName: null, avatar: false, checkedAt: null });

export class ProfileDirectory {
  private cache = new Map<string, { at: number; profile: PersonProfile; avatarUrl: string | null }>();
  private avatars = new Map<string, { at: number; bytes: Uint8Array; type: string }>();
  constructor(
    private readonly signIn: NotOrganicSignIn,
    private readonly opts: { portalUrl?: string | null; now?: () => number } = {},
  ) {}
  private now() { return this.opts.now?.() ?? Date.now(); }

  /** Reads one account. A missing Ephyra session or an authority outage is "unavailable", never a guessed name. */
  async get(did: string, fresh = false): Promise<PersonProfile> {
    const hit = this.cache.get(did);
    if (hit && !fresh && this.now() - hit.at < TTL_MS) return hit.profile;
    try {
      const parsed = profileFromAccount(did, await this.signIn.account(did), new Date(this.now()).toISOString());
      this.cache.set(did, { at: this.now(), ...parsed });
      return parsed.profile;
    } catch (error) {
      if (!(error instanceof SignInError) && !(error instanceof TypeError)) throw error;
      // Keep a previously verified profile rather than replacing it with nothing during a short outage.
      return hit?.profile ?? unavailable(did);
    }
  }
  async own(did: string, fresh: boolean): Promise<OwnProfile> {
    return { ...(await this.get(did, fresh)), manageUrl: this.opts.portalUrl ?? null };
  }
  async many(dids: readonly string[]): Promise<PersonProfile[]> {
    return Promise.all([...new Set(dids)].slice(0, 100).map((did) => this.get(did)));
  }
  /** Proxies the avatar so the browser never contacts a PDS with the DID. Only images, bounded. */
  async avatar(did: string): Promise<{ bytes: Uint8Array; type: string } | null> {
    const cached = this.avatars.get(did);
    if (cached && this.now() - cached.at < TTL_MS) return cached;
    await this.get(did);
    const url = this.cache.get(did)?.avatarUrl;
    if (!url) return null;
    const res = await this.signIn.fetchPublic(url).catch(() => null);
    const type = res?.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
    if (!res?.ok || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(type)) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.byteLength || bytes.byteLength > MAX_AVATAR_BYTES) return null;
    const value = { at: this.now(), bytes, type };
    this.avatars.set(did, value);
    return value;
  }
}

/** The portal's profile view. Derived from the configured authorization origin; null when it cannot be derived. */
export function portalProfileUrl(authorizationUrl: string): string | null {
  try {
    const url = new URL("/", authorizationUrl);
    url.searchParams.set("view", "profile");
    return url.href;
  } catch {
    return null;
  }
}
