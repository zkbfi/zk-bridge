import { useCallback, useMemo, useState, type ReactNode } from "react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { erc20ReaderFor, isFirstBridge, resolveCustomToken } from "./custom-token";
import { addPending } from "./pending";
import { priceNumber, usdText, type PriceQuote } from "./price-oracle";
import { PRICE_NOTE, usePrices } from "./use-prices";
import type { Address } from "viem";
import type { TokenInfo } from "@terminal/model/types";
import { useDeliveryCost, useHeads, useMaxFee, usePairHealth, usePriorityFee, useSnapshots, useTokens, useUsedTokens } from "../app/queries";
import { formatRoute, type BridgeQuery, type Route, type TipQuery } from "../app/route";
import { useServices } from "../app/services";
import { TransactionDialog } from "../actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../tx/bridge-draft";
import type { WebStep } from "../tx/bridge-steps";
import { parseUnits } from "../ui/format";
import { useWallet } from "../wallet/wallet-port";
import { isNativeToken, lightClientDelay, maxSendable, nativeTokensOf, tokenBalance } from "./bridge-model";
import { amountText, chainsFor, choiceOf, counterpartOf, directionFrom, reverse, sourceSide, tokenFor, transferEstimate, transferSteps } from "./bridge-model";
import { DeliveryMenu, deliverySummary } from "./DeliveryMenu";
import { ceilingCostUsd, ceilingWeiOf, DEFAULT_CAP_WAD, defaultFee, feeWarnings, GAS_LEVELS, gasLevelOfCeiling, highCapLine, PROOF_COST_USD, shareWadOfPercentText, totalCostUsd, usdOf, WAD, type CostInput, type GasLevel } from "@zk-bridge/shared";
import { formatUnits } from "viem";
import { loadFeeCap, saveFeeCap } from "./fee-cap";
import { DirectionMenu } from "./DirectionMenu";
import { FeeLine, GAS_LEVEL_NAMES, nextGasLevel, type FeeSlider } from "./FeeLine";
import { Chevron, FlipIcon, FloppyIcon, Identicon, SlidersIcon } from "./icons";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
import { dollarsText as dollarsOf } from "./number";
import { Sheet } from "./Sheet";
import { TokenIcon } from "./TokenIcon";
import { TokenPicker } from "./TokenPicker";
import { pressable, verdictOf } from "./verdict";
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

