//! A read-only client for one chain: blocks, receipts, logs and contract views. It holds no key and sends no transaction.

use crate::error::{Error, Result};
use crate::logging::redact_urls;
use crate::rpc::{parse_quantity, quantity, JsonRpc};
use alloy_primitives::{hex, keccak256, Address, Bytes, B256};
use alloy_sol_types::SolCall;
use serde_json::{json, Value};
use std::str::FromStr;

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

/// A client for one chain.
pub struct ChainClient {
    name: String,
    chain_id: u64,
    rpc: Box<dyn JsonRpc>,
}

fn parse_hash(value: &Value, what: &str) -> Result<B256> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::Malformed(format!("{what}: expected a hash, got {value}")))?;
    B256::from_str(text).map_err(|error| Error::Malformed(format!("{what}: {error}")))
}

fn parse_bytes(value: &Value, what: &str) -> Result<Bytes> {
    let text = value
        .as_str()
        .ok_or_else(|| Error::Malformed(format!("{what}: expected bytes, got {value}")))?;
    hex::decode(text)
        .map(Bytes::from)
        .map_err(|error| Error::Malformed(format!("{what}: {error}")))
}

impl ChainClient {
    /// Connects and checks that the node reports the configured chain identifier.
    ///
    /// # Errors
    /// `Error::Config` when the node serves another chain.
    pub fn connect(name: &str, expected_chain_id: u64, rpc: Box<dyn JsonRpc>) -> Result<Self> {
        let client = Self {
            name: name.to_string(),
            chain_id: expected_chain_id,
            rpc,
        };
        let actual = parse_quantity(&client.rpc.call("eth_chainId", json!([]))?)?;
        if actual != expected_chain_id {
            return Err(Error::Config(format!(
                "chain {name}: the node reports chain id {actual}, the configuration says {expected_chain_id}"
            )));
        }
        Ok(client)
    }

    /// A client that asks this node only for raw headers. It skips the `eth_chainId` check of [`Self::connect`]: every
    /// raw header is checked against the hash that was asked for, so the node is never trusted, and a header endpoint
    /// that is down must not stop a run that another source can serve.
    pub fn header_only(name: &str, chain_id: u64, rpc: Box<dyn JsonRpc>) -> Self {
        Self {
            name: name.to_string(),
            chain_id,
            rpc,
        }
    }

    /// The configured name of the chain.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The chain identifier.
    pub fn chain_id(&self) -> u64 {
        self.chain_id
    }

    /// The JSON of block `number` without transaction bodies, or `None` when the node does not know it.
    pub fn block(&self, number: u64) -> Result<Option<Value>> {
        let block = self
            .rpc
            .call("eth_getBlockByNumber", json!([quantity(number), false]))?;
        Ok((!block.is_null()).then_some(block))
    }

    /// The receipts of block `number`, in transaction order.
    ///
    /// Uses `eth_getBlockReceipts` and falls back to one `eth_getTransactionReceipt` per transaction.
    ///
    /// # Errors
    /// `Error::Malformed` when the block is unknown.
    pub fn block_receipts(&self, number: u64, block: &Value) -> Result<Value> {
        match self
            .rpc
            .call("eth_getBlockReceipts", json!([quantity(number)]))
        {
            Ok(receipts) if receipts.is_array() => return Ok(receipts),
            Ok(_) | Err(Error::Rpc { .. }) => {}
            Err(other) => return Err(other),
        }
        let hashes = block["transactions"]
            .as_array()
            .ok_or_else(|| Error::Malformed("block has no transactions".into()))?;
        let mut receipts = Vec::with_capacity(hashes.len());
        for hash in hashes {
            let receipt = self.rpc.call("eth_getTransactionReceipt", json!([hash]))?;
            if receipt.is_null() {
                return Err(Error::Malformed(format!(
                    "no receipt for transaction {hash}"
                )));
            }
            receipts.push(receipt);
        }
        Ok(Value::Array(receipts))
    }

