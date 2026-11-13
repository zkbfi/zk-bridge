//! Step timings of one proof run: what the producer logs so that "how long does a proof take" and "would a faster GPU
//! help" have an answer from real data.
//!
//! The producer logs one `prove_step` line per step (`step=... elapsed_ms=...`) and, at the end, one `prove_timing` line
//! that carries all of them (`docs/gpu-prover.md`, "Timing logs"). Nothing here holds a URL, a key or a secret: the
//! fields are numbers, counters and the hardware names that the worker reports.
//!
//! The worker may add a `timings` object to its answer to `POST /prove` ([`WorkerTimings`]). The field is optional on
//! both ends: a worker without it still works, and the producer then logs `worker_timings=none`.

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// The longest hardware name that the producer logs. The name comes from the worker, so a hostile worker cannot flood a
/// log line.
const MAX_NAME_CHARS: usize = 80;

/// A duration in whole milliseconds, saturating.
pub fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// What the worker measured for one proof. In JSON the keys are camelCase, like the rest of the contract.
///
/// The SP1 client proves in one call: the core proof, the compression and the Groth16 wrap run inside it and the client
/// does not report them apart. So `prove_ms` covers all three.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerTimings {
    /// The wait for the GPU: the time this request stood behind another proof of the same worker.
    pub queue_ms: u64,
    /// The native run of the program on the worker, before the proof.
    pub native_ms: u64,
    /// The SP1 Groth16 proof (core, compress and wrap together).
    pub prove_ms: u64,
    /// The worker's own verification of the new proof.
    pub verify_ms: u64,
    /// The whole request on the worker, from the moment it was valid to the answer.
    pub total_ms: u64,
    /// The GPU, for example `NVIDIA L40S`, or `None` when the worker could not tell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
    /// The processor model of the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_model: Option<String>,
    /// The number of logical processors of the host.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_count: Option<u32>,
}

impl WorkerTimings {
    /// Reads the `timings` value of an answer. A value that does not fit gives `None` and never fails the proof: the
    /// timings are for the logs only.
    pub fn from_value(value: &serde_json::Value) -> Option<Self> {
        let mut timings: Self = serde_json::from_value(value.clone()).ok()?;
        timings.gpu = timings.gpu.map(|name| clean_name(&name));
        timings.cpu_model = timings.cpu_model.map(|name| clean_name(&name));
        Some(timings)
    }
}

/// A hardware name without control characters and URLs, at most [`MAX_NAME_CHARS`] long.
fn clean_name(name: &str) -> String {
    let flat: String = name
        .chars()
        .map(|character| {
            if character.is_control() {
                ' '
            } else {
                character
            }
        })
        .take(MAX_NAME_CHARS)
        .collect();
    crate::logging::redact_urls(flat.trim())
}

/// What the worker knows about its host. Detected once.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HostInfo {
    /// The GPU name, when `nvidia-smi` answered.
    pub gpu: Option<String>,
    /// The processor model.
    pub cpu_model: Option<String>,
    /// The number of logical processors.
    pub cpu_count: Option<u32>,
}

impl HostInfo {
    /// Asks the machine: `nvidia-smi` for the GPU, `/proc/cpuinfo` for the processor. Every part may be missing.
    pub fn detect() -> Self {
        let gpu = std::process::Command::new("nvidia-smi")
            .args(["--query-gpu=name", "--format=csv,noheader"])
            .stderr(std::process::Stdio::null())
            .output()
            .ok()
            .filter(|output| output.status.success())
            .and_then(|output| parse_gpu_name(&String::from_utf8_lossy(&output.stdout)));
        let cpu_model = std::fs::read_to_string("/proc/cpuinfo")
            .ok()
            .and_then(|text| parse_cpu_model(&text));
        let cpu_count = std::thread::available_parallelism()
            .ok()
            .and_then(|count| u32::try_from(count.get()).ok());
        Self {
            gpu,
            cpu_model,
            cpu_count,
        }
    }
}

