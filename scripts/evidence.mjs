/**
 * Everything this project claims about 0G, checked against 0G.
 *
 * The point is that none of it needs to be taken on our word. Each line below
 * is read live from public infrastructure — the 0G Galileo RPC and the
 * deployed contracts — using nothing this repository controls. Run it yourself
 * against a fresh clone, or paste the addresses into the explorer and read the
 * same numbers off somebody else's page.
 *
 * No private key, no funds and no configuration required: every call here is a
 * read.
 *
 *   node scripts/evidence.mjs
 */

import { ethers } from 'ethers'

const RPC = process.env.OG_RPC_URL_OVERRIDE ?? 'https://evmrpc-testnet.0g.ai'
const EXPLORER = 'https://chainscan-galileo.0g.ai'
const CHAIN_ID = 16602

/** Deployed by this project. Both are public; neither is a secret. */
const ANCHOR = '0x75016F7ce345E0527d20B5E08f273E42886D35A5'
const COACH = '0x52c576686Ee095DF9C04cbFB09c6BE1A775F04e7'
const RELAYER = '0xbb1b9Bb7d3cf914e40486CcfF9A34A7492156352'

/** Written by the end-to-end pipeline run, not by hand. */
const PIPELINE_ANCHOR_TX = '0xd68b35dc830dbac369dc3b316ff9d995dacd362d0f20eee57b0417b4a7b9f19c'

const ANCHOR_ABI = [
  'function snapshotCount(address) view returns (uint256)',
  'function nonceUsed(address,uint256) view returns (bool)',
]
const COACH_ABI = [
  'function versionCount(uint256) view returns (uint256)',
  'function ownerOf(uint256) view returns (address)',
  'function balanceOf(address) view returns (uint256)',
  'function name() view returns (string)',
  'function getMetadataHash(uint256) view returns (bytes32)',
]

let failures = 0

function check(label, ok, detail) {
  const mark = ok ? 'PASS' : 'FAIL'
  if (!ok) failures += 1
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function heading(text) {
  console.log(`\n${text}\n${'-'.repeat(text.length)}`)
}

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID, { staticNetwork: true })

heading('The chain')

const network = await provider.getNetwork()
check('reachable, and is 0G Galileo', Number(network.chainId) === CHAIN_ID, `chain id ${network.chainId}`)

const head = await provider.getBlockNumber()
check('producing blocks', head > 0, `head at block ${head}`)

heading('The contracts exist on it')

for (const [name, address] of [['HealthRecordAnchor', ANCHOR], ['CoachAgent', COACH]]) {
  const code = await provider.getCode(address)
  check(`${name} has bytecode`, code !== '0x', `${(code.length - 2) / 2} bytes at ${address}`)
  console.log(`         ${EXPLORER}/address/${address}`)
}

heading('The pipeline transaction is on it')

const receipt = await provider.getTransactionReceipt(PIPELINE_ANCHOR_TX)
check('the end-to-end run anchored a snapshot', receipt !== null && receipt.status === 1,
  receipt ? `block ${receipt.blockNumber}, ${receipt.gasUsed} gas, ${receipt.logs.length} event(s)` : 'not found')
if (receipt) {
  check('and it was sent to HealthRecordAnchor',
    receipt.to?.toLowerCase() === ANCHOR.toLowerCase(), receipt.to ?? '')
  check('paid for by the relayer, not by the record owner',
    receipt.from.toLowerCase() === RELAYER.toLowerCase(), receipt.from)
  console.log(`         ${EXPLORER}/tx/${PIPELINE_ANCHOR_TX}`)
}

heading('Records are owned by people who hold no wallet')

const anchor = new ethers.Contract(ANCHOR, ANCHOR_ABI, provider)
const relayerRecords = await anchor.snapshotCount(RELAYER)

/*
 * The relayer signs and pays for every transaction. If the design were the
 * usual custodial shortcut — records filed under the account that paid — this
 * number would grow with every user. What it counts instead is only the
 * snapshots the deployer anchored by hand while proving the deployment.
 */
console.log(`  the relayer has paid for every anchor ever written here,`)
console.log(`  and owns ${relayerRecords} of them (its own deployment tests).`)

heading('The coach is a token somebody owns, and it changes as it learns')

const coach = new ethers.Contract(COACH, COACH_ABI, provider)

for (const tokenId of [6, 8]) {
  try {
    const owner = await coach.ownerOf(tokenId)
    const versions = await coach.versionCount(tokenId)
    const held = await coach.balanceOf(owner)
    check(`token ${tokenId} exists and is owned`, true,
      `owner ${owner}, ${versions} version(s), that owner holds ${held}`)
    check(`  its owner is not the relayer that paid for it`,
      owner.toLowerCase() !== RELAYER.toLowerCase(), owner)
  } catch (error) {
    check(`token ${tokenId} readable`, false, String(error).slice(0, 80))
  }
}

/*
 * Token 8 was minted and then evolved by the worker in one run. Two versions is
 * the observable difference between a token that was issued once and one that
 * tracks what it has learned.
 */
const evolved = await coach.versionCount(8)
check('a coach that learned more recorded a second version', Number(evolved) === 2,
  `versionCount(8) = ${evolved}`)

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
console.log('Read live from', RPC, `at block ${head}.`)
process.exit(failures === 0 ? 0 : 1)
