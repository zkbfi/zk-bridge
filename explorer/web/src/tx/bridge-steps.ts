/**
 * The steps of the bridge form for the web page. The plain path is the terminal's own builder (`buildBridgeSteps`), so
 * the calldata of an approval, a relay, and a relay with a call (with its callback gas) is the same as the terminal
 * builds for the same inputs. The tip path changes only three inputs: the receiver becomes the router of the
 * destination chain (the default delivery router, or the one that the user named), the mode becomes "call", and the
 * data becomes the encoded fee director. The page then adds the disclosure that the confirm dialog shows.
 *
 * The native coin goes through the delivery router of the source chain. With a tip it calls the router's payable
 * `relayTokensAndCall(receiver, data, callbackGas, gateEvidence)`: the router wraps the coin and relays the wrapped token
 * to the router of the other chain with the same fee terms as a token relay (native-route.ts). With No tip it calls
 * `wrapAndRelayTokens(receiver, gateEvidence)`, which carries no terms. Both carry the deposit gate's evidence as their
 * last argument: empty here, filled in by the transaction sequence right before the estimate (`withGateEvidence`).
 */
import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { deliveryRouterAbi, routerCallbackGas, type DeliveryCall } from "@zk-bridge/shared";
import { buildBridgeSteps, NATIVE_CHOICE, type BridgeContext } from "@terminal/app/actions";
import { parseUnits, AmountParseError } from "@terminal/format/amounts";
import type { ChainSide, TokenInfo } from "@terminal/model/types";
import { encodeDirectorFor } from "@terminal/tx/fee-terms-guard";
import { PlanInputError, parseAddress, type DisplayArgument, type PlannedTransaction } from "@terminal/tx/plan";
import type { FlowStep } from "@terminal/flow/transaction-flow";
import type { DeliverySelection } from "./delivery-selection";
import { crossingCopyOf } from "./native-route";

/** What the confirm dialog shows besides the decoded call. */
export type StepDisclosure = {
  /** Whether the tip below is paid by this transaction, or by the relay that follows an allowance. */
  readonly feesApplyTo: "this-transaction" | "next-transaction";
  /**
   * The call that the router makes after the delivery, as the user saw it. Absent or null means no call. The confirm
   * dialog compares it with the call in the bytes, so data built in another way is refused.
   */
  readonly deliveryCall?: DeliveryCall | null;
  /** The native coin of the destination chain, which prices the cost lines of a delivery fee. Null for a step that is not a relay. */
  readonly destinationNativeSymbol: string | null;
  /** The chain that delivers the message, where the router lives. Null for a step that is not a relay. */
  readonly destinationChainId: number | null;
  /** The name of that chain, for the headline of the review. Absent or null: the review says `the other chain`. */
  readonly destinationChainName?: string | null;
  /** The token that the amount is in, for the tip lines. Null for a step that is not a relay. */
  readonly amountToken: { readonly symbol: string; readonly decimals: number } | null;
  /** The tip that this relay carries, or null for a plain relay. */
  readonly delivery: DeliverySelection | null;
};

/** One transaction of a sequence, with its disclosure. */
export type WebStep = {
  readonly plan: PlannedTransaction;
  readonly disclosure: StepDisclosure;
  /**
   * Set on the step that the sequence inserts before a send on a chain whose deposit gate enforces: `confirm(evidence)`
   * for the epoch, with the gas of its simulation from the sender and the first second at which it would revert.
   */
  readonly gateConfirm?: { readonly epoch: bigint; readonly gas: bigint; readonly validUntil: bigint };
};

