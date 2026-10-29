// Contract storage (version 3) layout — see docs/SPECIFICATION.md.
//
//   uint8   version = 3
//   uint32  seqno
//   uint32  wallet_id
//   uint256 policy
//   uint256 root
//   uint256 pub_seed
//   uint32  limit              (<= 128)
//   uint32  next_leaf
//   uint32  blinded_remaining
//   uint32  ext_lock_until     (v3 only; externals rejected while now < this)
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
    /** Unix time until which external messages are rejected (0 = not locked). Always 0 for v2. */
    extLockUntil: number;
    /** 3 = current contract; 2 = original deployment (contracts/archive/xmss_wallet_v4_storage_v2.fc). */
    version: number;
    whitelist: KeyDict;
    blindedKeys: KeyDict;
};

export function storeKeyDictBox(d: KeyDict): Cell {
    return beginCell()
        .storeDict(d.size > 0 ? d : null)
        .endCell();
}

export function buildStorage(s: Omit<XmssWalletStorage, 'version'>): Cell {
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
        .storeUint(s.extLockUntil, 32)
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
    /** Number of usable leaves, 2..128 (the last one is reserved for rotation). Default 128. */
    limit?: number;
};

export function buildInitialStorage(p: InitialStorageParams): Cell {
    const limit = p.limit ?? TREE_MAX_LEAVES;
    if (limit < 2 || limit > TREE_MAX_LEAVES) throw new Error('limit must be 2..128');
    if (new Set(p.blindedCommitments).size < limit) {
        throw new Error('need at least `limit` distinct blinded keys');
    }
    return buildStorage({
        seqno: 0,
        walletId: p.walletId,
        policy: p.policy,
        root: p.root,
        publicSeed: p.publicSeed,
        limit,
        nextLeaf: 0,
        blindedRemaining: new Set(p.blindedCommitments).size,
        extLockUntil: 0,
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
    if (version !== STORAGE_VERSION && version !== 2) {
        throw new Error(`unsupported storage version ${version}`);
    }
    const out: XmssWalletStorage = {
        version,
        seqno: s.loadUint(32),
        walletId: s.loadUint(32),
        policy: s.loadUintBig(256),
        root: s.loadUintBig(256),
        publicSeed: s.loadUintBig(256),
        limit: s.loadUint(32),
        nextLeaf: s.loadUint(32),
        blindedRemaining: s.loadUint(32),
        extLockUntil: version >= 3 ? s.loadUint(32) : 0,
        whitelist: loadKeyDictBox(s.loadRef()),
        blindedKeys: loadKeyDictBox(s.loadRef())
    };
    s.endParse();
    return out;
}
