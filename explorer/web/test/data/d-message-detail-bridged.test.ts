import { describe, expect, it } from "vitest";
import { parseMessageDetail } from "../../src/data/message-detail";

const ADDRESS = "0x52908400098527886e0f7030069857d2e4169ee7";
const CHECKSUM = "0x52908400098527886E0F7030069857D2E4169EE7";

describe("parseMessageDetail, a bridged copy", () => {
  it("keeps the mark of a token that is a bridged copy", () => {
    const token = { address: ADDRESS, symbol: "zUSDC", decimals: 6, chainId: 369, isBridgedCopy: true };
    const parsed = parseMessageDetail({
      messageId: `0x${"AB".repeat(32)}`,
      kind: "token",
      status: "sent",
      direction: { sourceChainId: 369, destinationChainId: 1 },
      sender: ADDRESS,
      executor: ADDRESS,
      sent: { transactionHash: `0x${"cd".repeat(32)}`, blockNumber: 12, timestamp: 100 },
      transfer: { sourceToken: token, destinationToken: { ...token, chainId: 1, isBridgedCopy: false }, recipient: ADDRESS, value: "10", deliveredValue: null, hasCallback: false },
    });
    expect(parsed.transfer?.sourceToken).toEqual({ address: CHECKSUM, symbol: "zUSDC", decimals: 6, chainId: 369, isBridgedCopy: true });
    expect(parsed.transfer?.destinationToken).toEqual({ address: CHECKSUM, symbol: "zUSDC", decimals: 6, chainId: 1 });
  });
});
