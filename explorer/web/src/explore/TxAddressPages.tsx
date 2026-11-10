/**
 * The transaction and address pages (mockup explore-address-tx.html). A transaction: the kind in the band, the details
 * (from, to, function, gas, fee, nonce), where it sits (from the user's action to delivery, each step opening a drawer
 * with its details), the decoded events and the raw input collapsed. An address: identity band, balance and activity on
 * each chain, what it did through zkb.fi, and its transfers and proofs.
 */
import { useQuery } from "@tanstack/react-query";
import { CopyValue } from "../ui/CopyValue";
import { useState, type ReactNode } from "react";
import { getAddress, type Address, type Hex } from "viem";
import type { PairConfig } from "@terminal/model/types";
import { formatRoute, type ExplorePage } from "../app/route";
import { useFeed } from "../app/queries";
import { useServices } from "../app/services";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { Chevron, ExternalLink, Identicon } from "../bridge/icons";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { explorerUrl, useChainReader } from "./chain-reader";
import { chainNamer } from "./ExploreScreen";
import { statusWord } from "./explore-model";
import { KV, RouteIcons, shortHex, XBand, XGroup, XRow } from "./parts";
import { DrawerGrid, StepTrail, type TrailStep } from "./StepTrail";
import { describeTransaction, whereItSits, type StepDetail } from "./tx-model";

const explore = (page: ExplorePage): string => formatRoute({ name: "explore", page });

const chainOf = (pair: PairConfig, chainId: number) => (pair.first.chainId === chainId ? pair.first : pair.second);

