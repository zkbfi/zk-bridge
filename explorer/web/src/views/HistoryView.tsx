import { Box, Button, Flex, Heading, Table, Text } from "@chakra-ui/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { isAddress } from "viem";
import { DEFAULT_MAXIMUM_BLOCKS, MESSAGE_STATUSES, parseHistoryCursor, picksMessagesOnly, type HistoryEvent, type HistoryFilters } from "@zk-bridge/shared";
import { formatRoute } from "../app/route";
import { useServices } from "../app/services";
import { loadSharedPair } from "../config/environment";
import { chainNameOf } from "../data/message-detail";
import { formatTimestamp, shortenHex, STATUS_LABELS } from "../ui/format";
import { Field, Mono, Notice, Panel, SelectInput, TextInput } from "../ui/primitives";
import {
  dateOfSeconds,
  defaultHistoryDependencies,
  EMPTY_HISTORY_FILTERS,
  EVENT_KIND_LABELS,
  formatHistoryQuery,
  readHistory,
  secondsOfDate,
  type HistoryDependencies,
  type ScanRequest,
} from "./history-model";

/** A scan of the chains stays fresh this long. After that, a poll reads the chains again. */
const SCAN_FRESH_MILLISECONDS = 60_000;

/** Props of {@link HistoryView}. */
export type HistoryViewProps = {
  readonly filters: HistoryFilters;
  /** Called with the new filters when the reader changes a filter or turns the page. */
  readonly onChange: (filters: HistoryFilters) => void;
  /** Replaces the network reads. A test passes fakes. */
  readonly dependencies?: HistoryDependencies;
};

const ANY = "any";

/** A filter change starts again at the newest events. */
const restarted = (filters: HistoryFilters, change: Partial<HistoryFilters>): HistoryFilters => ({ ...filters, ...change, cursor: null });

const statusText = (event: HistoryEvent): string => {
  if (event.kind === "head-update") return "Not a message";
  return event.status === null ? "Not read from the chains" : STATUS_LABELS[event.status];
};

const EventRow = ({ event, chainName }: { readonly event: HistoryEvent; readonly chainName: string }) => (
  <Table.Row>
    <Table.Cell>
      <time dateTime={new Date(Number(event.timestamp) * 1000).toISOString()}>{formatTimestamp(Number(event.timestamp))} UTC</time>
    </Table.Cell>
    <Table.Cell>{EVENT_KIND_LABELS[event.kind]}</Table.Cell>
    <Table.Cell>{chainName}</Table.Cell>
    <Table.Cell>
      {event.messageId === null ? (
        <Text as="span">Slot {String(event.slot)}</Text>
      ) : (
        <a href={formatRoute({ name: "message", messageId: event.messageId })} aria-label={`Open message ${shortenHex(event.messageId, 6)}`}>
          {shortenHex(event.messageId, 6)}
        </a>
      )}
    </Table.Cell>
    <Table.Cell>{statusText(event)}</Table.Cell>
    <Table.Cell>
      <Mono>{shortenHex(event.transactionHash, 6)}</Mono>
    </Table.Cell>
  </Table.Row>
);

/**
 * The history of every bridge event on both chains: sends, deliveries and stored light client heads, newest first.
 * The indexer answers while it can. Otherwise the page reads the chains and says that the history is partial.
 *
 * @param props The filters, the change handler and the optional dependencies.
 */