/// The device UUID and the MIG mode of the first GPU, from `nvidia-smi --query-gpu=uuid,mig.mode.current`.
/// A MIG slice has a UUID that starts with `MIG-`. Either part is `None` when the tool does not say (a card without
/// MIG support answers `[N/A]` for the mode).
pub fn query_gpu_mig() -> (Option<String>, Option<String>) {
    let output = std::process::Command::new("nvidia-smi")
        .args(["--query-gpu=uuid,mig.mode.current", "--format=csv,noheader"])
        .stderr(std::process::Stdio::null())
        .output()
        .ok()
        .filter(|output| output.status.success());
    output.map_or((None, None), |output| {
        parse_gpu_uuid_and_mig(&String::from_utf8_lossy(&output.stdout))
    })
}

/// Reads the first line of `uuid, mig.mode.current` output.
pub fn parse_gpu_uuid_and_mig(output: &str) -> (Option<String>, Option<String>) {
    let Some(line) = output.lines().map(str::trim).find(|line| !line.is_empty()) else {
        return (None, None);
    };
    let mut parts = line.splitn(2, ',').map(|part| clean_name(part.trim()));
    let known =
        |part: Option<String>| part.filter(|text| !text.is_empty() && !text.starts_with('['));
    (known(parts.next()), known(parts.next()))
}

/// The first line of the `nvidia-smi` answer (one line per GPU; the worker uses the first).
pub fn parse_gpu_name(output: &str) -> Option<String> {
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?;
    Some(clean_name(line))
}

/// The `model name` of the first processor in `/proc/cpuinfo`.
pub fn parse_cpu_model(text: &str) -> Option<String> {
    text.lines()
        .filter_map(|line| line.split_once(':'))
        .find(|(key, _)| key.trim() == "model name")
        .map(|(_, value)| clean_name(value))
        .filter(|name| !name.is_empty())
}

/// What the remote backend measured around its worker.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteTimings {
    /// From the first request until the start of the request that the worker accepted: every cold-start wait, every
    /// pause and every failed attempt before it.
    pub wait_worker_ms: u64,
    /// How often the answer said "no worker is ready yet".
    pub not_ready_count: u32,
    /// How often an ordinary failure (no answer, a server error) made the backend send the job again.
    pub retry_count: u32,
    /// The part of `wait_worker_ms` spent asking `GET /ping` of endpoints with a start wait (a GPU tier) before the job
    /// was sent. 0 when no endpoint of the list has a start wait.
    pub start_wait_ms: u64,
    /// The label of the endpoint that gave the proof (`prover.remote_endpoints`, or `remote` for the single
    /// `prover.remote_url`). A label from the configuration, never a URL.
    pub endpoint: String,
    /// How many endpoints the backend gave up on before the one that gave the proof: 0 when the first one answered.
    pub failover_count: u32,
    /// The request that the worker accepted, from the first byte sent to the last byte read. A worker that the
    /// platform starts while it holds the request makes this include a cold start; `worker.total_ms` tells how much
    /// of it was the proof.
    pub remote_ms: u64,
    /// What the worker reported, when it did.
    pub worker: Option<WorkerTimings>,
}

/// What the backend measured inside `Prover::prove`. A backend that measures nothing gives `None`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProverTimings {
    /// The native run of the backend before it asked for a proof.
    pub native_ms: u64,
    /// The local verification of the proof that came back.
    pub verify_ms: u64,
    /// The remote part, for the remote backend.
    pub remote: Option<RemoteTimings>,
}

