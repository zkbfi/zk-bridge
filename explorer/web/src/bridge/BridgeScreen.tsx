import { useCallback, useMemo, useState, type ReactNode } from "react";
import { defaultRpcUrl } from "@terminal/config/default-rpc";
import { erc20ReaderFor, isFirstBridge, resolveCustomToken } from "./custom-token";
import { addPending } from "./pending";
import type { Address } from "viem";
import type { TokenInfo } from "@terminal/model/types";
import { useDeliveryCost, usePairHealth, usePriorityFee, useSnapshots, useTokens, useUsedTokens } from "../app/queries";
import { formatRoute, type BridgeQuery, type Route, type TipQuery } from "../app/route";
import { useServices } from "../app/services";
import { TransactionDialog } from "../actions/TransactionDialog";
import { computeBridgeDraft, DEFAULT_DELIVERY_OPTIONS, type DeliveryOptions } from "../tx/bridge-draft";
import type { WebStep } from "../tx/bridge-steps";
import { parseUnits } from "../ui/format";
import { useWallet } from "../wallet/wallet-port";
import { amountText, chainsFor, choiceOf, counterpartOf, directionFrom, reverse, sourceSide, tokenFor, transferEstimate, transferSteps } from "./bridge-model";
import { DeliveryMenu, deliverySummary, GAS_LEVELS, gasLevelOf } from "./DeliveryMenu";
import { DirectionMenu } from "./DirectionMenu";
import { FeeLine, type FeeSlider } from "./FeeLine";
import { Chevron, FlipIcon, Identicon, SlidersIcon } from "./icons";
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
  const tokens = useMemo(() => [...known, ...customTokens], [known, customTokens]);
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
  const used = useUsedTokens(account, pair.id).data;
  const gate = usePairHealth().data?.find((entry) => entry.pairId === pair.id)?.gates[sourceSide(route.dir)];
  const form: BridgeQuery = route.form ?? {};
  const { source, destination } = chainsFor(pair, route.dir);
  const side = sourceSide(route.dir);
  const token = tokenFor(form.token, tokens, side);
  const options = useMemo(() => optionsOf(form.tip), [form.tip]);
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
  const values = { token: token === null ? "" : choiceOf(token), amount: form.amount ?? "", receiver, mode: "plain" as const, data: "", gasLimit: form.gasLimit ?? "", callTarget: "", callData: "" };
  const context = { pair, snapshots: snapshots ?? [], signerAddress: account ?? ("0x0000000000000000000000000000000000000000" as Address) };
  const draft = useMemo(
    () => computeBridgeDraft(values, options, { pair, tokens, context, report: report.data ?? null, priorityFeeWei: priority.data ?? null }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(values), options, pair, tokens, snapshots, report.data, priority.data],
  );

  const snapshot = (snapshots ?? []).find((result) => result.status === "ok" && result.snapshot.chain.side === side);
  const balance = snapshot?.status === "ok" && token !== null ? (snapshot.snapshot.positions.find((position) => position.token.address === token.address)?.balance ?? null) : null;
  const amount = token === null ? null : safeParse(form.amount ?? "", token.decimals);
  const delivery = draft.delivery;
  const tipUnits = delivery?.description.nowUnits ?? null;
  const range = delivery?.suggestions.tipRange;
  const breakEven = range?.kind === "available" ? range.low.description.nowUnits : null;
  const typical = range?.kind === "available" ? range.default.description.nowUnits : null;
  const received = amount !== null && tipUnits !== null ? amount - tipUnits : amount;
  const gasWei = delivery?.suggestions.cost.gasCostWei ?? null;

  const verdict = verdictOf({
    connected: account !== null,
    draft,
    amountEntered: amount !== null && amount > 0n,
    overBalance: amount !== null && balance !== null && amount > balance,
    symbol: token?.symbol ?? "",
    paused: gate === "stop" || gate === "sealed" ? { route: `${source.name} → ${destination.name}` } : null,
    tipBelowBreakEven: tipUnits !== null && breakEven !== null && tipUnits < breakEven,
    firstBridge: token !== null && isFirstBridge(token, known, false),
  });

  const tokenIcon = (subjectToken: TokenInfo, badge: number | null, size = 26): ReactNode => <TokenIcon subject={iconSubjectOf(subjectToken, pair)} badgeChainId={badge} symbol={subjectToken.symbol} size={size} />;
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
      valueText: `${percent}%`,
      ticks: [
        ...(breakEvenPercent === null ? [] : [{ at: breakEvenPercent, label: "break-even for bots" }]),
        ...(typicalPercent === null ? [] : [{ at: typicalPercent, label: "typical" }]),
      ],
      onChange: (value) => write({ ...form, tip: { ...form.tip, mode: "percentage", percentText: String(value) } }),
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
      {fixture ? <p className="zb-col" style={{ fontSize: 12, color: "var(--zb-muted)", margin: "0 auto 6px" }}>Sample data. Nothing here reaches a chain.</p> : null}
      <div className="zb-col zb-row-pad" style={{ position: "relative" }}>
        <div className="zb-joined">
          <button type="button" aria-haspopup="menu" aria-expanded={menu === "direction"} onClick={() => setMenu(menu === "direction" ? null : "direction")} aria-label={`From ${source.name}. Change the route`}>
            From <TokenIcon subject={{ chainId: source.chainId }} symbol={source.name} size={22} />
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
                {tokenIcon(token, null)}
                {token.symbol}
                <Chevron />
              </button>
            )}
          </div>
          <div className="zb-balance">
            <span title="No price source yet">—</span>
            <span className="zb-right">
              {balance === null || token === null ? null : (
                <>
                  <span>
                    Balance <Num text={amountText(balance, token.decimals)} />
                  </span>
                  <button type="button" className="zb-max" onClick={() => write({ ...form, amount: amountText(balance, token.decimals) })}>
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
              tip={tipUnits === null ? "—" : inline(tokenIcon(token, null, 14), amountText(tipUnits, token.decimals), token.symbol)}
              tipHelp={`The tip pays whoever delivers your transfer on ${destination.name}. It is ${options.percentText}% of the amount, and at least their gas at today's price. Tap to change it.`}
              gas={gasWei === null ? "—" : inline(<TokenIcon subject={{ chainId: destination.chainId }} symbol={destination.nativeSymbol} size={14} />, amountText(gasWei, 18), destination.nativeSymbol)}
              gasHelp={`What the delivery costs in gas on ${destination.name} at today's price. The tip covers it.`}
              gasLevel={gasLevelOf(form.tip?.gasMultiplierText)}
              onGasLevel={(level) => write({ ...form, tip: { ...form.tip, gasMultiplierText: GAS_LEVELS.find((candidate) => candidate.level === level)!.multiplier } })}
              time={transferEstimate(source, destination)}
              steps={transferSteps(source, destination)}
              sliders={sliders}
              sliderNote={breakEvenPercent === null ? null : "Left of break-even a delivery bot loses money at today's gas price, so expect to deliver it yourself."}
            />
          )}
          <div className="zb-amount-row" style={{ marginTop: 6 }}>
            <span className="zb-amount-out" aria-label={`You receive on ${destination.name}`}>
              {received === null || token === null ? "0" : <Num text={amountText(received > 0n ? received : 0n, token.decimals)} />}
            </span>
            {token === null ? null : (
              <span className="zb-token">
                {tokenIcon(token, destination.chainId)}
                {token.symbol.replace(/^zkb/i, "")}
              </span>
            )}
          </div>
          <div className="zb-balance">
            <span title="No price source yet">—</span>
            {token === null ? null : <span className="zb-right">arrives as {/^zkb/i.test(token.symbol) ? token.symbol.replace(/^zkb/i, "") : `zkb${token.symbol}`} on {destination.name}</span>}
          </div>
        </div>
      </section>

      <section className="zb-actions">
        <div className="zb-col">
          <div className="zb-joined">
            <span>
              To <TokenIcon subject={{ chainId: destination.chainId }} symbol={destination.name} size={22} />
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

      {menu === "token" && token !== null ? <TokenPicker tokens={tokens} selected={token} snapshots={snapshots ?? []} {...(used === undefined ? {} : { used })} resolveCustom={resolveCustom} onPick={pick} onClose={() => setMenu(null)} /> : null}
      {review && token !== null && amount !== null ? (
        <Sheet label="Review" onClose={() => setReview(false)}>
          <div className="zb-col" style={{ paddingBottom: 18 }}>
            <div className="zb-kv"><span className="zb-k">You send</span><b>{inline(tokenIcon(token, null, 16), amountText(amount, token.decimals), token.symbol)} on {source.name}</b></div>
            <div className="zb-kv"><span className="zb-k">Arrives</span><b>{received === null ? "—" : inline(tokenIcon(token, destination.chainId, 16), amountText(received > 0n ? received : 0n, token.decimals), token.symbol)} on {destination.name}</b></div>
            <div className="zb-kv"><span className="zb-k">Tip</span><span>{tipUnits === null ? "none" : inline(tokenIcon(token, null, 14), amountText(tipUnits, token.decimals), token.symbol)}</span></div>
            <div className="zb-kv"><span className="zb-k">Time</span><span>{transferEstimate(source, destination)}</span></div>
            <div className="zb-kv"><span className="zb-k">To</span><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{receiver}{account !== null && receiver.toLowerCase() !== account.toLowerCase() ? " (not your wallet)" : ""}</span></div>
            {delivery === null ? null : (
              <div className="zb-kv"><span className="zb-k">Relay router</span><span className="zb-mono" style={{ wordBreak: "break-all", textAlign: "right" }}>{delivery.router}</span></div>
            )}
            {delivery === null || routerWarningOf(delivery) === null ? null : <div className="zb-warnbox" role="alert">{routerWarningOf(delivery)}</div>}
            {linked.length === 0 ? null : <LinkedWarning fields={linked} />}
            {verdict.kind === "warn" ? <div className="zb-warnbox">{verdict.detail}</div> : null}
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
