/** The downloads block: one primary button for the visitor's platform, a menu to switch, and the chosen file's details. */
import type { DownloadEntry } from "./manifest.ts";
import { platformLabel, platformRank } from "./platform.ts";
import type { Detection } from "./platform.ts";

/** What the visitor chose for one program. `selected` is a platform key; `open` is whether the menu shows. */
export type MenuState = { selected: string | null; open: boolean };

/** The choices of every program, by program name. */
export type MenuChoices = Record<string, MenuState>;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escape(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/** A byte count as text, such as `54.3 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["kB", "MB", "GB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** The downloads of one program, in menu order. */
export type DownloadGroup = { name: string; entries: DownloadEntry[] };

/** Groups the downloads by program name, keeping the order of first appearance. Files for every system come last. */
export function groupDownloads(downloads: readonly DownloadEntry[]): { programs: DownloadGroup[]; anySystem: DownloadEntry[] } {
  const programs: DownloadGroup[] = [];
  const anySystem: DownloadEntry[] = [];
  for (const entry of downloads) {
    if (entry.platform === "any") {
      anySystem.push(entry);
      continue;
    }
    const group = programs.find((candidate) => candidate.name === entry.name);
    if (group === undefined) programs.push({ name: entry.name, entries: [entry] });
    else group.entries.push(entry);
  }
  for (const group of programs) group.entries.sort((a, b) => platformRank(a.platform) - platformRank(b.platform));
  return { programs, anySystem };
}

/**
 * The platform shown first for a program: the visitor's choice, else the detected platform when this program has a
 * build for it, else the only build when there is just one, else none.
 */
export function defaultSelection(group: DownloadGroup, detection: Detection | null): string | null {
  const only = group.entries.length === 1 ? group.entries[0] : undefined;
  if (only !== undefined) return only.platform;
  const found = group.entries.find((entry) => entry.platform === detection?.key);
  return found?.platform ?? null;
}

function address(baseUrl: string, entry: DownloadEntry): string {
  return `${baseUrl}/${encodeURIComponent(entry.file)}`;
}

function menuItem(group: DownloadGroup, entry: DownloadEntry, selected: string | null, detection: Detection | null): string {
  const isSelected = entry.platform === selected;
  const yours = entry.platform === detection?.key ? ` <span class="dl-yours">your device</span>` : "";
  return [
    `<li role="none"><button type="button" role="menuitemradio" aria-checked="${isSelected}" class="dl-item" tabindex="-1"`,
    ` data-program="${escape(group.name)}" data-platform="${escape(entry.platform)}">`,
    `<span class="dl-check" aria-hidden="true">${isSelected ? "&#10003;" : ""}</span>`,
    `<span>${escape(platformLabel(entry.platform))}${yours}</span></button></li>`,
  ].join("");
}

function details(entry: DownloadEntry): string {
  const size = entry.size === undefined ? "" : `<dt>Size</dt><dd>${escape(formatSize(entry.size))}</dd>`;
  return [
    `<dl class="dl-details"><dt>File</dt><dd><code>${escape(entry.file)}</code></dd>${size}`,
    `<dt>SHA-256</dt><dd><code class="dl-sha">${escape(entry.sha256)}</code> `,
    `<button type="button" class="dl-copy" data-copy="${escape(entry.sha256)}">Copy</button></dd></dl>`,
  ].join("");
}

function assumedNote(entry: DownloadEntry, detection: Detection | null): string {
  if (detection === null || !detection.assumed || entry.platform !== detection.key) return "";
  return `<p class="dl-note">This browser does not say which chip your Mac has, so this is the Apple silicon build. On an Intel Mac, choose Intel from the menu.</p>`;
}

/** One program: the primary download, the menu and the details of the chosen file. */
export function renderProgram(group: DownloadGroup, baseUrl: string, detection: Detection | null, choice: MenuState | undefined): string {
  const selected = choice?.selected ?? defaultSelection(group, detection);
  const chosen = group.entries.find((entry) => entry.platform === selected);
  const multiple = group.entries.length > 1;
  const open = multiple && (choice?.open ?? chosen === undefined);
  const id = `menu-${group.name.replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const primary =
    chosen === undefined
      ? `<p class="dl-choose">Choose your system to see the download.</p>`
      : `<a class="dl-button" href="${escape(address(baseUrl, chosen))}" rel="noopener">Download for ${escape(platformLabel(chosen.platform))}</a>`;
  const trigger = multiple
    ? [
        `<span class="dl-menu"><button type="button" class="dl-trigger" id="${id}-trigger" aria-haspopup="menu" aria-expanded="${open}"`,
        ` aria-controls="${id}" data-program="${escape(group.name)}">${chosen === undefined ? "Choose system" : "Other systems"}`,
        `<span class="dl-chevron" aria-hidden="true"></span></button>`,
        `<ul class="dl-surface" id="${id}" role="menu" aria-labelledby="${id}-trigger"${open ? "" : " hidden"}>`,
        group.entries.map((entry) => menuItem(group, entry, selected, detection)).join(""),
        `</ul></span>`,
      ].join("")
    : "";
  return [
    `<div class="dl-program" data-program="${escape(group.name)}"><h3>${escape(group.name)}</h3>`,
    `<div class="dl-row">${primary}${trigger}</div>`,
    chosen === undefined ? "" : assumedNote(chosen, detection) + details(chosen),
    `</div>`,
  ].join("");
}

/** The whole downloads section. */
export function renderDownloads(
  downloads: readonly DownloadEntry[],
  baseUrl: string,
  detection: Detection | null,
  choices: MenuChoices = {},
): string {
  const { programs, anySystem } = groupDownloads(downloads);
  const other = anySystem.length === 0 ? "" : [
    `<div class="dl-program"><h3>Files for every system</h3><ul>`,
    anySystem.map((entry) => `<li><a href="${escape(address(baseUrl, entry))}" rel="noopener">${escape(entry.name)}</a>${entry.size === undefined ? "" : ` (${escape(formatSize(entry.size))})`}<br>SHA-256: <code>${escape(entry.sha256)}</code></li>`).join(""),
    `</ul></div>`,
  ].join("");
  return [
    `<section class="downloads" id="downloads"><h2>Downloads</h2>`,
    `<p>Compare the SHA-256 of a download with the value shown here before you run it.</p>`,
    programs.map((group) => renderProgram(group, baseUrl, detection, choices[group.name])).join(""),
    other,
    `</section>`,
  ].join("");
}
