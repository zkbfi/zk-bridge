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
import { HistoryPage } from "../views/HistoryView";
import { EMPTY_HISTORY_FILTERS } from "../views/history-model";
import { MessageView } from "../views/MessageView";
import { PairView } from "../views/pair/PairView";
import { ProverView } from "../views/ProverView";
import { ConnectionsView } from "../views/ConnectionsView";
import { BrandMark } from "../ui/BrandMark";
import { Notice } from "../ui/primitives";
import { ActionsContext } from "./actions-context";
import { formatLocation, formatRoute, linkedFields, NO_OVERLAY, parseLocation, resolveHome, routeTitle, type Overlay, type PageLocation, type Route } from "./route";
import { useServices } from "./services";
import { SettingsDialog } from "./SettingsDialog";
import { SourceBadge } from "./SourceBadge";
import { useThemeChoice } from "./theme";

const FORM_DIALOGS: Readonly<Record<string, FormDialogName>> = { bridge: "bridge", wrap: "wrap", "send-message": "message" };

/** How a change reaches the history: a new entry (navigation, a dialog opening or closing) or in place (typing). */
type HistoryMode = "push" | "replace";

/**
 * The view and the dialog that the address bar holds now, and a function that changes them. The address is the only
 * state of the page (it runs from IPFS, so a link is all there is): every change writes the hash first. A hash with
 * no view opens the default pair in place, without a history entry.
 */
