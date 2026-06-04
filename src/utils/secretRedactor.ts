const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/(api[_-]?key\s*[:=]\s*)["']?[^"'\s]+/gi, "$1[REDACTED]"],
  [/(token\s*[:=]\s*)["']?[^"'\s]+/gi, "$1[REDACTED]"],
  [/(secret\s*[:=]\s*)["']?[^"'\s]+/gi, "$1[REDACTED]"],
  [/(password\s*[:=]\s*)["']?[^"'\s]+/gi, "$1[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED AWS ACCESS KEY]"]
];

export function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);
}

export function looksLikeSensitivePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".env") ||
    lower.includes("/.env") ||
    lower.includes("private") && lower.endsWith(".key") ||
    lower.endsWith(".pem") ||
    lower.endsWith(".p12") ||
    lower.endsWith(".pfx") ||
    lower.includes("credential") ||
    lower.includes("secret") ||
    lower.includes("token")
  );
}
