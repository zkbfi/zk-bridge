//! The fork schedule that the prover reads from the beacon node at run time.
//!
//! The light-client program and the fork observation program read no fork table. The prover still has to name the fork
//! version that each committee signed under, because that version is an input of each fold step. It also has to name the
//! fork of a header slot, because the fork name decides how a served header is repaired (see
//! [`crate::light_client::repair_finalized_header`]).
//!
//! Two answers of the beacon node give this. `/eth/v1/config/fork_schedule` lists the version and the first epoch of
//! each scheduled fork, but not the name. `/eth/v1/config/spec` lists the name, the version and the epoch of each fork,
//! and it also lists forks that are not scheduled (epoch `2^64 - 1`, with a placeholder version on some nodes). The
//! prover ignores those rows entirely (see `spec_forks`). It joins the two answers by version, and it requires that the epochs agree. If they disagree, it stops. It never
//! falls back to the table that is compiled into `lc-core`: a silent fallback would bring the table back into the
//! decision, and a wrong table would then pass for a right one.
//!
//! A wrong answer from the node can only stop the prover. A wrong version fails the signature check of the native run
//! before any proof starts, and a wrong fork name gives a header that the native run refuses.

use crate::error::{Error, Result};
use lc_core::chain::{ChainSpec, ForkName, FAR_FUTURE_EPOCH};
use serde_json::{json, Map, Value};

/// The path of the fork schedule answer.
pub const FORK_SCHEDULE_PATH: &str = "/eth/v1/config/fork_schedule";
/// The path of the chain specification answer.
pub const CHAIN_SPEC_PATH: &str = "/eth/v1/config/spec";

/// The forks that the prover knows by name, with the prefix of their keys in the chain specification. Phase0 has no
/// prefix: its version is `GENESIS_FORK_VERSION`, and it starts at epoch 0.
const KNOWN_FORKS: [(&str, ForkName); 7] = [
    ("ALTAIR", ForkName::Altair),
    ("BELLATRIX", ForkName::Bellatrix),
    ("CAPELLA", ForkName::Capella),
    ("DENEB", ForkName::Deneb),
    ("ELECTRA", ForkName::Electra),
    ("FULU", ForkName::Fulu),
    ("GLOAS", ForkName::Gloas),
];

/// A fork as the chain specification names it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ActiveFork {
    /// A fork that the prover knows by name.
    Known(ForkName),
    /// A fork that the specification lists and the prover does not know (for example a fork newer than Gloas). The text is
    /// the prefix of its keys, such as `HEZE`.
    Unknown(String),
}

impl ActiveFork {
    /// The fork as text for an error message.
    fn describe(&self) -> String {
        match self {
            Self::Known(name) => format!("{name:?}"),
            Self::Unknown(prefix) => prefix.clone(),
        }
    }
}

/// One scheduled fork: its first epoch, its version and its name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ScheduledFork {
    /// The first epoch of the fork. It is never `u64::MAX`: a fork that is not scheduled is not in the list.
    pub epoch: u64,
    /// The fork version that enters the signing domain.
    pub version: [u8; 4],
    /// The name of the fork.
    pub fork: ActiveFork,
}

/// The scheduled forks of one beacon chain, as the beacon node reports them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForkSchedule {
    /// The scheduled forks, oldest first. The first one starts at epoch 0.
    forks: Vec<ScheduledFork>,
    /// The slots in one epoch of the chain.
    slots_per_epoch: u64,
}

/// A scheduled fork as the chain specification lists it.
struct SpecFork {
    fork: ActiveFork,
    version: [u8; 4],
    epoch: u64,
}

/// A fork as the fork schedule answer lists it.
struct ScheduleRow {
    version: [u8; 4],
    epoch: u64,
}

fn malformed(path: &str, reason: &str) -> Error {
    Error::Malformed(format!("GET {path}: {reason}"))
}

/// Reads a decimal text such as `"353024"`.
fn parse_epoch(value: &Value, path: &str, key: &str) -> Result<u64> {
    value
        .as_str()
        .and_then(|text| text.parse().ok())
        .ok_or_else(|| malformed(path, &format!("{key} is not a decimal number")))
}

/// Reads a four byte version such as `"0x90000076"`.
fn parse_version(value: &Value, path: &str, key: &str) -> Result<[u8; 4]> {
    let text = value
        .as_str()
        .and_then(|text| text.strip_prefix("0x"))
        .ok_or_else(|| malformed(path, &format!("{key} is not a 0x text")))?;
    let bytes = alloy_primitives::hex::decode(text)
        .map_err(|error| malformed(path, &format!("{key}: {error}")))?;
    <[u8; 4]>::try_from(bytes.as_slice())
        .map_err(|_| malformed(path, &format!("{key} is not four bytes")))
}

