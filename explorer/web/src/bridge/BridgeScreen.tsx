import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { erc20ReaderFor, isFirstBridge, resolveCustomToken } from "./custom-token";
import { addPending } from "./pending";
import { priceNumber, usdText, type PriceQuote } from "./price-oracle";
import { PRICE_NOTE, usePrices } from "./use-prices";
import { priceNotice } from "./price-notice";
import { AUTOMATIC_MAXIMUM_TEXT, dappTipVerdict } from "./tip-verdict";
import type { Address } from "viem";
import type { TokenInfo } from "@terminal/model/types";
import { useDeliveryCost, useHeads, useMaxFee, usePairHealth, usePriorityFee, useSnapshots, useTokens, useUsedTokens } from "../app/queries";
import { formatRoute, type BridgeQuery, type Route, type TipQuery } from "../app/route";
import { useServices } from "../app/services";
import { TransactionDialog } from "../actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, DEFAULT_GAS_MARGIN_TEXT, type DeliveryOptions } from "../tx/bridge-draft";
import type { WebStep } from "../tx/bridge-steps";
import { parseUnits } from "../ui/format";
import { useWallet } from "../wallet/wallet-port";
import { WaitTimeline } from "../wait/WaitTimeline";
import { durationText, type FeeReading } from "../wait/wait-model";
import { useTimeline } from "../wait/use-wait";
import { arrivesAsSymbol, isNativeToken, lightClientDelay, maxSendable, nativeTokensOf, tokenBalance } from "./bridge-model";
import { amountText, chainsFor, choiceOf, counterpartOf, directionFrom, reverse, sourceSide, tokenFor, transferSteps, withLightClientStep } from "./bridge-model";
import { DeliveryMenu, deliverySummary, type TipChoiceKey } from "./DeliveryMenu";
import { nativeSymbolOf, ceilingCostUsd, ceilingWeiOf, DEFAULT_GAS_LEVEL, deliveryGasUsd, feeSpanUsd, GAS_LEVELS, gasLevelOfCeiling, gasRange, PROOF_COST_USD, shareWadOfPercentText, totalCostUsd, routerCallbackGas, MAX_CALL_GAS, usdOf, WAD, type CostInput, type GasLevel } from "@zk-bridge/shared";
import { formatUnits } from "viem";
import { DEFAULT_AUTO_CAP_PERCENT, DEFAULT_HARD_CAP_PERCENT, feeCapProblem, ReviewNotice, ReviewRow, ReviewSheet, priceProblemOf, useDefaultFee, useFeeCaps, useFeeWarnings, useHardCap, useVerdict } from "@zkb/react";
import { DirectionMenu } from "./DirectionMenu";
import { FeeLine, GAS_LEVEL_NAMES, nextGasLevel, type FeeSlider } from "./FeeLine";
import { Chevron, FlipIcon, FloppyIcon, Identicon, LockIcon, UnlockIcon } from "./icons";
import { destinationProblem, LOCK_TIPS } from "./destination";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
import { dollarsSpanWords, dollarsText as dollarsOf } from "./number";
import { TokenIcon } from "./TokenIcon";
import { TokenPicker } from "./TokenPicker";
import { routerWarningOf } from "../tx/tip-copy";

/** Names every field a link filled beyond the route, the token and the amount. */
const LinkedWarning = ({ fields }: { readonly fields: readonly string[] }) => (
  <div className="zb-warnbox" role="alert">
    The link you opened filled in: {fields.join(", ")}. Check them before you confirm. Nothing is sent until you confirm in your wallet.
  </div>
);

/** Props of {@link BridgeScreen}. */
export type BridgeScreenProps = {
  readonly route: Extract<Route, { name: "bridge" }>;
  /** Writes a changed route (direction, form fields) to the address in place. */
  readonly onRoute: (next: Route) => void;
  readonly fixture: boolean;
  /** The fields a link filled that the user must check (receiver, tip settings, router, gas). */
  readonly linked?: readonly string[];
};

/** The receiver the fee estimate reads when no wallet is connected. Never sent anywhere. */
const ESTIMATE_RECEIVER = "0x000000000000000000000000000000000000dEaD";

/** An address in full. When the row is too narrow the browser shortens the head with an ellipsis and the last six
 *  characters stay, so the end of the address, the part people check, is always visible. Selecting or copying it
 *  gives the whole address. */
function AddressText({ address }: { address: string }) {
  const tail = 6;
  return (
    <span className="zb-addr zb-mono" title={address} aria-label={address}>
      <span className="zb-addr-head">{address.slice(0, -tail)}</span>
      <span className="zb-addr-tail">{address.slice(-tail)}</span>
    </span>
  );
}

/** The tip defaults to a share of the amount (owner: "default is a percent anyway"); the address can change it. */
const optionsOf = (tip: TipQuery | undefined): DeliveryOptions => ({ ...DEFAULT_DELIVERY_OPTIONS, mode: "percentage", ...tip });

/** A share of the amount (1e18 = 100%) as the percentage text the tip settings keep, exactly. */
const percentTextOfWad = (wad: bigint): string => formatUnits(wad, 16);
/** A share rounded to the nearest multiple of a grain. */
const nearest = (wad: bigint, grain: bigint): bigint => ((wad + grain / 2n) / grain) * grain;
/** The grain of a tip the drawer shows and keeps: 0.0001% of the amount. */
const TIP_GRAIN = 10n ** 12n;
/** The grain of a share the tip slider and the gas bars sign: 0.000001% of the amount. */
const SIGNED_GRAIN = 10n ** 10n;

/** A number as short text, at most `digits` decimals, no trailing zeros. */
const plain = (value: number, digits = 4): string => String(Number(value.toFixed(digits)));

/** Why a typed percentage cannot be used, or null. */
const percentProblem = (text: string): string | null => {
  const value = Number(text.trim().replace(/%$/, ""));
  if (text.trim() === "" || !Number.isFinite(value)) return "Enter a number, such as 0.5.";
  return value < 0 || value > 100 ? "Use a number from 0 to 100." : null;
};

const safeParse = (text: string, decimals: number): bigint | null => {
  try {
    return text.trim() === "" ? null : parseUnits(text.trim(), decimals);
  } catch {
    return null;
  }
};

/**
 * The bridge screen (the home): the From row, the orange From band, the seam, the fee line, the To band, the To row and
 * the Bridge pill, then the review sheet. Every field lives in the address (route.form), so a link reproduces it.
 *
 * @param props The route and the handler that writes it.
 */
