//! Hardened two-chain tests of deployment: the deploy script's predicted addresses (R2-08) and the opcodes that
//! PulseChain does not run (R2-10).

mod common;

use alloy_primitives::{hex, keccak256, Address, B256};
use alloy_sol_types::SolCall;
use common::bridge::*;
use common::*;
use serde_json::json;
use std::collections::HashMap;
use std::process::Command;
use std::sync::Mutex;

/// Both tests in this file run forge against the same project. Run in parallel, the forge script stalled until its
/// deadline (it passes in seconds alone), so the tests take turns. A poisoned lock still serialises.
static FORGE_TURN: Mutex<()> = Mutex::new(());
use zk_bridge_prover::contracts::{LightClientContract, VaultContract};

/// The deploy script configuration for two chains. The deployer is the first Anvil account, and the script signs
/// with it through `--unlocked`.
fn script_config(
    chain_a: &TestChain,
    chain_b: &TestChain,
    verifiers: (Address, Address),
    tokens: (Address, Address),
    nonces: (u64, u64),
    capella_era_on_a: &str,
) -> String {
    let versions = |version: &str| json!([{ "version": version, "stateDepth": "5" }]);
    let gate = |mode: &str| {
        json!({
            "mode": mode, "genesisTime": "1600000000", "secondsPerSlot": "12", "slotsPerEpoch": "32",
            "supportedVersions": versions("0x03000000"), "sealDepths": ["5", "6", "7"],
        })
    };
    let light_client = |era: &str, label: &str| {
        json!({
            "programVKey": format!("{:#x}", keccak256(b"light-client-program")),
            "genesisValidatorsRoot": format!("{:#x}", keccak256(label)),
            "slotsPerPeriod": "8192", "slotsPerEpoch": "32", "capellaForkEpoch": "3", "capellaEra": era,
            "initialSlot": "100",
            "initialHeaderRoot": format!("{:#x}", keccak256(b"header")),
            "initialSyncCommitteeHash": format!("{:#x}", keccak256(b"committee")),
            "initialNextSyncCommitteeHash": format!("{:#x}", keccak256(b"next committee")),
        })
    };
    let chain = |url: &str, id: u64, verifier: Address, nonce: u64, era: &str, label: &str, mode: &str| {
        json!({
            "rpcAlias": url, "chainId": id.to_string(), "verifier": format!("{verifier:#x}"),
            "depositCutoffTimestamp": "0", "deployerNonce": nonce.to_string(),
            "lightClient": light_client(era, label), "gate": gate(mode),
        })
    };
    json!({
        "deployer": format!("{DEPLOYER:#x}"),
        "chainA": chain(&chain_a.anvil.url, 1, verifiers.0, nonces.0, capella_era_on_a, "genesis-of-chain-b", "Enforcing"),
        "chainB": chain(&chain_b.anvil.url, 369, verifiers.1, nonces.1, "0", "genesis-of-chain-a", "DetectBeaconRoots"),
        "tokenPairs": [{ "chainA": format!("{:#x}", tokens.0), "chainB": format!("{:#x}", tokens.1) }],
    })
    .to_string()
}

