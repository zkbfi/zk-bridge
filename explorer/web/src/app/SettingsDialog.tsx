import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ICON_CREDIT } from "../bridge/icons";
import { maskUrl, migrateBoardUrls, redactConnectionText, type ConnectionSettings } from "@zk-bridge/shared";
import { DEFAULT_AUTO_CAP_PERCENT, DEFAULT_HARD_CAP_PERCENT, feeCapProblem, loadFeeCap, loadHardCap, saveFeeCap, saveHardCap } from "../bridge/fee-cap";
import { loadImageServer, saveImageServer } from "../bridge/image-server";
import { Sheet } from "../bridge/Sheet";
import { TokenIcon } from "../bridge/TokenIcon";
import { loadUserConnections, saveUserConnections, type ConnectionStorage, type SaveReason } from "../config/connection-storage";
import { findSecretLikeValues } from "../config/secret-scan";
import { originIsShared } from "../config/shared-origin";
import { clearRecent, browserStorage } from "../search/recent-items";
import type { ThemeChoice } from "../search/search-model";
import { INSECURE_ENDPOINT_WARNING, KEY_LIKE_NOTICE } from "../views/ConnectionsView";
import { useServices } from "./services";
import { currentValues, defaultValues, fieldProblem, pageProtocolOf, settingFields, settingsFromDrafts, textOf, type FieldValues, type SettingField } from "./settings-model";
import { useServiceProbe } from "./use-service-probe";

/** Props of {@link SettingsDialog}. */
export type SettingsDialogProps = {
  readonly theme: ThemeChoice;
  readonly onTheme: (theme: ThemeChoice) => void;
  readonly onRecentCleared: () => void;
  readonly onClose: () => void;
  /** Where the connection settings live. Tests pass their own. */
  readonly storage?: ConnectionStorage | null;
  /** The page's location, for its protocol and whether a gateway shares its origin. Tests pass their own. */
  readonly location?: Pick<Location, "protocol" | "hostname" | "pathname">;
};

const THEMES: readonly (readonly [ThemeChoice, string])[] = [
  ["system", "System"],
  ["light", "Light"],
  ["dark", "Dark"],
  ["mono", "Mono"],
];

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

const NO_SUBSCRIPTION = () => () => undefined;

/** The value after it has stopped changing for a moment, so a live check does not run on every key. */
const useSettled = (value: string, milliseconds = 600): string => {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), milliseconds);
    return () => clearTimeout(timer);
  }, [value, milliseconds]);
  return settled;
};

/** The live check of one field: a dot and the latency, "down", or nothing to check. */
const Check = ({ field, url }: { readonly field: SettingField; readonly url: string | null }) => {
  const state = useServiceProbe(url, field.probe);
  if (url === null) return null;
  const text = state.ok === null ? "…" : state.ok ? (field.probe.kind === "image" ? "ok" : `${state.ms} ms`) : "down";
  return (
    <span className="zb-ok" data-ok={state.ok === null ? "wait" : String(state.ok)} title={state.ok === false ? state.reason : undefined} role="status" aria-label={`${field.label}: ${state.ok === null ? "checking" : state.ok ? `ok, ${text}` : "down"}`}>
      <i aria-hidden="true" />
      {text}
    </span>
  );
};

const ResetIcon = () => (
  <svg viewBox="0 0 16 16" className="zb-icon" aria-hidden="true" focusable="false">
    <path d="M3.5 6.5A5 5 0 1 1 3 9.5M3.5 2.5v4h4" />
  </svg>
);

type FieldProps = {
  readonly field: SettingField;
  readonly value: string;
  readonly defaultValue: string;
  readonly problem: string | undefined;
  readonly onChange: (value: string) => void;
};

/** One endpoint: the chain icon or the service name, the URL, its live check, and a reset when it differs from the default. */
const Field = ({ field, value, defaultValue, problem, onChange }: FieldProps) => {
  const [focused, setFocused] = useState(false);
  const settled = useSettled(value.trim());
  const checkable = settled !== "" && fieldProblem(field, settled, defaultValue) === null ? settled : null;
  // A URL that looks like it holds a key shows masked until the field is in use.
  const masked = !focused && value !== "" && findSecretLikeValues({ url: value }).length > 0;
  return (
    <>
      <div className="zb-fld" data-problem={problem === undefined ? undefined : "true"}>
        {field.chainId === undefined ? <span className="zb-fld-k">{field.short ?? field.label}</span> : <TokenIcon subject={{ chainId: field.chainId }} symbol="" size={18} decorative />}
        <input
          aria-label={field.label}
          aria-invalid={problem === undefined ? undefined : true}
          spellCheck={false}
          autoComplete="off"
          inputMode="url"
          placeholder="not set"
          value={masked ? maskUrl(value) : value}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(event) => onChange(event.target.value)}
        />
        <Check field={field} url={checkable} />
        {value.trim() === defaultValue ? null : (
          <button type="button" className="zb-fld-reset" aria-label={`Reset ${field.label}`} title="Back to the default" onClick={() => onChange(defaultValue)}>
            <ResetIcon />
          </button>
        )}
      </div>
      {problem === undefined ? null : (
        <p className="zb-fld-err" role="alert">
          {problem}
        </p>
      )}
    </>
  );
};

