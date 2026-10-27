import { Box, Heading, Stack, Text } from "@chakra-ui/react";
import type { Address } from "viem";
import { useFeed, useSnapshots } from "../app/queries";
import { useServices } from "../app/services";
import { formatAmountWithSymbol, formatUnits } from "../ui/format";
import { Mono, Notice, Panel } from "../ui/primitives";
import { FeedTable } from "./pair/FeedTable";

/**
 * The page of one address: its transfers and messages as sender or recipient, and its balances on both chains.
 *
 * @param props The address.
 */
export const AddressView = ({ address }: { readonly address: Address }) => {
  const { pair } = useServices();
  const feed = useFeed(pair.id, { address }, 50);
  const snapshots = useSnapshots(address, pair.id);
  return (
    <Stack gap="3">
      <Box>
        <Heading as="h1" size="lg">
          Address
        </Heading>
        <Mono>{address}</Mono>
      </Box>
      <Panel title="Balances">
        {snapshots.error === null ? null : <Notice tone="error">Balances did not load: {snapshots.error.message}</Notice>}
        {snapshots.data === undefined ? <Text color="fg.muted" fontSize="sm">Loading…</Text> : null}
        {(snapshots.data ?? []).map((result) =>
          result.status === "error" ? (
            <Notice key={result.chain.chainId} tone="error">
              {result.chain.name}: {result.message}
            </Notice>
          ) : (
            <Box key={result.snapshot.chain.chainId} marginBottom="2">
              <Text fontWeight="medium" fontSize="sm">
                {result.snapshot.chain.name}
              </Text>
              <Text fontSize="sm">
                {formatUnits(result.snapshot.nativeBalance, 18, { groupThousands: true, maximumFractionDigits: 6 })} {result.snapshot.chain.nativeSymbol}
              </Text>
              {result.snapshot.positions.map((position) => (
                <Text key={position.token.address} fontSize="sm">
                  {formatAmountWithSymbol(position.balance, position.token)}
                </Text>
              ))}
            </Box>
          ),
        )}
      </Panel>
      <Panel title="Transfers and messages">
        {feed.error === null ? null : <Notice tone="error">The feed did not load: {feed.error.message}</Notice>}
        {feed.data === undefined ? <Text color="fg.muted" fontSize="sm">Loading…</Text> : <FeedTable pair={pair} items={feed.data.items} />}
      </Panel>
    </Stack>
  );
};
