#!/usr/bin/env bash
#
# Deploy and exercise both contracts against a fork of live 0G Galileo.
#
# This is the closest thing to a real deployment that costs nothing and needs no
# funded key: real chain id, real chain state, real EVM configuration, real gas.
# What it cannot tell you is whether a broadcast to the live network is accepted
# — only funds can answer that — but every other way a deployment fails is
# reachable from here.
#
# Usage:  ./script/verify-fork.sh
# Needs:  anvil, forge and cast on PATH. No key, no funds, no network account.

set -euo pipefail

RPC_UPSTREAM="${RPC_UPSTREAM:-https://evmrpc-testnet.0g.ai}"
PORT="${PORT:-8545}"
LOCAL="http://127.0.0.1:${PORT}"

# Anvil's well-known development accounts. These are published in anvil's own
# output on every start and hold nothing on any real network.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
ADMIN_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
USER_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
USER_ADDR=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC

cleanup() { [[ -n "${ANVIL_PID:-}" ]] && kill "$ANVIL_PID" 2>/dev/null || true; }
trap cleanup EXIT

echo "==> Forking ${RPC_UPSTREAM}"
anvil --fork-url "$RPC_UPSTREAM" --port "$PORT" --silent &
ANVIL_PID=$!

for _ in $(seq 1 30); do
  if cast chain-id --rpc-url "$LOCAL" >/dev/null 2>&1; then break; fi
  sleep 1
done

CHAIN_ID=$(cast chain-id --rpc-url "$LOCAL")
BLOCK=$(cast block-number --rpc-url "$LOCAL")
echo "    chain id ${CHAIN_ID} at block ${BLOCK}"

# The deploy script refuses any chain id it does not recognise, so this doubles
# as a check that the fork really is 0G and not a default local chain.
if [[ "$CHAIN_ID" != "16602" && "$CHAIN_ID" != "16661" ]]; then
  echo "    fork is not a 0G chain; the deploy guard should reject it" >&2
  exit 1
fi

echo "==> Deploying"
PRIVATE_KEY="$DEPLOYER_KEY" ADMIN="$ADMIN_ADDR" \
  forge script script/Deploy.s.sol:Deploy --rpc-url "$LOCAL" --broadcast >/tmp/ogt-deploy.log 2>&1 ||
  { cat /tmp/ogt-deploy.log; exit 1; }

ANCHOR=$(grep -oE 'HealthRecordAnchor: 0x[0-9a-fA-F]{40}' /tmp/ogt-deploy.log | tail -1 | awk '{print $2}')
COACH=$(grep -oE 'CoachAgent        : 0x[0-9a-fA-F]{40}' /tmp/ogt-deploy.log | tail -1 | awk '{print $3}')
echo "    HealthRecordAnchor ${ANCHOR}"
echo "    CoachAgent         ${COACH}"

echo "==> Anchoring a snapshot as a user"
cast send "$ANCHOR" "anchorSnapshot(bytes32[],uint32)" \
  "[0x1111111111111111111111111111111111111111111111111111111111111111]" 1 \
  --private-key "$USER_KEY" --rpc-url "$LOCAL" >/dev/null

COUNT=$(cast call "$ANCHOR" "snapshotCount(address)(uint256)" "$USER_ADDR" --rpc-url "$LOCAL")
[[ "$COUNT" == "1" ]] || { echo "    expected 1 snapshot, got ${COUNT}" >&2; exit 1; }
echo "    snapshot recorded and readable"

echo "==> Minting a coach"
cast send "$COACH" "mintCoach(bytes32,bytes32,uint32)" \
  0x2222222222222222222222222222222222222222222222222222222222222222 \
  0x3333333333333333333333333333333333333333333333333333333333333333 1 \
  --private-key "$USER_KEY" --rpc-url "$LOCAL" >/dev/null

OWNER=$(cast call "$COACH" "ownerOf(uint256)(address)" 1 --rpc-url "$LOCAL")
# The point of the whole design: the coach belongs to the person, not to us.
if [[ "${OWNER,,}" != "${USER_ADDR,,}" ]]; then
  echo "    coach owned by ${OWNER}, expected ${USER_ADDR}" >&2
  exit 1
fi
echo "    coach minted and owned by the user, not the backend"

echo
echo "OK — both contracts deploy and run against live 0G chain state."