/** A time for a step: "29 Oct, 16:07". */
export const timeText = (unix: number): string => new Date(unix * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** A value that neither the indexer nor the chain gives, with the reason on hover. */
export const Missing = ({ why }: { readonly why: string }) => <span title={why}>—</span>;

/** The drawer of a block step: number, hash, time, slot, committee and the explorer link. */
export const BlockDrawer = ({ detail }: { readonly detail: Extract<StepDetail, { kind: "block" }> }) => {
  const reader = useChainReader()(detail.chainId);
  const block = useQuery({ queryKey: ["block", detail.chainId, detail.number.toString()], enabled: reader !== null, queryFn: () => reader!.block(detail.number) }).data;
  const url = explorerUrl(detail.chainId, "block", detail.number.toString());
  return (
    <DrawerGrid
      rows={[
        ["Block", <a href={explore({ kind: "block", chainId: detail.chainId, id: detail.number.toString() })}>{detail.number.toLocaleString("en-US")}</a>],
        ["Hash", detail.hash !== null ? <CopyValue value={detail.hash} label="Copy block hash">{shortHex(detail.hash)}</CopyValue> : block === undefined || block.hash === null ? <Missing why="Read from the chain" /> : <CopyValue value={block.hash} label="Copy block hash">{shortHex(block.hash)}</CopyValue>],
        ["Time", block === undefined ? <Missing why="Read from the chain" /> : new Date(Number(block.timestamp) * 1000).toLocaleString("en-GB")],
        ["Slot", detail.slot === null ? <Missing why="Not known" /> : <a href={explore({ kind: "slot", id: detail.slot.toString() })}>{detail.slot.toLocaleString("en-US")}</a>],
        ["Committee", detail.period === null ? <Missing why="Not known" /> : <>period {detail.period.toLocaleString("en-US")} · <Missing why="The indexer does not record the signers" /> signed</>],
        ["Explorer", url === undefined ? <Missing why="No explorer for this chain" /> : <a href={url} target="_blank" rel="noreferrer" aria-label="The block on the chain's explorer"><ExternalLink /></a>],
      ]}
    />
  );
};

/** The drawer of a transaction step: the transaction, its cost when the page has it, and the explorer link. */
export const TxDrawer = ({ detail, cost }: { readonly detail: Extract<StepDetail, { kind: "tx" }>; readonly cost?: ReactNode }) => {
  const url = explorerUrl(detail.chainId, "tx", detail.hash);
  return (
    <DrawerGrid
      rows={[
        ["Transaction", <a href={explore({ kind: "tx", chainId: detail.chainId, id: detail.hash })} className="zb-mono">{shortHex(detail.hash)}</a>],
        ...(cost === undefined ? [] : [["Cost", cost] as const]),
        ["Explorer", url === undefined ? <Missing why="No explorer for this chain" /> : <a href={url} target="_blank" rel="noreferrer" aria-label="The transaction on the chain's explorer"><ExternalLink /></a>],
      ]}
    />
  );
};

/** The transaction page. */
export const TransactionPage = ({ chainId, hash }: { readonly chainId: number; readonly hash: Hex }) => {
  const { pair, explore: source } = useServices();
  const names = chainNamer(pair);
  const reader = useChainReader()(chainId);
  const read = useQuery({ queryKey: ["tx", chainId, hash], enabled: reader !== null, queryFn: () => reader!.transaction(hash), retry: 0 });
  const latest = useQuery({ queryKey: ["explore", "proofs"], queryFn: () => source.proofs() }).data ?? [];
  // The update this transaction posted, wherever it is in the history.
  const posted = useQuery({ queryKey: ["explore", "proofs-of-tx", hash.toLowerCase()], queryFn: () => source.findProofs({ transactionHash: hash.toLowerCase() as Hex }) }).data ?? [];
  const proofs = [...posted, ...latest];
  const feed = useFeed(pair.id, {}, 100).data?.items ?? [];
  const [raw, setRaw] = useState(false);
  const chain = chainOf(pair, chainId);
  const url = explorerUrl(chainId, "tx", hash);
  if (reader === null) {
    return <XBand label={chain.name} big="Transaction" sub={<span className="zb-mono">{hash}</span>} />;
  }
  if (read.isError) {
    return (
      <>
        <XBand label={chain.name} big="Not found" sub={<span className="zb-mono">{hash}</span>} />
        <div className="zb-col"><p className="zb-small">{chain.name} has no transaction with this hash.</p></div>
      </>
    );
  }
  if (read.data === undefined) return <XBand label={chain.name} big="Reading…" sub={<span className="zb-mono">{hash}</span>} />;
  const described = describeTransaction({ chainId, tx: read.data.tx, receipt: read.data.receipt, pair, proofs, feed });
  const steps = whereItSits(described, pair, described.transfer);
  const trail: TrailStep[] = steps.map((step) => ({
    label: step.label,
    done: step.done,
    when: step.at === null ? (step.done ? "" : "waiting") : timeText(step.at),
    ...(step.href === undefined ? {} : { href: step.href }),
    ...(step.detail === undefined ? {} : { drawer: step.detail.kind === "block" ? <BlockDrawer detail={step.detail} /> : <TxDrawer detail={step.detail} /> }),
  }));
  return (
    <>
      <XBand
        label={<>{chain.name} · block {described.blockNumber.toLocaleString("en-US")}</>}
        big={described.kind}
        sub={
          <>
            <span className="zb-mono zb-break">{hash}</span>
            {url === undefined ? null : <a href={url} target="_blank" rel="noreferrer" aria-label="On the chain's explorer"><ExternalLink /></a>}
            <span className="zb-xtag">{described.success ? "success" : "reverted"}</span>
            {described.proof === null ? null : <a className="zb-xtag" href={explore({ kind: "proof", chainId: described.proof.chainId, id: String(described.proof.number) })}>Proof #{described.proof.number}</a>}
          </>
        }
      />
      <div className="zb-col zb-xpage">
        <XGroup title="Details" />
        <KV k="From" href={explore({ kind: "address", id: described.from })}><span className="zb-mono">{shortHex(described.from)}</span></KV>
        {described.to === null ? <KV k="To">contract creation</KV> : <KV k="To" href={described.toName === null ? explore({ kind: "address", id: described.to }) : explore({ kind: "contract", chainId, id: described.to })}>{described.toName ?? ""} <span className="zb-mono">{shortHex(described.to)}</span></KV>}
        <KV k="Function"><span className="zb-mono">{described.functionSignature ?? (described.input === "0x" ? "none (a plain send)" : "not in the deployment's ABIs")}</span></KV>
        <KV k="Gas">{described.gasUsed.toLocaleString("en-US")} · <Num text={amountText(described.gasPriceWei, 9)} /> gwei</KV>
        <KV k="Fee"><TokenIcon subject={{ chainId }} symbol={chain.nativeSymbol} size={16} decorative /> <Num text={amountText(described.feeWei, 18)} /> {chain.nativeSymbol}</KV>
        <KV k="Nonce · position">{described.nonce} · index {described.index}</KV>
        <XGroup title="Where it sits" />
        <StepTrail steps={trail} />
        <XGroup title="Events" right={described.events.length} />
        {described.events.length === 0 ? <p className="zb-small">No events from the deployment's contracts.</p> : null}
        {described.events.map((event, index) => (
          <div key={`${event.name}-${index}`} className="zb-xevent">
            <b>{event.name}</b>
            <DrawerGrid rows={event.args.map(([name, value]) => [name, <span className="zb-mono zb-break">{value.length > 24 ? shortHex(value) : value}</span>] as const)} />
          </div>
        ))}
        <button type="button" className="zb-xraw" aria-expanded={raw} onClick={() => setRaw(!raw)}>
          <Chevron dir={raw ? "down" : "right"} /> Input data ({described.inputBytes.toLocaleString("en-US")} bytes)
        </button>
        {raw ? <pre className="zb-mono zb-xrawtext">{described.input}</pre> : null}
      </div>
    </>
  );
};

/** The address page. */
export const AddressPage = ({ address }: { readonly address: Address }) => {
  const { pair, explore: source, now } = useServices();
  const names = chainNamer(pair);
  const read = useChainReader();
  const chains = [pair.first, pair.second];
  const accounts = useQuery({
    queryKey: ["account", address],
    queryFn: () => Promise.all(chains.map(async (chain) => (read(chain.chainId) === null ? null : await read(chain.chainId)!.account(address)))),
  }).data;
  const proofs = (useQuery({ queryKey: ["explore", "proofs"], queryFn: () => source.proofs() }).data ?? []).filter((proof) => proof.poster.toLowerCase() === address.toLowerCase());
  const feed = useFeed(pair.id, { address }, 100).data?.items ?? [];
  const [tab, setTab] = useState<"transfers" | "proofs">(feed.length === 0 && proofs.length > 0 ? "proofs" : "transfers");
  const roles = new Set<string>();
  for (const chain of chains) for (const [name, value] of Object.entries(chain.contracts)) if (value !== null && value.toLowerCase() === address.toLowerCase()) roles.add(name);
  if (proofs.length > 0) roles.add("proof poster");
  if (accounts?.some((account) => account?.isContract === true)) roles.add("contract");
  else if (accounts !== undefined) roles.add("account");
  const sent = feed.filter((item) => item.sender.toLowerCase() === address.toLowerCase()).length;
  const received = feed.filter((item) => item.recipient.toLowerCase() === address.toLowerCase()).length;
  return (
    <>
      <XBand
        label="Address"
        icon={<Identicon address={address} />}
        big={shortHex(getAddress(address))}
        sub={
          <>
            <span className="zb-mono zb-break">{getAddress(address)}</span>
            {[...roles].map((role) => (
              <span key={role} className="zb-xtag">{role}</span>
            ))}
          </>
        }
      />
      <div className="zb-col zb-xpage">
        <XGroup title="On each chain" />
        {chains.map((chain, index) => {
          const account = accounts?.[index] ?? null;
          const url = explorerUrl(chain.chainId, "address", address);
          return (
            <div key={chain.chainId} className="zb-xrow zb-xrow-static">
              <span className="zb-xrow-icon"><TokenIcon subject={{ chainId: chain.chainId }} symbol={chain.name} size={28} decorative /></span>
              <span className="zb-xrow-text">
                <b>{chain.name}</b>
                <span>{account === null ? "—" : `${account.nonce.toLocaleString("en-US")} transactions sent`}</span>
              </span>
              <span className="zb-xnum">{account === null ? "—" : <><Num text={amountText(account.balance, 18)} /> {chain.nativeSymbol}</>}</span>
              {url === undefined ? null : <a href={url} target="_blank" rel="noreferrer" aria-label={`On ${chain.name}'s explorer`}><ExternalLink /></a>}
            </div>
          );
        })}
        <XGroup title="Through zkb.fi" />
        <KV k="Sent · received">{sent} · {received} transfers</KV>
        <KV k="Proofs posted">{proofs.length}</KV>
        <KV k="Contracts deployed"><Missing why="The indexer does not record deployers" /></KV>
        <KV k="Tips earned"><Missing why="The indexer does not record who delivered" /></KV>
        <div className="zb-tabs" role="tablist" aria-label="What this address did">
          <button type="button" role="tab" aria-selected={tab === "transfers"} onClick={() => setTab("transfers")}>Transfers <span className="zb-count">{feed.length}</span></button>
          <button type="button" role="tab" aria-selected={tab === "proofs"} onClick={() => setTab("proofs")}>Proofs <span className="zb-count">{proofs.length}</span></button>
        </div>
        {tab === "transfers"
          ? feed.length === 0
            ? <p className="zb-small">No transfers.</p>
            : feed.map((item) => {
                const { source: from, destination } = chainsFor(pair, item.direction);
                return (
                  <XRow
                    key={item.id}
                    href={explore({ kind: "tx", chainId: from.chainId, id: item.sourceTransactionHash })}
                    title={item.token === null || item.amount === null ? `Message ${shortHex(item.id)}` : <><Num text={amountText(item.amount, item.token.decimals)} /> {item.token.symbol}</>}
                    sub={<><RouteIcons from={from.chainId} to={destination.chainId} names={names} /> {relativeTime(item.sentAt, now())}</>}
                    status={statusWord(item.status)}
                  />
                );
              })
          : proofs.map((proof) => (
              <XRow
                key={`${proof.chainId}-${proof.number}`}
                href={explore({ kind: "proof", chainId: proof.chainId, id: String(proof.number) })}
                icon={<RouteIcons from={proof.chainId === pair.first.chainId ? pair.second.chainId : pair.first.chainId} to={proof.chainId} names={names} />}
                title={`Proof #${proof.number}`}
                sub={`slot ${proof.slot.toLocaleString("en-US")}`}
                status="posted"
              />
            ))}
        <div className="zb-xactions">
          <a className="zb-pill" href={formatRoute({ name: "bridge", pairId: pair.id, dir: "first-to-second", form: { receiver: getAddress(address) } })}>
            Bridge to this address <Chevron dir="right" />
          </a>
        </div>
      </div>
    </>
  );
};
