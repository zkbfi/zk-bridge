/**
 * What the confirm dialog shows before the wallet opens. The call is decoded from the calldata itself, not taken from
 * the plan, and the two must agree. When they do not, the dialog blocks the signature.
 */
import { decodeFeeDirector, feeModeOf, TIP_MODE_NAMES, type FeeDirector } from "@zk-bridge/shared";
import { formatUnits, formatRateAsPercent } from "@terminal/format/amounts";
import type { RouterAddressesReading } from "@terminal/chain/live-reads";
import { decodeKnownCall } from "@terminal/tx/decode";
import type { DisplayArgument } from "@terminal/tx/plan";
import { decodeFunctionData, getAddress, isAddress, type AbiFunction, type Address, type Hex } from "viem";
import type { WebStep } from "./bridge-steps";
import { NO_ROUTER_NOTICE, RUNNER_NOTES, routerWarningOf } from "./tip-copy";
import { confirmableAbis } from "./web-abis";

/** One labelled line of the dialog. */
export type ConfirmLine = { readonly label: string; readonly text: string };

/** The bridge fee lines. */
export type BridgeFeeView = {
  /** A sentence that says which transaction pays the fees. */
  readonly appliesTo: string;
  readonly lines: readonly ConfirmLine[];
};

const APPLIES_TO = {
  "this-transaction": "paid by this transaction",
  "next-transaction": "paid by the relay that follows this allowance",
} as const;

/** The tip lines. */
export type DeliveryView = {
  /** A sentence that says which transaction pays the tip. */
  readonly appliesTo: string;
  /** The address of the router that receives the relay. */
  readonly routerText: string;
  /** A warning when the router is not the default delivery router, or null. */
  readonly routerWarning: string | null;
  /** The address that receives the tip, as the router answered, or `unknown`. */
  readonly rewardAddressText: string;
  /** What happens when the router cannot deliver: `the tokens go to <address>`, or a sentence that the address could not be read. */
  readonly failedDeliveryText: string;
  /** A warning to check the router before signing when its addresses could not be read, or null. */
  readonly routerAddressesWarning: string | null;
  /** The tip mode in words: `percentage of the transfer`, `fixed amount` or `gas multiplier`. */
  readonly tipMode: string;
  /** The tip now, with its label: `0.25 zkbUSDC (exact)` or `about 1 WPLS now (estimate, at most 2 WPLS)`. */
  readonly tipNow: string;
  /** `exact` or `estimate, at most 2 USDC`. */
  readonly certaintyLabel: string;
  readonly summary: string;
  readonly formula: string;
  /** The most that the runner can take, as a sentence with the amount. */
  readonly runnerMaximum: string;
  /** What the runner and a direct delivery mean for the tip: one whitelisted runner, no tip on a direct delivery. */
  readonly runnerNotes: readonly string[];
  readonly costLines: readonly ConfirmLine[];
  readonly dataSource: string;
  readonly baseFee: string;
  /** The decoded terms of the director in the call data. */
  readonly directorLines: readonly ConfirmLine[];
};

/** The whole dialog for one transaction. */
export type ConfirmView = {
  readonly title: string;
  readonly chainText: string;
  readonly contractText: string;
  readonly functionSignature: string;
  /** The arguments, decoded from the calldata. */
  readonly arguments: readonly DisplayArgument[];
  readonly valueText: string;
  readonly bridgeFees: BridgeFeeView | null;
  readonly delivery: DeliveryView | null;
  /** For a relay with no tip: a sentence that says that no router is involved. Null otherwise. */
  readonly noRouterNotice: string | null;
  readonly notes: readonly string[];
  /** Why the signature is blocked, or null when it is allowed. */
  readonly blockedReason: string | null;
};

const withSymbol = (units: bigint, token: { readonly symbol: string; readonly decimals: number }): string =>
  `${formatUnits(units, token.decimals)} ${token.symbol}`;