/// The step lines of the backend, as `(step, fields)` pairs for the logger.
pub fn prover_step_lines(
    timings: &ProverTimings,
) -> Vec<(&'static str, Vec<(&'static str, String)>)> {
    let mut lines = vec![(
        "prover_native",
        vec![("elapsed_ms", timings.native_ms.to_string())],
    )];
    if let Some(remote) = &timings.remote {
        lines.push((
            "wait_worker",
            vec![
                ("elapsed_ms", remote.wait_worker_ms.to_string()),
                ("start_wait_ms", remote.start_wait_ms.to_string()),
                ("not_ready_count", remote.not_ready_count.to_string()),
                ("retry_count", remote.retry_count.to_string()),
                ("endpoint", remote.endpoint.clone()),
                ("failover_count", remote.failover_count.to_string()),
            ],
        ));
        lines.push(("remote", vec![("elapsed_ms", remote.remote_ms.to_string())]));
    }
    lines.push((
        "verify",
        vec![("elapsed_ms", timings.verify_ms.to_string())],
    ));
    lines
}

/// What the producer measured itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ProducerTimings {
    /// Beacon reads and assembly of the update.
    pub build_ms: u64,
    /// The native run and the start checks of the producer.
    pub native_ms: u64,
    /// The whole call of `Prover::prove`.
    pub prove_ms: u64,
    /// The producer's own checks of the answer (shape and Groth16 verification).
    pub check_ms: u64,
    /// The whole run.
    pub total_ms: u64,
}

/// The fields of the `prove_timing` line.
///
/// `native_ms` and `verify_ms` add the backend's part to the producer's part. `wait_worker_ms`, `not_ready_count`,
/// `retry_count`, `endpoint`, `failover_count` and `remote_ms` appear for the remote backend only. `worker_*` appear when the worker reported timings;
/// otherwise `worker_timings=none` says that the worker did not (a remote backend only).
/// `remote_overhead_ms` is `remote_ms` minus the worker's `total_ms`: the network, the proxy and a cold start that the
/// platform hid inside the request.
pub fn summary_fields(
    producer: &ProducerTimings,
    prover: Option<&ProverTimings>,
) -> Vec<(&'static str, String)> {
    let native_ms = producer.native_ms + prover.map_or(0, |timings| timings.native_ms);
    let verify_ms = producer.check_ms + prover.map_or(0, |timings| timings.verify_ms);
    let mut fields = vec![
        ("build_ms", producer.build_ms.to_string()),
        ("native_ms", native_ms.to_string()),
    ];
    let remote = prover.and_then(|timings| timings.remote.as_ref());
    if let Some(remote) = remote {
        fields.push(("wait_worker_ms", remote.wait_worker_ms.to_string()));
        fields.push(("start_wait_ms", remote.start_wait_ms.to_string()));
        fields.push(("not_ready_count", remote.not_ready_count.to_string()));
        fields.push(("retry_count", remote.retry_count.to_string()));
        fields.push(("endpoint", remote.endpoint.clone()));
        fields.push(("failover_count", remote.failover_count.to_string()));
        fields.push(("remote_ms", remote.remote_ms.to_string()));
    }
    fields.push(("verify_ms", verify_ms.to_string()));
    fields.push(("prove_ms", producer.prove_ms.to_string()));
    fields.push(("total_ms", producer.total_ms.to_string()));
    if let Some(remote) = remote {
        fields.extend(worker_fields(remote));
    }
    fields
}

/// The `worker_*` fields: the worker's numbers and hardware, or `worker_timings=none`.
pub fn worker_fields(remote: &RemoteTimings) -> Vec<(&'static str, String)> {
    let Some(worker) = &remote.worker else {
        return vec![("worker_timings", "none".to_string())];
    };
    let mut fields = vec![
        ("worker_timings", "reported".to_string()),
        ("worker_queue_ms", worker.queue_ms.to_string()),
        ("worker_native_ms", worker.native_ms.to_string()),
        ("worker_prove_ms", worker.prove_ms.to_string()),
        ("worker_verify_ms", worker.verify_ms.to_string()),
        ("worker_total_ms", worker.total_ms.to_string()),
        (
            "remote_overhead_ms",
            remote.remote_ms.saturating_sub(worker.total_ms).to_string(),
        ),
    ];
    if let Some(gpu) = &worker.gpu {
        fields.push(("worker_gpu", gpu.clone()));
    }
    if let Some(model) = &worker.cpu_model {
        fields.push(("worker_cpu_model", model.clone()));
    }
    if let Some(count) = worker.cpu_count {
        fields.push(("worker_cpu_count", count.to_string()));
    }
    fields
}

