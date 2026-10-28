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

function gatewayLinks(cid: string, gateways: readonly string[]): string {
  const items = gateways.map((gateway) => {
    const address = `${gateway}${cid}`;
    return `<li><a href="${escapeHtml(address)}" rel="noopener">${escapeHtml(new URL(gateway).host)}</a></li>`;
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

function verifiedBody(state: Extract<LandingState, { kind: "verified" }>): string {
  const sites = state.manifest.releases.filter((release) => release.name === "dapp" || release.name === "docs");
  const note = state.sequenceNote === null ? "" : `<p>${escapeHtml(state.sequenceNote)}</p>`;
  const downloads = state.manifest.downloads.map((entry) => downloadItem(entry, state.downloadBaseUrl)).join("");
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

/** Renders the page body as HTML text. Every value from data is escaped. A failed check yields no link. */
export function renderLanding(state: LandingState): string {
  return `<h1>${escapeHtml(state.title)}</h1>${body(state)}`;
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

/** Fetches the manifest and signature, checks them, and returns the state to show. */
export async function loadLandingState(
  config: LandingConfig,
  storage: Pick<Storage, "getItem" | "setItem"> | null,
): Promise<LandingState> {
  const failed = (reason: string): LandingState => ({ kind: "failed", title: config.title, reason });
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
  target.innerHTML = renderLanding({ kind: "loading", title: config.title });
  target.innerHTML = renderLanding(await loadLandingState(config, safeStorage()));
}