const directorLinesOf = (director: FeeDirector, token: { readonly symbol: string; readonly decimals: number }): readonly ConfirmLine[] => {
  const mode = feeModeOf(director.settings);
  return [
    { label: "Recipient after the fee", text: getAddress(director.recipient) },
    { label: "Settings", text: `${director.settings} (${TIP_MODE_NAMES[mode]})` },
    { label: "Limit", text: `${director.limit} base units (${withSymbol(director.limit, token)})` },
    { label: "Multiplier", text: `${director.multiplier} (${mode === "share" ? `${formatRateAsPercent(director.multiplier)} of the value` : `${formatUnits(director.multiplier, 18)} times the gas price`})` },
  ];
};

const mergeMeanings = (decoded: readonly DisplayArgument[], planned: readonly DisplayArgument[]): readonly DisplayArgument[] =>
  decoded.map((argument) => {
    const meaning = planned.find((candidate) => candidate.name === argument.name)?.meaning;
    return meaning === undefined || argument.meaning !== undefined ? argument : { ...argument, meaning };
  });

const bridgeViewOf = (step: WebStep): BridgeFeeView | null => {
  const { bridgeFees, amountToken } = step.disclosure;
  if (bridgeFees === null || amountToken === null) return null;
  return {
    appliesTo: APPLIES_TO[step.disclosure.feesApplyTo],
    lines: [
      { label: "Bridge fee on the source chain", text: `${formatRateAsPercent(bridgeFees.sourceRate)} = ${withSymbol(bridgeFees.sourceFee, amountToken)} (exact)` },
      { label: "Bridge fee on delivery", text: `${formatRateAsPercent(bridgeFees.destinationRate)}: at most ${withSymbol(bridgeFees.destinationFeeAtMost, amountToken)}. The rate only falls.` },
      { label: "Arrives", text: `at least ${withSymbol(bridgeFees.arrivesAtLeast, amountToken)}, before any delivery fee` },
    ],
  };
};

const RELAY_FUNCTIONS: readonly string[] = ["relayTokens", "relayTokensWithFallback", "wrapAndRelayTokens"];

const noRouterNoticeOf = (step: WebStep): string | null => {
  if (step.disclosure.delivery !== null) return null;
  return RELAY_FUNCTIONS.includes(step.plan.functionName) ? NO_ROUTER_NOTICE : null;
};

const ADDRESSES_UNREADABLE_WARNING =
  "The page could not read the reward address and the failed delivery address from the router. Check the router before you sign: you do not know who gets the tip, or who gets the tokens when delivery fails.";

type RouterAddressesView = Pick<DeliveryView, "rewardAddressText" | "failedDeliveryText" | "routerAddressesWarning">;

const routerAddressesViewOf = (reading: RouterAddressesReading | undefined): RouterAddressesView => {
  if (reading === undefined || reading.kind === "unreadable") {
    return {
      rewardAddressText: "unknown",
      failedDeliveryText: "unknown: the page could not read the failed delivery address of the router",
      routerAddressesWarning: ADDRESSES_UNREADABLE_WARNING,
    };
  }
  return {
    rewardAddressText: getAddress(reading.rewardAddress),
    failedDeliveryText: `the tokens go to ${getAddress(reading.failedDeliveryAddress)} (failed delivery address of the router)`,
    routerAddressesWarning: null,
  };
};

const deliveryViewOf = (step: WebStep, routerAddresses: RouterAddressesReading | undefined): DeliveryView | null => {
  const { delivery } = step.disclosure;
  if (delivery === null) return null;
  const { description, suggestions, token } = delivery;
  const native = step.disclosure.destinationNativeSymbol ?? step.plan.chain.nativeSymbol;
  return {
    appliesTo: APPLIES_TO[step.disclosure.feesApplyTo],
    certaintyLabel: description.certaintyLabel,
    summary: description.summary,
    formula: description.formula,
    routerText: getAddress(delivery.router),
    routerWarning: routerWarningOf(delivery),
    ...routerAddressesViewOf(routerAddresses),
    tipMode: TIP_MODE_NAMES[description.mode],
    tipNow: description.summary,
    runnerMaximum: `The runner can take at most ${withSymbol(delivery.maximumRunnerTake, token)}. Everything else goes to the recipient.`,
    runnerNotes: RUNNER_NOTES,
    costLines: description.breakdown.map((line) => ({
      label: line.label,
      text: `${formatUnits(line.amountWei, 18)} ${native} (estimate: ${line.note})`,
    })),
    dataSource: `${suggestions.dataSource.description}, ${suggestions.dataSource.gas} gas`,
    baseFee: suggestions.dataSource.baseFeeDescription,
    directorLines: directorLinesOf(delivery.director, token),
  };
};

