import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServicesProvider } from "../../src/app/services";
import { CommandPalette } from "../../src/search/CommandPalette";
import { buildTestServices, renderPage } from "../render";

const load = vi.hoisted(() => vi.fn());
vi.mock("../../src/docs/doc-entries", () => ({ loadDocEntries: load }));

describe("the palette when the docs cannot be downloaded", () => {
  it("still searches everything else, and asks for the docs once", async () => {
    load.mockRejectedValue(new Error("offline"));
    renderPage(
      <ServicesProvider services={buildTestServices()}>
        <CommandPalette recent={[]} walletConnected={false} onSelect={() => undefined} onClose={() => undefined} />
      </ServicesProvider>,
      { connected: false },
    );
    await userEvent.click(screen.getByRole("combobox"));
    await userEvent.paste("prover");
    expect(await screen.findByRole("option", { name: /^Prover and costs/ })).toBeInTheDocument();
    await userEvent.paste("x");
    expect(load).toHaveBeenCalledTimes(1);
  });
});
