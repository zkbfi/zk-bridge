import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { useUsedTokens } from "../../src/app/queries";
import { buildTestServices } from "../render";
import { connectedWallet, walletWrapper } from "../app/support";

const ACCOUNT = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("tokens used or bridged before", () => {
  it("come from the feed filtered by the wallet, with both the token and its counterpart", async () => {
    const base = buildTestServices();
    const token = { address: "0x1111111111111111111111111111111111111111", symbol: "USDC", decimals: 6, side: "first", counterpart: "0x2222222222222222222222222222222222222222" } as const;
    const getFeed = vi.fn(async () => ({ items: [{ token }, { token: null }], hasMore: false }) as unknown as Awaited<ReturnType<typeof base.dataSource.getFeed>>);
    const { result } = renderHook(() => useUsedTokens(ACCOUNT, FIXTURE_PAIR.id), {
      wrapper: walletWrapper({ wallet: connectedWallet(), services: { dataSource: { ...base.dataSource, getFeed } } }),
    });
    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(getFeed).toHaveBeenCalledWith(FIXTURE_PAIR.id, { address: ACCOUNT, kind: "token" }, 200);
    expect([...result.current.data!]).toEqual(["first:0x1111111111111111111111111111111111111111", "second:0x2222222222222222222222222222222222222222"]);
  });
});
