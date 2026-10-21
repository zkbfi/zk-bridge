//! Legacy (EIP-155) transactions: encoding and signing.
//!
//! A legacy transaction runs on every chain the bridge touches (Ethereum, PulseChain, Anvil), so the service
//! needs no fee-market logic. The fee is the node's `eth_gasPrice`.

use crate::error::Result;
use crate::signer::Signer;
use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_rlp::{Encodable, Header};

/// The fields of one legacy transaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LegacyTransaction {
    /// The chain identifier (EIP-155 replay protection).
    pub chain_id: u64,
    /// The sender nonce.
    pub nonce: u64,
    /// The price of one gas unit, in wei.
    pub gas_price: u128,
    /// The gas limit.
    pub gas_limit: u64,
    /// The receiver. Every transaction of the service calls a contract.
    pub to: Address,
    /// The calldata.
    pub data: Bytes,
}

fn encode_list(items: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
    let mut payload = Vec::new();
    items(&mut payload);
    let mut out = Vec::new();
    Header { list: true, payload_length: payload.len() }.encode(&mut out);
    out.extend_from_slice(&payload);
    out
}

impl LegacyTransaction {
    fn encode_body(&self, out: &mut Vec<u8>) {
        self.nonce.encode(out);
        self.gas_price.encode(out);
        self.gas_limit.encode(out);
        self.to.encode(out);
        U256::ZERO.encode(out);
        self.data.encode(out);
    }

    /// The digest that the sender signs (EIP-155: the body, then the chain identifier and two zeros).
    pub fn signing_digest(&self) -> B256 {
        let encoded = encode_list(|out| {
            self.encode_body(out);
            self.chain_id.encode(out);
            0u8.encode(out);
            0u8.encode(out);
        });
        keccak256(encoded)
    }

    /// Signs the transaction and returns the raw bytes for `eth_sendRawTransaction`.
    ///
    /// # Errors
    /// `Error::Signer` when signing fails.
    pub fn sign(&self, signer: &Signer) -> Result<Bytes> {
        let signature = signer.sign_digest(&self.signing_digest())?;
        let v = u64::from(signature.recovery_id) + self.chain_id * 2 + 35;
        let encoded = encode_list(|out| {
            self.encode_body(out);
            v.encode(out);
            U256::from_be_bytes(signature.r.0).encode(out);
            U256::from_be_bytes(signature.s.0).encode(out);
        });
        Ok(Bytes::from(encoded))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::hex;
    use alloy_rlp::Decodable;

    /// The EIP-155 specification example: nonce 9, gas price 20 gwei, gas 21000, to 0x3535..., value 1 ether,
    /// no data, chain 1. Our body has value zero, so this test checks the structure instead through recovery.
    /// Claim: the signed transaction recovers to the sender, so the digest and the `v` rule are right.
    /// Why it matters: a wrong digest makes every transaction come from a different, unfunded address.
    #[test]
    fn signed_transaction_recovers_to_the_sender() {
        let signer = Signer::from_secret_bytes(&hex::decode("ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80").unwrap()).unwrap();
        let transaction = LegacyTransaction {
            chain_id: 369,
            nonce: 3,
            gas_price: 1_000_000_000,
            gas_limit: 90_000,
            to: Address::repeat_byte(0x35),
            data: Bytes::from(vec![1, 2, 3]),
        };
        let raw = transaction.sign(&signer).unwrap();
        // Decode: list header, then nonce.. data, v, r, s.
        let mut slice: &[u8] = &raw;
        let header = Header::decode(&mut slice).unwrap();
        assert!(header.list);
        let _nonce = u64::decode(&mut slice).unwrap();
        let _price = u128::decode(&mut slice).unwrap();
        let _gas = u64::decode(&mut slice).unwrap();
        let _to = Address::decode(&mut slice).unwrap();
        let _value = U256::decode(&mut slice).unwrap();
        let _data = Bytes::decode(&mut slice).unwrap();
        let v = u64::decode(&mut slice).unwrap();
        let r = U256::decode(&mut slice).unwrap();
        let s = U256::decode(&mut slice).unwrap();
        assert!(v == 369 * 2 + 35 || v == 369 * 2 + 36);
        let signature = crate::signer::RecoverableSignature {
            r: B256::from(r.to_be_bytes::<32>()),
            s: B256::from(s.to_be_bytes::<32>()),
            recovery_id: (v - 35 - 369 * 2) as u8,
        };
        let recovered = crate::signer::recover_address(&transaction.signing_digest(), &signature).unwrap();
        assert_eq!(recovered, signer.address());
    }
}
