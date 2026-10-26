import { createContext, useContext } from "react";
import type { FormDialogName } from "../actions/ActionDialogs";

/** What a component can ask of the shell about actions. */
export interface ActionsPort {
  /** Opens one of the action dialogs. */
  open(dialog: FormDialogName): void;
}

/** Context of the actions. */
export const ActionsContext = createContext<ActionsPort | null>(null);

/**
 * The actions of the page.
 *
 * @throws When no provider wraps the component.
 */
export const useActions = (): ActionsPort => {
  const actions = useContext(ActionsContext);
  if (actions === null) throw new Error("useActions needs an ActionsContext provider above it.");
  return actions;
};
