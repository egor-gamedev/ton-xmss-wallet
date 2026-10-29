# Specification

Byte-level description of `contracts/xmss_wallet.fc` (storage version 2, proof version 1).
The TypeScript SDK in `src/` implements exactly this; `tests/crypto.spec.ts` checks the SDK
hashes against `@ton/core` cell hashes.

Compiled code hash: `ff6a94b4e2174005bbf87215a9f7d9b69b284b4bc6cca30327ee9f5f1887f5d7`
(FunC 0.4.4 via `@ton-community/func-js-bin@0.4.5-tvmbeta.3`).

## 1. Cryptographic scheme

A single-tree XMSS-style construction built from TVM `cell_hash` (SHA-256 of the cell
representation). It is **inspired by RFC 8391 but not compatible with it** (see §1.4).

| Parameter | Value |
| --- | --- |
| Hash output `n` | 256 bit |
| Winternitz `w` | 16 (4 bits per digit) |
| `len1` / `len2` / `len` | 64 / 3 / 67 |
| Tree height `h` | 7 → 128 one-time keys (leaves) per tree |
| Signature size | 67 WOTS+ elements + 7 auth-path nodes = 74 × 32 B ≈ 2.4 KB |

### 1.1 Hash functions

Every hash is `cell_hash` of one ordinary cell with no refs. For a byte-aligned payload of
`N` bytes that equals `SHA-256(0x00 ‖ 2N ‖ payload)`.

| Name | Cell contents | Where |
| --- | --- | --- |
| `PRF(seed, idx, i)` | `"WOTF":u32 ‖ secret_seed:u256 ‖ idx:u64 ‖ i:u8` | off-chain only |
| `F(x)` chain step | `"WOCH":u32 ‖ pub_seed:u256 ‖ x:u256` | WOTS+ chains |
| `H_l(a, b)` | `"LTRE":u32 ‖ a:u256 ‖ b:u256` | L-tree |
| `H_m(a, b)` | `"MRTL":u32 ‖ a:u256 ‖ b:u256` | Merkle tree |
| `commit(p)` | `"BLND":u32 ‖ preimage:u256` | blinded-key commitment |
| `wl_key(addr)` | `"WLIT":u32 ‖ wc:i8 ‖ addr_hash:u256` | whitelist dictionary key |
| `M` (signed digest) | `"XMSG":u32 ‖ H(my_address):u256 ‖ auth_mode:u8 ‖ req_type:u8 ‖ commit(preimage):u256 ‖ H(payload):u256` | message hash |

`H(my_address)` is the hash of a cell containing the 267-bit `MsgAddressInt` of the wallet.
`H(payload)` is the representation hash of the payload cell (§3).

### 1.2 WOTS+

- Secret element `sk[i] = PRF(secret_seed, leaf, i)`, public element `pk[i] = F^15(sk[i])`.
- Digits: the 64 nibbles of `M` (most significant first), then checksum
  `c = 960 − Σ digits` as 3 nibbles (most significant first).
- Signature `sig[i] = F^{d_i}(sk[i])`. Verifier computes `pk[i] = F^{15−d_i}(sig[i])`.

### 1.3 L-tree and Merkle tree

- L-tree: repeatedly hash adjacent pairs with `H_l`; an odd last node is carried up unchanged.
  The result is the leaf.
- Merkle: `parent = H_m(left, right)`. On verification, at height `j` the node is
  `H_m(sib, node)` if bit `j` of the leaf index is 1, else `H_m(node, sib)`.

### 1.4 Differences from RFC 8391 XMSS

- No per-hash address (ADRS) tweak and no bitmasks: the chain function is keyed only by
  `pub_seed`, not by leaf / chain / position.
- No randomized message hashing (`r`); the digest `M` is deterministic.
- One tree only (no hyper-tree / XMSS^MT), height fixed at 7.

