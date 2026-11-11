import { describe, expect, it } from "vitest";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { parseProofs } from "../../src/explore/explore-source";
import { searchExplore, type SearchData } from "../../src/explore/search";
import { RECORDED_HEAD_UPDATES } from "./recorded";

const pair: PairConfig = FIXTURE_PAIR;
const sourceHash = `0x${"aa".repeat(32)}`;
const deliveredHash = `0x${"bb".repeat(32)}`;
const feedItem = (over: Partial<FeedItem>): FeedItem => ({
  id: `0x${"cc".repeat(32)}`,
  kind: "token",
  direction: "first-to-second",
  status: "covered",
  sender: "0x0000000000000000000000000000000000000001",
  recipient: "0x0000000000000000000000000000000000000002",
  token: null,
  amount: null,
  sentAt: 1,
  deliveredAt: null,
  sourceTransactionHash: sourceHash as FeedItem["sourceTransactionHash"],
  destinationTransactionHash: null,
  ...over,
});
const proofs = parseProofs(RECORDED_HEAD_UPDATES);
const data = (feed: readonly FeedItem[]): SearchData => ({ pair, proofs, tokens: [{ address: "0x0000000000000000000000000000000000002002", symbol: "WBTC", decimals: 8, side: "second", counterpart: null }], feed });

describe("the search over transfers and the second chain", () => {
  it("finds a transfer by the hash of its sending or delivering transaction, on the chain where each happened", () => {
    const out = feedItem({ destinationTransactionHash: deliveredHash as FeedItem["sourceTransactionHash"] });
    const back = feedItem({ id: `0x${"dd".repeat(32)}`, direction: "second-to-first", sourceTransactionHash: `0x${"ee".repeat(32)}` });
    const sent = searchExplore(sourceHash, data([out, back]));
    expect(sent[0]!.items).toMatchObject([{ title: "Transfer sent", href: `#/explore/tx/${pair.first.chainId}/${sourceHash}`, chains: [pair.first.chainId] }]);
    const delivered = searchExplore(deliveredHash, data([out]));
    expect(delivered[0]!.items).toMatchObject([{ title: "Transfer delivered", href: `#/explore/tx/${pair.second.chainId}/${deliveredHash}`, chains: [pair.second.chainId] }]);
    const fromSecond = searchExplore(`0x${"ee".repeat(32)}`, data([back]));
    expect(fromSecond[0]!.items[0]).toMatchObject({ title: "Transfer sent", chains: [pair.second.chainId] });
  });

  it("finds a message by its id and does not offer a guessed transaction for it", () => {
    const message = feedItem({});
    const groups = searchExplore(message.id, data([message]));
    expect(groups.map((group) => group.title)).toEqual(["Messages"]);
    expect(groups[0]!.items[0]).toMatchObject({ sub: "covered", href: `#/message/${message.id}` });
  });

  it("names a proof's two chains whichever chain posted it, and a token's chain by its side", () => {
    const posted = { ...RECORDED_HEAD_UPDATES.items[0]!, chainId: pair.second.chainId };
    const secondProofs = parseProofs({ items: [posted] });
    const groups = searchExplore(String(secondProofs[0]!.slot), { ...data([]), proofs: secondProofs });
    expect(groups.find((group) => group.title === "Proofs")!.items[0]!.chains).toEqual([pair.first.chainId, pair.second.chainId]);
    const token = searchExplore("wbtc", data([]))[0]!.items[0]!;
    expect(token).toMatchObject({ title: "WBTC", sub: pair.second.name, match: "WBTC", chains: [pair.second.chainId], href: "#/explore/token/second/0x0000000000000000000000000000000000002002" });
    expect(searchExplore("0x0000000000000000000000000000000000002002", data([])).find((group) => group.title === "Tokens")!.items[0]!.chains).toEqual([pair.second.chainId]);
  });

  it("takes a release CID to its page", () => {
    const cid = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    expect(searchExplore(cid, data([]))).toEqual([{ title: "Releases", items: [{ title: "Release", sub: "bafybeigdy…bzdi", href: `#/explore/release/${cid}`, match: null, chains: [] }] }]);
  });

  it("finds nothing for text it does not recognise", () => {
    expect(searchExplore("hello world!", data([]))).toEqual([]);
  });

  it("finds a proof by the block of its posting transaction or by its own number, and names the other chain of a proof posted on the first", () => {
    const posted = { ...RECORDED_HEAD_UPDATES.items[0]!, chainId: pair.first.chainId, blockNumber: 4242, slot: 9000, executionBlockNumber: 8000 };
    const own = parseProofs({ items: [posted] });
    const byBlock = searchExplore("4242", { ...data([]), proofs: own });
    expect(byBlock.find((group) => group.title === "Proofs")!.items[0]).toMatchObject({ title: "Proof #1", chains: [pair.second.chainId, pair.first.chainId] });
    const byNumber = searchExplore("1", { ...data([]), proofs: own });
    expect(byNumber.find((group) => group.title === "Proofs")!.items).toHaveLength(1);
    expect(searchExplore("7777", { ...data([]), proofs: own }).find((group) => group.title === "Proofs")).toBeUndefined();
  });
});
