import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { TransactionDialog } from "../actions/TransactionDialog";
import { useServices } from "../app/services";
import type { WebStep } from "../tx/bridge-steps";
import { useWallet } from "../wallet/wallet-port";
import { mintStepOf } from "./faucet-model";

/** What {@link useMint} gives. */
export type UseMint = {
  /** Starts a mint of 1,000 tFAU on a chain: the confirm dialog opens, or, with no wallet connected, the wallet list. */
  readonly mint: (chainId: number) => void;
  /** The confirm dialog while a mint is under review, else null. The caller renders it once. */
  readonly dialog: ReactNode;
};

/**
 * The mint of the testnet faucet token for the connected wallet. The call goes through the same confirm dialog as every
 * other call of the page, which decodes it from its bytes; the wallet is switched to the chain when the viewer sends it.
 * When the mint is confirmed, the balances are read again.
 */
export const useMint = (): UseMint => {
  const wallet = useWallet();
  const { pair } = useServices();
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<readonly WebStep[] | null>(null);
  const mint = useCallback(
    (chainId: number): void => {
      if (wallet.status !== "connected") {
        void wallet.connect();
        return;
      }
      const step = mintStepOf(pair, chainId);
      if (step !== null) setSteps([step]);
    },
    [wallet, pair],
  );
  const dialog =
    steps === null ? null : (
      <TransactionDialog steps={steps} variant="sheet" onClose={() => setSteps(null)} onFinished={() => void queryClient.invalidateQueries({ queryKey: ["snapshots"] })} />
    );
  return { mint, dialog };
};
