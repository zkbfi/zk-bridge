/** Which download fits the visitor: reads the browser's platform and returns a key such as `darwin-arm64`. */

/** What was found. `key` is null when nothing can be chosen for the visitor. `assumed` is true when the chip is a guess. */
export type Detection = { key: string | null; assumed: boolean };

/** The part of `navigator` that detection reads. */
export type NavigatorLike = {
  userAgent?: string;
  userAgentData?: {
    platform?: string;
    getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string; bitness?: string; platform?: string }>;
  };
};

const NONE: Detection = { key: null, assumed: false };

/** An iPhone, iPad or Android device has no terminal program to download. */
function isMobile(userAgent: string): boolean {
  return /iPhone|iPad|iPod|Android/i.test(userAgent);
}

function archFromUserAgent(userAgent: string): "arm64" | "x64" | null {
  if (/aarch64|arm64|armv8/i.test(userAgent)) return "arm64";
  if (/x86_64|x86-64|x64|amd64|win64/i.test(userAgent)) return "x64";
  return null;
}

/**
 * Detects the platform from a user agent string alone. A Mac's chip is not in the string (every Mac says Intel), so a
 * Mac is reported as Apple silicon with `assumed` set. A system that names no chip is not guessed, except Windows,
 * which has one build.
 */
export function detectFromUserAgent(userAgent: string): Detection {
  if (isMobile(userAgent)) return NONE;
  if (/Windows/i.test(userAgent)) return { key: "windows-x64", assumed: false };
  if (/Macintosh|Mac OS X/i.test(userAgent)) return { key: "darwin-arm64", assumed: true };
  if (/Linux|X11/i.test(userAgent)) {
    const arch = archFromUserAgent(userAgent);
    return arch === null ? NONE : { key: `linux-${arch}`, assumed: false };
  }
  return NONE;
}

function keyFromHints(platform: string, architecture: string, bitness: string): Detection | null {
  const arch = /arm/i.test(architecture) ? "arm64" : /x86/i.test(architecture) && bitness !== "32" ? "x64" : null;
  if (/mac/i.test(platform)) return arch === null ? { key: "darwin-arm64", assumed: true } : { key: `darwin-${arch}`, assumed: false };
  if (/windows/i.test(platform)) return { key: "windows-x64", assumed: false };
  if (/linux/i.test(platform)) return arch === null ? NONE : { key: `linux-${arch}`, assumed: false };
  return null;
}

/**
 * Detects the platform. It asks `userAgentData.getHighEntropyValues` for the architecture and bitness where the browser
 * has it, and falls back to the user agent string when it is missing, fails, or names no platform it knows.
 */
export async function detectPlatform(navigatorLike: NavigatorLike): Promise<Detection> {
  const userAgent = navigatorLike.userAgent ?? "";
  if (isMobile(userAgent)) return NONE;
  const data = navigatorLike.userAgentData;
  if (data?.getHighEntropyValues !== undefined) {
    try {
      const values = await data.getHighEntropyValues(["architecture", "bitness", "platform"]);
      const found = keyFromHints(values.platform ?? data.platform ?? "", values.architecture ?? "", values.bitness ?? "");
      if (found !== null) return found;
    } catch {
      // the browser refused: the user agent string is the fallback
    }
  }
  return detectFromUserAgent(userAgent);
}

/** The readable name of a platform key, such as `macOS · Apple silicon`. An unknown key is shown as written. */
export function platformLabel(key: string): string {
  const match = /^(darwin|linux|windows)-(arm64|x64)$/.exec(key);
  if (match === null) return key === "any" ? "Any system" : key;
  const [, os, arch] = match;
  if (os === "darwin") return arch === "arm64" ? "macOS · Apple silicon" : "macOS · Intel";
  return `${os === "linux" ? "Linux" : "Windows"} · ${arch === "arm64" ? "Arm64" : "x64"}`;
}

/** The order of the menu: macOS, Linux, Windows; within one, Apple silicon / x64 before the rest. */
export function platformRank(key: string): number {
  const order = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];
  const index = order.indexOf(key);
  return index === -1 ? order.length : index;
}
