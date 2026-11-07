// Public destinations only. Resolve once per request, then pin that address while retaining TLS hostname verification.
import { lookup as dnsLookup } from "node:dns/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { isIP } from "node:net";
import type { ClientRequest, IncomingMessage } from "node:http";

export class ConnectionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConnectionError";
  }
}

export type PublicAddress = { address: string; family: 4 | 6 };
export type PublicLookup = (hostname: string) => Promise<PublicAddress[]>;
export type PublicDestination = { url: URL; address: PublicAddress };

const invalid = () =>
  new ConnectionError("invalid_url", "Use an HTTPS URL without embedded credentials or a fragment.");

/** Reject non-public address space, including IPv4 embedded in IPv6 transition mechanisms. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if ((a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)) return false;
    if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6 || address.includes("%") || address.includes(".")) return false;
  const [first = 0, second = 0] = address
    .split(":")
    .slice(0, 2)
    .map((part) => parseInt(part || "0", 16));
  // Only global unicast 2000::/3; this excludes mapped, local, multicast and NAT64 addresses.
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (second < 0x0200 || second === 0x0db8)) return false;
  if (first === 0x2002 || first === 0x3fff) return false;
  return true;
}

export function parsePublicHttps(input: string): URL {
  if (input.length > 4096 || /[\s\u0000-\u001f\u007f\\]/.test(input) || input.includes("#")) throw invalid();
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw invalid();
  }
  if (url.protocol !== "https:" || url.username || url.password || /^https:\/\/[^/]*@/i.test(input)) throw invalid();
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (!hostname || hostname === "localhost" || /\.(?:localhost|local|internal|invalid|test)$/.test(hostname)) {
    throw new ConnectionError("private_destination", "Use a repository or provider reachable on the public internet.");
  }
  if (isIP(hostname) && !isPublicAddress(hostname)) {
    throw new ConnectionError("private_destination", "Private network addresses are not allowed.");
  }
  if (!isIP(hostname) && !hostname.includes(".")) {
    throw new ConnectionError("private_destination", "Use a fully qualified public hostname.");
  }
  return url;
}

const systemLookup: PublicLookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map(({ address, family }) => ({
    address,
    family: family as 4 | 6,
  }));

export async function resolvePublicHttps(
  input: string,
  lookup: PublicLookup = systemLookup,
): Promise<PublicDestination> {
  const url = parsePublicHttps(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const literalFamily = isIP(hostname);
    const addresses = literalFamily
      ? [{ address: hostname, family: literalFamily as 4 | 6 }]
      : await Promise.race([
          lookup(hostname),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new ConnectionError("dns_timeout", "The hostname lookup timed out.")),
              5000,
            );
          }),
        ]);
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address) || isIP(item.address) !== item.family)
    ) {
      throw new ConnectionError(
        "private_destination",
        "This hostname does not resolve exclusively to public addresses.",
      );
    }
    return { url, address: addresses.find((item) => item.family === 4) ?? addresses[0]! };
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError("dns_failed", "The hostname could not be resolved.");
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type RequestFactory = (options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export type PublicFetchOptions = {
  lookup?: PublicLookup;
  request?: RequestFactory;
  timeoutMs?: number;
  maxResponseBytes?: number;
  maxRequestBytes?: number;
};

/** Buffered JSON/API transport: no redirects, proxy environment, ambient credentials, cookies, or unbounded bodies. */
export function createPublicHttpsFetch(options: PublicFetchOptions = {}) {
  return async (input: string, init: RequestInit = {}): Promise<Response> => {
    if (init.signal?.aborted) throw new ConnectionError("aborted", "The connection was cancelled.");
    const { url, address } = await resolvePublicHttps(input, options.lookup);
    if (init.signal?.aborted) throw new ConnectionError("aborted", "The connection was cancelled.");
    let headers: Headers;
    try {
      headers = new Headers(init.headers);
    } catch {
      throw new ConnectionError("invalid_headers", "The request contains an invalid header.");
    }
    for (const name of [
      "host",
      "proxy-authorization",
      "connection",
      "upgrade",
      "transfer-encoding",
      "content-length",
    ]) {
      if (headers.has(name))
        throw new ConnectionError("invalid_headers", "The request contains a reserved transport header.");
    }
    const body =
      init.body == null
        ? undefined
        : typeof init.body === "string"
          ? Buffer.from(init.body)
          : init.body instanceof Uint8Array
            ? Buffer.from(init.body)
            : null;
    if (body === null)
      throw new ConnectionError("invalid_body", "This connection supports text and byte request bodies only.");
    if (body && body.byteLength > (options.maxRequestBytes ?? 4_000_000)) {
      throw new ConnectionError("request_too_large", "The request exceeds the connection size limit.");
    }
    const method = (init.method ?? "GET").toUpperCase();
    if (!["GET", "HEAD", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"].includes(method)) {
      throw new ConnectionError("invalid_method", "This request method is not supported.");
    }
    const timeoutMs = options.timeoutMs ?? 90_000;
    const limit = options.maxResponseBytes ?? 8_000_000;
    return new Promise<Response>((resolve, reject) => {
      let request: ClientRequest | undefined;
      let settled = false;
      const finish = (error?: ConnectionError, response?: Response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        init.signal?.removeEventListener("abort", abort);
        if (error) {
          request?.destroy();
          reject(error);
        } else resolve(response!);
      };
      const abort = () => finish(new ConnectionError("aborted", "The connection was cancelled."));
      const timer = setTimeout(() => finish(new ConnectionError("timeout", "The connection timed out.")), timeoutMs);
      init.signal?.addEventListener("abort", abort, { once: true });
      const hostname = url.hostname.replace(/^\[|\]$/g, "");
      try {
        request = (options.request ?? httpsRequest)(
          {
            protocol: "https:",
            hostname,
            port: url.port || 443,
            path: `${url.pathname}${url.search}`,
            method,
            headers: { ...Object.fromEntries(headers), ...(body ? { "content-length": String(body.byteLength) } : {}) },
            servername: isIP(hostname) ? "" : hostname,
            rejectUnauthorized: true,
            agent: false,
            // A fixed family also disables Node's dual-stack lookup mode (which would expect an array callback).
            family: address.family,
            // Node retains the original host for TLS and Host while connecting only to the checked address.
            lookup: (_host, _opts, callback) => callback(null, address.address, address.family),
          },
          (response) => {
            const status = response.statusCode ?? 502;
            if (status >= 300 && status < 400) {
              response.destroy();
              finish(
                new ConnectionError("redirect_refused", "The endpoint redirected. Enter its final HTTPS address."),
              );
              return;
            }
            const announced = Number(response.headers["content-length"]);
            if (Number.isFinite(announced) && announced > limit) {
              response.destroy();
              finish(new ConnectionError("response_too_large", "The response exceeds the connection size limit."));
              return;
            }
            const chunks: Buffer[] = [];
            let size = 0;
            response.on("data", (chunk: Buffer | string) => {
              const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              size += data.byteLength;
              if (size > limit) {
                response.destroy();
                finish(new ConnectionError("response_too_large", "The response exceeds the connection size limit."));
              } else chunks.push(data);
            });
            response.on("error", () => finish(new ConnectionError("network_error", "The response could not be read.")));
            response.on("aborted", () => finish(new ConnectionError("network_error", "The response was interrupted.")));
            response.on("end", () => {
              const responseHeaders = new Headers();
              for (const [name, value] of Object.entries(response.headers)) {
                // Cookies are never returned to the browser or stored by this transport.
                if (value !== undefined && name !== "set-cookie")
                  responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : value);
              }
              try {
                const noBody = method === "HEAD" || [204, 205, 304].includes(status);
                finish(
                  undefined,
                  new Response(noBody ? null : Buffer.concat(chunks), { status, headers: responseHeaders }),
                );
              } catch {
                finish(new ConnectionError("invalid_response", "The endpoint returned an invalid response."));
              }
            });
          },
        );
        request.on("error", () => finish(new ConnectionError("network_error", "The endpoint could not be reached.")));
        if (init.signal?.aborted) {
          abort();
          return;
        }
        request.end(body);
      } catch {
        finish(new ConnectionError("network_error", "The endpoint could not be reached."));
      }
    });
  };
}

export const publicHttpsFetch = createPublicHttpsFetch();
