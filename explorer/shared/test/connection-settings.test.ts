import { describe, expect, it } from "vitest";
import {
  boardUrlOf,
  migrateBoardUrls,
  DEFAULT_INDEXER_URL,
  describeSource,
  maskUrl,
  normalizeEndpoint,
  parseConnectionUrl,
  redactConnectionText,
  resolveConnection,
  urlSecrets,
} from "../src/index.js";

const KEY = "FAKEKEY1234567890";
const keyed = `https://rpc.example.org/v3/${KEY}`;

describe("resolveConnection", () => {
  const chainIds = [1, 369];

  it("takes the user setting before the environment and the environment before the registry default", () => {
    const resolved = resolveConnection({
      chainIds,
      user: { indexerUrl: "https://user.example/indexer", rpcUrls: { 1: "https://user.example/1" } },
      environment: { indexerUrl: "https://env.example/indexer", rpcUrls: { 1: "https://env.example/1", 369: "https://env.example/369" } },
      registry: { indexerUrl: DEFAULT_INDEXER_URL, rpcUrls: { 1: "https://registry.example/1", 369: "https://registry.example/369" } },
    });
    expect(resolved.indexerUrl).toEqual({ value: "https://user.example/indexer", source: "user" });
    expect(resolved.rpcUrls[1]).toEqual({ value: "https://user.example/1", source: "user" });
    expect(resolved.rpcUrls[369]).toEqual({ value: "https://env.example/369", source: "environment" });
  });

  it("falls back to the registry default when the user and the environment set nothing", () => {
    const resolved = resolveConnection({
      chainIds,
      user: {},
      environment: {},
      registry: { indexerUrl: DEFAULT_INDEXER_URL, rpcUrls: { 369: "https://registry.example/369" } },
    });
    expect(resolved.indexerUrl).toEqual({ value: DEFAULT_INDEXER_URL, source: "default" });
    expect(resolved.rpcUrls[369]).toEqual({ value: "https://registry.example/369", source: "default" });
    expect(resolved.rpcUrls[1]).toBeNull();
  });

  it("skips a source that holds only blanks, so clearing a user setting returns to the weaker source", () => {
    const resolved = resolveConnection({
      chainIds: [1],
      user: { indexerUrl: "   ", rpcUrls: { 1: "" } },
      environment: { indexerUrl: null, rpcUrls: { 1: "https://env.example/1" } },
      registry: { indexerUrl: "https://default.example" },
    });
    expect(resolved.rpcUrls[1]).toEqual({ value: "https://env.example/1", source: "environment" });
    expect(resolved.indexerUrl).toEqual({ value: "https://default.example", source: "default" });
  });

  it("gives null for a setting that no source has", () => {
    const resolved = resolveConnection({ chainIds: [1], user: {}, environment: {}, registry: {} });
    expect(resolved).toEqual({ indexerUrl: null, rpcUrls: { 1: null }, msgboardUrls: { 1: null }, backendUrl: null, msgboardIndexerUrl: null, archiveUrl: null, msgboardUrl: null });
  });
});

describe("describeSource", () => {
  it("names each source in plain words", () => {
    expect(describeSource("user")).toBe("set by you");
    expect(describeSource("environment")).toBe("from the environment");
    expect(describeSource("default")).toBe("default");
  });
});

describe("parseConnectionUrl", () => {
  it("accepts http and https and trims the text", () => {
    expect(parseConnectionUrl("  https://rpc.example.org/x  ", "rpc")).toEqual({ ok: true, url: "https://rpc.example.org/x" });
    expect(parseConnectionUrl("http://localhost:8545", "rpc")).toEqual({ ok: true, url: "http://localhost:8545" });
  });

  it("removes the trailing slashes of an indexer URL and keeps those of an RPC URL", () => {
    expect(parseConnectionUrl("http://localhost:42069//", "indexer")).toEqual({ ok: true, url: "http://localhost:42069" });
    expect(parseConnectionUrl("https://rpc.example.org/", "rpc")).toEqual({ ok: true, url: "https://rpc.example.org/" });
  });

  it("refuses text that is not a URL, and a scheme that is not http or https", () => {
    expect(parseConnectionUrl("not a url", "rpc")).toMatchObject({ ok: false });
    expect(parseConnectionUrl("rpc.example.org", "rpc")).toMatchObject({ ok: false, message: expect.stringContaining("http:// or https://") });
    expect(parseConnectionUrl("wss://rpc.example.org", "rpc")).toMatchObject({ ok: false, message: expect.stringContaining("must start with http:// or https://") });
  });

  it("refuses a space, a quote or a backslash, which the Keychain store cannot hold", () => {
    for (const text of ['https://a.example/"x', "https://a.example/'x", "https://a.example/\\x"]) {
      expect(parseConnectionUrl(text, "indexer")).toMatchObject({ ok: false, message: expect.stringContaining("indexer URL") });
    }
  });

  it("never repeats the URL in a message, because the URL can hold a key", () => {
    for (const text of [`${keyed} extra`, `ftp://x/${KEY}`, `not a url ${KEY}`]) {
      const result = parseConnectionUrl(text, "rpc");
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(KEY);
    }
  });
});

