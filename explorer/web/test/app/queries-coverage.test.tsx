import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_ACCOUNT, FIXTURE_PAIR } from "@terminal/data/fixtures";
import { useSnapshots } from "../../src/app/queries";
import { ServicesProvider, type Services } from "../../src/app/services";
import { buildTestServices } from "../render";

const setup = (overrides: Partial<Services>) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity, refetchInterval: false } } });
  const services: Services = { ...buildTestServices(), ...overrides };
  const wrapper = ({ children }: { readonly children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <ServicesProvider services={services}>{children}</ServicesProvider>
    </QueryClientProvider>
  );
  return { client, wrapper, services };
};

describe("useSnapshots", () => {
  it("waits for the tokens, then reads both chains for the account with those tokens", async () => {
    const base = buildTestServices();
    const readSnapshots = vi.fn(base.chainAccess.readSnapshots);
    const { wrapper } = setup({ chainAccess: { ...base.chainAccess, readSnapshots } });
    const { result } = renderHook(() => useSnapshots(FIXTURE_ACCOUNT, FIXTURE_PAIR.id), { wrapper });
    expect(readSnapshots).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.data).toBeDefined());
    const tokens = await base.dataSource.listTokens(FIXTURE_PAIR.id);
    expect(readSnapshots).toHaveBeenCalledWith({ account: FIXTURE_ACCOUNT, tokens });
  });

  it("does not read without an account", async () => {
    const base = buildTestServices();
    const readSnapshots = vi.fn(base.chainAccess.readSnapshots);
    const { wrapper } = setup({ chainAccess: { ...base.chainAccess, readSnapshots } });
    const { result } = renderHook(() => useSnapshots(null, FIXTURE_PAIR.id), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe("idle"));
    expect(readSnapshots).not.toHaveBeenCalled();
  });

  it("reads with an empty token list when a read is forced before the tokens arrive", async () => {
    const base = buildTestServices();
    const readSnapshots = vi.fn(base.chainAccess.readSnapshots);
    const { client, wrapper } = setup({
      dataSource: { ...base.dataSource, listTokens: () => new Promise(() => undefined) },
      chainAccess: { ...base.chainAccess, readSnapshots },
    });
    renderHook(() => useSnapshots(FIXTURE_ACCOUNT, FIXTURE_PAIR.id), { wrapper });
    const query = client.getQueryCache().find({ queryKey: ["snapshots"], exact: false });
    expect(query).toBeDefined();
    await query?.fetch();
    expect(readSnapshots).toHaveBeenCalledWith({ account: FIXTURE_ACCOUNT, tokens: [] });
  });
});
