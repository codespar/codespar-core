/**
 * Sandbox by construction: a key outside the `csk_test_` pattern fails
 * before any network call. Nothing in this repository ever holds a live key.
 *
 * Three different mistakes land here and each has its own fix, so each has
 * its own message (#50): no key at all (the `.env` was never copied, or sits
 * where the agent does not read it), the `.env.example` placeholder left in
 * place, and a key that is not a test key. Telling a newcomer who has no key
 * that their key is LIVE sends them looking for the wrong thing.
 */
export const TEST_KEY_PREFIX = "csk_test_";

/** The value `.env.example` ships with. It has the test prefix and is nobody's key. */
export const CODESPAR_KEY_PLACEHOLDER = "csk_test_your_key_here";

/** Why a `CODESPAR_API_KEY` cannot be used: absent or empty, the placeholder, or not a test key. */
export type TestKeyProblem = "missing" | "placeholder" | "not_test";

export function testKeyProblem(key: string | undefined): TestKeyProblem | undefined {
  const value = key?.trim() ?? "";
  if (value === "") return "missing";
  if (value === CODESPAR_KEY_PLACEHOLDER) return "placeholder";
  if (!value.startsWith(TEST_KEY_PREFIX) || value.length <= TEST_KEY_PREFIX.length) return "not_test";
  return undefined;
}

/**
 * `envFile` is the `.env` the agent actually reads, as the runner resolves it
 * (`agents/<agent>/.env`, relative to where the command ran). The core does
 * not know which agent it runs for, so without it the message names the
 * pattern instead of the path.
 */
export function testKeyMessage(problem: TestKeyProblem, envFile?: string): string {
  const file = envFile ?? "agents/<agent>/.env";
  switch (problem) {
    case "missing":
      return (
        `CODESPAR_API_KEY is not set: copy ${file}.example to ${file} and paste a ${TEST_KEY_PREFIX} key from https://codespar.dev/auth/signup. ` +
        `${file} is the file this agent reads; a .env anywhere else, the repository root included, is not read.`
      );
    case "placeholder":
      return `CODESPAR_API_KEY is still the placeholder from .env.example (${CODESPAR_KEY_PLACEHOLDER}): replace it in ${file} with your own ${TEST_KEY_PREFIX} key from https://codespar.dev/auth/signup.`;
    case "not_test":
      return (
        `CODESPAR_API_KEY must be a test key (prefix "${TEST_KEY_PREFIX}"). ` +
        `This kit runs in the sandbox only; a live key is refused before any call is made. It is read from the environment, or from ${file}.`
      );
  }
}

export class NotATestKeyError extends Error {
  constructor(
    readonly problem: TestKeyProblem = "not_test",
    readonly envFile?: string,
  ) {
    super(testKeyMessage(problem, envFile));
    this.name = "NotATestKeyError";
  }
}

export function isTestKey(key: string | undefined): key is string {
  return testKeyProblem(key) === undefined;
}

export function assertTestKey(key: string | undefined): string {
  const problem = testKeyProblem(key);
  if (problem) throw new NotATestKeyError(problem);
  return key!.trim();
}

/** For logs and bundles: the prefix and the last four characters, nothing else. */
export function redactKey(key: string): string {
  if (key.length <= 12) return "csk_****";
  return `${key.slice(0, 9)}…${key.slice(-4)}`;
}