describe("maskUrl", () => {
  it("keeps the scheme and the host and masks everything after the host", () => {
    expect(maskUrl(keyed)).toBe("https://rpc.example.org/********7890");
    expect(maskUrl(keyed)).not.toContain(KEY);
  });

  it("shows a URL with no path as the origin alone", () => {
    expect(maskUrl("https://rpc.example.org")).toBe("https://rpc.example.org");
  });

  it("masks a key in the query and never shows a user name or a password", () => {
    expect(maskUrl(`https://user:hunter2hunter2@rpc.example.org/?apikey=${KEY}`)).toBe("https://rpc.example.org/********7890");
  });

  it("shows only stars for a short rest, and masks a text that is not a URL", () => {
    expect(maskUrl("https://rpc.example.org/abc")).toBe("https://rpc.example.org/********");
    expect(maskUrl("not a url but long enough")).toBe("********ough");
  });
});

describe("urlSecrets and redactConnectionText", () => {
  it("lists the whole URL, the credentials, the path and the query values", () => {
    const secrets = urlSecrets(`https://bob:hunter2hunter2@rpc.example.org/v3/${KEY}?token=${KEY}2`);
    expect(secrets).toEqual(expect.arrayContaining([`https://bob:hunter2hunter2@rpc.example.org/v3/${KEY}?token=${KEY}2`, "bob", "hunter2hunter2", `v3/${KEY}`, `token=${KEY}2`, `${KEY}2`]));
  });

  it("lists only the text for a text that is not a URL", () => {
    expect(urlSecrets("plain text")).toEqual(["plain text"]);
  });

  it("removes the whole URL, and the key alone, from an error message", () => {
    const message = `HTTP request failed. URL: ${keyed}. Details: path /v3/${KEY} not found`;
    const cleaned = redactConnectionText(message, [keyed]);
    expect(cleaned).not.toContain(KEY);
    expect(cleaned).toContain("HTTP request failed");
  });

  it("removes a key that only the pattern rules know, when no URL is given", () => {
    expect(redactConnectionText(`GET /v2/${KEY} failed`, [])).not.toContain(KEY);
  });
});

describe("the endpoints beside the indexer", () => {
  const layers = { chainIds: [1], registry: {} } as const;
  const endpointCases = [
    ["backendUrl", "https://user.example/b", "https://env.example/b", "https://default.example/b"],
    ["msgboardIndexerUrl", "https://user.example/m", "https://env.example/m", "https://default.example/m"],
    ["archiveUrl", "https://user.example/a", "https://env.example/a", "https://default.example/a"],
    ["msgboardUrl", "https://user.example/n", "https://env.example/n", "https://default.example/n"],
  ] as const;

  for (const [key, user, environment, fallback] of endpointCases) {
    it(`resolves ${key} from the user, then the environment, then the default`, () => {
      const resolve = (userLayer: object, environmentLayer: object) =>
        resolveConnection({ ...layers, user: userLayer, environment: environmentLayer, registry: { [key]: fallback } })[key];
      expect(resolve({ [key]: user }, { [key]: environment })).toEqual({ value: user, source: "user" });
      expect(resolve({ [key]: "  " }, { [key]: environment })).toEqual({ value: environment, source: "environment" });
      expect(resolve({}, {})).toEqual({ value: fallback, source: "default" });
      expect(resolveConnection({ ...layers, user: {}, environment: {}, registry: {} })[key]).toBeNull();
    });
  }
});

