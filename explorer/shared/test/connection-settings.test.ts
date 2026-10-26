import { describe, expect, it } from "vitest";
import {
  DEFAULT_INDEXER_URL,
  describeSource,
  maskUrl,
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
    expect(resolved).toEqual({ indexerUrl: null, rpcUrls: { 1: null } });
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
