import { Box, Heading, Table, Text } from "@chakra-ui/react";
import type { ChainSide } from "@terminal/model/types";
import { useProver } from "../app/queries";
import { useServices } from "../app/services";
import { formatSlot, formatTimestamp, formatUnits, shortenHex } from "../ui/format";
import { Mono, Notice } from "../ui/primitives";

/**
 * The prover and costs view: the light client updates that landed on chain, with gas used, cost and poster. It holds
 * on-chain facts only. The time of a proof and the cost of the graphics processor are not on chain.
 */
export const ProverView = () => {
  const { pair } = useServices();
  const prover = useProver(pair.id);
  const updates = prover.data?.updates;
  const chainOf = (side: ChainSide) => (side === "first" ? pair.first : pair.second);
  const totals = ([pair.first, pair.second] as const).map((chain) => {
    const own = (updates ?? []).filter((update) => chainOf(update.side).chainId === chain.chainId);
    return { chain, count: own.length, gas: own.reduce((sum, update) => sum + update.gasUsed, 0n), cost: own.reduce((sum, update) => sum + update.costWei, 0n) };
  });
  return (
    <Box>
      <Heading as="h1" size="lg" marginBottom="1">
        Prover and costs
      </Heading>
      <Text color="fg.muted" marginBottom="3">
        Light client updates as they landed on chain. The time of a proof and the cost of the graphics processor are not recorded on chain, so they are not here.
      </Text>
      {prover.error === null ? null : <Notice tone="error">The updates did not load: {prover.error.message}</Notice>}
      {updates === undefined ? <Text color="fg.muted">Loading…</Text> : null}
      {updates === undefined ? null : (
        <>
          <Box as="ul" listStyleType="none" margin="0" padding="0" marginBottom="3">
            {totals.map((total) => (
              <Text as="li" key={total.chain.chainId} fontSize="sm">
                {total.chain.name}: {total.count} recent updates, {total.gas.toString()} gas, {formatUnits(total.cost, 18, { maximumFractionDigits: 6 })} {total.chain.nativeSymbol}
              </Text>
            ))}
          </Box>
          <Box overflowX="auto">
            <Table.Root aria-label="Light client updates">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader scope="col">Time (UTC)</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col">Chain</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Slot</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Gas used</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col" textAlign="end">Cost</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col">Transaction</Table.ColumnHeader>
                  <Table.ColumnHeader scope="col">Poster</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {updates.map((update) => {
                  const chain = chainOf(update.side);
                  return (
                    <Table.Row key={update.transactionHash}>
                      <Table.Cell whiteSpace="nowrap">{formatTimestamp(update.at)}</Table.Cell>
                      <Table.Cell>{chain.name}</Table.Cell>
                      <Table.Cell textAlign="end">{formatSlot(update.slot)}</Table.Cell>
                      <Table.Cell textAlign="end">{update.gasUsed.toString()}</Table.Cell>
                      <Table.Cell textAlign="end" whiteSpace="nowrap">
                        {formatUnits(update.costWei, 18, { maximumFractionDigits: 6 })} {chain.nativeSymbol}
                      </Table.Cell>
                      <Table.Cell>
                        <Mono>{shortenHex(update.transactionHash, 6)}</Mono>
                      </Table.Cell>
                      <Table.Cell>
                        <Mono>{shortenHex(update.poster, 4)}</Mono>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Box>
        </>
      )}
    </Box>
  );
};
