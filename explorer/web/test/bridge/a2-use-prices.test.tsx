import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { custom } from "viem";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { ServicesProvider, type Services } from "../../src/app/services";
import { buildTestServices } from "../render";

vi.mock("../../src/app/rpc-transport", () => ({
  rpcTransport: () => custom({ request: async ({ method }: { method: string }) => { if (method === "eth_blockNumber") return "0x15f9000"; throw new Error("fetch failed"); } }),
}));
const seen: { source: unknown }[] = [];
vi.mock("@zkb/react", async (importOriginal) => {
  const original = await importOriginal<typeof import("@zkb/react")>();
  return { ...original, usePrices: (input: { source: unknown }) => { seen.push(input); return { data: undefined, states: [], error: null, isError: false, isFetching: false }; } };
});
const { usePrices } = await import("../../src/bridge/use-prices");

type Source = { mode: string; id?: string; poolReader?: () => Promise<{ block: bigint }> } | null;
const latestSource = (services: Services): Source => {
  seen.length = 0;
  const wrapper = ({ children }: { readonly children: ReactNode }) => <ServicesProvider services={services}>{children}</ServicesProvider>;
  renderHook(() => usePrices([]), { wrapper });
  return seen.at(-1)!.source as Source;
};
const withConfiguration = (dataMode: "live" | "fixture", rpcUrls: Record<number, string>, connection: Services["connection"] = null): Services => {
  const base = buildTestServices();
  return { ...base, pair: FIXTURE_PAIR, connection, configuration: { ...base.configuration, dataMode, rpcUrls } as Services["configuration"] };
};

describe("the price source of the dapp", () => {
  it("gives live prices a pool reader over the chosen RPC, pinned at its latest block", async () => {
    const source = latestSource(withConfiguration("live", { 369: "https://configured.example" }));
    expect((await source!.poolReader!()).block).toBe(23_040_000n);
  });

  it("uses the sample prices on a fixture page", () => {
    expect(latestSource(withConfiguration("fixture", {}))).toEqual({ mode: "sample" });
  });

  it("reads live prices over the user's RPC first, then the configuration's, then the default", () => {
    const connection = { resolved: () => ({ rpcUrls: { 369: { value: "https://user.example" } } }) } as unknown as Services["connection"];
    expect(latestSource(withConfiguration("live", { 369: "https://configured.example" }, connection))).toMatchObject({ mode: "live", id: "https://user.example" });
    const withoutUser = { resolved: () => ({ rpcUrls: {} }) } as unknown as Services["connection"];
    expect(latestSource(withConfiguration("live", { 369: "https://configured.example" }, withoutUser))).toMatchObject({ mode: "live", id: "https://configured.example" });
    expect(latestSource(withConfiguration("live", { 369: "https://configured.example" }))).toMatchObject({ id: "https://configured.example" });
    expect(latestSource(withConfiguration("live", {}))).toMatchObject({ mode: "live", id: expect.stringContaining("/369") });
  });
});