Consequence: not interoperable with standard XMSS libraries/HSMs, and multi-target attacks
apply (see [SECURITY.md](SECURITY.md#cryptography)).

## 2. Storage (version 2)

```
uint8   version = 2
uint32  seqno
uint32  wallet_id
uint256 policy              opaque value every request must repeat
uint256 root                Merkle root of the current tree
uint256 pub_seed
uint32  limit               usable leaves, 1..128
uint32  next_leaf           index the next signature must use
uint32  blinded_remaining   counter, kept in sync by the contract
^Cell   [ HashmapE 256 ]    whitelist       key = wl_key(addr), value ignored
^Cell   [ HashmapE 256 ]    blinded keys    key = commit(preimage), value ignored
```

Invariants checked on every load: `next_leaf ≤ limit ≤ 128`, no extra bits, exactly 2 refs.

## 3. Messages

### 3.1 Body

```
op:uint32  ^proof  ^payload
op = 0x7369676E ("sign")  external, auth_mode = 1
op = 0x73696E74 ("sint")  internal from a whitelisted address, auth_mode = 2
```

### 3.2 Payload

```
uint32  wallet_id
uint32  valid_until         now < valid_until ≤ now + 86400
uint32  seqno
uint256 policy
uint8   req_type
uint256 blinded_preimage    must be present in the blinded dict; consumed on success
...     request-specific tail
```

| `req_type` | Tail | Effect (each consumes 1 leaf + 1 blinded key, seqno += 1) |
| --- | --- | --- |
| `0x00` transfer | `mode:uint8 ^out_msg` | `send_raw_message(out_msg, mode)`, mode ∈ {0,1,2,64,65,66} |
| `0x01` rotate_root | `^[ new_root:u256 new_pub_seed:u256 new_limit:u32 new_policy:u256 new_blinded_count:u32 ^[HashmapE 256] ]` | replaces root / seed / policy / limit / blinded dict; `next_leaf = 0`. `new_blinded_count` must equal the dict size, `1 ≤ new_limit ≤ 128` |
| `0x02` wl_add | `^[MsgAddressInt]` | adds address to whitelist |
| `0x03` wl_remove | `^[MsgAddressInt]` | removes address from whitelist |

`out_msg` is any serialized `MessageRelaxed` (internal), so TON transfers, Jetton/NFT
transfers and arbitrary contract calls are possible — one per request.

### 3.3 Proof

```
cell 0: version:u8 = 1 | leaf_index:u64 | pub_seed:u256 | w0:u256 | w1:u256 | ^cell 1
cell k: w:u256 × 3 | ^cell k+1        (last cell has no ref)
words = sig[0..66] ‖ auth_path[0..6]  (74 words, 26 cells after the header)
```

The parser accepts a 256-bit word from the current cell or, when the current cell has no
bits left, from its single ref. Leftover bits/refs after the last word are rejected.

## 4. Processing

### recv_external (op `sign`)

Before `accept_message` (must fit the 10 000 gas credit):
1. parse body and storage
2. `seqno_in == seqno`
3. proof header: version, `leaf_index == next_leaf`, `pub_seed` match
4. `commit(blinded_preimage)` present in blinded dict

After `accept_message` (paid from the wallet balance) — `handle_request`:
5. `wallet_id`, `valid_until`, `policy`; `next_leaf < limit`; `blinded_remaining > 0`
6. full WOTS+ + Merkle verification against `root`
7. execute request, save storage, `commit()`

### recv_internal

- Bounced messages and bodies without op `sint` are accepted silently (top-ups).
- `msg_value ≥ 0.05 TON` (but see SECURITY.md: real gas needs ≈ 0.25–0.4 TON),
  sender must be whitelisted, blinded key present, then `handle_request` with `auth_mode = 2`.
  No `accept_message`: gas is bounded by `msg_value / gas_price`.

## 5. Get methods

| Method | Returns |
| --- | --- |
| `seqno` | int |
| `get_wallet_id` | int |
| `get_policy_hash` | int (uint256) |
| `get_root` | int (uint256) |
| `get_public_seed` | int (uint256) |
| `get_leaf_limit` | int |
| `get_next_leaf` | int |
| `get_leaves_remaining` | `limit − next_leaf` |
| `get_tree_height` | 7 |
| `get_blinded_keys_remaining` | int |
| `is_whitelisted(slice addr)` | −1 / 0 |

There is no `get_public_key` and no TON wallet-standard interface.

## 6. Exit codes

| Code | Name | Raised |
| --- | --- | --- |
| 133 | invalid_seqno | pre-accept |
| 134 | invalid_wallet_id | post-accept |
| 135 | invalid_signature | pre-accept (pub_seed) / post-accept (WOTS+, Merkle) |
| 136 | expired | post-accept |
| 138 | invalid_op | parsing |
| 148 | policy_mismatch | post-accept |
| 151 | invalid_leaf_index | pre-accept |
| 153 | wallet_exhausted | post-accept (`next_leaf == limit`, or bad `new_limit`) |
| 154 | invalid_proof_format | proof parsing |
| 156 | bad_storage | storage parsing |
| 157 | bad_mode | send mode not allowed |
| 158 | not_whitelisted | internal from unknown sender |
| 159 | insufficient_value | internal with < 0.05 TON |
| 160 | invalid_blinded_key | unknown/consumed blinded key, or bad rotate count |

## 7. Off-chain key derivation (SDK convention)

- `secret_seed`, `pub_seed`, `blinded_master_seed`: 32 random bytes each.
- Blinded preimage `i`: `SHA-256("BLND" ‖ blinded_master_seed ‖ i as u64 little-endian)`;
  128 commitments are stored at deployment / rotation.
- Default policy: `cell_hash` of the UTF-8 string `{"role":"user","walletId":<id>}`.
- Recovery phrase: see `src/recovery.ts` (79 BIP-39 English words, custom format, **not BIP-39**).
