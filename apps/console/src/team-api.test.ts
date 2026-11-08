import { expect, test } from "bun:test";
import { ApiError, UnknownWriteOutcome } from "./api.ts";
import { invitationUrl, TeamClient } from "./team-api.ts";
import { EMPTY_TEAM_FIXTURE, FakeTeamApi, INVITED_WORKSPACE_FIXTURE, TEAM_FIXTURE } from "./fake/team.ts";

const input = { expectedVersion: 0, workspaceId: EMPTY_TEAM_FIXTURE.workspaceId, label: "Review partner", role: "approver" as const };
const token = "fixture-token-for-an-invitation";

test("team client binds invitation writes to the signed-in account and exact operation", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ team: TEAM_FIXTURE, token, invitationId: "fixture-id" });
  }) as typeof fetch;
  const api = new TeamClient("https://console.example", "session-token", fetcher, "did:plc:owner");
  expect(await api.invite(input, "team:stable-operation")).toEqual({ team: TEAM_FIXTURE, token, invitationId: "fixture-id" });
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.url.pathname).toBe("/v1/account/team/invitations");
  expect(call.init).toMatchObject({ method: "POST", credentials: "same-origin", cache: "no-store" });
  const headers = new Headers(call.init.headers);
  expect(headers.get("X-Ephyra-Account")).toBe("did:plc:owner");
  expect(headers.get("X-Ephyra-Workspace")).toBe(input.workspaceId);
  expect(headers.get("Authorization")).toBe("Bearer session-token");
  expect(headers.get("Idempotency-Key")).toBe("team:stable-operation");
  expect(JSON.parse(call.init.body as string)).toEqual(input);
});

test("team reads and invitation previews never consume invitations or send an operation key", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const preview = { workspace: INVITED_WORKSPACE_FIXTURE, expiresAt: "2026-11-15T12:00:00.000Z" };
  const fetcher = (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json(url.pathname.endsWith("/preview") ? preview
      : url.pathname.endsWith("/workspaces") ? [INVITED_WORKSPACE_FIXTURE] : TEAM_FIXTURE);
  }) as typeof fetch;
  const api = new TeamClient("https://console.example", "", fetcher, "did:plc:recipient");
  expect(await api.team()).toEqual(TEAM_FIXTURE);
  expect(await api.workspaces()).toEqual([INVITED_WORKSPACE_FIXTURE]);
  expect(await api.preview(token)).toEqual(preview);
  expect(calls.map((call) => call.init.method)).toEqual(["GET", "GET", "POST"]);
  expect(calls[2]!.url.pathname).toBe("/v1/account/team/preview");
  expect(calls[2]!.url.href).not.toContain(token);
  expect(JSON.parse(calls[2]!.init.body as string)).toEqual({ token });
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBeNull();
    expect(headers.get("Idempotency-Key")).toBeNull();
    expect(headers.get("X-Ephyra-Account")).toBe("did:plc:recipient");
  }
});

test("ambiguous team writes keep their operation key and never retry themselves", async () => {
  for (const failure of [
    async () => { throw new Error("lost response"); },
    async () => new Response("", { status: 503 }),
    async () => Response.json({ team: TEAM_FIXTURE }),
    async () => new Response("not json"),
  ]) {
    let calls = 0;
    const api = new TeamClient("https://console.example", "", (async () => { calls++; return failure(); }) as typeof fetch);
    try {
      await api.invite(input, "team:keep-this-key");
      throw new Error("Unexpected success");
    } catch (error) {
      expect(error).toBeInstanceOf(UnknownWriteOutcome);
      expect((error as UnknownWriteOutcome).operationKey).toBe("team:keep-this-key");
    }
    expect(calls).toBe(1);
  }
});

test("acceptance and revocation preserve exact payloads; a refused request is a definite error", async () => {
  const calls: { url: URL; init: RequestInit }[] = [];
  const api = new TeamClient("https://console.example", "", (async (url: URL, init: RequestInit) => {
    calls.push({ url, init });
    return Response.json({ error: "Invitation expired" }, { status: 410 });
  }) as typeof fetch);
  await expect(api.accept(token, "team:accept")).rejects.toMatchObject({ status: 410, detail: "Invitation expired" });
  expect(calls[0]!.url.pathname).toBe("/v1/account/team/accept");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ token });
  const revoke = { expectedVersion: 3, workspaceId: TEAM_FIXTURE.workspaceId, id: "storybook-viewer" };
  await expect(api.revoke(revoke, "team:revoke")).rejects.toBeInstanceOf(ApiError);
  expect(calls[1]!.url.pathname).toBe("/v1/account/team/revoke");
  expect(new Headers(calls[1]!.init.headers).get("X-Ephyra-Workspace")).toBe(revoke.workspaceId);
  expect(JSON.parse(calls[1]!.init.body as string)).toEqual(revoke);
});

test("invitation links keep tokens in the fragment, including reserved characters", () => {
  const url = new URL(invitationUrl("a/b?c=d#e%f", "https://console.example/nested/path?session=x"));
  expect(url.pathname).toBe("/app/");
  expect(url.search).toBe("");
  expect(url.hash).toBe("#/join/a%2Fb%3Fc%3Dd%23e%25f");
  expect(decodeURIComponent(url.hash.slice("#/join/".length))).toBe("a/b?c=d#e%f");
});

test("fictional invitation recovery returns the same token and current revoked state without duplication", async () => {
  const api = new FakeTeamApi({ initial: EMPTY_TEAM_FIXTURE, uncertainAfterSave: ["invite"] });
  await expect(api.invite(input, "story:create")).rejects.toBeInstanceOf(UnknownWriteOutcome);
  const saved = await api.team();
  expect(saved.invitations).toHaveLength(1);
  const recovered = await api.invite(input, "story:create");
  expect(recovered.invitationId).toBe(saved.invitations[0]!.id);
  const revoked = await api.revoke({ expectedVersion: saved.version, workspaceId: saved.workspaceId, id: recovered.invitationId! }, "story:revoke");
  const replay = await api.invite(input, "story:create");
  expect(replay.token).toBe(recovered.token);
  expect(replay.team).toEqual(revoked);
  expect(replay.team.invitations).toHaveLength(1);
  await expect(api.invite({ ...input, role: "viewer" }, "story:create")).rejects.toMatchObject({ status: 409 });
});

test("fictional preview does not join and uncertain acceptance is recovered with one grant", async () => {
  const api = new FakeTeamApi({ uncertainAfterSave: ["accept"] });
  const fixtureToken = "storybook-token-for-invite";
  expect((await api.preview(fixtureToken)).workspace).toEqual(INVITED_WORKSPACE_FIXTURE);
  expect(await api.workspaces()).toHaveLength(1);
  await expect(api.accept(fixtureToken, "story:join")).rejects.toBeInstanceOf(UnknownWriteOutcome);
  expect(await api.workspaces()).toHaveLength(2);
  expect(await api.accept(fixtureToken, "story:join")).toEqual(INVITED_WORKSPACE_FIXTURE);
  expect(await api.workspaces()).toHaveLength(2);
});
