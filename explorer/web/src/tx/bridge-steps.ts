/**
 * The steps of the bridge form for the web page. The plain path is the terminal's own builder (`buildBridgeSteps`), so
 * the calldata of an approval, a relay, a relay with a call and a relay with a fallback is the same as the terminal
 * builds for the same inputs. The tip path changes only three inputs: the receiver becomes the router of the
 * destination chain (the fee router of the deployment, or the one that the user named), the mode becomes "call", and the
 * data becomes the encoded fee director. The page then adds the disclosure that the confirm dialog shows. The wrap route
 * carries no call data, so it never carries a tip.
 */
import { getAddress, type Address } from "viem";
import { encodeFeeDirector } from "@zk-bridge/shared";
import { buildBridgeSteps, NATIVE_CHOICE, type BridgeContext } from "@terminal/app/actions";
import type { ChainSnapshot } from "@terminal/chain/live-reads";
import { parseUnits, AmountParseError } from "@terminal/format/amounts";
import type { ChainSide, TokenInfo } from "@terminal/model/types";
import { PlanInputError, parseAddress, type DisplayArgument, type PlannedTransaction } from "@terminal/tx/plan";
import type { FlowStep } from "@terminal/flow/transaction-flow";
import { describeBridgeFees, type BridgeFeeDisclosure } from "./fee-disclosure";
import type { DeliverySelection } from "./delivery-selection";

/** What the confirm dialog shows besides the decoded call. */
export type StepDisclosure = {
  /** Whether the fees below are paid by this transaction, or by the relay that follows an allowance. */
  readonly feesApplyTo: "this-transaction" | "next-transaction";
  /** The native coin of the destination chain, which prices the cost lines of a delivery fee. Null for a step that is not a relay. */
  readonly destinationNativeSymbol: string | null;
  /** The token that the amount is in, for the fee lines. Null for a step that is not a relay. */
  readonly amountToken: { readonly symbol: string; readonly decimals: number } | null;
  /** The bridge fees of a relay, or null for a step that is not a relay. */
  readonly bridgeFees: BridgeFeeDisclosure | null;
  /** The tip that this relay carries, or null for a plain relay. */
  readonly delivery: DeliverySelection | null;
};

/** One transaction of a sequence, with its disclosure. */
export type WebStep = {
  readonly plan: PlannedTransaction;
  readonly disclosure: StepDisclosure;
};

/** The values of the bridge form, as text. */
export type BridgeFormValues = {
  /** `<side>:<token address>` or `<side>:native`. See `tokenChoiceValue` in the terminal. */
  readonly token: string;
  readonly amount: string;
  readonly receiver: string;
  readonly mode: "plain" | "call" | "fallback";
  readonly data: string;
  readonly fallback: string;
};

/** Input of {@link planBridgeSteps}. */
export type PlanBridgeInput = {
  readonly values: BridgeFormValues;
  readonly tokens: readonly TokenInfo[];
  readonly context: BridgeContext;
  /** The tip, or null for a plain relay. */
  readonly delivery: DeliverySelection | null;
};

const sideOfChoice = (choice: string): ChainSide => (choice.startsWith("second:") ? "second" : "first");

const snapshotOfSide = (context: BridgeContext, side: ChainSide): ChainSnapshot => {
  const found = (context.snapshots ?? []).find((result) => result.status === "ok" && result.snapshot.chain.side === side);
  if (found === undefined || found.status !== "ok") {
    throw new PlanInputError("The balances and the fee rate of both chains must load before you can bridge.");
  }
  return found.snapshot;
};

const parseAmountText = (text: string, decimals: number): bigint => {
  try {
    return parseUnits(text, decimals);
  } catch (error) {
    if (error instanceof AmountParseError) throw new PlanInputError(error.message);
    throw error;
  }
};

const explainRouterReceiver = (argument: DisplayArgument, input: { chainName: string; recipient: Address; deployed: boolean }): DisplayArgument => {
  if (argument.name !== "receiver") return argument;
  const owner = input.deployed ? "fee router" : "router (not the fee router of the deployment)";
  return { ...argument, meaning: `${owner} on ${input.chainName}: pays its one runner the tip, then sends the rest to ${input.recipient}` };
};

/**
 * Plans the transactions of the bridge form: an exact allowance when needed, then the relay.
 *
 * @param input The form values, the token list, the live state and the delivery fee.
 * @throws PlanInputError with a sentence for the user.
 */
export const planBridgeSteps = (input: PlanBridgeInput): readonly WebStep[] => {
  const { values, tokens, context, delivery } = input;
  const side = sideOfChoice(values.token);
  const otherSide: ChainSide = side === "first" ? "second" : "first";
  const sourceChain = side === "first" ? context.pair.first : context.pair.second;
  const destinationChain = side === "first" ? context.pair.second : context.pair.first;
  const source = snapshotOfSide(context, side);
  const destination = snapshotOfSide(context, otherSide);
  const isNative = values.token.endsWith(`:${NATIVE_CHOICE}`);
  const token = isNative ? null : tokens.find((candidate) => candidate.side === side && `${candidate.side}:${candidate.address}`.toLowerCase() === values.token.toLowerCase());
  if (!isNative && token === undefined) throw new PlanInputError("Choose a token.");
  const amount = parseAmountText(values.amount, token === null || token === undefined ? 18 : token.decimals);
  const receiver = parseAddress(values.receiver, "receiver");
  const bridgeFees = describeBridgeFees({ amount, sourceRate: source.feeRate, destinationRate: destination.feeRate });
  const amountToken = token === null || token === undefined ? { symbol: `wrapped ${sourceChain.nativeSymbol}`, decimals: 18 } : { symbol: token.symbol, decimals: token.decimals };

  if (delivery === null) {
    const steps = buildBridgeSteps({ ...values }, tokens, context);
    return withDisclosure(steps, { amountToken, destinationNativeSymbol: destinationChain.nativeSymbol, bridgeFees, delivery: null });
  }

  if (isNative) throw new PlanInputError("The wrap route carries no call data, so it cannot carry a tip.");
  const data = encodeFeeDirector(delivery.director);
  const deployed = getAddress(delivery.router) === getAddress(delivery.defaultRouter);
  const steps = buildBridgeSteps({ ...values, receiver: delivery.router, mode: "call", data }, tokens, context);
  const adjusted = steps.map((step): FlowStep => ({
    ...step,
    plan:
      step.plan.functionName === "relayTokensAndCall"
        ? { ...step.plan, arguments: step.plan.arguments.map((argument) => explainRouterReceiver(argument, { chainName: destinationChain.name, recipient: receiver, deployed })) }
        : step.plan,
  }));
  return withDisclosure(adjusted, { amountToken, destinationNativeSymbol: destinationChain.nativeSymbol, bridgeFees, delivery });
};

/**
 * The last step is the relay and carries the fees. An allowance before it carries the same fees, marked as the fees of
 * the next transaction, so the user sees what the whole sequence costs before the first signature.
 */
const withDisclosure = (steps: readonly FlowStep[], relayDisclosure: Omit<StepDisclosure, "feesApplyTo">): readonly WebStep[] =>
  steps.map((step, index): WebStep => ({
    plan: step.plan,
    disclosure: { ...relayDisclosure, feesApplyTo: index === steps.length - 1 ? "this-transaction" : "next-transaction" },
  }));
