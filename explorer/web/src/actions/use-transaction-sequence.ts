import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { useServices } from "../app/services";
import { createTransactionSequence, type SequenceState, type TransactionSequence } from "../tx/transaction-sequence";
import type { WebStep } from "../tx/bridge-steps";
import { useWallet } from "../wallet/wallet-port";

/** The sequence and its state. */
export type UseTransactionSequence = {
  readonly state: SequenceState;
  readonly sequence: TransactionSequence;
};

/**
 * Runs a sequence of transactions through the wallet of the page. The sequence starts when the hook mounts, and it
 * stops at the review of the first transaction. Nothing reaches the wallet until `sequence.confirm()`.
 *
 * @param steps The planned transactions.
 * @throws When no wallet account is connected at the start.
 */
export const useTransactionSequence = (steps: readonly WebStep[]): UseTransactionSequence => {
  const wallet = useWallet();
  const { chainAccess } = useServices();
  const walletReference = useRef(wallet);
  walletReference.current = wallet;
  const [sequence] = useState<TransactionSequence>(() => {
    const account = wallet.account;
    if (account === null) throw new Error("A wallet account must be connected before a transaction is prepared.");
    return createTransactionSequence({
      account: account as Address,
      clientFor: (chainId) => chainAccess.flowClient(chainId),
      sendTransaction: (transaction) => walletReference.current.sendTransaction(transaction),
    });
  });
  const state = useSyncExternalStore(sequence.subscribe, sequence.getState);

  useEffect(() => {
    sequence.start(steps);
    return () => sequence.cancel();
  }, [sequence, steps]);

  return { state, sequence };
};
