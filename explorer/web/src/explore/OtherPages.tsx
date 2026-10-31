/**
 * Explore's other pages in the same pattern (mockup explore.html): proof, token, block, slot, contract, gate, release
 * and costs. Every value links onward; a value neither the indexer nor the chain gives shows "—" with the reason on
 * hover.
 */
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { ChainConfig, PairConfig, TokenInfo } from "@terminal/model/types";
import { formatRoute, type ExplorePage } from "../app/route";
import { useAudit, useDeliveryCost, useFeed, useTokens } from "../app/queries";
import { useServices } from "../app/services";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor, nativeTokensOf } from "../bridge/bridge-model";
import { PROOF_COST_USD as PROOF_COST } from "@zk-bridge/shared";

const PROOF_COST_USD = Number(PROOF_COST) / 1e18;
import { ExternalLink } from "../bridge/icons";
import { iconSubjectOf } from "../bridge/image-source";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { explorerUrl, useChainReader } from "./chain-reader";
import { chainNamer } from "./ExploreScreen";
import { statusWord } from "./explore-model";
import { KV, RouteIcons, shortHex, XBand, XGroup, XRow } from "./parts";
import { CONTRACT_NAMES, type ContractKey } from "./contract-names";
import { SLOTS_PER_PERIOD } from "./tx-model";

const explore = (page: ExplorePage): string => formatRoute({ name: "explore", page });
const chainOf = (pair: PairConfig, chainId: number): ChainConfig => (pair.first.chainId === chainId ? pair.first : pair.second);
const otherOf = (pair: PairConfig, chainId: number): ChainConfig => (pair.first.chainId === chainId ? pair.second : pair.first);
const Missing = ({ why }: { readonly why: string }) => <span title={why}>—</span>;
const External = ({ url, label }: { readonly url: string | undefined; readonly label: string }) =>
  url === undefined ? null : (
    <a href={url} target="_blank" rel="noreferrer" aria-label={label}>
      <ExternalLink />
    </a>
  );

const useProofs = () => {
  const { explore: source } = useServices();
  return useQuery({ queryKey: ["explore", "proofs"], queryFn: () => source.proofs() }).data ?? [];
};

/** A proof: what it proves, the committee, the posting transaction, the verifier, gas and cost, its neighbours. */
export const ProofPage = ({ chainId, number }: { readonly chainId: number; readonly number: number }) => {
  const { pair } = useServices();
  const names = chainNamer(pair);
  const proofs = useProofs();
  const proof = proofs.find((row) => row.chainId === chainId && row.number === number);
  const holder = chainOf(pair, chainId);
  const tracked = otherOf(pair, chainId);
  const reader = useChainReader()(chainId);
  const verifier = useQuery({ queryKey: ["verifier", chainId], enabled: reader !== null, queryFn: () => reader!.verifier(holder.contracts.lightClient) }).data;
  const label = (
    <>
      Light-client update <RouteIcons from={tracked.chainId} to={holder.chainId} names={names} surface="accent" />
    </>
  );
  if (proof === undefined) return <XBand label={label} big={`Proof #${number}`} sub={proofs.length === 0 ? "Reading…" : "The indexer has no such proof."} />;
  const previous = proofs.find((row) => row.chainId === chainId && row.number === number - 1);
  const next = proofs.find((row) => row.chainId === chainId && row.number === number + 1);
  return (
    <>
      <XBand label={label} big={`Proof #${number}`} sub={`slot ${proof.slot.toLocaleString("en-US")}`} />
      <div className="zb-col zb-xpage">
        <KV k="Finalized slot" href={explore({ kind: "slot", id: proof.slot.toString() })}>{proof.slot.toLocaleString("en-US")}</KV>
        <KV k="Execution block" href={explore({ kind: "block", chainId: tracked.chainId, id: proof.executionBlockNumber.toString() })}>{proof.executionBlockNumber.toLocaleString("en-US")}</KV>
        <KV k="Sync committee">period {(proof.slot / SLOTS_PER_PERIOD).toLocaleString("en-US")} · <Missing why="The indexer does not record which of the 512 seats signed" /> signed</KV>
        <KV k="Header root"><span className="zb-mono">{shortHex(proof.headerRoot)}</span></KV>
        <KV k="Posted in" href={explore({ kind: "tx", chainId, id: proof.transactionHash })}><span className="zb-mono">{shortHex(proof.transactionHash)}</span></KV>
        <KV k="Posted by" href={explore({ kind: "address", id: proof.poster })}><span className="zb-mono">{shortHex(proof.poster)}</span></KV>
        {verifier === undefined ? <KV k="Verifier"><Missing why="Read from the light client on the chain" /></KV> : <KV k="Verifier" href={explore({ kind: "contract", chainId, id: verifier })}><span className="zb-mono">{shortHex(verifier)}</span></KV>}
        <KV k="Proving time"><Missing why="The prover does not publish its timings" /></KV>
        <KV k="Gas">{proof.gasUsed.toLocaleString("en-US")}</KV>
        <KV k="Cost"><Num text={amountText(proof.costWei, 18)} /> {holder.nativeSymbol}</KV>
        <KV k="Proof generation">${PROOF_COST_USD} (assumed)</KV>
        <KV k="Posted">{relativeTime(proof.timestamp, Math.floor(Date.now() / 1000))}</KV>
        <KV k="Previous" {...(previous === undefined ? {} : { href: explore({ kind: "proof", chainId, id: String(previous.number) }) })}>{previous === undefined ? "none" : `Proof #${previous.number}`}</KV>
        <KV k="Next" {...(next === undefined ? {} : { href: explore({ kind: "proof", chainId, id: String(next.number) }) })}>{next === undefined ? "waiting" : `Proof #${next.number}`}</KV>
        <XGroup title="Transfers it proved" />
        <p className="zb-small" title="The indexer does not link transfers to the proof that covered them">—</p>
      </div>
    </>
  );
};

