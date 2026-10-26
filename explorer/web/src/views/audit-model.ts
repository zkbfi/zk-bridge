/**
 * The audit rules of the web page. A row that the RPC source built from recent history only is `partial`: its
 * in-flight amount misses older transfers, so a difference is no proof of a mismatch. The page calls such a row
 * unverified. A complete row keeps the rule of the terminal: a difference that is not zero is a mismatch.
 */
import { hasAuditMismatch } from "@terminal/model/audit";
import type { AuditRow } from "@terminal/model/types";

/** What the page can say about a row. */
export type AuditVerdict = "matches" | "mismatch" | "unverified";

/**
 * The verdict for one row. A partial row is unverified, whatever its difference is.
 *
 * @param row The audit row.
 */
export const auditVerdict = (row: AuditRow): AuditVerdict => {
  if (row.partial === true) return "unverified";
  return hasAuditMismatch(row) ? "mismatch" : "matches";
};

/** How many rows have each verdict. */
export type AuditTally = { readonly mismatches: number; readonly unverified: number; readonly checked: number };

/**
 * Counts the rows by verdict. A partial row is never a mismatch. `checked` counts the rows that are not partial.
 *
 * @param rows The audit rows.
 */
export const tallyAudit = (rows: readonly AuditRow[]): AuditTally => {
  const verdicts = rows.map(auditVerdict);
  const unverified = verdicts.filter((verdict) => verdict === "unverified").length;
  return { mismatches: verdicts.filter((verdict) => verdict === "mismatch").length, unverified, checked: rows.length - unverified };
};
