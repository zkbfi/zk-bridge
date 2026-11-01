//! The proving worker for a GPU host. It needs the cargo feature `sp1-cuda` and an NVIDIA GPU.
//!
//! Settings come from environment variables: `PORT`, `PORT_HEALTH`, `ZK_BRIDGE_WORKER_MIN_HOST_MEMORY_GIB` (default 48), `ZK_BRIDGE_WORKER_LIGHT_CLIENT_ELF` and
//! `ZK_BRIDGE_WORKER_OBSERVATION_ELF`. The request handling is in `zk_bridge_prover::worker`; `docs/gpu-prover.md`
//! explains the deployment.

use zk_bridge_prover::prover::{Sp1CudaProver, Sp1ProgramPaths};
use zk_bridge_prover::worker::{run, GuestProver, WorkerSettings};

fn main() {
    let lookup = |name: &str| std::env::var(name).ok();
    let outcome = WorkerSettings::from_lookup(&lookup).and_then(|settings| {
        run(&settings, |settings| {
            let paths = Sp1ProgramPaths {
                light_client: settings.light_client_elf.clone(),
                fork_observation: Some(settings.observation_elf.clone()),
            };
            Ok(Box::new(Sp1CudaProver::load(&paths)?) as Box<dyn GuestProver>)
        })
    });
    if let Err(error) = outcome {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
