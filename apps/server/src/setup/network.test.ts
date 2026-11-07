import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";
import fc from "fast-check";
import {
  ConnectionError,
  createPublicHttpsFetch,
  isPublicAddress,
  parsePublicHttps,
  resolvePublicHttps,
  type PublicFetchOptions,
} from "./network.ts";

const publicLookup = async () => [{ address: "93.184.216.34", family: 4 as const }];

function transport(
  reply: {
    status?: number;
    headers?: Record<string, string | string[]>;
    body?: string;
    error?: string;
    hang?: boolean;
  } = {},
) {
  let captured: RequestOptions | undefined;
  let sent: unknown;
  let destroyed = false;
  const request: NonNullable<PublicFetchOptions["request"]> = (options, callback) => {
    captured = options;
    const stream = new EventEmitter() as ClientRequest;
    stream.destroy = (() => {
      destroyed = true;
      return stream;
    }) as ClientRequest["destroy"];
    stream.end = ((body: unknown) => {
      sent = body;
      queueMicrotask(() => {
        if (reply.error) {
          stream.emit("error", new Error(reply.error));
          return;
        }
        if (reply.hang) return;
        const source = new PassThrough();
        const response = source as unknown as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? { "content-type": "application/json" };
        callback(response);
        source.end(reply.body ?? '{"data":[]}');
      });
      return stream;
    }) as ClientRequest["end"];
    return stream;
  };
  return {
    request,
    get options() {
      return captured!;
    },
    get body() {
      return sent;
    },
    get destroyed() {
      return destroyed;
    },
  };
}

