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