#[cfg(test)]
mod tests {
    use super::*;

    fn worker() -> WorkerTimings {
        WorkerTimings {
            queue_ms: 5,
            native_ms: 700,
            prove_ms: 41_000,
            verify_ms: 30,
            total_ms: 42_000,
            gpu: Some("NVIDIA L40S".into()),
            cpu_model: Some("AMD EPYC 9354".into()),
            cpu_count: Some(32),
        }
    }

    fn get<'a>(fields: &'a [(&'static str, String)], key: &str) -> Option<&'a str> {
        fields
            .iter()
            .find(|(name, _)| *name == key)
            .map(|(_, value)| value.as_str())
    }

    /// Claim: the summary of a remote run carries every step, adds the backend's part to the producer's part, and
    /// shows the worker's numbers, its hardware and the overhead outside the worker.
    #[test]
    fn a_remote_summary_carries_every_step() {
        let producer = ProducerTimings {
            build_ms: 1200,
            native_ms: 300,
            prove_ms: 100_000,
            check_ms: 4,
            total_ms: 101_700,
        };
        let prover = ProverTimings {
            native_ms: 310,
            verify_ms: 6,
            remote: Some(RemoteTimings {
                wait_worker_ms: 60_000,
                start_wait_ms: 30_500,
                not_ready_count: 2,
                retry_count: 1,
                endpoint: "serverless".into(),
                failover_count: 1,
                remote_ms: 43_000,
                worker: Some(worker()),
            }),
        };
        let fields = summary_fields(&producer, Some(&prover));
        let expect = [
            ("build_ms", "1200"),
            ("native_ms", "610"),
            ("wait_worker_ms", "60000"),
            ("start_wait_ms", "30500"),
            ("not_ready_count", "2"),
            ("retry_count", "1"),
            ("endpoint", "serverless"),
            ("failover_count", "1"),
            ("remote_ms", "43000"),
            ("verify_ms", "10"),
            ("prove_ms", "100000"),
            ("total_ms", "101700"),
            ("worker_timings", "reported"),
            ("worker_queue_ms", "5"),
            ("worker_native_ms", "700"),
            ("worker_prove_ms", "41000"),
            ("worker_verify_ms", "30"),
            ("worker_total_ms", "42000"),
            ("remote_overhead_ms", "1000"),
            ("worker_gpu", "NVIDIA L40S"),
            ("worker_cpu_model", "AMD EPYC 9354"),
            ("worker_cpu_count", "32"),
        ];
        for (key, value) in expect {
            assert_eq!(get(&fields, key), Some(value), "{key}");
        }
    }

    /// Claim: without worker timings the summary says so and has no `worker_*` number. Without a remote part it has no
    /// remote field and no worker marker. Without a backend report it still has the producer's steps.
    #[test]
    fn missing_parts_are_left_out_or_marked() {
        let producer = ProducerTimings {
            build_ms: 1,
            native_ms: 2,
            prove_ms: 3,
            check_ms: 4,
            total_ms: 10,
        };
        let remote_without_worker = ProverTimings {
            native_ms: 0,
            verify_ms: 0,
            remote: Some(RemoteTimings::default()),
        };
        let fields = summary_fields(&producer, Some(&remote_without_worker));
        assert_eq!(get(&fields, "worker_timings"), Some("none"));
        assert!(fields
            .iter()
            .all(|(key, _)| !key.starts_with("worker_") || *key == "worker_timings"));
        assert!(get(&fields, "remote_overhead_ms").is_none());

        let local = ProverTimings {
            native_ms: 5,
            verify_ms: 0,
            remote: None,
        };
        let fields = summary_fields(&producer, Some(&local));
        assert_eq!(get(&fields, "native_ms"), Some("7"));
        assert!(get(&fields, "remote_ms").is_none() && get(&fields, "worker_timings").is_none());

        let fields = summary_fields(&producer, None);
        assert_eq!(get(&fields, "native_ms"), Some("2"));
        assert_eq!(get(&fields, "verify_ms"), Some("4"));
        assert_eq!(get(&fields, "total_ms"), Some("10"));
    }

    /// Claim: hardware that the worker could not name is left out, not logged as empty.
    #[test]
    fn unknown_hardware_is_left_out() {
        let mut bare = worker();
        bare.gpu = None;
        bare.cpu_model = None;
        bare.cpu_count = None;
        let remote = RemoteTimings {
            worker: Some(bare),
            ..RemoteTimings::default()
        };
        let fields = worker_fields(&remote);
        assert!(get(&fields, "worker_gpu").is_none());
        assert!(get(&fields, "worker_cpu_model").is_none());
        assert!(get(&fields, "worker_cpu_count").is_none());
    }

    /// Claim: the step lines name the remote steps only for a remote backend.
    #[test]
    fn step_lines_follow_the_backend() {
        let local = prover_step_lines(&ProverTimings::default());
        let names: Vec<&str> = local.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["prover_native", "verify"]);
        let remote = prover_step_lines(&ProverTimings {
            remote: Some(RemoteTimings::default()),
            ..ProverTimings::default()
        });
        let names: Vec<&str> = remote.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, ["prover_native", "wait_worker", "remote", "verify"]);
    }