/// The rows of the fork schedule answer. A row at the far future epoch is dropped: the specification lists unscheduled
/// forks that way, and some nodes list them in the schedule too.
fn schedule_rows(answer: &Value) -> Result<Vec<ScheduleRow>> {
    let entries = answer["data"]
        .as_array()
        .ok_or_else(|| malformed(FORK_SCHEDULE_PATH, "data is not a list"))?;
    let mut rows = Vec::new();
    for entry in entries {
        let epoch = parse_epoch(&entry["epoch"], FORK_SCHEDULE_PATH, "epoch")?;
        if epoch == FAR_FUTURE_EPOCH {
            continue;
        }
        let version = parse_version(
            &entry["current_version"],
            FORK_SCHEDULE_PATH,
            "current_version",
        )?;
        rows.push(ScheduleRow { version, epoch });
    }
    Ok(rows)
}

/// Every SCHEDULED fork that the specification lists: Phase0 from `GENESIS_FORK_VERSION`, then each `<NAME>_FORK_EPOCH`
/// with its `<NAME>_FORK_VERSION`.
///
/// A real node publishes placeholder rows, so the rules are:
///
/// - A row whose epoch is the far future epoch (`2^64 - 1`) is ignored entirely, before any other check. Its version may
///   be a placeholder, may repeat the version of another row, or may be missing. Its name does not matter either.
/// - An epoch key at a real epoch needs its version key. If the version is missing, the answer is malformed, and the
///   error names the epoch key. This holds for a feature key that the prover does not know, such as `EIP7594_FORK_EPOCH`.
/// - A scheduled prefix that the prover does not know becomes [`ActiveFork::Unknown`].
fn spec_forks(answer: &Value) -> Result<Vec<SpecFork>> {
    let data: &Map<String, Value> = answer["data"]
        .as_object()
        .ok_or_else(|| malformed(CHAIN_SPEC_PATH, "data is not an object"))?;
    let genesis = data
        .get("GENESIS_FORK_VERSION")
        .ok_or_else(|| malformed(CHAIN_SPEC_PATH, "GENESIS_FORK_VERSION is missing"))?;
    let mut forks = vec![SpecFork {
        fork: ActiveFork::Known(ForkName::Phase0),
        version: parse_version(genesis, CHAIN_SPEC_PATH, "GENESIS_FORK_VERSION")?,
        epoch: 0,
    }];
    for (key, epoch_value) in data {
        let Some(prefix) = key.strip_suffix("_FORK_EPOCH") else {
            continue;
        };
        let epoch = parse_epoch(epoch_value, CHAIN_SPEC_PATH, key)?;
        if epoch == FAR_FUTURE_EPOCH {
            continue;
        }
        let version_key = format!("{prefix}_FORK_VERSION");
        let version_value = data.get(&version_key).ok_or_else(|| {
            malformed(
                CHAIN_SPEC_PATH,
                &format!("{key} is a real epoch ({epoch}) but {version_key} is missing"),
            )
        })?;
        let fork = KNOWN_FORKS
            .iter()
            .find(|(known_prefix, _)| known_prefix == &prefix)
            .map_or_else(
                || ActiveFork::Unknown(prefix.to_string()),
                |(_, name)| ActiveFork::Known(*name),
            );
        forks.push(SpecFork {
            fork,
            version: parse_version(version_value, CHAIN_SPEC_PATH, &version_key)?,
            epoch,
        });
    }
    Ok(forks)
}

/// Requires that no two scheduled forks of the specification share a version. A shared version is the placeholder trap:
/// a join by version would then name the wrong fork.
fn require_distinct_versions(scheduled: &[&SpecFork], rows: &[ScheduleRow]) -> Result<()> {
    for (index, later) in scheduled.iter().enumerate() {
        let Some(earlier) = scheduled[..index]
            .iter()
            .find(|earlier| earlier.version == later.version)
        else {
            continue;
        };
        let schedule_epoch = rows
            .iter()
            .find(|row| row.version == later.version)
            .map_or(FAR_FUTURE_EPOCH, |row| row.epoch);
        return Err(Error::ForkScheduleMismatch {
            fork: format!(
                "{} and {} (one version)",
                earlier.fork.describe(),
                later.fork.describe()
            ),
            schedule_epoch,
            spec_epoch: later.epoch,
        });
    }
    Ok(())
}

/// Joins one schedule row to the scheduled fork of the specification with the same version, and requires the same epoch.
fn join_row(row: &ScheduleRow, scheduled: &[&SpecFork]) -> Result<ScheduledFork> {
    let Some(fork) = scheduled.iter().find(|fork| fork.version == row.version) else {
        return Err(Error::ForkScheduleMismatch {
            fork: format!(
                "the fork with version 0x{}",
                alloy_primitives::hex::encode(row.version)
            ),
            schedule_epoch: row.epoch,
            spec_epoch: FAR_FUTURE_EPOCH,
        });
    };
    if fork.epoch != row.epoch {
        return Err(Error::ForkScheduleMismatch {
            fork: fork.fork.describe(),
            schedule_epoch: row.epoch,
            spec_epoch: fork.epoch,
        });
    }
    Ok(ScheduledFork {
        epoch: row.epoch,
        version: row.version,
        fork: fork.fork.clone(),
    })
}

