import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Prober } from "../../src/app/service-probe";
import { ServiceRow } from "../../src/explore/ExploreScreen";
import { disconnectedWallet, renderWithWallet } from "../app/support";

const renderRow = (url: string | null, probe: Prober) =>
  renderWithWallet(<ServiceRow name="Indexer" url={url} kind={{ kind: "health" }} />, { wallet: disconnectedWallet(), services: { probe } }).container;

describe("a Services row in Explore", () => {
  it("shows a green dot and the latency when the service answers its health route", async () => {
    const container = renderRow("https://indexer.zkb.fi", async () => ({ ok: true, ms: 41 }));
    expect(await screen.findByText("41 ms")).toBeInTheDocument();
    expect(container.querySelector(".zb-xsvc-dot")).toHaveAttribute("data-ok", "true");
    expect(screen.getByText("indexer.zkb.fi")).toBeInTheDocument();
  });

  it("shows a red dot and down when it does not, with the reason on hover", async () => {
    const container = renderRow("https://indexer.zkb.fi", async () => ({ ok: false, reason: "No answer within 8 s." }));
    expect(await screen.findByText("down")).toHaveAttribute("title", "No answer within 8 s.");
    expect(container.querySelector(".zb-xsvc-dot")).toHaveAttribute("data-ok", "false");
  });

  it("asks nothing for a service that is not set, and says so of a value that is not a URL", () => {
    let asked = 0;
    const probe: Prober = async () => ((asked += 1), { ok: true, ms: 1 });
    const container = renderRow(null, probe);
    expect(screen.getByText("not set")).toBeInTheDocument();
    expect(container.querySelector(".zb-xsvc-dot")).not.toHaveAttribute("data-ok");
    expect(asked).toBe(0);
    renderRow("nope", async () => ({ ok: false, reason: "x" }));
    expect(screen.getByText("not a URL")).toBeInTheDocument();
  });
});
