//! The real implementation of [`RoutePorts`]: two chains, a beacon source and a prover.

#[cfg(feature = "dev-source")]
use crate::beacon::dev::{DevBeaconSource, DEFAULT_SLOT_OFFSET};
use crate::beacon::http::HttpBeaconSource;
use crate::beacon::{BeaconSource, DepositBlock, LightClientState, UpdatePlan};
use crate::chain::{ChainClient, ExecutionReader, RawLog};
use crate::config::{BeaconKind, ChainConfig, Config, ProverBackend, RouteName};
use crate::contracts::{
    head_updated_topic, is_already_claimed, update_calldata, BlockHashEvidence, BlockRootsEvidence,
    FlowLimiterContract, HistoricalSummariesEvidence, LightClientContract, VaultContract,
};
use crate::error::{Error, Result};
use crate::light_client::{
    ancestry_path, assemble_withdrawal_proof, build_execution_evidence, decode_deposit,
    to_layout_header, verify_withdrawal_natively, withdrawal_calldata, AncestryPath, VaultContext,
    DEPOSIT_EVENT_TOPIC,
};
use crate::prover::{OracleProver, Prover};
use crate::rpc::{parse_quantity, HttpClient, HttpRpc};
use crate::service::{Coverage, Route, RoutePorts, SendOutcome};
use crate::signer::Signer;
use crate::store::NewDeposit;
use alloy_primitives::{Address, Bytes, B256, U256};
use alloy_sol_types::SolCall;
use std::sync::Mutex;
use std::time::Duration;

/// The most light-client proofs (each a fold of one or more updates) that one call of `advance_light_client` sends.
const MAX_PROOFS_PER_CALL: usize = 8;

/// One direction over two real chains.
///
/// The source chain client sends transactions only when `own_light_client` is set: it then updates that light client.
pub struct LiveRoute {
    source: ChainClient,
    destination: ChainClient,
    source_vault: Address,
    destination_vault: Address,
    light_client: Address,
    own_light_client: Option<Address>,
    beacon: Box<dyn BeaconSource>,
    prover: Box<dyn Prover>,
    program_vkey: B256,
    receipt_timeout: Duration,
    log_block_range: u64,
    destination_start_block: u64,
    route_name: String,
    head_slots: Mutex<(Option<u64>, Vec<u64>)>,
}

/// Everything that builds a [`LiveRoute`].
pub struct LiveRouteParts {
    /// The route name.
    pub route_name: String,
    /// The client of the source chain. It needs the signer when `own_light_client` is set.
    pub source: ChainClient,
    /// The client of the destination chain (it holds the signer).
    pub destination: ChainClient,
    /// The vault on the source chain.
    pub source_vault: Address,
    /// The vault on the destination chain.
    pub destination_vault: Address,
    /// The light client on the destination chain.
    pub light_client: Address,
    /// The light client of the source chain's own beacon chain, on the source chain, when one is configured.
    pub own_light_client: Option<Address>,
    /// The beacon source of the source chain.
    pub beacon: Box<dyn BeaconSource>,
    /// The proving backend.
    pub prover: Box<dyn Prover>,
    /// The configured light-client program key.
    pub program_vkey: B256,
    /// How long to wait for a receipt.
    pub receipt_timeout: Duration,
    /// The largest block range of one log call.
    pub log_block_range: u64,
    /// The block of the destination deployment, where the head event scan starts.
    pub destination_start_block: u64,
}

impl LiveRoute {
    /// Builds the route and checks that the contracts point at each other (a name is a hypothesis, so the
    /// service reads each relationship from the contracts and compares).
    ///
    /// # Errors
    /// `Error::Config` when a contract does not match the configuration.
    pub fn connect(parts: LiveRouteParts) -> Result<Self> {
        let route = Self {
            source: parts.source,
            destination: parts.destination,
            source_vault: parts.source_vault,
            destination_vault: parts.destination_vault,
            light_client: parts.light_client,
            own_light_client: parts.own_light_client,
            beacon: parts.beacon,
            prover: parts.prover,
            program_vkey: parts.program_vkey,
            receipt_timeout: parts.receipt_timeout,
            log_block_range: parts.log_block_range,
            destination_start_block: parts.destination_start_block,
            route_name: parts.route_name,
            head_slots: Mutex::new((None, Vec::new())),
        };
        route.check_wiring()?;
        Ok(route)
    }

