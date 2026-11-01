import { useMemo } from "react";

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
  /** Why the typed destination address cannot be used, or null (destination row unlocked). */
  readonly destinationProblem?: string | null;
  /** The destination row already names the problem under the field, so the pill does not repeat it. */
  readonly destinationProblemShown?: boolean;
  readonly symbol: string;
  /** The destination's gate is closed (paused), with the route name for the message. */
  readonly paused: { readonly route: string } | null;
  /**
   * The fee is too low: under twice the anticipated cost of the bridge (gas at the gas level plus the proof), or below
   * the bots' break-even when there is no price. See fee-guard.
   */
  readonly tipBelowBreakEven: boolean;
  /** The fee and the total cost as text, for the low-fee detail; null without prices. */
  readonly lowFee?: { readonly feeText: string; readonly costText: string } | null;
  /** The tip before gas is a "High cap %" (shared fee rules): the tip and the line as text; or null. */
  readonly highTip?: { readonly thresholdText: string; readonly tipText: string } | null;
  /**
   * The total cost is above the user's cap share of the amount (shared fee rules): the cost, the cap and what the cap
   * allows, as text; or null.
   */
  readonly smallTransfer?: { readonly costText: string; readonly capText: string; readonly capAmountText: string } | null;
  /**
   * The fee is above the user's hard fee cap (owner, quote 86: "disallows movement forward until the cap is adjusted"):
   * the cap, the fee (or its worst case), what the cap allows and the smallest cap that admits the fee, as text; or null.
   */
  readonly hardCap?: { readonly capText: string; readonly feeText: string; readonly capAmountText: string; readonly raiseText: string; readonly worstCase: boolean } | null;
  /** zkb.fi has never bridged this token (owner: custom tokens). */
  readonly firstBridge?: boolean;
  /** The token is an Omnibridge copy (bridging it wraps it twice). */
  readonly omnibridge?: boolean;
};

/**
 * The pill's verdict, in priority order: no wallet, paused, nothing typed, over balance, a destination that can't be used, a blocked draft, a fee above
 * the hard cap (a block, never a warning to override); then one warning at most: a small transfer, a low fee, "High cap %", an Omnibridge copy, a first bridge; then an incomplete
 * draft, go.
 *
 * @param input The state.
 */
export const verdictOf = (input: VerdictInput): Verdict => {
  if (!input.connected) return { kind: "connect", label: "Connect wallet", detail: null };
  if (input.paused !== null) return { kind: "blocked", label: `${input.paused.route} is paused`, detail: "The gate on the destination is closed. Nothing can be sent until it opens." };
  if (!input.amountEntered) return { kind: "blocked", label: "Enter an amount", detail: null };
  if (input.overBalance) return { kind: "blocked", label: `Not enough ${input.symbol}`, detail: null };
  if (input.destinationProblem != null) return { kind: "blocked", label: "Check the destination", detail: input.destinationProblemShown === true ? null : input.destinationProblem };
  if (input.draft.status === "blocked") return { kind: "blocked", label: "Check the transfer", detail: input.draft.reason };
  if (input.hardCap != null) {
    const cap = input.hardCap;
    const fee = cap.worstCase ? `The fee could reach ${cap.feeText} if gas rises` : `The fee is ${cap.feeText}`;
    return { kind: "blocked", label: `Fee above your ${cap.capText} cap`, detail: `${fee}, more than your ${cap.capText} hard cap (${cap.capAmountText}). Raise the cap to ${cap.raiseText} to go on, or lower the fee.` };
  }
  if (input.draft.status === "ready") {
    if (input.smallTransfer != null) {
      const small = input.smallTransfer;
      return { kind: "warn", label: "Small transfer · may not be delivered in a timely manner", detail: `Delivery costs about ${small.costText}, more than the ${small.capText} (${small.capAmountText}) you allow. A bot may wait for cheaper gas: raise the cap in the tip drawer, or deliver it yourself.` };
    }
    if (input.tipBelowBreakEven) {
      const numbers = input.lowFee == null ? "The fee is under twice what delivering and proving it should cost" : `The fee (${input.lowFee.feeText}) is under twice what delivering and proving it should cost (${input.lowFee.costText} now)`;
      return { kind: "warn", label: "Tip too low · may not be delivered", detail: `${numbers}, so bots likely skip it and you would deliver it yourself. Raise it with the tip.` };
    }
    if (input.highTip != null) {
      return { kind: "warn", label: "High cap %", detail: `The tip, before gas, is ${input.highTip.tipText}, over the ${input.highTip.thresholdText} of the amount a tip should stay under. A lower tip still gets delivered; lower it with the tip.` };
    }
    if (input.omnibridge === true) {
      return { kind: "warn", label: "Already bridged by the Omnibridge · wraps twice", detail: "This token came over the Omnibridge. Bridging it again wraps it a second time and costs gas twice; it only turns back by undoing both bridges in order." };
    }
    if (input.firstBridge === true) {
      return { kind: "warn", label: "First time this token is bridged · keep the amount low", detail: "No one has bridged this token with zkb.fi before. The first transfer also deploys its counterpart on the other chain; a small first amount limits what is at risk." };
    }
  }
  if (input.draft.status === "incomplete") return { kind: "blocked", label: "Bridge", detail: input.draft.reason };
  return { kind: "go", label: "Bridge", detail: null };
};

/** Whether the pill can be pressed. */
export const pressable = (verdict: Verdict): boolean => verdict.kind === "go" || verdict.kind === "warn" || verdict.kind === "connect";

/**
 * The verdict of a state as a hook: `verdictOf`, kept while the state does not change, with whether the pill can be
 * pressed. The state is plain values and text, so it is compared by its content.
 *
 * @param input The state.
 */
export const useVerdict = (input: VerdictInput): { readonly verdict: Verdict; readonly pressable: boolean } => {
  // Only what the verdict reads is in the key: the draft may carry far more (steps, amounts) than its status and reason.
  const key = JSON.stringify({ ...input, draft: { status: input.draft.status, reason: input.draft.reason } });
  return useMemo(() => {
    const verdict = verdictOf(input);
    return { verdict, pressable: pressable(verdict) };
    // The key is the input's content, so the memo follows what the input says, not the identity of the object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
};
