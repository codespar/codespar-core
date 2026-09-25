/**
 * Sandbox by construction: a key outside the `csk_test_` pattern fails
 * before any network call. Nothing in this repository ever holds a live key.
 */
export const TEST_KEY_PREFIX = "csk_test_";

export class NotATestKeyError extends Error {
  constructor() {
    super(
      `CODESPAR_API_KEY must be a test key (prefix "${TEST_KEY_PREFIX}"). ` +
        "This kit runs in the sandbox only; a live key is refused before any call is made.",
    );
    this.name = "NotATestKeyError";
  }
}

export function isTestKey(key: string | undefined): key is string {
  return typeof key === "string" && key.startsWith(TEST_KEY_PREFIX) && key.length > TEST_KEY_PREFIX.length;
}

export function assertTestKey(key: string | undefined): string {
  if (!isTestKey(key)) throw new NotATestKeyError();
  return key;
}

/** For logs and bundles: the prefix and the last four characters, nothing else. */
export function redactKey(key: string): string {
  if (key.length <= 12) return "csk_****";
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}