describe("public HTTPS destination validation", () => {
  test("rejects local protocols, credentials, local hostnames and normalized IP bypasses", () => {
    for (const input of [
      "http://example.com",
      "file:///etc/passwd",
      "git://example.com/repo",
      "ssh://example.com/repo",
      "https://user:secret@example.com/repo",
      "https://@example.com/repo",
      "https://localhost/repo",
      "https://server.internal/repo",
      "https://host/repo",
      "https://127.0.0.1/repo",
      "https://2130706433/repo",
      "https://0x7f000001/repo",
      "https://0177.0.0.1/repo",
      "https://127.1/repo",
      "https://[::1]/repo",
      "https://[::ffff:127.0.0.1]/repo",
      "https://[::ffff:7f00:1]/repo",
      "https://[fe80::1]/repo",
      "https://[fc00::1]/repo",
      "https://example.com/#secret",
      "https://example.com/\nrepo",
      "https://example.com\\@127.0.0.1/repo",
    ])
      expect(() => parsePublicHttps(input)).toThrow(ConnectionError);
  });

  test("rejects every RFC1918 and loopback member, not just network bases", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 255 }), fc.integer({ min: 0, max: 255 }), (a, b) => {
        for (const address of [
          `10.${a}.${b}.1`,
          `127.${a}.${b}.1`,
          `192.168.${a}.${b}`,
          `172.${16 + (a % 16)}.${b}.1`,
        ]) {
          expect(isPublicAddress(address)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  test("rejects reserved and transition address ranges", () => {
    for (const address of [
      "0.0.0.0",
      "100.64.1.1",
      "169.254.169.254",
      "192.0.2.3",
      "198.18.2.1",
      "198.51.100.2",
      "203.0.113.1",
      "224.0.0.1",
      "255.255.255.255",
      "::",
      "64:ff9b::7f00:1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "3fff::1",
      "ff02::1",
    ]) {
      expect(isPublicAddress(address)).toBe(false);
    }
    expect(isPublicAddress("93.184.216.34")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  test("rejects DNS with a private or malformed answer, including mixed records", async () => {
    for (const bad of [
      { address: "127.0.0.1", family: 4 as const },
      { address: "::ffff:7f00:1", family: 6 as const },
      { address: "93.184.216.34", family: 6 as const },
    ]) {
      await expect(
        resolvePublicHttps("https://api.example.com/v1/models", async () => [...(await publicLookup()), bad]),
      ).rejects.toMatchObject({ code: "private_destination" });
    }
    await expect(resolvePublicHttps("https://api.example.com", async () => [])).rejects.toMatchObject({
      code: "private_destination",
    });
  });

  test("redacts DNS failures and validates literals without DNS", async () => {
    await expect(
      resolvePublicHttps("https://api.example.com", async () => {
        throw new Error("token=do-not-return");
      }),
    ).rejects.toMatchObject({ code: "dns_failed", message: "The hostname could not be resolved." });
    const destination = await resolvePublicHttps("https://[2606:4700:4700::1111]/v1", async () => {
      throw new Error("must not resolve literals");
    });
    expect(destination.address).toEqual({ address: "2606:4700:4700::1111", family: 6 });
  });
});

describe("pinned HTTPS transport", () => {
  test("pins one checked address and preserves TLS hostname validation", async () => {
    let lookups = 0;
    const wire = transport({ headers: { "content-type": "application/json", "set-cookie": "private=secret" } });
    const fetcher = createPublicHttpsFetch({
      lookup: async () => {
        lookups++;
        return publicLookup();
      },
      request: wire.request,
    });
    const response = await fetcher("https://api.example.com:8443/v1/models?limit=1", {
      headers: { authorization: "Bearer fixture-key" },
    });
    expect(await response.json()).toEqual({ data: [] });
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(lookups).toBe(1);
    expect(wire.options).toMatchObject({
      hostname: "api.example.com",
      servername: "api.example.com",
      port: "8443",
      path: "/v1/models?limit=1",
      rejectUnauthorized: true,
      agent: false,
      family: 4,
    });
    const pinned = await new Promise((resolve, reject) =>
      wire.options.lookup!("api.example.com", {}, (error, address, family) =>
        error ? reject(error) : resolve({ address, family }),
      ),
    );
    expect(pinned).toEqual({ address: "93.184.216.34", family: 4 });
  });

  test("does not open a request for mixed public/private DNS", async () => {
    let opened = false;
    const fetcher = createPublicHttpsFetch({
      lookup: async () => [...(await publicLookup()), { address: "10.0.0.1", family: 4 }],
      request: () => {
        opened = true;
        throw new Error("must not connect");
      },
    });
    await expect(fetcher("https://api.example.com")).rejects.toMatchObject({ code: "private_destination" });
    expect(opened).toBe(false);
  });

  test("never follows redirects even when callers request them", async () => {
    const wire = transport({ status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } });
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup, request: wire.request })("https://api.example.com", {
        redirect: "follow",
      }),
    ).rejects.toMatchObject({ code: "redirect_refused" });
    expect(wire.destroyed).toBe(true);
  });

  test("forwards bounded JSON bodies and retains failed HTTP status for provider validation", async () => {
    const wire = transport({ status: 401, body: '{"error":"invalid credential"}' });
    const response = await createPublicHttpsFetch({ lookup: publicLookup, request: wire.request })(
      "https://api.example.com/v1/models",
      { method: "POST", body: "{}", headers: { "content-type": "application/json" } },
    );
    expect(response.status).toBe(401);
    expect(Buffer.from(wire.body as Uint8Array).toString()).toBe("{}");
    expect(wire.options.headers).toMatchObject({ "content-length": "2" });
  });

  test("rejects host overrides and unsupported bodies before opening a connection", async () => {
    for (const headers of [
      { host: "127.0.0.1" },
      { "proxy-authorization": "secret" },
      { "content-length": "999" },
    ] as Record<string, string>[]) {
      await expect(
        createPublicHttpsFetch({ lookup: publicLookup })("https://api.example.com", { headers }),
      ).rejects.toMatchObject({ code: "invalid_headers" });
    }
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup })("https://api.example.com", { body: new FormData() }),
    ).rejects.toMatchObject({ code: "invalid_body" });
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup, maxRequestBytes: 1 })("https://api.example.com", { body: "{}" }),
    ).rejects.toMatchObject({ code: "request_too_large" });
  });

  test("bounds both declared and streamed responses", async () => {
    for (const reply of [{ headers: { "content-length": "1000" }, body: "a" }, { body: "a".repeat(1000) }]) {
      const wire = transport(reply);
      await expect(
        createPublicHttpsFetch({ lookup: publicLookup, request: wire.request, maxResponseBytes: 10 })(
          "https://api.example.com",
        ),
      ).rejects.toMatchObject({ code: "response_too_large" });
      expect(wire.destroyed).toBe(true);
    }
  });

  test("times out, cancels, and redacts connection errors", async () => {
    const hanging = transport({ hang: true });
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup, request: hanging.request, timeoutMs: 5 })(
        "https://api.example.com",
      ),
    ).rejects.toMatchObject({ code: "timeout" });
    expect(hanging.destroyed).toBe(true);
    const controller = new AbortController();
    controller.abort();
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup })("https://api.example.com", { signal: controller.signal }),
    ).rejects.toMatchObject({ code: "aborted" });
    const broken = transport({ error: "Authorization: Bearer fixture-secret" });
    await expect(
      createPublicHttpsFetch({ lookup: publicLookup, request: broken.request })("https://api.example.com"),
    ).rejects.toMatchObject({ code: "network_error", message: "The endpoint could not be reached." });
  });
});
