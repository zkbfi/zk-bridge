/**
 * The front matter of a docs page: a small YAML block at the top of the Markdown file that tells a crawler, an
 * assistant or a developer what the page is for, who it is for, which chains it covers and which release it was
 * checked against. The docs build and `scripts/check-machine-docs.ts` use the same validator.
 *
 * The block is a subset of YAML on purpose, so no YAML library is needed: one `key: value` per line, where a value is a
 * double-quoted string (JSON escapes), a single-quoted string, a whole number, a bare word, or an inline list such as
 * `[user, deliverer]`. Nested maps, multi-line values and anchors are refused.
 */

/** Who a page is written for. */
export const AUDIENCES = ["user", "deliverer", "operator", "integrator"] as const;
export type Audience = (typeof AUDIENCES)[number];

/** The longest summary, in characters. A summary is a single line, as a row of `llms.txt`. */
export const MAXIMUM_SUMMARY_LENGTH = 220;

/** The front matter of a page, after validation. */
export type FrontMatter = {
  readonly title: string;
  /** One line that says what the page gives the reader. */
  readonly summary: string;
  readonly audience: readonly Audience[];
  /** The chain ids the page is about, or "all". */
  readonly chains: "all" | readonly number[];
  /** The release the page was last checked against, such as `0.1.0`. */
  readonly verified_release: string;
  readonly kind: "page" | "skill";
  /** Skills only: the kebab-case name of the skill, which is its folder in `/docs/skills/<name>/SKILL.md`. */
  readonly name?: string;
  /** Skills only: what the skill does and when to use it, which an agent reads to decide (Agent Skills format). */
  readonly description?: string;
};

/** The keys the validator knows. Any other key is a mistake. */
const KNOWN_KEYS: readonly string[] = ["title", "summary", "audience", "chains", "verified_release", "kind", "name", "description"];
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** The text of a file split into its front matter block (without the `---` lines) and the rest. */
export type SplitSource = { readonly raw: string | null; readonly body: string };

/**
 * Splits a Markdown file at its front matter. The block must start on the first line with `---` and end at the next
 * line that holds only `---`. A file with no block gives `raw: null` and the whole text as the body.
 *
 * @param source The text of the file.
 */
export const splitFrontMatter = (source: string): SplitSource => {
  const text = source.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== "---") return { raw: null, body: text };
  const end = lines.findIndex((line, index) => index > 0 && line.trimEnd() === "---");
  if (end === -1) return { raw: null, body: text };
  return { raw: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n").replace(/^\n+/, "") };
};

const parseScalar = (text: string, line: number): string | number => {
  const value = text.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "string") return parsed;
    } catch {
      // falls through to the error below
    }
    throw new Error(`front matter line ${line}: a double-quoted value must be a valid JSON string`);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) throw new Error(`front matter line ${line}: a single-quoted value must end with a quote`);
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (/^\d+$/.test(value)) return Number(value);
  return value;
};

const parseValue = (text: string, line: number): string | number | (string | number)[] => {
  const value = text.trim();
  if (value.startsWith("[")) {
    if (!value.endsWith("]")) throw new Error(`front matter line ${line}: a list must close with ]`);
    const inner = value.slice(1, -1).trim();
    if (inner === "") return [];
    return inner.split(",").map((item) => parseScalar(item, line));
  }
  return parseScalar(value, line);
};

/**
 * Reads the block as a map.
 *
 * @param raw The text between the two `---` lines.
 * @throws When a line is not `key: value`, a key repeats, or a value uses YAML beyond the subset.
 */
export const parseFrontMatterBlock = (raw: string): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  raw.split("\n").forEach((rawLine, index) => {
    const line = index + 1;
    const text = rawLine.trimEnd();
    if (text.trim() === "" || text.trimStart().startsWith("#")) return;
    if (/^\s/.test(text) || text.startsWith("-")) throw new Error(`front matter line ${line}: nested maps and multi-line values are not supported; write the list on one line, such as [user, operator]`);
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(text);
    if (match === null) throw new Error(`front matter line ${line}: expected "key: value"`);
    const key = match[1] as string;
    if (key in result) throw new Error(`front matter line ${line}: the key "${key}" appears twice`);
    result[key] = parseValue(match[2] ?? "", line);
  });
  return result;
};

