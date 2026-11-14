import { Box, Button, Flex, Link, Text } from "@chakra-ui/react";
import { Modal } from "../ui/Modal";

/** A wallet found in the browser, by its EIP-6963 announcement or as the generic browser wallet. */
export type PickableWallet = { readonly id: string; readonly name: string; readonly icon?: string };

/** Where to install a wallet. */
export const INSTALL_LINKS: readonly { readonly name: string; readonly url: string }[] = [
  { name: "MetaMask", url: "https://metamask.io/download/" },
  { name: "Rabby", url: "https://rabby.io/" },
  { name: "Coinbase Wallet", url: "https://www.coinbase.com/wallet/downloads" },
  { name: "Rainbow", url: "https://rainbow.me/download" },
];

/** Props of {@link WalletPicker}. */
export type WalletPickerProps = {
  /** The wallets in the browser. Empty: the dialog lists where to install one. */
  readonly wallets: readonly PickableWallet[];
  /** What went wrong with the last attempt, in words, or null. */
  readonly error: string | null;
  /** True while a wallet is asked to connect. */
  readonly busy: boolean;
  readonly onPick: (id: string) => void;
  readonly onClose: () => void;
};

/**
 * The page's own connect list, for a page without a Reown project id: the wallets in the browser to pick from, or, with
 * none, links to install one. A failed attempt shows its message here and leaves the list open to try again.
 *
 * @param props The wallets, the last error and the handlers.
 */
export const WalletPicker = ({ wallets, error, busy, onPick, onClose }: WalletPickerProps) => (
  <Modal title="Connect a wallet" onClose={onClose} width="26rem">
    {error === null ? null : (
      <Box role="alert" marginBottom="3" padding="3" borderWidth="1px" borderColor="border" borderRadius="0">
        <Text fontSize="sm">{error}</Text>
      </Box>
    )}
    {wallets.length === 0 ? (
      <>
        <Text fontSize="sm" marginBottom="3">
          Install a wallet, then reload this page to connect.
        </Text>
        <Flex direction="column" gap="2" as="ul" listStyleType="none" margin="0" padding="0" aria-label="Wallets to install">
          {INSTALL_LINKS.map((wallet) => (
            <li key={wallet.name}>
              <Link href={wallet.url} target="_blank" rel="noopener noreferrer" display="flex" justifyContent="space-between" alignItems="center" borderWidth="1px" borderColor="border" borderRadius="full" paddingX="4" minHeight="11" fontWeight="medium" textDecoration="none">
                {wallet.name}
                <span aria-hidden="true">↗</span>
              </Link>
            </li>
          ))}
        </Flex>
      </>
    ) : (
      <>
        <Text fontSize="sm" marginBottom="3">
          Pick the wallet to connect.
        </Text>
        <Flex direction="column" gap="2" as="ul" listStyleType="none" margin="0" padding="0" aria-label="Wallets in this browser">
          {wallets.map((wallet) => (
            <li key={wallet.id}>
              <Button type="button" variant="outline" borderRadius="full" width="100%" justifyContent="flex-start" disabled={busy} onClick={() => onPick(wallet.id)}>
                {wallet.icon === undefined ? null : <img src={wallet.icon} alt="" width="20" height="20" />}
                {wallet.name}
              </Button>
            </li>
          ))}
        </Flex>
      </>
    )}
  </Modal>
);