    /// The raw EIP-2718 bytes of every transaction of a block, in order.
    ///
    /// Asks `eth_getRawTransactionByHash` for each transaction hash of the block, and checks that the keccak256 of the
    /// answer is that hash. A transaction proof needs these bytes: they are the leaves of the transactions trie.
    ///
    /// # Errors
    /// `Error::Malformed` when the block has no transaction list, when the node does not serve a transaction, or when
    /// the bytes do not hash to the transaction hash.
    pub fn block_raw_transactions(&self, block: &Value) -> Result<Vec<Bytes>> {
        let hashes = block["transactions"]
            .as_array()
            .ok_or_else(|| Error::Malformed("block has no transactions".into()))?;
        let mut transactions = Vec::with_capacity(hashes.len());
        for entry in hashes {
            let hash = parse_hash(entry, "transaction hash")?;
            let answer = match self.rpc.call("eth_getRawTransactionByHash", json!([entry])) {
                Ok(answer) if !answer.is_null() => answer,
                Ok(_) | Err(Error::Rpc { .. }) => {
                    return Err(Error::Malformed(format!(
                        "the node of chain {} does not serve the raw bytes of transaction {hash:#x} (eth_getRawTransactionByHash)",
                        self.name
                    )))
                }
                Err(other) => return Err(other),
            };
            let raw = parse_bytes(&answer, "raw transaction")?;
            if keccak256(&raw) != hash {
                return Err(Error::Malformed(format!(
                    "the raw bytes of transaction {hash:#x} hash to {:#x}",
                    keccak256(&raw)
                )));
            }
            transactions.push(raw);
        }
        Ok(transactions)
    }

    /// The receipt of one transaction, or `None` when it is not mined.
    pub fn transaction_receipt(&self, hash: B256) -> Result<Option<Value>> {
        let receipt = self
            .rpc
            .call("eth_getTransactionReceipt", json!([format!("{hash:#x}")]))?;
        Ok((!receipt.is_null()).then_some(receipt))
    }

    /// The execution block that holds a mined transaction: its number and hash from the receipt, and its timestamp from
    /// the block of that hash. The `fork-proof` command starts from it.
    ///
    /// # Errors
    /// `Error::Usage` when the transaction is not mined, `Error::Malformed` when the node does not know the block of the
    /// receipt or answers in another shape.
    pub fn source_block_of_transaction(&self, hash: B256) -> Result<crate::beacon::SourceBlock> {
        let receipt = self.transaction_receipt(hash)?.ok_or_else(|| {
            Error::Usage(format!(
                "the source chain has no receipt for transaction {hash:#x}"
            ))
        })?;
        let block_hash: B256 = receipt["blockHash"]
            .as_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| Error::Malformed("the receipt has no blockHash".into()))?;
        let number = parse_quantity(&receipt["blockNumber"])?;
        let block = self.block_by_hash(block_hash)?.ok_or_else(|| {
            Error::Malformed(format!(
                "the source chain does not know block {block_hash:#x}"
            ))
        })?;
        Ok(crate::beacon::SourceBlock {
            number,
            hash: block_hash,
            timestamp: parse_quantity(&block["timestamp"])?,
        })
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
        let entries = answer
            .as_array()
            .ok_or_else(|| Error::Malformed("eth_getLogs: not an array".into()))?;
        entries.iter().map(RawLog::from_json).collect()
    }

    /// Calls a view function at the latest block.
    ///
    /// # Errors
    /// `Error::Rpc` when the call reverts, `Error::Malformed` when the return data does not decode.
    pub fn view<C: SolCall>(&self, to: Address, call: C) -> Result<C::Return> {
        self.view_at(to, call, None)
    }

    /// Calls a view function at block `block_number`, or at the latest block when it is `None`. A node serves old blocks
    /// only while it keeps their state.
    ///
    /// # Errors
    /// `Error::Rpc` when the call reverts or the node lacks the state, `Error::Malformed` when the return data does not
    /// decode.
    pub fn view_at<C: SolCall>(
        &self,
        to: Address,
        call: C,
        block_number: Option<u64>,
    ) -> Result<C::Return> {
        let request = json!({ "to": format!("{to:#x}"), "data": format!("0x{}", hex::encode(call.abi_encode())) });
        let block = block_number.map_or_else(|| "latest".to_string(), quantity);
        let answer = self.rpc.call("eth_call", json!([request, block]))?;
        let raw = parse_bytes(&answer, "eth_call")?;
        C::abi_decode_returns(&raw)
            .map_err(|error| Error::Malformed(format!("{}: {error}", C::SIGNATURE)))
    }

    /// The JSON of the block with this hash, without transaction bodies, or `None` when the node does not know it.
    pub fn block_by_hash(&self, hash: B256) -> Result<Option<Value>> {
        let block = self
            .rpc
            .call("eth_getBlockByHash", json!([format!("{hash:#x}"), false]))?;
        Ok((!block.is_null()).then_some(block))
    }

    /// The raw RLP of the execution block header with this hash (`debug_getRawHeader`). A Gloas header has fields that the
    /// JSON rebuilder does not know, so the raw bytes are the only exact source. The bytes must hash to `hash`.
    ///
    /// # Errors
    /// `Error::Rpc` when the node lacks the method or the block, `Error::Malformed` for a wrong shape or a wrong hash.
    pub fn raw_header(&self, hash: B256) -> Result<Vec<u8>> {
        let answer = self
            .rpc
            .call("debug_getRawHeader", json!([format!("{hash:#x}")]))?;
        checked_raw_header(&answer, hash)
    }

    /// The `eth_getProof` answer for one account and some storage keys at block `block_number`.
    ///
    /// # Errors
    /// `Error::Rpc` when the node lacks the state of the block.
    pub fn account_proof(
        &self,
        address: Address,
        storage_keys: &[B256],
        block_number: u64,
    ) -> Result<Value> {
        let keys: Vec<String> = storage_keys.iter().map(|key| format!("{key:#x}")).collect();
        self.rpc.call(
            "eth_getProof",
            json!([format!("{address:#x}"), keys, quantity(block_number)]),
        )
    }

    /// The number of the latest block.
    pub fn latest_block_number(&self) -> Result<u64> {
        parse_quantity(&self.rpc.call("eth_blockNumber", json!([]))?)
    }
}

