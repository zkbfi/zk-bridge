import { Box, Button, Text } from "@chakra-ui/react";
import { useState } from "react";
import { useSnapshots, useTokens } from "../app/queries";
import { useServices } from "../app/services";
import type { WebStep } from "../tx/bridge-steps";
import { Modal } from "../ui/Modal";
import { Notice } from "../ui/primitives";
import { useWallet } from "../wallet/wallet-port";
import { BridgeForm } from "./BridgeForm";
import { ClaimPanel } from "./ClaimPanel";
import { MessageForm } from "./MessageForm";
import { TransactionDialog } from "./TransactionDialog";

/** The dialogs that hold a form. */
export type FormDialogName = "bridge" | "wrap" | "message" | "claim";

/** Props of {@link ActionDialog}. */
export type ActionDialogProps = {
  readonly dialog: FormDialogName;
  readonly onClose: () => void;
};

const TITLES: Readonly<Record<FormDialogName, string>> = {
  bridge: "Bridge tokens",
  wrap: "Wrap the native coin",
  message: "Send a message",
  claim: "Claim balances",
};

/**
 * A form dialog. After the user presses Review, the confirm dialog takes over. The form stays mounted under it, so
 * Cancel returns to the same values.
 *
 * @param props The dialog and the close handler.
 */
export const ActionDialog = ({ dialog, onClose }: ActionDialogProps) => {
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
    if (snapshots.data === undefined || tokens.data === undefined) return <Text color="fg.muted">Loading your balances and the fee rates…</Text>;
    return <DialogBody dialog={dialog} account={account} snapshots={snapshots.data} tokens={tokens.data} onReview={setReview} />;
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
  readonly account: NonNullable<ReturnType<typeof useWallet>["account"]>;
  readonly snapshots: NonNullable<ReturnType<typeof useSnapshots>["data"]>;
  readonly tokens: NonNullable<ReturnType<typeof useTokens>["data"]>;
  readonly onReview: (steps: readonly WebStep[]) => void;
};

const DialogBody = ({ dialog, account, snapshots, tokens, onReview }: DialogBodyProps) => {
  const { pair } = useServices();
  if (dialog === "message") return <MessageForm pair={pair} onReview={onReview} />;
  if (dialog === "claim") return <ClaimPanel pair={pair} snapshots={snapshots} account={account} onReview={onReview} />;
  return <BridgeForm variant={dialog === "wrap" ? "wrap" : "tokens"} pair={pair} tokens={tokens} context={{ pair, snapshots, signerAddress: account }} account={account} onReview={onReview} />;
};
