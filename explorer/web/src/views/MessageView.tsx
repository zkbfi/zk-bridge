/**
 * The message page (mockup explore-message.html). Every transfer is a message; the page tells one message's whole
 * story: the band (kind, route, amount, message ID, status), who and what (from, to, sent, received, the fee as one total
 * that opens into its parts, who delivered it), the steps from send to delivery (each opening a drawer; a failed release
 * opens to its reason), then the message itself (nonce, the app on each side by what it is, the payload).
 * Real data only: where the indexer, the deployment or the chain has no value the page shows "—".
 */
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import type { Hex } from "viem";
import type { MessageCosts } from "@zk-bridge/shared";
import type { PairConfig, TokenInfo } from "@terminal/model/types";
import { formatRoute, type ExplorePage } from "../app/route";
import { useMessage } from "../app/queries";
import { useServices } from "../app/services";
import { amountText } from "../bridge/bridge-model";
import { Chevron, CopyIcon, ExternalLink } from "../bridge/icons";
import { iconSubjectOf } from "../bridge/image-source";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import type { DetailDelivery, DetailToken, MessageDetail } from "../data/message-detail";
import { feePercentText, feeSummaryText } from "../data/fee-summary";
import { chainNamer } from "../explore/ExploreScreen";
import { durationText, statusWord } from "../explore/explore-model";
import { appOf, calledFunction, messageSteps, payloadBytes, payloadSummary, stepCostText, type MessageApp, type MessageStep } from "../explore/message-model";
import { KV, RouteIcons, shortHex, XBand, XGroup } from "../explore/parts";
import { DrawerGrid, StepTrail, type TrailStep } from "../explore/StepTrail";
import { explorerUrl } from "../explore/chain-reader";
import { BlockDrawer, Missing, timeText, TxDrawer } from "../explore/TxAddressPages";
import { ProofPanel } from "./ProofPanel";

const FINISHED: readonly MessageDetail["status"][] = ["delivered", "release_failed"];

const explore = (page: ExplorePage): string => formatRoute({ name: "explore", page });

/** Why a value is "—": the indexer does not record it yet. */
const NOT_RECORDED = "The indexer does not record this yet";

/** A detail token as the icon set knows it: its side, and the token on the other side as its counterpart. */
const tokenInfoOf = (token: DetailToken, other: DetailToken, pair: PairConfig): TokenInfo => ({
  address: token.address,
  symbol: token.symbol,
  decimals: token.decimals,
  side: token.chainId === pair.first.chainId ? "first" : "second",
  counterpart: other.address,
});

/** A token's icon, with the chain badge unless `badge` is false (a row that names the chain on its left). */
const TokenMark = ({ token, other, pair, size, surface, badge = true }: { readonly token: DetailToken; readonly other: DetailToken; readonly pair: PairConfig; readonly size: number; readonly surface?: "accent" | "plain"; readonly badge?: boolean }) => (
  <TokenIcon subject={iconSubjectOf(tokenInfoOf(token, other, pair), pair)} badgeChainId={badge ? token.chainId : null} symbol={token.symbol} size={size} surface={surface ?? "plain"} decorative />
);

/**
 * A sent or received line (owner: "Sent on [Chain_icon] [link]       [amount][symbol][token_icon]"): the label, the chain
 * icon alone (its name only in the alt text, owner: a chain icon standing by itself needs no name) and a link out to
 * that chain's transaction; on the right the bold amount, the symbol and the token icon, then a chevron-wide spacer so
 * the token icons line up with the Fee row's.
 */
const AmountRow = ({ label, chain, hash, children }: { readonly label: string; readonly chain: { readonly chainId: number; readonly name: string }; readonly hash: Hex | null; readonly children: ReactNode }) => {
  const url = hash === null ? undefined : explorerUrl(chain.chainId, "tx", hash);
  return (
    <div className="zb-kv zb-xkv">
      <span className="zb-k zb-xkg">
        <span>{label} on</span>
        <TokenIcon subject={{ chainId: chain.chainId }} symbol={chain.name} size={16} />
        {url === undefined ? <span /> : (
          <a href={url} target="_blank" rel="noreferrer" aria-label={`The transaction on ${chain.name}'s explorer`}>
            <ExternalLink />
          </a>
        )}
      </span>
      <span className="zb-xv">
        {children}
        <span className="zb-xsp" aria-hidden="true" />
      </span>
    </div>
  );
};