/// The raw header with hash `hash` (`debug_getRawHeader`), from the first of the ordered sources that gives one: the main
/// RPC of the chain, then each header endpoint in order. Every answer is checked against `hash` ([`checked_raw_header`]),
/// so no source is trusted, and a source without the method, a source that fails, or a header with another hash moves on to
/// the next source. Both commands that need a raw header read it here: `opening-proof` for the other chain, `evidence` for
/// a Gloas source block.
///
/// # Errors
/// When no source gives the header: one line per source, in order, that names the source (`<chain>.rpc_url` for the main
/// RPC, the name of the header client such as `source.header_rpc_urls[0]`) with its cause. The lines carry no URL path or
/// query, where a key sits.
pub fn raw_header_from_sources(
    main: &ChainClient,
    header_sources: &[ChainClient],
    hash: B256,
) -> std::result::Result<Vec<u8>, Vec<String>> {
    let mut failures = Vec::new();
    match main.raw_header(hash) {
        Ok(bytes) => return Ok(bytes),
        Err(error) => failures.push(redact_urls(&format!("{}.rpc_url: {error}", main.name()))),
    }
    for source in header_sources {
        match source.raw_header(hash) {
            Ok(bytes) => return Ok(bytes),
            Err(error) => failures.push(redact_urls(&format!("{}: {error}", source.name()))),
        }
    }
    Err(failures)
}

