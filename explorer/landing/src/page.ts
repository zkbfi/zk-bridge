/** The landing page: pure rendering from data, plus the browser start-up that fetches and checks the manifest. */
import { parseManifest, verifyManifestSignature } from "./manifest.ts";
import type { ReleaseEntry, ReleaseManifest } from "./manifest.ts";
import { rememberSequence } from "./sequence-memory.ts";
import { defaultSelection, groupDownloads, renderDownloads, renderProgram } from "./downloads.ts";
import type { MenuChoices } from "./downloads.ts";
import { detectPlatform } from "./platform.ts";
import type { Detection } from "./platform.ts";

/** The screenshots of the released app that ship with the page. Both are written at build time, only when they exist. */
export type SnapshotConfig = { light: string; dark: string; width: number; height: number };

/** Settings baked into the page at build time. */
export type LandingConfig = {
  title: string;
  manifestUrl: string;
  signatureUrl: string;
  downloadBaseUrl: string;
  gateways: string[];
  publicKeys: JsonWebKey[];
  /** A line shown above everything else, such as which network a test release runs on. Optional. */
  notice?: string;
  /** The screenshots of the app after its loader, set by the build when the release made them. */
  snapshot?: SnapshotConfig;
};

/** What the page shows. */
export type LandingState =
  | { kind: "loading"; title: string }
  | { kind: "failed"; title: string; reason: string }
  | {
      kind: "verified";
      title: string;
      manifest: ReleaseManifest;
      gateways: readonly string[];
      downloadBaseUrl: string;
      sequenceNote: string | null;
      /** The visitor's platform, once detected. */
      platform?: Detection | null;
      /** The screenshots to show, or none. */
      snapshot?: SnapshotConfig | null;
      /** What the visitor picked in the download menus. */
      choices?: MenuChoices;
    };

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** Escapes text for use in HTML text and quoted attributes. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** The marker in a subdomain-style gateway, such as `https://{cid}.ipfs.dweb.link/`. */
export const CID_PLACEHOLDER = "{cid}";

/** The longest label that a host name allows. A longer content address cannot be a subdomain. */
const MAXIMUM_LABEL_LENGTH = 63;

/** A content address that can be a subdomain: version 1, base32, lower case. */
const SUBDOMAIN_SAFE_CID = /^b[a-z2-7]+$/;

/** One gateway link: where it goes, what it is called, and whether other sites share its browser origin. */
export type GatewayLink = { address: string; label: string; sharedOrigin: boolean };

/** Whether a configured gateway is a subdomain-style template. */
function isSubdomainGateway(gateway: string): boolean {
  return gateway.includes(CID_PLACEHOLDER);
}

/** Gives the gateway address a parser can read: the placeholder becomes a plain host label. */
function parseableGateway(gateway: string): string {
  return gateway.replace(CID_PLACEHOLDER, "cid");
}

function gatewayLink(cid: string, gateway: string): GatewayLink | null {
  if (!isSubdomainGateway(gateway)) {
    return { address: `${gateway}${cid}`, label: new URL(gateway).host, sharedOrigin: true };
  }
  if (!SUBDOMAIN_SAFE_CID.test(cid) || cid.length > MAXIMUM_LABEL_LENGTH) return null;
  return { address: gateway.replace(CID_PLACEHOLDER, cid), label: new URL(parseableGateway(gateway)).host.replace(/^cid\./, ""), sharedOrigin: false };
}

/**
 * Lists the links to one release. Subdomain-style gateways come first, because each release then has its own browser
 * origin. Path-style gateways follow, marked as shared. A subdomain-style gateway is left out when the content address
 * cannot be a host label.
 */
export function gatewayLinkList(cid: string, gateways: readonly string[]): GatewayLink[] {
  const links = gateways.flatMap((gateway) => gatewayLink(cid, gateway) ?? []);
  return [...links.filter((link) => !link.sharedOrigin), ...links.filter((link) => link.sharedOrigin)];
}

/** The docs are part of the dapp: its `#/docs` route at the same gateway form. The slash keeps relative assets working. */
function docsAddress(address: string): string {
  return `${address}${address.endsWith("/") ? "" : "/"}#/docs`;
}

