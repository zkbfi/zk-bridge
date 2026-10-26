import { Box, Heading, Table, Text } from "@chakra-ui/react";
import type { PairHealth } from "@terminal/model/types";
import { usePairHealth } from "../app/queries";
import { useServices } from "../app/services";
import { formatAge, formatLag } from "../ui/format";
import { Notice } from "../ui/primitives";

const HEAD_FALLBACK = "no head";

const headText = (health: PairHealth, side: "first" | "second"): string => {
  const head = health.heads.find((candidate) => candidate.side === side);
  return head === undefined ? HEAD_FALLBACK : `lag ${formatLag(head)}`;
};

/**
 * The global view: one row per pair with its health. The default pair opens in the pair view.
 */
export const GlobalView = () => {
  const { knownPairs, pair, now } = useServices();
  const health = usePairHealth();
  const clock = now();
  return (
    <Box>
      <Heading as="h1" size="lg" marginBottom="1">
        Global view
      </Heading>
      <Text color="fg.muted" marginBottom="3">
        Choose a pair. Each row shows how healthy the pair is now.
      </Text>
      {health.error === null ? null : <Notice tone="error">The pair health did not load: {health.error.message}</Notice>}
      <Box overflowX="auto" marginTop="2">
        <Table.Root aria-label="Pairs">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeader scope="col">Pair</Table.ColumnHeader>
              <Table.ColumnHeader scope="col">Chains</Table.ColumnHeader>
              <Table.ColumnHeader scope="col">In flight</Table.ColumnHeader>
              <Table.ColumnHeader scope="col">Light client lag</Table.ColumnHeader>
              <Table.ColumnHeader scope="col">Gate</Table.ColumnHeader>
              <Table.ColumnHeader scope="col">Last activity</Table.ColumnHeader>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {knownPairs.map((known) => {
              const row = health.data?.find((candidate) => candidate.pairId === known.id);
              if (!known.configured || row === undefined) {
                return (
                  <Table.Row key={known.id}>
                    <Table.Cell>{known.id}</Table.Cell>
                    <Table.Cell colSpan={5} color="fg.muted">
                      {known.configured ? "Loading…" : "Not configured on this page. Set a deployment file for it."}
                    </Table.Cell>
                  </Table.Row>
                );
              }
              return (
                <Table.Row key={known.id}>
                  <Table.Cell>
                    <a href={`#/pair/${known.id}`}>{known.id}</a>
                    <Text fontSize="xs" color="fg.muted">
                      {known.label}
                    </Text>
                  </Table.Cell>
                  <Table.Cell>
                    {row.firstChainName} and {row.secondChainName}
                  </Table.Cell>
                  <Table.Cell>{row.inFlight}</Table.Cell>
                  <Table.Cell>
                    <Text>{row.firstChainName}: {headText(row, "first")}</Text>
                    <Text>{row.secondChainName}: {headText(row, "second")}</Text>
                  </Table.Cell>
                  <Table.Cell>
                    <Text>{row.firstChainName}: {row.gates.first}</Text>
                    <Text>{row.secondChainName}: {row.gates.second}</Text>
                  </Table.Cell>
                  <Table.Cell>{row.lastActivityAt === null ? "none seen" : formatAge(clock, row.lastActivityAt)}</Table.Cell>
                </Table.Row>
              );
            })}
          </Table.Body>
        </Table.Root>
      </Box>
      <Text fontSize="sm" color="fg.muted" marginTop="3">
        The page is set up for {pair.id}. Open it to bridge, to read the feed and to see the light client heads.
      </Text>
    </Box>
  );
};
