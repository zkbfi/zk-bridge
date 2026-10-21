//! A client for one chain: reads, logs, receipts, and signed transactions.

use crate::error::{Error, Result};
use crate::rpc::{parse_quantity, quantity, JsonRpc};
use crate::signer::Signer;
use crate::transaction::LegacyTransaction;
use alloy_primitives::{hex, Address, Bytes, B256};
use alloy_sol_types::SolCall;
use serde_json::{json, Value};
use std::str::FromStr;
use std::time::{Duration, Instant};

/// The extra gas on top of an estimate, in percent.
const GAS_MARGIN_PERCENT: u64 = 30;
/// The fixed extra gas on top of the margin.
const GAS_FLOOR_MARGIN: u64 = 20_000;

/// What the beacon sources need from an execution chain.
pub trait ExecutionReader {
    /// The number of the latest block.
    fn latest_block_number(&self) -> Result<u64>;
    /// The hash of block `number`.
    fn block_hash(&self, number: u64) -> Result<B256>;
    /// The number of the block under the `finalized` tag, or `None` when the chain has no such tag.
    fn finalized_tag_block_number(&self) -> Result<Option<u64>>;
}

/// A log as `eth_getLogs` returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RawLog {
    /// The emitting contract.
    pub address: Address,
    /// The topics.
    pub topics: Vec<B256>,
    /// The data.
    pub data: Bytes,
    /// The block number.
    pub block_number: u64,
    /// The block hash.
    pub block_hash: B256,
    /// The transaction hash.
    pub transaction_hash: B256,
    /// The index of the transaction in the block.
    pub transaction_index: u64,
    /// The index of the log in the block (not in the receipt).
    pub block_log_index: u64,
}

impl RawLog {
    /// Parses a log object of `eth_getLogs` or of a receipt.
    ///
    /// # Errors
    /// `Error::Malformed` for a missing or malformed field.
    pub fn from_json(entry: &Value) -> Result<Self> {
        let address = Address::from_str(entry["address"].as_str().unwrap_or_default())
            .map_err(|error| Error::Malformed(format!("log address: {error}")))?;
        let topics = entry["topics"]
            .as_array()
            .ok_or_else(|| Error::Malformed("log topics".into()))?
            .iter()
            .map(|topic| parse_hash(topic, "log topic"))
            .collect::<Result<Vec<_>>>()?;
        Ok(Self {
            address,
            topics,
            data: parse_bytes(&entry["data"], "log data")?,
            block_number: parse_quantity(&entry["blockNumber"])?,
            block_hash: parse_hash(&entry["blockHash"], "log block hash")?,
            transaction_hash: parse_hash(&entry["transactionHash"], "log transaction hash")?,
            transaction_index: parse_quantity(&entry["transactionIndex"])?,
            block_log_index: parse_quantity(&entry["logIndex"])?,
        })
    }
}

/// The outcome of a mined transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MinedTransaction {
    /// Whether the status is success.
    pub success: bool,
    /// The block that holds it.
    pub block_number: u64,
}

/// A client for one chain.
pub struct ChainClient {
    name: String,
    chain_id: u64,
    rpc: Box<dyn JsonRpc>,
    signer: Option<Signer>,
}

fn parse_hash(value: &Value, what: &str) -> Result<B256> {
    let text = value.as_str().ok_or_else(|| Error::Malformed(format!("{what}: expected a hash, got {value}")))?;
    B256::from_str(text).map_err(|error| Error::Malformed(format!("{what}: {error}")))
}

fn parse_bytes(value: &Value, what: &str) -> Result<Bytes> {
    let text = value.as_str().ok_or_else(|| Error::Malformed(format!("{what}: expected bytes, got {value}")))?;
    hex::decode(text).map(Bytes::from).map_err(|error| Error::Malformed(format!("{what}: {error}")))
}

impl ChainClient {
    /// Connects and checks that the node reports the configured chain identifier.
    ///
    /// # Errors
    /// `Error::Config` when the node serves another chain.
    pub fn connect(name: &str, expected_chain_id: u64, rpc: Box<dyn JsonRpc>, signer: Option<Signer>) -> Result<Self> {
        let client = Self { name: name.to_string(), chain_id: expected_chain_id, rpc, signer };
        let actual = parse_quantity(&client.rpc.call("eth_chainId", json!([]))?)?;
        if actual != expected_chain_id {
            return Err(Error::Config(format!(
                "chain {name}: the node reports chain id {actual}, the configuration says {expected_chain_id}"
            )));
        }
        Ok(client)
    }

    /// The configured name of the chain.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The chain identifier.
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// The sender address.
    ///
    /// # Errors
    /// `Error::Signer` when the client has no signer.
    pub fn sender(&self) -> Result<Address> {
        self.signer.as_ref().map(Signer::address).ok_or_else(|| Error::Signer(format!("chain {} has no signer", self.name)))
    }

