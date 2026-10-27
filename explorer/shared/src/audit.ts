/** What the audit needs to know about one native token. All amounts are in base units of that token. */
export type AuditInput = {
  readonly homeChainId: number;
  readonly token: string;
  /** `mediatorBalance(token)` on the home chain. */
  readonly escrow: bigint;
  /** The supply of the bridged copy on the other chain, from mints minus burns. Zero when no copy exists. */
  readonly bridgedSupply: bigint;
  /** Locked on the home chain, with the mint not yet done: transfers from home that are not delivered or paid. */
  readonly pendingForward: bigint;
  /** Burned on the other chain, with the release not yet done: transfers back to home that are not paid. */
  readonly pendingBackward: bigint;
};

/** The audit of one native token. */
export type AuditResult = AuditInput & {
  /** `bridgedSupply + pendingForward + pendingBackward`: what the escrow must hold. */
  readonly expectedEscrow: bigint;
  /** `escrow - expectedEscrow`. Positive: more locked than owed. Negative: the bridged copy is under-backed. */
  readonly difference: bigint;
  readonly mismatch: boolean;
};

/**
 * Checks escrow against supply for one native token.
 *
 * The invariant: the mediator record of a native token equals the supply of its bridged copy, plus the amounts that
 * are locked and not yet minted, plus the amounts that are burned and not yet released. A transfer counts as pending
 * until the delivery paid the recipient or the fallback address. A failed call or a claimable release stays pending,
 * because the tokens are still held or still owed.
 *
 * @param input The balances and the pending amounts of one token.
 */
export const auditToken = (input: AuditInput): AuditResult => {
  const expectedEscrow = input.bridgedSupply + input.pendingForward + input.pendingBackward;
  const difference = input.escrow - expectedEscrow;
  return { ...input, expectedEscrow, difference, mismatch: difference !== 0n };
};