const useHashLocation = (defaultPairId: string): readonly [PageLocation, (next: PageLocation, mode?: HistoryMode) => void] => {
  const read = useCallback((): PageLocation => {
    const parsed = parseLocation(window.location.hash);
    const route = resolveHome(parsed.route, defaultPairId);
    if (route === parsed.route) return parsed;
    const resolved = { route, overlay: parsed.overlay };
    window.history.replaceState(window.history.state, "", formatLocation(resolved));
    return resolved;
  }, [defaultPairId]);
  const [location, setLocation] = useState<PageLocation>(read);
  useEffect(() => {
    const onChange = (): void => setLocation(read());
    window.addEventListener("hashchange", onChange);
    window.addEventListener("popstate", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
      window.removeEventListener("popstate", onChange);
    };
  }, [read]);
  const go = useCallback((next: PageLocation, mode: HistoryMode = "push"): void => {
    const hash = formatLocation(next);
    if (hash !== window.location.hash) {
      if (mode === "replace") window.history.replaceState(window.history.state, "", hash);
      else window.history.pushState(null, "", hash);
    }
    setLocation(next);
  }, []);
  return [location, go];
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

const renderRoute = (route: Route, navigate: (next: Route) => void, update: (next: Route) => void) => {
  if (route.name === "home" || route.name === "global") return <GlobalView />;
  if (route.name === "pair") return <PairView key={route.pairId} route={route} onChange={update} />;
  if (route.name === "audit") return <AuditView />;
  if (route.name === "prover") return <ProverView />;
  if (route.name === "settings") return <ConnectionsView />;
  if (route.name === "history") return <HistoryPage route={route} onNavigate={navigate} onUpdate={update} />;
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
  const { configuration, pair } = useServices();
  const wallet = useWallet();
  const [location, go] = useHashLocation(pair.id);
  const { route, overlay } = location;
  // The dialog a link opened, kept until that dialog closes, so the form can name the fields that came from the link.
  const [linkedOverlay, setLinkedOverlay] = useState<Overlay | null>(() => (location.overlay.dialog === null ? null : location.overlay));
  const navigate = useCallback((next: Route): void => go({ route: next, overlay: NO_OVERLAY }), [go]);
  const update = useCallback((next: Route): void => go({ route: next, overlay }, "replace"), [go, overlay]);
  const openDialog = useCallback((dialog: Overlay["dialog"]): void => {
    setLinkedOverlay(null);
    go({ route, overlay: dialog === null ? NO_OVERLAY : { ...NO_OVERLAY, dialog } });
  }, [go, route]);
  const { theme, setTheme } = useThemeChoice();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const dialog: FormDialogName | null = overlay.dialog === "settings" ? null : overlay.dialog;
  const settingsOpen = overlay.dialog === "settings";
  const [recent, setRecent] = useState<readonly SearchResult[]>(() => loadRecent(browserStorage()));
  const [notice, setNotice] = useState<string | null>(null);
  const openPalette = useCallback(() => setPaletteOpen(true), []);
  usePaletteShortcuts(openPalette);

  useEffect(() => {
    document.title = `${routeTitle(route)} · zk-bridge explorer`;
  }, [route]);

  const runAction = useCallback(
    async (action: ActionId): Promise<void> => {
      if (action.name === "settings") return openDialog("settings");
      if (action.name === "theme") return setTheme(action.theme);
      const formDialog = FORM_DIALOGS[action.name];
      if (formDialog !== undefined) return openDialog(formDialog);
      try {
        if (action.name === "connect-wallet") await wallet.connect();
        if (action.name === "disconnect-wallet") wallet.disconnect();
        if (action.name === "switch-chain") await wallet.switchChain(action.chainId);
      } catch (error) {
        setNotice(error instanceof Error ? error.message : String(error));
      }
    },
    [openDialog, setTheme, wallet],
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

  const actionsPort = useMemo(() => ({ open: (name: FormDialogName) => openDialog(name) }), [openDialog]);

  return (
    <ActionsContext.Provider value={actionsPort}>
      <Box minHeight="100vh" backgroundColor="bg" color="fg">
        <Flex as="header" position="sticky" top="0" zIndex="sticky" gap="3" alignItems="center" paddingX={{ base: "4", md: "6" }} paddingY="2" backgroundColor="bg" borderBottomWidth="1px" borderColor="border">
          <a href={formatRoute({ name: "pair", pairId: pair.id, token: null })} aria-label={`zk-bridge explorer, ${pair.id}`}>
            <Flex as="span" gap="2" alignItems="center">
              <Box as="span" color="#eb6834" display="inline-flex">
                <BrandMark />
              </Box>
              <Text as="span" fontWeight="bold" whiteSpace="nowrap">
                zk-bridge
              </Text>
            </Flex>
          </a>
          <Button flex="1" justifyContent="space-between" variant="outline" size="sm" onClick={openPalette} aria-label="Search and jump (Control K or slash)" aria-haspopup="dialog">
            <Text as="span" color="fg.muted" truncate>
              Search or jump to…
            </Text>
            <Text as="kbd" fontSize="xs" color="fg.muted" display={{ base: "none", md: "inline" }}>
              Ctrl K
            </Text>
          </Button>
          <a href={formatRoute({ name: "history", filters: EMPTY_HISTORY_FILTERS })}>
            <Text as="span" fontSize="sm" whiteSpace="nowrap">
              History
            </Text>
          </a>
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
          <Box marginTop="3">{renderRoute(route, navigate, update)}</Box>
        </Box>
        {paletteOpen ? <CommandPalette recent={recent} walletConnected={wallet.status === "connected"} onSelect={select} onClose={() => setPaletteOpen(false)} /> : null}
        {dialog === null ? null : (
          <ActionDialog
            dialog={dialog}
            overlay={overlay}
            onOverlay={(next) => go({ route, overlay: next }, "replace")}
            linked={linkedOverlay === null ? [] : linkedFields(linkedOverlay, wallet.status === "connected" ? wallet.account : null)}
            onClose={() => openDialog(null)}
          />
        )}
        {settingsOpen ? <SettingsDialog theme={theme} onTheme={setTheme} onRecentCleared={() => setRecent([])} onClose={() => openDialog(null)} /> : null}
      </Box>
    </ActionsContext.Provider>
  );
};
