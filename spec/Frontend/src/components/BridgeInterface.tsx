// SPDX-License-Identifier: MIT
import { useState } from 'react';
import { createWalletClient, custom, parseUnits } from 'viem';
import { mainnet, pulsechain } from 'viem/chains';

// Core Contract ABIs (Minimal representations for interaction)
const VAULT_ABI = [
  "function deposit(address token, address recipient, uint256 amount, uint64 targetChainId) external",
  "function withdraw(bytes calldata proof, bytes calldata publicInputsBytes) external"
] as const;

export default function BridgeInterface() {
  const [amount, setAmount] = useState('');
  const [txHash, setTxHash] = useState('');
  const [isProving, setIsProving] = useState(false);
  const [zkPayload, setZkPayload] = useState<{ proof: string; inputs: string } | null>(null);

  // 1. Lock User Funds on the Source Chain
  const handleDeposit = async () => {
    if (!window.ethereum) return alert("Please install a Web3 wallet");
    
    const walletClient = createWalletClient({
      chain: mainnet, // Hardcoded to Ethereum for source example
      transport: custom(window.ethereum)
    });

    const [account] = await walletClient.getAddresses();
    const ETH_VAULT_ADDRESS = "0xYourEthereumVaultAddressHere";
    const ERC20_TOKEN_ADDRESS = "0xYourTokenAddressHere";
    const PULSECHAIN_ID = 369;

    const hash = await walletClient.writeContract({
      address: ETH_VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'deposit',
      args: [ERC20_TOKEN_ADDRESS, account, parseUnits(amount, 18), BigInt(PULSECHAIN_ID)],
      account
    });

    setTxHash(hash);
    alert(`Deposit TX Submitted: ${hash}`);
  };

  // 2. Fetch MPT Data and Generate the ZK Proof via User Client
  const generateProof = async () => {
    setIsProving(true);
    try {
      // Call your decentralized prover node backend or Aligned Layer/Succinct prover network endpoint
      const response = await fetch('/api/prove-deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ txHash })
      });
      
      const data = await response.json();
      setZkPayload({ proof: data.proof, inputs: data.publicInputsBytes });
      alert("ZK Proof Generated Successfully! Ready to claim funds.");
    } catch (err) {
      console.error("Proving failed", err);
    } finally {
      setIsProving(false);
    }
  };

  // 3. Complete the Move: Claim Funds on PulseChain
  const handleWithdraw = async () => {
    if (!zkPayload || !window.ethereum) return;

    const walletClient = createWalletClient({
      chain: pulsechain, // Switch user context to destination chain
      transport: custom(window.ethereum)
    });

    const [account] = await walletClient.getAddresses();
    const PULSE_VAULT_ADDRESS = "0xYourPulseChainVaultAddressHere";

    const hash = await walletClient.writeContract({
      address: PULSE_VAULT_ADDRESS,
      abi: VAULT_ABI,
      functionName: 'withdraw',
      args: [zkPayload.proof as `0x${string}`, zkPayload.inputs as `0x${string}`],
      account
    });

    alert(`Withdrawal Confirmed on PulseChain! TX: ${hash}`);
    setZkPayload(null);
  };

  return (
    <div style={{ padding: '40px', maxWidth: '400px', margin: '0 auto', fontFamily: 'sans-serif' }}>
      <h2>Immutable ZK Bridge</h2>
      
      <input type="text" placeholder="Amount to bridge" value={amount} onChange={(e) => setAmount(e.target.value)} />
      <button onClick={handleDeposit}>1. Deposit on Ethereum</button>

      {txHash && (
        <div style={{ marginTop: '20px' }}>
          <button onClick={generateProof} disabled={isProving}>
            {isProving ? "Generating ZK Math..." : "2. Generate ZK Proof"}
          </button>
        </div>
      )}

      {zkPayload && (
        <div style={{ marginTop: '20px' }}>
          <button onClick={handleWithdraw}>3. Claim on PulseChain (0% Fee)</button>
        </div>
      )}
    </div>
  );
}