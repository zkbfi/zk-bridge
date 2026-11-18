/** Small value checks that the modules of rpc.zkb.fi share. */

/** A 20-byte address: `0x` and 40 hex digits, in any case. */
export const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** A plain object (not null, not an array). */
export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
