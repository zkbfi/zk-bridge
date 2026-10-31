import { describe, expect, it } from "vitest";
import {
  auditItemView,
  auditToken,
  gateView,
  headUpdateView,
  headView,
  inFlightView,
  indexTokens,
  lastHeadUpdateView,
  tokenListItemView,
  tokenView,
  volumeView,
  type HeadUpdateRow,
  type TokenRow,
} from "../src/index.js";
import { addressOf, hashOf, testPair } from "./support/fixtures.js";

const pair = testPair();
const [ethereum, pulsechain] = pair.sides;
const native = addressOf("aa");
const copy = addressOf("bb");
const tokenRow: TokenRow = {
  chainId: 1,
  address: native,
  name: "Tether",
  symbol: "USDT",
  decimals: 6,
  metadataRead: true,
  isBridgedCopy: false,
  homeChainId: 1,
  homeToken: native,
  registeredTransactionHash: hashOf("11"),
  registeredBlockNumber: 12n,
  registeredTimestamp: 120n,
};
const index = indexTokens([tokenRow]);

const update: HeadUpdateRow = {
  chainId: 369,
  slot: 9_000n,
  headerRoot: hashOf("01"),
  executionBlockHash: hashOf("02"),
  executionBlockNumber: 500n,
  transactionHash: hashOf("03"),
  blockNumber: 80n,
  timestamp: 8_000n,
  gasUsed: 300_000n,
  effectiveGasPrice: 3n,
  costWei: 900_000n,
  poster: addressOf("99"),
};

describe("tokenListItemView", () => {
  it("adds the registration facts to the token facts", () => {
    expect(tokenListItemView(tokenRow, index)).toEqual({
      ...tokenView(1, native, index),
      registeredTransactionHash: hashOf("11"),
      registeredBlockNumber: 12,
      registeredTimestamp: 120,
    });
  });

  it("keeps a token that was never registered with null registration facts", () => {
    const bare = { ...tokenRow, registeredTransactionHash: null, registeredBlockNumber: null, registeredTimestamp: null };
    expect(tokenListItemView(bare, indexTokens([bare]))).toMatchObject({ registeredBlockNumber: null, registeredTimestamp: null });
  });
});

describe("headUpdateView and lastHeadUpdateView", () => {
  it("turns slots and times into numbers and gas into strings", () => {
    expect(headUpdateView(update)).toMatchObject({
      chainId: 369,
      slot: 9_000,
      executionBlockNumber: 500,
      blockNumber: 80,
      timestamp: 8_000,
      gasUsed: "300000",
      effectiveGasPrice: "3",
      costWei: "900000",
    });
  });

  it("gives a null update for a side that has none, so a client can tell no update from an old one", () => {
    expect(lastHeadUpdateView(1, undefined)).toEqual({ chainId: 1, update: null });
    expect(lastHeadUpdateView(369, update)).toEqual({
      chainId: 369,
      update: {
        slot: 9_000,
        executionBlockNumber: 500,
        transactionHash: hashOf("03"),
        timestamp: 8_000,
        gasUsed: "300000",
        costWei: "900000",
        poster: addressOf("99"),
      },
    });
  });
});

