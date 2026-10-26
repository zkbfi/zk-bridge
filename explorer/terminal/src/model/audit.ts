/**
 * Pure rules of the audit view.
 */
import type { AuditRow } from './types'

/**
 * The difference between what the home mediator holds and what the other chain can redeem.
 *
 * A native token that the mediator locked is either minted on the other chain (`bridgedSupply`) or still in
 * flight (`inFlight`). The three must add up, so a non-zero value is a mismatch. A positive value means that the
 * mediator holds more than it owes. A negative value means that more supply exists than escrow, which is the
 * dangerous direction.
 */
export function auditDifference(row: AuditRow): bigint {
  return row.escrow - row.bridgedSupply - row.inFlight
}

/**
 * True when the row came from recent history only. Its `inFlight` may miss an older transfer, so a non-zero difference
 * proves nothing. The row is unverified, not wrong.
 */
export function isUnverifiedRow(row: AuditRow): boolean {
  return row.partial === true
}

/** True when the escrow does not equal the bridged supply plus the amount in flight. A row that is unverified never is. */
export function hasAuditMismatch(row: AuditRow): boolean {
  return !isUnverifiedRow(row) && auditDifference(row) !== 0n
}

/** Counts the rows that have a mismatch. Unverified rows do not count. */
export function countAuditMismatches(rows: readonly AuditRow[]): number {
  return rows.filter(hasAuditMismatch).length
}

/** Counts the rows that the data source could not verify. */
export function countUnverifiedRows(rows: readonly AuditRow[]): number {
  return rows.filter(isUnverifiedRow).length
}
