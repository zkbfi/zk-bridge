import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useState, useSyncExternalStore } from "react";
import { describeSetting, type ConnectionRuntime } from "@terminal/data/connection-runtime";
import type { PairConfig } from "@terminal/model/types";
import { boardUrlOf, normalizeEndpoint, parseConnectionUrl, redactConnectionText, type EndpointKey, type ConnectionSettings, type ResolvedConnection, type ResolvedSetting } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import { saveUserConnections, type ConnectionStorage, type SaveReason } from "../config/connection-storage";
import { originIsShared } from "../config/shared-origin";
import { browserStorage } from "../search/recent-items";
import { Field, Notice, Panel, TextInput } from "../ui/primitives";

/** One URL that the page can set: the indexer, the RPC URL of one chain, or one of the other endpoints. */
export type ConnectionTarget =
  | { readonly kind: "indexer"; readonly label: string }
  | { readonly kind: "board"; readonly label: string; readonly chainId: number }
  | { readonly kind: "endpoint"; readonly label: string; readonly key: EndpointKey }
  | { readonly kind: "rpc"; readonly label: string; readonly chainId: number };

/** The endpoints beside the indexer, in the order of the page. */
const ENDPOINT_TARGETS: readonly ConnectionTarget[] = [
  { kind: "endpoint", label: "Backend URL", key: "backendUrl" },
  { kind: "endpoint", label: "Msgboard indexer URL", key: "msgboardIndexerUrl" },
  { kind: "endpoint", label: "Archive URL", key: "archiveUrl" },
];

/**
 * The targets of a pair, in the order of the page: the indexer, then each chain, then the other endpoints.
 *
 * @param pair The pair.
 */
export const connectionTargets = (pair: PairConfig): readonly ConnectionTarget[] => [
  { kind: "indexer", label: "Indexer URL" },
  ...[pair.first, pair.second].map((chain): ConnectionTarget => ({ kind: "rpc", label: `${chain.name} RPC URL`, chainId: chain.chainId })),
  ...ENDPOINT_TARGETS,
  // The msgboard node is set per chain (owner, quote 87).
  ...[pair.first, pair.second].map((chain): ConnectionTarget => ({ kind: "board", label: `${chain.name} msgboard node URL`, chainId: chain.chainId })),
];

/** The setting in force for a target. */
export const settingOf = (resolved: ResolvedConnection, target: ConnectionTarget): ResolvedSetting | null => {
  if (target.kind === "endpoint") return resolved[target.key];
  if (target.kind === "board") return boardUrlOf(resolved, target.chainId);
  return target.kind === "indexer" ? resolved.indexerUrl : (resolved.rpcUrls[target.chainId] ?? null);
};

/** The URL that the user set for a target, or null. */
export const userUrlOf = (user: ConnectionSettings, target: ConnectionTarget): string | null => {
  if (target.kind === "endpoint") return user[target.key] ?? null;
  if (target.kind === "board") return user.msgboardUrls?.[target.chainId] ?? user.msgboardUrl ?? null;
  return target.kind === "indexer" ? user.indexerUrl : (user.rpcUrls[target.chainId] ?? null);
};

/**
 * The user settings with one URL set. Other entries stay.
 *
 * @param user The settings now.
 * @param target The target.
 * @param url The new URL, already checked.
 */
export const withUserUrl = (user: ConnectionSettings, target: ConnectionTarget, url: string): ConnectionSettings => {
  if (target.kind === "endpoint") return { ...user, [target.key]: url };
  if (target.kind === "board") return { ...user, msgboardUrls: { ...user.msgboardUrls, [target.chainId]: url } };
  return target.kind === "indexer" ? { ...user, indexerUrl: url } : { ...user, rpcUrls: { ...user.rpcUrls, [target.chainId]: url } };
};

/**
 * The user settings with one entry removed. Other entries stay.
 *
 * @param user The settings now.
 * @param target The target.
 */
export const withoutUserUrl = (user: ConnectionSettings, target: ConnectionTarget): ConnectionSettings => {
  if (target.kind === "endpoint") return { ...user, [target.key]: null };
  if (target.kind === "board") return { ...user, msgboardUrls: Object.fromEntries(Object.entries(user.msgboardUrls ?? {}).filter(([chainId]) => Number(chainId) !== target.chainId)) };
  return target.kind === "indexer"
    ? { ...user, indexerUrl: null }
    : { ...user, rpcUrls: Object.fromEntries(Object.entries(user.rpcUrls).filter(([chainId]) => Number(chainId) !== target.chainId)) };
};

