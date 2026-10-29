# Security

> Status: experimental, unaudited. Tested in `@ton/sandbox` and on testnet only.
> Do not hold funds you cannot afford to lose. Every issue below marked verified is
> reproduced by a test in `tests/XmssWallet.spec.ts`.

## Reporting

Please open a GitHub issue for non-sensitive problems. For vulnerabilities that could put
deployed wallets at risk, use GitHub's private vulnerability reporting ("Report a
vulnerability" on the Security tab) instead of a public issue.

## Threat model

Goal: funds can only be moved by the holder of `secret_seed`, even against an attacker
with a large quantum computer (which breaks Ed25519, used by every standard TON wallet).

What the design gives you

- Authorization relies only on SHA-256 (one-wayness / second-preimage resistance). Shor's
  algorithm does not apply; Grover roughly halves the security level in bits.
- Replay protection: `seqno`, the wallet address and `wallet_id` are inside the signed digest;
  each leaf index is accepted once (`next_leaf` only moves forward).
- Signed internal requests are bound to `auth_mode`, so an external signature cannot be
  relayed internally or vice versa (*verified*).

What it does not give you

- TON itself (validators, other contracts, Jetton masters, bridges) still uses Ed25519.
  A quantum attacker able to forge validator signatures breaks the chain, not just wallets.
  This contract protects *this account's authorization* only.
- Availability: see the residual griefing issue below.

> Wallets created with the first published contract (storage v2, code hash `ff6a94b4…f5d7`,
> `contracts/archive/xmss_wallet_v4_storage_v2.fc`) still have the original, more severe
> versions of issues 1–3 (unbounded fee drain by replaying expired messages, possible permanent
> freeze). There is no in-place upgrade: move funds to a new wallet created with the current
> contract.

## Fixed in the current contract (storage v3)

All verified by tests in the `griefing protection` and `key rotation` groups.

- Expired / wrong-network-id / wrong-policy messages are rejected *before*
  `accept_message`, so replaying them costs the wallet nothing. Previously an expired message
  could be replayed forever, each replay paid by the wallet.
- Every accepted attempt is burned before verification. Right after `accept_message` the
  contract commits `seqno + 1`, `next_leaf + 1` and the consumed blinded key, then verifies.
  A forged or otherwise failing message is charged once, can never be replayed, and its
  leaf is retired (so no one-time key is ever asked to sign a second digest after a failure).
  This also covers out-of-gas during verification.
- No permanent freeze. The contract itself refuses (for free, exit 162) to spend the last
  leaf or the last blinded key on anything except `rotate_root`, and a rotation must install
  a tree with at least two leaves. A forged message on that last leaf does not burn it;
  instead externals are locked until the forged message's `valid_until`, after which the
  leaked header is expired. The relayer (internal) path is not locked.

## Known issues

### 1. One-shot griefing of pending messages (medium, verified)

Full WOTS+ verification costs ~550–650k gas, far above the 10k free gas credit for external
messages, so it must run after `accept_message`. Anyone who sees a pending signed message
(externals are public, and so are relayed bodies inside the relayer's own message) can copy
its header, garble the signature and get it in first. Effects, per observed message:

- the wallet pays one verification: ≈ 0.04 GRAM (up to ≈ 0.067 GRAM if the attacker also
  rewrites the payload to grind the most expensive digest, bounded by the 1M gas limit);
- the genuine message becomes invalid (its seqno/leaf/blinded key were burned) and the owner
  must sign a new request;
- one leaf is burned, so a persistent attacker forces earlier rotations.

The attacker gains nothing and cannot steal funds, but can deny service to externals. When
the burnable budget is down to the reserved last leaf, a forged rotation locks externals for
at most the message's validity window instead of burning it.

Mitigations: use the relayer path for important operations (a failure there costs the
relayer, not the wallet, and bounces), keep `valid_until` short so stale headers die fast,
rotate early (≤ 8 leaves left), keep the wallet balance moderate. A deployment can also be
compiled with `ALLOW_EXTERNAL = 0` (new code hash / address) to accept relayed requests only.

### 2. One-time key reuse after a dropped message (low)

If a signed message is broadcast but never accepted on-chain (dropped by the network or
expired before inclusion), the state does not change and the next request must be signed
with the same leaf over a different digest. Its first signature may have been observed in
transit, and two WOTS+ signatures from one key make forgeries easier.

- Prefer re-broadcasting the *identical* body while it is still valid.
- Use a `valid_until` long enough for inclusion (the SDK default is 10 minutes, max 24 h).
- If a re-sign after a dropped message was unavoidable, rotate to a new tree soon after.
- Never run two signers (devices, backends) for the same key set concurrently: both would
  read the same `next_leaf` and sign different messages with it.

The same applies to the last-leaf rotation after a lock (above): the rotation is re-signed
with the same, final leaf; rotate to the new tree immediately.

### 3. Relayer value depends on the gas price (low, verified)

Internal processing does not call `accept_message`, so gas is limited to
`msg_value / gas_price`. At today's 66.67 nanoGRAM/gas the hard-coded minimum of 0.05 GRAM
buys 750k gas, which covers a normal request (540–660k), verified by a test. Before the 2026
gas-price cut (400 nanoTON/gas) it bought only 125k gas and every relayed request failed with
exit −14. Relayers should attach ≥ 0.07 GRAM (covers the full 1M gas limit) and re-check
this if the network gas price is ever raised. The unused remainder stays in the wallet.

### 4. Signatures are not network-bound (medium)

The digest contains the wallet address and `wallet_id` but no network id. If the same key set
and the same init data are deployed on testnet and mainnet, the addresses are identical and
testnet signatures are valid on mainnet. Use different key sets (or at least a different
`wallet_id`) per network.

### 5. Cryptography is a custom XMSS variant (informational)

- No ADRS tweaks/bitmasks: every chain hash is keyed only by `pub_seed`. Multi-target attacks
  over ~128 × 67 × 15 ≈ 2^17 hash targets reduce second-preimage security from 256 to
  ≈ 239 bits classically (≈ 120 bits against Grover). Adequate, but below RFC 8391's tight
  bounds, and non-standard.
- Not interoperable with XMSS libraries, HSMs or hardware wallets; no independent review.

### 6. Restrictions you might not expect (informational)

- One outgoing message per request (no batching).
- Send modes limited to 0, 1, 2, 64, 65, 66: mode 128 (send whole balance) and +32
  (destroy account) are rejected, so the wallet can never be fully emptied in one step.
- Bounced messages are ignored silently (their value stays in the wallet).
- `blinded_remaining` is a trusted counter; it is only re-verified during rotation.
- If the action phase fails (e.g. insufficient balance), `commit()` has already saved the
  new `seqno`/`next_leaf`: the leaf is consumed, no funds move.

## Operational checklist

- [ ] Keys generated offline on a trusted machine; `keys/` never committed (it is gitignored).
- [ ] 79-word recovery phrase stored offline; a new phrase after every rotation.
- [ ] Separate key set per network.
- [ ] Rotate at ≤ 8 leaves left (plan for ~127 operations per tree; the last leaf is reserved).
- [ ] Important operations sent through a relayer, or with a short `valid_until`.
- [ ] A single signer process per key set.
