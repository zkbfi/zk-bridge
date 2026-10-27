import { Box, Button, Flex, Table, Text } from "@chakra-ui/react";
import type { ChainSnapshotResult } from "@terminal/chain/live-reads";
import type { PairConfig } from "@terminal/model/types";
import { formatAmountWithSymbol, formatUnits } from "../ui/format";
import { Mono, Notice, Panel } from "../ui/primitives";
import { useWallet } from "../wallet/wallet-port";

/** Props of {@link AccountPanel}. */
export type AccountPanelProps = {
  readonly pair: PairConfig;
  readonly snapshots: readonly ChainSnapshotResult[] | undefined;
  readonly snapshotError: string | null;
};

/**
 * The connected account, the balances on both chains of the pair.
 *
 * @param props The pair and the live balances.
 */
export const AccountPanel = ({ pair, snapshots, snapshotError }: AccountPanelProps) => {
  const wallet = useWallet();
  const connected = wallet.status === "connected" && wallet.account !== null;
  const walletChain = [pair.first, pair.second].find((chain) => chain.chainId === wallet.chainId);
  return (
    <Panel title="Account">
      {wallet.kind === "simulated" ? <Notice tone="warning">Simulated wallet. Nothing reaches a chain.</Notice> : null}
      {connected ? (
        <Box marginTop="1">
          <Text fontSize="xs" color="fg.muted">
            {wallet.walletName ?? "Wallet"} is connected
          </Text>
          <Mono>{wallet.account}</Mono>
          <Text fontSize="sm" marginTop="1">
            {walletChain === undefined ? `The wallet is on chain ${wallet.chainId}, which is not in this pair.` : `The wallet is on ${walletChain.name}.`}
          </Text>
          <Flex gap="2" marginTop="2" flexWrap="wrap">
            {[pair.first, pair.second].map((chain) => (
              <Button key={chain.chainId} size="xs" variant="outline" disabled={chain.chainId === wallet.chainId} onClick={() => void wallet.switchChain(chain.chainId)}>
                Switch to {chain.name}
              </Button>
            ))}
            <Button size="xs" variant="ghost" onClick={() => wallet.disconnect()}>
              Disconnect
            </Button>
          </Flex>
        </Box>
      ) : (
        <Box marginTop="1">
          <Text fontSize="sm" color="fg.muted">
            Connect the wallet in your browser to see your balances and to bridge. A hardware wallet works through that wallet.
          </Text>
          <Button marginTop="2" size="sm" colorPalette="blue" disabled={!wallet.walletAvailable || wallet.status === "connecting"} onClick={() => void wallet.connect()}>
            {wallet.status === "connecting" ? "Connecting…" : "Connect wallet"}
          </Button>
          {wallet.walletAvailable ? null : <Text fontSize="xs" color="fg.muted" marginTop="1">No wallet was found in this browser.</Text>}
        </Box>
      )}

      {!connected ? null : (
        <Box marginTop="3">
          {snapshotError === null ? null : <Notice tone="error">Balances did not load: {snapshotError}</Notice>}
          {(snapshots ?? []).map((result) =>
            result.status === "error" ? (
              <Notice key={result.chain.chainId} tone="error">
                {result.chain.name}: {result.message}
              </Notice>
            ) : (
              <Box key={result.snapshot.chain.chainId} marginTop="2" data-testid={`balances-${result.snapshot.chain.chainId}`}>
                <Text fontWeight="medium" fontSize="sm">
                  {result.snapshot.chain.name}
                </Text>
                <Table.Root size="sm" aria-label={`Balances on ${result.snapshot.chain.name}`}>
                  <Table.Body>
                    <Table.Row>
                      <Table.Cell>{result.snapshot.chain.nativeSymbol}</Table.Cell>
                      <Table.Cell textAlign="end">{formatUnits(result.snapshot.nativeBalance, 18, { groupThousands: true, maximumFractionDigits: 6 })}</Table.Cell>
                    </Table.Row>
                    {result.snapshot.positions.map((position) => (
                      <Table.Row key={position.token.address}>
                        <Table.Cell>{position.token.symbol}</Table.Cell>
                        <Table.Cell textAlign="end">
                          {formatAmountWithSymbol(position.balance, position.token)}
                          {position.claimable > 0n ? <Text as="span" fontSize="xs" color="orange.fg"> ({formatAmountWithSymbol(position.claimable, position.token)} claimable)</Text> : null}
                        </Table.Cell>
                      </Table.Row>
                    ))}
                  </Table.Body>
                </Table.Root>
              </Box>
            ),
          )}
        </Box>
      )}
    </Panel>
  );
};
