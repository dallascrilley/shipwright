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

/**
 * Scan bytes before they are persisted or published. Git's binary patch
 * encoding is usually UTF-8 text, but a candidate may also retain raw blob
 * bytes. The single-byte view preserves every byte so ASCII token prefixes
 * cannot be hidden by malformed UTF-8.
 */
export function containsSecretLikeBytes(input: Uint8Array): boolean {
  const singleByteText = new TextDecoder("latin1").decode(input);
  if (containsSecretLikeContent(singleByteText)) return true;
  try {
    return containsSecretLikeContent(new TextDecoder("utf-8", { fatal: true }).decode(input));
  } catch {
    return false;
  }
}

export function assertSecretSafeBytes(input: Uint8Array): void {
  if (containsSecretLikeBytes(input)) {
    throw new Error("secret scan blocked secret-shaped binary content");
  }
}