/** The values of the bridge form, as text. */
export type BridgeFormValues = {
  /** `<side>:<token address>` or `<side>:native`. See `tokenChoiceValue` in the terminal. */
  readonly token: string;
  readonly amount: string;
  readonly receiver: string;
  readonly mode: "plain" | "call";
  readonly data: string;
  /**
   * The exact gas that the follow-up call of a delivery router gets, as text. It counts only for a tipped relay with a
   * call, where it is the fifth word of the fee terms; a call needs a number above zero. The callback gas that the
   * relay passes is worked out from it, never typed.
   */
  readonly callGas: string;
  /**
   * The exact gas that `onTokenBridged` gets on the other chain, as text, for a relay with a call that carries no tip.
   * A plain relay has no gas number, and a tipped relay works the callback gas out from the call gas.
   */
  readonly callbackGas: string;
  /**
   * The contract that the delivery router calls after it pays the recipient, as text. Absent or empty means no call. It
   * counts only for a tipped relay to a delivery router.
   */
  readonly callTarget?: string;
  /** The call data for {@link BridgeFormValues.callTarget}, as hex text. Absent or empty means empty call data. */
  readonly callData?: string;
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
  const owner = input.deployed ? "delivery router" : "router (not the default delivery router)";
  return { ...argument, meaning: `${owner} on ${input.chainName}: pays the tip to its reward address, then sends the rest to ${input.recipient}` };
};

/** True when the form names a call after the delivery: a target or call data, not just spaces. */
export const hasCallText = (values: Pick<BridgeFormValues, "callTarget" | "callData">): boolean =>
  (values.callTarget ?? "").trim() !== "" || (values.callData ?? "").trim() !== "";

/**
 * Reads the call fields of the form. Empty target and empty data give null: no call.
 *
 * @throws PlanInputError when the data has no target, when the target is not an address, or when the data is not hex
 * with an even number of digits.
 */
export const parseDeliveryCallText = (values: Pick<BridgeFormValues, "callTarget" | "callData">): DeliveryCall | null => {
  const target = (values.callTarget ?? "").trim();
  const data = (values.callData ?? "").trim();
  if (target === "" && data === "") return null;
  if (target === "") throw new PlanInputError("The call data needs a call target. Enter the target contract, or clear the call data.");
  if (!/^0x[0-9a-fA-F]{40}$/.test(target) || !isAddress(target, { strict: false })) {
    throw new PlanInputError("The call target must be an address that starts with 0x and has 40 hexadecimal digits.");
  }
  if (data !== "" && !/^0x([0-9a-fA-F]{2})*$/.test(data)) {
    throw new PlanInputError("The call data must be hex that starts with 0x and has an even number of digits, such as 0xabcd.");
  }
  return { target: getAddress(target), data: data === "" ? "0x" : (data.toLowerCase() as Hex) };
};

/**
 * The values that the terminal builder reads. The callback gas rides only on a relay with a call, never on the wrap route
 * or a plain relay. The call fields and the call gas never go to the terminal builder: the call rides inside the encoded
 * data of a tip, and the callback gas of a tip is worked out from the call gas.
 */
