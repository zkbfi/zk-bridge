import { Box, Button, Stack, Text } from "@chakra-ui/react";
import { claimableEntries } from "@terminal/app/actions";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { PairConfig } from "@terminal/model/types";
import { AccountPanel } from "../../actions/AccountPanel";
import { useActions } from "../../app/actions-context";
import { Panel } from "../../ui/primitives";
import { useWallet } from "../../wallet/wallet-port";

/** Props of {@link ActionArea}. */
export type ActionAreaProps = {
  readonly pair: PairConfig;
  readonly snapshots: readonly ChainSnapshotResult[] | undefined;
  readonly snapshotError: string | null;
};

/**
 * The left side of the pair view: the account, the balances on both chains and the actions. An action is disabled
 * until a wallet is connected, and the panel says why.
 *
 * @param props The pair and the live balances.
 */
export const ActionArea = ({ pair, snapshots, snapshotError }: ActionAreaProps) => {
  const wallet = useWallet();
  const actions = useActions();
  const connected = wallet.status === "connected";
  const claimable = claimableEntries(snapshots ?? null).length;
  return (
    <Stack gap="3">
      <AccountPanel pair={pair} snapshots={snapshots} snapshotError={snapshotError} />
      <Panel title="Actions">
        <Stack gap="2">
          <Button colorPalette="blue" disabled={!connected} onClick={() => actions.open("bridge")}>
            Bridge tokens
          </Button>
          <Button variant="outline" disabled={!connected} onClick={() => actions.open("wrap")}>
            Wrap the native coin and bridge it
          </Button>
          <Button variant="outline" disabled={!connected} onClick={() => actions.open("message")}>
            Send a message
          </Button>
          <Button variant="outline" disabled={!connected} onClick={() => actions.open("claim")}>
            Claim balances{claimable === 0 ? "" : ` (${claimable})`}
          </Button>
        </Stack>
        {connected ? null : (
          <Box marginTop="2">
            <Text fontSize="sm" color="fg.muted">
              Connect a wallet to act. You can still read everything without one.
            </Text>
          </Box>
        )}
      </Panel>
    </Stack>
  );
};
