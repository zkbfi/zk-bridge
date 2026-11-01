import { StatefulPairView } from "../support/stateful";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { renderPage } from "../render";

const rows = (): HTMLElement[] => within(screen.getByRole("table", { name: "Transfers and messages" })).getAllByRole("row").slice(1);

const loaded = async () => {
  await screen.findByRole("table", { name: "Transfers and messages" });
  await waitFor(() => expect(rows().length).toBeGreaterThan(5));
};

describe("the feed and its filter bar", () => {
  it("lists the newest send first, with the time on each chain and the status in words", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    const first = rows()[0]!;
    // One time on the source chain and one on the destination chain, each named by its chain.
    const chains = within(first).getAllByText(/^on (Ethereum|PulseChain)$/);
    expect(chains).toHaveLength(2);
    expect(new Set(chains.map((chain) => chain.textContent)).size).toBe(2);
    expect(first.querySelectorAll("time").length).toBeGreaterThanOrEqual(1);
    expect(within(first).getByText(/^(Sent|Waiting for finality|Covered|Delivered|Release failed)$/)).toBeInTheDocument();
  });

  it("keeps the filter bar visible with a label on every control", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    const bar = screen.getByRole("search", { name: "Feed filters" });
    for (const label of ["Direction", "Kind", "Status", "Token", "Address", "Time range"]) expect(within(bar).getByLabelText(label)).toBeInTheDocument();
  });

  it("filters by status and shows only that status", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "release_failed");
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
    await waitFor(() => {
      for (const row of rows()) expect(within(row).getByText("Release failed")).toBeInTheDocument();
    });
  });

  it("filters by kind: messages carry no token amount", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "message");
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(0);
      for (const row of rows()) expect(within(row).getByText(/^Message to/)).toBeInTheDocument();
    });
  });

  it("filters by direction, with the chain names in the options", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    await userEvent.selectOptions(screen.getByLabelText("Direction"), "second-to-first");
    await waitFor(() => {
      for (const row of rows()) expect(within(row).getByText("PLS to ETH")).toBeInTheDocument();
    });
  });

  it("filters by token", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    const usdc = FIXTURE_TOKENS[0]!;
    await userEvent.selectOptions(screen.getByLabelText("Token"), usdc.address);
    await waitFor(() => {
      expect(rows().length).toBeGreaterThan(0);
      for (const row of rows()) expect(within(row).getByText(/USDC$/)).toBeInTheDocument();
    });
  });

  it("opens with the feed filtered to the token that the palette passed in", async () => {
    const weth = FIXTURE_TOKENS[2]!;
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={weth.address} />);
    await screen.findByRole("table", { name: "Transfers and messages" });
    expect(screen.getByLabelText("Token")).toHaveValue(weth.address);
  });

  it("does not filter by an address that is still being typed, and says so", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    const before = rows().length;
    await userEvent.type(screen.getByLabelText("Address"), "0x12");
    expect(await screen.findByRole("alert")).toHaveTextContent(/not an address yet/);
    expect(rows()).toHaveLength(before);
  });

  it("filters by a full address, in any letter case", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    const before = rows().length;
    await userEvent.click(screen.getByLabelText("Address"));
    await userEvent.paste(`0x${"00".repeat(19)}AB`);
    await waitFor(() => expect(screen.getByText(/No transfers or messages match/)).toBeInTheDocument());
    expect(before).toBeGreaterThan(0);
  });

  it("clears every filter with one button, which is disabled when none is set", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await loaded();
    expect(screen.getByRole("button", { name: "Clear filters" })).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Status"), "delivered");
    const clear = await screen.findByRole("button", { name: "Clear 1 filter" });
    await userEvent.click(clear);
    expect(screen.getByLabelText("Status")).toHaveValue("all");
  });

  it("shows the summary, the actions and the light client heads around the feed", async () => {
    renderPage(<StatefulPairView pairId="eth-pls" initialToken={null} />);
    await screen.findByText(/Gate on Ethereum/);
    expect(screen.getByRole("heading", { name: "Actions" })).toBeInTheDocument();
    const footer = await screen.findByRole("contentinfo", { name: "Light client heads" });
    expect(footer).toHaveTextContent(/Ethereum stores PulseChain: head 25,800,000, finalized 25,800,096, lag 96 slots/);
    expect(footer).toHaveTextContent(/PulseChain stores Ethereum/);
  });

  it("refuses a pair that this page is not set up for", () => {
    renderPage(<StatefulPairView pairId="other-pair" initialToken={null} />);
    expect(screen.getByRole("status")).toHaveTextContent(/set up for the pair eth-pls/);
  });
});