    fn check_wiring(&self) -> Result<()> {
        let vault = self.destination_vault;
        let name = &self.route_name;
        let mismatch = |what: &str, expected: String, actual: String| {
            Error::Config(format!(
                "route {name}: {what} is {actual}, the configuration says {expected}"
            ))
        };
        let remote_vault = self
            .destination
            .view(vault, VaultContract::remoteVaultCall {})?;
        if remote_vault != self.source_vault {
            return Err(mismatch(
                "destination vault remoteVault",
                self.source_vault.to_string(),
                remote_vault.to_string(),
            ));
        }
        let remote_chain = self
            .destination
            .view(vault, VaultContract::remoteChainIdCall {})?;
        if remote_chain != self.source.chain_id() {
            return Err(mismatch(
                "destination vault remoteChainId",
                self.source.chain_id().to_string(),
                remote_chain.to_string(),
            ));
        }
        let local_chain = self
            .destination
            .view(vault, VaultContract::localChainIdCall {})?;
        if local_chain != self.destination.chain_id() {
            return Err(mismatch(
                "destination vault localChainId",
                self.destination.chain_id().to_string(),
                local_chain.to_string(),
            ));
        }
        let light_client = self
            .destination
            .view(vault, VaultContract::lightClientCall {})?;
        if light_client != self.light_client {
            return Err(mismatch(
                "destination vault lightClient",
                self.light_client.to_string(),
                light_client.to_string(),
            ));
        }
        let program_key = self
            .destination
            .view(self.light_client, LightClientContract::programVKeyCall {})?;
        if program_key != self.program_vkey {
            return Err(mismatch(
                "light client programVKey",
                format!("{:#x}", self.program_vkey),
                format!("{program_key:#x}"),
            ));
        }
        self.check_own_light_client_wiring(&mismatch)
    }

    /// The own-chain light client must follow the same beacon chain as the destination light client (both track the
    /// source chain) and run the same program. The service reads both facts from the contracts and compares them.
    fn check_own_light_client_wiring(
        &self,
        mismatch: &dyn Fn(&str, String, String) -> Error,
    ) -> Result<()> {
        let Some(own) = self.own_light_client else {
            return Ok(());
        };
        self.source.sender().map_err(|_| {
            Error::Config(format!(
                "route {}: own_light_client is set, but the source chain has no signer",
                self.route_name
            ))
        })?;
        let own_key = self
            .source
            .view(own, LightClientContract::programVKeyCall {})?;
        if own_key != self.program_vkey {
            return Err(mismatch(
                "own light client programVKey",
                format!("{:#x}", self.program_vkey),
                format!("{own_key:#x}"),
            ));
        }
        let own_root = self
            .source
            .view(own, LightClientContract::genesisValidatorsRootCall {})?;
        let tracked_root = self.destination.view(
            self.light_client,
            LightClientContract::genesisValidatorsRootCall {},
        )?;
        if own_root != tracked_root {
            return Err(mismatch(
                "own light client genesisValidatorsRoot (the destination light client tracks the same beacon chain)",
                format!("{tracked_root:#x}"),
                format!("{own_root:#x}"),
            ));
        }
        Ok(())
    }

    fn read_light_client_state(&self) -> Result<LightClientState> {
        read_light_client_state_of(&self.destination, self.light_client)
    }

    /// The slots of every head that the light client stored by an update, from its `HeadUpdated` events.
    fn stored_slots(&self) -> Result<Vec<u64>> {
        let latest = self.destination.latest_block_number()?;
        let mut cache = self.head_slots.lock().expect("lock");
        let mut from = cache
            .0
            .map_or(self.destination_start_block, |last| last + 1);
        while from <= latest {
            let to = latest.min(from.saturating_add(self.log_block_range - 1));
            for log in self
                .destination
                .logs(self.light_client, head_updated_topic(), from, to)?
            {
                let slot_topic = log
                    .topics
                    .get(1)
                    .ok_or_else(|| Error::Malformed("HeadUpdated without a slot topic".into()))?;
                cache.1.push(u64::from_be_bytes(
                    slot_topic[24..].try_into().expect("8 bytes"),
                ));
            }
            cache.0 = Some(to);
            from = to + 1;
        }
        Ok(cache.1.clone())
    }

