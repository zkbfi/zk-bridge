import { describe, expect, it } from "vitest";
import { maskSecret, redactError, redactSecrets, REDACTED } from "../src/config/index.js";
import { isRegistrableSecret } from "../src/redaction.js";

describe("maskSecret", () => {
  it("answers an empty string for an empty secret", () => {
    expect(maskSecret("")).toBe("");
  });

  it("shows only stars for a secret shorter than twelve characters", () => {
    expect(maskSecret("short-key-1")).toBe("********");
  });

  it("shows the last four characters of a secret of twelve characters or more", () => {
    expect(maskSecret("abcdefghijkl")).toBe("********ijkl");
  });
});

describe("redactSecrets", () => {
  it("removes each occurrence of a known secret of six characters or more", () => {
    expect(redactSecrets("a=hunter22 b=hunter22", ["hunter22"])).toBe(`a=${REDACTED} b=${REDACTED}`);
  });

  it("removes a known secret shorter than six characters where it stands as a value, and keeps it inside a longer word (S-6)", () => {
    expect(redactSecrets("pin: 1234 ok, key=abcde&x=1, at /k9/ and @me, \"tok\": \"q1\"", ["1234", "abcde", "k9", "me", "q1"])).toBe(
      `pin: ${REDACTED} ok, key=${REDACTED}&x=1, at /${REDACTED}/ and @${REDACTED}, "tok": "${REDACTED}"`,
    );
    expect(redactSecrets("block=12345 and id=abcdefg", ["1234", "abcd"])).toBe("block=12345 and id=abcdefg");
    expect(redactSecrets("id=x here", ["x"])).toBe(`id=${REDACTED} here`);
  });

  it.each([
    ["after a space", "token abc12 in the url", `token ${REDACTED} in the url`],
    ["after Bearer", "Authorization: Bearer abc12", `Authorization: Bearer ${REDACTED}`],
    ["inside JSON without quotes", "{token: abc12, n: 1}", `{token: ${REDACTED}, n: 1}`],
    ["after a question mark", "GET /x?abc12", `GET /x?${REDACTED}`],
    ["in a path segment", "GET https://h/abc12/eth", `GET https://h/${REDACTED}/eth`],
    ["after a comma", "keys a,abc12", `keys a,${REDACTED}`],
  ])("removes a short known secret wherever it stands as a whole token: %s (fail closed)", (_name, text, expected) => {
    expect(redactSecrets(text, ["abc12"])).toBe(expected);
  });

  it("removes a short known secret that holds characters a pattern would read as special (S-6)", () => {
    expect(redactSecrets("pass a.b* and ab", ["a.b*"])).toBe(`pass ${REDACTED} and ab`);
  });

  it("never matches an empty value or white space", () => {
    expect(redactSecrets("a b", ["", "  "])).toBe("a b");
  });

  it("removes the percent-encoded form of a known secret (S-6)", () => {
    const secret = "pa ss/word!";
    expect(redactSecrets(`https://rpc.example/?q=${encodeURIComponent(secret)} and ${secret}`, [secret])).toBe(`https://rpc.example/?q=${REDACTED} and ${REDACTED}`);
  });

  it.each([
    ["QuickNode path token", "https://black-wild-sun.quiknode.pro/4f1c9a0b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70/", `https://black-wild-sun.quiknode.pro/${REDACTED}/`],
    ["QuickNode short token", "https://x.quiknode.pro/abc123/", `https://x.quiknode.pro/${REDACTED}/`],
    ["Ankr path key", "https://rpc.ankr.com/eth/9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d", `https://rpc.ankr.com/eth/${REDACTED}`],
    ["hex path key on any host", "https://node.example/0123456789abcdef0123456789abcdef/eth", `https://node.example/${REDACTED}/eth`],
    ["Alchemy", "https://eth-mainnet.g.alchemy.com/v2/AbCdEfGhIjKlMnOpQrStUv", `https://eth-mainnet.g.alchemy.com/v2/${REDACTED}`],
    ["valve.city", "https://rpc.valve.city/rpc/abcdefgh12/evm/1", `https://rpc.valve.city/rpc/${REDACTED}/evm/1`],
    ["access_token query", "https://b.example/eth/v1?access_token=tok_live_99887766", `https://b.example/eth/v1?access_token=${REDACTED}`],
    ["apikey query", "https://b.example/?apikey=Z9&n=1", `https://b.example/?apikey=${REDACTED}&n=1`],
    ["dkey query", "https://lb.drpc.org/ogrpc?network=ethereum&dkey=AkLmNoPq", `https://lb.drpc.org/ogrpc?network=ethereum&${"dkey"}=${REDACTED}`],
    ["x-api-key header", "x-api-key: 77aa88bb99cc00dd", `x-api-key: ${REDACTED}`],
    ["X-API-Key header", "X-API-Key:77aa", `X-API-Key:${REDACTED}`],
    ["authorization header without a scheme", "authorization: s3cr3t", `authorization: ${REDACTED}`],
    ["authorization header with another scheme", "Authorization: Token abc", `Authorization: Token ${REDACTED}`],
    ["JSON x-api-key", '{"x-api-key":"77aa"}', `{"x-api-key":"${REDACTED}"}`],
    ["JSON access_token", '{"access_token":"t"}', `{"access_token":"${REDACTED}"}`],
    ["JSON authorization", '{"Authorization":"Bearer t"}', `{"Authorization":"${REDACTED}"}`],
  ])("removes the %s that the caller did not name (S-6)", (_name, input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it.each([
    ["a transaction hash in a path", "GET https://explorer.example/tx/0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"],
    ["a job identifier in a path", "POST /webhook/jobs/1b4e28ba-2fa1-11d2-883f-0016d3cca427"],
    ["a short hex path segment", "GET https://node.example/eth/v1/beacon/headers/12345678"],
    ["a public query value", "GET https://b.example/?network=ethereum&slot=100"],
  ])("keeps %s", (_name, input) => {
    expect(redactSecrets(input)).toBe(input);
  });

  it("removes the key of a versioned provider path such as /v3/<key>, and keeps a short path", () => {
    expect(redactSecrets("GET https://rpc.example.org/v3/FAKEKEY1234567890 failed")).toBe(`GET https://rpc.example.org/v3/${REDACTED} failed`);
    expect(redactSecrets("GET https://rpc.example.org/v3/health failed")).toBe("GET https://rpc.example.org/v3/health failed");
  });

  it.each([
    ["key vk_abc-123_X end", `key ${REDACTED} end`],
    ["key rpa_abc-123_X end", `key ${REDACTED} end`],
    ["Authorization: Bearer abcdefgh12345", `Authorization: Bearer ${REDACTED}`],
    ["https://h/x?api_key=sekret&a=1", `https://h/x?api_key=${REDACTED}&a=1`],
    ['{"token":"abc","x":1}', `{"token":"${REDACTED}","x":1}`],
    ["GET /rpc/abcdefgh12/evm/1", `GET /rpc/${REDACTED}/evm/1`],
    ["postgres://user:pass@host/db", `postgres://${REDACTED}@host/db`],
  ])("removes the secret in %s", (input, expected) => {
    expect(redactSecrets(input)).toBe(expected);
  });

  it("leaves text without a secret unchanged", () => {
    expect(redactSecrets("nothing to hide")).toBe("nothing to hide");
  });
});

describe("isRegistrableSecret: what may become a known secret", () => {
  it.each(["user", "admin", "password", "Password", "eth", "v1", "1", "true", "null", "", "  "])("refuses %j unless it is marked secret", (value) => {
    expect(isRegistrableSecret(value)).toBe(false);
  });

  it("refuses a common word or a configuration literal even when it is marked secret", () => {
    expect(isRegistrableSecret("password", { marked: true })).toBe(false);
    expect(isRegistrableSecret("true", { marked: true })).toBe(false);
  });

  it("takes a short value that the configuration marks secret, and a long value that is no common word", () => {
    expect(isRegistrableSecret("k9x", { marked: true })).toBe(true);
    expect(isRegistrableSecret("4f1c9a0b2d3e")).toBe(true);
  });
});

describe("redactError", () => {
  it("redacts the message of an Error", () => {
    expect(redactError(new Error("failed with hunter22"), ["hunter22"])).toBe(`failed with ${REDACTED}`);
  });

  it("redacts the text of a value that is not an Error", () => {
    expect(redactError("raw hunter22")).toBe("raw hunter22");
    expect(redactError("raw hunter22", ["hunter22"])).toBe(`raw ${REDACTED}`);
  });
});
