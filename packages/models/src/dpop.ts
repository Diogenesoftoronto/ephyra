const encoder = new TextEncoder();
const encode = (value: Uint8Array) => Buffer.from(value).toString("base64url");
const json = (value: unknown) => encode(encoder.encode(JSON.stringify(value)));

/** The key must be the same key bound to the access token. */
export async function dpopProof(url: string, token: string, keys: CryptoKeyPair): Promise<string> {
  const jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  const target = new URL(url);
  target.search = "";
  target.hash = "";
  const ath = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(token))));
  const header = json({ typ: "dpop+jwt", alg: "ES256", jwk });
  const payload = json({ htm: "POST", htu: target.href, iat: Math.floor(Date.now() / 1000), jti: crypto.randomUUID(), ath });
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, encoder.encode(input));
  return `${input}.${encode(new Uint8Array(signature))}`;
}