    fn deposit_block(&self, number: u64) -> Result<DepositBlock> {
        let block = self
            .source
            .block(number)?
            .ok_or_else(|| Error::Malformed(format!("source block {number} is unknown")))?;
        let hash: B256 = block["hash"]
            .as_str()
            .and_then(|text| text.parse().ok())
            .ok_or_else(|| Error::Malformed("block hash".into()))?;
        Ok(DepositBlock {
            number,
            hash,
            timestamp: parse_quantity(&block["timestamp"])?,
        })
    }

    fn deposit_from_log(&self, log: &RawLog, log_index: u64) -> Result<Option<NewDeposit>> {
        let event = decode_deposit(&log.topics, &log.data)?;
        if event.target_chain_id != self.destination.chain_id() {
            return Ok(None);
        }
        if event.destination_vault != self.destination_vault {
            return Ok(None);
        }
        Ok(Some(NewDeposit {
            route: self.route_name.clone(),
            nonce: event.nonce,
            token: event.token,
            sender: event.sender,
            recipient: event.recipient,
            amount: event.amount,
            block_number: log.block_number,
            block_hash: log.block_hash,
            transaction_hash: log.transaction_hash,
            transaction_index: log.transaction_index,
            log_index,
        }))
    }

    /// Sends a transaction to the destination chain and waits for it. A revert is an error with the revert data.
    fn send_and_wait(&self, to: Address, data: &[u8], what: &str) -> Result<B256> {
        self.destination
            .send_and_wait(to, data, what, self.receipt_timeout)
    }

    /// Proves an update and sends it to `light_client` on `chain`.
    fn submit_update(
        &self,
        chain: &ChainClient,
        light_client: Address,
        statement: &crate::prover::ProofStatement,
    ) -> Result<()> {
        let proof = self.prover.prove(self.program_vkey, statement)?;
        let data = update_calldata(&proof.proof_bytes, &proof.public_values);
        chain.send_and_wait(
            light_client,
            &data,
            "the light client update",
            self.receipt_timeout,
        )?;
        Ok(())
    }

    /// Makes the vault layout rows cover the withdrawal: the `block_roots` row (recent path) or the
    /// `historical_summaries` row (historical path) must cover the anchor slot, and the block hash row must cover the
    /// deposit slot. Anyone may add a row. The chain's stored data validates it.
    fn ensure_layouts(
        &self,
        anchor: &crate::light_client::BeaconHeader,
        deposit_slot: u64,
        stored: &[u64],
    ) -> Result<()> {
        let vault = self.destination_vault;
        let roots_cover = |rows: &[crate::contracts::StateLayoutRow]| {
            rows.iter()
                .any(|row| row.firstSlot <= anchor.slot && anchor.slot <= row.lastSlot)
        };
        let hash_cover = |rows: &[crate::contracts::BodyLayoutRow], slot: u64| {
            rows.iter()
                .any(|row| row.firstSlot <= slot && slot <= row.lastSlot)
        };

        // The vault takes the path from the distance, so the row that it needs depends on the distance too.
        match ancestry_path(anchor.slot, deposit_slot)? {
            AncestryPath::Recent => {
                let rows = self
                    .destination
                    .view(vault, VaultContract::stateLayoutsCall {})?;
                if !roots_cover(&rows) {
                    let evidence = self
                        .beacon
                        .roots_layout_evidence(anchor, stored, &self.source)?
                        .ok_or_else(|| {
                            Error::Beacon(
                                "not enough stored headers yet to validate the block roots layout"
                                    .into(),
                            )
                        })?;
                    let call = VaultContract::addBlockRootsLayoutCall {
                        blockRootsGindex: U256::from(evidence.gindex),
                        evidence: BlockRootsEvidence {
                            laterHeader: to_layout_header(&evidence.later_header),
                            earlierSlotA: evidence.earlier_slot_a,
                            earlierSlotB: evidence.earlier_slot_b,
                            branchA: evidence.branch_a,
                            branchB: evidence.branch_b,
                        },
                    };
                    self.send_and_wait(vault, &call.abi_encode(), "addBlockRootsLayout")?;
                }
            }
            AncestryPath::Historical => {
                let rows = self
                    .destination
                    .view(vault, VaultContract::historicalLayoutsCall {})?;
                if !rows
                    .iter()
                    .any(|row| row.firstSlot <= anchor.slot && anchor.slot <= row.lastSlot)
                {
                    let evidence = self.beacon.historical_layout_evidence(anchor, stored, &self.source)?.ok_or_else(|| {
                        Error::Beacon(
                            "no stored header lies in a completed era more than 8192 slots below the anchor, so the historical summaries layout cannot be validated yet"
                                .into(),
                        )
                    })?;
                    let call = VaultContract::addHistoricalSummariesLayoutCall {
                        historicalSummariesGindex: U256::from(evidence.gindex),
                        evidence: HistoricalSummariesEvidence {
                            anchorHeader: to_layout_header(&evidence.anchor_header),
                            earlierSlot: evidence.earlier_slot,
                            branch: evidence.branch,
                        },
                    };
                    self.send_and_wait(vault, &call.abi_encode(), "addHistoricalSummariesLayout")?;
                }
            }
        }

        for wanted in [deposit_slot, anchor.slot] {
            let rows = self
                .destination
                .view(vault, VaultContract::bodyLayoutsCall {})?;
            if hash_cover(&rows, deposit_slot) {
                break;
            }
            let Some(evidence) = self
                .beacon
                .hash_layout_evidence(wanted, stored, &self.source)?
            else {
                continue;
            };
            let call = VaultContract::addBlockHashLayoutCall {
                blockHashGindex: U256::from(evidence.gindex),
                evidence: BlockHashEvidence {
                    header: to_layout_header(&evidence.header),
                    branch: evidence.branch,
                },
            };
            self.send_and_wait(vault, &call.abi_encode(), "addBlockHashLayout")?;
        }
        let rows = self
            .destination
            .view(vault, VaultContract::bodyLayoutsCall {})?;
        if !hash_cover(&rows, deposit_slot) {
            return Err(Error::Beacon(format!(
                "no validated block hash layout covers slot {deposit_slot} yet"
            )));
        }
        Ok(())
    }
}

