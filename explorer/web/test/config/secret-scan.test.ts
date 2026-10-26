import { describe, expect, it } from "vitest";
import { assertNoSecrets, ConfigurationError, findSecretLikeValues } from "../../src/config/secret-scan";

// Each sample is built from parts, so that this file holds no string that a scanner would take for a real key.
const SIGNING_KEY = `0x${"ab".repeat(32)}`;
const VK_TOKEN = `vk_${"x9".repeat(8)}`;

describe("findSecretLikeValues", () => {
  it("refuses a vk_ token in any value, because the page publishes every VITE_ variable", () => {
    const findings = findSecretLikeValues({ VITE_EXPLORER_RPC_URL_1: `https://rpc.example.org/${VK_TOKEN}/evm/1` });
    expect(findings.map((finding) => finding.reason)).toContain("contains a vk_ token");
  });

  it("refuses 32 bytes of hex, with or without the prefix", () => {
    expect(findSecretLikeValues({ VITE_A: SIGNING_KEY })).not.toHaveLength(0);
    expect(findSecretLikeValues({ VITE_A: "ab".repeat(32) })).not.toHaveLength(0);
  });

  it("allows an address, which is 20 bytes", () => {
    expect(findSecretLikeValues({ VITE_A: `0x${"ab".repeat(20)}` })).toHaveLength(0);
  });

  it("refuses a name and password in a URL, and a key in the query", () => {
    expect(findSecretLikeValues({ VITE_A: "https://user:hunter2@rpc.example.org" })).not.toHaveLength(0);
    expect(findSecretLikeValues({ VITE_A: "https://rpc.example.org/?apikey=abc" })).not.toHaveLength(0);
  });

  it("refuses a long mixed segment in the path of a URL, the way a keyed proxy reads its key", () => {
    expect(findSecretLikeValues({ VITE_A: "https://proxy.example.org/rpc/3f9a1b2c4d5e6f708192a3b4c5d6/evm/1" })).not.toHaveLength(0);
  });

  it("refuses a recovery phrase and a variable that is named for a secret", () => {
    const phrase = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    expect(findSecretLikeValues({ VITE_A: phrase })).not.toHaveLength(0);
    expect(findSecretLikeValues({ VITE_SIGNER_PASSWORD: "x" })).not.toHaveLength(0);
  });

  it("allows an ordinary public endpoint and an empty value", () => {
    expect(findSecretLikeValues({ VITE_EXPLORER_RPC_URL_369: "https://rpc.pulsechain.com", VITE_EXPLORER_PAIR: "eth-pls", VITE_EMPTY: "", VITE_MISSING: undefined })).toHaveLength(0);
  });

  it("never repeats the value in a finding", () => {
    const findings = findSecretLikeValues({ VITE_A: SIGNING_KEY });
    expect(JSON.stringify(findings)).not.toContain(SIGNING_KEY.slice(2, 20));
  });
});

describe("assertNoSecrets", () => {
  it("throws a ConfigurationError that names the variable and not the value", () => {
    expect(() => assertNoSecrets({ VITE_A: SIGNING_KEY })).toThrow(ConfigurationError);
    expect(() => assertNoSecrets({ VITE_A: SIGNING_KEY })).toThrow(/VITE_A/);
    try {
      assertNoSecrets({ VITE_A: SIGNING_KEY });
    } catch (error) {
      expect(String(error)).not.toContain(SIGNING_KEY.slice(2, 20));
    }
  });
});
