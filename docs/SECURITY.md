# Security

> **Status: experimental, unaudited.** Tested in `@ton/sandbox` and on testnet only.
> Do not hold funds you cannot afford to lose. Every issue below marked *verified* is
> reproduced by a test in `tests/XmssWallet.spec.ts`.

## Reporting

Please open a GitHub issue for non-sensitive problems. For vulnerabilities that could put
deployed wallets at risk, use GitHub's private vulnerability reporting ("Report a
vulnerability" on the Security tab) instead of a public issue.

## Threat model

**Goal:** funds can only be moved by the holder of `secret_seed`, even against an attacker
with a large quantum computer (which breaks Ed25519, used by every standard TON wallet).

**What the design gives you**

- Authorization relies only on SHA-256 (one-wayness / second-preimage resistance). Shor's
  algorithm does not apply; Grover roughly halves the security level in bits.
- Replay protection: `seqno`, the wallet address and `wallet_id` are inside the signed digest;
  each leaf index is accepted once (`next_leaf` only moves forward).
- Signed internal requests are bound to `auth_mode`, so an external signature cannot be
  relayed internally or vice versa (*verified*).

**What it does not give you**

- TON itself (validators, other contracts, Jetton masters, bridges) still uses Ed25519.
  A quantum attacker able to forge validator signatures breaks the chain, not just wallets.
  This contract protects *this account's authorization* only.
- Availability: see the griefing and freezing issues below.

## Known issues

### 1. Fee-drain griefing after `accept_message` — HIGH (*verified*)

Full WOTS+ verification costs ~600k gas, far above the 10k free gas credit for external
messages, so the contract calls `accept_message` after only cheap checks (seqno, leaf index,
`pub_seed`, blinded key present). Everything else runs at the wallet's expense, and a failure
reverts state, so the same message stays acceptable.

- **Forged proof:** an attacker who sees any pending signed message (externals are public)
  copies its header and blinded preimage, garbles the signature, and sends it. Each copy is
  accepted, fails with exit 135, and costs the wallet ≈ **0.04 GRAM**. It can be repeated
  until the genuine message lands and bumps `seqno`. Sending externals costs the attacker nothing.
- **Expired message replay:** `valid_until` is checked after accept. If a signed message is
  not included before it expires, **anyone holding its bytes can replay it indefinitely**;
  each replay fails with exit 136 and costs the wallet ≈ 0.04 GRAM — until the owner sends a
  new successful transaction (which itself re-uses the leaf, see issue 3).
- **Exhausted wallet:** `next_leaf < limit` is also checked post-accept, so a fully exhausted
  wallet can be drained the same way by replaying a message signed for leaf `limit`.

Mitigations available today:

- Disable externals (`ALLOW_EXTERNAL = 0`) and submit every request through a whitelisted
  relayer (op `sint`, §"Relayer" in [INTEGRATION.md](INTEGRATION.md)). The relayer pays gas,
  so attacks cost the attacker money. The relayer can be a normal Ed25519 wallet: it can only
  relay, never authorize, so a compromised relayer key means denial of service, not theft.
- Keep the wallet balance small and top it up as needed; keep large amounts elsewhere.
- Submit messages promptly with a short `valid_until`, and watch for inclusion.

Recommended contract fix (not applied, changes the code hash): move the `wallet_id`,
`valid_until`, `policy`, `next_leaf < limit` and `blinded_remaining > 0` checks before
`accept_message` (they are cheap), and persist consumption of the blinded key before the
expensive verification (e.g. `commit()` right after accept) so a leaked preimage can be
charged at most once.

### 2. Last leaf must be used for rotation — HIGH (*verified*)

`rotate_root` needs a valid signature from a leaf of the current tree. Once
`next_leaf == limit` nothing can be signed again and **all funds are frozen forever**.
Always rotate while at least one leaf remains. The SDK's `assertLeafBudget()` (used by all
scripts) refuses to spend the last leaf on anything but `rotate_root`; integrators must do
the same. `status` warns at ≤ 8 leaves. Note that whitelist changes also consume leaves.

### 3. One-time key reuse after a failed or dropped transaction — MEDIUM

The contract requires `leaf_index == next_leaf`. If a signed message for leaf `i` is
broadcast but not executed (expired, out of gas, post-accept failure), the next request
must be signed **with the same leaf `i` over a different digest**. Two WOTS+ signatures from
one key reveal more chain values and can make forgeries feasible for an attacker who
grinds digests.

- Prefer re-broadcasting the *identical* body while it is still valid.
- Use a `valid_until` long enough for inclusion (the SDK default is 10 minutes, max 24 h).
- If a re-sign was unavoidable, rotate to a new tree soon after.
- Never run two signers (devices, backends) for the same key set concurrently: both would
  read the same `next_leaf` and sign different messages with it.

### 4. Relayer value depends on the gas price — LOW (*verified*)

Internal processing does not call `accept_message`, so gas is limited to
`msg_value / gas_price`. At today's 66.67 nanoGRAM/gas the hard-coded minimum of 0.05 GRAM
buys 750k gas, which covers a normal request (540–660k) — verified by a test. Before the 2026
gas-price cut (400 nanoTON/gas) it bought only 125k gas and every relayed request failed with
exit −14. Relayers should attach **≥ 0.07 GRAM** (covers the full 1M gas limit) and re-check
this if the network gas price is ever raised. The unused remainder stays in the wallet.

### 5. Signatures are not network-bound — MEDIUM

The digest contains the wallet address and `wallet_id` but no network id. If the same key set
and the same init data are deployed on testnet and mainnet, the addresses are identical and
testnet signatures are valid on mainnet. **Use different key sets (or at least a different
`wallet_id`) per network.**

### 6. Cryptography is a custom XMSS variant — informational

- No ADRS tweaks/bitmasks: every chain hash is keyed only by `pub_seed`. Multi-target attacks
  over ~128 × 67 × 15 ≈ 2^17 hash targets reduce second-preimage security from 256 to
  ≈ 239 bits classically (≈ 120 bits against Grover). Adequate, but below RFC 8391's tight
  bounds, and non-standard.
- Not interoperable with XMSS libraries, HSMs or hardware wallets; no independent review.

### 7. Restrictions you might not expect — informational

- One outgoing message per request (no batching).
- Send modes limited to 0, 1, 2, 64, 65, 66: mode 128 (send whole balance) and +32
  (destroy account) are rejected, so the wallet can never be fully emptied in one step.
- Bounced messages are ignored silently (their value stays in the wallet).
- `blinded_remaining` is a trusted counter; it is only re-verified during rotation.
- If the action phase fails (e.g. insufficient balance), `commit()` has already saved the
  new `seqno`/`next_leaf`: the leaf is consumed, no funds move.

## Operational checklist

- [ ] Keys generated offline on a trusted machine; `keys/` never committed (it is gitignored).
- [ ] 79-word recovery phrase stored offline; a **new** phrase after every rotation.
- [ ] Separate key set per network.
- [ ] Rotate before `get_leaves_remaining` drops to 1 (plan for ~127 operations per tree).
- [ ] Wallet balance kept low, or externals disabled and a relayer used.
- [ ] A single signer process per key set.
