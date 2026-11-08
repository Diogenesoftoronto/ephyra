/** Shared SSE is checked before each chunk and while idle. Closing it also cancels its producer. */
export async function forwardSharedRequest(
  request: Request,
  forward: (request: Request) => Response | Promise<Response>,
  allowed: () => Promise<boolean>,
  heartbeatMs = 1000,
): Promise<Response> {
  const abort = new AbortController();
  const signal = AbortSignal.any([request.signal, abort.signal]);
  const denied = () => Response.json({ error: "This workspace access has been revoked or changed." }, { status: 403 });
  if (!await allowed()) return denied();
  const response = await forward(new Request(request, { signal }));
  if (!await allowed()) {
    abort.abort();
    await response.body?.cancel().catch(() => {});
    return denied();
  }
  if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) return response;
  const reader = response.body.getReader();
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;
  let checking = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const finish = () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    request.signal.removeEventListener("abort", finish);
    abort.abort();
    void reader.cancel().catch(() => {});
    try { controller.close(); } catch { /* The downstream reader may have cancelled first. */ }
  };
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      request.signal.addEventListener("abort", finish, { once: true });
      if (request.signal.aborted) { finish(); return; }
      timer = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        void allowed().then((valid) => { if (!valid) finish(); }, finish).finally(() => { checking = false; });
      }, heartbeatMs);
    },
    async pull() {
      try {
        const next = await reader.read();
        if (closed) return;
        if (next.done || !await allowed()) { finish(); return; }
        if (!closed) controller.enqueue(next.value);
      } catch { finish(); }
    },
    cancel() { finish(); },
  });
  return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
}