/** The app on one side of a message: its name and short address, leading to its contract (or address) page. */
const AppValue = ({ app }: { readonly app: MessageApp }) => (
  <>
    {app.name === null ? null : <span>{app.name}</span>}
    <span className="zb-mono">{shortHex(app.address)}</span>
  </>
);

/** The message ID, copied with one tap. */
const CopyId = ({ id }: { readonly id: Hex }) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="zb-xcopy"
      aria-label={copied ? "Message ID copied" : "Copy the message ID"}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => setCopied(false));
      }}
    >
      <CopyIcon />
    </button>
  );
};

/**
 * The fee as one row: the token icon, the total and its USD value, with a right chevron that turns down as its drawer
 * opens into delivery gas, proof generation and the tip to the deliverer (owner: "show a total and allow a drawer to
 * open from a right pointing chevron"). The indexer records none of the parts yet, so each shows "—".
 */
/** Where the indexer read the fee, in words. */
const FEE_SOURCE_WORDS: Readonly<Record<NonNullable<DetailDelivery["source"]>, string>> = {
  event: "the router's Delivered event",
  logs: "the token transfers of the delivery",
  terms: "the sender's terms (the router paid the native coin, which leaves no log)",
};

/** Why a router delivery has no fee figure. */
const feeMissingWhy = (delivery: DetailDelivery | null): string =>
  delivery === null
    ? "No delivery router delivered this transfer, so no delivery fee was taken"
    : delivery.source === "terms"
      ? "A gas-based fee paid in the native coin leaves no log, so the indexer cannot read it"
      : NOT_RECORDED;

const FeeRow = ({ token, other, pair, destination, delivery }: { readonly token: DetailToken | null; readonly other: DetailToken | null; readonly pair: PairConfig; readonly destination: { readonly chainId: number; readonly name: string }; readonly delivery: DetailDelivery | null }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  const fee = delivery?.fee ?? null;
  const percent = feePercentText(fee, delivery?.received ?? null);
  // Each part: the amount and a small token icon in place of the symbol (owner). The cost parts are not recorded yet;
  // the tip is the fee that the router paid to the deliverer.
  const icon = (size: number) => (other === null || token === null ? null : <TokenMark token={other} other={token} pair={pair} size={size} badge={false} />);
  const missing = (
    <span className="zb-xamt-sm">
      <Missing why={NOT_RECORDED} />
      {icon(14)}
    </span>
  );
  const feePart =
    fee === null || other === null ? (
      <span className="zb-xamt-sm">
        <Missing why={feeMissingWhy(delivery)} />
        {icon(14)}
      </span>
    ) : (
      <span className="zb-xamt-sm">
        <Num text={amountText(fee, other.decimals)} />
        {icon(14)}
      </span>
    );
  return (
    <>
      <button type="button" className="zb-kv zb-xkv zb-xtap" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
        <span className="zb-k zb-xkg">
          <span>Fee</span>
          <span className="zb-xusd">$<Missing why="Needs a price; testnets have none" /></span>
        </span>
        <span className="zb-xv">
          <b>{fee === null || other === null ? <Missing why={feeMissingWhy(delivery)} /> : <><Num text={amountText(fee, other.decimals)} />{percent === null ? null : ` (${percent})`}</>}</b>
          {icon(22)}
          <Chevron dir={open ? "down" : "right"} />
        </span>
      </button>
      <div className={open ? "zb-drawer zb-open" : "zb-drawer"} id={id} aria-hidden={!open} inert={!open}>
        <div className="zb-drawer-inner">
          <div className="zb-drawer-body zb-xfee">
            <dl className="zb-trail-grid">
              <div>
                <dt>Delivery gas · <TokenIcon subject={{ chainId: destination.chainId }} symbol={destination.name} size={14} /></dt>
                <dd>{missing}</dd>
              </div>
              <div>
                <dt>Proof generation</dt>
                <dd>{missing}</dd>
              </div>
              <div>
                <dt>Tip to the deliverer</dt>
                <dd>{feePart}</dd>
              </div>
              {delivery?.deliverer == null ? null : (
                <div>
                  <dt>Deliverer</dt>
                  <dd><a href={explore({ kind: "address", id: delivery.deliverer })} className="zb-mono">{shortHex(delivery.deliverer)}</a></dd>
                </div>
              )}
              {delivery?.source == null ? null : (
                <div>
                  <dt>Read from</dt>
                  <dd>{FEE_SOURCE_WORDS[delivery.source]}</dd>
                </div>
              )}
              <div className="zb-xfee-total">
                <dt>Total</dt>
                <dd>{feePart}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </>
  );
};

