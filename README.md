# JustLend CLI

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![TRON Network](https://img.shields.io/badge/Network-TRON-red)](https://tron.network/)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9.3-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Protocol: JustLend DAO](https://img.shields.io/badge/Protocol-JustLend_DAO-green)](https://justlend.org/)
[![CI](https://github.com/justlend/justlend-cli/actions/workflows/ci.yml/badge.svg?branch=main&event=push)](https://github.com/justlend/justlend-cli/actions/workflows/ci.yml)

CLI for [JustLend DAO](https://justlend.org) on TRON. Covers V2 (Moolah) lending, V1 legacy lending, sTRX / stUSDT staking, energy rental and direct purchase, governance, rewards, airdrops, mining reads, historical records, pre-sign transaction prechecks, and safe dry-run simulation.

> Current status: active CLI implementation with read paths, selected write paths, TronLink signer integration, JSON output, and dry-run simulation. Production/mainnet validation is not required for QA pass criteria; Nile/testnet dry-run is the default safety regression path.

## Requirements

- Node.js >= 20
- npm
- TronLink browser extension + `tronlink-signer` only when signing real write transactions
- TRON API key is optional; pass `--api-key <key>` or set `JUSTLEND_API_KEY` / `TRON_API_KEY`

## Installation

The CLI is not currently published to npm. Install it from source:

```bash
git clone https://github.com/justlend/justlend-cli.git
cd justlend-cli
npm ci
npm run build
npm link
```

After installation, the `justlend` command is available globally.

## Common validation commands

```bash
# Full local verification used before commits / releases
npm run check

# Individual stages
npm run typecheck
npm test
npm run build

# Nile dry-run smoke. This builds on dist/bin/cli.js, so run build first.
npm run test:smoke:nile
```

## Global options

| Option | Default | Description |
| --- | --- | --- |
| `--network <mainnet\|nile>` | `JUSTLEND_NETWORK` or `mainnet` | Target network. QA validation should prefer `nile`. |
| `--full-host <url>` | network default | Override Tron RPC host; env: `JUSTLEND_FULL_HOST`. |
| `--api-host <url>` | network default | Override JustLend V1 backend host; env: `JUSTLEND_API_HOST`. |
| `--moolah-api-host <url>` | network default | Override V2 Moolah backend host; env: `JUSTLEND_MOOLAH_API_HOST`. |
| `--energy-api-url <url>` | none | Energy direct-purchase API; env: `JUSTLEND_ENERGY_API_URL`. No fallback is used. |
| `--json` | off | Machine-readable output: `{success,data}` or `{success:false,error}`. |
| `--local-broadcast` | off | Broadcast via CLI local TronWeb instead of signer TronWeb. |
| `--no-broadcast` | off | Sign only; return `signedTx` without sending. |
| `--dry-run` | off | Build calldata and run `triggerconstantcontract` simulation. No signer, no broadcast. |
| `--dry-run-owner <address>` | — | Owner address used for dry-run simulation. |
| `--no-precheck` | off (precheck on) | Skip the pre-sign balance / energy / revert preflight on contract writes. |
| `--yes` | off | Skip local safety prompt before signing/broadcasting. |
| `--port <n>` | `3386` | TronLink Signer HTTP port. |
| `--api-key <key>` | — | TronGrid API key; `JUSTLEND_API_KEY` / `TRON_API_KEY` env is also supported. |
| `--verbose` | off | Print diagnostic HTTP/RPC logs to stderr. |
| `--debug` | off | Print verbose diagnostic logs with sensitive fields redacted. |
| `--log-file <path>` | — | Append diagnostic logs to a file instead of stderr. |
| `--timeout <ms>` | `300000` | Signing timeout. |
| `--fee-limit <trx>` | `100` | Fee limit in TRX for TRC20 / V2 writes. |
| `-q, --quiet` | off | Suppress non-error output. |

## Command overview

Run the current command tree:

```bash
justlend --help
```

Main groups:

```text
network       Show endpoints and JustLend contract addresses
price         Query token price from JustLend backend
market        V2 Moolah market reads
vault         V2 Moolah vault reads
position      V2 user position reads
liquidation   V2 liquidation reads
history       Cross-module transaction history
v1            V1 legacy lending commands
connect       Verify TronLink wallet connection
serve         Run signer daemon / IPC server
stusdt        stUSDT / wstUSDT staking commands
wtrx          Wrap native TRX into WTRX or unwrap WTRX back to TRX
airdrop       V2 airdrop multiClaim commands
sun           SUN liquidity mining pool commands
strx          sTRX liquid staking commands
energy        Energy rental and direct-purchase commands
gov           Governance commands
mining        V2 Moolah mining reward commands
approve       Approve TRC20 token spending
supply        V2 supply
withdraw      V2 withdraw
borrow        V2 borrow
repay         V2 repay
collateral    V2 collateral commands
liquidate     V2 liquidation write command
simulate      Explain dry-run usage for a planned transaction
watch         Current position health snapshot
portfolio     Cross-module portfolio overview
rewards       V1 mining + V2 airdrop claimable summary
```

### Side effects by command group

| Class | Commands | Confirmation |
|-------|----------|--------------|
| 🟢 Network Read (no signing) | `network` `price` `market` `vault` `position` `liquidation` `history` `watch` `portfolio` `rewards` `mining` `simulate` `connect` `config` | none |
| 🟡 Remote Write (signs + broadcasts) | `approve` `supply` `withdraw` `borrow` `repay` `collateral` `v1` `stusdt` `wtrx` `sun` `strx` `energy` `gov` `airdrop` `rewards claim` | dry-run first; `--yes` required in `--json`/`--quiet`/non-TTY |
| 🔴 Destructive / high-risk | `liquidate` | seizes another account's collateral (irreversible); dry-run + explicit `--yes`, never automate without review |
| ⚙️ Daemon (local) | `serve` | per-session token + `0600/0700` files; same-user only; idle auto-shutdown (`--idle-timeout`, default 10 min) |

### Energy direct purchase

The purchase API is separately deployed and must be configured explicitly. Until its production
hostname is added to the CLI allowlist, a custom endpoint also requires the standard explicit
untrusted-host opt-in.

```bash
export JUSTLEND_ENERGY_API_URL="https://energy-api.example"
export JUSTLEND_ALLOW_UNTRUSTED_HOSTS=1 # temporary/custom endpoints only

# Read live backend limits, prices, and pool capacity
justlend energy purchase config

# Read-only authoritative quote
justlend energy purchase quote 65000 --receiver TReceiverAddress...

# Quote-only dry run: no wallet and no signed transaction
justlend --dry-run energy purchase buy 65000 --receiver TReceiverAddress...

# Explicit write: prompts before signing; --yes is required for non-TTY/JSON use
justlend --yes energy purchase buy 65000 --receiver TReceiverAddress...

# Reconcile a payment whose submission result was unknown
justlend energy purchase risk TPayerAddress...
```

The CLI signs a native TRX transfer but **never broadcasts it locally**. The configured energy
service validates and broadcasts the signed transaction. Ambiguous submissions retry only the same
signed transaction. Public transaction identifiers—not signed transaction payloads—are persisted in
`~/.justlend-cli/energy-payment-risks.json` so a later invocation cannot silently create a second
payment. A per-payer intent lock is also created atomically before signing, so concurrent CLI
processes cannot authorize two payments. The final authoritative quote must exactly match the amount
shown at confirmation time. Corrupt or unreadable safety state blocks purchases instead of being
treated as empty. Risk output distinguishes FullNode `observed`/`included` status from SolidityNode
`solidified` finality; an RPC error or missing transaction remains unresolved and cannot authorize a
new signature. `--no-broadcast` is intentionally rejected for this workflow; use `quote` or
`--dry-run` instead.

## Safe dry-run examples

Dry-run is the recommended way to test write paths. It does not sign and does not broadcast.

```bash
OWNER=TCrDi83pUoK17GbwxN1SckM3YNXzahWvoN

justlend --json --network nile --dry-run --dry-run-owner "$OWNER" strx stake 0.000001
justlend --json --network nile --dry-run --dry-run-owner "$OWNER" stusdt wrap 0.000001
justlend --json --network nile --dry-run --dry-run-owner "$OWNER" wtrx wrap 1
justlend --json --network nile --dry-run --dry-run-owner "$OWNER" wtrx unwrap 1
justlend --json --network nile --dry-run --dry-run-owner "$OWNER" v1 deposit TRX 0.000001
justlend --json --network nile --dry-run --dry-run-owner "$OWNER" gov exchange 0.000001
```

For real writes, prefer this escalation path:

```bash
# 1. Simulate without signer / broadcast
justlend --network nile --dry-run --dry-run-owner "$OWNER" strx stake 0.000001

# 2. Sign only, no broadcast
justlend --network nile --no-broadcast strx stake 0.000001

# 3. Broadcast intentionally; interactive TTY prompts unless --yes is supplied
justlend --network nile --yes strx stake 0.000001
```

A successful dry-run returns fields such as:

```json
{
  "success": true,
  "data": {
    "mode": "dry-run",
    "status": "success",
    "selector": "d0e30db0",
    "energyUsed": 58112,
    "calldataLen": 8
  }
}
```

## Pre-sign preflight

Real write commands (those that sign + broadcast) run an automatic preflight
**before** the confirmation prompt and before any signing. The transaction is
built, then simulated via `triggerconstantcontract`, and the CLI:

- surfaces any decoded **revert reason** and aborts instead of signing a doomed tx;
- estimates the **energy + bandwidth burn** against live account resources and chain fee rates;
- **blocks** when the estimated fee exceeds `--fee-limit`, or when `callValue + fee` exceeds the signer's TRX balance;
- **warns** (without blocking) on affordable, non-zero burns so you know TRX will be spent.

This does not apply to `--dry-run` (which already simulates and never signs).
Pass `--no-precheck` to skip the preflight — e.g. when chain reads are flaky and
you have already validated the call with `--dry-run`.

```bash
# Default: preflight runs automatically before the confirm prompt
justlend --network nile --yes strx stake 0.000001

# Skip the preflight (you accept the risk of a failed / over-budget broadcast)
justlend --network nile --yes --no-precheck strx stake 0.000001
```

## Signer daemon

`justlend serve` runs the TronLink signer + IPC server so subsequent commands
reuse one wallet session. It writes per-session state under `~/.justlend-cli`
with `0600/0700` permissions (creation aborts if the socket cannot be locked
down). The daemon auto-shuts down after `--idle-timeout` minutes with no IPC
activity (default `10`; `0` disables); a request in flight always defers
shutdown so it never exits mid-signature.

```bash
justlend serve                      # idle auto-shutdown after 10 min
justlend serve --idle-timeout 30    # extend the idle window
justlend serve --idle-timeout 0     # run until stopped (Ctrl+C / SIGTERM)
```

## JSON output contract

Success:

```json
{
  "success": true,
  "data": {}
}
```

Failure:

```json
{
  "success": false,
  "error": "message"
}
```

Failures may include additional diagnostic fields such as `code`, `module`, `network`, `host`, `path`, `status`, and `hint`.

### Error / exit code contract

Branch on the **exit code** first (`0` = success, non-zero = failure), then on the JSON `code` field.

| `code` | Meaning | Retryable | How to handle |
|--------|---------|:---:|---------------|
| `USER_CANCELLED` | Rejected/cancelled in TronLink | ❌ | Re-approve in wallet |
| `SIGNER_TIMEOUT` | TronLink approval timed out | ⚠️ (user must be present) | Retry, approve promptly |
| `SIGNER_DISCONNECTED` | Signer page closed / IPC dropped | ⚠️ after reconnect | Keep the TronLink signer page open, retry |
| `INSUFFICIENT_BALANCE` | Not enough balance | ❌ | Top up |
| `INSUFFICIENT_ALLOWANCE` | TRC20 allowance too low | ❌ | `justlend approve <token>` first |
| `INVALID_ADDRESS` | Malformed TRON address | ❌ | Fix the Base58 address |
| `NETWORK_CONNECTION_FAILED` | Connection failure | ✅ | Exponential backoff |
| `BROADCAST_FAILED` | Tx broadcast rejected | ❌ (write) | Inspect, retry manually — never auto-retry |
| _(HTTP backend error)_ | Carries `status`/`host`/`path`/`hint` | `5xx`/network ✅, `4xx` ❌ | Follow `hint` |

**Retry policy:** only read-only backend calls marked idempotent are auto-retried (2 attempts with
backoff). Signing and broadcast paths are **never** auto-retried (double-submit risk).

## V2 mining rollout note

V2 mining backend APIs are mainnet-only. Nile commands intentionally return a guard error rather than pretending to succeed. Mainnet claim is also blocked until the V2 MerkleDistributor address is deployed/configured. This is a safety decision to avoid blind chain writes.

## Architecture

```text
bin/cli.ts            # entry -> src/index.ts -> Commander program
src/
├── index.ts          # global options + command registration
├── commands/         # command modules
└── lib/              # chains, ABIs, API clients, tx helpers, output, errors
```

Key library modules:

- `src/lib/chains.ts` — network + contract config.
- `src/lib/abis.ts` — contract ABIs.
- `src/lib/api/v1.ts` / `src/lib/api/v2.ts` — backend clients.
- `src/lib/tx.ts` — transaction send / dry-run helpers.
- `src/lib/precheck.ts` — pre-sign balance / energy / revert preflight.
- `src/lib/output.ts` — table / JSON output.
- `src/lib/error.ts` — JSON-mode-aware error handling.
- `src/lib/signer.ts` / `src/lib/ipc.ts` — TronLink signer integration.

## Documentation

- `scripts/nile-dry-run-smoke.sh` — Nile dry-run smoke regression.

## License

MIT License Copyright (c) 2026 JustLend DAO
