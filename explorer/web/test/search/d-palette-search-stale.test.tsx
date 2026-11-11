import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import type { IndexerClient } from "../../src/data/indexer-client";
import { usePaletteSearch } from "../../src/search/use-palette-search";
import { buildTestServices } from "../render";
import { connectedWallet, walletWrapper } from "../app/support";

const FIRST = `0x${"11".repeat(32)}` as Hex;
const SECOND = `0x${"22".repeat(32)}` as Hex;

describe("usePaletteSearch while the indexer is slow", () => {
  it("drops the answer to a query that was replaced, and keeps waiting for the answer to the current one", async () => {
    const answers = new Map<Hex, (value: null) => void>();
    const base = buildTestServices();
    const indexer: IndexerClient = {
      ...base.indexer,
      message: (id) => new Promise((resolve) => answers.set(id.toLowerCase() as Hex, resolve as (value: null) => void)),
    };
    const wrapper = walletWrapper({ wallet: connectedWallet(), services: { indexer } });
    const { result, rerender } = renderHook(({ query }) => usePaletteSearch({ query, recent: [], walletConnected: false, docPages: [] }), { wrapper, initialProps: { query: FIRST as string } });
    await waitFor(() => expect(answers.has(FIRST)).toBe(true));
    expect(result.current.loading).toBe(true);

    rerender({ query: SECOND });
    await waitFor(() => expect(answers.has(SECOND)).toBe(true));
    // The old answer arrives late: it must not stand in for the answer to the new query.
    await act(async () => {
      answers.get(FIRST)!(null);
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.problem).toBeNull();

    await act(async () => {
      answers.get(SECOND)!(null);
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.problem).toBe("The indexer knows no message with this identifier or transaction hash.");
  });
});
