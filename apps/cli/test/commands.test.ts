import { test, expect, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main } from "../src/commands/cli.ts";

async function withTransport(run: (requests: string[]) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-command-"));
  const env = {
    EPHYRA_CREDENTIALS: join(directory, "credentials.json"), EPHYRA_URL: "https://offline.example",
    EPHYRA_API_TOKEN: "test-token", EPHYRA_PRINCIPAL: "test-reviewer",
  };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests: string[] = [];
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  const transport = (async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json([]);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: transport });
  const output = spyOn(console, "log").mockImplementation(() => {});
  try { await run(requests); }
  finally {
    Object.defineProperty(globalThis, "fetch", fetchDescriptor); output.mockRestore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("inline --name=value filters, as shell completion inserts them, reach the API like spaced ones", () => withTransport(async requests => {
  for (const args of [["runs", "--status", "failed"], ["runs", "--status=failed"]]) {
    requests.length = 0;
    await main([...args, "--json"]);
    expect(requests).toEqual(["https://offline.example/v1/runs?status=failed"]);
  }
  for (const args of [["quests", "--state", "ready"], ["quests", "--state=ready"], ["trails", "--state=ready"]]) {
    requests.length = 0;
    await main([...args, "--json"]);
    expect(requests).toEqual(["https://offline.example/v1/trails?state=ready"]);
  }
  requests.length = 0;
  await main(["runs", "--status=done", "--limit=5", "--json"]);
  expect(requests).toEqual(["https://offline.example/v1/runs?status=done&limit=5"]);
  // An empty inline value is no filter, and a value containing = is kept whole.
  requests.length = 0;
  await main(["runs", "--status=", "--json"]);
  expect(requests).toEqual(["https://offline.example/v1/runs"]);
  requests.length = 0;
  await main(["quests", "--state=a=b", "--json"]);
  expect(requests).toEqual(["https://offline.example/v1/trails?state=a%3Db"]);
}));

async function checkAliases() {
  const directory = await mkdtemp(join(tmpdir(), "ephyra-command-"));
  const env = {
    EPHYRA_CREDENTIALS: join(directory, "credentials.json"), EPHYRA_URL: "https://offline.example",
    EPHYRA_API_TOKEN: "test-token", EPHYRA_PRINCIPAL: "test-reviewer",
  };
  const before = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const requests: { url: string; method: string; authorization: string | null }[] = [];
  const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  const transport = (async (input, init) => {
    requests.push({ url: String(input), method: init?.method ?? "GET", authorization: new Headers(init?.headers).get("authorization") });
    return Response.json([]);
  }) as typeof fetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, writable: true, value: transport });
  const output = spyOn(console, "log").mockImplementation(() => {});
  try {
    for (const name of ["quests", "trails"]) await main([name, "--state", "closed", "--json"]);
    expect(requests.map(request => request.url)).toEqual([
      "https://offline.example/v1/trails?state=closed", "https://offline.example/v1/trails?state=closed",
    ]);
    expect(requests.every(request => request.method === "GET" && request.authorization === "Bearer test-token")).toBe(true);
    expect(output.mock.calls).toEqual([["[]"], ["[]"]]);
  } finally {
    Object.defineProperty(globalThis, "fetch", fetchDescriptor); output.mockRestore();
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
}

test("quests and the existing trails alias read the same authenticated API", checkAliases);
test("command transport mocking preserves fetch when the host exposes it through an accessor", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "fetch")!;
  const originalFetch = fetch;
  const getter = () => originalFetch;
  Object.defineProperty(globalThis, "fetch", { configurable: true, enumerable: true, get: getter });
  try {
    await checkAliases();
    expect(Object.getOwnPropertyDescriptor(globalThis, "fetch")!.get).toBe(getter);
  } finally { Object.defineProperty(globalThis, "fetch", original); }
});
