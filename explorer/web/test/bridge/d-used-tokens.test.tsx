import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { useUsedTokens } from "../../src/app/queries";
import { buildTestServices } from "../render";
import { connectedWallet, walletWrapper } from "../app/support";

const ACCOUNT = "0x52908400098527886E0F7030069857D2E4169EE7";

const usedWith = async (tokens: readonly object[]) => {
  const base = buildTestServices();
  const getFeed = async () => ({ items: tokens.map((token) => ({ token })), hasMore: false }) as unknown as Awaited<ReturnType<typeof base.dataSource.getFeed>>;
  const { result } = renderHook(() => useUsedTokens(ACCOUNT, FIXTURE_PAIR.id), {
    wrapper: walletWrapper({ wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed } } }),
  });
  await waitFor(() => expect(result.current.data).toBeDefined());
  return [...result.current.data!];
};

describe("tokens used before, by side", () => {
  it("puts the counterpart of a token of the second side on the first side, in lower case", async () => {
    const used = await usedWith([{ address: "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa", side: "second", counterpart: "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb" }]);
    expect(used).toEqual(["second:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "first:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"]);
  });

  it("holds only the token itself when it has no counterpart", async () => {
    const used = await usedWith([{ address: "0x1111111111111111111111111111111111111111", side: "first", counterpart: null }]);
    expect(used).toEqual(["first:0x1111111111111111111111111111111111111111"]);
  });
});