describe("headView", () => {
  const head = { chainId: 369, slot: 1_000n, headerRoot: hashOf("01"), executionBlockNumber: 70n, updatedTimestamp: 7_000n, updateCount: 4 };
  const tip = (chainId: number, blockNumber: bigint, timestamp: bigint) => ({ chainId, blockNumber, timestamp, baseFeePerGas: null });

  it("measures the lag in slots from the finalized slot and in seconds from the tip of the tracked chain", () => {
    expect(
      headView({
        side: pulsechain,
        tracked: ethereum,
        head,
        finalizedSlot: 1_040,
        headBlockTimestamp: 6_900,
        trackedTip: tip(1, 99n, 7_000n),
        ownTip: tip(369, 50n, 7_100n),
      }),
    ).toMatchObject({
      chainId: 369,
      trackedChainId: 1,
      lightClient: pulsechain.contracts.lightClient,
      storedHeadSlot: 1_000,
      storedHeadExecutionBlock: 70,
      storedHeadExecutionTimestamp: 6_900,
      lastUpdateTimestamp: 7_000,
      updateCount: 4,
      finalizedSlot: 1_040,
      lagSlots: 40,
      lagSeconds: 100,
      trackedChainTipBlock: 99,
      ownChainTipTimestamp: 7_100,
    });
  });

  it("never reports a negative lag", () => {
    const view = headView({ side: pulsechain, tracked: ethereum, head, finalizedSlot: 900, headBlockTimestamp: 7_500, trackedTip: tip(1, 99n, 7_000n), ownTip: undefined });
    expect(view.lagSlots).toBe(0);
    expect(view.lagSeconds).toBe(0);
  });

  it("tells a head that came from an update, with the slot the light client started from", () => {
    const view = headView({
      side: pulsechain,
      tracked: ethereum,
      head: { ...head, initialSlot: 900n, initialHeadBlockNumber: 40n, genesisTime: 100n, secondsPerSlot: 12n },
      finalizedSlot: 1_040,
      headBlockTimestamp: 6_900,
      trackedTip: tip(1, 99n, 7_000n),
      ownTip: undefined,
    });
    expect(view).toMatchObject({
      storedHeadSlot: 1_000,
      storedHeadSource: "update",
      storedHeadSlotTimestamp: 100 + 1_000 * 12,
      initialized: true,
      initializedAtSlot: 900,
      initializedAtBlock: 40,
      updateCount: 4,
    });
  });

  it("shows the head set at deployment as the stored head, with no update, and measures the lag from its slot time", () => {
    const deployment = {
      chainId: 943,
      slot: 11_463_040n,
      headerRoot: hashOf("01"),
      executionBlockNumber: null,
      updatedTimestamp: null,
      updateCount: 0,
      initialSlot: 11_463_040n,
      initialHeadBlockNumber: 25_767_020n,
      genesisTime: 1_655_733_600n,
      secondsPerSlot: 12n,
    };
    const slotTime = 1_655_733_600 + 11_463_040 * 12;
    const view = headView({
      side: pulsechain,
      tracked: ethereum,
      head: deployment,
      finalizedSlot: 11_477_760,
      headBlockTimestamp: null,
      trackedTip: tip(1, 99n, BigInt(slotTime + 3_600)),
      ownTip: undefined,
    });
    expect(view).toMatchObject({
      storedHeadSlot: 11_463_040,
      storedHeadSource: "deployment",
      storedHeadExecutionBlock: null,
      storedHeadExecutionTimestamp: null,
      storedHeadSlotTimestamp: slotTime,
      lastUpdateTimestamp: null,
      updateCount: 0,
      initialized: true,
      initializedAtSlot: 11_463_040,
      initializedAtBlock: 25_767_020,
      lagSlots: 11_477_760 - 11_463_040,
      lagSeconds: 3_600,
    });
  });

  it("says a light client with no head is not initialized", () => {
    const view = headView({ side: pulsechain, tracked: ethereum, head: undefined, finalizedSlot: 5, headBlockTimestamp: null, trackedTip: undefined, ownTip: undefined });
    expect(view).toMatchObject({ initialized: false, storedHeadSource: null, initializedAtSlot: null, initializedAtBlock: null, storedHeadSlotTimestamp: null });
  });

  it("reports unknown lags as null when the head, the beacon or the tip is missing", () => {
    const view = headView({ side: pulsechain, tracked: ethereum, head: undefined, finalizedSlot: null, headBlockTimestamp: null, trackedTip: undefined, ownTip: undefined });
    expect(view).toMatchObject({ storedHeadSlot: null, updateCount: 0, lagSlots: null, lagSeconds: null, trackedChainTipBlock: null, ownChainTipBlock: null });
    expect(headView({ side: pulsechain, tracked: ethereum, head, finalizedSlot: null, headBlockTimestamp: 1, trackedTip: undefined, ownTip: undefined }).lagSlots).toBeNull();
  });
});