    /// The JSON of block `number` without transaction bodies, or `None` when the node does not know it.
    pub fn block(&self, number: u64) -> Result<Option<Value>> {
        let block = self.rpc.call("eth_getBlockByNumber", json!([quantity(number), false]))?;
        Ok((!block.is_null()).then_some(block))
    }

    /// The number of the block under the `finalized` tag, or `None` when the node has none.
    ///
    /// # Errors
    /// An RPC error other than "no such tag".
    pub fn finalized_block_number(&self) -> Result<Option<u64>> {
        let block = match self.rpc.call("eth_getBlockByNumber", json!(["finalized", false])) {
            Ok(block) => block,
            Err(Error::Rpc { .. }) => return Ok(None),
            Err(other) => return Err(other),
        };
        if block.is_null() {
            return Ok(None);
        }
        parse_quantity(&block["number"]).map(Some)
    }

    /// The receipts of block `number`, in transaction order.
    ///
    /// Uses `eth_getBlockReceipts` and falls back to one `eth_getTransactionReceipt` per transaction.
    ///
    /// # Errors
    /// `Error::Malformed` when the block is unknown.
    pub fn block_receipts(&self, number: u64, block: &Value) -> Result<Value> {
        match self.rpc.call("eth_getBlockReceipts", json!([quantity(number)])) {
            Ok(receipts) if receipts.is_array() => return Ok(receipts),
            Ok(_) | Err(Error::Rpc { .. }) => {}
            Err(other) => return Err(other),
        }
        let hashes = block["transactions"].as_array().ok_or_else(|| Error::Malformed("block has no transactions".into()))?;
        let mut receipts = Vec::with_capacity(hashes.len());
        for hash in hashes {
            let receipt = self.rpc.call("eth_getTransactionReceipt", json!([hash]))?;
            if receipt.is_null() {
                return Err(Error::Malformed(format!("no receipt for transaction {hash}")));
            }
            receipts.push(receipt);
        }
        Ok(Value::Array(receipts))
    }

    /// The receipt of one transaction, or `None` when it is not mined.
    pub fn transaction_receipt(&self, hash: B256) -> Result<Option<Value>> {
        let receipt = self.rpc.call("eth_getTransactionReceipt", json!([format!("{hash:#x}")]))?;
        Ok((!receipt.is_null()).then_some(receipt))
    }

    /// The logs of one contract with topic 0 `topic`, in the block range `from..=to`.
    pub fn logs(&self, address: Address, topic: B256, from: u64, to: u64) -> Result<Vec<RawLog>> {
        let filter = json!([{
            "address": format!("{address:#x}"),
            "topics": [format!("{topic:#x}")],
            "fromBlock": quantity(from),
            "toBlock": quantity(to),
        }]);
        let answer = self.rpc.call("eth_getLogs", filter)?;
        let entries = answer.as_array().ok_or_else(|| Error::Malformed("eth_getLogs: not an array".into()))?;
        entries.iter().map(RawLog::from_json).collect()
    }

    /// Calls a view function at the latest block.
    ///
    /// # Errors
    /// `Error::Rpc` when the call reverts, `Error::Malformed` when the return data does not decode.
    pub fn view<C: SolCall>(&self, to: Address, call: C) -> Result<C::Return> {
        let raw = self.eth_call(to, &call.abi_encode(), false)?;
        C::abi_decode_returns(&raw).map_err(|error| Error::Malformed(format!("{}: {error}", C::SIGNATURE)))
    }

    /// Runs `eth_call`. With `as_sender` the call comes from the signer address.
    ///
    /// # Errors
    /// `Error::Rpc` with the revert data when the call reverts.
    pub fn eth_call(&self, to: Address, data: &[u8], as_sender: bool) -> Result<Bytes> {
        let mut request = json!({ "to": format!("{to:#x}"), "data": format!("0x{}", hex::encode(data)) });
        if as_sender {
            request["from"] = json!(format!("{:#x}", self.sender()?));
        }
        let answer = self.rpc.call("eth_call", json!([request, "latest"]))?;
        parse_bytes(&answer, "eth_call")
    }

