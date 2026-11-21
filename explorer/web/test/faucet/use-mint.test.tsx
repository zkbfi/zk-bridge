import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FIXTURE_TRANSACTION_HASH } from "@terminal/chain/chain-access";
import { FAUCET_TOKEN_ADDRESS, MINT_UNITS } from "../../src/faucet/faucet-model";
import { useMint } from "../../src/faucet/use-mint";
import { connectedWallet, disconnectedWallet, renderWithWallet } from "../app/support";
import { TESTNET } from "./testnet-pair";

const Harness = ({ chainId }: { readonly chainId: number }) => {
  const { mint, dialog } = useMint();
  return (
    <>
      <button type="button" onClick={() => mint(chainId)}>
        mint
      </button>
      {dialog}
    </>
  );
};

const services = { pair: TESTNET };

describe("useMint", () => {
  it("opens the confirm dialog on a mint that it decodes from the bytes, sends it through the wallet, and says Done", async () => {
    const sendTransaction = vi.fn(async () => FIXTURE_TRANSACTION_HASH);
    renderWithWallet(<Harness chainId={943} />, { wallet: connectedWallet({ sendTransaction }), services });
    await userEvent.click(screen.getByRole("button", { name: "mint" }));
    expect(await screen.findByRole("heading", { name: `Mint 1,000 tFAU on ${TESTNET.second.name}` })).toBeInTheDocument();
    expect(screen.getByText("1000 tFAU")).toBeInTheDocument();
    expect(screen.getByText("mint(uint256)")).toBeInTheDocument();
    await userEvent.click(await screen.findByRole("button", { name: "Send to wallet" }));
    await waitFor(() => expect(sendTransaction).toHaveBeenCalledTimes(1));
    expect(sendTransaction).toHaveBeenCalledWith(expect.objectContaining({ chainId: 943, to: FAUCET_TOKEN_ADDRESS[943], value: 0n }));
    expect(await screen.findByText("Done. Every transaction is confirmed.")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Close", { selector: "button" }));
    expect(screen.queryByText("Done. Every transaction is confirmed.")).toBeNull();
  });

  it("asks the wallet to connect first, and opens no dialog, when no wallet is connected", async () => {
    const connect = vi.fn(async () => undefined);
    renderWithWallet(<Harness chainId={943} />, { wallet: disconnectedWallet({ connect }), services });
    await userEvent.click(screen.getByRole("button", { name: "mint" }));
    expect(connect).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens nothing for a chain that is not in the pair", async () => {
    renderWithWallet(<Harness chainId={1} />, { wallet: connectedWallet(), services });
    await userEvent.click(screen.getByRole("button", { name: "mint" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("mints exactly 1,000 tFAU, the most one call may", () => {
    expect(MINT_UNITS).toBe(1_000n * 10n ** 18n);
  });
});
