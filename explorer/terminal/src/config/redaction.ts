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
  // Keys in a query string.
  [/([?&](?:api[_-]?key|key|token|secret|password)=)[^&\s"']+/gi, `$1${REDACTED}`],
  // Keys in a JSON field.
  [/("(?:api[_-]?key|token|secret|password)"\s*:\s*")[^"]+(")/gi, `$1${REDACTED}$2`],
  // A keyed RPC path: /rpc/<key>/...
  [/(\/rpc\/)[A-Za-z0-9_-]{8,}/g, `$1${REDACTED}`],
  // Credentials in a URL: scheme://user:password@host
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, `$1${REDACTED}@`],
]

/**
 * Removes secrets from text.
 *
 * @param text The text of a log line, an error message or a report.
 * @param knownSecrets Secret values that the caller holds. Each occurrence is removed, whatever its shape.
 */
export function redactSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let result = text
  for (const secret of knownSecrets) {
    if (secret.length >= 6) result = result.split(secret).join(REDACTED)
  }
  for (const [pattern, replacement] of RULES) result = result.replace(pattern, replacement)
  return result
}

/** Redacts an error for a log or a screen: its message only, never its fields. */
export function redactError(error: unknown, knownSecrets: readonly string[] = []): string {
  return redactSecrets(error instanceof Error ? error.message : String(error), knownSecrets)
}
