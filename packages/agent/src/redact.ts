/** Remove common credential forms before keeping command output. Explicit secrets must also be supplied. */
export function redact(text: string, secrets: string[] = [], limit = 16_384): string {
  let result = text.replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    // JSON and quoted forms: "API_TOKEN": "value", 'password' = 'value'
    .replace(/(["'][\w-]*(?:api[_-]?key|token|password|passwd|secret|credential|authorization)[\w-]*["']\s*[:=]\s*)(["'])(?:(?!\2).)*\2/gi, "$1$2[REDACTED]$2")
    // Credentials that identify themselves by shape.
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, "[REDACTED]");
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join("[REDACTED]");
  return result.length > limit ? result.slice(0, limit) + "\n[truncated]" : result;
}
