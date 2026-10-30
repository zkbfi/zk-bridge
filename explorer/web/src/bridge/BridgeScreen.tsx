import type { Route } from "../app/route";

/** Props of {@link BridgeScreen}. */
export type BridgeScreenProps = {
  readonly route: Extract<Route, { name: "bridge" }>;
  /** Writes a changed route (direction, form fields) to the address in place. */
  readonly onRoute: (next: Route) => void;
  readonly fixture: boolean;
};

/** The bridge screen. Built out in the following tasks. */
export const BridgeScreen = ({ fixture }: BridgeScreenProps) => <main>{fixture ? "Sample data." : null}</main>;
