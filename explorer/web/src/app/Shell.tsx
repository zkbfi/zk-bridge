import { Box, Button, Flex, Text } from "@chakra-ui/react";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { ActivityScreen } from "../bridge/ActivityScreen";
import { BridgeScreen } from "../bridge/BridgeScreen";
import { Header } from "../bridge/Header";
import { Notice } from "../ui/primitives";
import { ActionsContext } from "./actions-context";
import { resolvePair } from "./route";
import { bridgeLinkedFields, formatLocation, formatRoute, linkedFields, NO_OVERLAY, parseLocation, resolveHome, routeTitle, type BridgeQuery, type Overlay, type PageLocation, type Route } from "./route";
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
const useHashLocation = (
  defaultPairId: string,
  onOutsideChange: (next: PageLocation) => void,
): readonly [PageLocation, (next: PageLocation, mode?: HistoryMode) => void, string | null] => {
  const outside = useRef(onOutsideChange);
  outside.current = onOutsideChange;
  // The pair the address asked for that this build does not have, for the notice.
  const unknownPair = useRef<string | null>(null);
  const read = useCallback((): PageLocation => {
    const parsed = parseLocation(window.location.hash);
    const paired = resolvePair(resolveHome(parsed.route, defaultPairId), defaultPairId);
    // Only set here: React's strict mode runs the first read twice, and the second sees the address already moved.
    if (paired.unknown !== null) unknownPair.current = paired.unknown;
    const route = paired.route;
    if (route === parsed.route) return parsed;
    const resolved = { route, overlay: parsed.overlay };
    window.history.replaceState(window.history.state, "", formatLocation(resolved));
    return resolved;
  }, [defaultPairId]);
  const [location, setLocation] = useState<PageLocation>(read);
  const [unknown, setUnknown] = useState<string | null>(() => unknownPair.current);
  useEffect(() => {
    // pushState and replaceState fire neither event, so every change seen here came from outside the page: the address
    // bar, a link, or Back and Forward.
    const onChange = (): void => {
      unknownPair.current = null;
      const next = read();
      setLocation(next);
      setUnknown(unknownPair.current);
      outside.current(next);
    };
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
  return [location, go, unknown];
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
  if (route.name === "home" || route.name === "global" || route.name === "explore") return <GlobalView />;
  if (route.name === "bridge") return null;
  if (route.name === "activity") return null;
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
  // The dialog a link opened (at load or later), kept until the user opens a dialog from inside the page, so the form
  // can name the fields that came from the link.
  const linkedOf = (next: PageLocation): Overlay | null => (next.overlay.dialog === null ? null : next.overlay);
  const [linkedOverlay, setLinkedOverlay] = useState<Overlay | null>(() => linkedOf(parseLocation(window.location.hash)));
  // The bridge form a link carried (at load, or whenever the address changes from outside the page). Beyond the route,
  // the token and the amount, every field it filled is named on the screen and in the review (see linkedFields).
  const linkedFormOf = (next: PageLocation): BridgeQuery | null => (next.route.name === "bridge" ? (next.route.form ?? null) : null);
  const [linkedForm, setLinkedForm] = useState<BridgeQuery | null>(() => linkedFormOf(parseLocation(window.location.hash)));
  const [location, go, unknownPair] = useHashLocation(pair.id, (next) => {
    setLinkedOverlay(linkedOf(next));
    setLinkedForm(linkedFormOf(next));
  });
  const { route, overlay } = location;
  const navigate = useCallback((next: Route): void => go({ route: next, overlay: NO_OVERLAY }), [go]);
  const update = useCallback((next: Route): void => go({ route: next, overlay }, "replace"), [go, overlay]);
  const openDialog = useCallback((dialog: Overlay["dialog"]): void => {
    setLinkedOverlay(null);
    go({ route, overlay: dialog === null ? NO_OVERLAY : { ...NO_OVERLAY, dialog } });
  }, [go, route]);
  const { theme, setTheme } = useThemeChoice();
  // The three screens slide sideways: Activity, Bridge, Explore. Arrow keys and a swipe move between them; the header
  // chevrons are links; the address follows (#/activity, #/bridge/<pair>, #/explore).
  const screenIndex = (name: Route["name"]): number => (name === "activity" ? 0 : name === "bridge" || name === "home" ? 1 : name === "explore" ? 2 : -1);
  const screenRoute = (index: number): Route => (index === 0 ? { name: "activity" } : index === 1 ? { name: "bridge", pairId: pair.id, dir: "first-to-second" } : { name: "explore" });
  const [previousIndex, setPreviousIndex] = useState(() => screenIndex(route.name));
  const currentIndex = screenIndex(route.name);
  const slideClass = previousIndex < 0 || currentIndex < 0 || previousIndex === currentIndex ? "" : currentIndex < previousIndex ? "zb-slide-left" : "zb-slide-right";
  useEffect(() => {
    const timer = setTimeout(() => setPreviousIndex(currentIndex), 200);
    return () => clearTimeout(timer);
  }, [currentIndex]);
  const step = useCallback((delta: number): void => {
    const at = screenIndex(route.name);
    if (at < 0) return;
    const next = at + delta;
    if (next < 0 || next > 2) return;
    navigate(screenRoute(next));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.name, navigate, pair.id]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (overlay.dialog !== null || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable || target.closest('[role="dialog"], [role="menu"], [role="slider"]') !== null)) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, overlay.dialog]);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const onTouchStart = (event: React.TouchEvent): void => {
    const touch = event.touches[0];
    touchStart.current = touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
  };
  const onTouchEnd = (event: React.TouchEvent): void => {
    const start = touchStart.current;
    const touch = event.changedTouches[0];
    touchStart.current = null;
    if (start === null || touch === undefined) return;
    const dx = touch.clientX - start.x;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(touch.clientY - start.y)) step(dx > 0 ? -1 : 1);
  };
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
      <Box className="zb" minHeight="100vh" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
        <Header
          page={routeTitle(route)}
          homeHref={formatRoute({ name: "bridge", pairId: pair.id, dir: "first-to-second" })}
          screenHref={(screen) => (screen === "Bridge" ? formatRoute({ name: "bridge", pairId: pair.id, dir: "first-to-second" }) : `#/${screen.toLowerCase()}`)}
          onSearch={openPalette}
        />
        {route.name === "activity" ? (
          <div key="activity" className={slideClass}>
            <ActivityScreen />
          </div>
        ) : route.name === "bridge" ? (
          <div key="bridge" className={slideClass}>
          {unknownPair === null ? null : (
            <p className="zb-notice" role="status">
              {unknownPair} isn't available here; showing {pair.label}
            </p>
          )}
          <BridgeScreen
            route={route}
            onRoute={update}
            fixture={configuration.dataMode === "fixture"}
            linked={linkedForm === null ? [] : bridgeLinkedFields(linkedForm, wallet.status === "connected" ? wallet.account : null)}
          />
          </div>
        ) : (
        <Box as="main" paddingX={{ base: "4", md: "6" }} paddingY="4">
          <Flex gap="3" alignItems="center" justifyContent="flex-end" flexWrap="wrap" marginBottom="2">
            <a href={formatRoute({ name: "history", filters: EMPTY_HISTORY_FILTERS })}>
              <Text as="span" fontSize="sm" whiteSpace="nowrap">
                History
              </Text>
            </a>
            <SourceBadge />
            <Text fontSize="sm" color="fg.muted" whiteSpace="nowrap">
              {shortAccount(wallet.status === "connected" ? wallet.account : null)}
            </Text>
          </Flex>
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
        )}
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