function gatewayLinks(cid: string, gateways: readonly string[], withDocs: boolean): string {
  const items = gatewayLinkList(cid, gateways).map((link) => {
    const note = link.sharedOrigin ? " (shared origin: other sites on this gateway share the browser storage of the app)" : "";
    const docs = withDocs ? ` · <a href="${escapeHtml(docsAddress(link.address))}" rel="noopener">Docs</a>` : "";
    return `<li><a href="${escapeHtml(link.address)}" rel="noopener">${escapeHtml(link.label)}</a>${docs}${escapeHtml(note)}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function releaseSection(release: ReleaseEntry, gateways: readonly string[]): string {
  return [
    `<div class="release">`,
    `<h3>${escapeHtml(release.name)} ${escapeHtml(release.version)}</h3>`,
    `<p>Commit <code>${escapeHtml(release.commit)}</code>, published ${escapeHtml(release.publishedAt)}.</p>`,
    `<p>Content address: <code>${escapeHtml(release.cid)}</code></p>`,
    `<p>Archive SHA-256: <code>${escapeHtml(release.archiveSha256)}</code></p>`,
    gatewayLinks(release.cid, gateways, release.name === "dapp"),
    `</div>`,
  ].join("");
}

/**
 * The download address of a verified release. `{version}` in the setting becomes the version of the signed dapp
 * release, so one setting serves every release (for example a release page per version). It stays as written when
 * the manifest has no dapp release.
 */
function downloadBase(state: Extract<LandingState, { kind: "verified" }>): string {
  const dapp = state.manifest.releases.find((release) => release.name === "dapp");
  return dapp === undefined ? state.downloadBaseUrl : state.downloadBaseUrl.replaceAll("{version}", encodeURIComponent(dapp.version));
}

/** The screenshot of the app, light or dark by the visitor's setting, linking to the app. Nothing when there is no image. */
function snapshotBlock(snapshot: SnapshotConfig | null, dapp: ReleaseEntry | undefined, gateways: readonly string[]): string {
  if (snapshot === null) return "";
  const link = dapp === undefined ? undefined : gatewayLinkList(dapp.cid, gateways)[0];
  const alt = "The bridge screen of the app, as it looks once the loader has finished.";
  const picture = [
    `<picture><source media="(prefers-color-scheme: dark)" srcset="${escapeHtml(snapshot.dark)}">`,
    `<img src="${escapeHtml(snapshot.light)}" width="${snapshot.width}" height="${snapshot.height}" alt="${escapeHtml(alt)}" loading="lazy"></picture>`,
  ].join("");
  const caption = `<figcaption>The app${dapp === undefined ? "" : ` ${escapeHtml(dapp.version)}`}, as it looks after the loader.</figcaption>`;
  const shown = link === undefined ? picture : `<a href="${escapeHtml(link.address)}" rel="noopener">${picture}</a>`;
  return `<figure class="snapshot" id="snapshot">${shown}${caption}</figure>`;
}

/** What zkb.fi is, in plain words. Shown above the links. */
const INTRO = [
  `<p>zkb.fi is a bridge for moving tokens between chains. This page links to its app and to the terminal programs.</p>`,
  `<p>No one holds your tokens: the contracts have no owner. The app runs from the InterPlanetary File System, not from this server. Each link below comes from a signed release list that your browser checks before it shows anything.</p>`,
].join("");

/** The docs and the text files for LLMs. The docs are part of the app; the text files are served next to this page. */
function docsSection(dapp: ReleaseEntry | undefined, gateways: readonly string[]): string {
  const link = dapp === undefined ? undefined : gatewayLinkList(dapp.cid, gateways)[0];
  const items = [
    link === undefined ? "" : `<li><a href="${escapeHtml(docsAddress(link.address))}" rel="noopener">Docs and guides</a>, inside the app</li>`,
    `<li><a href="./llms.txt">llms.txt</a>: an index of the docs for language models</li>`,
    `<li><a href="./llms-full.txt">llms-full.txt</a>: the same with every page in full</li>`,
  ];
  return `<section class="docs" id="docs"><h2>Docs</h2><ul>${items.join("")}</ul></section>`;
}

/** The signed release list, with how to check it. Last on the page. */
function verificationSection(sequenceNote: string | null): string {
  const note = sequenceNote === null ? "" : `<p>${escapeHtml(sequenceNote)}</p>`;
  return [
    `<section class="verification" id="verification"><h2>The signed release list</h2>`,
    `<p>The signature on this release list is valid. Your browser checked it against the release keys built into this page.</p>`,
    note,
    `<p><a href="./version.json">version.json</a> and its signature <a href="./version.json.sig">version.json.sig</a></p>`,
    `</section>`,
  ].join("");
}

function verifiedBody(state: Extract<LandingState, { kind: "verified" }>): string {
  // The docs are inside the dapp (Docs link above). A list signed before that may still name a docs site: it is read, not shown.
  const sites = state.manifest.releases.filter((release) => release.name === "dapp");
  const downloads = renderDownloads(state.manifest.downloads, downloadBase(state), state.platform ?? null, state.choices);
  return [
    INTRO,
    `<section class="app-links" id="app-links"><h2>Open the app</h2>`,
    snapshotBlock(state.snapshot ?? null, sites[0], state.gateways),
    sites.map((release) => releaseSection(release, state.gateways)).join(""),
    `</section>`,
    docsSection(sites[0], state.gateways),
    downloads,
    verificationSection(state.sequenceNote),
  ].join("");
}

function body(state: LandingState): string {
  if (state.kind === "loading") return `<p>Checking the signed release list.</p>`;
  if (state.kind === "failed") {
    return `<div class="warning" role="alert"><p>Warning: this release list failed its check. Do not use anything from this page.</p><p>${escapeHtml(state.reason)}</p></div>`;
  }
  return verifiedBody(state);
}

function noticeLine(notice: string | null | undefined): string {
  return notice === null || notice === undefined || notice.trim() === "" ? "" : `<p class="notice" role="note">${escapeHtml(notice)}</p>`;
}

/**
 * Renders the page body as HTML text. Every value from data is escaped. A failed check yields no link. The notice of
 * the page settings, when set, stands above the result in every state.
 */
export function renderLanding(state: LandingState, notice: string | null = null): string {
  return `<h1>${escapeHtml(state.title)}</h1>${noticeLine(notice)}${body(state)}`;
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`could not fetch ${url} (status ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

function describeSequence(check: ReturnType<typeof rememberSequence>): string | null {
  return check.kind === "not-remembered"
    ? "This browser cannot remember the last release number, so a replay of an old list would not be caught here."
    : null;
}

/** Returns the first gateway that is not a web address, or null when all are good. */
export function findMalformedGateway(gateways: readonly string[]): string | null {
  const isWebAddress = (gateway: string): boolean => {
    try {
      return ["https:", "http:"].includes(new URL(parseableGateway(gateway)).protocol);
    } catch {
      return false;
    }
  };
  return gateways.find((gateway) => !isWebAddress(gateway)) ?? null;
}

/** Fetches the manifest and signature, checks them, and returns the state to show. */
export async function loadLandingState(
  config: LandingConfig,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): Promise<LandingState> {
  const failed = (reason: string): LandingState => ({ kind: "failed", title: config.title, reason });
  const malformed = findMalformedGateway(config.gateways);
  if (malformed !== null) return failed(`The page settings hold a gateway that is not a web address: ${malformed}`);
  try {
    const [manifestBytes, signature] = await Promise.all([fetchBytes(config.manifestUrl), fetchBytes(config.signatureUrl)]);
    const valid = await verifyManifestSignature({ manifestBytes, signature, publicKeys: config.publicKeys });
    if (!valid) return failed("The signature does not match any built-in release key.");
    const manifest = parseManifest(new TextDecoder().decode(manifestBytes));
    const check = rememberSequence(storage, manifest.sequence);
    if (check.kind === "lower") {
      return failed(`This list is older (number ${manifest.sequence}) than one this browser saw before (number ${check.remembered}).`);
    }
    return {
      kind: "verified",
      title: config.title,
      manifest,
      gateways: config.gateways,
      downloadBaseUrl: config.downloadBaseUrl,
      sequenceNote: describeSequence(check),
      snapshot: config.snapshot ?? null,
    };
  } catch (error) {
    return failed(error instanceof Error ? error.message : "The release list could not be checked.");
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Moves focus to an element, when it exists. */
function focusIn(root: ParentNode, selector: string): void {
  root.querySelector<HTMLElement>(selector)?.focus();
}

/** Wires the download menus: click, keyboard, copy. The menus are drawn again from `choices` after each change. */
function wireDownloads(target: HTMLElement, state: Extract<LandingState, { kind: "verified" }>): void {
  const choices: MenuChoices = {};
  const baseUrl = downloadBase(state);
  const programs = groupDownloads(state.manifest.downloads).programs;
  const draw = (name: string): HTMLElement | null => {
    const group = programs.find((candidate) => candidate.name === name);
    const current = Array.from(target.querySelectorAll<HTMLElement>(".dl-program[data-program]")).find((node) => node.dataset.program === name);
    if (group === undefined || current === undefined) return null;
    const html = renderProgram(group, baseUrl, state.platform ?? null, choices[name]);
    current.outerHTML = html;
    return Array.from(target.querySelectorAll<HTMLElement>(".dl-program[data-program]")).find((node) => node.dataset.program === name) ?? null;
  };
  const stateOf = (name: string) => {
    const group = programs.find((candidate) => candidate.name === name);
    const existing = choices[name];
    if (existing !== undefined) return existing;
    const fresh = { selected: group === undefined ? null : defaultSelection(group, state.platform ?? null), open: false };
    choices[name] = fresh;
    return fresh;
  };
  const setMenu = (name: string, open: boolean, focus: string | null): void => {
    stateOf(name).open = open;
    const node = draw(name);
    if (node !== null && focus !== null) focusIn(node, focus);
  };
  const closeAll = (): void => {
    for (const [name, choice] of Object.entries(choices)) if (choice.open) setMenu(name, false, null);
  };
  const items = (menu: Element): HTMLElement[] => Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitemradio"]'));

  target.addEventListener("click", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    const trigger = element?.closest<HTMLElement>(".dl-trigger");
    const item = element?.closest<HTMLElement>(".dl-item");
    const copy = element?.closest<HTMLElement>(".dl-copy");
    if (copy !== null && copy !== undefined) {
      void navigator.clipboard?.writeText(copy.dataset.copy ?? "").then(
        () => {
          copy.textContent = "Copied";
          setTimeout(() => (copy.textContent = "Copy"), 1500);
        },
        () => (copy.textContent = "Select and copy"),
      );
      return;
    }
    if (trigger !== null && trigger !== undefined) {
      const name = trigger.dataset.program ?? "";
      const group = programs.find((candidate) => candidate.name === name);
      const open = trigger.getAttribute("aria-expanded") !== "true";
      if (group !== undefined && !(name in choices)) stateOf(name);
      setMenu(name, open, open ? '.dl-item[aria-checked="true"], .dl-item' : ".dl-trigger");
      return;
    }
    if (item !== null && item !== undefined) {
      const name = item.dataset.program ?? "";
      const choice = stateOf(name);
      choice.selected = item.dataset.platform ?? null;
      choice.open = false;
      const node = draw(name);
      if (node !== null) focusIn(node, ".dl-trigger");
      return;
    }
    closeAll();
  });

  target.addEventListener("keydown", (event) => {
    const element = event.target instanceof Element ? event.target : null;
    const menu = element?.closest(".dl-surface");
    const trigger = element?.closest<HTMLElement>(".dl-trigger");
    if (trigger !== null && trigger !== undefined && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      setMenu(trigger.dataset.program ?? "", true, '.dl-item[aria-checked="true"], .dl-item');
      return;
    }
    if (menu === null || menu === undefined) return;
    const list = items(menu);
    const index = list.findIndex((node) => node === element);
    const move = (to: number): void => {
      event.preventDefault();
      list[(to + list.length) % list.length]?.focus();
    };
    if (event.key === "ArrowDown") move(index + 1);
    else if (event.key === "ArrowUp") move(index - 1);
    else if (event.key === "Home") move(0);
    else if (event.key === "End") move(list.length - 1);
    else if (event.key === "Escape") {
      event.preventDefault();
      const name = menu.closest<HTMLElement>(".dl-program")?.dataset.program ?? "";
      setMenu(name, false, ".dl-trigger");
    } else if (event.key === "Tab") closeAll();
  });
}

/** Browser entry point: shows progress, then the checked result, then picks the download for the visitor's platform. */
export async function startLanding(config: LandingConfig): Promise<void> {
  const target = document.getElementById("app");
  if (target === null) return;
  target.innerHTML = renderLanding({ kind: "loading", title: config.title }, config.notice);
  const state = await loadLandingState(config, safeStorage());
  if (state.kind !== "verified") {
    target.innerHTML = renderLanding(state, config.notice);
    return;
  }
  const platform = await detectPlatform(navigator).catch((): Detection => ({ key: null, assumed: false }));
  const shown = { ...state, platform };
  target.innerHTML = renderLanding(shown, config.notice);
  wireDownloads(target, shown);
}