const short = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`;

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
  // The native coins come last: the default is the first bridged token, else the native coin (wrap route).
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
  const [storedCap, setStoredCap] = useState(() => loadFeeCap());
  const capPercent = form.tip?.capPercentText === undefined ? storedCap : Number(form.tip.capPercentText) || storedCap;
  // The fee is automatic until the user picks a share: the larger of the default curve and twice the cost, capped.
  const automatic = baseOptions.mode === "percentage" && form.tip?.percentText === undefined;
  const report = useDeliveryCost(destination.chainId, { enabled: token !== null });
  const priority = usePriorityFee(destination.chainId, { enabled: token !== null });
  const [menu, setMenu] = useState<"direction" | "token" | "receiver" | "delivery" | null>(null);
  const [review, setReview] = useState(false);
  const [signing, setSigning] = useState<readonly WebStep[] | null>(null);

  const write = (next: BridgeQuery, dir = route.dir): void => {
    const cleaned = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined && value !== "")) as BridgeQuery;
    onRoute({ name: "bridge", pairId: route.pairId, dir, ...(Object.keys(cleaned).length === 0 ? {} : { form: cleaned }) });
  };

  const receiver = form.receiver ?? account ?? "";
  // Without a wallet the fee is still estimated: the draft reads an empty account on the source chain and a stand-in
  // receiver. Nothing can be sent that way; the pill asks for a wallet first.
  const values = { token: token === null ? "" : choiceOf(token), amount: form.amount ?? "", receiver: receiver === "" && account === null ? ESTIMATE_RECEIVER : receiver, mode: "plain" as const, data: "", gasLimit: form.gasLimit ?? "", callTarget: "", callData: "" };
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
  const prices = usePrices(tokens).data;
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
  const costNormalUsd = costAt(1);
  const amountUsd = valueOf(amount);
  const capWad = shareWadOfPercentText(String(capPercent)) ?? DEFAULT_CAP_WAD;
  // A higher gas level adds its extra expected cost on top of the curve, so the automatic fee rises with the bars too.
  const auto = defaultFee({ amountUsd: amountUsd, costUsd: costUsd, capWad, ...(costUsd === null || costNormalUsd === null ? {} : { levelExtraUsd: costUsd - costNormalUsd }) });
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
  // What the output can say about the fee: none to take (the wrap route, no tip), known, being estimated, or unknown.
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
  const gasBased = options.mode === "gas-multiplier";
  const expandedUsd = (() => {
    const input = costInputAt(gasLevel);
    return input === null ? null : ceilingCostUsd(input);
  })();
  const shareWithoutPriceWad = options.mode === "percentage" ? shareWadOfPercentText(options.percentText) : amount === null || amount === 0n || tipUnits === null ? null : (tipUnits * WAD) / amount;
  const warnings = feeWarnings({
    amountUsd: amountUsd,
    capWad,
    feeUsd: feeUsd,
    costUsd: costUsd,
    costNormalUsd: costNormalUsd,
    shareWithoutPriceWad,
    belowBreakEven: tipUnits !== null && breakEven !== null && tipUnits < breakEven,
    gasBased,
    expandedCostUsd: expandedUsd,
  });
  const line = highCapLine(amountUsd);
  const linePercent = Number((line.numerator * 10n ** 8n) / line.denominator) / 10 ** 6;
  const thresholdText = `${Number(linePercent.toPrecision(2))}%`;
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
  // The bars beside the gas can (owner, quote 81): a new level writes its ceiling (none at Normal) and, for a share the
  // user set, adds the level's extra expected cost to it. The automatic fee follows by itself (its floor is twice the
  // cost at the level). Either way every number moves: "a new level of fee spend has been consented to".
  const setGasLevel = (level: GasLevel): void => {
    const { ceilingGweiText: _drop, ...rest } = form.tip ?? {};
    const ceiling = levelBaseWei === null || level === 1 ? undefined : formatUnits(ceilingWeiOf(levelBaseWei, level), 9);
    const percentText = rebasedPercentText(costAt(gasLevel), costAt(level));
    write({ ...form, tip: { ...rest, ...(percentText === undefined ? {} : { percentText }), ...(ceiling === undefined ? {} : { ceilingGweiText: ceiling }) } });
  };
  const capText = `${Number(capPercent.toPrecision(3))}%`;
  const setCap = (value: number): void => {
    const { capPercentText: _drop, ...rest } = form.tip ?? {};
    write({ ...form, tip: { ...rest, ...(value === storedCap ? {} : { capPercentText: String(value) }) } });
  };
  // The save button makes this bridge's cap the default (owner: "a little save button (floppy icon) next to the slider").
  const saveCap = (): void => {
    if (saveFeeCap(String(capPercent)) !== null) return;
    setStoredCap(loadFeeCap());
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
    feeUsd === null || costUsd === null || costNormalUsd === null || tipUsd === null
      ? []
      : [
          { label: "Delivery gas", value: dollarsText(costNormalUsd - PROOF_COST_USD) },
          { label: "Proof", value: dollarsText(PROOF_COST_USD) },
          ...(gasLevel === 1 ? [] : [{ label: `${levelName(gasLevel)} gas level, ${expectedText(gasLevel)} the cost`, value: `+${dollarsText(costUsd - costNormalUsd)}` }]),
          { label: "Tip", value: dollarsText(tipUsd) },
          { label: "Fee", value: dollarsText(feeUsd), total: true },
        ];
  // In gas-based mode the fee can drift after signing, up to the signed limit (the tip at the ceiling).
  const drift = gasBased && delivery !== null && tipUnits !== null ? { now: usd(tipUnits), most: usd(delivery.maximumTip), level: levelName(gasLevel) } : null;

  const verdict = verdictOf({
    connected: account !== null,
    draft,
    amountEntered: amount !== null && amount > 0n,
    overBalance: amount !== null && balance !== null && amount > balance,
    symbol: token?.symbol ?? "",
    paused: gate === "stop" || gate === "sealed" ? { route: `${source.name} → ${destination.name}` } : null,
    tipBelowBreakEven: warnings.lowFee,
    lowFee: feeUsd === null || costUsd === null ? null : { feeText: dollarsText(feeUsd), costText: dollarsText(costUsd) },
    highTip: warnings.highCap ? { thresholdText, tipText: dollarsText(tipUsd) } : null,
    smallTransfer: warnings.smallTransfer && amountUsd !== null ? { costText: dollarsText(costUsd), capText, capAmountText: dollarsText((amountUsd * capWad) / WAD) } : null,
    firstBridge: token !== null && !isNativeToken(token) && isFirstBridge(token, known, false),
  });

  const tokenIcon = (subjectToken: TokenInfo, badge: number | null, size = 32, surface: "accent" | "plain" = "plain"): ReactNode => <TokenIcon subject={iconSubjectOf(subjectToken, pair)} badgeChainId={badge} symbol={subjectToken.symbol} size={size} surface={surface} />;
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
  const backToAutomatic = (): void => {
    const { percentText: _percent, mode: _mode, ...rest } = form.tip ?? {};
    write({ ...form, tip: rest });
  };
  const tipStatus: FeeSlider["status"] = automatic
    ? { text: auto.binding === "cap" ? "Automatic · held at your cap" : "Automatic · follows the amount and the gas level" }
    : {
        text: options.mode === "percentage" ? "Set by you · the automatic fee is off" : options.mode === "fixed" ? "A fixed tip from the delivery settings" : options.mode === "gas-multiplier" ? "A gas-based tip from the delivery settings" : "No tip",
        action: { label: "Back to automatic", onClick: backToAutomatic },
      };
  const tipSlider: FeeSlider =
    tipPercent !== null && costPercent !== null
      ? (() => {
          const max = Math.min(100, Math.max(1, costPercent * 1.5, linePercent * 1.5, (autoTipPercent ?? 0) * 1.5, tipPercent * 1.25));
          return {
            label: "Tip",
            help: "What the deliverer keeps once the delivery gas and the proof are paid, as a share of the amount. Your fee is the cost at your gas level plus this tip. Left of the 2× cost tick bots may skip it; right of the high cap line it reads as a High cap %.",
            value: tipPercent,
            min: 0,
            max: Number(max.toFixed(2)),
            step: 0.01,
            valueText: `${percentText(tipPercent)} · ${dollarsText(tipUsd)}`,
            ticks: [
              { at: costPercent, label: "2× cost" },
              { at: linePercent, label: "high cap line" },
              ...(automatic || autoTipPercent === null ? [] : [{ at: autoTipPercent, label: "automatic" }]),
            ],
            onChange: (value) => setTip(value, true),
            status: tipStatus,
          };
        })()
      : (() => {
          const breakEvenPercent = share(breakEven);
          const typicalPercent = share(typical);
          return {
            label: "Fee",
            help: "The share of the amount that pays whoever delivers your transfer, their gas and the proof included. Without a price the tip can't be told apart from the cost. Left of the break-even tick a delivery bot loses money at today's gas price.",
            value: percent,
            min: 0,
            max: Number(Math.max(1, (typicalPercent ?? 0.1) * 3, percent * 1.5).toFixed(2)),
            step: 0.01,
            valueText: percentText(percent),
            ticks: [
              ...(breakEvenPercent === null ? [] : [{ at: breakEvenPercent, label: "break-even for bots" }]),
              ...(typicalPercent === null ? [] : [{ at: typicalPercent, label: "typical" }]),
            ],
            onChange: (value) => setTip(value, false),
            status: tipStatus,
          };
        })();
  const sliders: FeeSlider[] = [
    tipSlider,
    {
      label: "Automatic fee cap",
      help: "The most the automatic fee may take, as a share of the amount. Changing it here applies to this bridge; the save button makes it your default.",
      value: capPercent,
      min: 0.05,
      max: Math.max(2, capPercent),
      step: 0.05,
      valueText: `${capText}${auto.binding === "cap" && automatic ? " · reached" : ""}`,
      ticks: [{ at: Number(linePercent.toFixed(3)), label: "high cap line" }],
      onChange: setCap,
      save: capSave,
      ...(automatic ? {} : { status: { text: "Applies to the automatic fee only" } }),
    },
  ];
  const nextLevel = nextGasLevel(gasLevel);
  const gasHelp = `${levelName(gasLevel)} gas: up to ${GAS_LEVELS[gasLevel].ceilingFactor}× today's base fee, cost ${expectedText(gasLevel)}${costUsd === null ? "" : ` (${dollarsText(costUsd)})`}. Tap for ${levelName(nextLevel)}.`;

  const flip = (): void => {
    const next = token === null ? null : counterpartOf(token, tokens);
    write({ ...form, token: next === null ? undefined : choiceOf(next) }, reverse(route.dir));
  };

  const pick = (picked: TokenInfo): void => {
    setMenu(null);
    if (!tokens.includes(picked)) setCustomTokens((list) => [...list, picked]);
    write({ ...form, token: choiceOf(picked) }, directionFrom(picked.side));
  };

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
              <span className="zb-mono">{short(account)}</span>
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

      <div className="zb-seam">
        <div className="zb-col">
          <button type="button" className="zb-flip" onClick={flip} aria-label={`Flip: send from ${destination.name} instead`}>
            <FlipIcon />
          </button>
          <button type="button" className="zb-pill zb-settings-pill" aria-haspopup="true" aria-expanded={menu === "delivery"} onClick={() => setMenu(menu === "delivery" ? null : "delivery")} aria-label={`Delivery settings: ${deliverySummary(form)}`}>
            <SlidersIcon />
            <span>{deliverySummary(form)}</span>
            <Chevron dir={menu === "delivery" ? "up" : "down"} />
          </button>
        </div>
      </div>

      {menu === "delivery" ? (
        <div className="zb-col" style={{ position: "relative", zIndex: 5 }}>
          <DeliveryMenu form={form} defaultRouter={destination.contracts.deliveryRouter} onChange={(next) => write(next)} onReceiver={() => setMenu("receiver")} />
        </div>
      ) : null}
      <section className="zb-band-to" aria-label={`You receive on ${destination.name}`}>
        <div className="zb-col">
          {token === null ? null : (
            <FeeLine
              tip={tipUnits === null ? (feeState === "none" && amount !== null ? "none" : "—") : inline(tokenIcon(token, null, 18), amountText(tipUnits, token.decimals), token.symbol)}
              tipHelp={`One fee pays whoever delivers your transfer on ${destination.name}: their gas at your gas level, the proof, and a tip on top. It is ${Number(Number(options.percentText).toPrecision(3))}% of the amount${usd(tipUnits) === "—" ? "" : ` (about ${usd(tipUnits)})`}, ${automatic ? "set automatically" : "with the tip set by you"}. Tap for the breakdown.`}
              breakdown={breakdown}
              gasHelp={gasHelp}
              gasLevel={gasLevel}
              onGasLevel={setGasLevel}
              time={(() => {
                const delay = lightClientDelay(heads ?? [], side);
                return delay === null ? transferEstimate(source, destination) : `${transferEstimate(source, destination)} + ${delay.text}`;
              })()}
              steps={transferSteps(source, destination)}
              sliders={sliders}
              sliderNote={tipSlider.label === "Tip" ? null : share(breakEven) === null ? null : "Left of break-even a delivery bot loses money at today's gas price, so expect to deliver it yourself."}
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
                {token.symbol.replace(/^zkb/i, "")}
              </span>
            )}
          </div>
          <div className="zb-balance">
            <span title={PRICE_NOTE}>{usd(received)}</span>
            {token === null ? null : <span className="zb-right">arrives as {/^zkb/i.test(token.symbol) ? token.symbol.replace(/^zkb/i, "") : `zkb${token.symbol}`} on {destination.name}</span>}
          </div>
        </div>
      </section>

      <section className="zb-actions">
        <div className="zb-col">
          <div className="zb-joined">
            <span>
              To <TokenIcon subject={{ chainId: destination.chainId }} symbol={destination.name} size={26} />
            </span>
            <button type="button" aria-expanded={menu === "receiver"} onClick={() => setMenu(menu === "receiver" ? null : "receiver")} aria-label="Destination address. Change it">
              <span className="zb-mono">{receiver === "" ? "your wallet" : short(receiver)}</span>
              <Chevron />
            </button>
          </div>
          {menu === "receiver" ? (
            <label className="zb-search-field" style={{ marginTop: 8 }}>
              <span className="zb-visually-hidden">Destination address on {destination.name}</span>
              <input spellCheck={false} autoComplete="off" placeholder="0x… (your wallet if empty)" value={form.receiver ?? ""} onChange={(event) => write({ ...form, receiver: event.target.value })} />
            </label>
          ) : null}
          {receiver !== "" && account !== null && receiver.toLowerCase() !== account.toLowerCase() ? <p className="zb-verdict" style={{ textAlign: "left" }}>Not your wallet. Check the address.</p> : null}
          {linked.length === 0 ? null : <LinkedWarning fields={linked} />}
          <button
            type="button"
            className="zb-go"
            data-kind={verdict.kind}
            disabled={!pressable(verdict)}
            onClick={() => (verdict.kind === "connect" ? void wallet.connect() : setReview(true))}
          >
            {verdict.label}
          </button>
          {verdict.detail === null ? null : <p className="zb-verdict">{verdict.detail}</p>}
        </div>
      </section>

      {menu === "token" && token !== null ? <TokenPicker tokens={tokens} selected={token} snapshots={snapshots ?? []} {...(used === undefined ? {} : { used })} resolveCustom={resolveCustom} priceOf={(subject) => { const price = priceOf(subject); return price === null ? null : usdText(priceNumber(price)); }} onPick={pick} onClose={() => setMenu(null)} /> : null}
      {review && token !== null && amount !== null ? (
        <Sheet label="Review" onClose={() => setReview(false)}>
          <div className="zb-col" style={{ paddingBottom: 18 }}>
            <div className="zb-kv"><span className="zb-k">You send</span><b>{inline(tokenIcon(token, null, 16), amountText(amount, token.decimals), token.symbol)} on {source.name}</b></div>
            <div className="zb-kv"><span className="zb-k">Arrives</span><b>{received === null ? "—" : inline(tokenIcon(token, destination.chainId, 16), amountText(received > 0n ? received : 0n, token.decimals), token.symbol)} on {destination.name}</b></div>
            <div className="zb-kv"><span className="zb-k">Fee</span><span>{tipUnits === null ? "none" : inline(tokenIcon(token, null, 18), amountText(tipUnits, token.decimals), token.symbol)}{feeUsd === null ? null : <span title={PRICE_NOTE}> (about {usd(tipUnits)})</span>}</span></div>
            {drift === null ? null : (
              <div className="zb-kv zb-kv-sub"><span className="zb-k">Can drift</span><span title={PRICE_NOTE}>{drift.now} now, up to {drift.most} if gas rises to the {drift.level} ceiling</span></div>
            )}
            {breakdown.map((line) => (
              <div key={line.label} className="zb-kv zb-kv-sub"><span className="zb-k">{line.label}</span><span title={PRICE_NOTE}>{line.value}</span></div>
            ))}
            <div className="zb-kv"><span className="zb-k">Time</span><span>{transferEstimate(source, destination)}</span></div>
            <div className="zb-kv"><span className="zb-k">To</span><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{receiver}{account !== null && receiver.toLowerCase() !== account.toLowerCase() ? " (not your wallet)" : ""}</span></div>
            {delivery === null ? null : (
              <div className="zb-kv"><span className="zb-k">Relay router</span><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{delivery.router}</span></div>
            )}
            {delivery === null || routerWarningOf(delivery) === null ? null : <div className="zb-warnbox" role="alert">{routerWarningOf(delivery)}</div>}
            {linked.length === 0 ? null : <LinkedWarning fields={linked} />}
            {verdict.kind === "warn" ? <div className="zb-warnbox">{verdict.detail}</div> : null}
            {warnings.capWarning ? (
              <div className="zb-warnbox" role="group" aria-label="Fee cap">
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
              </div>
            ) : null}
            <button type="button" className="zb-go" data-kind="go" disabled={draft.status !== "ready"} onClick={() => { setReview(false); setSigning(draft.steps); }}>
              Confirm in wallet
            </button>
            {draft.status === "ready" ? null : <p className="zb-verdict">{draft.reason}</p>}
          </div>
        </Sheet>
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
