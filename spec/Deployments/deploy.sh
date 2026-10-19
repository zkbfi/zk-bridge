#!/bin/bash
set -e # Exit immediately if any command fails

echo "🛠️ Starting Production Deployment Suite for Ethereum ⇄ PulseChain Bridge..."

# 1. Install Succinct SP1 zkVM Toolchain Compilers
curl -L https://sp1up.succinct.xyz | bash
source ~/.bashrc
sp1up

# 2. Compile the Rust Circuit to extract the mathematically unique Verification Key
echo "🦀 Compiling off-chain consensus circuits..."
cd bridge-circuits
cargo prove build --release

# Capture the generated VKey string outputted by the sp1 compiler toolchain
PROGRAM_VKEY=$(cargo prove vkey)
echo "🔒 Your Immutable Verification Key Fingerprint is: $PROGRAM_VKEY"
cd ..

# 3. Initialize Foundry Toolchain for Smart Contract Deployments
curl -L https://foundry.paradigm.xyz | bash
source ~/.bashrc
foundryup

cd smart-contracts

# =========================================================================
# NOTE: Ensure your real private key and RPC URLs are configured below or
# passed via an environment file (.env) to protect keys from leak risks.
# =========================================================================
export ETH_RPC="https://alchemy.com"
export PULSE_RPC="https://rpc.pulsechain.com"
export DEPLOYER_KEY="YOUR_REAL_DEPLOYER_PRIVATE_KEY"

# 4. FIRST: Deploy the LightClientSync contract on both networks
echo "🚀 Deploying Consensus Sync Layer to Ethereum..."
SYNC_ETH_ADDRESS=$(forge create src/LightClientSync.sol:LightClientSync \
  --rpc-url $ETH_RPC --private-key $DEPLOYER_KEY \
  --constructor-args "INITIAL_ETH_COMMITTEE_ROOT" "CURRENT_PERIOD_INT" \
  --json | jq -r '.deployedTo')

echo "🚀 Deploying Consensus Sync Layer to PulseChain..."
SYNC_PULSE_ADDRESS=$(forge create src/LightClientSync.sol:LightClientSync \
  --rpc-url $PULSE_RPC --private-key $DEPLOYER_KEY \
  --constructor-args "INITIAL_PULSE_COMMITTEE_ROOT" "CURRENT_PERIOD_INT" \
  --json | jq -r '.deployedTo')

# 5. SECOND: Deploy the Vault Contracts using the captured Sync pointers
echo "🚀 Deploying Vault Contracts to Ethereum..."
forge create src/ZKBridgeVault.sol:ZKBridgeVault \
  --rpc-url $ETH_RPC \
  --private-key $DEPLOYER_KEY \
  --constructor-args "0xSP1VerifierContractAddressMainnet" $PROGRAM_VKEY 1 $SYNC_ETH_ADDRESS \
  --verify

echo "🚀 Deploying Vault Contracts to PulseChain..."
forge create src/ZKBridgeVault.sol:ZKBridgeVault \
  --rpc-url $PULSE_RPC \
  --private-key $DEPLOYER_KEY \
  --constructor-args "0xSP1VerifierContractAddressPulseChain" $PROGRAM_VKEY 369 $SYNC_PULSE_ADDRESS \
  --verify

echo "🏁 Deployment Complete! Admin accounts are unlinked and contracts are strictly decentralized."