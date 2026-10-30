/**
 * Explore's pages: one per kind, every value linking onward. Browse lists one kind; the proof, token, address,
 * transaction, slot, block, contract, gate, release and costs pages follow the same pattern (mockups explore.html and
 * explore-address-tx.html). Real data only: where the indexer or the chain has no value the page shows "—".
 */
import { useQuery } from "@tanstack/react-query";
import { formatRoute, type ExplorePage } from "../app/route";
import { useFeed, useTokens } from "../app/queries";
import { useServices } from "../app/services";
import { relativeTime } from "../bridge/activity-model";
import { amountText, chainsFor } from "../bridge/bridge-model";
import { Num } from "../bridge/Num";
import { TokenIcon } from "../bridge/TokenIcon";
import { chainNamer } from "./ExploreScreen";
import { statusWord } from "./explore-model";
import { RouteIcons, shortHex, XGroup, XRow } from "./parts";
import { AddressPage, TransactionPage } from "./TxAddressPages";
import { BlockPage, ContractPage, CostsPage, GatePage, ProofPage, ReleasePage, SlotPage, TokenPage } from "./OtherPages";
import type { Address, Hex } from "viem";

const href = (page: ExplorePage): string => formatRoute({ name: "explore", page });

/** One Explore page. */
export const ExplorePageView = ({ page }: { readonly page: ExplorePage }) => {
  if (page.kind === "browse") return <BrowsePage kind={page.id} />;
  if (page.kind === "tx" && page.chainId !== undefined) return <TransactionPage chainId={page.chainId} hash={page.id.toLowerCase() as Hex} />;
  if (page.kind === "address") return <AddressPage address={page.id as Address} />;
  if (page.kind === "proof" && page.chainId !== undefined) return <ProofPage chainId={page.chainId} number={Number(page.id)} />;
  if (page.kind === "token") return <TokenPage id={page.id} />;
  if (page.kind === "block" && page.chainId !== undefined) return <BlockPage chainId={page.chainId} number={BigInt(page.id)} />;
  if (page.kind === "slot") return <SlotPage slot={BigInt(page.id)} />;
  if (page.kind === "contract" && page.chainId !== undefined) return <ContractPage chainId={page.chainId} address={page.id as Address} />;
  if (page.kind === "gate" && page.chainId !== undefined) return <GatePage chainId={page.chainId} />;
  if (page.kind === "release") return <ReleasePage cid={page.id} />;
  return <CostsPage />;
};

const BrowsePage = ({ kind }: { readonly kind: string }) => {
  const { pair, explore, now } = useServices();
  const names = chainNamer(pair);
  const proofs = useQuery({ queryKey: ["explore", "proofs"], queryFn: () => explore.proofs() }).data ?? [];
  const gates = useQuery({ queryKey: ["explore", "gates"], queryFn: () => explore.gates() }).data ?? [];
  const feed = useFeed(pair.id, {}, 100).data?.items ?? [];
  const tokens = useTokens(pair.id).data ?? [];
  const otherOf = (chainId: number): number => (chainId === pair.first.chainId ? pair.second.chainId : pair.first.chainId);
  const titles: Record<string, string> = { transfers: "Transfers & messages", proofs: "Proofs", tokens: "Tokens", addresses: "Addresses", contracts: "Contracts", gates: "Gates & escrow", releases: "Releases" };
  const rows = (() => {
    if (kind === "proofs") {
      return proofs.map((proof) => (
        <XRow
          key={`${proof.chainId}-${proof.number}`}
          href={href({ kind: "proof", chainId: proof.chainId, id: String(proof.number) })}
          icon={<RouteIcons from={otherOf(proof.chainId)} to={proof.chainId} names={names} />}
          title={`Proof #${proof.number}`}
          sub={`slot ${proof.slot.toLocaleString("en-US")} · ${relativeTime(proof.timestamp, now())}`}
          status="posted"
        />
      ));
    }
    if (kind === "transfers") {
      return feed.map((item) => {
        const { source, destination } = chainsFor(pair, item.direction);
        return (
          <XRow
            key={item.id}
            href={href({ kind: "tx", chainId: source.chainId, id: item.sourceTransactionHash })}
            title={item.token === null || item.amount === null ? `Message ${shortHex(item.id)}` : <><Num text={amountText(item.amount, item.token.decimals)} /> {item.token.symbol}</>}
            sub={<RouteIcons from={source.chainId} to={destination.chainId} names={names} />}
            status={statusWord(item.status)}
          />
        );
      });
    }
    if (kind === "tokens") {
      return tokens.map((token) => {
        const chain = token.side === "first" ? pair.first : pair.second;
        return <XRow key={`${token.side}:${token.address}`} href={href({ kind: "token", id: `${token.side}:${token.address}` })} icon={<TokenIcon subject={{ chainId: chain.chainId, address: token.address }} badgeChainId={chain.chainId} symbol={token.symbol} size={28} decorative />} title={token.symbol} sub={shortHex(token.address)} />;
      });
    }
    if (kind === "addresses") {
      const seen = new Map<string, string>();
      for (const proof of proofs) seen.set(proof.poster.toLowerCase(), "poster");
      for (const item of feed) {
        if (!seen.has(item.sender.toLowerCase())) seen.set(item.sender.toLowerCase(), "sender");
        if (!seen.has(item.recipient.toLowerCase())) seen.set(item.recipient.toLowerCase(), "receiver");
      }
      return [...seen].map(([address, role]) => <XRow key={address} href={href({ kind: "address", id: address })} title={<span className="zb-mono">{shortHex(address)}</span>} sub={role} />);
    }
    if (kind === "contracts") {
      return [pair.first, pair.second].flatMap((chain) =>
        (Object.entries(chain.contracts) as [string, string | null][])
          .filter((entry): entry is [string, string] => entry[1] !== null)
          .map(([name, address]) => <XRow key={`${chain.chainId}-${name}`} href={href({ kind: "contract", chainId: chain.chainId, id: address })} icon={<TokenIcon subject={{ chainId: chain.chainId }} symbol={chain.name} size={28} decorative />} title={name} sub={<span className="zb-mono">{shortHex(address)}</span>} />),
      );
    }
    if (kind === "gates") {
      return gates.map((gate) => <XRow key={gate.chainId} href={href({ kind: "gate", chainId: gate.chainId, id: String(gate.chainId) })} icon={<TokenIcon subject={{ chainId: gate.chainId }} symbol={names(gate.chainId)} size={28} decorative />} title={`Gate on ${names(gate.chainId)}`} sub={<span className="zb-mono">{shortHex(gate.gate)}</span>} status={gate.sealed ? "sealed" : gate.depositsOpen ? "open" : "closed"} />);
    }
    return [];
  })();
  return (
    <div className="zb-col zb-xpage">
      <XGroup title={titles[kind] ?? kind} right={rows.length} />
      {rows.length === 0 ? <p className="zb-small">None yet on this pair.</p> : rows}
    </div>
  );
};
