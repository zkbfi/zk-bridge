/**
 * The image server for token and chain icons, which the user can replace (owner: "image server should be another
 * thing that they can swap out"). Icons the release ships do not depend on it. Stored in this browser only.
 */
import { DEFAULT_IMAGE_SERVER } from "./image-source";

const KEY = "zk-bridge-explorer.image-server";

/**
 * Why a template cannot be used, or null. It must be an https URL with `{chainId}` and `{address}` in the path.
 *
 * @param template The template text.
 */
export const imageServerProblem = (template: string): string | null => {
  let url: URL;
  try {
    url = new URL(template.replace("{chainId}", "1").replace("{address}", "0x0"));
  } catch {
    return "This is not a URL.";
  }
  if (url.protocol !== "https:") return "Use an https:// address.";
  if (!template.includes("{chainId}") || !template.includes("{address}")) return "Put {chainId} and {address} where the chain and the token go.";
  return null;
};

/** The image server in use: the stored one when it is valid, else the default. */
export const loadImageServer = (storage: Pick<Storage, "getItem"> | null = safeStorage()): string => {
  try {
    const stored = storage?.getItem(KEY) ?? null;
    return stored !== null && imageServerProblem(stored) === null ? stored : DEFAULT_IMAGE_SERVER;
  } catch {
    return DEFAULT_IMAGE_SERVER;
  }
};

/**
 * Stores a template, or clears it (back to the default) when null. Returns the problem when the template is refused.
 *
 * @param template The template, or null for the default.
 */
export const saveImageServer = (template: string | null, storage: Pick<Storage, "setItem" | "removeItem"> | null = safeStorage()): string | null => {
  if (template !== null) {
    const problem = imageServerProblem(template);
    if (problem !== null) return problem;
  }
  try {
    if (template === null || template === DEFAULT_IMAGE_SERVER) storage?.removeItem(KEY);
    else storage?.setItem(KEY, template);
  } catch {
    // The choice then lasts for this visit only.
  }
  return null;
};

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}
