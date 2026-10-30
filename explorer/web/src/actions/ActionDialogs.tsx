import { Box, Button, Text } from "@chakra-ui/react";
import { useState } from "react";
import { useSnapshots, useTokens } from "../app/queries";
import type { Overlay } from "../app/route";
import { useServices } from "../app/services";
import type { WebStep } from "../tx/bridge-steps";
import { Modal } from "../ui/Modal";
import { Notice } from "../ui/primitives";
import { useWallet } from "../wallet/wallet-port";
import { BridgeForm } from "./BridgeForm";
import { MessageForm } from "./MessageForm";
import { TransactionDialog } from "./TransactionDialog";

/** The dialogs that hold a form. */
export type FormDialogName = "bridge" | "wrap" | "message";

/** Props of {@link ActionDialog}. */
export type ActionDialogProps = {
  readonly dialog: FormDialogName;
  /** The dialog and its form as the address holds them. */
  readonly overlay: Overlay;
  /** Called with the form after every edit. The page writes it to the address in place. */
  readonly onOverlay: (next: Overlay) => void;
  /** The fields that a link filled in and that could send funds elsewhere, so the form asks the user to check them. */
  readonly linked: readonly string[];
  readonly onClose: () => void;
};

const TITLES: Readonly<Record<FormDialogName, string>> = {
  bridge: "Bridge tokens",
  wrap: "Wrap the native coin",
  message: "Send a message",
};

/**
 * A form dialog. After the user presses Review, the confirm dialog takes over. The form stays mounted under it, so
 * Cancel returns to the same values.
 *
 * @param props The dialog and the close handler.
 */
export const ActionDialog = ({ dialog, overlay, onOverlay, linked, onClose }: ActionDialogProps) => {
  const wallet = useWallet();
  const { pair } = useServices();
  const [review, setReview] = useState<readonly WebStep[] | null>(null);
  const tokens = useTokens(pair.id);
  const snapshots = useSnapshots(wallet.account, pair.id);
  const account = wallet.status === "connected" ? wallet.account : null;

  const renderBody = () => {
    if (account === null) {
      return (
        <Box>
          <Notice tone="info">Connect a wallet first. The page needs your account to read your balances.</Notice>
          <Button marginTop="3" colorPalette="blue" disabled={!wallet.walletAvailable} onClick={() => void wallet.connect()}>
            Connect wallet
          </Button>
        </Box>
      );
    }
    if (snapshots.data === undefined || tokens.data === undefined) return <Text color="fg.muted">Loading your balances…</Text>;
    return (
      <>
        {linked.length === 0 ? null : (
          <Notice tone="warning">
            The link you opened filled in: {linked.join(", ")}. Check them before you review. Nothing is sent until you confirm in your wallet.
          </Notice>
        )}
        <DialogBody dialog={dialog} overlay={overlay} onOverlay={onOverlay} account={account} snapshots={snapshots.data} tokens={tokens.data} onReview={setReview} />
      </>
    );
  };

  return (
    <>
      <div aria-hidden={review !== null} inert={review !== null}>
        <Modal title={TITLES[dialog]} onClose={onClose} width="44rem">
          {renderBody()}
        </Modal>
      </div>
      {review === null ? null : <TransactionDialog steps={review} onClose={() => setReview(null)} />}
    </>
  );
};

type DialogBodyProps = {
  readonly dialog: FormDialogName;
  readonly overlay: Overlay;
  readonly onOverlay: (next: Overlay) => void;
  readonly account: NonNullable<ReturnType<typeof useWallet>["account"]>;
  readonly snapshots: NonNullable<ReturnType<typeof useSnapshots>["data"]>;
  readonly tokens: NonNullable<ReturnType<typeof useTokens>["data"]>;
  readonly onReview: (steps: readonly WebStep[]) => void;
};

const DialogBody = ({ dialog, overlay, onOverlay, account, snapshots, tokens, onReview }: DialogBodyProps) => {
  const { pair } = useServices();
  if (dialog === "message") return <MessageForm pair={pair} query={overlay.message} onQuery={(message) => onOverlay({ ...overlay, message })} onReview={onReview} />;
  return (
    <BridgeForm
      variant={dialog === "wrap" ? "wrap" : "tokens"}
      pair={pair}
      tokens={tokens}
      context={{ pair, snapshots, signerAddress: account }}
      account={account}
      query={overlay.bridge}
      onQuery={(bridge) => onOverlay({ ...overlay, bridge })}
      onReview={onReview}
    />
  );
};
