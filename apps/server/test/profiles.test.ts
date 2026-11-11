import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import { personLabel } from "@ephyra/core";
import { ProfileDirectory, portalProfileUrl, profileFromAccount, validAvatarUrl } from "../src/auth/profiles.ts";
import { SignInError, type NotOrganicSignIn } from "../src/auth/notorganic.ts";

const DID = "did:plc:approver123";
const CID = "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const AVATAR = `https://pds.notorganic.test/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(DID)}&cid=${CID}`;
const body = (account: Record<string, unknown>) => ({ account: { did: DID, ...account } });

function stub(answer: () => Promise<unknown>, image?: () => Promise<Response>) {
  const calls: string[] = [];
  const signIn = {
    account: async (did: string) => { calls.push(did); return answer(); },
    fetchPublic: async (url: string) => { calls.push(url); return image ? image() : new Response(null, { status: 404 }); },
  } as unknown as NotOrganicSignIn;
  return { signIn, calls };
}

describe("profiles", () => {
  test("only the authority's fields for the requested DID are used", () => {
    const { profile, avatarUrl } = profileFromAccount(DID, body({ handle: "dio.pds.notorganic.info", displayName: "Dio", avatarUrl: AVATAR }), "t");
    expect(profile).toEqual({ did: DID, status: "verified", handle: "dio.pds.notorganic.info", displayName: "Dio", avatar: true, checkedAt: "t" });
    expect(avatarUrl).toBe(AVATAR);
    expect(profileFromAccount(DID, { account: { did: "did:plc:other", handle: "x.test" } }, "t").profile.status).toBe("unavailable");
    expect(profileFromAccount(DID, body({ handle: "not a handle!" }), "t").profile.handle).toBeNull();
  });
  test("avatar URLs must be a getBlob for this DID; anything else is dropped", () => {
    expect(validAvatarUrl(AVATAR, DID)).toBe(AVATAR);
    expect(validAvatarUrl(AVATAR, "did:plc:someoneelse")).toBeNull();
    expect(validAvatarUrl(AVATAR.replace("https:", "http:"), DID)).toBeNull();
    expect(validAvatarUrl(`${AVATAR}&extra=1`, DID)).toBeNull();
    expect(validAvatarUrl("https://cdn.example/avatar/did:plc:approver123.png", DID)).toBeNull();
    fc.assert(fc.property(fc.webUrl(), (url) => {
      const out = validAvatarUrl(url, DID);
      if (out) expect(new URL(out).pathname).toBe("/xrpc/com.atproto.sync.getBlob");
    }));
  });
  test("no session or an outage is unavailable, never a guessed label; a verified profile survives an outage", async () => {
    let fail = true;
    let now = 0;
    const { signIn } = stub(async () => { if (fail) throw new SignInError(401, "no session"); return body({ handle: "dio.test", displayName: null, avatarUrl: null }); });
    const directory = new ProfileDirectory(signIn, { now: () => now, portalUrl: portalProfileUrl("https://id.notorganic.info/authorize") });
    const missing = await directory.get(DID);
    expect(missing.status).toBe("unavailable");
    expect(personLabel(missing)).toBe("Unverified account");
    fail = false;
    expect(personLabel(await directory.get(DID, true))).toBe("@dio.test");
    fail = true;
    now = 11 * 60_000;
    expect((await directory.get(DID)).status).toBe("verified");
    expect((await directory.own(DID, false)).manageUrl).toBe("https://id.notorganic.info/?view=profile");
  });
  test("the avatar proxy serves bounded images only, fetched from the validated URL", async () => {
    const png = new Uint8Array([137, 80, 78, 71]);
    const { signIn, calls } = stub(async () => body({ handle: "dio.test", avatarUrl: AVATAR }),
      async () => new Response(png, { headers: { "content-type": "image/png" } }));
    const directory = new ProfileDirectory(signIn);
    expect((await directory.avatar(DID))?.type).toBe("image/png");
    expect(calls).toContain(AVATAR);
    const html = stub(async () => body({ avatarUrl: AVATAR }), async () => new Response("<script>", { headers: { "content-type": "text/html" } }));
    expect(await new ProfileDirectory(html.signIn).avatar(DID)).toBeNull();
    const huge = stub(async () => body({ avatarUrl: AVATAR }), async () => new Response(new Uint8Array(1_000_001), { headers: { "content-type": "image/png" } }));
    expect(await new ProfileDirectory(huge.signIn).avatar(DID)).toBeNull();
  });
  test("an oversized streaming avatar is cancelled before reading the rest of its body", async () => {
    let chunks = 0;
    let cancelled = false;
    const image = new ReadableStream<Uint8Array>({
      pull(controller) { chunks++; controller.enqueue(new Uint8Array(600_000)); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    const f = stub(async () => body({ avatarUrl: AVATAR }), async () => new Response(image, { headers: { "content-type": "image/png" } }));
    expect(await new ProfileDirectory(f.signIn).avatar(DID)).toBeNull();
    expect(chunks).toBe(2);
    expect(cancelled).toBe(true);
  });
});
