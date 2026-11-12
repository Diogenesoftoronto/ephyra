// An in-memory GitHub / GitLab / Forgejo API, shaped like the real REST responses Ephyra reads.
// Tests inject its fetch; nothing reaches the network.
import type { HostedProvider } from "../../hosted";

type Pr = { number: number; head: string; base: string; title: string; body: string; state: "open" | "closed";
  merged: boolean; headSha: string; mergeSha: string | null; updatedAt: string };

export type FakeForge = {
  fetch: typeof fetch;
  prs: Pr[];
  requests: { method: string; url: string; authorization: string | null; body: string | null }[];
  /** Fail the next request matching method+path fragment with this status, or throw (status 0) to simulate a timeout. */
  failNext: (method: string, fragment: string, status: number, headers?: Record<string, string>) => void;
  setHeadSha: (head: string, sha: string) => void;
  merge: (number: number, mergeSha: string) => void;
  reviews: Record<number, unknown[]>;
  comments: Record<number, unknown[]>;
  ciState: string | null;
};

export function fakeForge(provider: HostedProvider, origin: string, owner = "team"): FakeForge {
  const prs: Pr[] = [];
  const requests: FakeForge["requests"] = [];
  const failures: { method: string; fragment: string; status: number; headers?: Record<string, string> }[] = [];
  const reviews: Record<number, unknown[]> = {};
  const comments: Record<number, unknown[]> = {};
  const heads = new Map<string, string>();
  let clock = Date.parse("2026-11-12T00:00:00Z");
  const now = () => new Date(clock += 1000).toISOString();
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
  const web = (n: number) => provider === "gitlab" ? `${origin}/team/project/-/merge_requests/${n}` : `${origin}/team/project/pull/${n}`;
  const show = (pr: Pr) => provider === "gitlab"
    ? { iid: pr.number, web_url: web(pr.number), state: pr.merged ? "merged" : pr.state === "open" ? "opened" : "closed",
      source_branch: pr.head, target_branch: pr.base, sha: pr.headSha, merge_commit_sha: pr.mergeSha, updated_at: pr.updatedAt,
      head_pipeline: forge.ciState ? { status: forge.ciState } : null }
    : { number: pr.number, html_url: web(pr.number), state: pr.state, merged: pr.merged, merged_at: pr.merged ? pr.updatedAt : null,
      head: { ref: pr.head, sha: pr.headSha }, base: { ref: pr.base }, merge_commit_sha: pr.mergeSha, updated_at: pr.updatedAt };

  const forge: FakeForge = {
    prs, requests, reviews, comments, ciState: null,
    failNext: (method, fragment, status, headers) => failures.push({ method, fragment, status, headers }),
    setHeadSha: (head, sha) => heads.set(head, sha),
    merge: (number, mergeSha) => {
      const pr = prs.find((p) => p.number === number)!;
      Object.assign(pr, { merged: true, state: "closed", mergeSha, updatedAt: now() });
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const method = init?.method ?? "GET";
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : null;
      requests.push({ method, url: url.toString(), authorization: headers.get("authorization"), body });
      const failure = failures.findIndex((f) => f.method === method && url.pathname.includes(f.fragment));
      if (failure >= 0) {
        const [f] = failures.splice(failure, 1);
        if (f!.status === 0) throw new DOMException("The operation timed out.", "TimeoutError");
        return new Response(JSON.stringify({ message: f!.status === 403 ? "API rate limit exceeded" : "nope" }),
          { status: f!.status, headers: f!.headers });
      }
      const path = url.pathname;
      const kind = provider === "gitlab" ? "merge_requests" : "pulls";
      const m = new RegExp(`/(?:${kind})/(\\d+)(/[a-z]+)?$`).exec(path);
      const one = m ? prs.find((p) => p.number === Number(m[1])) : undefined;
      if (method === "GET" && path.endsWith(`/${kind}`)) {
        let list = [...prs].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const state = url.searchParams.get("state");
        if (state === "open" || state === "opened") list = list.filter((p) => p.state === "open");
        const head = url.searchParams.get("head") ?? url.searchParams.get("source_branch");
        if (head) list = list.filter((p) => p.head === head.replace(`${owner}:`, ""));
        return json(list.map(show));
      }
      if (method === "POST" && path.endsWith(`/${kind}`)) {
        const input = JSON.parse(body!);
        const head = input.head ?? input.source_branch;
        if (prs.some((p) => p.head === head && p.state === "open")) return json({ message: "exists" }, 422);
        const pr: Pr = { number: prs.length + 1, head, base: input.base ?? input.target_branch, title: input.title,
          body: input.body ?? input.description, state: "open", merged: false, headSha: heads.get(head) ?? "0".repeat(40), mergeSha: null,
          updatedAt: now() };
        prs.push(pr);
        return json(show(pr), 201);
      }
      if (one && !m![2] && method === "GET") return json(show(one));
      if (one && !m![2] && (method === "PATCH" || method === "PUT")) {
        Object.assign(one, { state: "closed", updatedAt: now() });
        return json(show(one));
      }
      if (one && m![2] === "/reviews") return json(reviews[one.number] ?? []);
      if (one && m![2] === "/approvals") return json({ approved_by: reviews[one.number] ?? [] });
      if (one && m![2] === "/notes") return json(comments[one.number] ?? []);
      const issue = /\/issues\/(\d+)\/comments$/.exec(path);
      if (issue) return json(comments[Number(issue[1])] ?? []);
      if (/\/commits\/[0-9a-f]+\/status$/.test(path)) return json({ state: forge.ciState });
      return json({ message: "not found" }, 404);
    }) as typeof fetch,
  };
  return forge;
}
