import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useServices } from "./services";
import { clearRecent, browserStorage } from "../search/recent-items";
import type { ThemeChoice } from "../search/search-model";
import { Modal } from "../ui/Modal";
import { DataRow, Mono } from "../ui/primitives";

/** Props of {@link SettingsDialog}. */
export type SettingsDialogProps = {
  readonly theme: ThemeChoice;
  readonly onTheme: (theme: ThemeChoice) => void;
  readonly onRecentCleared: () => void;
  readonly onClose: () => void;
};

const THEME_LABELS: Readonly<Record<ThemeChoice, string>> = { light: "Light", dark: "Dark", system: "Follow the system" };

/**
 * Shows only the host of an endpoint. A URL can carry a path that the operator would rather not repeat on screen.
 *
 * @param url The URL text.
 */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return "not a valid URL";
  }
};

/**
 * The settings: the configuration that this page was built with, the theme, and the recent list.
 *
 * @param props The theme and the handlers.
 */
export const SettingsDialog = ({ theme, onTheme, onRecentCleared, onClose }: SettingsDialogProps) => {
  const { configuration, pair } = useServices();
  const rpcRows = [pair.first, pair.second].map((chain) => ({ chain, url: configuration.rpcUrls[chain.chainId] }));
  return (
    <Modal title="Settings" onClose={onClose}>
      <Box>
        <Text fontWeight="medium" marginBottom="1">
          Configuration
        </Text>
        <DataRow label="Data">{configuration.dataMode === "fixture" ? "sample data, nothing reaches a network" : "live"}</DataRow>
        <DataRow label="Pair">
          <Mono>{pair.id}</Mono>
        </DataRow>
        <DataRow label="Indexer">{configuration.dataMode === "fixture" ? "none" : hostOf(configuration.indexerUrl)}</DataRow>
        {rpcRows.map((row) => (
          <DataRow key={row.chain.chainId} label={`${row.chain.name} RPC`}>
            {row.url === undefined ? "not set" : hostOf(row.url)}
          </DataRow>
        ))}
        <Text fontSize="xs" color="fg.muted" marginTop="1">
          The page was built with these values. Change them in the build environment, not here. Only the host shows.
        </Text>
      </Box>
      <Box marginTop="4">
        <Text fontWeight="medium" marginBottom="1">
          Theme
        </Text>
        <Flex gap="2" role="group" aria-label="Theme">
          {(["light", "dark", "system"] as const).map((choice) => (
            <Button key={choice} size="sm" variant={theme === choice ? "solid" : "outline"} aria-pressed={theme === choice} onClick={() => onTheme(choice)}>
              {THEME_LABELS[choice]}
            </Button>
          ))}
        </Flex>
      </Box>
      <Box marginTop="4">
        <Text fontWeight="medium" marginBottom="1">
          Recent searches
        </Text>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            clearRecent(browserStorage());
            onRecentCleared();
          }}
        >
          Clear the recent list
        </Button>
      </Box>
    </Modal>
  );
};