impl ForkSchedule {
    /// Builds the schedule from the two answers of the beacon node (the whole JSON bodies, with their `data` key).
    ///
    /// # Errors
    /// `Error::Malformed` for a body of the wrong shape. `Error::ForkScheduleMismatch` when the two answers disagree: a
    /// scheduled fork of one answer is missing from the other, the epochs differ, or two scheduled forks share a version.
    /// A row at the far future epoch is never scheduled, so it takes no part in any of these checks.
    pub fn from_answers(
        fork_schedule: &Value,
        chain_spec: &Value,
        slots_per_epoch: u64,
    ) -> Result<Self> {
        let rows = schedule_rows(fork_schedule)?;
        let all_forks = spec_forks(chain_spec)?;
        let scheduled: Vec<&SpecFork> = all_forks.iter().collect();
        require_distinct_versions(&scheduled, &rows)?;
        let mut forks = rows
            .iter()
            .map(|row| join_row(row, &scheduled))
            .collect::<Result<Vec<_>>>()?;
        if let Some(missing) = scheduled
            .iter()
            .find(|fork| !rows.iter().any(|row| row.version == fork.version))
        {
            return Err(Error::ForkScheduleMismatch {
                fork: missing.fork.describe(),
                schedule_epoch: FAR_FUTURE_EPOCH,
                spec_epoch: missing.epoch,
            });
        }
        forks.sort_by_key(|fork| fork.epoch);
        if forks.first().map(|fork| fork.epoch) != Some(0) {
            return Err(malformed(FORK_SCHEDULE_PATH, "no fork starts at epoch 0"));
        }
        Ok(Self {
            forks,
            slots_per_epoch,
        })
    }

    /// The fork that is active at `epoch`: the newest scheduled fork that starts at or before it. A fork at the far future
    /// epoch is not in the list, so it is never active.
    pub fn fork_at_epoch(&self, epoch: u64) -> &ScheduledFork {
        self.forks
            .iter()
            .rev()
            .find(|fork| fork.epoch <= epoch)
            .unwrap_or(&self.forks[0])
    }

    /// The epoch that contains `slot`.
    pub fn epoch_at_slot(&self, slot: u64) -> u64 {
        slot / self.slots_per_epoch
    }

    /// The version that signed a sync aggregate carried by the block at `signature_slot`. The committee signs the root of
    /// the block before, with the domain of the epoch of `signature_slot - 1` (`compute_domain` in `process_sync_aggregate`
    /// uses the previous slot). The result is saturating at slot 0.
    pub fn signing_version(&self, signature_slot: u64) -> [u8; 4] {
        self.fork_at_epoch(self.epoch_at_slot(signature_slot.saturating_sub(1)))
            .version
    }

    /// The name of the fork that is active at `slot`.
    ///
    /// # Errors
    /// `Error::UnknownActiveFork` when the active fork is one that the prover does not know. The prover then stops. It
    /// does not take the newest known fork instead.
    pub fn fork_at_slot(&self, slot: u64) -> Result<ForkName> {
        let active = self.fork_at_epoch(self.epoch_at_slot(slot));
        match &active.fork {
            ActiveFork::Known(name) => Ok(*name),
            ActiveFork::Unknown(_) => Err(Error::UnknownActiveFork {
                version: active.version,
                epoch: active.epoch,
            }),
        }
    }

    /// The scheduled forks, oldest first.
    pub fn forks(&self) -> &[ScheduledFork] {
        &self.forks
    }
}

/// The two answers that a beacon node would give for a compiled chain specification: the fork schedule and the chain
/// specification. The local beacon network serves them, and the tests of the beacon source use them. The prover never
/// calls this to decide anything.
pub fn answers_from_table(spec: &ChainSpec) -> (Value, Value) {
    let mut previous_version = spec.fork_schedule[0].fork_version;
    let mut schedule = Vec::new();
    let mut specification = Map::new();
    specification.insert(
        "GENESIS_FORK_VERSION".into(),
        json!(version_text(spec.fork_schedule[0].fork_version)),
    );
    for entry in spec.fork_schedule {
        let prefix = KNOWN_FORKS
            .iter()
            .find(|(_, name)| *name == entry.fork_name)
            .map(|(prefix, _)| *prefix);
        if let Some(prefix) = prefix {
            specification.insert(
                format!("{prefix}_FORK_VERSION"),
                json!(version_text(entry.fork_version)),
            );
            specification.insert(
                format!("{prefix}_FORK_EPOCH"),
                json!(entry.epoch.to_string()),
            );
        }
        if entry.epoch == FAR_FUTURE_EPOCH {
            continue;
        }
        schedule.push(json!({
            "previous_version": version_text(previous_version),
            "current_version": version_text(entry.fork_version),
            "epoch": entry.epoch.to_string(),
        }));
        previous_version = entry.fork_version;
    }
    specification.insert("CONFIG_NAME".into(), json!(spec.name));
    (
        json!({ "data": schedule }),
        json!({ "data": Value::Object(specification) }),
    )
}

