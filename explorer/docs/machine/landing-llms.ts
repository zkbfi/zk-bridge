/**
 * `llms.txt` (llmstxt.org) for the landing sites, zkb.fi and next.zkb.fi. The dapp bundle has its own `llms.txt` with
 * relative links; this one sits at the root of the landing site, so every link is absolute: the pages, skills and data
 * files are named at the content address (CID) of the dapp of the release the site serves.
 *
 * The page list comes from `readMachineContent`, the source of the dapp's own files, so the two never drift. The text
 * is built when a release is published (`script/release/publish-pages.sh`), because the CID of the dapp is known only
 * after the release is built and signed.
 */
import { type MachineContent, type MachinePage } from "./site-files.ts";
import type { Audience } from "./front-matter.ts";

export type LandingChannel = "stable" | "next";

/** What the landing text needs to know about one release. */
export type LandingRelease = {
  readonly channel: LandingChannel;
  /** The version of the dapp in `version.json`, such as `0.1.2-next.16`. */
  readonly version: string;
  /** The CID of the dapp, lower case (a base32 CIDv1 works as a gateway subdomain). */
  readonly dappCid: string;
};

const SITES: Readonly<Record<LandingChannel, string>> = { stable: "https://zkb.fi", next: "https://next.zkb.fi" };
const RELEASES_REPOSITORY = "https://github.com/zkbfi/releases";

/** Hosts a link may name besides the dapp's own `<cid>.ipfs.zkb.fi`. */
export const PUBLIC_HOSTS: readonly string[] = [
  "zkb.fi",
  "next.zkb.fi",
  "docs.zkb.fi",
  "indexer.zkb.fi",
  "prove.zkb.fi",
  "status.zkb.fi",
  "gateway.zkb.fi",
  "github.com",
  "llmstxt.org",
];

/** Pages listed under Optional only, so a reader short of room can skip them. */
const OPTIONAL_PAGES: readonly string[] = ["glossary", "safety", "running-a-bot"];

const CID = /^[a-z2-7]{20,120}$/;

const SECTIONS: readonly { readonly audience: Audience; readonly title: string }[] = [
  { audience: "user", title: "Docs: using the bridge" },
  { audience: "deliverer", title: "Docs: delivering transfers" },
  { audience: "integrator", title: "Docs: integrating with the SDK and the APIs" },
  { audience: "operator", title: "Docs: running and operating" },
];

const channelNote = (channel: LandingChannel): string =>
  channel === "next"
    ? "This is the next channel: staging, on Sepolia and the PulseChain testnet (chain 943, pair v4). Nothing here holds real value. A release reaches stable (https://zkb.fi) only when it is promoted."
    : "This is the stable channel, served at https://zkb.fi. The next channel (https://next.zkb.fi) is staging on Sepolia and the PulseChain testnet.";

/**
 * The text of the landing `llms.txt`.
 *
 * @param content The pages and skills, from `readMachineContent`.
 * @param release The channel, version and dapp CID of the release the site serves.
 * @throws When the CID is not a lower-case base32 string, since it goes into a host name.
 */
