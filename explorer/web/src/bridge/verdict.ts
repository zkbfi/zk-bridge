/**
 * What the Bridge pill says and whether it can be pressed (owner: "we should also use the bridge button to show
 * things like, fee too low, bots will probably not deliver for you"). Solid = go; orange outline = a warning the user
 * may override; grey = blocked; "Connect wallet" when no wallet is connected.
 */

/** The verdict. */
export type Verdict = {
  readonly kind: "go" | "warn" | "blocked" | "connect";
  readonly label: string;
  /** A line under the pill explaining a warning or a block, or null. */
  readonly detail: string | null;
};

/** What the verdict reads. */
export type VerdictInput = {
  readonly connected: boolean;
  /** The draft's status and reason (from computeBridgeDraft). */
  readonly draft: { readonly status: "ready" | "incomplete" | "blocked"; readonly reason: string | null };
  readonly amountEntered: boolean;
  /** The amount is more than the balance. */
  readonly overBalance: boolean;
  readonly symbol: string;
  /** The destination's gate is closed (paused), with the route name for the message. */
  readonly paused: { readonly route: string } | null;
  /** The tip is below what a delivery bot needs at today's gas price. */
  readonly tipBelowBreakEven: boolean;
  /** zkb.fi has never bridged this token (owner: custom tokens). */
  readonly firstBridge?: boolean;
  /** The token is an Omnibridge copy (bridging it wraps it twice). */
  readonly omnibridge?: boolean;
};

/**
 * The pill's verdict, in priority order: no wallet, paused, nothing typed, over balance, a blocked draft, a low tip,
 * an incomplete draft, go.
 *
 * @param input The state.
 */
export const verdictOf = (input: VerdictInput): Verdict => {
  if (!input.connected) return { kind: "connect", label: "Connect wallet", detail: null };
  if (input.paused !== null) return { kind: "blocked", label: `${input.paused.route} is paused`, detail: "The gate on the destination is closed. Nothing can be sent until it opens." };
  if (!input.amountEntered) return { kind: "blocked", label: "Enter an amount", detail: null };
  if (input.overBalance) return { kind: "blocked", label: `Not enough ${input.symbol}`, detail: null };
  if (input.draft.status === "blocked") return { kind: "blocked", label: "Check the transfer", detail: input.draft.reason };
  if (input.omnibridge === true && input.draft.status === "ready") {
    return { kind: "warn", label: "Already bridged by the Omnibridge · wraps twice", detail: "This token came over the Omnibridge. Bridging it again wraps it a second time and costs gas twice; it only turns back by undoing both bridges in order." };
  }
  if (input.firstBridge === true && input.draft.status === "ready") {
    return { kind: "warn", label: "First time this token is bridged · keep the amount low", detail: "No one has bridged this token with zkb.fi before. The first transfer also deploys its counterpart on the other chain; a small first amount limits what is at risk." };
  }
  if (input.tipBelowBreakEven && input.draft.status === "ready") {
    return { kind: "warn", label: "Tip too low · may not be delivered", detail: "Bots likely skip a tip this small at today's gas price; you would deliver it yourself. Raise it with the tip." };
  }
  if (input.draft.status === "incomplete") return { kind: "blocked", label: "Bridge", detail: input.draft.reason };
  return { kind: "go", label: "Bridge", detail: null };
};

/** Whether the pill can be pressed. */
export const pressable = (verdict: Verdict): boolean => verdict.kind === "go" || verdict.kind === "warn" || verdict.kind === "connect";