    /// Claim: the worker's `timings` value is read leniently. A good one parses, with hostile names cleaned. A value
    /// that does not fit gives `None`.
    /// Why it matters: the timings are for the logs. They must never fail a proof, and a worker must not put a URL or a
    /// line break into the producer's log.
    #[test]
    fn worker_timings_are_read_leniently_and_cleaned() {
        let value = serde_json::json!({
            "queueMs": 1, "nativeMs": 2, "proveMs": 3, "verifyMs": 4, "totalMs": 10,
            "gpu": "GPU\nhttps://evil.example/path?key=SECRET", "cpuCount": 8, "future": true
        });
        let parsed = WorkerTimings::from_value(&value).expect("parsed");
        assert_eq!(parsed.total_ms, 10);
        assert_eq!(parsed.cpu_count, Some(8));
        let gpu = parsed.gpu.unwrap();
        assert!(!gpu.contains('\n') && !gpu.contains("SECRET"), "{gpu}");
        assert!(WorkerTimings::from_value(&serde_json::json!("fast")).is_none());
        assert!(WorkerTimings::from_value(&serde_json::json!({"totalMs": "x"})).is_none());
        let long = serde_json::json!({
            "queueMs": 0, "nativeMs": 0, "proveMs": 0, "verifyMs": 0, "totalMs": 0, "gpu": "x".repeat(500)
        });
        assert_eq!(
            WorkerTimings::from_value(&long).unwrap().gpu.unwrap().len(),
            MAX_NAME_CHARS
        );
    }

    /// Claim: the hardware parsers take the first GPU and the first processor model, and give `None` for no text.
    #[test]
    fn hardware_text_is_parsed() {
        assert_eq!(
            parse_gpu_name("NVIDIA L40S\nNVIDIA L40S\n").as_deref(),
            Some("NVIDIA L40S")
        );
        assert_eq!(parse_gpu_name("  \n"), None);
        let cpuinfo = "processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC 9354 32-Core Processor\nmodel name\t: other\n";
        assert_eq!(
            parse_cpu_model(cpuinfo).as_deref(),
            Some("AMD EPYC 9354 32-Core Processor")
        );
        assert_eq!(parse_cpu_model("processor : 0\n"), None);
        assert_eq!(parse_cpu_model("model name :  \n"), None);
    }

    /// Claim: a machine can be asked without a panic, and `millis` saturates.
    #[test]
    fn detection_and_millis_do_not_fail() {
        let _ = HostInfo::detect();
        assert_eq!(millis(Duration::from_millis(1500)), 1500);
        assert_eq!(millis(Duration::MAX), u64::MAX);
    }
}
