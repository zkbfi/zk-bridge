//! The `zk-bridge-prover` binary. All logic is in the library.
//!
//! Exit codes: 0 for success, 1 for an error, 2 when `route-health` finds a route that refuses deposits.

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let lookup = |name: &str| std::env::var(name).ok();
    let mut out = std::io::stdout();
    match zk_bridge_prover::cli::run(arguments, &lookup, &mut out) {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("error: {error}");
            std::process::exit(1);
        }
    }
}