/**
 * A fee cap in percent: the name on the left, the number right-justified against its % (owner, quote 86: "the input be
 * justified to the right, next to the units").
 */
const CapField = ({ id, label, value, problem, onChange }: { readonly id: string; readonly label: string; readonly value: string; readonly problem: string | undefined; readonly onChange: (value: string) => void }) => (
  <>
    <div className="zb-fld zb-fld-cap" data-problem={problem === undefined ? undefined : "true"} data-field={id}>
      <span className="zb-fld-k zb-fld-k-wide">{label}</span>
      <input aria-label={`${label} (%)`} aria-invalid={problem === undefined ? undefined : true} inputMode="decimal" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
      <span className="zb-fld-unit">% of the amount</span>
    </div>
    {problem === undefined ? null : (
      <p className="zb-fld-err" role="alert">
        {problem}
      </p>
    )}
  </>
);

/** What to say after a save that the browser did not fully keep, or null. */
export const keptNotice = (reason: SaveReason): string | null => {
  if (reason === "stored") return null;
  if (reason === "shared-origin") return "This gateway is shared with other sites, so your settings last for this visit only.";
  if (reason === "key-like-url") return KEY_LIKE_NOTICE;
  return "The browser did not keep your settings; they last until the page closes.";
};

/**
 * The settings (mockup pulse-v5.html, the "settings" panel; spec "Settings (owner)" and "Every endpoint is
 * swappable"): the theme, an RPC and a beacon API per chain, the image server and every other outside service, each with its default,
 * a live check and a reset; then the fee cap and the recent list. One Save keeps them all.
 *
 * @param props The theme and the handlers.
 */