describe("gateView", () => {
  const gate = {
    chainId: 369,
    sealed: false,
    sealedVersion: null,
    sealedSlot: null,
    enforcing: false,
    lastConfirmedEpoch: 5n,
    lastConfirmedVersion: "0x01020304",
    lastConfirmedTimestamp: 6_000n,
    confirmations: 2,
  } as const;
  const bridge = { chainId: 369, depositsOpen: true, openedRemoteSlot: 1n, openedBlockNumber: 2n, openedTimestamp: 3n };

  it("prefers the live flags over the stored ones, because a gate can start enforcing with no event", () => {
    expect(gateView({ side: pulsechain, live: { enforcing: true, sealed: true }, gate, bridge })).toMatchObject({
      chainId: 369,
      gate: pulsechain.contracts.gate,
      enforcing: true,
      sealed: true,
      lastConfirmedEpoch: 5,
      lastConfirmedTimestamp: 6_000,
      confirmations: 2,
      depositsOpen: true,
      depositsOpenedTimestamp: 3,
    });
  });

  it("falls back to the stored flags when the chain does not answer, and to null when nothing is stored", () => {
    expect(gateView({ side: pulsechain, live: null, gate, bridge })).toMatchObject({ enforcing: false, sealed: false });
    expect(gateView({ side: pulsechain, live: null, gate: undefined, bridge: undefined })).toMatchObject({
      enforcing: null,
      sealed: null,
      confirmations: 0,
      depositsOpen: false,
      depositsOpenedTimestamp: null,
      lastConfirmedTimestamp: null,
    });
  });
});

describe("inFlightView", () => {
  it("counts by status and by direction, and lists every status even when its count is zero", () => {
    expect(
      inFlightView(
        [
          { direction: "1>369", status: "sent", count: 2 },
          { direction: "1>369", status: "covered", count: 1 },
          { direction: "369>1", status: "sent", count: 4 },
        ],
        ["sent", "waiting_for_finality", "covered"],
      ),
    ).toEqual({
      total: 7,
      byStatus: { sent: 6, waiting_for_finality: 0, covered: 1 },
      byDirection: { "1>369": 3, "369>1": 4 },
    });
  });

  it("is empty for no messages", () => {
    expect(inFlightView([], ["sent"])).toEqual({ total: 0, byStatus: { sent: 0 }, byDirection: {} });
  });
});

describe("volumeView", () => {
  it("shows the token facts and the transfer count", () => {
    expect(volumeView({ chainId: 1, token: native, total: "900", count: 3 }, index)).toEqual({
      chainId: 1,
      token: tokenView(1, native, index),
      volume: "900",
      transfers: 3,
    });
  });

  it("shows zero for a missing total and a null token for a transfer with no token", () => {
    expect(volumeView({ chainId: 1, token: null, total: null, count: 0 }, index)).toEqual({ chainId: 1, token: null, volume: "0", transfers: 0 });
  });
});

describe("auditItemView", () => {
  const audit = auditToken({ homeChainId: 1, token: native, escrow: 100n, bridgedSupply: 60n, pendingForward: 30n, pendingBackward: 5n });

  it("shows the audit with the bridged copy", () => {
    expect(auditItemView({ audit, homeChainId: 1, copy: { chainId: 369, token: copy } }, index)).toEqual({
      token: tokenView(1, native, index),
      bridgedToken: tokenView(369, copy, index),
      escrow: "100",
      bridgedSupply: "60",
      pendingForward: "30",
      pendingBackward: "5",
      expectedEscrow: "95",
      difference: "5",
      mismatch: true,
    });
  });

  it("shows no bridged token when no copy exists", () => {
    expect(auditItemView({ audit, homeChainId: 1, copy: null }, index).bridgedToken).toBeNull();
  });
});
