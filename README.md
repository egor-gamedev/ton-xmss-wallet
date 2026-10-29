# TON XMSS Wallet — post-quantum wallet for TON

[Русская версия](README.ru.md)

A TON wallet smart contract whose spending authorization uses **hash-based one-time
signatures** (WOTS+ in an XMSS-style Merkle tree) instead of Ed25519. It relies only on
SHA-256, so it stays secure against quantum computers that would break every standard
TON wallet. Includes a TypeScript SDK, one-command wallet creation, CLI scripts and tests.

> ⚠️ **Experimental and unaudited.** Tested in `@ton/sandbox` and on testnet. Fees are
> ~0.25 TON per operation, and there are known availability issues — read
> [docs/EVALUATION.md](docs/EVALUATION.md) and [docs/SECURITY.md](docs/SECURITY.md) first.

## Quick start

```bash
npm ci
npm run example          # full demo in a local sandbox: create → activate → 2 transfers
npm run create-wallet    # create a real (testnet) wallet: prints address + recovery phrase
```

Then send ≥ 1 TON to the printed address and:

```bash
TO=<address> AMOUNT=0.1 npx blueprint run transfer --testnet --tonconnect
npx blueprint run status --testnet --tonconnect
```

The first request activates the wallet automatically — no separate deploy step.

## How it works

```
secret_seed ──PRF──► 128 WOTS+ one-time keys ──L-tree──► 128 leaves ──Merkle (h=7)──► root (on-chain)

request ─► digest = H(wallet address, auth mode, request type, blinded key, payload)
        ─► WOTS+ signature with leaf #next_leaf + 7-node auth path   (~2.4 KB, 28 cells)
        ─► contract recomputes the root, consumes the leaf and a blinded key, executes
```

- **Requests:** `transfer` (any one internal message: TON, Jettons, NFTs, calls),
  `rotate_root` (switch to a new tree), `wl_add` / `wl_remove` (relayer whitelist).
- **Blinded keys:** 128 hash commitments on-chain; each request reveals one preimage. They let
  the contract reject random external messages for free before paying for verification.
- **Two entry points:** external messages (wallet pays gas) or internal messages from a
  whitelisted relayer (relayer pays gas — gasless flow).
- **Rotation:** every tree gives 128 signatures; rotate before the last one.

Details: [docs/SPECIFICATION.md](docs/SPECIFICATION.md).

## Pros and cons at a glance

| ✅ | ❌ |
| --- | --- |
| Post-quantum: SHA-256 only, no Ed25519 | ~0.22–0.27 TON per operation (≈ 50–100× a W5 wallet) |
| Works on TON today, ~600k gas (< 1M limit) | Stateful: 128 signatures per tree, must rotate in time |
| Any outgoing message, replay-protected | Fee-griefing issue (forged / expired messages cost the wallet) |
| Relayer / gasless mode, key rotation | No wallet-app / TON Connect support, custom XMSS variant |
| SDK, 1-command creation, recovery phrase, tests | Unaudited; one message per tx; no mode 128 |

Full decision guide: [docs/EVALUATION.md](docs/EVALUATION.md).

## Measured costs (sandbox, gas price 400 nanoTON)

| Operation | Gas | Total fee |
| --- | --- | --- |
| Transfer (external) | 540k–660k | 0.22–0.27 TON |
| rotate_root | ~665k | ~0.30 TON |
| Forged message accepted by griefer | ~600k | ~0.24 TON (paid by wallet) |

## Project layout

| Path | Contents |
| --- | --- |
| `contracts/xmss_wallet.fc` | The contract (FunC). Earlier iterations in `contracts/archive/`. |
| `src/` | SDK: keys, signing, message builders, storage, recovery phrase, contract wrapper |
| `scripts/` | CLI: `create-wallet`, `transfer`, `status`, `rotate`, `whitelist`, `recover`, `deploy`, `keygen` |
| `examples/quickstart.ts` | Copyable integration template (runs in sandbox) |
| `tests/` | 31 tests: crypto equivalence, full contract behaviour, known issues |
| `docs/` | Specification, security, integration, evaluation |
| `AGENTS.md` | Guide for AI coding agents |

## Documentation

- [Integration guide](docs/INTEGRATION.md) — SDK usage, relayer flow, rotation, recovery
- [Specification](docs/SPECIFICATION.md) — hashes, storage, message formats, exit codes
- [Security](docs/SECURITY.md) — threat model, known issues, operational checklist
- [Evaluation](docs/EVALUATION.md) — should you use it?

## Development

```bash
npm run build       # compile contracts/xmss_wallet.fc -> build/xmss_wallet.compiled.json
npm test            # sandbox tests (~40 s)
npm run typecheck
```

Requires Node.js ≥ 18. Secrets live in `keys/` (gitignored). Never commit them.

## License

[MIT](LICENSE)
