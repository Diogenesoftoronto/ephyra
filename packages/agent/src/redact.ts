/** Remove common credential forms before keeping command output. Explicit secrets must also be supplied. */
export function redact(text: string, secrets: string[] = [], limit = 16_384): string {
  let result = text.replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
  return result.length > limit ? result.slice(0, limit) + "\n[truncated]" : result;
}