/// The wait note for the answer of a simulated `checkWithdrawal`, or `None` when the limiter allowed it.
///
/// # Errors
/// The error itself when it carries no revert data: the node failed, and the limiter gave no answer.
fn limiter_wait_note(limiter: Address, simulation: Result<Bytes>) -> Result<Option<String>> {
    let error = match simulation {
        Ok(_) => return Ok(None),
        Err(error) => error,
    };
    let Some(data) = error.revert_data() else {
        return Err(error);
    };
    Ok(Some(format!(
        "waiting on the flow limiter {limiter:#x}: it refuses the withdrawal now (revert data 0x{}); the deposit stays unclaimed and the service tries again on every pass",
        alloy_primitives::hex::encode(data)
    )))
}

impl LiveRoute {
    /// Names the flow limiter in the error of a refused withdrawal, when the vault has one and the revert carries data.
    /// The vault passes the revert data of the limiter through unchanged, so the prover cannot tell a refusal of the
    /// limiter from another revert. It says that the limiter may have refused, and it keeps the revert data. The nonce
    /// stays unclaimed, so a later attempt can pay it.
    fn explain_refusal(&self, error: Error) -> Error {
        let Some(data) = error.revert_data() else {
            return error;
        };
        let limiter = match self
            .destination
            .view(self.destination_vault, VaultContract::flowLimiterCall {})
        {
            Ok(limiter) if limiter != Address::ZERO => limiter,
            _ => return error,
        };
        Error::Transaction(format!(
            "the destination vault refused the withdrawal, and flow limiter {limiter:#x} is attached, so it may have refused (revert data 0x{}); the deposit stays unclaimed and a later attempt can pay it",
            alloy_primitives::hex::encode(data)
        ))
    }
}

impl RoutePorts for LiveRoute {
    fn finalized_source_block(&self) -> Result<Option<u64>> {
        self.beacon.finalized_execution_block(&self.source)
    }

