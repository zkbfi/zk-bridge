import { Box, Flex, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Modal } from "../ui/Modal";
import { TextInput } from "../ui/primitives";
import { usePaletteSearch } from "./use-palette-search";
import { moveHighlight, type MoveKey, type SearchResult } from "./search-model";
import type { DocPage } from "../docs/docs-index";

/** Props of {@link CommandPalette}. */
export type CommandPaletteProps = {
  readonly recent: readonly SearchResult[];
  readonly walletConnected: boolean;
  /** Called with the result that the user picked. The caller jumps and closes. */
  readonly onSelect: (result: SearchResult) => void;
  readonly onClose: () => void;
  /** Replaces the documentation pages. Tests use it. */
  readonly docPages?: readonly DocPage[];
};

const MOVE_KEYS: readonly string[] = ["ArrowDown", "ArrowUp", "Home", "End"];

/**
 * The search and quick navigation. One field finds views, pairs, tokens, transfers by identifier or transaction hash,
 * addresses, actions and documentation. The arrow keys move through the results, Enter opens one, Escape closes.
 *
 * @param props The recent results, the wallet state and the handlers.
 */
export const CommandPalette = ({ recent, walletConnected, onSelect, onClose, docPages }: CommandPaletteProps) => {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputReference = useRef<HTMLInputElement>(null);
  const listId = useId();
  const search = usePaletteSearch({ query, recent, walletConnected, ...(docPages === undefined ? {} : { docPages }) });
  const active = search.flat[highlight] ?? null;
  const optionId = useCallback((result: SearchResult): string => `${listId}-${result.id}`, [listId]);

  useEffect(() => {
    if (active === null) return;
    document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" });
  }, [active, optionId]);

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (MOVE_KEYS.includes(event.key)) {
      event.preventDefault();
      setHighlight((current) => moveHighlight(current, search.flat.length, event.key as MoveKey));
      return;
    }
    if (event.key !== "Enter" || active === null) return;
    event.preventDefault();
    onSelect(active);
  };

  return (
    <Modal title="Search and jump" width="42rem" onClose={onClose} initialFocusReference={inputReference}>
      <TextInput
        ref={inputReference}
        role="combobox"
        aria-label="Search views, pairs, tokens, transfers, addresses, actions and docs"
        aria-expanded="true"
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={active === null ? undefined : optionId(active)}
        placeholder="Search a view, token, address, transaction hash, action or doc…"
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setHighlight(0);
        }}
        onKeyDown={onKeyDown}
      />
      <Box id={listId} role="listbox" aria-label="Results" marginTop="3" maxHeight="55vh" overflowY="auto">
        {search.groups.map((group) => (
          <Box key={group.id} role="group" aria-labelledby={`${listId}-group-${group.id}`} marginBottom="2">
            <Text id={`${listId}-group-${group.id}`} fontSize="xs" fontWeight="semibold" color="fg.muted" textTransform="uppercase" letterSpacing="wide" paddingX="2">
              {group.title}
            </Text>
            {group.results.map((result) => {
              const selected = active !== null && active.id === result.id;
              return (
                <Flex
                  key={result.id}
                  id={optionId(result)}
                  role="option"
                  aria-selected={selected}
                  direction="column"
                  paddingX="2"
                  paddingY="1.5"
                  borderRadius="md"
                  cursor="pointer"
                  backgroundColor={selected ? "bg.emphasized" : "transparent"}
                  _hover={{ backgroundColor: "bg.muted" }}
                  onMouseMove={() => setHighlight(search.flat.findIndex((candidate) => candidate.id === result.id))}
                  onClick={() => onSelect(result)}
                >
                  <Text fontSize="sm" fontWeight="medium" wordBreak="break-all">
                    {result.title}
                  </Text>
                  <Text fontSize="xs" color="fg.muted" wordBreak="break-all">
                    {result.subtitle}
                  </Text>
                </Flex>
              );
            })}
          </Box>
        ))}
        {search.groups.length === 0 && !search.loading ? (
          <Text fontSize="sm" color="fg.muted" paddingX="2">
            {search.problem ?? "Nothing matches. Try a token symbol, an address, a transaction hash or a word from the docs."}
          </Text>
        ) : null}
        {search.loading ? (
          <Text fontSize="sm" color="fg.muted" paddingX="2" role="status">
            Asking the indexer…
          </Text>
        ) : null}
        {search.groups.length > 0 && search.problem !== null ? (
          <Text fontSize="xs" color="fg.muted" paddingX="2" role="status">
            {search.problem}
          </Text>
        ) : null}
      </Box>
      <Text fontSize="xs" color="fg.muted" marginTop="2">
        Up and down move, Enter opens, Escape closes.
      </Text>
    </Modal>
  );
};
