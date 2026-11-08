import { FIXTURE_TOKENS } from "@terminal/data/fixtures";
import { choiceOf } from "../../src/bridge/bridge-model";

/**
 * The link query that names the first fixture token (USDC on the first chain). The Bridge screen now opens on the
 * source chain's gas token, which carries no tip; tests of tips and fees name a bridged token the way a link does.
 */
export const USDC_QUERY = `bridge.token=${encodeURIComponent(choiceOf(FIXTURE_TOKENS.find((token) => token.side === "first")!))}`;

/** The same for the first fixture token of the second chain (zUSDC), for links that send from the second chain. */
export const ZUSDC_QUERY = `bridge.token=${encodeURIComponent(choiceOf(FIXTURE_TOKENS.find((token) => token.side === "second")!))}`;

/** The link query with the fixture token of the side it sends from (the second chain's when it says so, else the first's). */
export const tokenQuery = (query: string): string => `${query.includes("dir=second-to-first") ? ZUSDC_QUERY : USDC_QUERY}&${query}`;