    fn scan(&self, from: u64, to: u64) -> Result<Vec<NewDeposit>> {
        let mut deposits = Vec::new();
        for log in self
            .source
            .logs(self.source_vault, DEPOSIT_EVENT_TOPIC, from, to)?
        {
            let receipt = self
                .source
                .transaction_receipt(log.transaction_hash)?
                .ok_or_else(|| {
                    Error::Malformed(format!("no receipt for {:#x}", log.transaction_hash))
                })?;
            let position = receipt["logs"]
                .as_array()
                .and_then(|logs| {
                    logs.iter().position(|entry| {
                        parse_quantity(&entry["logIndex"]).ok() == Some(log.block_log_index)
                    })
                })
                .ok_or_else(|| Error::Malformed("the log is not in its receipt".into()))?;
            deposits.extend(self.deposit_from_log(&log, position as u64)?);
        }
        Ok(deposits)
    }

    fn deposit_from_receipt(
        &self,
        transaction: B256,
        log_index: u64,
    ) -> Result<Option<NewDeposit>> {
        let Some(receipt) = self.source.transaction_receipt(transaction)? else {
            return Ok(None);
        };
        let Some(entry) = receipt["logs"]
            .as_array()
            .and_then(|logs| logs.get(log_index as usize))
        else {
            return Ok(None);
        };
        let log = RawLog::from_json(entry)?;
        if log.address != self.source_vault || log.topics.first() != Some(&DEPOSIT_EVENT_TOPIC) {
            return Ok(None);
        }
        let finalized = self.finalized_source_block()?;
        if finalized.is_none_or(|block| log.block_number > block) {
            return Err(Error::Usage(format!(
                "block {} is not final yet; the service reads only final blocks",
                log.block_number
            )));
        }
        self.deposit_from_log(&log, log_index)
    }

    fn claimed(&self, nonce: B256) -> Result<bool> {
        self.destination.view(
            self.destination_vault,
            VaultContract::claimedCall {
                depositNonce: nonce,
            },
        )
    }

    fn advance_light_client(&self, deposit: &NewDeposit) -> Result<Coverage> {
        let block = self.deposit_block(deposit.block_number)?;
        if block.hash != deposit.block_hash {
            return Err(Error::Malformed(format!(
                "block {} changed its hash; the source chain reorganized a final block",
                block.number
            )));
        }
        for _ in 0..MAX_PROOFS_PER_CALL {
            let state = self.read_light_client_state()?;
            let stored = self.stored_slots()?;
            match self
                .beacon
                .next_update(&block, &state, &stored, &self.source)?
            {
                UpdatePlan::Covered => return Ok(Coverage::Covered),
                UpdatePlan::NotYetFinal => return Ok(Coverage::NotYetFinal),
                UpdatePlan::Update(statement) => {
                    self.submit_update(&self.destination, self.light_client, &statement)?
                }
            }
        }
        Err(Error::Beacon(format!(
            "the light client is still behind block {} after {MAX_PROOFS_PER_CALL} proofs",
            block.number
        )))
    }

    fn advance_own_light_client(&self) -> Result<usize> {
        let Some(own) = self.own_light_client else {
            return Ok(0);
        };
        // One fold per pass. The chain keeps finalizing, so a loop that chases the newest final header would not end on
        // a fast chain (on Anvil each update mines a block that moves the finalized block). A fold holds up to 64
        // updates, so a head many periods behind catches up in one proof, or in a few passes when it lags by more than
        // 64 periods.
        let state = read_light_client_state_of(&self.source, own)?;
        match self.beacon.next_head_update(&state, &self.source)? {
            UpdatePlan::Covered | UpdatePlan::NotYetFinal => Ok(0),
            UpdatePlan::Update(statement) => {
                self.submit_update(&self.source, own, &statement)?;
                Ok(1)
            }
        }
    }

