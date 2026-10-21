//! The `zk-bridge-prover` binary. All logic is in the library.

fn main() {
    let arguments: Vec<String> = std::env::args().collect();
    let lookup = |name: &str| std::env::var(name).ok();
    let mut out = std::io::stdout();
    if let Err(error) = zk_bridge_prover::cli::execute(arguments, &lookup, &mut out) {
        eprintln!("error: {error}");
        std::process::exit(1);
    }
}