export const BridgeScreen = ({ route, onRoute, fixture, linked = [] }: BridgeScreenProps) => {
  const { pair } = useServices();
  const wallet = useWallet();
  const account = wallet.status === "connected" ? wallet.account : null;
  const { configuration, connection } = useServices();
  const known = useTokens(pair.id).data ?? [];
  const [customTokens, setCustomTokens] = useState<readonly TokenInfo[]>([]);
  // The native coins come last in the list; the default token is still the source chain's gas token (tokenFor).
  const tokens = useMemo(() => [...known, ...customTokens, ...nativeTokensOf(pair)], [known, customTokens, pair]);
  const rpcFor = (chainId: number): string | null => connection?.resolved().rpcUrls[chainId]?.value ?? configuration.rpcUrls[chainId] ?? defaultRpcUrl(chainId);
  const resolveCustom = useCallback(
    async (address: string, side: "first" | "second"): Promise<TokenInfo | null> => {
      const chain = side === "first" ? pair.first : pair.second;
      const rpc = rpcFor(chain.chainId);
      return rpc === null ? null : resolveCustomToken(address, side, erc20ReaderFor(rpc));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pair, configuration, connection],
  );
  const snapshots = useSnapshots(account, pair.id).data;
  const heads = useHeads(pair.id).data;
  const used = useUsedTokens(account, pair.id).data;
  const gate = usePairHealth().data?.find((entry) => entry.pairId === pair.id)?.gates[sourceSide(route.dir)];
  const form: BridgeQuery = route.form ?? {};
  const { source, destination } = chainsFor(pair, route.dir);
  const side = sourceSide(route.dir);
  const token = tokenFor(form.token, tokens, side);
  const baseOptions = useMemo(() => optionsOf(form.tip), [form.tip]);
  const { storedCap, storedHardCap, hardCapPercent, setHardCapPercent, saveCap: storeCap, saveHard } = useFeeCaps();
  // The hard cap lives in this browser only: a link never raises it (owner, quote 86: the absolute most the fee may be).
  // The automatic cap never goes above the hard cap, whatever a link or the store says.
  const capPercent = Math.min(form.tip?.capPercentText === undefined ? storedCap : Number(form.tip.capPercentText) || storedCap, hardCapPercent);
  // The fee is automatic until the user picks a share: the larger of the default curve and twice the cost, capped.
  const automatic = baseOptions.mode === "percentage" && form.tip?.percentText === undefined;
  const report = useDeliveryCost(destination.chainId, { enabled: token !== null });
  const priority = usePriorityFee(destination.chainId, { enabled: token !== null });
  const [menu, setMenu] = useState<"direction" | "token" | null>(null);
  const [review, setReview] = useState(false);
  const [signing, setSigning] = useState<readonly WebStep[] | null>(null);

  const write = (next: BridgeQuery, dir = route.dir): void => {
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "")) as BridgeQuery;
    onRoute({ name: "bridge", pairId: route.pairId, dir, ...(Object.keys(cleaned).length === 0 ? {} : { form: cleaned }) });
  };

  // The destination row (owner, quotes 96–97): locked (the default), the transfer goes to the connected wallet and
  // follows it; unlocked, to the address typed in place. A link that names a receiver opens it unlocked.
  const [unlockedHere, setUnlockedHere] = useState(() => form.receiver !== undefined);
  const unlocked = unlockedHere || form.receiver !== undefined;
  const typedReceiver = form.receiver ?? "";
  const receiver = unlocked ? typedReceiver : (account ?? "");
  const receiverProblem = unlocked ? destinationProblem(typedReceiver) : null;
  // Without a wallet, or while the destination is being typed, the fee is still estimated: the draft reads an empty
  // account on the source chain and a stand-in receiver. Nothing can be sent that way: the pill asks for a wallet, or
  // names the destination's problem, first.
  const estimateReceiver = receiver === "" || (unlocked && receiverProblem !== null) ? ESTIMATE_RECEIVER : receiver;
  const values = { token: token === null ? "" : choiceOf(token), amount: form.amount ?? "", receiver: estimateReceiver, mode: "plain" as const, data: "", callGas: form.callGas ?? "", callbackGas: "", callTarget: form.callTarget ?? "", callData: form.callData ?? "" };
  const context = {
    pair,
    snapshots: account === null ? [{ status: "ok" as const, snapshot: { chain: source, nativeBalance: 0n, positions: [] } }] : (snapshots ?? []),
    signerAddress: account ?? ("0x0000000000000000000000000000000000000000" as Address),
  };
  const draftWith = (chosen: DeliveryOptions) => computeBridgeDraft(values, chosen, { pair, tokens, context, report: report.data ?? null, priorityFeeWei: priority.data ?? null });
  const probe = useMemo(
    () => draftWith(baseOptions),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(values), baseOptions, pair, tokens, snapshots, report.data, priority.data],
  );

  const snapshot = (snapshots ?? []).find((result) => result.status === "ok" && result.snapshot.chain.side === side);
  const balance = token === null || snapshot === undefined ? null : tokenBalance(token, [snapshot]);
  const maxFee = useMaxFee(source.chainId, { enabled: token !== null && isNativeToken(token) && account !== null }).data ?? null;
  const max = balance === null || token === null ? null : maxSendable(token, balance, maxFee);
  const amount = token === null ? null : safeParse(form.amount ?? "", token.decimals);
  const { data: prices, states: priceStates } = usePrices(tokens);
  // Money is integers (shared fee rules): prices and values in USD × 1e18, shares × 1e18.
  const nativeQuote = prices?.get(`native:${destination.chainId}`) ?? null;
  const priceOf = (subject: TokenInfo | null): PriceQuote | null => (subject === null ? null : (prices?.get(`${subject.side}:${subject.address}`) ?? null));
  const tokenQuote = priceOf(token);
  const valueOf = (units: bigint | null): bigint | null => (units === null || tokenQuote === null || token === null ? null : usdOf(units, token.decimals, tokenQuote.usdE18));
  const dollarsText = (value: bigint | null): string => (value === null ? "—" : dollarsOf(value));
  const usd = (units: bigint | null): string => dollarsText(valueOf(units));
  const costInputAt = (level: GasLevel): CostInput | null =>
    probe.delivery === null || nativeQuote === null
      ? null
      : { gasUsed: probe.delivery.suggestions.dataSource.gas, baseFeeWei: probe.delivery.suggestions.dataSource.baseFeeWei, priorityFeeWei: probe.delivery.priorityFeeWei, nativePriceE18: nativeQuote.usdE18, level };
  const costAt = (level: GasLevel): bigint | null => {
    const input = costInputAt(level);
    return input === null ? null : totalCostUsd(input);
  };
  // Today's base fee on the destination, from the draft or, before an amount is typed, from the indexer's report, so the
  // gas bars work at once. A base fee of 0 (or a few wei, as on the testnets) still needs a ceiling that says the level,
  // so the level is read and written against at least 1 wei.
  const reportBaseFee = report.data?.baseFee.wei;
  const baseFeeWei = probe.delivery?.suggestions.dataSource.baseFeeWei ?? (reportBaseFee == null ? null : BigInt(reportBaseFee));
  const levelBaseWei = baseFeeWei === null ? null : baseFeeWei > 0n ? baseFeeWei : 1n;
  const ceilingWeiText = form.tip?.ceilingGweiText === undefined ? null : safeParse(form.tip.ceilingGweiText, 9);
  const gasLevel = gasLevelOfCeiling(ceilingWeiText, levelBaseWei);
  const costUsd = costAt(gasLevel);
  const costDefaultUsd = costAt(DEFAULT_GAS_LEVEL);
  const amountUsd = valueOf(amount);
  // A level above the default adds its extra expected cost on top of the curve, so the automatic fee rises with the bars too.
  // When the amount's value or the cost cannot be priced (no market, or the source is unreachable with no recent price
  // held), the default fee is the automatic maximum: the cap in force, 1% unless the user moved it (owner: "use 1% - the
  // frontend's auto maximum whenever the frontend cannot determine the price"). A price still held (stale) is used.
  const priceKeys = token === null ? [] : [`${token.side}:${token.address}`, `native:${destination.chainId}`];
  const priceProblem = priceProblemOf(priceStates, priceKeys);
  // The native coin carries a tip like a token (it goes through the source router's relayTokensAndCall, native-route.ts),
  // so the same fallback applies to it.
  const unpriced = amount !== null && amount > 0n && (amountUsd === null || costUsd === null) && priceProblem !== null && priceProblem.state.kind !== "stale";
  const { capWad, auto } = useDefaultFee({ amountUsd, costUsd, costDefaultUsd, capPercent, unpriced });
  // The automatic fee signs the default share; a gas-based fee signs a limit no higher than the cap's share (owner,
  // quotes 70–71: "limited by the cap").
  const options = useMemo(
    () =>
      automatic
        ? { ...baseOptions, percentText: formatUnits(auto.shareWad, 16) }
        : baseOptions.mode === "gas-multiplier"
          ? { ...baseOptions, gasCapRate: capWad }
          : baseOptions,
    [automatic, baseOptions, auto.shareWad, capWad],
  );
  const draft = useMemo(
    () => (options === baseOptions ? probe : draftWith(options)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [probe, options, baseOptions],
  );
  const delivery = draft.delivery;
  const tipUnits = delivery?.description.nowUnits ?? null;
  const range = delivery?.suggestions.tipRange;
  const breakEven = range?.kind === "available" ? range.low.description.nowUnits : null;
  const typical = range?.kind === "available" ? range.default.description.nowUnits : null;
  const received = amount !== null && tipUnits !== null ? amount - tipUnits : amount;
  // What the output can say about the fee: none to take (No tip, or no router on the destination), known, being estimated, or unknown.
  const feeState: "none" | "known" | "estimating" | "unknown" =
    token === null || amount === null || draft.tip?.kind !== "on" || options.mode === "none"
      ? "none"
      : tipUnits !== null
        ? "known"
        : report.isError || priority.isError || draft.deliveryProblem !== null
          ? "unknown"
          : "estimating";
  // The automatic fee is the rule's own figure; a share the draft signs from it rounds down by at most a unit.
  const feeUsd = automatic && auto.feeUsd !== null && tipUnits !== null ? auto.feeUsd : valueOf(tipUnits);
  // The wait the pill shows follows the fee: one that pays for a proof starts it at finality, one that does not waits for a batch.
  // The one tip verdict of zkb.fi, as the backend and the runner judge it: a tip in a token with no price pays at the
  // automatic maximum (1% of the amount), and its proof then starts at finality.
  const tipVerdict = token === null ? null : dappTipVerdict({ prices, states: priceStates, tokenKey: `${token.side}:${token.address}`, destinationChainId: destination.chainId, decimals: token.decimals, amount, tipUnits: feeState === "known" ? tipUnits : null, feeUsd, costUsd });
  const unpricedVerdict = tipVerdict === "unpriced-at-max" || tipVerdict === "unpriced-below-max";
  const waitFee: FeeReading = unpricedVerdict
    ? { kind: "unpriced", atMaximum: tipVerdict === "unpriced-at-max" }
    : feeUsd !== null && costDefaultUsd !== null && feeState === "known"
      ? { kind: "known", feeUsd, costUsd: costDefaultUsd }
      : { kind: "unknown" };
  const timeline = useTimeline(route.dir, waitFee);
  const gasBased = options.mode === "gas-multiplier";
  const expandedUsd = (() => {
    const input = costInputAt(gasLevel);
    return input === null ? null : ceilingCostUsd(input);
  })();
  const shareWithoutPriceWad = options.mode === "percentage" ? shareWadOfPercentText(options.percentText) : amount === null || amount === 0n || tipUnits === null ? null : (tipUnits * WAD) / amount;
  const { warnings, linePercent, thresholdText } = useFeeWarnings({
    amountUsd: amountUsd,
    capWad,
    feeUsd: feeUsd,
    costUsd: costUsd,
    costDefaultUsd: costDefaultUsd,
    shareWithoutPriceWad,
    belowBreakEven: tipUnits !== null && breakEven !== null && tipUnits < breakEven,
    gasBased,
    expandedCostUsd: expandedUsd,
  });
  const levelName = (level: GasLevel): string => GAS_LEVEL_NAMES[level];
  // The share to sign for a tip (a share of the amount) on top of a cost, to the nearest 0.000001%: short text in the
  // address, and the dust of a near-free delivery gas never shows as a last-digit unit. Null without a price.
  const signedShareFor = (tipWad: bigint, cost: bigint): bigint | null => (amountUsd === null || amountUsd <= 0n ? null : nearest(tipWad + (cost * WAD) / amountUsd, SIGNED_GRAIN));
  // The tip before gas of the fee now, as a share to the nearest 0.0001%: what the drawer shows and what a new gas level
  // keeps, so moving the bars back and forth lands on the same fee instead of drifting.
  const tipWadNow = (cost: bigint | null): bigint | null => {
    if (feeUsd === null || cost === null || amountUsd === null || amountUsd <= 0n) return null;
    return nearest(feeUsd > cost ? ((feeUsd - cost) * WAD) / amountUsd : 0n, TIP_GRAIN);
  };
  // A share the user set, rebased on a new cost: the tip before gas stays, the fee moves by the cost's change.
  const rebasedPercentText = (from: bigint | null, to: bigint | null): string | undefined => {
    if (automatic || options.mode !== "percentage" || to === null) return undefined;
    const tipWad = tipWadNow(from);
    const next = tipWad === null ? null : signedShareFor(tipWad, to);
    return next === null ? undefined : percentTextOfWad(next);
  };
  // The bars beside the gas can (owner, quote 81): a new level writes its ceiling (none at the default, Normal) and, for a share the
  // user set, adds the level's extra expected cost to it. The automatic fee follows by itself (its floor is twice the
  // cost at the level). Either way every number moves: "a new level of fee spend has been consented to".
  const setGasLevel = (level: GasLevel): void => {
    const { ceilingGweiText: _drop, ...rest } = form.tip ?? {};
    const ceiling = levelBaseWei === null || level === DEFAULT_GAS_LEVEL ? undefined : formatUnits(ceilingWeiOf(levelBaseWei, level), 9);
    const percentText = rebasedPercentText(costAt(gasLevel), costAt(level));
    write({ ...form, tip: { ...rest, ...(percentText === undefined ? {} : { percentText }), ...(ceiling === undefined ? {} : { ceilingGweiText: ceiling }) } });
  };
  // A ceiling typed or dragged in the delivery menu: the level it stands for moves the cost, and a share the user set
  // is rebased as the bars do.
  const setCeiling = (wei: bigint): void => {
    if (levelBaseWei === null || wei <= 0n) return;
    const level = gasLevelOfCeiling(wei, levelBaseWei);
    const { ceilingGweiText: _drop, ...rest } = form.tip ?? {};
    const percentText = rebasedPercentText(costAt(gasLevel), costAt(level));
    write({ ...form, tip: { ...rest, ...(percentText === undefined ? {} : { percentText }), ceilingGweiText: formatUnits(wei, 9) } });
  };
  const capText = `${Number(capPercent.toPrecision(3))}%`;
  const pricesNote = amount === null || amount <= 0n ? null : priceNotice({ states: priceStates, keys: priceKeys, nameOf: (key) => (key.startsWith("native:") ? destination.nativeSymbol : (token?.symbol ?? "")), unpriced: unpriced && automatic, maximumText: capText });
  const hardCapText = `${Number(hardCapPercent.toPrecision(3))}%`;
  const setCap = (value: number): void => {
    const next = Math.min(value, hardCapPercent);
    const { capPercentText: _drop, ...rest } = form.tip ?? {};
    write({ ...form, tip: { ...rest, ...(next === storedCap ? {} : { capPercentText: String(next) }) } });
  };
  // Lowering the hard cap under the automatic cap takes the automatic cap down with it.
  const setHardCap = (value: number): void => {
    setHardCapPercent(value);
    if (form.tip?.capPercentText !== undefined && Number(form.tip.capPercentText) > value) {
      const { capPercentText: _drop, ...rest } = form.tip;
      write({ ...form, tip: { ...rest, ...(value === storedCap ? {} : { capPercentText: String(value) }) } });
    }
  };
  const hardSave = { saved: hardCapPercent === storedHardCap, onSave: saveHard, label: hardCapPercent === storedHardCap ? `${hardCapText} is your hard cap` : `Save ${hardCapText} as your hard cap` };
  // The save button makes this bridge's cap the default (owner: "a little save button (floppy icon) next to the slider").
  const saveCap = (): void => {
    if (storeCap(capPercent) !== null) return;
    const { capPercentText: _drop, ...rest } = form.tip ?? {};
    write({ ...form, tip: rest });
  };
  const capSave = { saved: capPercent === storedCap, onSave: saveCap, label: capPercent === storedCap ? `${capText} is your default cap` : `Save ${capText} as your default cap` };
  // One fee pays for everything (owner: "we need to couple them in the ui"); the drawer breaks it down. The tip is what
  // is left of the fee once the cost at the chosen gas level is paid: the same tip the slider moves and "High cap %"
  // reads.
  const expectedText = (level: GasLevel): string => `${Number(GAS_LEVELS[level].expectedHalves) / 2}×`;
  const tipShareWad = tipWadNow(costUsd);
  const tipUsd = tipShareWad === null || amountUsd === null ? (feeUsd === null || costUsd === null ? null : feeUsd > costUsd ? feeUsd - costUsd : 0n) : (tipShareWad * amountUsd) / WAD;
  const breakdown =
    feeUsd === null || costUsd === null || costDefaultUsd === null || tipUsd === null
      ? []
      : [
          { label: "Delivery gas", value: dollarsText(costDefaultUsd - PROOF_COST_USD) },
          // The proof cost is a set figure ($0.025), shown exactly rather than cut to the cent.
          { label: "Proof", value: `$${formatUnits(PROOF_COST_USD, 18)}` },
          ...(gasLevel === DEFAULT_GAS_LEVEL ? [] : [{ label: `${levelName(gasLevel)} gas level`, value: costUsd >= costDefaultUsd ? `+${dollarsText(costUsd - costDefaultUsd)}` : `−${dollarsText(costDefaultUsd - costUsd)}` }]),
          { label: "Tip", value: dollarsText(tipUsd) },
          { label: "Fee", value: dollarsText(feeUsd), total: true },
        ];
  // In gas-based mode the fee can drift after signing, up to the signed limit (the tip at the ceiling).
  const drift = gasBased && delivery !== null && tipUnits !== null ? { now: usd(tipUnits), most: usd(delivery.maximumTip), level: levelName(gasLevel) } : null;

  // The hard cap (owner, quote 86): the fee now, or for a gas-based fee the most the signed terms allow, against the
  // cap's share of the amount, in base units. Above it the Bridge button is blocked until the cap is raised.
  const { check: hard, over: hardOver, raisePercent } = useHardCap({ hardCapPercent, amountUnits: amount, feeUnits: tipUnits, worstFeeUnits: gasBased && delivery !== null ? delivery.maximumTip : 0n });
  const raiseHardCap = (): void => {
    if (raisePercent !== null) setHardCap(raisePercent);
  };
  const unitsText = (units: bigint): string => (token === null ? "" : `${amountText(units, token.decimals)} ${token.symbol}${valueOf(units) === null ? "" : ` (${usd(units)})`}`);

  const { verdict, pressable: canPress } = useVerdict({
    connected: account !== null,
    draft,
    amountEntered: amount !== null && amount > 0n,
    overBalance: amount !== null && balance !== null && amount > balance,
    destinationProblem: receiverProblem,
    destinationProblemShown: typedReceiver !== "",
    symbol: token?.symbol ?? "",
    paused: gate === "stop" || gate === "sealed" ? { route: `${source.name} → ${destination.name}` } : null,
    tipBelowBreakEven: unpricedVerdict ? tipVerdict === "unpriced-below-max" : warnings.lowFee,
    unpricedTip: unpricedVerdict ? { maximumText: AUTOMATIC_MAXIMUM_TEXT } : null,
    lowFee: feeUsd === null || costUsd === null ? null : { feeText: dollarsText(feeUsd), costText: dollarsText(costUsd) },
    highTip: warnings.highCap ? { thresholdText, tipText: dollarsText(tipUsd) } : null,
    smallTransfer: warnings.smallTransfer && amountUsd !== null ? { costText: dollarsText(costUsd), capText, capAmountText: dollarsText((amountUsd * capWad) / WAD) } : null,
    firstBridge: token !== null && !isNativeToken(token) && isFirstBridge(token, known, false),
    hardCap: hard !== null && hard.over ? { capText: hardCapText, feeText: unitsText(hard.feeUnits), capAmountText: unitsText(hard.capUnits), raiseText: `${raisePercent}%`, worstCase: hard.feeUnits !== tipUnits } : null,
  });

  const tokenIcon = (subjectToken: TokenInfo, badge: number | null, size = 32, surface: "accent" | "plain" = "plain"): ReactNode => <TokenIcon subject={iconSubjectOf(subjectToken, pair)} badgeChainId={badge} symbol={subjectToken.symbol} isBridgedCopy={subjectToken.isBridgedCopy} size={size} surface={surface} />;
  const inline = (icon: ReactNode, text: string, symbol: string): ReactNode => (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      {icon}
      <Num text={text} />
      <span className="zb-visually-hidden"> {symbol}</span>
    </span>
  );

  const percent = Number(options.percentText) || 0;
  const percentText = (value: number): string => `${Number(value.toPrecision(3))}%`;
  const share = (units: bigint | null): number | null => (units === null || amount === null || amount === 0n ? null : Number((units * 1_000_000n) / amount) / 10_000);
  // Shares of the amount in percent, from USD (priced) or token units (unpriced).
  const pricedAmount = amountUsd !== null && amountUsd > 0n ? amountUsd : null;
  const usdPercent = (value: bigint | null): number | null => (value === null || pricedAmount === null ? null : Number((value * WAD) / pricedAmount / 10n ** 10n) / 1e6);
  const tipPercent = usdPercent(tipUsd);
  const autoTipPercent = auto.feeUsd === null || costUsd === null ? null : usdPercent(auto.feeUsd > costUsd ? auto.feeUsd - costUsd : 0n);
  const costPercent = usdPercent(costUsd);
  // Moving the tip leaves the automatic fee: the share signed is the tip plus the cost at the gas level (priced), or the
  // whole fee's share (unpriced).
  const setTip = (value: number, withCost: boolean): void => {
    const tipWad = shareWadOfPercentText(value.toFixed(4)) ?? 0n;
    const signed = withCost && costUsd !== null ? signedShareFor(tipWad, costUsd) : null;
    write({ ...form, tip: { ...form.tip, mode: "percentage", percentText: percentTextOfWad(signed ?? tipWad) } });
  };
  const COST_TWICE = 2n;
  const backToAutomatic = (): void => {
    const { percentText: _percent, mode: _mode, ...rest } = form.tip ?? {};
    write({ ...form, tip: rest });
  };
  const tipStatus: FeeSlider["status"] = automatic
    ? { text: auto.binding === "cap" ? "Automatic · held at your cap" : "Automatic · follows the amount and the gas level" }
    : { text: options.mode === "percentage" ? "Set by you · the automatic fee is off" : options.mode === "fixed" ? "A fixed fee you set" : options.mode === "gas-multiplier" ? "A gas-based fee you set" : "No tip" };
  const tokenUnit: ReactNode = token === null ? null : (
    <>
      {tokenIcon(token, null, 16)}
      {token.symbol}
    </>
  );
  // Token units for a USD value at the token's price, rounded down; null without a price.
  const unitsOfUsd = (value: bigint | null): bigint | null => (value === null || tokenQuote === null || token === null || tokenQuote.usdE18 === 0n ? null : (value * 10n ** BigInt(token.decimals)) / tokenQuote.usdE18);
  const tokenNumber = (units: bigint): number => (token === null ? 0 : Number(formatUnits(units, token.decimals)));
  const writeTip = (next: TipQuery): void => write({ ...form, tip: { ...form.tip, ...next } });

  // The fee's span over the next 15 minutes (owner, quote 92: "present their caps as ranges"): a point for a fee fixed at
  // signing, the cost's range for a gas-based fee (up to the signed limit). As shares of the amount, in percent.
  const gasSpan = (() => {
    const input = costInputAt(gasLevel);
    return input === null ? null : gasRange(input);
  })();
  const spanPercent: { readonly low: number; readonly high: number } | null = (() => {
    if (feeUsd !== null && pricedAmount !== null) {
      const span = feeSpanUsd({ feeUsd, gasBased, range: gasSpan, worstFeeUsd: gasBased && delivery !== null ? valueOf(delivery.maximumTip) : null });
      const low = usdPercent(span.lowUsd);
      const high = usdPercent(span.highUsd);
      return low === null || high === null ? null : { low, high };
    }
    const now = share(tipUnits);
    if (now === null) return null;
    return { low: now, high: gasBased && delivery !== null ? (share(delivery.maximumTip) ?? now) : now };
  })();
  const spanBand = spanPercent === null ? undefined : { from: spanPercent.low, to: spanPercent.high, label: spanPercent.low === spanPercent.high ? `The fee: ${plain(spanPercent.low, 3)}% of the amount` : `Where the fee could land over 15 min: ${plain(spanPercent.low, 3)}% to ${plain(spanPercent.high, 3)}% of the amount` };
  const spanNote = spanPercent === null ? undefined : spanPercent.low === spanPercent.high ? `The fee is ${plain(spanPercent.low, 3)}% of the amount, fixed when you sign.` : `The fee could land between ${plain(spanPercent.low, 3)}% and ${plain(spanPercent.high, 3)}% over 15 min.`;

  // The tip control of the mode in force (owner, quotes 89–90): one value, shared by the drawer and the delivery menu.
  const tipControl: FeeSlider | null = (() => {
    if (options.mode === "none") return null;
    if (options.mode === "fixed") {
      if (token === null) return null;
      const decimals = token.decimals;
      const recommendedUnits = amount === null ? null : (amount * auto.shareWad) / WAD;
      const recommendedText = recommendedUnits === null ? null : formatUnits(recommendedUnits, decimals);
      const fixedText = form.tip?.fixedText;
      const nowUnits = fixedText === undefined ? tipUnits : safeParse(fixedText, decimals);
      const value = nowUnits === null ? 0 : tokenNumber(nowUnits);
      const twiceCost = costUsd === null ? null : unitsOfUsd(COST_TWICE * costUsd);
      const max = Math.max(value * 1.5, recommendedUnits === null ? 0 : tokenNumber(recommendedUnits) * 3, twiceCost === null ? 0 : tokenNumber(twiceCost) * 2, 10 ** -Math.min(6, decimals));
      return {
        label: "Fixed fee",
        help: `The fee in ${token.symbol}, the same whatever gas costs: it pays the deliverer's gas, the proof and their tip. Under twice the cost, bots may skip it.`,
        value,
        min: 0,
        max: Number(max.toPrecision(3)),
        step: Number((max / 1000).toPrecision(2)),
        valueText: usd(nowUnits),
        ticks: twiceCost === null ? [] : [{ at: tokenNumber(twiceCost), label: "2× cost" }],
        onChange: (next) => writeTip({ mode: "fixed", fixedText: plain(next, Math.min(decimals, 8)) }),
        input: {
          text: fixedText ?? (nowUnits === null ? "" : formatUnits(nowUnits, decimals)),
          unit: tokenUnit,
          check: (text) => {
            const units = safeParse(text, decimals);
            if (units === null || !/^\d*\.?\d*$/.test(text.trim())) return `Enter an amount of ${token.symbol} with at most ${decimals} decimals.`;
            return amount !== null && units > amount ? "The fee can't be more than the amount." : null;
          },
          onText: (text) => writeTip({ mode: "fixed", fixedText: text }),
        },
        ...(recommendedText === null || recommendedUnits === null ? {} : { recommended: { at: tokenNumber(recommendedUnits), differs: nowUnits !== recommendedUnits, onReset: () => writeTip({ mode: "fixed", fixedText: recommendedText }) } }),
        status: tipStatus,
      };
    }
    if (options.mode === "gas-multiplier") {
      const text = form.tip?.gasMultiplierText ?? DEFAULT_GAS_MARGIN_TEXT;
      const value = Number(text) || 0;
      const atDefault = costInputAt(DEFAULT_GAS_LEVEL);
      const gasNow = atDefault === null ? null : deliveryGasUsd(atDefault);
      // Recommended: the factor whose fee meets the automatic fee at today's gas; 2 (twice the cost) without prices.
      const recommended = auto.feeUsd !== null && gasNow !== null && gasNow > 0n ? Number((auto.feeUsd * 100n) / gasNow) / 100 : 2;
      const max = Math.max(5, recommended * 2, value * 1.5);
      return {
        label: "Fee on gas",
        help: "A gas-based fee is paid at delivery from the gas actually spent: this many times the gas cost, so it follows gas up and down, never past the limit you sign.",
        value,
        min: 0,
        max: Number(max.toPrecision(3)),
        step: 0.05,
        valueText: usd(tipUnits),
        ticks: [{ at: 2, label: "2× cost" }],
        onChange: (next) => writeTip({ mode: "gas-multiplier", gasMultiplierText: plain(next, 2) }),
        input: {
          text,
          unit: "× gas cost",
          check: (typed) => {
            const number = Number(typed);
            if (typed.trim() === "" || !Number.isFinite(number)) return "Enter a number, such as 2.";
            return number <= 0 || number > 1000 ? "Use a number above 0 and at most 1000." : null;
          },
          onText: (typed) => writeTip({ mode: "gas-multiplier", gasMultiplierText: typed }),
        },
        recommended: { at: recommended, differs: Math.abs(value - recommended) >= 0.005, onReset: () => writeTip({ mode: "gas-multiplier", gasMultiplierText: String(recommended) }) },
        ...(spanNote === undefined ? {} : { note: spanNote }),
        status: tipStatus,
      };
    }
    if (tipPercent !== null && costPercent !== null) {
      const max = Math.min(100, Math.max(1, costPercent * 1.5, linePercent * 1.5, (autoTipPercent ?? 0) * 1.5, tipPercent * 1.25));
      return {
        label: "Tip",
        help: "What the deliverer keeps once the delivery gas and the proof are paid, as a share of the amount. Your fee is the cost at your gas level plus this tip. Left of the 2× cost tick bots may skip it; right of the high cap tick it reads as a High cap %.",
        value: tipPercent,
        min: 0,
        max: Number(max.toFixed(2)),
        step: 0.01,
        valueText: dollarsText(tipUsd),
        ticks: [
          { at: costPercent, label: "2× cost" },
          { at: linePercent, label: "high cap" },
        ],
        onChange: (value) => setTip(value, true),
        input: { text: plain(tipPercent), unit: "%", check: percentProblem, onText: (text) => setTip(Number(text.replace(/%$/, "")), true) },
        ...(autoTipPercent === null ? {} : { recommended: { at: autoTipPercent, differs: !automatic, onReset: backToAutomatic } }),
        status: tipStatus,
      };
    }
    const breakEvenPercent = share(breakEven);
    const typicalPercent = share(typical);
    const autoPercent = Number(formatUnits(auto.shareWad, 16));
    return {
      label: "Fee",
      help: "The share of the amount that pays whoever delivers your transfer, their gas and the proof included. Without a price the tip can't be told apart from the cost. Left of the break-even tick a delivery bot loses money at today's gas price.",
      value: percent,
      min: 0,
      max: Number(Math.max(1, (typicalPercent ?? 0.1) * 3, percent * 1.5).toFixed(2)),
      step: 0.01,
      ticks: [
        ...(breakEvenPercent === null ? [] : [{ at: breakEvenPercent, label: "break-even" }]),
        ...(typicalPercent === null ? [] : [{ at: typicalPercent, label: "typical" }]),
      ],
      onChange: (value) => setTip(value, false),
      input: { text: plain(percent), unit: "%", check: percentProblem, onText: (text) => setTip(Number(text.replace(/%$/, "")), false) },
      recommended: { at: autoPercent, differs: !automatic, onReset: backToAutomatic },
      status: tipStatus,
    };
  })();

  // The gas level as an anchor (owner, quote 91): the ceiling the deliverer may pay, with today's gas marked and the
  // range the price could land in over 15 minutes shaded; never explained as a multiplier.
  const gasControl: FeeSlider | null = (() => {
    if (levelBaseWei === null) return null;
    const gwei = (wei: bigint): number => Number(formatUnits(wei, 9));
    const ceilingWei = ceilingWeiText ?? ceilingWeiOf(levelBaseWei, DEFAULT_GAS_LEVEL);
    const max = gwei((ceilingWeiOf(levelBaseWei, 3) * 6n) / 5n);
    // The range in dollars (the whole cost, the proof included) and in the destination's coin (the delivery gas alone).
    const gasUsed = probe.delivery?.suggestions.dataSource.gas ?? null;
    const priority = probe.delivery?.priorityFeeWei ?? 0n;
    const coin = (wei: bigint): string => (gasUsed === null ? "" : amountText(gasUsed * (wei + priority), 18));
    const coinRange = gasSpan === null || gasUsed === null ? "" : ` (gas ${coin(gasSpan.lowWei)}–${coin(gasSpan.highWei)} ${destination.nativeSymbol})`;
    const words = gasSpan === null ? null : `Anchored at today's gas · could land ${dollarsSpanWords(gasSpan.lowUsd, gasSpan.highUsd)} over 15 min${coinRange}`;
    return {
      label: "Gas level",
      help: "Today's gas is the anchor. Over the next 15 minutes the real price could land lower (left) or higher (right); this sets how high you let it go. The bars beside the gas can step through Low, Normal and High.",
      value: gwei(ceilingWei),
      min: 0,
      max,
      step: max / 300,
      valueText: levelName(gasLevel),
      ticks: ([1, 2, 3] as const).map((level) => ({ at: gwei(ceilingWeiOf(levelBaseWei, level)), label: levelName(level) })).filter((tick) => tick.label !== levelName(DEFAULT_GAS_LEVEL)),
      onChange: (next) => setCeiling(parseUnits(next.toFixed(9), 9)),
      input: {
        text: formatUnits(ceilingWei, 9),
        unit: "gwei",
        check: (text) => {
          const wei = safeParse(text, 9);
          return wei === null || wei <= 0n ? "Enter a gas price above 0 in gwei, at most 9 decimals." : null;
        },
        onText: (text) => setCeiling(safeParse(text, 9) ?? 0n),
      },
      recommended: { at: gwei(ceilingWeiOf(levelBaseWei, DEFAULT_GAS_LEVEL)), differs: form.tip?.ceilingGweiText !== undefined, onReset: () => setGasLevel(DEFAULT_GAS_LEVEL) },
      ...(gasSpan === null ? {} : { band: { from: gwei(gasSpan.lowWei), to: gwei(gasSpan.highWei), mark: gwei(gasSpan.anchorWei), label: words ?? "" } }),
      ...(words === null ? {} : { note: words }),
    };
  })();

  // The callback gas that the relay passes: the call gas plus the router's own work, shown read only. No call, no number.
  const callbackGas = (() => {
    const text = (form.callGas ?? "").trim();
    return form.callTarget !== undefined && /^\d+$/.test(text) && BigInt(text) > 0n && BigInt(text) <= MAX_CALL_GAS ? routerCallbackGas({ callGas: BigInt(text) }) : null;
  })();

  const autoCapRecommended = Math.min(DEFAULT_AUTO_CAP_PERCENT, hardCapPercent);
  const capControl: FeeSlider = {
    label: "Automatic fee cap",
    help: "The most the automatic fee may take, as a share of the amount. It can't be above your hard cap. Changing it here applies to this bridge; the save button makes it your default.",
    value: capPercent,
    min: 0.05,
    max: Math.max(0.05, hardCapPercent),
    step: 0.05,
    ...(auto.binding === "cap" && automatic ? { valueText: "reached" } : {}),
    ticks: [{ at: Number(linePercent.toFixed(3)), label: "high cap" }],
    onChange: setCap,
    input: { text: plain(capPercent), unit: "%", check: (text) => feeCapProblem(text) ?? (Number(text.replace(/%$/, "")) > hardCapPercent ? `At most your ${hardCapText} hard cap.` : null), onText: (text) => setCap(Number(text.replace(/%$/, ""))) },
    recommended: { at: autoCapRecommended, differs: capPercent !== autoCapRecommended, onReset: () => setCap(autoCapRecommended) },
    ...(spanBand === undefined ? {} : { band: spanBand }),
    save: capSave,
    ...(automatic ? {} : { status: { text: "Applies to the automatic fee only" } }),
  };
  const hardCapControl: FeeSlider = {
    label: "Hard fee cap",
    help: "The absolute most the fee may be, in every tip mode. A fee above it, or a gas-based fee that could rise above it, stops the Bridge button until you raise this cap.",
    value: hardCapPercent,
    min: 0.05,
    max: Number(Math.max(5, hardCapPercent * 1.5, (spanPercent?.high ?? 0) * 1.2).toFixed(2)),
    step: 0.05,
    ...(hardOver ? { valueText: "below the fee" } : {}),
    ticks: [{ at: capPercent, label: "auto cap" }],
    onChange: setHardCap,
    input: { text: plain(hardCapPercent), unit: "%", check: feeCapProblem, onText: (text) => setHardCap(Number(text.replace(/%$/, ""))) },
    recommended: { at: DEFAULT_HARD_CAP_PERCENT, differs: hardCapPercent !== DEFAULT_HARD_CAP_PERCENT, onReset: () => setHardCap(DEFAULT_HARD_CAP_PERCENT) },
    ...(spanBand === undefined ? {} : { band: spanBand }),
    ...(spanNote === undefined ? {} : { note: spanNote }),
    save: hardSave,
  };
  const nextLevel = nextGasLevel(gasLevel);
  const gasHelp = `${levelName(gasLevel)} gas: anchored at today's gas${gasSpan === null ? "" : `, the cost could land ${dollarsSpanWords(gasSpan.lowUsd, gasSpan.highUsd)} over 15 min`}. Tap for ${levelName(nextLevel)}.`;

  // The tip modes of the delivery menu. Choosing one keeps the fee where it is when it can (the share or the amount
  // in force now), so switching never jumps the numbers; Automatic hands the fee back to the rule.
  const chooseTip = (next: TipChoiceKey): void => {
    const { percentText: _percent, fixedText: _fixed, ...rest } = form.tip ?? {};
    if (next === "automatic") return write({ ...form, tip: { ...rest, mode: "percentage" } });
    if (next === "percentage") return write({ ...form, tip: { ...rest, mode: "percentage", percentText: form.tip?.percentText ?? options.percentText } });
    if (next === "fixed") return write({ ...form, tip: { ...rest, mode: "fixed", ...(tipUnits === null || token === null ? {} : { fixedText: formatUnits(tipUnits, token.decimals) }) } });
    write({ ...form, tip: { ...rest, mode: next } });
  };
  const tipChoice: TipChoiceKey = automatic ? "automatic" : options.mode;
  const summary = deliverySummary(form, {
    destination: destination.name,
    feeShareText: tipUnits === null || amount === null || amount === 0n ? null : `${Number((Number((tipUnits * 1_000_000n) / amount) / 10_000).toPrecision(2))}%`,
    worstCaseText: gasBased && delivery !== null ? (valueOf(delivery.maximumTip) === null ? `${amountText(delivery.maximumTip, token?.decimals ?? 18)} ${token?.symbol ?? ""}` : usd(delivery.maximumTip)) : null,
    fixedText: options.mode === "fixed" && tipUnits !== null && token !== null ? `${amountText(tipUnits, token.decimals)} ${token.symbol}` : null,
    feeAmountText: tipUnits === null || token === null ? null : valueOf(tipUnits) === null ? `${amountText(tipUnits, token.decimals)} ${token.symbol}` : usd(tipUnits),
    percentText: options.mode === "percentage" && Number(options.percentText) > 0 ? `${Number(Number(options.percentText).toPrecision(3))}%` : null,
    gasLevelName: levelName(gasLevel),
    worstCaseShareText: gasBased && delivery !== null && amount !== null && amount > 0n ? `${Number((Number((delivery.maximumTip * 1_000_000n) / amount) / 10_000).toPrecision(2))}%` : null,
  });

  const destinationInput = useRef<HTMLInputElement>(null);
  const [lockTip, setLockTip] = useState(false);
  const [focusDestination, setFocusDestination] = useState(false);
  useEffect(() => {
    if (!focusDestination) return;
    destinationInput.current?.focus();
    setFocusDestination(false);
  }, [focusDestination]);
  // Locking drops the typed address (the wallet takes over); unlocking opens the field in place, empty and focused.
  const toggleLock = (): void => {
    if (unlocked) {
      setUnlockedHere(false);
      const { receiver: _drop, ...rest } = form;
      write(rest);
      return;
    }
    setUnlockedHere(true);
    setFocusDestination(true);
  };

  const flip = (): void => {
    const next = token === null ? null : counterpartOf(token, tokens, pair);
    write({ ...form, token: next === null ? undefined : choiceOf(next) }, reverse(route.dir));
  };

  const pick = (picked: TokenInfo): void => {
    setMenu(null);
    if (!tokens.includes(picked)) setCustomTokens((list) => [...list, picked]);
    write({ ...form, token: choiceOf(picked) }, directionFrom(picked.side));
  };

  // The flip sits at the start of the fee pill's row, centred with it (owner: "why is the tip and the switch chain
  // direction button not on the same line?").
  const flipButton = (
    <button type="button" className="zb-flip" onClick={flip} aria-label={`Flip: send from ${destination.name} instead`}>
      <FlipIcon />
    </button>
  );

  return (
    <main className="zb-bridge">
      {fixture ? <p className="zb-col" style={{ fontSize: "var(--zb-step--1)", color: "var(--zb-muted)", margin: "0 auto 6px" }}>Sample data. Nothing here reaches a chain.</p> : null}
      <div className="zb-col zb-row-pad" style={{ position: "relative" }}>
        <div className="zb-joined">
          <button type="button" aria-haspopup="menu" aria-expanded={menu === "direction"} onClick={() => setMenu(menu === "direction" ? null : "direction")} aria-label={`From ${source.name}. Change the route`}>
            From <TokenIcon subject={{ chainId: source.chainId }} symbol={source.name} size={26} />
            <Chevron />
          </button>
          {account === null ? (
            <button type="button" onClick={() => void wallet.connect()}>
              Connect wallet
            </button>
          ) : (
            <span>
              <AddressText address={account} />
              <Identicon address={account} />
            </span>
          )}
        </div>
        {menu === "direction" ? (
          <DirectionMenu
            current={{ pairId: route.pairId, dir: route.dir }}
            onPick={(next) => {
              setMenu(null);
              const target: Route = { name: "bridge", pairId: next.pairId, dir: next.dir, ...(route.form?.amount === undefined ? {} : { form: { amount: route.form.amount } }) };
              // The services are built for one pair, so another pair is a new page load (behind the loader).
              if (next.pairId !== pair.id) {
                window.location.hash = formatRoute(target);
                window.location.reload();
              } else onRoute(target);
            }}
            onClose={() => setMenu(null)}
          />
        ) : null}
      </div>

      <section className="zb-band-from" aria-label={`You send from ${source.name}`}>
        <div className="zb-col">
          <div className="zb-amount-row">
            <input className="zb-amount" inputMode="decimal" autoComplete="off" placeholder="0" aria-label={`Amount to send from ${source.name}`} value={form.amount ?? ""} onChange={(event) => write({ ...form, amount: event.target.value })} />
            {token === null ? null : (
              <button type="button" className="zb-token" aria-haspopup="dialog" onClick={() => setMenu("token")} aria-label={`Token: ${token.symbol}. Choose another`}>
                {tokenIcon(token, null, 28, "accent")}
                {token.symbol}
                <Chevron />
              </button>
            )}
          </div>
          <div className="zb-balance">
            <span title={PRICE_NOTE}>{usd(amount)}</span>
            <span className="zb-right">
              {balance === null || token === null ? null : (
                <>
                  <span>
                    Balance <Num text={amountText(balance, token.decimals)} />
                  </span>
                  <button type="button" className="zb-max" disabled={max === null} title={isNativeToken(token) ? "Leaves enough for the gas of sending it" : undefined} onClick={() => max !== null && write({ ...form, amount: amountText(max, token.decimals) })}>
                    MAX
                  </button>
                </>
              )}
            </span>
          </div>
        </div>
      </section>

      <section className="zb-band-to" aria-label={`You receive on ${destination.name}`}>
        <div className="zb-col">
          {token === null ? (
            <div className="zb-fee-row">{flipButton}</div>
          ) : (
            <FeeLine
              lead={flipButton}
              summary={summary.short}
              summaryFull={`${summary.full}${tipUnits === null ? "" : `. Fee ${amountText(tipUnits, token.decimals)} ${token.symbol}${usd(tipUnits) === "—" ? "" : ` (about ${usd(tipUnits)})`}: the delivery gas at your gas level, the proof and a tip, ${automatic ? "set automatically" : "set by you"}`}`}
              gasHelp={gasHelp}
              gasLevel={gasLevel}
              onGasLevel={setGasLevel}
              // Owner: "just tell the user what is happening ... give them hard numbers. clicking in helps them figure out why":
              // the time is the number alone; the light client's age is a row in the steps.
              time={`~${durationText(timeline.total.typical)}`}
              steps={withLightClientStep(transferSteps(source, destination), lightClientDelay(heads ?? [], side))}
              timeline={<WaitTimeline timeline={timeline} sourceName={source.name} />}
              menu={
                <DeliveryMenu
                  form={form}
                  defaultRouter={destination.contracts.deliveryRouter}
                  onChange={(next) => write(next)}
                  tipChoice={tipChoice}
                  onTipChoice={chooseTip}
                  value={tipControl}
                  gas={gasControl}
                  caps={[capControl, hardCapControl]}
                  breakdown={breakdown}
                  note={tipControl?.label !== "Fee" ? null : share(breakEven) === null ? null : "Left of break-even a delivery bot loses money at today's gas price, so expect to deliver it yourself."}
                  callbackGas={callbackGas}
                />
              }
            />
          )}
          <div className="zb-amount-row" style={{ marginTop: 6 }}>
            <span className="zb-amount-out" aria-label={`You receive on ${destination.name}`}>
              {received === null || token === null ? "0" : <Num text={amountText(received > 0n ? received : 0n, token.decimals)} />}
            </span>
            {feeState === "estimating" ? <span className="zb-fee-state" aria-live="polite">estimating</span> : feeState === "unknown" ? <span className="zb-fee-state">fee unknown</span> : null}
            {token === null ? null : (
              <span className="zb-token">
                {tokenIcon(token, destination.chainId)}
                {nativeSymbolOf(token)}
              </span>
            )}
          </div>
          <div className="zb-balance">
            <span title={PRICE_NOTE}>{usd(received)}</span>
            {token === null ? null : <span className="zb-right">arrives as {arrivesAsSymbol(token)} on {destination.name}</span>}
          </div>
          {pricesNote === null ? null : <p className="zb-price-note" role="status">{pricesNote}</p>}
        </div>
      </section>

      <section className="zb-actions">
        <div className="zb-col">
          <div className="zb-joined zb-dest" data-locked={unlocked ? undefined : "true"}>
            <span>
              To <TokenIcon subject={{ chainId: destination.chainId }} symbol={destination.name} size={26} />
            </span>
            {unlocked ? (
              <div className="zb-dest-field">
                <input
                  ref={destinationInput}
                  className="zb-dest-input zb-mono"
                  aria-label={`Destination address on ${destination.name}`}
                  aria-invalid={receiverProblem !== null && typedReceiver !== "" ? true : undefined}
                  data-filled={typedReceiver.trim() === "" ? undefined : "true"}
                  title={typedReceiver.trim() === "" ? undefined : typedReceiver.trim()}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="0x… destination address"
                  value={typedReceiver}
                  onChange={(event) => write({ ...form, receiver: event.target.value })}
                />
                {typedReceiver.trim() === "" ? null : (
                  <span className="zb-dest-shown" aria-hidden="true">
                    <AddressText address={typedReceiver.trim()} />
                  </span>
                )}
              </div>
            ) : (
              <span className="zb-dest-wallet">
                {account === null ? <span className="zb-mono">destination wallet</span> : <AddressText address={account} />}
                {account === null ? null : <Identicon address={account} />}
              </span>
            )}
            <span className="zb-dest-lock-wrap" onMouseEnter={() => setLockTip(true)} onMouseLeave={() => setLockTip(false)}>
              <button type="button" className="zb-dest-lock" aria-pressed={!unlocked} aria-label={unlocked ? `Destination unlocked: ${LOCK_TIPS.unlocked}. Lock it to your wallet` : `Destination locked: ${LOCK_TIPS.locked}. Unlock to type another address`} onClick={toggleLock} onFocus={() => setLockTip(true)} onBlur={() => setLockTip(false)}>
                {unlocked ? <UnlockIcon /> : <LockIcon />}
              </button>
              {lockTip ? (
                <span role="tooltip" className="zb-tooltip zb-dest-tip">
                  {unlocked ? LOCK_TIPS.unlocked : LOCK_TIPS.locked}
                </span>
              ) : null}
            </span>
          </div>
          {receiverProblem === null || typedReceiver === "" ? null : (
            <p className="zb-fld-err zb-dest-err" role="alert">
              {receiverProblem}
            </p>
          )}
          {receiver !== "" && receiverProblem === null && account !== null && receiver.toLowerCase() !== account.toLowerCase() ? <p className="zb-verdict" style={{ textAlign: "left" }}>Not your wallet. Check the address.</p> : null}
          {linked.length === 0 ? null : <LinkedWarning fields={linked} />}
          <button
            type="button"
            className="zb-go"
            data-kind={verdict.kind}
            disabled={!canPress}
            onClick={() => (verdict.kind === "connect" ? void wallet.connect() : setReview(true))}
          >
            {verdict.label}
          </button>
          {verdict.detail === null ? null : <p className="zb-verdict">{verdict.detail}</p>}
          {hardOver && raisePercent !== null ? (
            <button type="button" className="zb-pill zb-pill-outline zb-raise" onClick={raiseHardCap}>
              Raise cap to {raisePercent}%
            </button>
          ) : null}
        </div>
      </section>

      {menu === "token" && token !== null ? <TokenPicker tokens={tokens} selected={token} snapshots={snapshots ?? []} {...(used === undefined ? {} : { used })} resolveCustom={resolveCustom} priceOf={(subject) => { const price = priceOf(subject); return price === null ? null : usdText(priceNumber(price)); }} onPick={pick} onClose={() => setMenu(null)} /> : null}
      {review && token !== null && amount !== null ? (
        <ReviewSheet onClose={() => setReview(false)}>
            <ReviewRow label="You send"><b>{inline(tokenIcon(token, null, 16), amountText(amount, token.decimals), token.symbol)} on {source.name}</b></ReviewRow>
            <ReviewRow label="Arrives"><b>{received === null ? "—" : inline(tokenIcon(token, destination.chainId, 16), amountText(received > 0n ? received : 0n, token.decimals), token.symbol)} on {destination.name}</b></ReviewRow>
            <ReviewRow label="Fee"><span>{tipUnits === null ? "none" : inline(tokenIcon(token, null, 18), amountText(tipUnits, token.decimals), token.symbol)}{feeUsd === null ? null : <span title={PRICE_NOTE}> (about {usd(tipUnits)})</span>}</span></ReviewRow>
            {drift === null ? null : (
              <ReviewRow label="Can drift" sub><span title={PRICE_NOTE}>{drift.now} now, up to {drift.most} if gas rises to the {drift.level} ceiling</span></ReviewRow>
            )}
            {breakdown.map((line) => (
              <ReviewRow key={line.label} label={line.label} sub><span title={PRICE_NOTE}>{line.value}</span></ReviewRow>
            ))}
            <ReviewRow label="Time"><span>{`~${durationText(timeline.total.typical)}`}</span></ReviewRow>
            <ReviewRow label="To"><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{receiver}{account !== null && receiver.toLowerCase() !== account.toLowerCase() ? " (not your wallet)" : ""}</span></ReviewRow>
            {delivery === null ? null : (
              <ReviewRow label="Relay router"><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{delivery.router}</span></ReviewRow>
            )}
            {delivery === null || routerWarningOf(delivery) === null ? null : <ReviewNotice role="alert">{routerWarningOf(delivery)}</ReviewNotice>}
            {linked.length === 0 ? null : <LinkedWarning fields={linked} />}
            {verdict.kind === "warn" ? <ReviewNotice>{verdict.detail}</ReviewNotice> : null}
            {hardOver && raisePercent !== null ? (
              <ReviewNotice role="group" groupLabel="Hard fee cap">
                <p style={{ margin: "0 0 8px" }}>
                  <b>{verdict.label}</b> · {verdict.detail}
                </p>
                <button type="button" className="zb-pill zb-pill-outline" onClick={raiseHardCap}>
                  Raise cap to {raisePercent}%
                </button>
              </ReviewNotice>
            ) : null}
            {warnings.capWarning ? (
              <ReviewNotice role="group" groupLabel="Fee cap">
                <p style={{ margin: "0 0 8px" }}>
                  <b>High cap %</b> · If gas rises to the {levelName(gasLevel)} ceiling, your {capText} cap lets the fee leave the deliverer more than {thresholdText} of the amount on top of the cost. Lower the cap here; the fee updates.
                </p>
                <span className="zb-seg" role="radiogroup" aria-label="Automatic fee cap">
                  {[0.1, 0.25, 0.5, 1].map((value) => (
                    <button key={value} type="button" role="radio" aria-checked={capPercent === value} onClick={() => setCap(value)}>
                      {value}%
                    </button>
                  ))}
                </span>
                <button type="button" className="zb-save" style={{ marginLeft: 8, verticalAlign: "middle" }} aria-label={capSave.label} title={capSave.label} disabled={capSave.saved} onClick={capSave.onSave}>
                  <FloppyIcon />
                </button>
              </ReviewNotice>
            ) : null}
            <button type="button" className="zb-go" data-kind="go" disabled={draft.status !== "ready" || hardOver || receiverProblem !== null} onClick={() => { setReview(false); setSigning(draft.steps); }}>
              Confirm in wallet
            </button>
            {draft.status === "ready" ? null : <p className="zb-verdict">{draft.reason}</p>}
        </ReviewSheet>
      ) : null}
      {signing === null ? null : <TransactionDialog
          steps={signing}
          variant="sheet"
          onClose={() => setSigning(null)}
          onFinished={(hash) => {
            if (token !== null && amount !== null) addPending({ sourceTransactionHash: hash as `0x${string}`, direction: route.dir, token, amount, sentAt: Math.floor(Date.now() / 1000) });
          }}
        />}
    </main>
  );
};
