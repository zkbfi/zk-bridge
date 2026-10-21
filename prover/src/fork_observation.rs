//! Submits a fork observation to the `ForkRegistry` of a chain (finding HB-02, the registry path).
//!
//! A sync committee of the observed chain signs under the real fork version of that chain. A proof of the fork
//! observation program shows which version a bound committee signed under. Anyone may send that proof to
//! `ForkRegistry.observe`. After an observation of a version that the deposit gate does not support, the gate
//! refuses every deposit, and anyone may seal it with empty evidence.
//!
//! The path mirrors a light-client update (`route.rs`): the prover backend proves the statement, the calldata builder
//! in `contracts.rs` encodes the call, and the destination chain client sends the transaction and waits for it.
//! The registry checks the start fields of the observation against its own light client before it asks the
//! verifier, so a stale or foreign observation reverts here without a mined transaction.

use crate::chain::ChainClient;
use crate::contracts::observe_calldata;
use crate::error::Result;
use crate::light_client::decode_fork_observation;
use crate::prover::{ProofStatement, Prover};
use alloy_primitives::{Address, B256};
use std::time::Duration;

/// What a submitted observation recorded.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SubmittedObservation {
    /// The transaction that called `observe`.
    pub transaction: B256,
    /// The fork version that the committee signed under.
    pub version: [u8; 4],
    /// The attested slot that the signature covers.
    pub attested_slot: u64,
}

/// Proves a fork observation and sends it to the registry.
///
/// `observation_program_vkey` is the key of the fork observation program, never the key of the light client program:
/// the registry refuses to be built with equal keys, so a proof of one program cannot pass for the other.
///
/// # Errors
/// `Error::VerificationRefused` when the program rejects the statement. `Error::Malformed` when the public values are
/// not an encoded observation. `Error::Rpc` with the revert data when the registry would revert (the estimate fails and
/// nothing is sent). `Error::Transaction` when the mined transaction reverts. `Error::Http` on a timeout.
pub fn submit_fork_observation(
    destination: &ChainClient,
    registry: Address,
    prover: &dyn Prover,
    observation_program_vkey: B256,
    statement: &ProofStatement,
    receipt_timeout: Duration,
) -> Result<SubmittedObservation> {
    let proof = prover.prove(observation_program_vkey, statement)?;
    let observation = decode_fork_observation(&proof.public_values)?;
    let data = observe_calldata(&proof.proof_bytes, &proof.public_values);
    let transaction =
        destination.send_and_wait(registry, &data, "the fork observation", receipt_timeout)?;
    Ok(SubmittedObservation {
        transaction,
        version: observation.observedVersion.0,
        attested_slot: observation.observedAttestedSlot,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chain::fake::ScriptedRpc;
    use crate::error::Error;
    use crate::signer::Signer;
    use alloy_primitives::hex;
    use serde_json::{json, Value};
    use std::sync::Mutex;

    const ANVIL_SECRET: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    fn oracle() -> Signer {
        Signer::from_secret_bytes(&hex::decode(ANVIL_SECRET).unwrap()).unwrap()
    }

    /// Public values of an observation of `version` at `slot`: seven words, the version left-aligned.
    fn public_values(version: [u8; 4], slot: u64) -> Vec<u8> {
        let mut bytes = vec![0u8; 224];
        bytes[160..164].copy_from_slice(&version);
        bytes[216..224].copy_from_slice(&slot.to_be_bytes());
        bytes
    }

    /// A node that records the calldata of the one transaction it receives, and mines it as a success.
    fn recording_node(sent: std::sync::Arc<Mutex<Vec<String>>>) -> ChainClient {
        let handler = move |method: &str, params: &Value| -> Result<Value> {
            match method {
                "eth_chainId" => Ok(json!("0x171")),
                "eth_estimateGas" => {
                    sent.lock()
                        .unwrap()
                        .push(params[0]["data"].as_str().unwrap().to_string());
                    Ok(json!("0x5208"))
                }
                "eth_getTransactionCount" => Ok(json!("0x0")),
                "eth_gasPrice" => Ok(json!("0x1")),
                "eth_sendRawTransaction" => Ok(json!(format!("{:#x}", B256::repeat_byte(0x11)))),
                "eth_getTransactionReceipt" => Ok(json!({ "status": "0x1", "blockNumber": "0x1" })),
                other => panic!("unexpected {other}"),
            }
        };
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        ChainClient::connect("test", 369, Box::new(rpc), Some(oracle())).unwrap()
    }

    /// Claim: the call data of a submission is `observe(proof, publicValues)` with the exact public values that the
    /// prover committed to, and the report names the version and the slot that those values hold.
    /// Why it matters: the registry hashes the public values for the verifier. A byte that differs between the proof
    /// and the call makes the verifier refuse it, and a wrong report would hide which fork was recorded.
    #[test]
    fn the_submission_carries_the_proven_public_values() {
        let sent = std::sync::Arc::new(Mutex::new(Vec::new()));
        let client = recording_node(sent.clone());
        let values = public_values([0, 0, 3, 0x6d], 10_864_592);
        let statement = ProofStatement::ObservationAsserted(values.clone());
        let prover = crate::prover::OracleProver::new(oracle());
        let submitted = submit_fork_observation(
            &client,
            Address::repeat_byte(0x44),
            &prover,
            B256::repeat_byte(0x22),
            &statement,
            Duration::from_secs(1),
        )
        .unwrap();
        assert_eq!(submitted.version, [0, 0, 3, 0x6d]);
        assert_eq!(submitted.attested_slot, 10_864_592);
        assert_eq!(submitted.transaction, B256::repeat_byte(0x11));
        let data = hex::decode(sent.lock().unwrap()[0].trim_start_matches("0x")).unwrap();
        let call = <crate::contracts::ForkRegistryContract::observeCall as alloy_sol_types::SolCall>::abi_decode(&data).unwrap();
        assert_eq!(call.publicValues.as_ref(), values.as_slice());
        assert_eq!(call.proof.len(), 65, "the oracle signature");
    }

    /// Claim: public values of the wrong size are refused before anything is sent.
    /// Why it matters: the registry would revert them anyway. Refusing early costs no gas and names the cause.
    #[test]
    fn malformed_public_values_send_nothing() {
        let sent = std::sync::Arc::new(Mutex::new(Vec::new()));
        let client = recording_node(sent.clone());
        let statement = ProofStatement::ObservationAsserted(vec![1, 2, 3]);
        let prover = crate::prover::OracleProver::new(oracle());
        let error = submit_fork_observation(
            &client,
            Address::repeat_byte(0x44),
            &prover,
            B256::repeat_byte(0x22),
            &statement,
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(matches!(error, Error::Malformed(_)), "{error}");
        assert!(sent.lock().unwrap().is_empty());
    }

    /// Claim: garbage guest input gives no proof and sends nothing.
    /// Why it matters: the oracle models a sound proof system. It signs only what the program accepts.
    #[test]
    fn a_rejected_guest_input_gives_no_proof() {
        let sent = std::sync::Arc::new(Mutex::new(Vec::new()));
        let client = recording_node(sent.clone());
        let statement = ProofStatement::Observation(vec![0xff; 16]);
        let prover = crate::prover::OracleProver::new(oracle());
        let error = submit_fork_observation(
            &client,
            Address::repeat_byte(0x44),
            &prover,
            B256::repeat_byte(0x22),
            &statement,
            Duration::from_secs(1),
        )
        .unwrap_err();
        assert!(matches!(error, Error::VerificationRefused(_)), "{error}");
        assert!(sent.lock().unwrap().is_empty());
    }
}
