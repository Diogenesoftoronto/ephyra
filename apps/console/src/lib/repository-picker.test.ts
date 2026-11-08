import { expect, test } from "bun:test";
import fc from "fast-check";
import { detectRepositorySource, listGitHubRepositories } from "./repository-picker.ts";

test("platform detection accepts exact hosts and retains native forge addresses", () => {
  expect(detectRepositorySource("https://github.com/team/repo")).toBe("github");
  expect(detectRepositorySource("https://github.com.attacker.test/team/repo")).toBeUndefined();
  expect(detectRepositorySource("rad:z123")).toBe("git");
  expect(detectRepositorySource("at://did:plc:abc/org.tangled.repo/xyz")).toBe("tangled");
});
test("public repository lookup omits credentials and rejects links from other accounts", async () => {
  let called = "";
  const request = (async (url, options) => {
    called = String(url);
    expect(options?.credentials).toBe("omit");
    expect(options?.referrerPolicy).toBe("no-referrer");
    return Response.json([
      { full_name: "Octocat/Hello-World", default_branch: "main", description: "Hello" },
      { full_name: "evil/repo", html_url: "https://evil.test" },
      { full_name: "octocat/secret", private: true },
      { full_name: "octocat/<script>" },
    ]);
  }) as typeof fetch;
  expect(await listGitHubRepositories("octocat", 1, new AbortController().signal, request)).toEqual([
    { name: "Octocat/Hello-World", url: "https://github.com/Octocat/Hello-World.git", branch: "main", description: "Hello" },
  ]);
  expect(called).toBe("https://api.github.com/users/octocat/repos?sort=updated&per_page=30&page=1");
});
test("untrusted owner text never becomes a second origin or path", async () => {
  await fc.assert(fc.asyncProperty(fc.string().filter(value => !/^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(value)), async owner => {
    let calls = 0;
    const request = (async () => { calls++; return Response.json([]); }) as typeof fetch;
    await expect(listGitHubRepositories(owner, 1, new AbortController().signal, request)).rejects.toThrow("username");
    expect(calls).toBe(0);
  }));
});
test("rate limits keep the direct-link recovery path", async () => {
  const request = (async () => new Response("", { status: 403 })) as typeof fetch;
  await expect(listGitHubRepositories("octocat", 1, new AbortController().signal, request)).rejects.toThrow("Paste a repository link");
});
