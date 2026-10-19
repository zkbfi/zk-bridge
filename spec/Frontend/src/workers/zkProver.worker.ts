// /workers/zkProver.worker.ts
import { SP1Prover, SP1ProofWithPublicInputs } from '@succinctlabs/sp1-sdk';

// Declare the execution context explicitly as a Dedicated Web Worker thread
const ctx: DedicatedWorkerGlobalScope = self as any;

/**
 * Heavy cryptographic computations are isolated inside this Web Worker.
 * This keeps the main application UI running smoothly at 60 FPS.
 */
ctx.addEventListener('message', async (event: MessageEvent) => {
  const { txHash, rawReceipts, receiptsRoot, receiptIndex, programElfBytes } = event.data;

  try {
    ctx.postMessage({ status: 'PROGRESS', message: 'Initializing browser WASM prover...' });

    // Initialize the official Succinct client-side prover instance
    const prover = new SP1Prover();

    // Setup your circuit input stream
    ctx.postMessage({ status: 'PROGRESS', message: 'Generating zero-knowledge proof...' });
    
    // Execute the core Groth16 zk-SNARK compilation inside the background thread
    const proofResult: SP1ProofWithPublicInputs = await prover.prove({
      elf: programElfBytes, // The compiled binary bytes of your main.rs circuit
      stdin: { txHash, rawReceipts, receiptsRoot, receiptIndex },
      kind: 'groth16' // Generates small, cheap-to-verify on-chain proofs
    });

    // Send the completed cryptographic artifacts back to BridgeInterface.tsx
    ctx.postMessage({ 
      status: 'SUCCESS', 
      proof: proofResult.proof, 
      publicInputsBytes: proofResult.publicInputs 
    });
  } catch (error: any) {
    ctx.postMessage({ 
      status: 'ERROR', 
      error: error?.message || 'Unknown proving execution failure' 
    });
  }
});