/**
 * Builds the dialog for one step.
 *
 * @param step The planned transaction and its disclosure.
 * @param routerAddresses What the router answered for its reward address and failed delivery address. Undefined when
 * the page has not read them: the dialog then names no address.
 */
export const buildConfirmView = (step: WebStep, routerAddresses?: RouterAddressesReading): ConfirmView => {
  const { plan } = step;
  const decoded = decodeKnownCall(plan.data, confirmableAbis);
  const blockedReason = blockedReasonOf(step, decoded);
  return {
    title: plan.title,
    chainText: `${plan.chain.name} (chain ${plan.chain.chainId})`,
    contractText: `${plan.contractLabel} at ${getAddress(plan.to as Address)}`,
    functionSignature: plan.functionSignature,
    arguments: decoded === null ? [] : mergeMeanings(decoded.arguments, plan.arguments),
    valueText: `${formatUnits(plan.value, 18)} ${plan.chain.nativeSymbol}`,
    bridgeFees: bridgeViewOf(step),
    delivery: deliveryViewOf(step, routerAddresses),
    noRouterNotice: noRouterNoticeOf(step),
    notes: plan.notes,
    blockedReason,
  };
};

const blockedReasonOf = (step: WebStep, decoded: ReturnType<typeof decodeKnownCall>): string | null => {
  if (decoded === null) return "The page cannot read this call from its bytes, so it will not send it.";
  if (decoded.functionSignature !== step.plan.functionSignature) {
    return `The bytes call ${decoded.functionSignature}, but the page planned ${step.plan.functionSignature}. Nothing was sent.`;
  }
  const { delivery, feesApplyTo } = step.disclosure;
  if (delivery === null || feesApplyTo === "next-transaction") return null;
  return routerMismatch(decoded.arguments, delivery.router) ?? directorMismatch(step, delivery.director);
};

/** The router that the user saw must be the receiver in the call. */
const routerMismatch = (decoded: readonly DisplayArgument[], shown: Address): string | null => {
  const receiver = decoded.find((argument) => argument.name === "receiver")?.value;
  if (receiver === undefined || !isAddress(receiver)) return "The call names no router, but a tip was chosen.";
  return getAddress(receiver) === getAddress(shown) ? null : "The router in the call differs from the one that was shown. Nothing was sent.";
};

/** The whole `data` argument of the call, as the wallet will receive it. The display lines cut long bytes. */
const rawDataArgument = (calldata: Hex): Hex | null => {
  for (const abi of confirmableAbis) {
    try {
      const call = decodeFunctionData({ abi, data: calldata });
      // The decoder returns only a function name that the ABI holds, so the search always finds the item.
      const item = abi.find((entry): entry is AbiFunction => entry.type === "function" && entry.name === call.functionName) as AbiFunction;
      const index = item.inputs.findIndex((input) => input.name === "data");
      const value = index < 0 ? undefined : call.args?.[index];
      if (typeof value === "string") return value as Hex;
    } catch {
      // This ABI does not hold the function. Try the next one.
    }
  }
  return null;
};

/** The director that the user saw must be the director in the call data. */
const directorMismatch = (step: WebStep, shown: FeeDirector): string | null => {
  const data = rawDataArgument(step.plan.data);
  if (data === null) return "The call carries no fee director, but a delivery fee was chosen.";
  try {
    const found = decodeFeeDirector(data);
    const same =
      found.recipient.toLowerCase() === shown.recipient.toLowerCase() &&
      found.settings === shown.settings &&
      found.limit === shown.limit &&
      found.multiplier === shown.multiplier;
    return same ? null : "The fee director in the call data differs from the one that was shown. Nothing was sent.";
  } catch {
    return "The fee director in the call data cannot be read.";
  }
};