/** A step's cost for its drawer (owner: only in the expanded view), or "—" when the indexer has not stored it. */
const CostCell = ({ text }: { readonly text: string | null }) => (text === null ? <Missing why={NOT_RECORDED} /> : <span title={COST_NOTE}>{text}</span>);
const COST_NOTE = "Gas used × the effective gas price, in the chain's coin; dollars at the PulseX price of the block the indexer read (for Ethereum, the PulseChain block nearest the transaction).";

/** The drawer of the delivery step: the transaction, its block, gas and what it paid out; or, for a release that failed, the reason first. */
const DeliveryDrawer = ({ detail, reverted, pair }: { readonly detail: MessageDetail; readonly reverted: boolean; readonly pair: PairConfig }) => {
  const cost = <CostCell text={stepCostText(detail.costs?.delivered ?? null, pair)} />;
  const gasUsed = detail.costs?.delivered == null ? null : Number(detail.costs.delivered.gasUsed).toLocaleString("en-US");
  const hash = detail.destinationTransactionHash;
  const transaction: readonly [string, ReactNode] = ["Transaction", hash === null ? <Missing why={NOT_RECORDED} /> : <a href={explore({ kind: "tx", chainId: detail.destinationChainId, id: hash })} className="zb-mono">{shortHex(hash)}</a>];
  if (reverted) {
    return (
      <DrawerGrid
        rows={[
          ["Reason", "the mediator could not release the tokens; final"],
          transaction,
          ["Gas used", gasUsed ?? <Missing why={NOT_RECORDED} />],
          ["Cost", cost],
        ]}
      />
    );
  }
  const paid = detail.transfer?.deliveredValue ?? null;
  return (
    <DrawerGrid
      rows={[
        transaction,
        ["Block", detail.deliveredBlockNumber === null ? <Missing why={NOT_RECORDED} /> : <a href={explore({ kind: "block", chainId: detail.destinationChainId, id: String(detail.deliveredBlockNumber) })}>{detail.deliveredBlockNumber.toLocaleString("en-US")}</a>],
        ["Gas", gasUsed ?? <Missing why={NOT_RECORDED} />],
        ["Cost", cost],
        ...(detail.transfer === null ? [] : [["Paid out", paid === null ? <Missing why={NOT_RECORDED} /> : <><Num text={amountText(paid, detail.transfer.destinationToken.decimals)} /> {detail.transfer.destinationToken.symbol}</>] as const]),
      ]}
    />
  );
};

/** The drawer of the proof step: the proof, its transaction and its cost, shared by every message it covered. */
const ProofDrawer = ({ proof, pair, href }: { readonly proof: NonNullable<MessageCosts["proof"]>; readonly pair: PairConfig; readonly href: string | undefined }) => (
  <DrawerGrid
    rows={[
      ...(href === undefined ? [] : [["Proof", <a href={href}>open</a>] as const]),
      ["Transaction", <a href={explore({ kind: "tx", chainId: proof.chainId, id: proof.hash })} className="zb-mono">{shortHex(proof.hash)}</a>],
      ["Cost", <CostCell text={stepCostText(proof, pair)} />],
    ]}
  />
);

const trailOf = (steps: readonly MessageStep[], detail: MessageDetail, pair: PairConfig): TrailStep[] =>
  steps.map((step, index) => ({
    label: step.label,
    done: step.done,
    when: step.at === null ? (step.done ? "" : "waiting") : timeText(step.at),
    ...(step.href === undefined ? {} : { href: step.href }),
    ...(step.tone === undefined ? {} : { tone: step.tone }),
    ...(step.detail === undefined
      ? // The proof step (the third) opens a drawer once the indexer has its cost; else it only links to the proof.
        index === 2 && detail.costs?.proof != null
        ? { drawer: <ProofDrawer proof={detail.costs.proof} pair={pair} href={step.href} /> }
        : {}
      : {
          drawer:
            step.detail.kind === "block" ? (
              <BlockDrawer detail={step.detail} />
            ) : step.detail.kind === "tx" ? (
              <TxDrawer detail={step.detail} cost={<CostCell text={stepCostText(detail.costs?.sent ?? null, pair)} />} />
            ) : (
              <DeliveryDrawer detail={detail} reverted={step.detail.reverted} pair={pair} />
            ),
        }),
  }));