/// Runs the deploy script against the two chains. Returns the success flag and the combined output.
fn run_script(directory: &std::path::Path, config: &str) -> (bool, String) {
    let config_path = directory.join("bridge.config.json");
    std::fs::write(&config_path, config).unwrap();
    let base = directory.join("forge-script");
    // The script reads the configuration file, and the repository's foundry.toml allows reads only below
    // `script/hardened`. Forge reads no permission from the environment, so the test writes a copy of the repository's
    // foundry.toml into the scratch directory with one more read permission (for the scratch directory) and the
    // broadcast directory moved there too (a broadcast run writes records, and they must not land in the repository),
    // and points `FOUNDRY_CONFIG` at the copy. The repository's file stays unchanged.
    let relative = directory.strip_prefix(repository_root()).expect("the scratch directory lies below the repository");
    let repository_config = std::fs::read_to_string(repository_root().join("foundry.toml")).unwrap();
    assert!(repository_config.contains("fs_permissions = ["), "the repository config lists fs_permissions");
    let extra_permission = format!("fs_permissions = [\n  {{ access = \"read\", path = \"./{}\" }},", relative.display());
    let config_copy = directory.join("foundry.toml");
    let broadcast = format!("[profile.default]\nbroadcast = \"./{}/broadcast\"", relative.display());
    let adjusted = repository_config.replace("fs_permissions = [", &extra_permission).replace("[profile.default]", &broadcast);
    std::fs::write(&config_copy, adjusted).unwrap();
    // The output goes to files, so the test can poll the process and stop it after a deadline instead of waiting forever.
    let (stdout_path, stderr_path) = (directory.join("forge-script.out"), directory.join("forge-script.err"));
    let mut child = Command::new("forge")
        .current_dir(repository_root())
        .env("BRIDGE_CONFIG", &config_path)
        .env("FOUNDRY_CONFIG", &config_copy)
        .args(["script", "script/hardened/DeployBridge.s.sol", "--tc", "DeployBridge", "--broadcast", "--unlocked", "--sender", &format!("{DEPLOYER:#x}")])
        .arg("--out")
        .arg(base.join("out"))
        .arg("--cache-path")
        .arg(base.join("cache"))
        .stdout(std::fs::File::create(&stdout_path).unwrap())
        .stderr(std::fs::File::create(&stderr_path).unwrap())
        .spawn()
        .expect("run forge script");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(240);
    let status = loop {
        if let Some(status) = child.try_wait().expect("poll forge") {
            break Some(status);
        }
        if std::time::Instant::now() > deadline {
            let _ = child.kill();
            let _ = child.wait();
            break None;
        }
        std::thread::sleep(std::time::Duration::from_millis(200));
    };
    let read = |path: &std::path::Path| std::fs::read_to_string(path).unwrap_or_default();
    let text = format!("{}{}", read(&stdout_path), read(&stderr_path));
    assert!(status.is_some(), "forge script did not finish within 240 seconds:\n{text}");
    (status.is_some_and(|status| status.success()), text)
}

