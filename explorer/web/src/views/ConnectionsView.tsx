import { Box, Button, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { useState, useSyncExternalStore } from "react";
import { describeSetting, type ConnectionRuntime } from "@terminal/data/connection-runtime";
import type { PairConfig } from "@terminal/model/types";
import { parseConnectionUrl, redactConnectionText, type ConnectionSettings, type ResolvedConnection, type ResolvedSetting } from "@zk-bridge/shared";
import { useServices } from "../app/services";
import { saveUserConnections, type ConnectionStorage } from "../config/connection-storage";
import { browserStorage } from "../search/recent-items";
import { Field, Notice, Panel, TextInput } from "../ui/primitives";

/** One URL that the page can set: the indexer, or the RPC URL of one chain. */
export type ConnectionTarget =
  | { readonly kind: "indexer"; readonly label: string }
  | { readonly kind: "rpc"; readonly label: string; readonly chainId: number };

/**
 * The targets of a pair, in the order of the page: the indexer, then each chain.
 *
 * @param pair The pair.
 */
export const connectionTargets = (pair: PairConfig): readonly ConnectionTarget[] => [
  { kind: "indexer", label: "Indexer URL" },
  ...[pair.first, pair.second].map((chain): ConnectionTarget => ({ kind: "rpc", label: `${chain.name} RPC URL`, chainId: chain.chainId })),
];

/** The setting in force for a target. */
export const settingOf = (resolved: ResolvedConnection, target: ConnectionTarget): ResolvedSetting | null =>
  target.kind === "indexer" ? resolved.indexerUrl : (resolved.rpcUrls[target.chainId] ?? null);

/** The URL that the user set for a target, or null. */
export const userUrlOf = (user: ConnectionSettings, target: ConnectionTarget): string | null =>
  target.kind === "indexer" ? user.indexerUrl : (user.rpcUrls[target.chainId] ?? null);

/**
 * The user settings with one URL set. Other entries stay.
 *
 * @param user The settings now.
 * @param target The target.
 * @param url The new URL, already checked.
 */
export const withUserUrl = (user: ConnectionSettings, target: ConnectionTarget, url: string): ConnectionSettings =>
  target.kind === "indexer" ? { ...user, indexerUrl: url } : { ...user, rpcUrls: { ...user.rpcUrls, [target.chainId]: url } };

/**
 * The user settings with one entry removed. Other entries stay.
 *
 * @param user The settings now.
 * @param target The target.
 */
export const withoutUserUrl = (user: ConnectionSettings, target: ConnectionTarget): ConnectionSettings =>
  target.kind === "indexer"
    ? { ...user, indexerUrl: null }
    : { ...user, rpcUrls: Object.fromEntries(Object.entries(user.rpcUrls).filter(([chainId]) => Number(chainId) !== target.chainId)) };

type Message = { readonly tone: "info" | "error"; readonly text: string };

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
  const purpose = target.kind === "indexer" ? "indexer" : "rpc";
  const userUrl = userUrlOf(runtime.user(), target);

  /** Every text that reaches the screen loses the typed URL and every URL in force. */
  const show = (tone: Message["tone"], text: string): void => setMessage({ tone, text: runtime.redact(redactConnectionText(text, [typed])) });

  const testUrl = (url: string) => (target.kind === "indexer" ? runtime.testIndexer(url) : runtime.testRpcUrl(target.chainId, url));

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

  const onSave = async (): Promise<void> => {
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
          <Button size="sm" variant="outline" disabled={busy || typed.trim() === ""} onClick={() => void onTest()}>
            Test
          </Button>
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

/** What a viewer must know about where the browser keeps these URLs. */
export const STORAGE_WARNING =
  "The browser keeps these URLs in its local storage in clear text. Anyone who can use this browser profile can read them. Use a URL with an API key only if you can replace that key.";

/** Props of {@link ConnectionsView}. */
export type ConnectionsViewProps = {
  /** Replaces the browser storage. Tests use it. */
  readonly storage?: ConnectionStorage | null;
};

const LiveConnections = ({ runtime, pair, storage }: { readonly runtime: ConnectionRuntime; readonly pair: PairConfig; readonly storage: ConnectionStorage | null }) => {
  const resolved = useSyncExternalStore(runtime.subscribe, runtime.resolved);
  const label = useSyncExternalStore(runtime.subscribe, () => runtime.redact(runtime.source().label));
  const [storageFailed, setStorageFailed] = useState(false);
  const [checking, setChecking] = useState(false);

  const onChange = (next: ConnectionSettings): void => {
    setStorageFailed(!saveUserConnections(storage, next).saved);
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
      {storageFailed ? <Notice tone="warning">The browser did not keep your setting. It works only until the page closes.</Notice> : null}
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
