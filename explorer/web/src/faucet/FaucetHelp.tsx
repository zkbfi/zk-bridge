import { FAUCET_DOCS_HREF, FAUCET_SYMBOL, type GasFaucet } from "./faucet-model";

/** Props of {@link FaucetHelp}. */
export type FaucetHelpProps = {
  /** The gas faucet of the source chain when the wallet has none of its coin, else null. */
  readonly gas: GasFaucet | null;
  /** True when tFAU is the selected token and the wallet holds none of it. */
  readonly noTokens: boolean;
  readonly onMint: () => void;
};

/**
 * The help under the amount on a testnet: no coin for gas (checked first, because a mint needs gas too), or no tFAU to send.
 * Each note links the docs page that explains the testnet tokens.
 *
 * @param props What is missing and the mint handler.
 */
export const FaucetHelp = ({ gas, noTokens, onMint }: FaucetHelpProps) => {
  if (gas === null && !noTokens) return null;
  return (
    <p className="zb-help" role="status" data-testid="faucet-help">
      {gas !== null ? (
        <>
          You need {gas.coin} to send ·{" "}
          <a className="zb-link" href={gas.url} target="_blank" rel="noopener noreferrer">
            Get some
          </a>
        </>
      ) : (
        <>
          You have 0 {FAUCET_SYMBOL} ·{" "}
          <button type="button" className="zb-link" onClick={onMint}>
            Mint 1,000
          </button>
        </>
      )}
      {" · "}
      <a className="zb-link" href={FAUCET_DOCS_HREF}>
        How testnet tokens work
      </a>
    </p>
  );
};