export const buildLandingLlmsTxt = (content: MachineContent, release: LandingRelease): string => {
  if (!CID.test(release.dappCid)) throw new Error("the dapp CID must be a lower-case base32 CIDv1");
  if (!/^[0-9A-Za-z.+-]+$/.test(release.version)) throw new Error("the version has an unexpected form");
  const site = SITES[release.channel];
  const dapp = `https://${release.dappCid}.ipfs.zkb.fi`;
  const line = (name: string, url: string, description: string): string => `- [${name}](${url}): ${description}`;
  const out: string[] = [
    "# zkb.fi",
    "",
    "> zkb.fi is a bridge between Ethereum and PulseChain for tokens and messages. It has no validators and no signers: each chain runs a light client of the other, and a zero-knowledge proof shows that a message was sent on the other chain.",
    "",
    channelNote(release.channel),
    "",
    `Current release: dapp ${release.version}, CID ${release.dappCid}. The app and its documentation are published on IPFS only; ${site} is the release page. The links below name that CID, so they point at exactly this release. Each docs page is Markdown with a front matter block (title, summary, audience, chains, verified_release).`,
    "",
    "## The app",
    "",
    line("zkb.fi app", `${dapp}/`, "The dapp of this release: bridge tokens, send messages, explore transfers, open the docs at #/docs. It runs in the browser and reads the chains through the light clients."),
    line("Gateway copy", `https://gateway.zkb.fi/ipfs/${release.dappCid}/`, "The same release through the zkb.fi IPFS gateway, which serves any CID."),
    line("Release page", `${site}/`, "The landing page: it checks the signed release list in the browser and shows the downloads."),
    "",
    "## Verify a release",
    "",
    line("version.json", `${site}/version.json`, "The signed release list: the CID and archive hash of each site, and the SHA-256 of each download."),
    line("version.json.sig", `${site}/version.json.sig`, "The Ed25519 signature over version.json."),
    line("releases-log.json", `${site}/releases-log.json`, "The signed log of every release of this channel."),
    line("releases-log.json.sig", `${site}/releases-log.json.sig`, "The signature over releases-log.json."),
    line("public-keys.json", `${site}/public-keys.json`, "The release signing key of this channel."),
    line("SHA256SUMS", `${site}/SHA256SUMS`, "Checksums of the release files."),
    line("Release repository", `${RELEASES_REPOSITORY}`, "Signed release lists, and the downloads of each release (terminal, prover) on the releases tab; next releases are pre-releases."),
    line("Verify-a-release skill", `${dapp}/docs/skills/verify-a-release/SKILL.md`, "Step by step: check the signature, then the CID and the hashes."),
    "",
  ];
  const placed = new Set<MachinePage>();
  for (const section of SECTIONS) {
    const members = content.pages.filter((page) => !placed.has(page) && !OPTIONAL_PAGES.includes(page.slug) && page.meta.audience[0] === section.audience);
    if (members.length === 0) continue;
    out.push(`## ${section.title}`, "");
    if (section === SECTIONS[0]) {
      out.push(line("llms.txt of the dapp", `${dapp}/llms.txt`, "The same index with relative links, as the dapp itself serves it."), line("llms-full.txt of the dapp", `${dapp}/llms-full.txt`, "Every page and skill in one file."));
    }
    for (const page of members) {
      placed.add(page);
      out.push(line(page.meta.title, `${dapp}/docs/${page.slug}.md`, page.meta.summary));
    }
    out.push("");
  }
  if (content.skills.length > 0) {
    out.push("## Skills", "", "Agent Skills (SKILL.md files) that an assistant can load to carry out a task with the bridge.", "");
    for (const skill of content.skills) out.push(line(skill.meta.title, `${dapp}/docs/skills/${skill.name}/SKILL.md`, skill.meta.summary));
    out.push("");
  }
  out.push(
    "## Machine-readable data",
    "",
    line("chains.json", `${dapp}/data/chains.json`, "The chains: ids, names, native coin, explorers, slot and finality timing."),
    line("contracts.json", `${dapp}/data/contracts.json`, "The deployed contract addresses of each pair, per chain, with the test tokens."),
    line("Indexer OpenAPI", `${dapp}/data/openapi/indexer.json`, "OpenAPI 3.1 description of the indexer API."),
    line("Backend OpenAPI", `${dapp}/data/openapi/backend.json`, "OpenAPI 3.1 description of the prover backend API."),
    "",
    "## Live APIs",
    "",
    "All are public and read-only except the proof request. They are described by the two OpenAPI files above.",
    "",
    line("Indexer: pair", "https://indexer.zkb.fi/api/pair", "Which pair the indexer serves: its two chains and their contract addresses."),
    line("Indexer: summary", "https://indexer.zkb.fi/api/summary", "Light client heads, gates, messages in flight, the last day's volume."),
    line("Indexer: feed", "https://indexer.zkb.fi/api/feed?limit=20", "The newest messages and transfers. Filters: status, address."),
    line("Prover: pipeline, first to second", "https://prove.zkb.fi/directions/first-to-second/pipeline", "The stages of the next proof for the direction Sepolia to PulseChain testnet."),
    line("Prover: pipeline, second to first", "https://prove.zkb.fi/directions/second-to-first/pipeline", "The same for PulseChain testnet to Sepolia."),
    line("Prover: benchmarks", "https://prove.zkb.fi/benchmarks?window=24h", "Median and 90th percentile of each proving step over the last 24 hours."),
    line("Prover: billing", "https://prove.zkb.fi/billing", "What the GPU time for proofs cost, per day. POST https://prove.zkb.fi/requests asks for a proof; see the backend OpenAPI file."),
    line("Status", "https://status.zkb.fi/api/status", "The state of every service of the bridge as JSON; the page is https://status.zkb.fi/."),
    line("Status summary", "https://status.zkb.fi/api/summary", "The overall state of the bridge services and a message that names what fails."),
    line("IPFS gateway", "https://gateway.zkb.fi/ipfs/", "Serves any IPFS CID by path. A release also loads at https://<cid>.ipfs.zkb.fi/."),
    "",
    "## Optional",
    "",
  );
  const optional = OPTIONAL_PAGES.flatMap((name) => content.pages.filter((page) => page.slug === name));
  for (const page of optional) out.push(line(page.meta.title, `${dapp}/docs/${page.slug}.md`, page.meta.summary));
  out.push(line("llms-full.txt of the dapp", `${dapp}/llms-full.txt`, "Every page and skill in one file."), line("llms.txt specification", "https://llmstxt.org/", "The format of this file."), "");
  return out.join("\n");
};

