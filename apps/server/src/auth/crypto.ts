// Small crypto helpers for Not Organic sign-in. WebCrypto only.
const encoder = new TextEncoder();

/** The JWK fields used here (the server is not compiled with DOM types). */
export type Jwk = { kty?: string; crv?: string; x?: string; y?: string; d?: string; [k: string]: unknown };
/** Minimal fetch signature, so tests can inject a plain function. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

export const b64url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** 32 random bytes, base64url. Used for session tokens, state, PKCE verifiers and CSRF tokens. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256b64url(value: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * AES-256-GCM sealing for secrets at rest (refresh tokens, DPoP private keys). The key comes from
 * EPHYRA_SESSION_KEY (32 bytes, base64 or base64url); the sealed form is base64url(iv ‖ ciphertext).
 */
export class SecretBox {
  private constructor(private readonly key: CryptoKey) {}

  static async fromBase64(raw: string): Promise<SecretBox> {
    const bytes = Buffer.from(raw.trim(), raw.includes("-") || raw.includes("_") ? "base64url" : "base64");
    if (bytes.length !== 32) throw new Error("EPHYRA_SESSION_KEY must be 32 bytes (base64)");
    const key = await crypto.subtle.importKey("raw", bytes, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return new SecretBox(key);
  }

  async seal(value: unknown): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, this.key, encoder.encode(JSON.stringify(value))));
    const out = new Uint8Array(iv.length + data.length);
    out.set(iv);
    out.set(data, iv.length);
    return b64url(out);
  }

  async open<T>(sealed: string): Promise<T> {
    const bytes = Buffer.from(sealed, "base64url");
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, this.key, bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(plain)) as T;
  }
}

export type DpopKeys = { keys: CryptoKeyPair; publicJwk: Jwk; privateJwk: Jwk };

/** A fresh ES256 key pair for DPoP, with JWKs so it can be sealed and restored. */
export async function newDpopKeys(): Promise<DpopKeys> {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const { kty, crv, x, y } = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as Jwk;
  return { keys, publicJwk: { kty, crv, x, y }, privateJwk: (await crypto.subtle.exportKey("jwk", keys.privateKey)) as Jwk };
}

export async function restoreDpopKeys(privateJwk: Jwk, publicJwk: Jwk): Promise<CryptoKeyPair> {
  const alg = { name: "ECDSA", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", privateJwk as never, alg, true, ["sign"]),
    publicKey: await crypto.subtle.importKey("jwk", publicJwk as never, alg, true, ["verify"]),
  };
}

/** RFC 9449 DPoP proof. `accessToken` adds `ath` (resource requests); omit it for token refresh. */
export async function dpopProof(keys: CryptoKeyPair, publicJwk: Jwk, url: string, method: string, accessToken?: string): Promise<string> {
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  const json = (value: unknown) => b64url(encoder.encode(JSON.stringify(value)));
  const iat = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = { htm: method.toUpperCase(), htu: target.href, iat, jti: crypto.randomUUID() };
  if (accessToken) payload.ath = await sha256b64url(accessToken);
  const input = `${json({ typ: "dpop+jwt", alg: "ES256", jwk: publicJwk })}.${json(payload)}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(input));
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

/** Decode (not verify) a JWT payload. Only used on tokens just received from the configured issuer over TLS. */
export function jwtClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as Record<string, unknown>;
  } catch {
    return {};
  }
}
