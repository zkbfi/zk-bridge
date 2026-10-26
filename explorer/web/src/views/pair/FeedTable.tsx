import { Box, Table, Text } from "@chakra-ui/react";
import type { FeedItem, PairConfig } from "@terminal/model/types";
import { formatAmountWithSymbol, formatTimestamp, shortenHex } from "../../ui/format";
import { Mono, StatusBadge } from "../../ui/primitives";

/** Props of {@link FeedTable}. */
export type FeedTableProps = {
  readonly pair: PairConfig;
  readonly items: readonly FeedItem[];
};

const chainsOf = (item: FeedItem, pair: PairConfig) =>
  item.direction === "first-to-second" ? { from: pair.first, to: pair.second } : { from: pair.second, to: pair.first };

/**
 * The feed, newest first. Each row shows the time on the source chain, the time on the destination chain, the
 * direction, what moved and the status. The first cell links to the page of the transfer.
 *
 * @param props The pair and the rows.
 */
export const FeedTable = ({ pair, items }: FeedTableProps) => {
  if (items.length === 0) {
    return (
      <Text color="fg.muted" fontSize="sm" paddingY="6" textAlign="center">
        No transfers or messages match these filters.
      </Text>
    );
  }
  return (
    <Box overflowX="auto">
      <Table.Root size="sm" variant="line" aria-label="Transfers and messages">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeader scope="col">Sent</Table.ColumnHeader>
            <Table.ColumnHeader scope="col">Arrived</Table.ColumnHeader>
            <Table.ColumnHeader scope="col">Route</Table.ColumnHeader>
            <Table.ColumnHeader scope="col">What</Table.ColumnHeader>
            <Table.ColumnHeader scope="col" display={{ base: "none", xl: "table-cell" }}>
              To
            </Table.ColumnHeader>
            <Table.ColumnHeader scope="col">Status</Table.ColumnHeader>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {items.map((item) => {
            const { from, to } = chainsOf(item, pair);
            return (
              <Table.Row key={item.id}>
                <Table.Cell whiteSpace="nowrap">
                  <a href={`#/message/${item.id}`} aria-label={`Open ${item.kind === "token" ? "transfer" : "message"} ${shortenHex(item.id, 6)}`}>
                    <time dateTime={new Date(item.sentAt * 1000).toISOString()}>{formatTimestamp(item.sentAt)}</time>
                  </a>
                  <Text fontSize="xs" color="fg.muted">
                    on {from.name}
                  </Text>
                </Table.Cell>
                <Table.Cell whiteSpace="nowrap">
                  {item.deliveredAt === null ? (
                    <Text color="fg.muted">not yet</Text>
                  ) : (
                    <time dateTime={new Date(item.deliveredAt * 1000).toISOString()}>{formatTimestamp(item.deliveredAt)}</time>
                  )}
                  <Text fontSize="xs" color="fg.muted">
                    on {to.name}
                  </Text>
                </Table.Cell>
                <Table.Cell whiteSpace="nowrap">
                  {from.nativeSymbol} to {to.nativeSymbol}
                </Table.Cell>
                <Table.Cell>
                  {item.token === null || item.amount === null ? <Text>Message to <Mono>{shortenHex(item.recipient, 4)}</Mono></Text> : <Text>{formatAmountWithSymbol(item.amount, item.token)}</Text>}
                </Table.Cell>
                <Table.Cell display={{ base: "none", xl: "table-cell" }}>
                  <Mono>{shortenHex(item.recipient, 4)}</Mono>
                </Table.Cell>
                <Table.Cell>
                  <StatusBadge status={item.status} />
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Box>
  );
};
