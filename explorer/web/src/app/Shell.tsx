import { Box, Button, Flex, Text } from "@chakra-ui/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActionDialog, type FormDialogName } from "../actions/ActionDialogs";
import { CommandPalette } from "../search/CommandPalette";
import { browserStorage, loadRecent, rememberRecent } from "../search/recent-items";
import type { ActionId, SearchResult } from "../search/search-model";
import { useWallet } from "../wallet/wallet-port";
import { AddressView } from "../views/AddressView";
import { AuditView } from "../views/AuditView";
import { DocsView } from "../views/DocsView";
import { GlobalView } from "../views/GlobalView";
import { MessageView } from "../views/MessageView";
import { PairView } from "../views/pair/PairView";
import { ProverView } from "../views/ProverView";
import { ConnectionsView } from "../views/ConnectionsView";
import { Notice } from "../ui/primitives";
import { ActionsContext } from "./actions-context";
import { parseRoute, formatRoute, routeTitle, type Route } from "./route";
import { useServices } from "./services";
import { SettingsDialog } from "./SettingsDialog";
import { SourceBadge } from "./SourceBadge";
import { useThemeChoice } from "./theme";

const FORM_DIALOGS: Readonly<Record<string, FormDialogName>> = { bridge: "bridge", wrap: "wrap", "send-message": "message", claim: "claim" };

/** The route that the address bar holds now, and a function that changes it. */
const useHashRoute = (): readonly [Route, (next: Route) => void] => {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  const navigate = useCallback((next: Route): void => {
    window.location.hash = formatRoute(next);
  }, []);
  return [route, navigate];
};

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable;
};

/** Opens the palette with Ctrl+K, Command+K and the slash key, unless the viewer is typing in a field. */
const usePaletteShortcuts = (open: () => void): void => {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const chord = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !isTypingTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey;
      if (!chord && !slash) return;
      event.preventDefault();
      open();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);
};

const renderRoute = (route: Route) => {
  if (route.name === "global") return <GlobalView />;
  if (route.name === "pair") return <PairView key={`${route.pairId}-${route.token ?? "all"}`} pairId={route.pairId} initialToken={route.token} />;
  if (route.name === "audit") return <AuditView />;
  if (route.name === "prover") return <ProverView />;
  if (route.name === "settings") return <ConnectionsView />;
  if (route.name === "docs") return <DocsView slug={route.slug} heading={route.heading} />;
  if (route.name === "address") return <AddressView address={route.address} />;
  return <MessageView messageId={route.messageId} />;
};

const shortAccount = (account: string | null): string => (account === null ? "No wallet" : `${account.slice(0, 6)}…${account.slice(-4)}`);

/**
 * The frame of the page: the top bar with the one search field, the current view, and the palette and dialogs.
 * There is no menu. Everything that a menu holds is a result of the search.
 */
export const Shell = () => {
  const { configuration } = useServices();
  const wallet = useWallet();
  const [route, navigate] = useHashRoute();
  const { theme, setTheme } = useThemeChoice();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dialog, setDialog] = useState<FormDialogName | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [recent, setRecent] = useState<readonly SearchResult[]>(() => loadRecent(browserStorage()));
  const [notice, setNotice] = useState<string | null>(null);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcuts(openPalette);

  useEffect(() => {
    document.title = `${routeTitle(route)} · zk-bridge explorer`;
  }, [route]);

  const runAction = useCallback(
    async (action: ActionId): Promise<void> => {
      if (action.name === "settings") return setSettingsOpen(true);
      if (action.name === "theme") return setTheme(action.theme);
      const formDialog = FORM_DIALOGS[action.name];
      if (formDialog !== undefined) return setDialog(formDialog);
      try {
        if (action.name === "connect-wallet") await wallet.connect();
        if (action.name === "disconnect-wallet") wallet.disconnect();
        if (action.name === "switch-chain") await wallet.switchChain(action.chainId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [setTheme, wallet],
  );

  const select = useCallback(
    (result: SearchResult): void => {
      setRecent(rememberRecent(browserStorage(), result));
      setPaletteOpen(false);
      if (result.jump.type === "route") return navigate(result.jump.route);
      void runAction(result.jump.action);
    },
    [navigate, runAction],
  );

  const actionsPort = useMemo(() => ({ open: (name: FormDialogName) => setDialog(name) }), []);

  return (
    <ActionsContext.Provider value={actionsPort}>
      <Box minHeight="100vh" backgroundColor="bg" color="fg">
        <Flex as="header" position="sticky" top="0" zIndex="sticky" gap="3" alignItems="center" paddingX={{ base: "4", md: "6" }} paddingY="2" backgroundColor="bg" borderBottomWidth="1px" borderColor="border">
          <a href="#/" aria-label="zk-bridge explorer, global view">
            <Text as="span" fontWeight="bold" whiteSpace="nowrap">
              zk-bridge
            </Text>
          </a>
          <Button flex="1" justifyContent="space-between" variant="outline" size="sm" onClick={openPalette} aria-label="Search and jump (Control K or slash)" aria-haspopup="dialog">
            <Text as="span" color="fg.muted" truncate>
              Search or jump to…
            </Text>
            <Text as="kbd" fontSize="xs" color="fg.muted" display={{ base: "none", md: "inline" }}>
              Ctrl K
            </Text>
          </Button>
          <SourceBadge />
          <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap" display={{ base: "none", sm: "block" }}>
            {shortAccount(wallet.status === "connected" ? wallet.account : null)}
          </Text>
        </Flex>
        <Box as="main" paddingX={{ base: "4", md: "6" }} paddingY="4">
          {configuration.dataMode === "fixture" ? <Notice tone="warning">Sample data. Nothing here is real and no send reaches a chain.</Notice> : null}
          {notice === null ? null : (
            <Flex gap="2" alignItems="center" marginY="2">
              <Notice tone="error">{notice}</Notice>
              <Button size="xs" variant="ghost" onClick={() => setNotice(null)}>
                Dismiss
              </Button>
            </Flex>
          )}
          <Box marginTop="3">{renderRoute(route)}</Box>
        </Box>
        {paletteOpen ? <CommandPalette recent={recent} walletConnected={wallet.status === "connected"} onSelect={select} onClose={() => setPaletteOpen(false)} /> : null}
        {dialog === null ? null : <ActionDialog dialog={dialog} onClose={() => setDialog(null)} />}
        {settingsOpen ? <SettingsDialog theme={theme} onTheme={setTheme} onRecentCleared={() => setRecent([])} onClose={() => setSettingsOpen(false)} /> : null}
      </Box>
    </ActionsContext.Provider>
  );
};