/** A token: both addresses, escrowed against minted, volume, its transfers. */
export const TokenPage = ({ id }: { readonly id: string }) => {
  const { pair, now } = useServices();
  const names = chainNamer(pair);
  const tokens = [...(useTokens(pair.id).data ?? []), ...nativeTokensOf(pair)];
  const [side, address] = id.split(":") as ["first" | "second", Address];
  const token: TokenInfo | undefined = tokens.find((candidate) => candidate.side === side && candidate.address.toLowerCase() === address.toLowerCase());
  const audit = useAudit(pair.id).data ?? [];
  const feed = (useFeed(pair.id, {}, 100).data?.items ?? []).filter((item) => item.token !== null && token !== undefined && (item.token.address.toLowerCase() === token.address.toLowerCase() || item.token.address.toLowerCase() === token.counterpart?.toLowerCase()));
  const home = chainOf(pair, side === "first" ? pair.first.chainId : pair.second.chainId);
  if (token === undefined) return <XBand label={home.name} big={shortHex(address)} sub="This pair has no such token." />;
  const other = otherOf(pair, home.chainId);
  const row = audit.find((entry) => entry.token.address.toLowerCase() === token.address.toLowerCase() || entry.token.address.toLowerCase() === token.counterpart?.toLowerCase());
  const day = feed.filter((item) => item.sentAt >= now() - 86_400);
  const volume = day.reduce((sum, item) => sum + (item.amount ?? 0n), 0n);
  return (
    <>
      <XBand label={home.name} big={token.symbol} icon={<TokenIcon subject={iconSubjectOf(token, pair)} badgeChainId={home.chainId} symbol={token.symbol} size={44} surface="accent" />} />
      <div className="zb-col zb-xpage">
        <KV k={`On ${home.name}`} href={explore({ kind: "contract", chainId: home.chainId, id: token.address })}><span className="zb-mono">{token.address === "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" ? "native coin" : shortHex(token.address)}</span></KV>
        {token.counterpart === null ? <KV k={`On ${other.name}`}><Missing why="Not bridged yet; the first transfer deploys it" /></KV> : <KV k={`On ${other.name}`} href={explore({ kind: "token", id: `${side === "first" ? "second" : "first"}:${token.counterpart}` })}><span className="zb-mono">{shortHex(token.counterpart)}</span></KV>}
        <KV k="Escrowed">{row === undefined ? <Missing why="The indexer has no escrow for this token" /> : <><Num text={amountText(row.escrow, token.decimals)} /> {token.symbol}</>}</KV>
        <KV k={`Supply on ${other.name}`}>{row === undefined ? <Missing why="The indexer has no supply for this token" /> : <><Num text={amountText(row.bridgedSupply, token.decimals)} /> {row.bridgedSupply === row.escrow ? "· matches" : "· differs"}</>}</KV>
        <KV k="Volume, 24 h">{day.length === 0 ? "none" : <><Num text={amountText(volume, token.decimals)} /> {token.symbol} · {day.length} transfers</>}</KV>
        <KV k="Gate cap"><Missing why="The gate has no per-token cap the indexer reports" /></KV>
        <XGroup title="Latest transfers" right={feed.length} />
        {feed.length === 0 ? <p className="zb-small">No transfers of this token yet.</p> : null}
        {feed.slice(0, 20).map((item) => {
          const { source, destination } = chainsFor(pair, item.direction);
          return <XRow key={item.id} href={explore({ kind: "tx", chainId: source.chainId, id: item.sourceTransactionHash })} title={<><Num text={amountText(item.amount ?? 0n, token.decimals)} /> {item.token?.symbol}</>} sub={<RouteIcons from={source.chainId} to={destination.chainId} names={names} />} status={statusWord(item.status)} />;
        })}
      </div>
    </>
  );
};