    /// Signs and sends a transaction, and returns its hash. It estimates the gas first, so a call that would
    /// revert fails here with the revert data and sends nothing.
    ///
    /// # Errors
    /// `Error::Rpc` with revert data when the estimate reverts; other node errors as they come.
    pub fn send_transaction(&self, to: Address, data: &[u8]) -> Result<B256> {
        let signer = self.signer.as_ref().ok_or_else(|| Error::Signer(format!("chain {} has no signer", self.name)))?;
        let from = format!("{:#x}", signer.address());
        let data_hex = format!("0x{}", hex::encode(data));
        let estimate = self.rpc.call("eth_estimateGas", json!([{ "from": from, "to": format!("{to:#x}"), "data": data_hex }]))?;
        let gas_limit = parse_quantity(&estimate)? * (100 + GAS_MARGIN_PERCENT) / 100 + GAS_FLOOR_MARGIN;
        let nonce = parse_quantity(&self.rpc.call("eth_getTransactionCount", json!([from, "pending"]))?)?;
        let gas_price = u128::from(parse_quantity(&self.rpc.call("eth_gasPrice", json!([]))?)?);
        let transaction = LegacyTransaction {
            chain_id: self.chain_id,
            nonce,
            gas_price,
            gas_limit,
            to,
            data: Bytes::copy_from_slice(data),
        };
        let raw = transaction.sign(signer)?;
        let answer = self.rpc.call("eth_sendRawTransaction", json!([format!("0x{}", hex::encode(&raw))]))?;
        parse_hash(&answer, "transaction hash")
    }

    /// Reads the status of a transaction once.
    pub fn mined_transaction(&self, hash: B256) -> Result<Option<MinedTransaction>> {
        let Some(receipt) = self.transaction_receipt(hash)? else {
            return Ok(None);
        };
        Ok(Some(MinedTransaction {
            success: parse_quantity(&receipt["status"])? == 1,
            block_number: parse_quantity(&receipt["blockNumber"])?,
        }))
    }

    /// Polls for the receipt until `timeout`. Returns `None` when the transaction is still pending.
    pub fn wait_for_transaction(&self, hash: B256, timeout: Duration) -> Result<Option<MinedTransaction>> {
        let start = Instant::now();
        loop {
            if let Some(mined) = self.mined_transaction(hash)? {
                return Ok(Some(mined));
            }
            if start.elapsed() >= timeout {
                return Ok(None);
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
}

impl ExecutionReader for ChainClient {
    fn latest_block_number(&self) -> Result<u64> {
        parse_quantity(&self.rpc.call("eth_blockNumber", json!([]))?)
    }

    fn finalized_tag_block_number(&self) -> Result<Option<u64>> {
        self.finalized_block_number()
    }

    fn block_hash(&self, number: u64) -> Result<B256> {
        let block = self.block(number)?.ok_or_else(|| Error::Malformed(format!("block {number} is unknown")))?;
        parse_hash(&block["hash"], "block hash")
    }
}

#[cfg(test)]
pub(crate) mod fake {
    //! A scripted JSON-RPC transport for unit tests.

    use super::*;
    use std::sync::Mutex;

    /// A closure that answers one call.
    pub type Handler = Box<dyn Fn(&str, &Value) -> Result<Value> + Send + Sync>;

    /// Answers calls from a closure and records the method names.
    pub struct ScriptedRpc {
        pub calls: Mutex<Vec<String>>,
        pub handler: Handler,
    }

    impl JsonRpc for ScriptedRpc {
        fn call(&self, method: &str, params: Value) -> Result<Value> {
            self.calls.lock().unwrap().push(method.to_string());
            (self.handler)(method, &params)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::ScriptedRpc;
    use super::*;
    use std::sync::Mutex;

    fn client(handler: impl Fn(&str, &Value) -> Result<Value> + Send + Sync + 'static) -> Result<ChainClient> {
        let rpc = ScriptedRpc { calls: Mutex::new(vec![]), handler: Box::new(handler) };
        ChainClient::connect("test", 369, Box::new(rpc), None)
    }

    /// Claim: connecting to a node that serves another chain fails.
    /// Why it matters: a misconfigured URL would otherwise read deposits from the wrong chain.
    #[test]
    fn connect_refuses_a_wrong_chain_id() {
        let error = client(|_, _| Ok(json!("0x1"))).err().expect("must fail");
        assert!(error.to_string().contains("chain id 1"));
    }

    /// Claim: a node without a `finalized` tag gives `None`, not an error and not the latest block.
    /// Why it matters: the service reads only finalized blocks. A fallback to latest would break that rule.
    #[test]
    fn missing_finalized_tag_gives_none() {
        let chain = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Err(Error::Rpc { code: -32602, message: "unknown block".into(), data: None }),
        })
        .unwrap();
        assert_eq!(chain.finalized_block_number().unwrap(), None);
    }

    /// Claim: block receipts fall back to one receipt per transaction when the node lacks `eth_getBlockReceipts`.
    #[test]
    fn receipts_fall_back_to_per_transaction() {
        let chain = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            "eth_getBlockReceipts" => Err(Error::Rpc { code: -32601, message: "no such method".into(), data: None }),
            "eth_getTransactionReceipt" => Ok(json!({"status": "0x1"})),
            _ => Ok(Value::Null),
        })
        .unwrap();
        let receipts = chain.block_receipts(5, &json!({"transactions": ["0x01", "0x02"]})).unwrap();
        assert_eq!(receipts.as_array().unwrap().len(), 2);
    }
}