const terminalValuesOf = (values: BridgeFormValues, input: { isNative: boolean }): Record<string, string> => {
  const { callGas: _gas, callbackGas, callTarget: _target, callData: _data, ...rest } = values;
  if (input.isNative || values.mode === "plain" || callbackGas.trim() === "") return rest;
  return { ...rest, callbackGas };
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
  const sourceChain = side === "first" ? context.pair.first : context.pair.second;
  const destinationChain = side === "first" ? context.pair.second : context.pair.first;
  const isNative = values.token.endsWith(`:${NATIVE_CHOICE}`);
  const token = isNative ? null : tokens.find((candidate) => candidate.side === side && `${candidate.side}:${candidate.address}`.toLowerCase() === values.token.toLowerCase());
  if (!isNative && token === undefined) throw new PlanInputError("Choose a token.");
  const amount = parseAmountText(values.amount, token === null || token === undefined ? 18 : token.decimals);
  const receiver = parseAddress(values.receiver, "receiver");
  const call = parseDeliveryCallText(values);
  const terminalValues = terminalValuesOf(values, { isNative });
  const amountToken = token === null || token === undefined ? { symbol: `wrapped ${sourceChain.nativeSymbol}`, decimals: 18 } : { symbol: token.symbol, decimals: token.decimals };

  if (delivery === null) {
    if (call !== null) throw new PlanInputError("A call after the delivery needs a tip, because only the delivery router makes it. Choose a tip, or clear the call fields.");
    const steps = buildBridgeSteps(terminalValues, tokens, context);
    return withDisclosure(steps, { amountToken, destinationNativeSymbol: destinationChain.nativeSymbol, destinationChainId: destinationChain.chainId, destinationChainName: destinationChain.name, delivery: null });
  }

  // The token that the router of the other chain receives: the counterpart of the token, or for the native coin the copy
  // of the wrapped native token (null while the copy is not deployed: the guard then reads no token).
  const destinationToken = isNative ? crossingCopyOf(sourceChain, tokens) : (token as TokenInfo).counterpart;
  // The guard of the router runs on the whole data, and it refuses a zero, router, mediator or bridge target.
  const data = encodeDirectorFor(delivery.director, context.pair, { router: delivery.router, destination: destinationChain, destinationToken }, call ?? undefined);
  const deployed = getAddress(delivery.router) === getAddress(delivery.defaultRouter);
  // The callback gas of a router is worked out here, from the call gas in the terms. The relay passes it as the mediator wants it.
  const callbackGasNumber = routerCallbackGas(call === null ? {} : { callGas: delivery.director.callGas });
  const explain = (argument: DisplayArgument): DisplayArgument => explainRouterReceiver(argument, { chainName: destinationChain.name, recipient: receiver, deployed });
  const disclosure = { amountToken, destinationNativeSymbol: destinationChain.nativeSymbol, destinationChainId: destinationChain.chainId, destinationChainName: destinationChain.name, delivery, deliveryCall: call };
  if (isNative) {
    // The plain wrap step checks the amount, the balance, the receiver and the router of the source chain; the tipped
    // step sends the same value to the same router, with the terms.
    const [wrap] = buildBridgeSteps(terminalValues, tokens, context);
    return withDisclosure([{ plan: planWrapAndRelayWithTip({ wrap: (wrap as FlowStep).plan, router: delivery.router, data, callbackGas: callbackGasNumber, explain }), skippable: false }], disclosure);
  }
  const steps = buildBridgeSteps({ ...terminalValues, receiver: delivery.router, mode: "call", data, callbackGas: String(callbackGasNumber) }, tokens, context);
  const adjusted = steps.map((step): FlowStep => ({
    ...step,
    plan: step.plan.functionName === "relayTokensAndCall" ? { ...step.plan, arguments: step.plan.arguments.map(explain) } : step.plan,
  }));
  return withDisclosure(adjusted, disclosure);
};

/**
 * The tipped send of the native coin: `relayTokensAndCall(router, terms, callbackGas, gateEvidence)` on the delivery
 * router of the source chain, with the coin as the value and empty gate evidence. It keeps the chain, the router, the
 * value and the gate evidence argument of the plain wrap step.
 */
const planWrapAndRelayWithTip = (input: { wrap: PlannedTransaction; router: Address; data: Hex; callbackGas: bigint; explain: (argument: DisplayArgument) => DisplayArgument }): PlannedTransaction => {
  const { wrap, router, data, callbackGas, explain } = input;
  const symbol = wrap.chain.nativeSymbol;
  return {
    ...wrap,
    title: `Wrap ${symbol} and relay it to the router of the other chain`,
    functionSignature: "relayTokensAndCall(address,bytes,uint256,bytes)",
    functionName: "relayTokensAndCall",
    data: encodeFunctionData({ abi: deliveryRouterAbi, functionName: "relayTokensAndCall", args: [router, data, callbackGas, "0x"] }),
    arguments: [
      explain({ name: "receiver", type: "address", value: getAddress(router) }),
      { name: "data", type: "bytes", value: data, meaning: `${(data.length - 2) / 2} bytes` },
      { name: "callbackGas", type: "uint256", value: callbackGas.toString(), meaning: "the exact gas that onTokenBridged gets on the other chain" },
      wrap.arguments.at(-1)!,
    ],
    notes: [`The transaction sends ${wrap.value.toString()} wei of ${symbol}. The router wraps it, then relays it with the fee terms to the router of the other chain, which pays the tip and sends the rest to the recipient.`],
  };
};

/**
 * The last step is the relay and carries the tip. An allowance before it carries the same tip, marked as the tip of the
 * next transaction, so the user sees what the whole sequence costs before the first signature.
 */
const withDisclosure = (steps: readonly FlowStep[], relayDisclosure: Omit<StepDisclosure, "feesApplyTo">): readonly WebStep[] =>
  steps.map((step, index): WebStep => ({
    plan: step.plan,
    disclosure: { ...relayDisclosure, feesApplyTo: index === steps.length - 1 ? "this-transaction" : "next-transaction" },
  }));
