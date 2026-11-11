import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FIXTURE_PAIR } from "@terminal/data/fixtures";
import { createFixtureExploreSource } from "../../src/explore/explore-fixture";
import { ExplorePageView } from "../../src/explore/ExplorePages";
import { connectedWallet, renderWithWallet } from "../app/support";

const pair = FIXTURE_PAIR;
const GATE = "0x1782a38a37ce9fb9f53b0585b23b833847007e20";

describe("the gates list", () => {
  it("says for each gate whether it is sealed, open or closed", async () => {
    const explore = {
      ...createFixtureExploreSource(),
      gates: async () => [
        { chainId: pair.first.chainId, gate: GATE, enforcing: true, sealed: true, depositsOpen: true, confirmations: 0, lastConfirmedTimestamp: null },
        { chainId: pair.second.chainId, gate: GATE, enforcing: true, sealed: false, depositsOpen: true, confirmations: 0, lastConfirmedTimestamp: null },
        { chainId: 5, gate: GATE, enforcing: true, sealed: false, depositsOpen: false, confirmations: 0, lastConfirmedTimestamp: null },
      ],
    } as never;
    renderWithWallet(<ExplorePageView page={{ kind: "browse", id: "gates" }} />, { wallet: connectedWallet(), services: { pair, explore } });
    const links = await screen.findAllByRole("link");
    expect(links.map((link) => /(sealed|open|closed)$/.exec(link.textContent ?? "")?.[1])).toEqual(["sealed", "open", "closed"]);
  });

  it("says when a short list has nothing, under its own title", () => {
    renderWithWallet(<ExplorePageView page={{ kind: "browse", id: "releases" }} />, { wallet: connectedWallet(), services: { pair } });
    expect(screen.getByText("Releases")).toBeInTheDocument();
    expect(screen.getByText("None yet on this pair.")).toBeInTheDocument();
  });
});

describe("which page a route shows", () => {
  const show = (page: Parameters<typeof ExplorePageView>[0]["page"]) => renderWithWallet(<ExplorePageView page={page} />, { wallet: connectedWallet(), services: { pair } });

  it("shows a release by its CID", async () => {
    show({ kind: "release", id: "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" });
    expect(await screen.findByText("Release", { selector: ".zb-xband-label, .zb-xband *" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "On an IPFS gateway" })).toBeInTheDocument();
  });

  it("shows the costs page for an on-chain page that names no chain", async () => {
    show({ kind: "contract", id: "0x0000000000000000000000000000000000000001" });
    expect(await screen.findByText("What the bridge spends")).toBeInTheDocument();
  });
});