describe("normalizeEndpoint", () => {
  const normalize = (text: string, pageProtocol: "https:" | "http:" = "https:") => normalizeEndpoint({ text, pageProtocol });

  it("drops one trailing slash and keeps a path prefix", () => {
    expect(normalize("https://x.example/api/")).toEqual({ ok: true, url: "https://x.example/api", warning: null });
    expect(normalize("  https://x.example/a/b  ")).toEqual({ ok: true, url: "https://x.example/a/b", warning: null });
    expect(normalize("https://x.example/")).toEqual({ ok: true, url: "https://x.example", warning: null });
  });

  it("warns for http on an https page, and only then", () => {
    expect(normalize("http://x.example/api", "https:")).toEqual({ ok: true, url: "http://x.example/api", warning: "insecure-on-secure-page" });
    expect(normalize("http://x.example/api", "http:")).toMatchObject({ ok: true, warning: null });
    expect(normalize("https://x.example", "https:")).toMatchObject({ ok: true, warning: null });
  });

  it("refuses a URL with credentials, and never repeats the secret", () => {
    const refused = normalize("https://user:FAKEKEY1234567890@x.example");
    expect(refused).toMatchObject({ ok: false, reason: expect.stringMatching(/user name or a password/) });
    expect(JSON.stringify(refused)).not.toContain("FAKEKEY1234567890");
    expect(normalize("https://user@x.example").ok).toBe(false);
  });

  it("refuses text that is not a plain http or https URL", () => {
    expect(normalize("ftp://x.example")).toMatchObject({ ok: false, reason: "The URL must start with http:// or https://." });
    expect(normalize("nonsense")).toMatchObject({ ok: false, reason: expect.stringMatching(/not a URL/) });
    expect(normalize("https://x.example/a b")).toMatchObject({ ok: false, reason: expect.stringMatching(/space/) });
    expect(normalize("https://x.example/?key=1")).toMatchObject({ ok: false, reason: expect.stringMatching(/query/) });
    expect(normalize("https://x.example/#top")).toMatchObject({ ok: false, reason: expect.stringMatching(/fragment/) });
  });
});

describe("the msgboard node per chain (owner, quote 87)", () => {
  const chainIds = [1, 369];
  it("resolves each chain on its own, a chain without its own node falling back to the single one of the same source", () => {
    const resolved = resolveConnection({
      chainIds,
      user: { msgboardUrls: { 369: "https://board-pls.example" } },
      environment: { msgboardUrl: "https://board.example" },
      registry: {},
    });
    expect(resolved.msgboardUrls?.[369]).toEqual({ value: "https://board-pls.example", source: "user" });
    expect(resolved.msgboardUrls?.[1]).toEqual({ value: "https://board.example", source: "environment" });
    expect(boardUrlOf(resolved, 1)?.value).toBe("https://board.example");
    expect(boardUrlOf({ msgboardUrl: { value: "https://only.example", source: "user" } }, 369)?.value).toBe("https://only.example");
  });

  it("lets two chains share one URL, each its own entry", () => {
    const resolved = resolveConnection({ chainIds, user: { msgboardUrls: { 1: "https://same.example", 369: "https://same.example" } }, environment: {}, registry: {} });
    expect(resolved.msgboardUrls).toEqual({ 1: { value: "https://same.example", source: "user" }, 369: { value: "https://same.example", source: "user" } });
  });

  it("moves a saved single node to every chain and clears it; a chain's own node stays", () => {
    const old = { indexerUrl: null, rpcUrls: {}, msgboardUrl: "https://old.example" };
    expect(migrateBoardUrls(old, chainIds)).toEqual({ indexerUrl: null, rpcUrls: {}, msgboardUrl: null, msgboardUrls: { 1: "https://old.example", 369: "https://old.example" } });
    expect(migrateBoardUrls({ ...old, msgboardUrls: { 369: "https://mine.example" } }, chainIds).msgboardUrls).toEqual({ 1: "https://old.example", 369: "https://mine.example" });
    const none = { indexerUrl: null, rpcUrls: {} };
    expect(migrateBoardUrls(none, chainIds)).toBe(none);
  });
});
