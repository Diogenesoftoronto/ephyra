import { isIP } from "node:net";

function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}
export function redact(input: string): string {
  return input
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, "[REDACTED]")
    .replace(
      /\b(?:sk-[\w-]+|ghp_[\w]+|xox[baprs]-[\w-]+|AKIA[A-Z0-9]{16})\b/g,
      "[REDACTED]",
    )
    .replace(/\beyJ[\w-]+\.[\w-]+\.[\w-]+\b/g, "[REDACTED]")
    .replace(
      /\b(?:password|secret|token|api[_-]?key)\s*[=:]\s*[^\s,;]+/gi,
      "[REDACTED]",
    )
    .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[REDACTED]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (value) =>
      isIP(value) ? "[REDACTED]" : value,
    )
    .replace(
      /(?<![\w:])(?:[a-f\d]{0,4}:){2,}[a-f\d:]{0,4}(?![\w:])/gi,
      (value) => (isIP(value) ? "[REDACTED]" : value),
    )
    .replace(/\b(?:\d[ -]?){13,19}\b/g, (value) =>
      luhn(value) ? "[REDACTED]" : value,
    );
}