/// A version as the beacon API writes it.
fn version_text(version: [u8; 4]) -> String {
    format!("0x{}", alloy_primitives::hex::encode(version))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::light_client::{verify_update_natively, ChainKind, UpdateInput};
    use lc_core::chain::{ETHEREUM_MAINNET, PULSECHAIN, SEPOLIA};
    use lc_core::update::FoldStep;
    use lc_testkit::synthetic::{build_gloas_update, UpdateRecipe};
    use std::path::Path;

    const SLOTS_PER_EPOCH: u64 = 32;

    /// The body of a recorded answer: the fixtures wrap it in a `response` key.
    fn recorded(directory: &str, name: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../light-client/tests/fixtures")
            .join(directory)
            .join(name);
        let wrapper: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        wrapper["response"].clone()
    }

    fn sepolia_schedule() -> Value {
        recorded("sepolia", "fork_schedule.json")
    }

    fn sepolia_specification() -> Value {
        recorded("sepolia", "chain_spec.json")
    }

    /// Sets one text in the `data` of an answer.
    fn with_spec_key(mut answer: Value, key: &str, text: &str) -> Value {
        answer["data"][key] = json!(text);
        answer
    }

    /// Adds one row to the schedule answer.
    fn with_row(mut answer: Value, version: &str, epoch: &str) -> Value {
        answer["data"].as_array_mut().unwrap().push(
            json!({ "previous_version": "0x90000076", "current_version": version, "epoch": epoch }),
        );
        answer
    }

    fn sepolia() -> ForkSchedule {
        ForkSchedule::from_answers(
            &sepolia_schedule(),
            &sepolia_specification(),
            SLOTS_PER_EPOCH,
        )
        .unwrap()
    }

    /// Claim: the recorded Sepolia answers join into the eight rows (version, epoch, name) and nothing else. Gloas is
    /// `0x90000076` from epoch 353024. A schedule row whose version the specification gives at another epoch is refused,
    /// whatever the epoch is.
    /// Why it matters: the schedule gives no name and the specification gives the name, so the join decides which version
    /// the prover calls Gloas. A join by epoch alone would accept a swapped version when two answers agree on the epoch.
    #[test]
    fn the_sepolia_schedule_names_every_fork_by_its_version() {
        let expected = [
            (0, [0x90, 0, 0, 0x69], ForkName::Phase0),
            (50, [0x90, 0, 0, 0x70], ForkName::Altair),
            (100, [0x90, 0, 0, 0x71], ForkName::Bellatrix),
            (56_832, [0x90, 0, 0, 0x72], ForkName::Capella),
            (132_608, [0x90, 0, 0, 0x73], ForkName::Deneb),
            (222_464, [0x90, 0, 0, 0x74], ForkName::Electra),
            (272_640, [0x90, 0, 0, 0x75], ForkName::Fulu),
            (353_024, [0x90, 0, 0, 0x76], ForkName::Gloas),
        ];
        let schedule = sepolia();
        let actual: Vec<_> = schedule
            .forks()
            .iter()
            .map(|fork| (fork.epoch, fork.version, fork.fork.clone()))
            .collect();
        let wanted: Vec<_> = expected
            .iter()
            .map(|(epoch, version, name)| (*epoch, *version, ActiveFork::Known(*name)))
            .collect();
        assert_eq!(actual, wanted);
        // Control for the exact join: the schedule says Gloas is 0x90000099 at the epoch where the specification says
        // 0x90000076. The epochs agree, the versions do not, so the join must stop.
        let mut swapped = sepolia_schedule();
        swapped["data"][7]["current_version"] = json!("0x90000099");
        let error = ForkSchedule::from_answers(&swapped, &sepolia_specification(), SLOTS_PER_EPOCH)
            .unwrap_err();
        assert_eq!(
            error,
            Error::ForkScheduleMismatch {
                fork: "the fork with version 0x90000099".into(),
                schedule_epoch: 353_024,
                spec_epoch: FAR_FUTURE_EPOCH,
            }
        );
    }

    /// Claim: the signing version is the version of the epoch of the slot before the signature slot. On Sepolia the slot
    /// 11296768 is the first slot of the Gloas epoch 353024, and its aggregate still signs under Fulu. The slot 11296769
    /// signs under Gloas. Slot 0 saturates to genesis.
    /// Why it matters: `process_sync_aggregate` signs with the domain of `previous_slot`. A prover that used the epoch of
    /// the signature slot would pick a wrong version for the one slot at each fork boundary, and the native run would
    /// refuse a valid update.
    #[test]
    fn the_signing_version_is_the_fork_of_the_slot_before_the_signature_slot() {
        let schedule = sepolia();
        assert_eq!(schedule.signing_version(11_296_768), [0x90, 0, 0, 0x75]);
        assert_eq!(schedule.signing_version(11_296_769), [0x90, 0, 0, 0x76]);
        assert_eq!(schedule.signing_version(0), [0x90, 0, 0, 0x69]);
    }

    /// Claim: a fork at the far future epoch never becomes active. Far-future rows in the schedule are dropped, and the
    /// version at epoch `2^64 - 2` is the newest scheduled fork: Gloas on Sepolia (also with a far-future Heze row added),
    /// Capella on PulseChain, where the specification lists Deneb at the far future epoch with the placeholder
    /// `0xffffffff`.
    /// Why it matters: a prover that took the entry with the largest epoch would sign with the placeholder, and every
    /// update would fail the signature check.
    #[test]
    fn far_future_entries_never_become_active() {
        let with_heze = with_row(sepolia_schedule(), "0x90000077", "18446744073709551615");
        let schedule =
            ForkSchedule::from_answers(&with_heze, &sepolia_specification(), SLOTS_PER_EPOCH)
                .unwrap();
        assert_eq!(
            schedule.fork_at_epoch(u64::MAX - 1).version,
            [0x90, 0, 0, 0x76]
        );
        assert_eq!(schedule.forks().len(), 8);
        let (pulsechain_schedule, pulsechain_specification) = answers_from_table(&PULSECHAIN);
        let pulsechain = ForkSchedule::from_answers(
            &pulsechain_schedule,
            &pulsechain_specification,
            PULSECHAIN.slots_per_epoch,
        )
        .unwrap();
        let active = pulsechain.fork_at_epoch(u64::MAX - 1);
        assert_eq!(active.fork, ActiveFork::Known(ForkName::Capella));
        assert_eq!(active.version, [0, 0, 0x03, 0x6c]);
        assert!(pulsechain
            .forks()
            .iter()
            .all(|fork| fork.version != [0xff; 4]));
    }

    /// Claim: when the schedule puts Gloas at epoch 353025 and the specification says 353024, the prover stops with one
    /// exact error that names the fork and both epochs.
    /// Why it matters: the two answers come from one node and must agree. If they do not, the node is broken or lying, and
    /// the prover must not guess which answer to trust.
    #[test]
    fn a_schedule_that_disagrees_with_the_specification_stops_the_prover() {
        let mut moved = sepolia_schedule();
        moved["data"][7]["epoch"] = json!("353025");
        let error = ForkSchedule::from_answers(&moved, &sepolia_specification(), SLOTS_PER_EPOCH)
            .unwrap_err();
        assert_eq!(
            error,
            Error::ForkScheduleMismatch {
                fork: "Gloas".into(),
                schedule_epoch: 353_025,
                spec_epoch: 353_024,
            }
        );
        // The other direction: the specification lists a scheduled fork that the schedule lacks.
        let mut short = sepolia_schedule();
        short["data"].as_array_mut().unwrap().pop();
        let error = ForkSchedule::from_answers(&short, &sepolia_specification(), SLOTS_PER_EPOCH)
            .unwrap_err();
        assert_eq!(
            error,
            Error::ForkScheduleMismatch {
                fork: "Gloas".into(),
                schedule_epoch: FAR_FUTURE_EPOCH,
                spec_epoch: 353_024,
            }
        );
    }

    /// Claim: a delayed fork follows the node and not the compiled table. When the node moves Gloas to epoch 353030 in both
    /// answers, the version of slot 11296769 (epoch 353024) is Fulu, although the compiled `SEPOLIA` table says Gloas from
    /// epoch 353024. The native run of a Gloas update, signed at epoch 353028 under the Gloas version, then fails with the
    /// signature error, and the control (the schedule of the compiled table) passes.
    /// Why it matters: this is the delay case of T14. A wrong schedule can only stall the prover, because the committee
    /// signs a domain that contains the version, and the native run refuses the wrong version before any proof starts.
    #[test]
    fn a_delayed_fork_follows_the_node_not_the_compiled_table() {
        let mut schedule_answer = sepolia_schedule();
        schedule_answer["data"][7]["epoch"] = json!("353030");
        let specification = with_spec_key(sepolia_specification(), "GLOAS_FORK_EPOCH", "353030");
        let delayed =
            ForkSchedule::from_answers(&schedule_answer, &specification, SLOTS_PER_EPOCH).unwrap();
        assert_eq!(delayed.signing_version(11_296_769), [0x90, 0, 0, 0x75]);
        assert_eq!(delayed.fork_at_slot(11_296_769).unwrap(), ForkName::Fulu);
        assert_eq!(
            SEPOLIA.fork_version_at(353_024),
            [0x90, 0, 0, 0x76],
            "the compiled table says Gloas at this epoch"
        );

        let scenario = build_gloas_update(
            &SEPOLIA,
            UpdateRecipe {
                store_slot: 11_296_770,
                finalized_slot: 11_296_800,
                attested_slot: 11_296_900,
                signature_slot: 11_296_901,
                participants: 400,
                include_next_committee: false,
                store_knows_next_committee: false,
            },
        );
        let input_under = |schedule: &ForkSchedule| UpdateInput {
            chain: ChainKind::Sepolia,
            store: scenario.store.clone(),
            steps: vec![FoldStep {
                fork_version: schedule.signing_version(scenario.update.signature_slot),
                update: scenario.update.clone(),
            }],
        };
        let (table_schedule, table_specification) = answers_from_table(&SEPOLIA);
        let from_table =
            ForkSchedule::from_answers(&table_schedule, &table_specification, SLOTS_PER_EPOCH)
                .unwrap();
        verify_update_natively(&input_under(&from_table)).expect("control: the right version");
        assert_eq!(
            verify_update_natively(&input_under(&delayed)).unwrap_err(),
            Error::VerificationRefused(lc_core::Error::SignatureVerificationFailed.to_string())
        );
    }

    /// Claim: with a Heze fork active from epoch 353100, a slot after that epoch gives `UnknownActiveFork` with the Heze
    /// version and epoch, and a slot before it still works. The signing version stays available, because the version
    /// needs no fork name.
    /// Why it matters: the prover cannot choose an anchor for a fork it does not know (T17). It must stop and not take the
    /// newest known fork, because a wrong anchor gives a header that the program refuses.
    #[test]
    fn an_unknown_active_fork_stops_the_prover() {
        let schedule_answer = with_row(sepolia_schedule(), "0x90000077", "353100");
        let specification = with_spec_key(sepolia_specification(), "HEZE_FORK_EPOCH", "353100");
        let schedule =
            ForkSchedule::from_answers(&schedule_answer, &specification, SLOTS_PER_EPOCH).unwrap();
        let after_heze = 353_100 * SLOTS_PER_EPOCH + 1;
        assert_eq!(
            schedule.fork_at_slot(after_heze).unwrap_err(),
            Error::UnknownActiveFork {
                version: [0x90, 0, 0, 0x77],
                epoch: 353_100
            }
        );
        assert_eq!(schedule.fork_at_slot(11_296_769).unwrap(), ForkName::Gloas);
        assert_eq!(schedule.signing_version(after_heze), [0x90, 0, 0, 0x77]);
    }

    /// Claim: a specification where two scheduled forks share one version gives the mismatch error.
    /// Why it matters: this is the placeholder trap of T16. A join by version would name the wrong fork for a row that
    /// both forks claim.
    #[test]
    fn two_forks_with_one_version_stop_the_prover() {
        let specification =
            with_spec_key(sepolia_specification(), "FULU_FORK_VERSION", "0x90000074");
        let error =
            ForkSchedule::from_answers(&sepolia_schedule(), &specification, SLOTS_PER_EPOCH)
                .unwrap_err();
        assert_eq!(
            error,
            Error::ForkScheduleMismatch {
                fork: "Electra and Fulu (one version)".into(),
                schedule_epoch: 222_464,
                spec_epoch: 272_640,
            }
        );
    }

    /// Claim: the answers that the compiled table gives join back into the same table, for every chain of the crate. The
    /// local beacon network and the tests of the beacon source depend on this.
    /// Why it matters: the helper is test support, but the other tests would pass for a wrong reason if it dropped a fork.
    #[test]
    fn the_answers_from_the_table_join_back_into_the_table() {
        for spec in [&ETHEREUM_MAINNET, &PULSECHAIN, &SEPOLIA] {
            let (schedule_answer, specification) = answers_from_table(spec);
            let schedule =
                ForkSchedule::from_answers(&schedule_answer, &specification, spec.slots_per_epoch)
                    .unwrap();
            for entry in spec
                .fork_schedule
                .iter()
                .filter(|entry| entry.epoch != FAR_FUTURE_EPOCH)
            {
                let active = schedule.fork_at_epoch(entry.epoch);
                assert_eq!(active.version, entry.fork_version, "{}", spec.name);
                assert_eq!(
                    active.fork,
                    ActiveFork::Known(entry.fork_name),
                    "{}",
                    spec.name
                );
            }
        }
    }

    /// Reads a recorded chain specification answer from `tests/fixtures/specs`.
    fn recorded_specification(file: &str) -> Value {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/specs")
            .join(file);
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    /// A fork schedule answer from `(version, epoch)` pairs.
    fn schedule_of(rows: &[(&str, u64)]) -> Value {
        let data: Vec<Value> = rows
            .iter()
            .map(|(version, epoch)| {
                json!({ "previous_version": "0x00000000", "current_version": version, "epoch": epoch.to_string() })
            })
            .collect();
        json!({ "data": data })
    }

    /// The scheduled rows of the real Sepolia file.
    const SEPOLIA_ROWS: [(&str, u64); 8] = [
        ("0x90000069", 0),
        ("0x90000070", 50),
        ("0x90000071", 100),
        ("0x90000072", 56_832),
        ("0x90000073", 132_608),
        ("0x90000074", 222_464),
        ("0x90000075", 272_640),
        ("0x90000076", 353_024),
    ];

    /// The scheduled rows of the real PulseChain testnet file.
    const PULSECHAIN_TESTNET_ROWS: [(&str, u64); 4] = [
        ("0x00000943", 0),
        ("0x00000944", 1),
        ("0x00000945", 2),
        ("0x00000946", 4_200),
    ];

    /// The scheduled rows of the real mainnet files.
    const MAINNET_ROWS: [(&str, u64); 7] = [
        ("0x00000000", 0),
        ("0x01000000", 74_240),
        ("0x02000000", 144_896),
        ("0x03000000", 194_048),
        ("0x04000000", 269_568),
        ("0x05000000", 364_032),
        ("0x06000000", 411_392),
    ];

    fn join(schedule: &Value, specification: &Value) -> Result<ForkSchedule> {
        ForkSchedule::from_answers(schedule, specification, SLOTS_PER_EPOCH)
    }

    /// Claim: the real PulseChain testnet answer parses. Its Deneb row (epoch `2^64 - 1`, version `0xffffffff`) takes no
    /// part, and Capella is active at epoch 5000.
    /// Why it matters: a real node publishes the placeholder row. A prover that stopped on it could not run on that chain.
    #[test]
    fn the_real_pulsechain_testnet_answer_joins() {
        let specification = recorded_specification("pulsechain-testnet-v4.json");
        let schedule = join(&schedule_of(&PULSECHAIN_TESTNET_ROWS), &specification).unwrap();
        assert_eq!(schedule.forks().len(), 4);
        let active = schedule.fork_at_epoch(5_000);
        assert_eq!(active.fork, ActiveFork::Known(ForkName::Capella));
        assert_eq!(active.version, [0, 0, 0x09, 0x46]);
        assert!(schedule
            .forks()
            .iter()
            .all(|fork| fork.version != [0xff; 4]));
    }

    /// Claim: the real Sepolia answer parses, with and without a far-future Heze row in the schedule. Gloas is active at
    /// epoch 353024 and Fulu at epoch 353023.
    /// Why it matters: Heze is listed with a real looking version and a far future epoch. It must not become a fork.
    #[test]
    fn the_real_sepolia_answer_joins() {
        let specification = recorded_specification("sepolia.json");
        let schedule = join(&schedule_of(&SEPOLIA_ROWS), &specification).unwrap();
        assert_eq!(schedule.forks().len(), 8);
        assert_eq!(
            schedule.fork_at_epoch(353_024).fork,
            ActiveFork::Known(ForkName::Gloas)
        );
        assert_eq!(
            schedule.fork_at_epoch(353_023).fork,
            ActiveFork::Known(ForkName::Fulu)
        );
        let mut with_heze = SEPOLIA_ROWS.to_vec();
        with_heze.push(("0x08000000", FAR_FUTURE_EPOCH));
        assert_eq!(
            join(&schedule_of(&with_heze), &specification).unwrap(),
            schedule
        );
    }

    /// Claim: both real mainnet answers parse and give the same schedule, with Fulu active at epoch 411392 and Gloas and
    /// Heze not scheduled.
    /// Why it matters: two clients write different key sets. Both must give the same fork rows.
    #[test]
    fn the_real_mainnet_answers_join() {
        for file in [
            "ethereum-mainnet-lodestar.json",
            "ethereum-mainnet-publicnode.json",
        ] {
            let schedule = join(&schedule_of(&MAINNET_ROWS), &recorded_specification(file))
                .unwrap_or_else(|error| panic!("{file}: {error}"));
            assert_eq!(schedule.forks().len(), 7, "{file}");
            assert_eq!(
                schedule.fork_at_epoch(411_392).fork,
                ActiveFork::Known(ForkName::Fulu),
                "{file}"
            );
            assert_eq!(
                schedule.fork_at_epoch(u64::MAX - 1).fork,
                ActiveFork::Known(ForkName::Fulu),
                "{file}"
            );
        }
    }

    /// A tiny specification: genesis, Altair at epoch 10, plus the `extra` keys.
    fn small_specification(extra: &[(&str, &str)]) -> Value {
        let mut data = json!({
            "GENESIS_FORK_VERSION": "0x00000001",
            "ALTAIR_FORK_VERSION": "0x00000002",
            "ALTAIR_FORK_EPOCH": "10",
        });
        for (key, value) in extra {
            data[*key] = json!(value);
        }
        json!({ "data": data })
    }

    const FAR_FUTURE_TEXT: &str = "18446744073709551615";

    fn small_schedule() -> Value {
        schedule_of(&[("0x00000001", 0), ("0x00000002", 10)])
    }

    /// Claim: a row at the far future epoch is ignored entirely. Its version may repeat the version of a scheduled fork, it
    /// may be the placeholder `0xffffffff`, and it may be no valid version at all.
    /// Why it matters: real nodes publish such rows. The rule must apply before the duplicate check and before the version
    /// is read, or a placeholder would stop the prover.
    #[test]
    fn a_far_future_row_is_ignored_before_every_other_check() {
        for version in ["0x00000002", "0x00000001", "0xffffffff", "not a version"] {
            let specification = small_specification(&[
                ("DENEB_FORK_VERSION", version),
                ("DENEB_FORK_EPOCH", FAR_FUTURE_TEXT),
            ]);
            let schedule = join(&small_schedule(), &specification)
                .unwrap_or_else(|error| panic!("version {version}: {error}"));
            assert_eq!(schedule.forks().len(), 2, "version {version}");
        }
    }

    /// Claim: an epoch key with no version key is ignored when its epoch is the far future epoch, and is an error that
    /// names the key when the epoch is real.
    /// Why it matters: a scheduled fork without a version cannot be joined. A placeholder without a version is harmless.
    #[test]
    fn an_epoch_without_a_version_is_ignored_only_when_far_future() {
        let ignored = small_specification(&[("DENEB_FORK_EPOCH", FAR_FUTURE_TEXT)]);
        assert_eq!(join(&small_schedule(), &ignored).unwrap().forks().len(), 2);
        let broken = small_specification(&[("DENEB_FORK_EPOCH", "20")]);
        let error = join(&small_schedule(), &broken).unwrap_err();
        assert!(
            matches!(&error, Error::Malformed(text)
                if text.contains("DENEB_FORK_EPOCH") && text.contains("DENEB_FORK_VERSION")),
            "{error}"
        );
    }

    /// Claim: two SCHEDULED forks that share a version stay an error, even when a far-future row also shares it.
    /// Why it matters: the far-future rule must not hide a real duplicate between rows that matter.
    #[test]
    fn a_duplicate_version_among_scheduled_rows_stays_an_error() {
        let specification = small_specification(&[
            ("BELLATRIX_FORK_VERSION", "0x00000002"),
            ("BELLATRIX_FORK_EPOCH", "20"),
            ("DENEB_FORK_VERSION", "0x00000002"),
            ("DENEB_FORK_EPOCH", FAR_FUTURE_TEXT),
        ]);
        let error = join(&small_schedule(), &specification).unwrap_err();
        assert_eq!(
            error,
            Error::ForkScheduleMismatch {
                fork: "Altair and Bellatrix (one version)".into(),
                schedule_epoch: 10,
                spec_epoch: 20,
            }
        );
    }

    /// Claim: an unknown extra key is ignored when it is set to the far future epoch, and is an error that names the key
    /// when it is set to a real epoch without a version.
    /// Why it matters: nodes add feature epochs such as `EIP7594_FORK_EPOCH`. A feature that is off must not stop the
    /// prover, and a feature that is on without a version is a fork the prover cannot sign for.
    #[test]
    fn an_unknown_feature_epoch_is_ignored_only_when_far_future() {
        let off = small_specification(&[("EIP7594_FORK_EPOCH", FAR_FUTURE_TEXT)]);
        assert_eq!(join(&small_schedule(), &off).unwrap().forks().len(), 2);
        let on = small_specification(&[("EIP7594_FORK_EPOCH", "30")]);
        let error = join(&small_schedule(), &on).unwrap_err();
        assert!(
            matches!(&error, Error::Malformed(text) if text.contains("EIP7594_FORK_EPOCH")),
            "{error}"
        );
    }

    /// Claim: the join with the fork schedule answer still requires equal epochs for scheduled rows, on a real file.
    /// A schedule that moves Gloas by one epoch, or gives a row for the far-future Heze version, is refused or ignored
    /// as the rules say.
    /// Why it matters: ignoring far-future rows must not weaken the epoch check for the rows that count.
    #[test]
    fn scheduled_rows_still_need_equal_epochs_on_a_real_file() {
        let specification = recorded_specification("sepolia.json");
        let mut moved = SEPOLIA_ROWS.to_vec();
        moved[7] = ("0x90000076", 353_025);
        assert_eq!(
            join(&schedule_of(&moved), &specification).unwrap_err(),
            Error::ForkScheduleMismatch {
                fork: "Gloas".into(),
                schedule_epoch: 353_025,
                spec_epoch: 353_024,
            }
        );
        let mut heze_scheduled = SEPOLIA_ROWS.to_vec();
        heze_scheduled.push(("0x08000000", 400_000));
        assert_eq!(
            join(&schedule_of(&heze_scheduled), &specification).unwrap_err(),
            Error::ForkScheduleMismatch {
                fork: "the fork with version 0x08000000".into(),
                schedule_epoch: 400_000,
                spec_epoch: FAR_FUTURE_EPOCH,
            }
        );
    }
}
