const TOKEN_PATTERNS = [
  /gh[psuor]_[A-Za-z0-9_]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  /-----BEGIN(?: [A-Z]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z]+)? PRIVATE KEY-----/g,
  /https:\/\/x-access-token:[^@\s]+@github\.com/gi,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-or-[A-Za-z0-9_-]{20,}\b/g,
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{20,}\b/gi,
] as const;

export function redactSecrets(input: string): string {
  return TOKEN_PATTERNS.reduce(
    (value, pattern) => value.replace(pattern, "[REDACTED]"),
    input,
  );
}

/** High-confidence detector shared by persistence and publication policy. */
export function containsSecretLikeContent(input: string): boolean {
  return TOKEN_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(input);
  });
}