/** The payload: its size and, for a mediator call, what it asks; opens to the raw bytes. */
const PayloadRow = ({ detail }: { readonly detail: MessageDetail }) => {
  const [open, setOpen] = useState(false);
  if (detail.data === null) return <KV k="Payload"><Missing why={NOT_RECORDED} /></KV>;
  const summary = payloadSummary(detail);
  return (
    <>
      <button type="button" className="zb-xraw" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Chevron dir={open ? "down" : "right"} /> Payload ({payloadBytes(detail.data).toLocaleString("en-US")} bytes){summary === null ? "" : `, decoded: ${summary}`}
      </button>
      {open ? <pre className="zb-mono zb-xrawtext">{detail.data}</pre> : null}
    </>
  );
};

/**
 * The page of one transfer or message.
 *
 * @param props The message identifier.
 */
export const MessageView = ({ messageId }: { readonly messageId: Hex }) => {
  const { pair, explore: indexed } = useServices();
  const message = useMessage(messageId);
  const proofs = useQuery({ queryKey: ["explore", "proofs"], queryFn: () => indexed.proofs() }).data ?? [];
  const names = chainNamer(pair);
  if (message.error !== null && message.data === undefined) {
    return (
      <>
        <XBand label="Message" big="Not loaded" />
        <div className="zb-col zb-xpage"><p className="zb-small">The message did not load: {message.error.message}</p></div>
      </>
    );
  }
  if (message.data === undefined) return <XBand label="Message" big="Loading…" />;
  if (message.data === null) {
    return (
      <>
        <XBand label="Message" big="Not found" />
        <div className="zb-col zb-xpage"><p className="zb-small">The indexer does not know the message <span className="zb-mono zb-break">{messageId}</span>.</p></div>
      </>
    );
  }
  const detail = message.data;
  const transfer = detail.transfer;
  const source = { chainId: detail.sourceChainId, name: names(detail.sourceChainId) };
  const destination = { chainId: detail.destinationChainId, name: names(detail.destinationChainId) };
  const steps = messageSteps(detail, pair, proofs);
  const stopped = steps.findIndex((step) => step.tone === "error");
  const reverted = stopped >= 0;
  const status = statusWord(detail.status);
  // A message that reached its destination (delivered, or failed to release) has nothing left to prove or deliver.
  const finished = detail.deliveredAt !== null || FINISHED.includes(detail.status);
  const call = calledFunction(detail.data);
  const target = appOf(pair, detail.destinationChainId, detail.executor);
  const deliveredBy = detail.executedBy === null ? <KV k="Delivered by"><Missing why={detail.deliveredAt === null ? "Not delivered yet" : NOT_RECORDED} /></KV> : <KV k="Delivered by" href={explore({ kind: "address", id: detail.executedBy })}><span className="zb-mono">{shortHex(detail.executedBy)}</span></KV>;
  return (
    <>
      <XBand
        label={
          <>
            {transfer === null ? "Contract call" : "Token transfer"} <RouteIcons from={source.chainId} to={destination.chainId} names={names} surface="accent" />
          </>
        }
        big={
          transfer === null ? (
            "Message"
          ) : (
            <span className="zb-xamt">
              <TokenMark token={transfer.sourceToken} other={transfer.destinationToken} pair={pair} size={34} surface="accent" />
              <span>
                <Num text={amountText(transfer.value, transfer.sourceToken.decimals)} /> {transfer.sourceToken.symbol}
              </span>
            </span>
          )
        }
        sub={
          <>
            <span className="zb-mono zb-break">{shortHex(detail.id)}</span> · message ID <CopyId id={detail.id} />
          </>
        }
        tags={
          <>
            <span className="zb-xtag">{status}</span>
            {detail.deliveredAt === null || reverted ? null : <span className="zb-xtag">{durationText(detail.deliveredAt - detail.sentAt)}</span>}
          </>
        }
      />
      <div className="zb-col zb-xpage">
        <XGroup title="Who and what" />
        {transfer === null ? (
          <>
            <KV k="From" href={explore({ kind: "address", id: detail.sender })}><span className="zb-mono">{shortHex(detail.sender)}</span></KV>
            <KV k="Calls" href={target.href}><AppValue app={target} /></KV>
            <KV k="Function">{call === null ? <Missing why={NOT_RECORDED} /> : <span className="zb-mono zb-break">{call.text}</span>}</KV>
            <KV k="Arguments">{detail.data === null ? <Missing why={NOT_RECORDED} /> : `${Math.max(0, payloadBytes(detail.data) - 4).toLocaleString("en-US")} bytes`}</KV>
            {deliveredBy}
            <PayloadRow detail={detail} />
          </>
        ) : (
          <>
            {transfer.sender === null ? <KV k="From"><Missing why={NOT_RECORDED} /></KV> : <KV k="From" href={explore({ kind: "address", id: transfer.sender })}><span className="zb-mono">{shortHex(transfer.sender)}</span></KV>}
            <KV k="To" href={explore({ kind: "address", id: transfer.delivery?.recipient ?? transfer.recipient })}><span className="zb-mono">{shortHex(transfer.delivery?.recipient ?? transfer.recipient)}</span></KV>
            <a className="zb-kv zb-xkv" href={explore({ kind: "token", id: `${transfer.sourceToken.chainId === pair.first.chainId ? "first" : "second"}:${transfer.sourceToken.address}` })}>
              <span className="zb-k">Token</span>
              <span className="zb-xv">
                <b>{transfer.sourceToken.symbol}</b>
                <TokenMark token={transfer.sourceToken} other={transfer.destinationToken} pair={pair} size={22} badge={false} />
                <Chevron dir="right" />
              </span>
            </a>
            <AmountRow label="Sent" chain={source} hash={detail.sourceTransactionHash}>
              <b><Num text={amountText(transfer.value, transfer.sourceToken.decimals)} /></b>
              <TokenMark token={transfer.sourceToken} other={transfer.destinationToken} pair={pair} size={22} badge={false} />
            </AmountRow>
            <AmountRow label="Received" chain={destination} hash={detail.destinationTransactionHash}>
              {(transfer.delivery === null ? transfer.deliveredValue : transfer.delivery.received) === null ? (
                <Missing why={detail.deliveredAt === null ? "Not delivered yet" : transfer.delivery === null ? NOT_RECORDED : feeMissingWhy(transfer.delivery)} />
              ) : (
                <>
                  <b><Num text={amountText((transfer.delivery === null ? transfer.deliveredValue : transfer.delivery.received) as bigint, transfer.destinationToken.decimals)} /></b>
                  <TokenMark token={transfer.destinationToken} other={transfer.sourceToken} pair={pair} size={22} badge={false} />
                </>
              )}
            </AmountRow>
            <FeeRow token={transfer.sourceToken} other={transfer.destinationToken} pair={pair} destination={destination} delivery={transfer.delivery} />
            {transfer.delivery === null || transfer.delivery.fee === null ? null : (
              <p className="zb-small zb-xsummary">
                {feeSummaryText({ sent: transfer.value, sentDecimals: transfer.sourceToken.decimals, sentSymbol: transfer.sourceToken.symbol, fee: transfer.delivery.fee, received: transfer.delivery.received, decimals: transfer.destinationToken.decimals, symbol: transfer.destinationToken.symbol })}
              </p>
            )}
            {deliveredBy}
          </>
        )}
        <XGroup title="Steps" />
        <StepTrail steps={trailOf(steps, detail, pair)} initiallyOpen={reverted ? stopped : null} />
        {transfer === null ? null : (
          <>
            <XGroup title="The message itself" />
            <KV k="Nonce"><Missing why={NOT_RECORDED} /></KV>
            <SourceApp detail={detail} />
            <KV k="Target app" href={target.href}><AppValue app={target} /></KV>
            <PayloadRow detail={detail} />
          </>
        )}
        {finished ? null : (
          <>
            <XGroup title="Prove and deliver it yourself" />
            <ProofPanel detail={detail} />
          </>
        )}
      </div>
    </>
  );
};

const SourceApp = ({ detail }: { readonly detail: MessageDetail }) => {
  const { pair } = useServices();
  const app = appOf(pair, detail.sourceChainId, detail.sender);
  return (
    <KV k="Source app" href={app.href}>
      <AppValue app={app} />
    </KV>
  );
};
