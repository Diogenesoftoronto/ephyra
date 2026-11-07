import { expect, test } from "bun:test";
import type { ServiceProfile, Trail } from "@ephyra/core";
import { ArtifactStore } from "./cas.ts";
import { NotOrganicSandboxRunner } from "./notorganic.ts";

test("Not Organic sends one script and polls to completion", async () => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = async (input: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init });
    return Response.json(calls.length === 1 ? { id: "run/1", status: "queued" } :
      { id: "run/1", status: "succeeded", exit_code: 0, stdout: "ok" });
  };
  const profile: ServiceProfile = { name: "p", digest: "x", network: "none", readOnlyProd: true, credentials: [],
    limits: { cpu: 1, memoryMb: 128, diskMb: 100, timeoutS: 30 } };
  const runner = new NotOrganicSandboxRunner({ baseUrl: "https://example.test", projectId: "project", maxCostMicrousd: 100,
    fetch: fakeFetch, cas: new ArtifactStore("/unused"), pollMs: 1 });
  const handle = await runner.allocate({ trail: { id: "t" } as Trail, attempt: 1, repoUrl: "repo", commit: "sha", profile });
  await runner.writeFile(handle, "task.py", "print(1)");
  const output = [];
  for await (const item of runner.exec(handle, ["python", "task.py"], { deadlineMs: 5000 })) output.push(item);
  expect(JSON.parse(String(calls[0]!.init!.body))).toEqual({ project_id: "project", code: "print(1)",
    language: "python", filename: "task.py", max_cost_microusd: 100 });
  expect(new Headers(calls[0]!.init!.headers).get("idempotency-key")).toBeTruthy();
  expect(calls[1]!.url).toBe("https://example.test/v1/sandbox/runs/run%2F1");
  expect(output).toContainEqual({ stream: "stdout", chunk: "ok" });
  expect(output.some((x) => "exit" in x && x.exit === 0)).toBe(true);
  await runner.destroy(handle);
});
