import { loadPairFromEnvironment } from "./pair-from-environment";

/** The pair that this process follows. Loaded once, when the first module imports it. */
export const pair = loadPairFromEnvironment();
