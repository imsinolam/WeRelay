/** Only DNS lookup failures prove the HTTP send never reached the upstream. */
export function isDefinitelyNotSentWechatError(error: unknown): boolean {
  const seen = new Set<unknown>();
  const codes = new Set<string>();
  let current = error;
  while (current && typeof current === "object" && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    const record = current as { code?: unknown; cause?: unknown };
    if (typeof record.code === "string") codes.add(record.code);
    current = record.cause;
  }
  return codes.size > 0 && [...codes].every((code) => code === "ENOTFOUND" || code === "EAI_AGAIN");
}