/** The text of `llms-full.txt` on the landing site: the landing index, then every page and skill in full. */
export const buildLandingLlmsFullTxt = (content: MachineContent, release: LandingRelease, fullDocs: string): string =>
  `${buildLandingLlmsTxt(content, release)}\n---\n\n${fullDocs}`;

/**
 * Checks a landing `llms.txt` against the spec shape and its links.
 *
 * @param text The file.
 * @param release The release it was built for.
 * @param emitted The paths the dapp release emits (from `filesOfContent`), to check links into the dapp.
 * @returns The problems, one per line; empty when all is well.
 */
export const checkLandingLlmsTxt = (text: string, release: LandingRelease, emitted: ReadonlySet<string>): string[] => {
  const problems: string[] = [];
  const lines = text.split("\n");
  if (!/^# \S/.test(lines[0] as string)) problems.push("the first line must be an H1 title");
  if (lines.filter((entry) => entry.startsWith("# ")).length !== 1) problems.push("there must be exactly one H1");
  const firstBlock = lines.findIndex((entry, index) => index > 0 && entry.trim() !== "");
  if (!(lines[firstBlock] ?? "").startsWith("> ")) problems.push("a blockquote summary must follow the title");
  const sections: { title: string; links: number }[] = [];
  for (const entry of lines) {
    if (entry.startsWith("## ")) sections.push({ title: entry.slice(3), links: 0 });
    else if (entry.startsWith("- ")) {
      const match = /^- \[([^\]]+)\]\((\S+)\)(?:: (\S.*))?$/.exec(entry);
      if (match === null) {
        problems.push(`not a "- [name](url): description" item: ${entry}`);
        continue;
      }
      if (match[3] === undefined) problems.push(`link without a description: ${entry}`);
      const current = sections[sections.length - 1];
      if (current === undefined) problems.push(`a link outside a section: ${entry}`);
      else current.links += 1;
      let url: URL;
      try {
        url = new URL(match[2] as string);
      } catch {
        problems.push(`not an absolute URL: ${match[2] as string}`);
        continue;
      }
      if (url.protocol !== "https:" || !(match[2] as string).startsWith("https://")) problems.push(`not https: ${match[2] as string}`);
      const dappHost = `${release.dappCid}.ipfs.zkb.fi`;
      if (url.hostname === dappHost) {
        const path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        if (path !== "" && !emitted.has(path)) problems.push(`links ${match[2] as string}, which the release does not emit`);
      } else if (!PUBLIC_HOSTS.includes(url.hostname)) problems.push(`links a host that is not public: ${url.hostname}`);
    }
  }
  for (const section of sections) if (section.links === 0) problems.push(`the section "${section.title}" has no links`);
  if (!sections.some((section) => section.title === "Optional")) problems.push("the Optional section is missing");
  if (/vk_|0x[0-9a-fA-F]{64}|[?&](key|token|apikey)=/.test(text)) problems.push("the text holds something key-shaped");
  return problems;
};