/** A block on one chain: hash, time, transactions and gas, and the proofs that refer to it. */
export const BlockPage = ({ chainId, number }: { readonly chainId: number; readonly number: bigint }) => {
  const { pair } = useServices();
  const chain = chainOf(pair, chainId);
  const reader = useChainReader()(chainId);
  const block = useQuery({ queryKey: ["block", chainId, number.toString()], enabled: reader !== null, queryFn: () => reader!.block(number), retry: 1 });
  const proofs = useProofs().filter((proof) => (proof.chainId === chainId && proof.blockNumber === number) || (proof.chainId !== chainId && proof.executionBlockNumber === number));
  const data = block.data as (Awaited<ReturnType<NonNullable<typeof reader>["block"]>> & { readonly transactions?: readonly unknown[] }) | undefined;
  return (
    <>
      <XBand label={chain.name} big={`Block ${number.toLocaleString("en-US")}`} sub={<External url={explorerUrl(chainId, "block", number.toString())} label="On the chain's explorer" />} />
      <div className="zb-col zb-xpage">
        <KV k="Hash">{data === undefined ? <Missing why={block.isError ? "The chain has no such block yet" : "Read from the chain"} /> : <span className="zb-mono">{shortHex(data.hash ?? "")}</span>}</KV>
        <KV k="Time">{data === undefined ? <Missing why="Read from the chain" /> : new Date(Number(data.timestamp) * 1000).toLocaleString("en-GB")}</KV>
        <KV k="Transactions">{data?.transactions === undefined ? <Missing why="Read from the chain" /> : data.transactions.length}</KV>
        <KV k="Gas used">{data === undefined ? <Missing why="Read from the chain" /> : data.gasUsed.toLocaleString("en-US")}</KV>
        <KV k="Base fee">{data?.baseFeePerGas == null ? <Missing why="Read from the chain" /> : <><Num text={amountText(data.baseFeePerGas, 9)} /> gwei</>}</KV>
        <KV k="Previous" href={explore({ kind: "block", chainId, id: (number - 1n).toString() })}>{(number - 1n).toLocaleString("en-US")}</KV>
        <KV k="Next" href={explore({ kind: "block", chainId, id: (number + 1n).toString() })}>{(number + 1n).toLocaleString("en-US")}</KV>
        <XGroup title="Proofs that refer to it" right={proofs.length} />
        {proofs.length === 0 ? <p className="zb-small">None.</p> : null}
        {proofs.map((proof) => (
          <XRow key={`${proof.chainId}-${proof.number}`} href={explore({ kind: "proof", chainId: proof.chainId, id: String(proof.number) })} title={`Proof #${proof.number}`} sub={proof.chainId === chainId ? "posted in this block" : "proves this block final"} status="posted" />
        ))}
      </div>
    </>
  );
};

