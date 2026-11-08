/** A lightweight form check. The server resolves and verifies the complete native identity. */
export function repositoryAddressError(raw: string): string | undefined {
  const value = raw.trim();
  if (!value || /[\s\u0000-\u001f\u007f\\?#]/.test(value)) return "Use a repository address without credentials, query parameters or fragments.";
  if (/^rad:(?:\/\/)?z[1-9A-HJ-NP-Za-km-z]+$/.test(value)) return;
  if (/^at:\/\/did:[a-z]+:[A-Za-z0-9._:%-]+\/org\.tangled\.repo(?:\.declaration|\.manifest)?\/[A-Za-z0-9._~:-]+$/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && url.pathname !== "/") return;
  } catch { /* The server will verify accepted address kinds. */ }
  return "Use an HTTPS repository URL, a Radicle ID (rad:z…), or an exact Tangled AT URI.";
}
