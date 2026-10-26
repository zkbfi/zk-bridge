import { Button, Flex } from "@chakra-ui/react";
import { FEED_STATUSES, type PairConfig, type TimeRange, type TokenInfo } from "@terminal/model/types";
import { countActiveFilters, EMPTY_FILTER, type FilterState } from "@terminal/model/filter-state";
import { STATUS_LABELS } from "../../ui/format";
import { Field, SelectInput, TextInput } from "../../ui/primitives";

/** Props of {@link FilterBar}. */
export type FilterBarProps = {
  readonly pair: PairConfig;
  readonly tokens: readonly TokenInfo[];
  readonly state: FilterState;
  readonly onChange: (next: FilterState) => void;
  /** The problem with the address text, or null. */
  readonly addressProblem: string | null;
};

const RANGES: readonly { readonly value: TimeRange; readonly label: string }[] = [
  { value: "all", label: "All time" },
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
];

const clearLabel = (active: number): string => {
  if (active === 0) return "Clear filters";
  return `Clear ${active} ${active === 1 ? "filter" : "filters"}`;
};

/**
 * The fixed header of the feed: direction, kind, status, token, address and time range. Every control has a label.
 *
 * @param props The pair, the tokens and the filter state.
 */
export const FilterBar = ({ pair, tokens, state, onChange, addressProblem }: FilterBarProps) => {
  const active = countActiveFilters(state);
  return (
    <form role="search" aria-label="Feed filters" onSubmit={(event) => event.preventDefault()}>
      <Flex gap="2" flexWrap="wrap" alignItems="flex-end">
        <Flex flex="1 1 9rem">
          <Field label="Direction">
            {(id) => (
              <SelectInput id={id} value={state.direction} onChange={(event) => onChange({ ...state, direction: event.target.value as FilterState["direction"] })}>
                <option value="all">Both directions</option>
                <option value="first-to-second">{pair.first.name} to {pair.second.name}</option>
                <option value="second-to-first">{pair.second.name} to {pair.first.name}</option>
              </SelectInput>
            )}
          </Field>
        </Flex>
        <Flex flex="1 1 7rem">
          <Field label="Kind">
            {(id) => (
              <SelectInput id={id} value={state.kind} onChange={(event) => onChange({ ...state, kind: event.target.value as FilterState["kind"] })}>
                <option value="all">All kinds</option>
                <option value="token">Token transfers</option>
                <option value="message">Messages</option>
              </SelectInput>
            )}
          </Field>
        </Flex>
        <Flex flex="1 1 8rem">
          <Field label="Status">
            {(id) => (
              <SelectInput id={id} value={state.status} onChange={(event) => onChange({ ...state, status: event.target.value as FilterState["status"] })}>
                <option value="all">Any status</option>
                {FEED_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {STATUS_LABELS[status]}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        </Flex>
        <Flex flex="1 1 8rem">
          <Field label="Token">
            {(id) => (
              <SelectInput id={id} value={state.token} onChange={(event) => onChange({ ...state, token: event.target.value })}>
                <option value="all">Any token</option>
                {tokens.map((token) => (
                  <option key={`${token.side}-${token.address}`} value={token.address}>
                    {token.symbol} ({token.side === "first" ? pair.first.name : pair.second.name})
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        </Flex>
        <Flex flex="2 1 12rem">
          <Field label="Address" error={addressProblem}>
            {(id) => <TextInput id={id} placeholder="Sender or recipient, 0x…" value={state.address} spellCheck={false} autoComplete="off" onChange={(event) => onChange({ ...state, address: event.target.value })} />}
          </Field>
        </Flex>
        <Flex flex="1 1 8rem">
          <Field label="Time range">
            {(id) => (
              <SelectInput id={id} value={state.range} onChange={(event) => onChange({ ...state, range: event.target.value as TimeRange })}>
                {RANGES.map((range) => (
                  <option key={range.value} value={range.value}>
                    {range.label}
                  </option>
                ))}
              </SelectInput>
            )}
          </Field>
        </Flex>
        <Button type="button" size="sm" variant="outline" disabled={active === 0} onClick={() => onChange(EMPTY_FILTER)}>
          {clearLabel(active)}
        </Button>
      </Flex>
    </form>
  );
};