/** A beacon slot: its sync-committee period and the proofs that finalized it. */
export const SlotPage = ({ slot }: { readonly slot: bigint }) => {
  const { pair } = useServices();
  const names = chainNamer(pair);
  const proofs = useProofs().filter((proof) => proof.slot === slot);
  return (
    <>
      <XBand label="Beacon chain" big={`Slot ${slot.toLocaleString("en-US")}`} sub={`sync committee period ${(slot / SLOTS_PER_PERIOD).toLocaleString("en-US")}`} />
      <div className="zb-col zb-xpage">
        <KV k="Previous" href={explore({ kind: "slot", id: (slot - 1n).toString() })}>{(slot - 1n).toLocaleString("en-US")}</KV>
        <KV k="Next" href={explore({ kind: "slot", id: (slot + 1n).toString() })}>{(slot + 1n).toLocaleString("en-US")}</KV>
        <XGroup title="Proofs of this slot" right={proofs.length} />
        {proofs.length === 0 ? <p className="zb-small">No light client has stored this slot.</p> : null}
        {proofs.map((proof) => (
          <XRow key={`${proof.chainId}-${proof.number}`} href={explore({ kind: "proof", chainId: proof.chainId, id: String(proof.number) })} icon={<RouteIcons from={otherOf(pair, proof.chainId).chainId} to={proof.chainId} names={names} />} title={`Proof #${proof.number}`} sub={`execution block ${proof.executionBlockNumber.toLocaleString("en-US")}`} status="posted" />
        ))}
      </div>
    </>
  );
};

/** A contract: which one of the deployment it is, its balance, and what leads on from it. */
export const ContractPage = ({ chainId, address }: { readonly chainId: number; readonly address: Address }) => {
  const { pair } = useServices();
  const chain = chainOf(pair, chainId);
  const key = Object.entries(chain.contracts).find(([, value]) => value?.toLowerCase() === address.toLowerCase())?.[0];
  const reader = useChainReader()(chainId);
  const account = useQuery({ queryKey: ["account", chainId, address], enabled: reader !== null, queryFn: () => reader!.account(address) }).data;
  const proofs = useProofs().filter((proof) => proof.chainId === chainId);
  return (
    <>
      <XBand label={chain.name} big={key === undefined ? "Contract" : (CONTRACT_NAMES[key as ContractKey] ?? key)} sub={<><span className="zb-mono zb-break">{address}</span><External url={explorerUrl(chainId, "address", address)} label="On the chain's explorer" /></>} />
      <div className="zb-col zb-xpage">
        <KV k="Part of">{key === undefined ? "not this deployment" : "this deployment"}</KV>
        <KV k="Code">{account === undefined ? <Missing why="Read from the chain" /> : account.isContract ? "deployed" : "none (an account)"}</KV>
        <KV k="Balance">{account === undefined ? <Missing why="Read from the chain" /> : <><Num text={amountText(account.balance, 18)} /> {chain.nativeSymbol}</>}</KV>
        <KV k="As an address" href={explore({ kind: "address", id: address })}><span className="zb-mono">{shortHex(address)}</span></KV>
        {key === "gate" ? <KV k="Gate state" href={explore({ kind: "gate", chainId, id: String(chainId) })}>open the gate</KV> : null}
        {key === "lightClient" ? (
          <>
            <XGroup title="Proofs posted to it" right={proofs.length} />
            {proofs.map((proof) => <XRow key={proof.number} href={explore({ kind: "proof", chainId, id: String(proof.number) })} title={`Proof #${proof.number}`} sub={`slot ${proof.slot.toLocaleString("en-US")}`} status="posted" />)}
          </>
        ) : null}
      </div>
    </>
  );
};

