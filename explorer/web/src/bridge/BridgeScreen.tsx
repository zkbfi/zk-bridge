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
import { ceilingCostMicroUsd, ceilingWeiOf, DEFAULT_CAP_WAD, defaultFee, feeWarnings, GAS_LEVELS, gasLevelOfCeiling, highCapLine, PROOF_COST_MICRO_USD, shareWadOfPercentText, totalCostMicroUsd, usdMicroOf, WAD, type CostInput, type GasLevel } from "@zk-bridge/shared";
import { formatUnits } from "viem";
import { loadFeeCap, saveFeeCap } from "./fee-cap";
import { DirectionMenu } from "./DirectionMenu";
import { FeeLine, type FeeSlider } from "./FeeLine";
import { Chevron, FlipIcon, FloppyIcon, Identicon, SlidersIcon } from "./icons";
import { iconSubjectOf } from "./image-source";
import { Num } from "./Num";
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
  // Money is integers (shared fee rules): prices as USD × 1e18, values in micro-dollars, shares × 1e18.
  const nativeQuote = prices?.get(`native:${destination.chainId}`) ?? null;
  const priceOf = (subject: TokenInfo | null): PriceQuote | null => (subject === null ? null : (prices?.get(`${subject.side}:${subject.address}`) ?? null));
  const tokenQuote = priceOf(token);
  const micro = (units: bigint | null): bigint | null => (units === null || tokenQuote === null || token === null ? null : usdMicroOf(units, token.decimals, tokenQuote.usdE18));
  const dollarsText = (value: bigint | null): string => (value === null ? "—" : `$${usdText(Number(value) / 1e6)}`);
  const usd = (units: bigint | null): string => dollarsText(micro(units));
  const costInputAt = (level: GasLevel): CostInput | null =>
    probe.delivery === null || nativeQuote === null
      ? null
      : { gasUsed: probe.delivery.suggestions.dataSource.gas, baseFeeWei: probe.delivery.suggestions.dataSource.baseFeeWei, priorityFeeWei: probe.delivery.priorityFeeWei, nativePriceE18: nativeQuote.usdE18, level };
  const costAt = (level: GasLevel): bigint | null => {
    const input = costInputAt(level);
    return input === null ? null : totalCostMicroUsd(input);
  };
  const baseFeeWei = probe.delivery?.suggestions.dataSource.baseFeeWei ?? null;
  const ceilingWeiText = form.tip?.ceilingGweiText === undefined ? null : safeParse(form.tip.ceilingGweiText, 9);
  const gasLevel = gasLevelOfCeiling(ceilingWeiText, baseFeeWei);
  const costMicro = costAt(gasLevel);
  const costNormalMicro = costAt(1);
  const amountMicro = micro(amount);
  const capWad = shareWadOfPercentText(String(capPercent)) ?? DEFAULT_CAP_WAD;
  const auto = defaultFee({ amountMicroUsd: amountMicro, costMicroUsd: costMicro, capWad });
  const options = useMemo(
    () => (automatic ? { ...baseOptions, percentText: formatUnits(auto.shareWad, 16) } : baseOptions),
    [automatic, baseOptions, auto.shareWad],
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
  const feeMicro = automatic && auto.feeMicroUsd !== null && tipUnits !== null ? auto.feeMicroUsd : micro(tipUnits);
  const gasBased = options.mode === "gas-multiplier";
  const expandedMicro = (() => {
    const input = costInputAt(gasLevel);
    return input === null ? null : ceilingCostMicroUsd(input);
  })();
  const shareWithoutPriceWad = options.mode === "percentage" ? shareWadOfPercentText(options.percentText) : amount === null || amount === 0n || tipUnits === null ? null : (tipUnits * WAD) / amount;
  const warnings = feeWarnings({
    amountMicroUsd: amountMicro,
    capWad,
    feeMicroUsd: feeMicro,
    costMicroUsd: costMicro,
    costNormalMicroUsd: costNormalMicro,
    shareWithoutPriceWad,
    belowBreakEven: tipUnits !== null && breakEven !== null && tipUnits < breakEven,
    gasBased,
    expandedCostMicroUsd: expandedMicro,
  });
  const line = highCapLine(amountMicro);
  const linePercent = Number((line.numerator * 10n ** 8n) / line.denominator) / 10 ** 6;
  const thresholdText = `${Number(linePercent.toPrecision(2))}%`;
  const levelName = (level: GasLevel): string => (level === 1 ? "Normal" : level === 2 ? "High" : "Highest");
  const setGasLevel = (level: GasLevel): void => {
    const { ceilingGweiText: _drop, ...rest } = form.tip ?? {};
    const ceiling = baseFeeWei === null || level === 1 ? undefined : formatUnits(ceilingWeiOf(baseFeeWei, level), 9);
    write({ ...form, tip: { ...rest, ...(ceiling === undefined ? {} : { ceilingGweiText: ceiling }) } });
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
  const breakdown =
    feeMicro === null || costMicro === null
      ? []
      : [
          { label: "Delivery gas", value: dollarsText(costMicro - PROOF_COST_MICRO_USD) },
          { label: "Proof", value: dollarsText(PROOF_COST_MICRO_USD) },
          { label: "Tip", value: feeMicro > costMicro ? dollarsText(feeMicro - costMicro) : "$0" },
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
    lowFee: feeMicro === null || costMicro === null ? null : { feeText: dollarsText(feeMicro), costText: dollarsText(costMicro) },
    highTip: warnings.highCap ? { thresholdText, tipText: feeMicro === null || costNormalMicro === null ? "—" : dollarsText(feeMicro > costNormalMicro ? feeMicro - costNormalMicro : 0n) } : null,
    smallTransfer: warnings.smallTransfer && amountMicro !== null ? { costText: dollarsText(costMicro), capText, capAmountText: dollarsText((amountMicro * capWad) / WAD) } : null,
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
  // The default ceiling is twice today's base fee, so half of it marks today's price.
  const ceilingNow = delivery?.baseFeeCeilingWei == null ? null : Number(delivery.baseFeeCeilingWei / 10_000_000n) / 100;
  const ceilingValue = form.tip?.ceilingGweiText === undefined ? (ceilingNow ?? 0) : Number(form.tip.ceilingGweiText);
  const share = (units: bigint | null): number | null => (units === null || amount === null || amount === 0n ? null : Number((units * 1_000_000n) / amount) / 10_000);
  const breakEvenPercent = share(breakEven);
  const typicalPercent = share(typical);
  const sliderMax = Math.max(1, (typicalPercent ?? 0.1) * 3, percent * 1.5);
  const sliders: FeeSlider[] = [
    {
      label: "Tip",
      help: "The share of the amount that pays whoever delivers your transfer. Left of the break-even tick a delivery bot loses money at today's gas price.",
      value: percent,
      min: 0,
      max: Number(sliderMax.toFixed(2)),
      step: 0.01,
      valueText: `${Number(percent.toPrecision(3))}%`,
      ticks: [
        ...(breakEvenPercent === null ? [] : [{ at: breakEvenPercent, label: "break-even for bots" }]),
        ...(typicalPercent === null ? [] : [{ at: typicalPercent, label: "typical" }]),
      ],
      onChange: (value) => write({ ...form, tip: { ...form.tip, mode: "percentage", percentText: String(value) } }),
    },
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
    },
    ...(ceilingNow === null
      ? []
      : [
          {
            label: "Gas price ceiling",
            help: "The highest base fee at which the tip still pays the deliverer. Higher lets your transfer through a gas spike; it never raises what you pay below it.",
            value: ceilingValue,
            min: 0,
            max: Math.max(1, Math.round(ceilingNow * 3)),
            step: 0.1,
            valueText: `${ceilingValue} gwei`,
            ticks: [{ at: Math.round((ceilingNow / 2) * 10) / 10, label: "today's price" }],
            onChange: (value: number) => write({ ...form, tip: { ...form.tip, ceilingGweiText: String(value) } }),
          },
        ]),
  ];

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
              tip={tipUnits === null ? (feeState === "none" ? "none" : "—") : inline(tokenIcon(token, null, 18), amountText(tipUnits, token.decimals), token.symbol)}
              tipHelp={`One fee pays whoever delivers your transfer on ${destination.name}: their gas, the proof, and a tip on top. It is ${Number(Number(options.percentText).toPrecision(3))}% of the amount${usd(tipUnits) === "—" ? "" : ` (about ${usd(tipUnits)})`}. Tap for the breakdown.`}
              breakdown={breakdown}
              gasHelp={`Gas level: the highest gas price on ${destination.name} at which your transfer still gets delivered. Normal: up to ${GAS_LEVELS[1].ceilingFactor}× today's base fee; High: ${GAS_LEVELS[2].ceilingFactor}×; Highest: ${GAS_LEVELS[3].ceilingFactor}×. A higher level raises the cost the fee must cover.`}
              gasLevel={gasLevel}
              onGasLevel={setGasLevel}
              time={(() => {
                const delay = lightClientDelay(heads ?? [], side);
                return delay === null ? transferEstimate(source, destination) : `${transferEstimate(source, destination)} + ${delay.text}`;
              })()}
              steps={transferSteps(source, destination)}
              sliders={sliders}
              sliderNote={breakEvenPercent === null ? null : "Left of break-even a delivery bot loses money at today's gas price, so expect to deliver it yourself."}
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
            <div className="zb-kv"><span className="zb-k">Fee</span><span>{tipUnits === null ? "none" : inline(tokenIcon(token, null, 18), amountText(tipUnits, token.decimals), token.symbol)}{feeMicro === null ? null : <span title={PRICE_NOTE}> (about {usd(tipUnits)})</span>}</span></div>
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
                <button type="button" className="zb-q zb-save" style={{ marginLeft: 8, verticalAlign: "middle" }} aria-label={capSave.label} title={capSave.label} disabled={capSave.saved} onClick={capSave.onSave}>
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