type Message = { readonly tone: "info" | "error" | "warning"; readonly text: string };

type RowProps = {
  readonly runtime: ConnectionRuntime;
  readonly target: ConnectionTarget;
  readonly resolved: ResolvedConnection;
  /** Keeps the new settings and puts them in use. */
  readonly onChange: (next: ConnectionSettings) => void;
};

const ConnectionRow = ({ runtime, target, resolved, onChange }: RowProps) => {
  const [typed, setTyped] = useState("");
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const purpose = target.kind === "rpc" ? "rpc" : "indexer";
  const userUrl = userUrlOf(runtime.user(), target);

  /** Every text that reaches the screen loses the typed URL and every URL in force. */
  const show = (tone: Message["tone"], text: string): void => setMessage({ tone, text: runtime.redact(redactConnectionText(text, [typed])) });

  const testUrl = (url: string) => (target.kind === "rpc" ? runtime.testRpcUrl(target.chainId, url) : runtime.testIndexer(url));

  const runBusy = async <value,>(work: () => Promise<value>): Promise<value> => {
    setBusy(true);
    try {
      return await work();
    } finally {
      setBusy(false);
    }
  };

  const onTest = async (): Promise<void> => {
    const outcome = await runBusy(() => testUrl(typed));
    show(outcome.ok === "pass" ? "info" : "error", outcome.message);
  };

  /** An endpoint keeps its path prefix, loses one trailing slash and warns about plain http on a secure page. */
  const onSaveEndpoint = (key: EndpointKey): void => {
    const normalized = normalizeEndpoint({ text: typed, pageProtocol: window.location.protocol === "https:" ? "https:" : "http:" });
    if (!normalized.ok) return show("error", normalized.reason);
    onChange(withUserUrl(runtime.user(), { kind: "endpoint", label: target.label, key }, normalized.url));
    setTyped("");
    if (normalized.warning === null) return setMessage({ tone: "info", text: "Saved. The page uses this URL now." });
    setMessage({ tone: "warning", text: INSECURE_ENDPOINT_WARNING });
  };

  /** A board node is an endpoint too, set for one chain. */
  const onSaveBoard = (board: Extract<ConnectionTarget, { kind: "board" }>): void => {
    const normalized = normalizeEndpoint({ text: typed, pageProtocol: window.location.protocol === "https:" ? "https:" : "http:" });
    if (!normalized.ok) return show("error", normalized.reason);
    onChange(withUserUrl(runtime.user(), board, normalized.url));
    setTyped("");
    setMessage(normalized.warning === null ? { tone: "info", text: "Saved. The page uses this URL now." } : { tone: "warning", text: INSECURE_ENDPOINT_WARNING });
  };

  const onSave = async (): Promise<void> => {
    if (target.kind === "endpoint") return onSaveEndpoint(target.key);
    if (target.kind === "board") return onSaveBoard(target);
    const parsed = parseConnectionUrl(typed, purpose);
    if (!parsed.ok) return show("error", parsed.message);
    if (target.kind === "rpc") {
      const outcome = await runBusy(() => testUrl(parsed.url));
      if (outcome.ok !== "pass") return show("error", `Not saved. ${outcome.message}`);
    }
    onChange(withUserUrl(runtime.user(), target, parsed.url));
    setTyped("");
    setMessage({ tone: "info", text: "Saved. The page uses this URL now." });
  };

  const onForget = (): void => {
    onChange(withoutUserUrl(runtime.user(), target));
    setTyped("");
    setMessage({ tone: "info", text: "Your setting is gone. The page uses the next source." });
  };

  return (
    <Panel title={target.label} level={3}>
      <Stack gap="2">
        <Text fontSize="sm">
          In force: <span>{describeSetting(settingOf(resolved, target))}</span>
        </Text>
        <Field label={`New ${target.label}`} hint="The value stays hidden while you type.">
          {(controlId) => (
            <TextInput id={controlId} type="password" autoComplete="off" spellCheck={false} value={typed} onChange={(event) => setTyped(event.target.value)} />
          )}
        </Field>
        <Flex gap="2" flexWrap="wrap">
          {target.kind === "endpoint" || target.kind === "board" ? null : (
            <Button size="sm" variant="outline" disabled={busy || typed.trim() === ""} onClick={() => void onTest()}>
              Test
            </Button>
          )}
          <Button size="sm" disabled={busy || typed.trim() === ""} onClick={() => void onSave()}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={busy || userUrl === null} onClick={onForget}>
            Forget my setting
          </Button>
        </Flex>
        {message === null ? null : <Notice tone={message.tone}>{message.text}</Notice>}
      </Stack>
    </Panel>
  );
};

