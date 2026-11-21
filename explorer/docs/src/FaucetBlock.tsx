/**
 * The faucet block of a docs page: the mint of the testnet faucet token (tFAU) on one chain, drawn from a fenced
 * ```faucet block (see `explorer/web/src/docs/markdown.ts`). It uses the app's own wallet and the confirm dialog that
 * every call of the app goes through, so the mint is decoded from its bytes before the wallet opens. With no wallet
 * connected it still shows the token and its address, and its button connects a wallet.
 */
import { useState } from "react";
import { useServices } from "@web/app/services";
import { FAUCET_DECIMALS, FAUCET_SYMBOL, FAUCET_TOKEN_ADDRESS } from "@web/faucet/faucet-model";
import { useMint } from "@web/faucet/use-mint";
import { useWallet } from "@web/wallet/wallet-port";

/** Props of {@link FaucetBlock}. */
export type FaucetBlockProps = {
  /** The chain to mint on. */
  readonly chainId: number;
};

/** What a failed "add to wallet" says: the wallet's own reason, as one line. */
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0] as string;

/**
 * The mint block of one chain: the token, its address, a Mint button and an add-to-wallet button. It draws nothing for a
 * chain that is not in the pair of the app (the page that holds the block is not shown there either).
 *
 * @param props The chain.
 */
export const FaucetBlock = ({ chainId }: FaucetBlockProps) => {
  const { pair } = useServices();
  const wallet = useWallet();
  const { mint, dialog } = useMint();
  const [note, setNote] = useState<string | null>(null);
  const chain = [pair.first, pair.second].find((candidate) => candidate.chainId === chainId);
  const address = FAUCET_TOKEN_ADDRESS[chainId];
  if (chain === undefined || address === undefined) return null;
  const connected = wallet.status === "connected";
  const elsewhere = connected && wallet.chainId !== chainId;
  const addToWallet = (): void => {
    setNote(`Asking your wallet to list ${FAUCET_SYMBOL} on ${chain.name}…`);
    wallet.watchAsset({ chainId, address, symbol: FAUCET_SYMBOL, decimals: FAUCET_DECIMALS }).then(
      () => setNote(`Your wallet lists ${FAUCET_SYMBOL} on ${chain.name}.`),
      (error: unknown) => setNote(`Your wallet did not list ${FAUCET_SYMBOL}: ${reasonOf(error)}`),
    );
  };
  return (
    <section className="zd-faucet" aria-label={`Mint ${FAUCET_SYMBOL} on ${chain.name}`}>
      <p className="zd-faucet-title">Mint {FAUCET_SYMBOL} on {chain.name}</p>
      <dl className="zd-faucet-facts">
        <div>
          <dt>Token</dt>
          <dd>zkb Faucet Token ({FAUCET_SYMBOL}), {FAUCET_DECIMALS} decimals</dd>
        </div>
        <div>
          <dt>Address</dt>
          <dd>
            <code className="zd-code">{address}</code>
          </dd>
        </div>
        <div>
          <dt>One mint</dt>
          <dd>1,000 {FAUCET_SYMBOL}, sent to {connected ? "your wallet" : "the wallet you connect"}</dd>
        </div>
      </dl>
      <div className="zd-faucet-actions">
        {connected ? (
          <>
            <button type="button" className="zb-pill" onClick={() => mint(chainId)}>
              Mint 1,000 {FAUCET_SYMBOL}
            </button>
            <button type="button" className="zb-pill" onClick={addToWallet}>
              Add {FAUCET_SYMBOL} to wallet
            </button>
          </>
        ) : (
          <button type="button" className="zb-pill" onClick={() => void wallet.connect()}>
            Connect wallet
          </button>
        )}
      </div>
      {elsewhere ? <p className="zd-faucet-note">Your wallet is on another chain. Minting switches it to {chain.name} first.</p> : null}
      {connected ? null : <p className="zd-faucet-note">Connect a wallet to mint. You can also add the token to a wallet by hand with the address above.</p>}
      {note === null ? null : (
        <p className="zd-faucet-note" role="status">
          {note}
        </p>
      )}
      {dialog}
    </section>
  );
};
