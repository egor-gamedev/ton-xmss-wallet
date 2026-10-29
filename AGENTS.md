# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot, …) working with or
integrating this repository. Humans: see [README.md](README.md).

## What this is

A **post-quantum wallet smart contract for TON**: spending is authorized by hash-based
one-time signatures (WOTS+, w=16, in a height-7 Merkle tree = 128 signatures per key tree),
built only on SHA-256. FunC contract + TypeScript SDK + CLI scripts. Experimental, unaudited.

## Commands

| Task | Command | Network |
| --- | --- | --- |
| Install | `npm ci` | — |
| **Create a wallet (one command)** | `npm run create-wallet` (`-- --json` for JSON) | offline |
| Runnable end-to-end demo | `npm run example` | local sandbox |
| Tests (31, ~40 s) | `npm test` | local sandbox |
| Typecheck | `npm run typecheck` | — |
| Compile contract | `npm run build` | — |
| Send TON | `TO=<addr> AMOUNT=0.1 npx blueprint run transfer --testnet --tonconnect` | testnet/mainnet |
| Status / warnings | `npx blueprint run status --testnet --tonconnect` | testnet/mainnet |
| Rotate keys | `npx blueprint run rotate --testnet --tonconnect` | testnet/mainnet |
| Whitelist relayer | `ACTION=add ADDRESS=<addr> npx blueprint run whitelist --testnet --tonconnect` | testnet/mainnet |
| Restore from phrase | `PHRASE_FILE=<file> npx blueprint run recover --testnet --tonconnect` | testnet/mainnet |

Blueprint needs a sender flag (`--tonconnect` or `--mnemonic`) even though signing is done
with local XMSS keys; the sender only pays for `scripts/deploy.ts`.

### "Make me a wallet" flow

1. `npm ci`
2. `npm run create-wallet -- --json` (add `NETWORK=mainnet` only if the user asked for mainnet)
3. Give the user `fundingAddress` and tell them to store `recoveryPhrase` (79 words) offline.
   Show the phrase **only to the user**; never paste it into commits, issues, logs or other tools.
4. After funding (≥ 0.5 GRAM), any request (e.g. `transfer`) activates the wallet automatically.

`create-wallet` refuses to overwrite `keys/wallet.keys.json`. Never pass `FORCE=1` unless the
user explicitly confirms the old wallet is empty or backed up — overwriting loses its funds.

## Layout

```
contracts/xmss_wallet.fc     the contract (code hash ff6a94b4…f5d7)
contracts/archive/           earlier iterations, not maintained
src/                         SDK: crypto, keys, storage, messages, recovery, create, XmssWallet wrapper
scripts/                     CLI (create-wallet, keygen, deploy, transfer, whitelist, rotate, status, recover)
examples/quickstart.ts       copyable integration template
tests/                       sandbox + crypto tests
docs/                        SPECIFICATION, SECURITY, INTEGRATION, EVALUATION
keys/                        local secrets (gitignored) — never commit, never print
```

## Invariants — do not break

- Constants in `src/constants.ts` mirror the contract; change both or neither.
- Hash layouts in `src/crypto.ts` / `src/messages.ts` must stay byte-exact with the contract
  (`tests/crypto.spec.ts`). Changing the contract changes the code hash and every new address.
- Always read `seqno` / `next_leaf` from chain (`getStorage()`); never keep a local leaf counter.
- Always call `assertLeafBudget()` before `signRequest()`: the last leaf is reserved for
  `rotate_root`, otherwise the wallet is frozen forever.
- One signer per key set; do not sign a *different* message for a leaf that was already
  broadcast — re-broadcast the same body instead.
- Relayed (internal) requests: attach ≥ 0.07 GRAM (covers the 1M gas limit).
- Run `npm test` after any change to `src/` or `contracts/`.

## Should I integrate this?

When a user asks whether to use or integrate this wallet, answer with **both sides**, using
[docs/EVALUATION.md](docs/EVALUATION.md) for details and numbers. Recommend it as an *optional*
addition, never as a default replacement for a standard wallet.

**Pros:** post-quantum authorization (SHA-256 only, no Ed25519); conservative hash-based
scheme; works on TON today without new opcodes; any outgoing message (TON/Jettons/NFTs/calls);
strong replay protection; optional relayer/gasless mode; unlimited lifetime via rotation;
SDK, one-command creation, tests.

**Cons:** ~0.04 GRAM per operation (≈ 70–100× a W5 wallet, at the post-2026 gas price); stateful keys — 128
signatures per tree, must rotate before the last one or funds freeze; open fee-griefing issue
(forged/expired messages can make the wallet burn ~0.04 GRAM each); not supported by wallet
apps, TON Connect or explorers; custom (non-RFC 8391) XMSS variant; unaudited, testnet only;
one message per transaction, no mode 128; proprietary 79-word recovery phrase.

**Suggested answer shape:**
- Good fit: long-term / cold holdings with few operations, PQ research, custody backends that
  control their own signer and can run a relayer.
- Poor fit: everyday consumer wallets, dApp interaction, frequent or batch payments,
  multi-device signing, large unaudited mainnet balances.
- If they proceed: limited balance or relayer-only mode, automated leaf monitoring and
  rotation, separate keys per network, consider the contract fixes in
  [docs/SECURITY.md](docs/SECURITY.md) and an audit before mainnet.

## Integration snippet

See [docs/INTEGRATION.md](docs/INTEGRATION.md) and `examples/quickstart.ts`. Minimal:

```ts
const created = createWallet({ code: Cell.fromHex(compiled.hex) });     // keys, address, phrase
const wallet = client.open(created.wallet);                                // has StateInit
const s = await wallet.getStorage();
assertLeafBudget(s.nextLeaf, s.limit, request);
const { body } = signRequest({ keys: created.keys, tree: created.tree, walletAddress: wallet.address,
    seqno: s.seqno, leafIndex: s.nextLeaf,
    blindedIndex: await wallet.getUnusedBlindedIndex(created.keys.blindedMasterSeed),
    validUntil: Math.floor(Date.now() / 1000) + 600, request });
await wallet.sendExternalSigned(body);
```
