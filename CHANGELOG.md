# Changelog

## 0.1.0

- XMSS / WOTS+ wallet contract (storage v2, proof v1), code hash `ff6a94b4…f5d7`.
- TypeScript SDK: key generation, signing, message builders, storage parser, recovery phrase.
- One-command `create-wallet` with self-activation on the first request.
- CLI scripts: transfer, status, rotate, whitelist, recover, deploy, keygen.
- 31 sandbox tests, including reproductions of the known issues in docs/SECURITY.md.

## 0.1.1

- Fees updated for the 2026 network changes: basechain gas price cut 6× (400 → 66.67
  nano per gas unit) and Toncoin renamed to Gram (GRAM, 1:1). A transfer now costs
  ~0.04 GRAM (measured 0.0386 GRAM on mainnet) instead of ~0.25 TON.
- Tests and the example run with the current mainnet fee params (`tests/network-config.ts`).
- The 0.05 GRAM relayer minimum now covers verification gas; recommended value 0.07 GRAM.

## 0.2.0: contract fix (storage v3, new code hash `4f6ce7be…38ac`)

- Fee-drain fix: wallet_id, valid_until, policy, request type and the leaf / blinded-key
  budget are checked before `accept_message` (≈ 7k of the 10k free gas). Expired messages can
  no longer be replayed at the wallet's expense.
- Every accepted attempt is burned and committed (seqno, leaf, blinded key) before the
  expensive WOTS+ verification: a forged or failing message is charged once and never again,
  and a leaf that signed a failed message is never reused.
- The last leaf / blinded key is reserved on-chain for `rotate_root` (exit 162); rotation
  requires `new_limit ≥ 2` and enough blinded keys. A forged last-leaf rotation locks
  externals until it expires (exit 161, `get_external_lock_until`) instead of burning the leaf.
- `_require` replaced by `throw_unless` (≈ 50 gas saved per check).
- SDK: storage v3 (still reads v2), `assertExternalsUnlocked`, budget check includes blinded keys.
- The first published contract is kept in `contracts/archive/xmss_wallet_v4_storage_v2.fc`.