/// The bytes of a `debug_getRawHeader` answer, checked against the hash that was asked for.
///
/// Both paths that read a raw header use this one function, so a header that does not hash to the requested hash gives the
/// same error everywhere: `Error::Malformed`. The error name does not say "beacon", because the node that lied is an
/// execution node.
///
/// # Errors
/// `Error::Malformed` when the answer is not a hex text, or when its keccak256 is not `hash`.
pub fn checked_raw_header(answer: &Value, hash: B256) -> Result<Vec<u8>> {
    let text = answer
        .as_str()
        .ok_or_else(|| Error::Malformed("debug_getRawHeader: the result is not a string".into()))?;
    let bytes = alloy_primitives::hex::decode(text)
        .map_err(|error| Error::Malformed(format!("debug_getRawHeader: {error}")))?;
    if alloy_primitives::keccak256(&bytes) != hash {
        return Err(Error::Malformed(format!(
            "the execution node answered a header that does not hash to {hash:#x}"
        )));
    }
    Ok(bytes)
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

    fn client(
        handler: impl Fn(&str, &Value) -> Result<Value> + Send + Sync + 'static,
    ) -> Result<ChainClient> {
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        ChainClient::connect("test", 369, Box::new(rpc))
    }

    /// Claim: connecting to a node that serves another chain fails.
    /// Why it matters: a misconfigured URL would otherwise read messages from the wrong chain.
    #[test]
    fn connect_refuses_a_wrong_chain_id() {
        let error = client(|_, _| Ok(json!("0x1"))).err().expect("must fail");
        assert!(error.to_string().contains("chain id 1"));
    }

    /// Claim: the source block of a transaction has the number and hash of its receipt and the timestamp of that block. A
    /// transaction that is not mined, a receipt without a block hash and a block the node does not know are refused.
    /// Why it matters: the `fork-proof` command keys its record by this block.
    #[test]
    fn the_source_block_of_a_transaction_comes_from_its_receipt() {
        let hash = format!("{:#x}", B256::repeat_byte(5));
        let answering = move |receipt: Value, block: Value| {
            client(move |method, _| match method {
                "eth_chainId" => Ok(json!("0x171")),
                "eth_getTransactionReceipt" => Ok(receipt.clone()),
                "eth_getBlockByHash" => Ok(block.clone()),
                _ => Ok(Value::Null),
            })
            .unwrap()
        };
        let chain = answering(
            json!({"blockHash": hash, "blockNumber": "0x10"}),
            json!({"timestamp": "0x64"}),
        );
        let block = chain
            .source_block_of_transaction(B256::repeat_byte(1))
            .unwrap();
        assert_eq!(
            (block.number, block.hash, block.timestamp),
            (16, B256::repeat_byte(5), 100)
        );
        let error = |chain: ChainClient| {
            chain
                .source_block_of_transaction(B256::repeat_byte(1))
                .unwrap_err()
                .to_string()
        };
        assert!(error(answering(Value::Null, Value::Null)).contains("no receipt"));
        assert!(
            error(answering(json!({"blockNumber": "0x10"}), Value::Null)).contains("no blockHash")
        );
        assert!(error(answering(
            json!({"blockHash": hash, "blockNumber": "0x10"}),
            Value::Null
        ))
        .contains("does not know block"));
    }

    /// Claim: block receipts fall back to one receipt per transaction when the node lacks `eth_getBlockReceipts`.
    #[test]
    fn receipts_fall_back_to_per_transaction() {
        let chain = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            "eth_getBlockReceipts" => Err(Error::Rpc {
                code: -32601,
                message: "no such method".into(),
                data: None,
            }),
            "eth_getTransactionReceipt" => Ok(json!({"status": "0x1"})),
            _ => Ok(Value::Null),
        })
        .unwrap();
        let receipts = chain
            .block_receipts(5, &json!({"transactions": ["0x01", "0x02"]}))
            .unwrap();
        assert_eq!(receipts.as_array().unwrap().len(), 2);
    }

    /// Claim: the raw transactions of a block come back in order, and bytes that do not hash to the transaction hash are
    /// refused. A node without the method gives an error that names it.
    /// Why it matters: the transaction proof hashes these bytes into the trie. A wrong byte string would build a proof
    /// for another transaction, or a trie whose root differs from the header.
    #[test]
    fn raw_transactions_must_hash_to_their_hashes() {
        let first = [0x02u8, 1, 2, 3];
        let second = [0x02u8, 4, 5, 6];
        let hashes = json!([
            format!("{:#x}", keccak256(first)),
            format!("{:#x}", keccak256(second))
        ]);
        let honest = client(move |method, params| match method {
            "eth_chainId" => Ok(json!("0x171")),
            "eth_getRawTransactionByHash"
                if params[0] == json!(format!("{:#x}", keccak256(first))) =>
            {
                Ok(json!(hex::encode_prefixed(first)))
            }
            "eth_getRawTransactionByHash" => Ok(json!(hex::encode_prefixed(second))),
            _ => Ok(Value::Null),
        })
        .unwrap();
        let block = json!({ "transactions": hashes });
        let raw = honest.block_raw_transactions(&block).unwrap();
        assert_eq!(
            raw,
            vec![Bytes::from(first.to_vec()), Bytes::from(second.to_vec())]
        );

        let swapped = client(move |method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Ok(json!(hex::encode_prefixed(second))),
        })
        .unwrap();
        let error = swapped
            .block_raw_transactions(&block)
            .unwrap_err()
            .to_string();
        assert!(error.contains("hash to"), "{error}");

        let without_method = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Err(Error::Rpc {
                code: -32601,
                message: "no such method".into(),
                data: None,
            }),
        })
        .unwrap();
        let error = without_method
            .block_raw_transactions(&block)
            .unwrap_err()
            .to_string();
        assert!(error.contains("eth_getRawTransactionByHash"), "{error}");
    }

    fn header_source(
        name: &str,
        handler: impl Fn(&str, &Value) -> Result<Value> + Send + Sync + 'static,
    ) -> ChainClient {
        let rpc = ScriptedRpc {
            calls: Mutex::new(vec![]),
            handler: Box::new(handler),
        };
        ChainClient::header_only(name, 369, Box::new(rpc))
    }

    fn missing_method() -> Error {
        Error::Rpc {
            code: -32601,
            message: "the method debug_getRawHeader does not exist/is not available".into(),
            data: None,
        }
    }

    /// Claim: the raw header is read from the main RPC first, then from each header source in order. A source without the
    /// method (-32601) or with a header of another hash moves on to the next one, and the first header that hashes to the
    /// block hash wins.
    /// Why it matters: a public RPC often lacks `debug_getRawHeader`, and a header source is never trusted.
    #[test]
    fn the_raw_header_comes_from_the_first_source_with_the_right_hash() {
        let header = vec![0xc3u8, 0x01, 0x02, 0x03];
        let hash = keccak256(&header);
        let main = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Err(missing_method()),
        })
        .unwrap();
        let wrong = header_source("source.header_rpc_urls[0]", |_, _| Ok(json!("0xc0")));
        let answer = hex::encode_prefixed(&header);
        let right = header_source("source.header_rpc_urls[1]", move |method, params| {
            assert_eq!(method, "debug_getRawHeader");
            assert_eq!(params[0], json!(format!("{hash:#x}")));
            Ok(json!(answer.clone()))
        });
        let never = header_source("source.header_rpc_urls[2]", |_, _| {
            panic!("a source after the first right one is never asked")
        });
        let sources = [wrong, right, never];
        assert_eq!(
            raw_header_from_sources(&main, &sources, hash).unwrap(),
            header
        );

        let honest_main = client(move |method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Ok(json!(hex::encode_prefixed([0xc3u8, 0x01, 0x02, 0x03]))),
        })
        .unwrap();
        let unasked = [header_source("source.header_rpc_urls[0]", |_, _| {
            panic!("the main RPC answered")
        })];
        assert_eq!(
            raw_header_from_sources(&honest_main, &unasked, hash).unwrap(),
            header
        );
    }

    /// Claim: when no source gives a header with the block hash, the failures name each source with its cause, in order,
    /// and carry no URL path (where a key sits), even when a node puts its URL in the error.
    /// Why it matters: a header URL can carry a key, and the failures reach logs.
    #[test]
    fn the_failures_name_every_source_and_no_url() {
        let hash = keccak256([0xc0u8]);
        let main = client(|method, _| match method {
            "eth_chainId" => Ok(json!("0x171")),
            _ => Err(missing_method()),
        })
        .unwrap();
        let sources = [
            header_source("source.header_rpc_urls[0]", |_, _| Ok(json!("0xc1"))),
            header_source("source.header_rpc_urls[1]", |_, _| {
                Err(Error::Http(
                    "debug_getRawHeader: https://rpc.example.org/v2/SECRETKEY timed out".into(),
                ))
            }),
        ];
        let failures = raw_header_from_sources(&main, &sources, hash).unwrap_err();
        assert_eq!(failures.len(), 3, "{failures:?}");
        assert!(failures[0].starts_with("test.rpc_url: "), "{failures:?}");
        assert!(failures[0].contains("-32601"), "{failures:?}");
        assert!(failures[1].starts_with("source.header_rpc_urls[0]: "));
        assert!(failures[1].contains("does not hash to"), "{failures:?}");
        assert!(failures[2].starts_with("source.header_rpc_urls[1]: "));
        let joined = failures.join("; ");
        assert!(!joined.contains("SECRETKEY"), "{joined}");
    }
}
