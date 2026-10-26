import { vi } from "vitest";

/** The arguments of a `readContract` call, as the code under test passes them. */
export type ReadCall = {
  readonly address: string;
  readonly functionName: string;
  readonly args?: readonly unknown[];
};

/**
 * A fake of the Ponder client of a chain. `readContract` answers from a function that the test writes. A function that
 * throws makes the call reject, like a contract that reverts.
 *
 * @param answer Gives the result for one call.
 */
export const createFakeClient = (answer: (call: ReadCall) => unknown) => ({
  readContract: vi.fn(async (call: ReadCall) => answer(call)),
  getTransactionReceipt: vi.fn(),
});

/** The fake client type. */
export type FakeClient = ReturnType<typeof createFakeClient>;
