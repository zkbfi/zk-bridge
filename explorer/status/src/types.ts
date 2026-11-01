/** The state of one check. */
export type State = "ok" | "degraded" | "down";

/** The states from good to bad. */
export const STATES: readonly State[] = ["ok", "degraded", "down"];

/** The sections of the page, in order. */
export const SECTIONS = ["services", "chains", "bridges", "pipeline", "wallets"] as const;
export type Section = (typeof SECTIONS)[number];

/** The titles of the sections on the page. */
export const SECTION_TITLES: Readonly<Record<Section, string>> = {
  services: "Services",
  chains: "Chains & light clients",
  bridges: "Bridges & gates",
  pipeline: "Proving pipeline",
  wallets: "Wallets",
};

/** What a check finds out: a state and one plain sentence that says what is wrong (or right). */
export type Outcome = { readonly state: State; readonly detail: string };

/** One check: what it is called and how to run it. `run` may throw: the runner turns that into "down". */
export type CheckDefinition = {
  /** Stable, lower case, such as `unit-zk-bridge-backend`. It is the key in the database and in the API. */
  readonly id: string;
  /** The name on the page, such as `Backend (local)`. */
  readonly name: string;
  readonly section: Section;
  readonly run: () => Promise<Outcome>;
};

/** One finished run of one check. */
export type CheckResult = {
  readonly id: string;
  readonly at: number;
  readonly state: State;
  /** Milliseconds the check took. */
  readonly latencyMs: number;
  readonly detail: string;
};

/** The window names of the API and the page. */
export const WINDOWS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
export type WindowName = keyof typeof WINDOWS;
/** The number of bars in a history of each window: 30 minutes, 3 hours and 12 hours each. */
export const BUCKETS: Readonly<Record<WindowName, number>> = { "24h": 48, "7d": 56, "30d": 60 };


/** A check before it has its dependencies: the checks of `src/checks` are specs, and `buildChecks` binds them. */
export type CheckSpec<Deps> = Omit<CheckDefinition, "run"> & { readonly run: (deps: Deps) => Promise<Outcome> };
