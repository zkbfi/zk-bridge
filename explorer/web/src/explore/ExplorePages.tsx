/**
 * Explore's pages: one per kind, every value linking onward. Browse lists one kind; the proof, token, address,
 * transaction, slot, block, contract, gate, release and costs pages follow the same pattern (mockups explore.html and
 * explore-address-tx.html). Real data only: where the indexer or the chain has no value the page shows "—".
 */
import { useQuery } from "@tanstack/react-query";
import { formatRoute, type ExplorePage } from "../app/route";
import { useServices } from "../app/services";
import { TokenIcon } from "../bridge/TokenIcon";
import { chainNamer } from "./ExploreScreen";
import { shortHex, XGroup, XRow } from "./parts";
import { BrowseList } from "./BrowseList";
import { isListKind } from "./browse-model";
import { AddressPage, TransactionPage } from "./TxAddressPages";
import { BlockPage, ContractPage, CostsPage, GatePage, ProofPage, ReleasePage, SlotPage, TokenPage } from "./OtherPages";
import type { Address, Hex } from "viem";

const href = (page: ExplorePage): string => formatRoute({ name: "explore", page });

/** One Explore page. */
export const ExplorePageView = ({ page }: { readonly page: ExplorePage }) => {
  if (page.kind === "browse") return isListKind(page.id) ? <BrowseList kind={page.id} query={page.query} /> : <BrowsePage kind={page.id} />;
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

/** The short lists that never page: the contracts of the pair and the gates. */
const BrowsePage = ({ kind }: { readonly kind: string }) => {
  const { pair, explore } = useServices();
  const names = chainNamer(pair);
  const gates = useQuery({ queryKey: ["explore", "gates"], queryFn: () => explore.gates(), enabled: kind === "gates" }).data ?? [];
  const titles: Record<string, string> = { contracts: "Contracts", gates: "Gates & escrow", releases: "Releases" };
  const rows = (() => {
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