/// Claim: the addresses that the deploy script predicts from the deployer nonces are the addresses it deploys to, on
/// both chains, and each vault points at the other chain's predicted vault.
/// Shows: the script runs against two live Anvil chains (the real `run()` entry point, with `--broadcast`). A first run
/// with a wrong deployer nonce, and a second with a wrong Capella era, both fail before any transaction, so the
/// deployer nonces do not move. The honest run succeeds. Its logged plan names the addresses that this test computes
/// by itself from the deployer and the nonces. The contracts have code at those addresses. Each vault's
/// `remoteVault()` is the predicted vault of the other chain, each vault's light client and gate are the predicted
/// ones, and the token pair is registered both ways.
/// Why it matters: R2-08. Each vault needs the other's address as an immutable constructor argument, and neither can be
/// known before deployment unless the address is predicted. A vault that points at a wrong address on the other chain
/// accepts no deposit, or worse, accepts one from a stranger's contract.
#[test]
fn r2_08_hardened_deploy_script_predicted_addresses_are_the_deployed_addresses() {
    let _turn = FORGE_TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !tools_available() {
        return;
    }
    let chain_a = TestChain::start(1, Hardfork::Cancun);
    let chain_b = TestChain::start(369, Hardfork::Shanghai);
    install_beacon_roots(&chain_a);
    chain_b.send(Some(DEPLOYER), &[]);
    let deploy_verifier = |chain: &TestChain| chain.deploy("OracleSP1Verifier", HashMap::from([("oracle", word_address(DEPLOYER))]));
    let deploy_token = |chain: &TestChain, name: &str| {
        chain.deploy("MockERC20", HashMap::from([("name", Argument::Text(name.into())), ("symbol", Argument::Text("TKN".into()))]))
    };
    let verifiers = (deploy_verifier(&chain_a), deploy_verifier(&chain_b));
    let tokens = (deploy_token(&chain_a, "Token A"), deploy_token(&chain_b, "Token B"));
    let nonces = (chain_a.nonce(DEPLOYER), chain_b.nonce(DEPLOYER));
    let directory = scratch("r2-08-deploy-script");

    // Controls: a wrong nonce and a wrong Capella era both stop the script before it sends anything.
    let (ok, output) = run_script(&directory, &script_config(&chain_a, &chain_b, verifiers, tokens, (nonces.0 + 1, nonces.1), "0"));
    assert!(!ok && output.contains("DeployerNonceMismatch"), "a wrong nonce must stop the script:\n{output}");
    let (ok, output) = run_script(&directory, &script_config(&chain_a, &chain_b, verifiers, tokens, nonces, "1"));
    assert!(!ok && output.contains("CapellaEraMismatch"), "a wrong Capella era must stop the script:\n{output}");
    assert_eq!((chain_a.nonce(DEPLOYER), chain_b.nonce(DEPLOYER)), nonces, "a refused run sends nothing");

    // The honest run.
    let (ok, output) = run_script(&directory, &script_config(&chain_a, &chain_b, verifiers, tokens, nonces, "0"));
    assert!(ok, "the script must succeed:\n{output}");
    assert_eq!((chain_a.nonce(DEPLOYER), chain_b.nonce(DEPLOYER)), (nonces.0 + 3, nonces.1 + 3), "three contracts on each chain");

    // This test's own prediction: light client at n, gate at n + 1, vault at n + 2.
    let predicted = |nonce: u64| (DEPLOYER.create(nonce), DEPLOYER.create(nonce + 1), DEPLOYER.create(nonce + 2));
    let (light_client_a, gate_a, vault_a) = predicted(nonces.0);
    let (light_client_b, gate_b, vault_b) = predicted(nonces.1);
    let lowercase_output = output.to_lowercase();
    for address in [light_client_a, gate_a, vault_a, light_client_b, gate_b, vault_b] {
        assert!(lowercase_output.contains(&format!("{address:#x}")), "the script's plan names {address:#x}:\n{output}");
    }
    for (chain, addresses) in [(&chain_a, [light_client_a, gate_a, vault_a]), (&chain_b, [light_client_b, gate_b, vault_b])] {
        for address in addresses {
            assert!(chain.code_of(address).len() > 1000, "{address} holds a contract on chain {}", chain.anvil.chain_id);
        }
    }

    // Read the relationships from the chains (a name is a hypothesis).
    let address_of = |chain: &TestChain, to: Address, data: Vec<u8>| Address::from_slice(&chain.call(to, &data).unwrap()[12..]);
    assert_eq!(address_of(&chain_a, vault_a, VaultContract::remoteVaultCall {}.abi_encode()), vault_b, "vault A points at the predicted vault B");
    assert_eq!(address_of(&chain_b, vault_b, VaultContract::remoteVaultCall {}.abi_encode()), vault_a, "vault B points at the predicted vault A");
    assert_eq!(address_of(&chain_a, vault_a, VaultContract::lightClientCall {}.abi_encode()), light_client_a);
    assert_eq!(address_of(&chain_b, vault_b, VaultContract::lightClientCall {}.abi_encode()), light_client_b);
    assert_eq!(address_of(&chain_a, vault_a, VaultContract::depositGateCall {}.abi_encode()), gate_a);
    assert_eq!(address_of(&chain_b, vault_b, VaultContract::depositGateCall {}.abi_encode()), gate_b);
    assert_eq!(address_of(&chain_a, vault_a, VaultContract::remoteTokenOfCall { localToken: tokens.0 }.abi_encode()), tokens.1);
    assert_eq!(address_of(&chain_b, vault_b, VaultContract::remoteTokenOfCall { localToken: tokens.1 }.abi_encode()), tokens.0);
    // Each light client tracks the other chain: the genesis validators roots match the configuration.
    let genesis = |chain: &TestChain, light_client: Address| {
        B256::from_slice(&chain.call(light_client, &LightClientContract::genesisValidatorsRootCall {}.abi_encode()).unwrap())
    };
    assert_eq!(genesis(&chain_a, light_client_a), keccak256("genesis-of-chain-b"));
    assert_eq!(genesis(&chain_b, light_client_b), keccak256("genesis-of-chain-a"));
    assert!(gate_enforcing(&chain_a, gate_a), "the gate of chain 1 enforces from the start");
    assert!(!gate_enforcing(&chain_b, gate_b), "the gate of chain 369 detects");
    // The forge cache of this test is large. Remove the scratch directory (a failed run keeps it for inspection).
    let _ = std::fs::remove_dir_all(&directory);
}