/** The answer of {@link validateFrontMatter}. */
export type Validation = { readonly ok: true; readonly value: FrontMatter } | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Checks a parsed block against the schema: `title`, `summary`, `audience`, `chains` and `verified_release` for every
 * page, and for a skill `kind: skill` with a kebab-case `name`. A page may say `kind: page`, or leave `kind` out.
 *
 * @param data The parsed block.
 */
export const validateFrontMatter = (data: Record<string, unknown>): Validation => {
  const errors: string[] = [];
  for (const key of Object.keys(data)) if (!KNOWN_KEYS.includes(key)) errors.push(`unknown key "${key}" (known: ${KNOWN_KEYS.join(", ")})`);

  const text = (key: string): string | null => {
    const value = data[key];
    if (typeof value !== "string" || value.trim() === "") {
      errors.push(`"${key}" is required and must be a non-empty text`);
      return null;
    }
    return value.trim();
  };

  const title = text("title");
  const summary = text("summary");
  if (summary !== null && (/[\r\n]/.test(summary) || summary.length > MAXIMUM_SUMMARY_LENGTH)) errors.push(`"summary" must be one line of at most ${MAXIMUM_SUMMARY_LENGTH} characters`);

  const rawAudience = data.audience;
  const audienceList = Array.isArray(rawAudience) ? rawAudience : rawAudience === undefined ? [] : [rawAudience];
  if (audienceList.length === 0) errors.push(`"audience" is required: one or more of ${AUDIENCES.join(", ")}`);
  for (const item of audienceList) if (!(AUDIENCES as readonly unknown[]).includes(item)) errors.push(`"audience" holds "${String(item)}"; allowed: ${AUDIENCES.join(", ")}`);
  if (new Set(audienceList).size !== audienceList.length) errors.push('"audience" repeats a value');

  const rawChains = data.chains;
  let chains: "all" | number[] = "all";
  if (rawChains === "all") chains = "all";
  else if (Array.isArray(rawChains) && rawChains.length > 0 && rawChains.every((id) => typeof id === "number" && id > 0)) chains = rawChains as number[];
  else if (typeof rawChains === "number" && rawChains > 0) chains = [rawChains];
  else errors.push('"chains" is required: "all" or a list of chain ids such as [11155111, 943]');

  const release = text("verified_release");
  if (release !== null && !VERSION.test(release)) errors.push(`"verified_release" must be a version such as 0.1.0, got "${release}"`);

  const kind = data.kind ?? "page";
  if (kind !== "page" && kind !== "skill") errors.push('"kind" must be "skill" or left out');
  const name = data.name;
  if (kind === "skill") {
    if (typeof name !== "string" || !KEBAB.test(name)) errors.push('a skill needs "name" in kebab-case, such as bridge-tokens');
  } else if (name !== undefined) errors.push('"name" is only for skills (kind: skill)');
  const description = data.description;
  if (kind === "skill") {
    if (typeof description !== "string" || description.trim() === "") errors.push('a skill needs "description": what it does and when to use it');
  } else if (description !== undefined) errors.push('"description" is only for skills (kind: skill)');

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      title: title as string,
      summary: summary as string,
      audience: audienceList as Audience[],
      chains,
      verified_release: release as string,
      kind: kind as "page" | "skill",
      ...(typeof name === "string" ? { name } : {}),
      ...(typeof description === "string" ? { description } : {}),
    },
  };
};

/** A file read into its front matter and its body. */
export type ParsedPage = { readonly meta: FrontMatter; readonly body: string };

/**
 * Reads and validates a file.
 *
 * @param source The text of the file.
 * @param label The path for the error text.
 * @throws With every problem on one line each, when the block is missing or invalid.
 */
export const readFrontMatter = (source: string, label: string): ParsedPage => {
  const { raw, body } = splitFrontMatter(source);
  if (raw === null) throw new Error(`${label}: the file has no front matter (a block between two --- lines at the top)`);
  let data: Record<string, unknown>;
  try {
    data = parseFrontMatterBlock(raw);
  } catch (error) {
    throw new Error(`${label}: ${(error as Error).message}`);
  }
  const result = validateFrontMatter(data);
  if (!result.ok) throw new Error(`${label}: ${result.errors.join("; ")}`);
  return { meta: result.value, body };
};
