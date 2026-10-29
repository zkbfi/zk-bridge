/** The landing page: pure rendering from data, plus the browser start-up that fetches and checks the manifest. */
import { parseManifest, verifyManifestSignature } from "./manifest.ts";
import type { DownloadEntry, ReleaseEntry, ReleaseManifest } from "./manifest.ts";
import { rememberSequence } from "./sequence-memory.ts";

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

function gatewayLinks(cid: string, gateways: readonly string[]): string {
  const items = gatewayLinkList(cid, gateways).map((link) => {
    const note = link.sharedOrigin ? " (shared origin: other sites on this gateway share the browser storage of the app)" : "";
    return `<li><a href="${escapeHtml(link.address)}" rel="noopener">${escapeHtml(link.label)}</a>${escapeHtml(note)}</li>`;
  });
  return `<ul>${items.join("")}</ul>`;
}

function releaseSection(release: ReleaseEntry, gateways: readonly string[]): string {
  return [
    `<section>`,
    `<h2>${escapeHtml(release.name)} ${escapeHtml(release.version)}</h2>`,
    `<p>Commit <code>${escapeHtml(release.commit)}</code>, published ${escapeHtml(release.publishedAt)}.</p>`,
    `<p>Content address: <code>${escapeHtml(release.cid)}</code></p>`,
    `<p>Archive SHA-256: <code>${escapeHtml(release.archiveSha256)}</code></p>`,
    gatewayLinks(release.cid, gateways),
    `</section>`,
  ].join("");
}

function downloadItem(download: DownloadEntry, baseUrl: string): string {
  const address = `${baseUrl}/${encodeURIComponent(download.file)}`;
  return [
    `<li><a href="${escapeHtml(address)}" rel="noopener">${escapeHtml(download.name)}</a>`,
    ` for ${escapeHtml(download.platform)} (${escapeHtml(download.file)})`,
    `<br>SHA-256: <code>${escapeHtml(download.sha256)}</code></li>`,
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

function verifiedBody(state: Extract<LandingState, { kind: "verified" }>): string {
  const sites = state.manifest.releases.filter((release) => release.name === "dapp" || release.name === "docs");
  const note = state.sequenceNote === null ? "" : `<p>${escapeHtml(state.sequenceNote)}</p>`;
  const downloads = state.manifest.downloads.map((entry) => downloadItem(entry, downloadBase(state))).join("");
  return [
    `<p>The signature on this release list is valid.</p>`,
    note,
    sites.map((release) => releaseSection(release, state.gateways)).join(""),
    `<h2>Downloads</h2>`,
    `<p>Compare the SHA-256 of a download with the value shown here before you run it.</p>`,
    `<ul>${downloads}</ul>`,
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

/** Browser entry point: shows progress, then the checked result. */
export async function startLanding(config: LandingConfig): Promise<void> {
  const target = document.getElementById("app");
  if (target === null) return;
  target.innerHTML = renderLanding({ kind: "loading", title: config.title }, config.notice);
  target.innerHTML = renderLanding(await loadLandingState(config, safeStorage()), config.notice);
}