export const SettingsDialog = ({ theme, onTheme, onRecentCleared, onClose, storage: storageProp, location = window.location }: SettingsDialogProps) => {
  const { configuration, pair, connection, probe } = useServices();
  const storage = storageProp === undefined ? browserStorage() : storageProp;
  const fields = useMemo(() => settingFields(pair), [pair]);
  const defaults = useMemo(() => defaultValues({ fields, pair, configuration, sharedPair: connection?.sharedPair }), [fields, pair, configuration, connection]);
  const liveUser = useSyncExternalStore(connection?.subscribe ?? NO_SUBSCRIPTION, () => connection?.user() ?? null);
  const [storedUser, setStoredUser] = useState<ConnectionSettings>(() => liveUser ?? migrateBoardUrls(loadUserConnections(storage), [pair.first.chainId, pair.second.chainId]));
  const user = liveUser ?? storedUser;
  const [drafts, setDrafts] = useState<FieldValues>(() => currentValues(fields, defaults, user, loadImageServer()));
  const [cap, setCap] = useState(() => String(loadFeeCap()));
  const [hardCap, setHardCap] = useState(() => String(loadHardCap()));
  const [problems, setProblems] = useState<Readonly<Record<string, string>>>({});
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fixture = configuration.dataMode === "fixture";

  const edit = (id: string, value: string): void => {
    setDrafts((current) => ({ ...current, [id]: value }));
    setProblems(({ [id]: _dropped, ...rest }) => rest);
    setStatus(null);
  };

  const save = async (): Promise<void> => {
    const outcome = settingsFromDrafts({ fields, drafts, defaults, user, pageProtocol: pageProtocolOf(location.protocol) });
    const found: Record<string, string> = { ...outcome.problems };
    const capProblem = feeCapProblem(cap);
    if (capProblem !== null) found.cap = capProblem;
    const hardProblem = feeCapProblem(hardCap);
    if (hardProblem !== null) found.hardCap = hardProblem;
    else if (capProblem === null && Number(cap) > Number(hardCap)) found.cap = `The automatic cap can't be above the ${Number(hardCap)}% hard cap.`;
    setBusy(true);
    try {
      // A new RPC must serve its chain before it replaces the one in use, as on the connections page.
      const before = currentValues(fields, defaults, user, loadImageServer());
      for (const field of fields) {
        const text = textOf(drafts, field.id).trim();
        if (field.probe.kind !== "rpc" || found[field.id] !== undefined || text === "" || text === before[field.id]) continue;
        const result = await probe(text, field.probe);
        if (!result.ok) found[field.id] = `Not saved. ${redactConnectionText(result.reason, [text])}`;
      }
    } finally {
      setBusy(false);
    }
    setProblems(found);
    if (Object.keys(found).length > 0) return setStatus("Not saved: fix the marked fields.");
    saveHardCap(hardCap.trim() === String(DEFAULT_HARD_CAP_PERCENT) ? null : hardCap);
    saveFeeCap(cap.trim() === String(DEFAULT_AUTO_CAP_PERCENT) ? null : cap);
    saveImageServer(outcome.imageServer);
    const kept = saveUserConnections(storage, outcome.user);
    if (connection === null) setStoredUser(outcome.user);
    else connection.apply(outcome.user);
    const notes = [outcome.insecure.length === 0 ? null : INSECURE_ENDPOINT_WARNING, keptNotice(kept.reason)].filter((note) => note !== null);
    setStatus(notes.length === 0 ? "Saved." : `Saved. ${notes.join(" ")}`);
  };

  const resetAll = (): void => {
    setDrafts(defaults);
    setCap(String(DEFAULT_AUTO_CAP_PERCENT));
    setHardCap(String(DEFAULT_HARD_CAP_PERCENT));
    setProblems({});
    setStatus("Defaults filled in. Save to keep them.");
  };

  const section = (name: SettingField["section"]) =>
    fields
      .filter((field) => field.section === name)
      .map((field) => <Field key={field.id} field={field} value={textOf(drafts, field.id)} defaultValue={textOf(defaults, field.id)} problem={problems[field.id]} onChange={(value) => edit(field.id, value)} />);

  return (
    <Sheet label="Settings" onClose={onClose}>
      <div className="zb-col zb-set">
        <h3>Theme</h3>
        <div className="zb-seg" role="radiogroup" aria-label="Theme">
          {THEMES.map(([choice, label]) => (
            <button key={choice} type="button" role="radio" aria-checked={theme === choice} onClick={() => onTheme(choice)}>
              {label}
            </button>
          ))}
        </div>

        <h3>RPC endpoints</h3>
        <p className="zb-set-help">Used to read balances and send transactions. Yours stay in this browser.</p>
        {section("rpc")}

        <h3>Beacon endpoints</h3>
        <p className="zb-set-help">Where the light clients' proofs read each chain's consensus. Yours stay in this browser.</p>
        {section("beacon")}

        <h3>Token and chain images</h3>
        <p className="zb-set-help">Where icons come from when the release doesn't already carry them.</p>
        {section("images")}

        <h3>Services</h3>
        <p className="zb-set-help">Everything else this page talks to.</p>
        {section("services")}
        <div className="zb-fld zb-fld-static">
          <span className="zb-fld-k">Prices</span>
          <span>PulseX pools, via your RPC</span>
        </div>

        <h3>Msgboard nodes</h3>
        <p className="zb-set-help">Where proofs are read, one per chain. Two chains can share a URL; each is checked on its own.</p>
        {section("boards")}

        <h3 className="zb-set-quiet">More</h3>
        <CapField id="cap" label="Automatic fee cap" value={cap} problem={problems.cap} onChange={(value) => { setCap(value); setProblems(({ cap: _dropped, ...rest }) => rest); }} />
        <CapField id="hardCap" label="Hard fee cap" value={hardCap} problem={problems.hardCap} onChange={(value) => { setHardCap(value); setProblems(({ hardCap: _dropped, cap: _cap, ...rest }) => rest); }} />
        <div className="zb-set-row">
          <button
            type="button"
            className="zb-set-link"
            onClick={() => {
              clearRecent(browserStorage());
              onRecentCleared();
              setStatus("Recent searches cleared.");
            }}
          >
            Clear recent searches
          </button>
          <a className="zb-set-link" href="#/settings" onClick={onClose}>
            Connections and fallback
          </a>
        </div>
        <p className="zb-set-help zb-set-credits">
          Credits: <a href="https://game-icons.net/" rel="noopener noreferrer" target="_blank">{ICON_CREDIT}</a>
        </p>
        {fixture ? <p className="zb-set-help">Sample data: nothing here reaches a network.</p> : null}
        {originIsShared(location) ? <p className="zb-set-help">This gateway is shared with other sites, so settings last for this visit only.</p> : null}

        <div className="zb-set-actions">
          <span className="zb-set-status" role="status" aria-live="polite">
            {status}
          </span>
          <button type="button" className="zb-pill zb-pill-outline" onClick={resetAll}>
            Reset to defaults
          </button>
          <button type="button" className="zb-pill zb-pill-solid" disabled={busy} onClick={() => void save()}>
            Save
          </button>
        </div>
      </div>
    </Sheet>
  );
};
