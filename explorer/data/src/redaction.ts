/**
 * Masking and redaction of secrets. This module has no dependency on the terminal library, so the bots can import it.
 *
 * Two tools. `maskSecret` is for the screen: it shows only the last four characters. `redactSecrets` is for logs and
 * error messages: it removes anything that looks like a secret, and every secret value the caller knows.
 */

/** The text that replaces a secret in a log line. */
export const REDACTED = '[redacted]'

/** How many trailing characters a masked secret shows. */
const VISIBLE_TAIL = 4

/** A secret shorter than this shows no characters at all, because four of them would be too much of it. */
const MINIMUM_LENGTH_FOR_TAIL = 12

/**
 * Masks a secret for display. A long secret shows `********abcd`. A short one shows only stars.
 * The star count never reveals the length beyond a fixed range.
 */
export function maskSecret(secret: string): string {
  if (secret === '') return ''
  const stars = '*'.repeat(8)
  if (secret.length < MINIMUM_LENGTH_FOR_TAIL) return stars
  return `${stars}${secret.slice(-VISIBLE_TAIL)}`
}

/** A pattern and its replacement. `$1` and `$2` keep the parts around the secret. */
const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  // valve.city keys.
  [/\bvk_[A-Za-z0-9_-]+/g, REDACTED],
  // RunPod API keys.
  [/\brpa_[A-Za-z0-9_-]+/g, REDACTED],
  // Bearer and Basic credentials in a header line.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // An Authorization header with any other scheme, or none: `authorization: <value>`, `Authorization: Token <value>`.
  [/(\bauthorization\s*:\s*(?:[A-Za-z]+\s+)?)[^\s"',;]+/gi, `$1${REDACTED}`],
  // An API key header: `x-api-key: <value>`, `api-key: <value>`, `x-auth-token: <value>`.
  [/(\b(?:x-)?(?:api-?key|auth-?token|access-?token)\s*:\s*)[^\s"',;]+/gi, `$1${REDACTED}`],
  // Keys in a query string: any parameter whose name ends in key, token, secret, password or auth (api_key, apikey,
  // key, dkey, token, access_token, ...).
  [/([?&][A-Za-z0-9_-]*(?:key|token|secret|password|auth)=)[^&#\s"']+/gi, `$1${REDACTED}`],
  // Keys in a JSON field.
  [/("(?:api[_-]?key|x-api-key|access[_-]?token|token|secret|password|authorization)"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`],
  // A keyed RPC path: /rpc/<key>/... (valve.city and similar).
  [/(\/rpc\/)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
  // A versioned provider path: /v2/<key>, /v3/<key> (Alchemy, Infura and similar).
  [/(\/v\d+\/)[A-Za-z0-9_-]{16,}/g, `$1${REDACTED}`],
  // QuickNode: the token is the first segment of the path, whatever its length.
  [/(\.quiknode\.pro\/)[A-Za-z0-9_-]+/gi, `$1${REDACTED}`],
  // Ankr: rpc.ankr.com/<chain>/<key>.
  [/(\brpc\.ankr\.com\/[A-Za-z0-9_-]+\/)[A-Za-z0-9_-]{16,}/gi, `$1${REDACTED}`],
  // A path segment of 32 or more hex digits without 0x, on any host: the key of most providers. A hash or an address
  // (0x...) and an identifier with dashes stay readable.
  [/(\/)(?!0x)[0-9a-f]{32,}(?=[/?#\s"']|$)/gi, `$1${REDACTED}`],
  // Credentials in a URL: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
]

/** A known secret shorter than this is removed only where it stands alone, not inside a longer word or number. */
const MINIMUM_LENGTH_ANYWHERE = 6

/**
 * Values that never become known secrets: configuration literals and common words of URLs and messages. Removing them
 * would wipe ordinary words from every log line and message, and a secret with such a value protects nothing.
 */
const NOT_SECRETS: ReadonlySet<string> = new Set([
  '0', '1', 'true', 'false', 'null', 'undefined', 'none', 'yes', 'no', 'on', 'off',
  'user', 'username', 'admin', 'administrator', 'root', 'guest', 'test', 'demo', 'default', 'name',
  'pass', 'password', 'secret', 'token', 'key', 'apikey', 'changeme', 'example', 'public', 'anonymous',
])

/** The shortest value that may become a known secret without a mark: shorter values are path parts, chain names and words. */
export const MINIMUM_CREDENTIAL_LENGTH = 8

/**
 * Whether a value may become a known secret. The decision is made here, when a caller collects its secrets, and not
 * when the text is cleaned: every known secret is then removed wherever it stands as a whole token.
 *
 * - Never: an empty value or white space.
 * - A value that the configuration marks secret (a password, the value of a key parameter, a secret variable): always,
 *   whatever it is. A password "admin" is still a password.
 * - Any other value (a user name, a path, a plain query value): only when it is no configuration literal or common word
 *   ({@link NOT_SECRETS}) and has at least {@link MINIMUM_CREDENTIAL_LENGTH} characters.
 */
export function isRegistrableSecret(value: string, options: { readonly marked?: boolean } = {}): boolean {
  const trimmed = value.trim()
  if (trimmed === '') return false
  if (options.marked === true) return true
  return !NOT_SECRETS.has(trimmed.toLowerCase()) && trimmed.length >= MINIMUM_CREDENTIAL_LENGTH
}

function escapeForPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Removes every occurrence of one known secret, in its plain and its percent-encoded form.
 *
 * The rule fails closed: whatever the caller passes is a secret (only an empty value or white space is skipped). A
 * secret of six characters or more is removed wherever it occurs. A shorter one is removed wherever it stands as a
 * whole token, between characters that are not letters or digits: `abcde` goes from `token abcde`, `Bearer abcde`,
 * `key=abcde&` and `/abcde/`, but not from `abcdefg`, and `1234` not from `12345`. Which values may become known
 * secrets at all is decided when they are collected, with {@link isRegistrableSecret}.
 */
function removeKnownSecret(text: string, secret: string): string {
  if (secret.trim() === '') return text
  let result = text
  for (const form of new Set([secret, encodeURIComponent(secret)])) {
    if (form.length >= MINIMUM_LENGTH_ANYWHERE) result = result.split(form).join(REDACTED)
    else result = result.replace(new RegExp(`(?<![A-Za-z0-9])${escapeForPattern(form)}(?![A-Za-z0-9])`, 'g'), REDACTED)
  }
  return result
}

/**
 * Removes secrets from text.
 *
 * @param text The text of a log line, an error message or a report.
 * @param knownSecrets Secret values that the caller holds. Each occurrence is removed, whatever its shape and length;
 *   see {@link removeKnownSecret} for the rule on short values.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text
  // Longest first, each once: a short secret inside a longer one must not split it and leave the rest readable.
  const ordered = [...new Set(knownSecrets)].sort((a, b) => b.length - a.length)
  for (const secret of ordered) result = removeKnownSecret(result, secret)
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement)
  return result
}

/** Redacts an error for a log or a screen: its message only, never its fields. */
export function redactError(error: unknown, knownSecrets: readonly string[] = []): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), knownSecrets)
}
