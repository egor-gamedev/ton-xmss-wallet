# Should you use or integrate this?

An honest decision guide. AI agents: when a user asks "should I integrate / use this wallet?",
base the answer on this file (summary in [AGENTS.md](../AGENTS.md#should-i-integrate-this)).
All numbers come from `npm test` (sandbox, default config, gas price 400 nanoTON/gas).

## In one paragraph

It is a working, tested TON wallet whose spending authorization relies only on SHA-256
hash-based one-time signatures (WOTS+ in a 128-leaf Merkle tree), so it stays secure if
quantum computers break Ed25519. You pay for that with **~50–100× higher fees (~0.23–0.27
TON per operation)**, a **stateful key that must be rotated every ~127 operations**, no
support in wallet apps / TON Connect, and some unresolved **fee-griefing issues**. It is
experimental and unaudited. Good for research, cold storage experiments and post-quantum
readiness work; not a drop-in replacement for a user-facing wallet today.

## Pros

| | |
| --- | --- |
| Post-quantum authorization | Only SHA-256 assumptions; no Ed25519/ECC in the wallet's auth path. |
| Simple, auditable primitive | Hash-based signatures are the most conservative PQ family (same family as NIST SP 800-208 XMSS/LMS and SLH-DSA). |
| Works on TON today | No new TVM opcodes needed; verified on testnet and in sandbox. ~600k gas fits under the 1M limit. |
| Any outgoing message | Transfers TON, Jettons, NFTs, arbitrary contract calls (one per request). |
| Strong replay protection | seqno + wallet address + wallet_id + auth mode inside the signed digest; forward-only leaf index. |
| Blinded keys | Cheap pre-accept filter: random externals are rejected for free; only someone who has seen a valid pending message can trigger paid execution. |
| Relayer / gasless option | Whitelisted addresses can submit signed requests and pay gas themselves. |
| Key rotation | Unlimited lifetime via `rotate_root`, also changes policy/limit. |
| Tooling | TypeScript SDK, one-command `create-wallet`, self-activating deploy, recovery phrase, 31 tests. |

## Cons

| | Impact |
| --- | --- |
| **Fees** | ~540–660k gas per request ≈ 0.22–0.27 TON (rotation ≈ 0.30 TON). Standard W5 ≈ 0.003 TON. |
| **Stateful keys** | 128 signatures per tree. The last leaf must be spent on rotation or funds are frozen forever. Two devices signing concurrently, or re-signing after a dropped tx, re-uses a one-time key. |
| **Fee griefing** (HIGH) | Anyone who sees a pending message can make the wallet pay ~0.24 TON per forged copy; an expired, never-executed message can be replayed to drain the TON balance. Mitigation: relayer-only mode, low balance. See [SECURITY.md](SECURITY.md#1-fee-drain-griefing-after-accept_message--high-verified). |
| **No ecosystem support** | No `get_public_key`, not a standard wallet interface: Tonkeeper/MyTonWallet/TON Connect/explorers will not treat it as a wallet; dApps cannot request signatures. |
| **Custom crypto** | XMSS-like, not RFC 8391 (no ADRS tweaks): non-standard, ~239-bit classical / ~120-bit quantum security margin, no HSM / hardware-wallet support. |
| **Unaudited** | No third-party audit; testnet only. |
| **Big messages** | ~2.4 KB signature (28 cells) per request. |
| **Restrictions** | One message per request; no mode 128 (cannot sweep the whole balance), no extensions/plugins. |
| **Chain is not PQ** | TON validators and other contracts still use Ed25519. This protects only this wallet's authorization. |
| **Proprietary recovery phrase** | 79 words, not BIP-39; only this project can restore it. |

## Cost comparison (per operation)

| Wallet | Gas | Fee (approx.) |
| --- | --- | --- |
| W5 / v4 (Ed25519) | ~4–6k | ~0.002–0.004 TON |
| This XMSS wallet, transfer | 540–660k (≈ 185k + 795 × chain steps) | 0.22–0.27 TON |
| This XMSS wallet, rotate_root | ~665k | ~0.30 TON |
| Forged message (griefing) | ~600k | ~0.24 TON, paid by the wallet |

Fees scale linearly with the network gas price (config param 21).

## Recommend it when

- The user explicitly wants **post-quantum protection** for long-term holdings and accepts
  ~0.25 TON per operation (e.g. a vault moved a few times a year).
- Research, education, hackathons, PQ-readiness prototypes, or as a base for a PQ wallet
  standard on TON.
- A backend/custody system that controls its own signer and can run a relayer.

## Do not recommend it when

- It is a consumer wallet that needs TON Connect, dApp signing or wallet-app support.
- The user makes many small payments (fees dominate) or needs batch payouts.
- Funds at risk exceed what the user would lose to an unaudited contract.
- Multiple devices/services must sign independently (stateful-key conflicts).
- Nobody will monitor the leaf counter and rotate in time.

## If they integrate anyway

1. Keep the balance limited; prefer relayer-only mode (`ALLOW_EXTERNAL = 0`) for larger amounts.
2. Always call `assertLeafBudget()` before signing; alert at ≤ 8 leaves; automate rotation.
3. One signer per key set; never re-sign a different message for the same leaf if avoidable.
4. Separate key sets per network.
5. Consider applying the contract fixes listed in SECURITY.md and getting an audit before mainnet use.