    fn build_withdrawal(&self, deposit: &NewDeposit) -> Result<Vec<u8>> {
        let block_json = self.source.block(deposit.block_number)?.ok_or_else(|| {
            Error::Malformed(format!("source block {} is unknown", deposit.block_number))
        })?;
        let receipts = self
            .source
            .block_receipts(deposit.block_number, &block_json)?;
        let execution =
            build_execution_evidence(&block_json, &receipts, deposit.transaction_index)?;
        if execution.block_hash != deposit.block_hash {
            return Err(Error::Malformed(
                "the source block hash differs from the stored deposit block hash".into(),
            ));
        }

        let state = self.read_light_client_state()?;
        let stored = self.stored_slots()?;
        let block = self.deposit_block(deposit.block_number)?;
        let path = self
            .beacon
            .withdrawal_path(&block, &state, &stored, &self.source)?;
        let proof = assemble_withdrawal_proof(
            &path,
            &execution,
            deposit.transaction_index,
            deposit.log_index,
        );

        let stored_anchor_root = self.destination.view(
            self.light_client,
            LightClientContract::headersCall {
                slot: path.anchor_header.slot,
            },
        )?;
        let context = VaultContext {
            remote_vault: self.source_vault,
            local_vault: self.destination_vault,
            local_chain_id: self.destination.chain_id(),
            stored_anchor_root,
        };
        let verified = verify_withdrawal_natively(&proof, &context, self.beacon.chain_kind())?;
        if verified.nonce != deposit.nonce
            || verified.recipient != deposit.recipient
            || verified.amount != deposit.amount
            || verified.token != deposit.token
        {
            return Err(Error::VerificationRefused(
                "the proven deposit differs from the scanned deposit".into(),
            ));
        }
        self.ensure_layouts(&path.anchor_header, path.deposit_header.slot, &stored)?;
        Ok(withdrawal_calldata(&proof))
    }

    fn flow_limiter_refusal(&self, deposit: &NewDeposit) -> Result<Option<String>> {
        let limiter = self
            .destination
            .view(self.destination_vault, VaultContract::flowLimiterCall {})?;
        if limiter == Address::ZERO {
            return Ok(None);
        }
        let local_token = self.destination.view(
            self.destination_vault,
            VaultContract::localTokenOfCall {
                remoteToken: deposit.token,
            },
        )?;
        let check = FlowLimiterContract::checkWithdrawalCall {
            token: local_token,
            recipient: deposit.recipient,
            amount: deposit.amount,
            nonce: deposit.nonce,
        };
        // The limiter may accept calls from its vault only, so the simulation comes from the vault address.
        let simulation =
            self.destination
                .eth_call_from(limiter, self.destination_vault, &check.abi_encode());
        limiter_wait_note(limiter, simulation)
    }

    fn send_withdrawal(&self, calldata: &[u8]) -> Result<SendOutcome> {
        match self
            .destination
            .send_transaction(self.destination_vault, calldata)
        {
            Ok(hash) => Ok(SendOutcome::Sent(hash)),
            Err(error)
                if error
                    .revert_data()
                    .is_some_and(|data| is_already_claimed(data)) =>
            {
                Ok(SendOutcome::AlreadyClaimed)
            }
            Err(error) => Err(self.explain_refusal(error)),
        }
    }

    fn transaction_succeeded(&self, transaction: B256) -> Result<Option<bool>> {
        Ok(self
            .destination
            .wait_for_transaction(transaction, self.receipt_timeout)?
            .map(|mined| mined.success))
    }
}

/// What a light client contract stores, as the service reads it from the chain that holds the contract.
pub fn read_light_client_state_of(
    client: &ChainClient,
    address: Address,
) -> Result<LightClientState> {
    let head_slot = client.view(address, LightClientContract::headCall {})?;
    let slots_per_period = client.view(address, LightClientContract::slotsPerPeriodCall {})?;
    let period = head_slot / slots_per_period;
    Ok(LightClientState {
        head_slot,
        head_root: client.view(
            address,
            LightClientContract::headersCall { slot: head_slot },
        )?,
        head_execution_hash: client.view(
            address,
            LightClientContract::executionBlockHashesCall { slot: head_slot },
        )?,
        genesis_validators_root: client
            .view(address, LightClientContract::genesisValidatorsRootCall {})?,
        slots_per_period,
        head_committee_hash: client
            .view(address, LightClientContract::syncCommitteesCall { period })?,
        next_committee_hash: client.view(
            address,
            LightClientContract::syncCommitteesCall { period: period + 1 },
        )?,
    })
}

fn connect_chain(config: &ChainConfig, signer: Option<Signer>) -> Result<ChainClient> {
    ChainClient::connect(
        &config.name,
        config.chain_id,
        Box::new(HttpRpc::new(&config.rpc_url)),
        signer,
    )
}

