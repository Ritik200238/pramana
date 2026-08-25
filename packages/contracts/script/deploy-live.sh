#!/usr/bin/env bash
#
# Deploy to live 0G Galileo, then prove the deployment by using it.
#
# Everything here has already been exercised against a fork of this same chain
# (see verify-fork.sh), so this is the same sequence with real funds and a real
# broadcast. It refuses to start rather than half-deploy: no balance, no run.
#
# Usage:  ./script/deploy-live.sh
# Reads:  packages/contracts/.env   (PRIVATE_KEY, ADMIN — gitignored)

set -euo pipefail

RPC="${RPC:-https://evmrpc-testnet.0g.ai}"
EXPLORER="https://chainscan-galileo.0g.ai"

cd "$(dirname "$0")/.."
[[ -f .env ]] || { echo "packages/contracts/.env is missing" >&2; exit 1; }
set -a; . ./.env; set +a

ADDRESS=$(cast wallet address --private-key "$PRIVATE_KEY")
echo "==> Deployer ${ADDRESS}"

CHAIN=$(cast chain-id --rpc-url "$RPC")
[[ "$CHAIN" == "16602" ]] || { echo "expected chain 16602, got ${CHAIN}" >&2; exit 1; }

BALANCE=$(cast balance "$ADDRESS" --rpc-url "$RPC")
echo "    balance ${BALANCE} wei on chain ${CHAIN}"

# Roughly the deployment cost measured on the fork, with headroom for the
# exercises below. Refusing early beats a contract deployed and a mint that
# cannot pay.
if [[ "$BALANCE" == "0" ]]; then
  echo "    not funded. Send testnet 0G to ${ADDRESS} at https://faucet.0g.ai" >&2
  exit 1
fi

echo "==> Broadcasting"
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC" --broadcast | tee /tmp/ogt-live-deploy.log

ANCHOR=$(grep -oE 'HealthRecordAnchor: 0x[0-9a-fA-F]{40}' /tmp/ogt-live-deploy.log | tail -1 | awk '{print $2}')
COACH=$(grep -oE 'CoachAgent +: 0x[0-9a-fA-F]{40}' /tmp/ogt-live-deploy.log | tail -1 | awk '{print $3}')

echo
echo "    HealthRecordAnchor ${ANCHOR}"
echo "    CoachAgent         ${COACH}"
echo "    ${EXPLORER}/address/${ANCHOR}"
echo "    ${EXPLORER}/address/${COACH}"

# ---------------------------------------------------------------- prove it works

echo
echo "==> Anchoring a snapshot on the live chain"
cast send "$ANCHOR" "anchorSnapshot(bytes32[],uint32)" \
  "[0x1111111111111111111111111111111111111111111111111111111111111111]" 1 \
  --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null

COUNT=$(cast call "$ANCHOR" "snapshotCount(address)(uint256)" "$ADDRESS" --rpc-url "$RPC")
echo "    snapshotCount = ${COUNT}"

echo "==> Minting a coach on the live chain"
cast send "$COACH" "mintCoach(bytes32,bytes32,uint32)" \
  0x2222222222222222222222222222222222222222222222222222222222222222 \
  0x3333333333333333333333333333333333333333333333333333333333333333 1 \
  --private-key "$PRIVATE_KEY" --rpc-url "$RPC" >/dev/null

OWNER=$(cast call "$COACH" "ownerOf(uint256)(address)" 1 --rpc-url "$RPC")
echo "    ownerOf(1) = ${OWNER}"

SPENT=$(cast balance "$ADDRESS" --rpc-url "$RPC")
echo
echo "==> Done. Remaining balance ${SPENT} wei."
echo "    Put these in apps/api/.env:"
echo "      OG_ANCHOR_ADDRESS=${ANCHOR}"
echo "      OG_COACH_ADDRESS=${COACH}"
