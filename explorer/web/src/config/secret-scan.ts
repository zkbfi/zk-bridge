/**
 * Detection of values that look like keys. The page ships every `VITE_` variable to every visitor, so the build and the
 * start of the page both refuse a configuration that holds anything key-like. The check is a guard against mistakes,
 * not a proof: it favours a false alarm over a leaked key. Findings never repeat the value.
 */

/** One value that looks like a secret. */
export type SecretFinding = {
  /** The name of the variable. */
  readonly variable: string;
  /** Why the value looks like a secret. It never contains the value. */
  readonly reason: string;
};

type ValueRule = { readonly reason: string; readonly pattern: RegExp };

const VALUE_RULES: readonly ValueRule[] = [
  { reason: "contains a vk_ token", pattern: /\bvk_[A-Za-z0-9_-]{6,}/ },
  { reason: "contains an sk_ or sk- token", pattern: /\bsk[_-][A-Za-z0-9]{16,}/ },
  { reason: "contains 32 bytes of hex, the size of a signing key", pattern: /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/ },
  { reason: "contains a signed web token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./ },
  { reason: "has a user name and password in a URL", pattern: /\/\/[^/\s:@]+:[^/\s@]+@/ },
  { reason: "has a key or token in the query of a URL", pattern: /[?&](?:api[_-]?key|apikey|key|token|secret|access_token|auth)=/i },
  { reason: "looks like a recovery phrase of twelve words or more", pattern: /^\s*(?:[a-z]{3,8}\s+){11,}[a-z]{3,8}\s*$/ },
];

const NAME_RULE = /(secret|private|password|passphrase|mnemonic|api_?key|auth|token)/i;

/** A long path segment with letters and digits, such as `/rpc/3f9a.../evm/1`, is a key that a proxy reads from the path. */
const KEY_IN_PATH = /\/(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{24,}(?:\/|$)/;

const looksLikeUrl = (value: string): boolean => /^(?:https?|wss?):\/\//i.test(value.trim());

/**
 * Lists every variable that holds a key-like value, or whose name says that it holds a secret.
 *
 * @param values The variables to check, by name. An empty or missing value is clean.
 */
export const findSecretLikeValues = (values: Readonly<Record<string, string | undefined>>): readonly SecretFinding[] =>
  Object.entries(values).flatMap(([variable, value]): SecretFinding[] => {
    if (value === undefined || value === "") return [];
    const reasons = [
      ...(NAME_RULE.test(variable) ? ["the name says it holds a secret"] : []),
      ...VALUE_RULES.filter((rule) => rule.pattern.test(value)).map((rule) => rule.reason),
      ...(looksLikeUrl(value) && KEY_IN_PATH.test(value) ? ["has a key-like segment in the path of a URL"] : []),
    ];
    return reasons.map((reason) => ({ variable, reason }));
  });

/** The configuration holds a secret, or is otherwise unusable. The message names variables, never values. */
export class ConfigurationError extends Error {
  override readonly name = "ConfigurationError";
}

/**
 * Throws when any value looks like a secret.
 *
 * @param values The variables to check.
 * @throws ConfigurationError with one line per finding.
 */
export const assertNoSecrets = (values: Readonly<Record<string, string | undefined>>): void => {
  const findings = findSecretLikeValues(values);
  if (findings.length === 0) return;
  const lines = findings.map((finding) => `${finding.variable}: ${finding.reason}`).join("; ");
  throw new ConfigurationError(
    `Refusing this configuration, because a value looks like a key (${lines}). The page publishes every VITE_ variable to every visitor. Use a public endpoint.`,
  );
};