fn build_beacon(config: &ChainConfig) -> Result<Box<dyn BeaconSource>> {
    let kind = config.chain_kind()?;
    match config.beacon.kind {
        BeaconKind::Http => {
            let url = config.beacon.url.as_deref().unwrap_or_default();
            Ok(Box::new(HttpBeaconSource::new(kind, Box::new(HttpClient::new(url)))))
        }
        #[cfg(feature = "dev-source")]
        BeaconKind::Dev => Ok(Box::new(DevBeaconSource::new(
            kind,
            config.beacon.finality_depth.unwrap_or(0),
            config.beacon.slot_offset.unwrap_or(DEFAULT_SLOT_OFFSET),
        ))),
        #[cfg(not(feature = "dev-source"))]
        BeaconKind::Dev => Err(Error::Config(
            "beacon.kind = \"dev\" needs a build with the cargo feature `dev-source` (the production build leaves it out)".into(),
        )),
    }
}

fn build_prover(config: &Config, oracle: &Signer) -> Result<Box<dyn Prover>> {
    match config.prover.backend {
        ProverBackend::Oracle => Ok(Box::new(OracleProver::new(oracle.clone()))),
        #[cfg(feature = "sp1")]
        ProverBackend::Sp1 => Ok(Box::new(crate::prover::Sp1Prover {
            elf_path: config.prover.sp1_elf_path.clone().unwrap_or_default(),
        })),
        #[cfg(not(feature = "sp1"))]
        ProverBackend::Sp1 => Err(Error::Config(
            "prover.backend = \"sp1\" needs a build with the cargo feature `sp1` (see the documentation in src/prover.rs)".into(),
        )),
    }
}

/// Builds the routes of a configuration. `signer` sends transactions. `oracle` signs for the oracle backend.
///
/// # Errors
/// Any connection or wiring error.
pub fn build_routes(config: &Config, signer: &Signer, oracle: &Signer) -> Result<Vec<Route>> {
    let mut routes = Vec::new();
    for name in &config.routes {
        routes.push(build_route(config, *name, signer, oracle)?);
    }
    Ok(routes)
}

fn build_route(
    config: &Config,
    name: RouteName,
    signer: &Signer,
    oracle: &Signer,
) -> Result<Route> {
    let source_config = config.source_of(name);
    let destination_config = config.destination_of(name);
    let own_light_client = source_config.own_light_client_address()?;
    // The source client signs only when it must update the own-chain light client.
    let source_signer = own_light_client.map(|_| signer.clone());
    let live = LiveRoute::connect(LiveRouteParts {
        route_name: name.as_str().to_string(),
        source: connect_chain(source_config, source_signer)?,
        destination: connect_chain(destination_config, Some(signer.clone()))?,
        source_vault: source_config.vault_address()?,
        destination_vault: destination_config.vault_address()?,
        light_client: destination_config.light_client_address()?,
        own_light_client,
        beacon: build_beacon(source_config)?,
        prover: build_prover(config, oracle)?,
        program_vkey: config.prover.program_vkey_value()?,
        receipt_timeout: Duration::from_secs(config.receipt_timeout_seconds),
        log_block_range: config.log_block_range,
        destination_start_block: destination_config.start_block,
    })?;
    Ok(Route {
        name: name.as_str().to_string(),
        start_block: source_config.start_block,
        log_block_range: config.log_block_range,
        ports: Box::new(live),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claim: a revert with data is a wait that names the limiter and keeps the data, a pass is no wait, and a failure
    /// without revert data stays an error.
    /// Why it matters: a wait costs no attempt, so mistaking a node failure for a refusal would hide an outage, and
    /// mistaking a refusal for an error would strand the deposit after `max_attempts`.
    #[test]
    fn only_a_revert_with_data_is_a_wait() {
        let limiter = Address::repeat_byte(0x77);
        assert_eq!(limiter_wait_note(limiter, Ok(Bytes::new())).unwrap(), None);

        let refused = Error::Rpc {
            code: 3,
            message: "execution reverted".into(),
            data: Some(Bytes::from(vec![0xde, 0xad])),
        };
        let note = limiter_wait_note(limiter, Err(refused))
            .unwrap()
            .expect("a wait");
        assert!(note.contains("waiting on the flow limiter"), "{note}");
        assert!(note.contains(&format!("{limiter:#x}")), "{note}");
        assert!(note.contains("0xdead"), "{note}");

        let outage = Error::Rpc {
            code: -32000,
            message: "busy".into(),
            data: None,
        };
        assert!(limiter_wait_note(limiter, Err(outage)).is_err());
    }
}
