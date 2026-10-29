// Contract storage (version 2) layout — see docs/SPECIFICATION.md.
//
//   uint8   version = 2
//   uint32  seqno
//   uint32  wallet_id
//   uint256 policy
//   uint256 root
//   uint256 pub_seed
//   uint32  limit              (<= 128)
//   uint32  next_leaf
//   uint32  blinded_remaining
//   ^[ HashmapE 256 ]  whitelist      key = H(WLIT || wc:int8 || addr_hash:uint256)
//   ^[ HashmapE 256 ]  blinded keys   key = H(BLND || preimage)

import { Address, beginCell, Builder, Cell, Dictionary, DictionaryValue, Slice } from '@ton/core';
import { bigintToBytes, cellHashBytes } from './crypto';
import { STORAGE_VERSION, TAG, TREE_MAX_LEAVES } from './constants';

/** Presence-only dictionary value: stored as an empty inline slice (same as the contract's wl_set). */
const PresenceValue: DictionaryValue<true> = {
    serialize: (_v: true, _b: Builder) => {},
    parse: (_s: Slice) => true
};

export type KeyDict = Dictionary<bigint, true>;

export function emptyKeyDict(): KeyDict {
    return Dictionary.empty(Dictionary.Keys.BigUint(256), PresenceValue);
}

export function keyDictFrom(keys: bigint[]): KeyDict {
    const d = emptyKeyDict();
    for (const k of keys) d.set(k, true);
    return d;
}

/** Whitelist dictionary key for an address. Matches wl_key(). */
export function whitelistKey(addr: Address): bigint {
    const wc = addr.workChain & 0xff;
    return cellHashBytes(
        Buffer.concat([
            bigintToBytes(BigInt(TAG.WL_KEY), 4),
            Buffer.from([wc]),
            Buffer.from(addr.hash)
        ])
    );
}

export type XmssWalletStorage = {
    seqno: number;
    walletId: number;
    policy: bigint;
    root: bigint;
    publicSeed: bigint;
    limit: number;
    nextLeaf: number;
    blindedRemaining: number;
    whitelist: KeyDict;
    blindedKeys: KeyDict;
};

export function storeKeyDictBox(d: KeyDict): Cell {
    return beginCell()
        .storeDict(d.size > 0 ? d : null)
        .endCell();
}

export function buildStorage(s: XmssWalletStorage): Cell {
    return beginCell()
        .storeUint(STORAGE_VERSION, 8)
        .storeUint(s.seqno, 32)
        .storeUint(s.walletId, 32)
        .storeUint(s.policy, 256)
        .storeUint(s.root, 256)
        .storeUint(s.publicSeed, 256)
        .storeUint(s.limit, 32)
        .storeUint(s.nextLeaf, 32)
        .storeUint(s.blindedRemaining, 32)
        .storeRef(storeKeyDictBox(s.whitelist))
        .storeRef(storeKeyDictBox(s.blindedKeys))
        .endCell();
}

export type InitialStorageParams = {
    walletId: number;
    policy: bigint;
    root: bigint;
    publicSeed: bigint;
    /** Blinded-key commitments, H(BLND || preimage). Usually blindedCommitments(seed, 128). */
    blindedCommitments: bigint[];
    /** Addresses allowed to relay signed internal requests (gasless / relayer flow). */
    whitelist?: Address[];
    /** Number of usable leaves, 1..128. Default 128. */
    limit?: number;
};

export function buildInitialStorage(p: InitialStorageParams): Cell {
    const limit = p.limit ?? TREE_MAX_LEAVES;
    if (limit < 1 || limit > TREE_MAX_LEAVES) throw new Error('limit must be 1..128');
    if (p.blindedCommitments.length === 0) throw new Error('at least one blinded key is required');
    return buildStorage({
        seqno: 0,
        walletId: p.walletId,
        policy: p.policy,
        root: p.root,
        publicSeed: p.publicSeed,
        limit,
        nextLeaf: 0,
        blindedRemaining: p.blindedCommitments.length,
        whitelist: keyDictFrom((p.whitelist ?? []).map(whitelistKey)),
        blindedKeys: keyDictFrom(p.blindedCommitments)
    });
}

function loadKeyDictBox(c: Cell): KeyDict {
    const s = c.beginParse();
    const d = s.loadDict(Dictionary.Keys.BigUint(256), PresenceValue);
    s.endParse();
    return d;
}

export function parseStorage(data: Cell): XmssWalletStorage {
    const s = data.beginParse();
    const version = s.loadUint(8);
    if (version !== STORAGE_VERSION) throw new Error(`unsupported storage version ${version}`);
    const out: XmssWalletStorage = {
        seqno: s.loadUint(32),
        walletId: s.loadUint(32),
        policy: s.loadUintBig(256),
        root: s.loadUintBig(256),
        publicSeed: s.loadUintBig(256),
        limit: s.loadUint(32),
        nextLeaf: s.loadUint(32),
        blindedRemaining: s.loadUint(32),
        whitelist: loadKeyDictBox(s.loadRef()),
        blindedKeys: loadKeyDictBox(s.loadRef())
    };
    s.endParse();
    return out;
}
