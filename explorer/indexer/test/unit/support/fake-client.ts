import { vi } from "vitest";

/** The arguments of a `readContract` call, as the code under test passes them. */
export type ReadCall = {
  readonly address: string;
  readonly functionName: string;
  readonly args?: readonly unknown[];
};

/**
 * A fake of the Ponder client of a chain. `readContract` answers from a function that the test writes. A function that
 * throws makes the call reject, like a contract that reverts. `getCode` answers with code unless a test makes it answer
 * `undefined`, like an address with no contract yet.
 *
 * @param answer Gives the result for one call.
 */
export const createFakeClient = (answer: (call: ReadCall) => unknown) => ({
  readContract: vi.fn(async (call: ReadCall) => answer(call)),
  getCode: vi.fn(async (_call: { address: string; blockNumber?: bigint }): Promise<string | undefined> => "0x6080"),
  getTransactionReceipt: vi.fn(),
});

/** The fake client type. */
export type FakeClient = ReturnType<typeof createFakeClient>;
