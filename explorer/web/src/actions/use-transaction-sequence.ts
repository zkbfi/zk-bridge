import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Address } from "viem";
import { createGateCheck, NO_BEACON_ENDPOINT_TEXT, type GateChainClient } from "@zk-bridge/shared";
import { beaconUrlsFor } from "@terminal/config/default-beacon";
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
  const { chainAccess, connection } = useServices();
  const walletReference = useRef(wallet);
  walletReference.current = wallet;
  const [sequence] = useState<TransactionSequence>(() => {
    const account = wallet.account;
    if (account === null) throw new Error("A wallet account must be connected before a transaction is prepared.");
    // The deposit gate check reads on the same sticky flow client as the send, with the beacon endpoints of Settings in
    // force at each check. The sample page has no chain, so it checks no gate.
    const checkGate =
      connection === null
        ? undefined
        : createGateCheck({
            // The flow client of a live page is a viem public client; its type names only what the flow needs.
            clientFor: (chainId) => chainAccess.flowClient(chainId) as unknown as GateChainClient,
            beaconUrlsFor: (chainId) => beaconUrlsFor(connection.resolved(), chainId),
            noneText: `${NO_BEACON_ENDPOINT_TEXT} (Settings, Beacon endpoints)`,
          });
    return createTransactionSequence({
      account: account as Address,
      clientFor: (chainId) => chainAccess.flowClient(chainId),
      sendTransaction: (transaction) => walletReference.current.sendTransaction(transaction),
      ...(checkGate === undefined ? {} : { checkGate }),
    });
  });
  const state = useSyncExternalStore(sequence.subscribe, sequence.getState);

  useEffect(() => {
    sequence.start(steps);
    return () => sequence.cancel();
  }, [sequence, steps]);

  return { state, sequence };
};
