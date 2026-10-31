import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { buildFixtureFeed, FIXTURE_NOW } from "@terminal/data/fixtures";
import { ServicesProvider } from "../../src/app/services";
import type { DocPage } from "../../src/docs/docs-index";
import { createFixtureIndexerClient } from "../../src/data/fixture-indexer-client";
import type { IndexerClient } from "../../src/data/indexer-client";
import type { MessageDetail } from "../../src/data/message-detail";
import { CommandPalette } from "../../src/search/CommandPalette";
import { renderPage } from "../render";
import { buildTestServices } from "../render";

const unknownHash = `0x${"77".repeat(32)}` as const;
const page = (heading: string): DocPage => ({
  slug: "custom",
  title: "Custom page",
  blocks: [],
  headings: [{ id: "custom-heading", text: heading, level: 2 }],
});

const open = (props: { readonly docPages?: readonly DocPage[]; readonly indexer?: IndexerClient } = {}) => {
  const onSelect = vi.fn();
  const palette = <CommandPalette recent={[]} walletConnected={false} onSelect={onSelect} onClose={() => undefined} {...(props.docPages === undefined ? {} : { docPages: props.docPages })} />;
  const services = { ...buildTestServices(), indexer: props.indexer ?? createFixtureIndexerClient() };
  const view = renderPage(<ServicesProvider services={services}>{palette}</ServicesProvider>, { connected: false });
  return { ...view, onSelect, input: screen.getByRole("combobox") };
};

describe("the command palette, the cases of the first test file leaves out", () => {
  it("searches the documentation pages that the caller gives instead of the real ones", async () => {
    const { input } = open({ docPages: [page("Zebra crossing")] });
    await userEvent.type(input, "zebra");
    expect(await screen.findByRole("option", { name: /Zebra crossing/ })).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, "data source");
    expect(screen.queryByRole("option", { name: /The data source line/ })).toBeNull();
  });

  it("tells the user to try other words when nothing matches and no lookup failed", async () => {
    const { input } = open();
    await userEvent.type(input, "qqzzxx");
    expect(await screen.findByText("Nothing matches. Try a token symbol, an address, a transaction hash or a word from the docs.")).toBeInTheDocument();
  });

  it("shows the lookup problem under results that still match, in place of the empty message", async () => {
    const { input } = open({ docPages: [page(unknownHash)] });
    await userEvent.click(input);
    await userEvent.paste(unknownHash);
    expect(await screen.findByText(/knows no message with this identifier or transaction hash/)).toBeInTheDocument();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([expect.stringContaining(unknownHash)]);
    expect(screen.queryByText(/^Nothing matches/)).toBeNull();
  });

  it("shows the answer of the latest query only, even when an older lookup finishes late", async () => {
    const feed = buildFixtureFeed(FIXTURE_NOW);
    const fixture = createFixtureIndexerClient();
    const slowHash = feed[3]!.id;
    const fastHash = feed[4]!.id;
    let releaseSlow: (detail: MessageDetail | null) => void = () => undefined;
    const slow = new Promise<MessageDetail | null>((resolve) => {
      releaseSlow = resolve;
    });
    const indexer: IndexerClient = {
      message: (id) => (id === slowHash ? slow : fixture.message(id)),
      findMessageByTransaction: (hash) => fixture.findMessageByTransaction(hash),
      transactionCost: async () => null,
    };
    const { input } = open({ indexer });
    await userEvent.click(input);
    await userEvent.paste(slowHash);
    expect(await screen.findByRole("status")).toHaveTextContent("Asking the indexer…");
    await userEvent.clear(input);
    await userEvent.paste(fastHash);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    const fastTitle = screen.getByRole("option").textContent;
    expect(fastTitle).toContain(`${fastHash.slice(0, 10)}…`);
    await act(async () => {
      releaseSlow(await fixture.message(slowHash));
    });
    expect(screen.getByRole("option").textContent).toBe(fastTitle);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