export const HistoryView = ({ filters, onChange, dependencies }: HistoryViewProps) => {
  const { pair, configuration, connection } = useServices();
  const [addressText, setAddressText] = useState(filters.address ?? "");
  const [tokenText, setTokenText] = useState(filters.token ?? "");
  const queryClient = useQueryClient();
  const [maximumBlocks, setMaximumBlocks] = useState(DEFAULT_MAXIMUM_BLOCKS);
  // The scan of the chains is kept under a key that holds no filter and no page, so a filter or a page never reads the
  // chains again.
  const reads = useMemo(
    () => ({
      ...(dependencies ?? defaultHistoryDependencies(() => loadSharedPair(configuration))),
      scanOf: (request: ScanRequest) =>
        queryClient.fetchQuery({ queryKey: ["history-scan", request.key], queryFn: () => request.load(request.signal), staleTime: SCAN_FRESH_MILLISECONDS }),
    }),
    [dependencies, configuration, queryClient],
  );
  const query = useQuery({
    queryKey: ["history", formatHistoryQuery(filters), String(maximumBlocks)],
    queryFn: ({ signal }) => readHistory({ connection: (connection as NonNullable<typeof connection>).connection(), filters, dependencies: reads, maximumBlocks, signal }),
    enabled: connection !== null,
    refetchInterval: filters.cursor === null ? 15_000 : false,
    placeholderData: (previous) => previous,
  });

  const chains = [pair.first, pair.second];
  const addressProblem = addressText.trim() === "" || isAddress(addressText.trim(), { strict: false }) ? null : "This is not an address yet. The list is not filtered by it.";
  const tokenProblem = tokenText.trim() === "" || isAddress(tokenText.trim(), { strict: false }) ? null : "This is not an address yet. The list is not filtered by it.";
  const directionValue = filters.direction === null ? ANY : `${filters.direction.sourceChainId}>${filters.direction.destinationChainId}`;

  const editAddress = (text: string): void => {
    setAddressText(text);
    const trimmed = text.trim();
    if (trimmed === "") return onChange(restarted(filters, { address: null }));
    if (isAddress(trimmed, { strict: false })) onChange(restarted(filters, { address: trimmed.toLowerCase() as `0x${string}` }));
  };
  const editToken = (text: string): void => {
    setTokenText(text);
    const trimmed = text.trim();
    if (trimmed === "") return onChange(restarted(filters, { token: null }));
    if (isAddress(trimmed, { strict: false })) onChange(restarted(filters, { token: trimmed.toLowerCase() as `0x${string}` }));
  };
  const clear = (): void => {
    setAddressText("");
    setTokenText("");
    onChange(EMPTY_HISTORY_FILTERS);
  };

  const reading = query.data;
  const nextCursor = reading?.page.nextCursor ?? null;
  return (
    <Flex direction="column" gap="3">
      <Heading as="h1" size="lg">
        History
      </Heading>
      <Text fontSize="sm" color="fg.muted">
        Every send, delivery and light client head update on both chains, newest first.
      </Text>
      <form role="search" aria-label="History filters" onSubmit={(event) => event.preventDefault()}>
        <Flex gap="2" flexWrap="wrap" alignItems="flex-end">
          <Flex flex="1 1 12rem">
            <Field label="Pair and direction">
              {(id) => (
                <SelectInput
                  id={id}
                  value={directionValue}
                  onChange={(event) => {
                    const [source, destination] = event.target.value.split(">");
                    onChange(restarted(filters, { direction: event.target.value === ANY ? null : { sourceChainId: Number(source), destinationChainId: Number(destination) } }));
                  }}
                >
                  <option value={ANY}>{pair.label}, both directions</option>
                  <option value={`${pair.first.chainId}>${pair.second.chainId}`}>
                    {pair.first.name} to {pair.second.name}
                  </option>
                  <option value={`${pair.second.chainId}>${pair.first.chainId}`}>
                    {pair.second.name} to {pair.first.name}
                  </option>
                </SelectInput>
              )}
            </Field>
          </Flex>
          <Flex flex="1 1 8rem">
            <Field label="Chain">
              {(id) => (
                <SelectInput id={id} value={filters.chain === null ? ANY : String(filters.chain)} onChange={(event) => onChange(restarted(filters, { chain: event.target.value === ANY ? null : Number(event.target.value) }))}>
                  <option value={ANY}>Either chain</option>
                  {chains.map((chain) => (
                    <option key={chain.chainId} value={chain.chainId}>
                      {chain.name}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>
          </Flex>
          <Flex flex="1 1 8rem">
            <Field label="Event">
              {(id) => (
                <SelectInput id={id} value={filters.eventKind ?? ANY} onChange={(event) => onChange(restarted(filters, { eventKind: event.target.value === ANY ? null : (event.target.value as HistoryEvent["kind"]) }))}>
                  <option value={ANY}>All events</option>
                  {(Object.keys(EVENT_KIND_LABELS) as HistoryEvent["kind"][]).map((kind) => (
                    <option key={kind} value={kind}>
                      {EVENT_KIND_LABELS[kind]}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>
          </Flex>
          <Flex flex="1 1 8rem">
            <Field label="Kind of message">
              {(id) => (
                <SelectInput id={id} value={filters.kind ?? ANY} onChange={(event) => onChange(restarted(filters, { kind: event.target.value === ANY ? null : (event.target.value as "token" | "message") }))}>
                  <option value={ANY}>All kinds</option>
                  <option value="token">Token transfers</option>
                  <option value="message">Messages</option>
                </SelectInput>
              )}
            </Field>
          </Flex>
          <Flex flex="1 1 8rem">
            <Field label="Status">
              {(id) => (
                <SelectInput id={id} value={filters.statuses[0] ?? ANY} onChange={(event) => onChange(restarted(filters, { statuses: event.target.value === ANY ? [] : [event.target.value as (typeof MESSAGE_STATUSES)[number]] }))}>
                  <option value={ANY}>Any status</option>
                  {MESSAGE_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {STATUS_LABELS[status]}
                    </option>
                  ))}
                </SelectInput>
              )}
            </Field>
          </Flex>
          <Flex flex="2 1 12rem">
            <Field label="Address" error={addressProblem}>
              {(id) => <TextInput id={id} placeholder="Sender or recipient, 0x…" value={addressText} spellCheck={false} autoComplete="off" onChange={(event) => editAddress(event.target.value)} />}
            </Field>
          </Flex>
          <Flex flex="2 1 12rem">
            <Field label="Token" error={tokenProblem}>
              {(id) => <TextInput id={id} placeholder="Token address, 0x…" value={tokenText} spellCheck={false} autoComplete="off" onChange={(event) => editToken(event.target.value)} />}
            </Field>
          </Flex>
          <Flex flex="1 1 9rem">
            <Field label="From date (UTC)">
              {(id) => <TextInput id={id} type="date" value={dateOfSeconds(filters.from)} onChange={(event) => onChange(restarted(filters, { from: secondsOfDate(event.target.value, "start") }))} />}
            </Field>
          </Flex>
          <Flex flex="1 1 9rem">
            <Field label="To date (UTC)">
              {(id) => <TextInput id={id} type="date" value={dateOfSeconds(filters.to)} onChange={(event) => onChange(restarted(filters, { to: secondsOfDate(event.target.value, "end") }))} />}
            </Field>
          </Flex>
          <Button type="button" size="sm" variant="outline" onClick={clear}>
            Clear filters
          </Button>
        </Flex>
      </form>

      {picksMessagesOnly(filters) ? (
        <Notice tone="info">
          Head updates are not listed while a filter on message kind, status, token or address is on, because a head update belongs to no message. Head updates are not missing.
        </Notice>
      ) : null}
      {connection === null ? <Notice tone="info">This page shows sample data, and the sample data has no history. Open the connection settings to set an indexer or chain endpoints.</Notice> : null}
      {query.error === null ? null : <Notice tone="error">The history did not load: {query.error.message}</Notice>}
      {reading?.source === "rpc" ? (
        <Notice tone="warning">
          Partial history. The indexer is not answering, so this list comes from the chains. It holds only sends, deliveries and head updates found in the blocks read, and a send shows a status only when its delivery was found.
          {reading.unappliedFilters.length === 0 ? "" : ` The chains cannot apply these filters, so they are off: ${reading.unappliedFilters.join(", ")}.`}
        </Notice>
      ) : null}

      {reading === undefined || reading.readBack.length === 0 ? null : (
        <Notice tone="info">
          {reading.readBack.map((entry) => `Read back to block ${entry.block} on ${chainNameOf(pair, entry.chainId)}.`).join(" ")} Older events are not listed.{" "}
          <Button size="xs" variant="outline" onClick={() => setMaximumBlocks(maximumBlocks + DEFAULT_MAXIMUM_BLOCKS)}>
            Read further back
          </Button>
        </Notice>
      )}

      <Panel title="Events">
        {connection !== null && reading === undefined && query.error === null ? <Text color="fg.muted" fontSize="sm">Loading…</Text> : null}
        {reading === undefined ? null : reading.page.items.length === 0 ? (
          <Text color="fg.muted" fontSize="sm">No events match these filters.</Text>
        ) : (
          <Box overflowX="auto">
            <Table.Root size="sm" aria-label="History events">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeader>Time</Table.ColumnHeader>
                  <Table.ColumnHeader>Event</Table.ColumnHeader>
                  <Table.ColumnHeader>Chain</Table.ColumnHeader>
                  <Table.ColumnHeader>Message or slot</Table.ColumnHeader>
                  <Table.ColumnHeader>Status</Table.ColumnHeader>
                  <Table.ColumnHeader>Transaction</Table.ColumnHeader>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {reading.page.items.map((event) => (
                  <EventRow key={`${event.kind}-${event.transactionHash}-${event.messageId ?? event.slot}`} event={event} chainName={chainNameOf(pair, event.chainId)} />
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        )}
        <Flex gap="2" marginTop="2">
          {filters.cursor === null ? null : (
            <Button size="sm" variant="outline" onClick={() => onChange({ ...filters, cursor: null })}>
              Newest events
            </Button>
          )}
          {nextCursor === null ? null : (
            <Button size="sm" variant="outline" onClick={() => onChange({ ...filters, cursor: parseHistoryCursor(nextCursor) })}>
              Older events
            </Button>
          )}
        </Flex>
      </Panel>
    </Flex>
  );
};
