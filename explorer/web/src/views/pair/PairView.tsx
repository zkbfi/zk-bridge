import { Box, Button, Grid, Stack, Text } from "@chakra-ui/react";
import { useMemo, useState } from "react";
import { useFeed, useHeads, useSnapshots, useSummary, useTokens } from "../../app/queries";
import { useServices } from "../../app/services";
import { formatTimestamp } from "../../ui/format";
import { Notice, Panel } from "../../ui/primitives";
import { useWallet } from "../../wallet/wallet-port";
import { ActionArea } from "./ActionArea";
import { FeedTable } from "./FeedTable";
import { EMPTY_FILTER, filterForToken, validateFilter, type FilterState } from "./filter-model";
import { FilterBar } from "./FilterBar";
import { HeadsFooter } from "./HeadsFooter";
import { SummaryBar } from "./SummaryBar";

/** Props of {@link PairView}. */
export type PairViewProps = {
  readonly pairId: string;
  /** A token address to filter the feed to when the view opens, or null. */
  readonly initialToken: string | null;
};

const PAGE_SIZE = 50;

/**
 * The pair view: summary across the top, the action area on the left, the filter bar and the feed on the right, and the
 * light client heads in the footer.
 *
 * @param props The pair name and an optional starting token.
 */
export const PairView = ({ pairId, initialToken }: PairViewProps) => {
  const { pair, now } = useServices();
  const wallet = useWallet();
  const [filterState, setFilterState] = useState<FilterState>(initialToken === null ? EMPTY_FILTER : filterForToken(initialToken));
  const [limit, setLimit] = useState(PAGE_SIZE);
  const clock = now();
  // The time range moves once a minute, so the feed query does not change on every render.
  const filterClock = Math.floor(clock / 60) * 60;
  const validated = useMemo(() => validateFilter(filterState, filterClock), [filterState, filterClock]);
  const summary = useSummary(pairId);
  const heads = useHeads(pairId);
  const feed = useFeed(pairId, validated.filter, limit);
  const tokens = useTokens(pairId);
  const snapshots = useSnapshots(wallet.status === "connected" ? wallet.account : null, pairId);

  if (pairId !== pair.id) {
    return <Notice tone="warning">This page is set up for the pair {pair.id}. It has no data for {pairId}.</Notice>;
  }
  return (
    <Stack gap="3" height={{ base: "auto", lg: "calc(100vh - 8rem)" }}>
      <Panel title="Summary">
        <SummaryBar pair={pair} summary={summary.data} error={summary.error?.message ?? null} now={clock} />
      </Panel>
      <Grid templateColumns={{ base: "1fr", lg: "minmax(18rem, 22rem) minmax(0, 1fr)" }} gap="3" flex="1" minHeight="0" alignItems="start">
        <Box overflowY={{ base: "visible", lg: "auto" }} maxHeight={{ base: "none", lg: "100%" }}>
          <ActionArea pair={pair} snapshots={snapshots.data} snapshotError={snapshots.error?.message ?? null} />
        </Box>
        <Box overflowY={{ base: "visible", lg: "auto" }} maxHeight={{ base: "none", lg: "100%" }} borderWidth="1px" borderColor="border" borderRadius="lg" backgroundColor="bg.subtle">
          <Box position="sticky" top={{ base: "3.5rem", lg: "0" }} zIndex="sticky" backgroundColor="bg.subtle" padding="3" borderBottomWidth="1px" borderColor="border">
            <FilterBar pair={pair} tokens={tokens.data ?? []} state={filterState} onChange={(next) => { setFilterState(next); setLimit(PAGE_SIZE); }} addressProblem={validated.addressProblem} />
          </Box>
          <Box padding="3">
            {feed.error === null ? null : <Notice tone="warning">The feed did not refresh ({feed.error.message}). The rows are the last good ones.</Notice>}
            {feed.data?.coveredFrom === undefined ? null : (
              <Text fontSize="xs" color="fg.muted" marginBottom="2">
                RPC fallback: history since {formatTimestamp(feed.data.coveredFrom)} UTC
              </Text>
            )}
            {feed.data === undefined ? <Text color="fg.muted">Loading the feed…</Text> : <FeedTable pair={pair} items={feed.data.items} />}
            {feed.data?.hasMore === true ? (
              <Button marginTop="2" variant="outline" size="sm" onClick={() => setLimit(limit + PAGE_SIZE)}>
                Show older rows
              </Button>
            ) : null}
          </Box>
        </Box>
      </Grid>
      <HeadsFooter pair={pair} heads={heads.data} now={clock} />
    </Stack>
  );
};
