/**
 * Placeholders in page text, such as `{{contracts.11155111.bridge}}`. This file has no Node imports, so the dapp can use
 * it too: the in-app pages and the Markdown files show the same resolved values.
 */
import type { Facts } from "./facts.ts";

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;

const lookup = (facts: Facts, path: string): string | number | null => {
  const [root, ...rest] = path.split(".");
  let node: unknown = root === "contracts" ? facts.contracts.chains : root === "chains" ? facts.chains.chains : undefined;
  if (node === undefined) return null;
  for (const part of rest) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, part)) return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" || typeof node === "number" ? node : null;
};

/**
 * Replaces every `{{contracts.<chainId>.<field>}}` and `{{chains.<chainId>.<field>}}` with its value. The path after
 * the chain id follows the files: `{{contracts.943.testTokens.tUSD.address}}`, `{{chains.1.nativeSymbol}}`.
 *
 * @param source The text.
 * @param facts The fact files.
 * @param label The file name for the error text.
 * @throws When a placeholder names nothing, or a value that is empty or not text or a number.
 */
export const resolvePlaceholders = (source: string, facts: Facts, label: string): string => {
  const missing: string[] = [];
  const text = source.replace(PLACEHOLDER, (whole, path: string) => {
    const value = lookup(facts, path);
    if (value === null) {
      missing.push(path);
      return whole;
    }
    return String(value);
  });
  if (missing.length > 0) throw new Error(`${label}: unknown placeholder ${missing.map((path) => `{{${path}}}`).join(", ")}`);
  return text;
};

