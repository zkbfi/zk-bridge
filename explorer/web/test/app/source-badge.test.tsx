import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Shell } from "../../src/app/Shell";
import { SourceBadgeView } from "../../src/app/SourceBadge";
import { renderPage } from "../render";
import { fallbackStatus, liveServices } from "../support/live";
import { disconnectedWallet, walletWrapper } from "./support";

beforeEach(() => {
  window.location.hash = "#/settings";
  window.localStorage.clear();
});

const renderLiveShell = () => {
  const services = liveServices();
  render(<Shell />, { wrapper: walletWrapper({ wallet: disconnectedWallet(), services }) });
  return services;
};

describe("the source badge in the top bar", () => {
  it("says indexer in a neutral tone while the indexer answers", () => {
    renderLiveShell();
    const badge = screen.getByLabelText("Data source: indexer");
    expect(badge).toHaveTextContent("indexer");
    expect(badge.className).not.toBe("");
  });

  it("changes to the fallback text with its reason when the status changes, and back", async () => {
    const services = renderLiveShell();
    act(() => services.fake.setStatus(fallbackStatus("indexer unreachable")));
    const badge = await screen.findByLabelText("Data source: RPC fallback: indexer unreachable");
    expect(badge).toHaveTextContent("RPC fallback: indexer unreachable");
    expect(badge).toHaveAttribute("title", "RPC fallback: indexer unreachable");
    act(() => services.fake.setStatus({ kind: "indexer", reason: null, label: "indexer" }));
    expect(await screen.findByLabelText("Data source: indexer")).toBeInTheDocument();
  });

  it("uses a different tone for a fallback than for the indexer, so colour is not the only sign", async () => {
    const services = renderLiveShell();
    const before = screen.getByLabelText("Data source: indexer").className;
    act(() => services.fake.setStatus(fallbackStatus("indexer unreachable")));
    const after = (await screen.findByLabelText(/^Data source: RPC fallback/)).className;
    expect(after).not.toBe(before);
  });

  it("removes a URL from the reason before it shows", async () => {
    const services = renderLiveShell();
    act(() => services.fake.setStatus(fallbackStatus("could not reach http://localhost:42069")));
    const badge = await screen.findByLabelText(/^Data source: RPC fallback/);
    expect(badge.textContent).not.toContain("localhost:42069");
  });

  it("follows the runtime after a change of settings", async () => {
    const services = renderLiveShell();
    act(() => services.connection?.apply({ indexerUrl: "https://new.example.org", rpcUrls: {} }));
    expect(screen.getByLabelText("Data source: indexer")).toBeInTheDocument();
  });

  it("shows no badge on a fixture page", () => {
    window.location.hash = "";
    renderPage(<Shell />, { connected: false });
    expect(screen.queryByLabelText(/^Data source:/)).toBeNull();
    expect(screen.getByText(/Sample data\./)).toBeInTheDocument();
  });
});

describe("SourceBadgeView", () => {
  it("renders the label of the runtime that it gets", () => {
    const services = liveServices();
    render(<SourceBadgeView runtime={services.connection!} />, { wrapper: walletWrapper({ wallet: disconnectedWallet(), services }) });
    expect(screen.getByLabelText("Data source: indexer")).toBeInTheDocument();
  });
});
