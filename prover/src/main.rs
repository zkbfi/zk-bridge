//! The `zk-bridge-prover` binary. All logic is in the library.
//!
//! Exit codes: 0 for success, 1 for an error, and 3 when `prove` finds that the starting head already is the newest final
//! header, so there is nothing to prove.

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let lookup = |name: &str| std::env::var(name).ok();
    let mut out = std::io::stdout();
    match zk_bridge_prover::cli::run(arguments, &lookup, &mut out) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!(
                "error: {}",
                zk_bridge_prover::logging::redact_urls(&error.to_string())
            );
            std::process::exit(1);
        }
    }
}
