import { describe, expect, it } from "vitest";
import { maskSecret, redactError, redactSecrets, REDACTED } from "../src/config/index.js";

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

  it("keeps a known secret shorter than six characters, because it would match too much text", () => {
    expect(redactSecrets("pin 1234 ok", ["1234"])).toBe("pin 1234 ok");
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

describe("redactError", () => {
  it("redacts the message of an Error", () => {
    expect(redactError(new Error("failed with hunter22"), ["hunter22"])).toBe(`failed with ${REDACTED}`);
  });

  it("redacts the text of a value that is not an Error", () => {
    expect(redactError("raw hunter22")).toBe("raw hunter22");
    expect(redactError("raw hunter22", ["hunter22"])).toBe(`raw ${REDACTED}`);
  });
});