/** What a viewer must know when an endpoint uses plain http and the page uses https. */
export const INSECURE_ENDPOINT_WARNING =
  "Saved, but this page uses https and the URL uses plain http. The browser blocks the request, so the endpoint will not answer. Use an https URL.";

/** What a viewer must know about where the browser keeps these URLs. */
export const STORAGE_WARNING =
  "The browser keeps these URLs in its local storage in clear text. Anyone who can use this browser profile can read them. Use a URL with an API key only if you can replace that key.";

/** What a viewer must know when other sites share the origin of this page, as on a path-style IPFS gateway. */
export const SHARED_ORIGIN_NOTICE =
  "This page runs on a path-style gateway, so other sites on the same gateway share its browser storage and could change what it keeps. For that reason the page keeps your settings for this visit only and writes nothing. A gateway with a subdomain for each release, such as https://<content address>.ipfs.<gateway host>/, gives this page its own storage.";

/** What a viewer must know when a URL looks like it holds a key and the page did not write it. */
export const KEY_LIKE_NOTICE =
  "A URL that looks like it holds a key was not written to the browser storage, because the storage is clear text. The page uses it until the page closes.";

/** The notice for a save that did not keep everything, or null when nothing needs saying. The shared-origin notice is always on show. */
const saveNotice = (reason: SaveReason): string | null => {
  if (reason === "stored" || reason === "shared-origin") return null;
  return reason === "key-like-url" ? KEY_LIKE_NOTICE : "The browser did not keep your setting. It works only until the page closes.";
};

/** Props of {@link ConnectionsView}. */
export type ConnectionsViewProps = {
  /** Replaces the browser storage. Tests use it. */
  readonly storage?: ConnectionStorage | null;
};

const LiveConnections = ({ runtime, pair, storage }: { readonly runtime: ConnectionRuntime; readonly pair: PairConfig; readonly storage: ConnectionStorage | null }) => {
  const resolved = useSyncExternalStore(runtime.subscribe, runtime.resolved);
  const label = useSyncExternalStore(runtime.subscribe, () => runtime.redact(runtime.source().label));
  const [saveReason, setSaveReason] = useState<SaveReason>("stored");
  const shared = originIsShared(window.location);
  const [checking, setChecking] = useState(false);

  const onChange = (next: ConnectionSettings): void => {
    setSaveReason(saveUserConnections(storage, next).reason);
    runtime.apply(next);
  };

  const checkNow = async (): Promise<void> => {
    setChecking(true);
    try {
      await runtime.connection().checkNow();
    } finally {
      setChecking(false);
    }
  };

  return (
    <Stack gap="3">
      <Notice tone="warning">{STORAGE_WARNING}</Notice>
      {shared ? <Notice tone="warning">{SHARED_ORIGIN_NOTICE}</Notice> : null}
      {saveNotice(saveReason) === null ? null : <Notice tone="warning">{saveNotice(saveReason)}</Notice>}
      <Flex gap="3" alignItems="center" flexWrap="wrap">
        <Text role="status">Using: {label}</Text>
        <Button size="sm" variant="outline" disabled={checking} onClick={() => void checkNow()}>
          Check the indexer now
        </Button>
      </Flex>
      {connectionTargets(pair).map((target) => (
        <ConnectionRow key={target.label} runtime={runtime} target={target} resolved={resolved} onChange={onChange} />
      ))}
    </Stack>
  );
};

/**
 * The connections page. The indexer is the first source. When it cannot answer, the page reads the chains through the
 * RPC URLs. Both kinds of URL can be set here. A URL shows only in its masked form, because it can hold an API key.
 *
 * @param props The storage, for tests.
 */
export const ConnectionsView = ({ storage }: ConnectionsViewProps) => {
  const { connection, pair } = useServices();
  return (
    <Box>
      <Heading as="h1" size="lg" marginBottom="1">
        Connections
      </Heading>
      <Text color="fg.muted" marginBottom="3">
        The page asks the indexer first. If the indexer is down or behind the chains, it falls back to the RPC URLs below.
      </Text>
      {connection === null ? (
        <Notice tone="info">Sample data uses no connections.</Notice>
      ) : (
        <LiveConnections runtime={connection} pair={pair} storage={storage === undefined ? browserStorage() : storage} />
      )}
    </Box>
  );
};