/// The opcodes that the Shanghai-era chain does not run.
const MCOPY: u8 = 0x5e;
const TSTORE: u8 = 0x5d;
const TLOAD: u8 = 0x5c;

/// Counts how often `opcode` occurs as an instruction. The bytes that follow `PUSH1` to `PUSH32` are data and are skipped.
fn count_opcode(code: &[u8], opcode: u8) -> usize {
    let (mut count, mut index) = (0, 0);
    while index < code.len() {
        let current = code[index];
        if current == opcode {
            count += 1;
        }
        if (0x60..=0x7f).contains(&current) {
            index += usize::from(current - 0x5f);
        }
        index += 1;
    }
    count
}

/// Claim: bytecode that contains `MCOPY` fails to run on chain 369 (Shanghai) and runs on chain 1 (Cancun), and the
/// hardened build, deployed on chain 369, contains no `MCOPY`, `TSTORE` or `TLOAD` and works there.
/// Shows: a small contract with `MCOPY` is called on both chains: the call succeeds on Cancun and fails on Shanghai. A
/// creation code that runs `MCOPY` in its constructor deploys on Cancun and fails to deploy on Shanghai. The scanner is
/// checked on known samples so that it can find an opcode and skips push data. The deployed code of the light client,
/// the vault and the gate on chain 369 has none of the three opcodes, and a deposit on chain 369 runs that code to
/// completion.
/// Why it matters: R2-10. The repository compiled for Cancun, and PulseChain stopped at Shanghai. A contract that
/// uses `MCOPY` deploys and then reverts on every call, or fails to deploy, and nothing in the source shows it.
#[test]
fn r2_10_hardened_mcopy_bytecode_fails_on_shanghai_and_the_hardened_build_runs() {
    let _turn = FORGE_TURN.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if !tools_available() {
        return;
    }
    let bridge = deploy_bridge("r2-10-mcopy");
    let (cancun, shanghai) = (&bridge.chain_a, &bridge.chain_b);

    // The scanner finds a real instruction and skips push data (the control for the zero counts below).
    assert_eq!(count_opcode(&[MCOPY], MCOPY), 1);
    assert_eq!(count_opcode(&[0x60, MCOPY, 0x00], MCOPY), 0);
    assert_eq!(count_opcode(&[0x61, TSTORE, TSTORE, TSTORE], TSTORE), 1);

    // Runtime code: PUSH1 0, PUSH1 0, PUSH1 0, MCOPY, STOP.
    let probe = Address::repeat_byte(0x5e);
    let runtime = hex::decode("6000600060005e00").unwrap();
    for chain in [cancun, shanghai] {
        chain.set_code(probe, &runtime);
    }
    assert!(cancun.call(probe, &[]).is_ok(), "MCOPY runs on Cancun");
    assert!(shanghai.call(probe, &[]).is_err(), "MCOPY does not run on Shanghai");

    // Creation code that runs MCOPY in its constructor, then returns one STOP byte as the runtime code.
    let creation = hex::decode("6000600060005e600060005360016000f3").unwrap();
    let deployed = cancun.send(None, &creation);
    assert!(deployed["contractAddress"].is_string(), "the constructor with MCOPY deploys on Cancun");
    let failed = shanghai.send_allowing_failure(None, &creation);
    assert_eq!(failed["status"], "0x0", "the constructor with MCOPY fails on Shanghai");

    // The hardened build on chain 369.
    for (name, address) in [("light client", bridge.light_client_b), ("vault", bridge.vault_b), ("gate", bridge.gate_b)] {
        let code = shanghai.code_of(address);
        assert!(code.len() > 1000, "{name} has code");
        for (opcode, label) in [(MCOPY, "MCOPY"), (TSTORE, "TSTORE"), (TLOAD, "TLOAD")] {
            assert_eq!(count_opcode(&code, opcode), 0, "{name} contains no {label}");
        }
    }
    let made = deposit_on(&bridge, Direction::BToA, ONE_TOKEN);
    assert_eq!(made.receipt["status"], "0x1", "the hardened vault runs on Shanghai");
}
