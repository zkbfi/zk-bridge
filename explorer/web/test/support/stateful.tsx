/**
 * The forms and the pair view take their state from the address (the page passes it down and writes every change
 * back). These wrappers hold that state in React instead, so a test can type into a form or change a filter and see
 * the result without a page around it.
 */
import { useState } from "react";
import type { Address } from "viem";
import { ActionDialog, type ActionDialogProps } from "../../src/actions/ActionDialogs";
import { BridgeForm, type BridgeFormProps } from "../../src/actions/BridgeForm";
import { MessageForm, type MessageFormProps } from "../../src/actions/MessageForm";
import { NO_OVERLAY, type BridgeQuery, type MessageQuery, type Overlay, type Route } from "../../src/app/route";
import { PairView } from "../../src/views/pair/PairView";

export const StatefulBridgeForm = ({ initial = {}, ...props }: Omit<BridgeFormProps, "query" | "onQuery"> & { readonly initial?: BridgeQuery }) => {
  const [query, setQuery] = useState<BridgeQuery>(initial);
  return <BridgeForm {...props} query={query} onQuery={setQuery} />;
};

export const StatefulMessageForm = ({ initial = {}, ...props }: Omit<MessageFormProps, "query" | "onQuery"> & { readonly initial?: MessageQuery }) => {
  const [query, setQuery] = useState<MessageQuery>(initial);
  return <MessageForm {...props} query={query} onQuery={setQuery} />;
};

export const StatefulActionDialog = ({ linked = [], ...props }: Omit<ActionDialogProps, "overlay" | "onOverlay" | "linked"> & { readonly linked?: readonly string[] }) => {
  const [overlay, setOverlay] = useState<Overlay>({ ...NO_OVERLAY, dialog: props.dialog });
  return <ActionDialog {...props} overlay={overlay} onOverlay={setOverlay} linked={linked} />;
};

type PairRoute = Extract<Route, { name: "pair" }>;

export const StatefulPairView = ({ pairId, initialToken }: { readonly pairId: string; readonly initialToken: Address | null }) => {
  const [route, setRoute] = useState<PairRoute>({ name: "pair", pairId, token: initialToken });
  return <PairView route={route} onChange={setRoute} />;
};