/** A deposit gate: whether it enforces, is sealed, and deposits are open. */
export const GatePage = ({ chainId }: { readonly chainId: number }) => {
  const { pair, explore: source } = useServices();
  const chain = chainOf(pair, chainId);
  const gate = (useQuery({ queryKey: ["explore", "gates"], queryFn: () => source.gates() }).data ?? []).find((row) => row.chainId === chainId);
  const state = gate === undefined ? "—" : gate.sealed ? "sealed" : gate.depositsOpen ? "open" : "closed";
  return (
    <>
      <XBand label={chain.name} big={`Gate · ${state}`} />
      <div className="zb-col zb-xpage">
        {gate === undefined ? <p className="zb-small">Reading…</p> : (
          <>
            <KV k="Contract" href={explore({ kind: "contract", chainId, id: gate.gate })}><span className="zb-mono">{shortHex(gate.gate)}</span></KV>
            <KV k="Enforcing">{gate.enforcing ? "yes" : "no"}</KV>
            <KV k="Deposits">{gate.depositsOpen ? "open" : "closed"}</KV>
            <KV k="Sealed">{gate.sealed ? "yes" : "no"}</KV>
            <KV k="Confirmations">{gate.confirmations}</KV>
            <KV k="Last confirmed">{gate.lastConfirmedTimestamp === null ? "never" : new Date(gate.lastConfirmedTimestamp * 1000).toLocaleString("en-GB")}</KV>
            <KV k="Escrow" href={explore({ kind: "browse", id: "tokens" })}>by token</KV>
          </>
        )}
      </div>
    </>
  );
};

/** A release by its CID. */
export const ReleasePage = ({ cid }: { readonly cid: string }) => {
  const { explore: source } = useServices();
  const counts = useQuery({ queryKey: ["explore", "counts"], queryFn: () => source.counts() }).data;
  return (
    <>
      <XBand label="Release" big={shortHex(cid)} sub={<><span className="zb-mono zb-break">{cid}</span><External url={`https://ipfs.io/ipfs/${cid}`} label="On an IPFS gateway" /></>} />
      <div className="zb-col zb-xpage">
        <KV k="Signed">{counts === undefined ? <Missing why="Read from the indexer" /> : counts.releases === 0 ? <Missing why="The indexer has no release events" /> : "see release events"}</KV>
        <KV k="Version"><Missing why="The indexer has no release events" /></KV>
      </div>
    </>
  );
};

const DeliveryCostLine = ({ chain }: { readonly chain: ChainConfig }) => {
  const report = useDeliveryCost(chain.chainId, { enabled: true }).data;
  const token = report?.kinds.token;
  return (
    <>
      <KV k={`Base fee on ${chain.name}`}>{report === undefined || report.baseFee.wei === null ? <Missing why="Read from the indexer" /> : <><Num text={amountText(BigInt(report.baseFee.wei!), 9)} /> gwei</>}</KV>
      <KV k={`Delivery gas on ${chain.name}`}>{token === undefined ? <Missing why="Read from the indexer" /> : `${(token.p90Gas ?? token.defaultGas).toString()}${token.isDefault ? " (default)" : ` (p90 of ${token.sampleCount})`}`}</KV>
    </>
  );
};

/** What the bridge costs: the light clients' updates per chain, delivery per chain, and the proof. */
export const CostsPage = () => {
  const { pair, explore: source } = useServices();
  const costs = useQuery({ queryKey: ["explore", "costs"], queryFn: () => source.lightClientCosts() }).data ?? [];
  return (
    <>
      <XBand label="Costs" big="What the bridge spends" />
      <div className="zb-col zb-xpage">
        <XGroup title="Light-client updates" />
        {costs.length === 0 ? <p className="zb-small">None posted yet.</p> : null}
        {costs.map((row) => {
          const chain = chainOf(pair, row.chainId);
          return (
            <div key={row.chainId}>
              <KV k={`On ${chain.name}`} href={explore({ kind: "browse", id: "proofs" })}>{row.updates} updates</KV>
              <KV k="Gas">{row.gasUsed.toLocaleString("en-US")}</KV>
              <KV k="Cost"><Num text={amountText(row.costWei, 18)} /> {chain.nativeSymbol} · <Num text={amountText(row.updates === 0 ? 0n : row.costWei / BigInt(row.updates), 18)} /> per update</KV>
            </div>
          );
        })}
        <XGroup title="Delivery" />
        <DeliveryCostLine chain={pair.first} />
        <DeliveryCostLine chain={pair.second} />
        <XGroup title="Proof generation" />
        <KV k="Per proof">${PROOF_COST_USD} (assumed)</KV>
      </div>
    </>
  );
};
