// Request payloads, XMSS proofs and signed message bodies — see docs/SPECIFICATION.md.

import { Address, beginCell, Cell, MessageRelaxed, storeMessageRelaxed } from '@ton/core';
import {
    ALLOWED_SEND_MODES,
    AUTH,
    AuthMode,
    MAX_VALID_UNTIL_DELTA,
    OP,
    PROOF_VERSION,
    REQ,
    ReqType,
    TAG,
    TREE_HEIGHT,
    TREE_MAX_LEAVES,
    WOTS_LEN
} from './constants';
import {
    authPath,
    bigintToBytes,
    bytesToBigint,
    cellHashBytes,
    commitBlindedKey,
    rootFromSignature,
    treeRoot,
    wotsSign,
    XmssTree
} from './crypto';
import { deriveBlindedPreimage, XmssKeySet } from './keys';
import { keyDictFrom, storeKeyDictBox } from './storage';

export type TransferRequest = {
    type: 'transfer';
    /** One of 0, 1, 2, 64, 65, 66. Mode 128 (send whole balance) is rejected by the contract. */
    mode: number;
    /** Outgoing internal message (use `internal({...})` from @ton/core) or a pre-serialized cell. */
    message: MessageRelaxed | Cell;
};

export type RotateRootRequest = {
    type: 'rotate_root';
    newRoot: bigint;
    newPublicSeed: bigint;
    newPolicy: bigint;
    /** Usable leaves in the new tree, 2..128 (the last is reserved for the next rotation). */
    newLimit: number;
    /** Commitments H(BLND || preimage) of the new blinded keys (non-empty). */
    newBlindedCommitments: bigint[];
};

export type WhitelistRequest = {
    type: 'wl_add' | 'wl_remove';
    address: Address;
};

export type WalletRequest = TransferRequest | RotateRootRequest | WhitelistRequest;

export function requestType(r: WalletRequest): ReqType {
    switch (r.type) {
        case 'transfer':
            return REQ.TRANSFER;
        case 'rotate_root':
            return REQ.ROTATE_ROOT;
        case 'wl_add':
            return REQ.WL_ADD;
        case 'wl_remove':
            return REQ.WL_REMOVE;
    }
}

export type PayloadHeader = {
    walletId: number;
    validUntil: number;
    seqno: number;
    policy: bigint;
    blindedPreimage: bigint;
};

export function buildPayload(h: PayloadHeader, r: WalletRequest): Cell {
    const b = beginCell()
        .storeUint(h.walletId, 32)
        .storeUint(h.validUntil, 32)
        .storeUint(h.seqno, 32)
        .storeUint(h.policy, 256)
        .storeUint(requestType(r), 8)
        .storeUint(h.blindedPreimage, 256);

    switch (r.type) {
        case 'transfer': {
            if (!(ALLOWED_SEND_MODES as readonly number[]).includes(r.mode)) {
                throw new Error(
                    `send mode ${r.mode} is not allowed (allowed: ${ALLOWED_SEND_MODES})`
                );
            }
            const msg =
                r.message instanceof Cell
                    ? r.message
                    : beginCell().store(storeMessageRelaxed(r.message)).endCell();
            return b.storeUint(r.mode, 8).storeRef(msg).endCell();
        }
        case 'rotate_root': {
            if (r.newLimit < 2 || r.newLimit > TREE_MAX_LEAVES) {
                throw new Error('newLimit must be 2..128');
            }
            if (new Set(r.newBlindedCommitments).size < r.newLimit) {
                throw new Error('need at least newLimit distinct blinded commitments');
            }
            const treeData = beginCell()
                .storeUint(r.newRoot, 256)
                .storeUint(r.newPublicSeed, 256)
                .storeUint(r.newLimit, 32)
                .storeUint(r.newPolicy, 256)
                .storeUint(new Set(r.newBlindedCommitments).size, 32)
                .storeRef(storeKeyDictBox(keyDictFrom(r.newBlindedCommitments)))
                .endCell();
            return b.storeRef(treeData).endCell();
        }
        case 'wl_add':
        case 'wl_remove':
            return b.storeRef(beginCell().storeAddress(r.address).endCell()).endCell();
    }
}

/** The 256-bit digest that is WOTS+-signed. Matches hash_message(). */
export function hashRequest(
    walletAddress: Address,
    payload: Cell,
    reqType: ReqType,
    authMode: AuthMode,
    authKey: bigint
): bigint {
    const addrHash = bytesToBigint(beginCell().storeAddress(walletAddress).endCell().hash());
    return cellHashBytes(
        Buffer.concat([
            bigintToBytes(BigInt(TAG.XMSS_MSG), 4),
            bigintToBytes(addrHash, 32),
            Buffer.from([authMode, reqType]),
            bigintToBytes(authKey, 32),
            Buffer.from(payload.hash())
        ])
    );
}

/**
 * Proof cell: version:8 | leaf_index:64 | public_seed:256 | w0 | w1 | ^next
 * followed by a chain of cells holding 3 words each. Words = 67 WOTS+ elements + 7 auth-path nodes.
 */
export function buildProof(
    leafIndex: number,
    publicSeed: bigint,
    sig: bigint[],
    path: bigint[]
): Cell {
    const words = [...sig, ...path];
    if (words.length !== WOTS_LEN + TREE_HEIGHT) throw new Error('bad proof word count');

    const tailWords = words.slice(2);
    let tail: Cell | null = null;
    for (let end = tailWords.length; end > 0; end -= 3) {
        const b = beginCell();
        for (const w of tailWords.slice(Math.max(0, end - 3), end)) b.storeUint(w, 256);
        if (tail) b.storeRef(tail);
        tail = b.endCell();
    }

    const head = beginCell()
        .storeUint(PROOF_VERSION, 8)
        .storeUint(leafIndex, 64)
        .storeUint(publicSeed, 256)
        .storeUint(words[0], 256)
        .storeUint(words[1], 256);
    if (tail) head.storeRef(tail);
    return head.endCell();
}

/** op:32 | ^proof | ^payload */
export function buildBody(authMode: AuthMode, proof: Cell, payload: Cell): Cell {
    return beginCell()
        .storeUint(authMode === AUTH.EXTERNAL ? OP.SIGNED_EXTERNAL : OP.SIGNED_INTERNAL, 32)
        .storeRef(proof)
        .storeRef(payload)
        .endCell();
}

/**
 * Refuses to spend the last remaining leaf on anything except rotate_root.
 * A wallet with next_leaf == limit can never sign again (funds frozen), so
 * the last leaf must be reserved for rotation. Call before signRequest().
 */
export function assertLeafBudget(
    nextLeaf: number,
    limit: number,
    request: WalletRequest,
    blindedRemaining = Infinity
): void {
    const remaining = Math.min(limit - nextLeaf, blindedRemaining);
    if (remaining <= 0) {
        throw new Error('wallet is exhausted: no leaves left, funds cannot be moved');
    }
    if (remaining === 1 && request.type !== 'rotate_root') {
        throw new Error('only one leaf left: it is reserved for rotate_root — rotate keys first');
    }
}

/**
 * Throws if the wallet currently rejects external messages (after a failed attempt on the
 * last leaf). Use the relayer path or wait until `extLockUntil`.
 */
export function assertExternalsUnlocked(extLockUntil: number, now = Math.floor(Date.now() / 1000)) {
    if (now < extLockUntil) {
        throw new Error(
            `externals are locked until ${new Date(extLockUntil * 1000).toISOString()}`
        );
    }
}

export type SignRequestParams = {
    keys: XmssKeySet;
    /** Tree built from `keys` with buildTree(). Cache it — building takes ~1 s. */
    tree: XmssTree;
    walletAddress: Address;
    /** Current on-chain seqno (get method `seqno`). */
    seqno: number;
    /** Current on-chain next leaf (get method `get_next_leaf`). NEVER guess this value. */
    leafIndex: number;
    /** Index of an unused blinded key (see XmssWallet.getUnusedBlindedIndex). */
    blindedIndex: number;
    /** Unix time; must satisfy now < validUntil <= now + 86400 at execution time. */
    validUntil: number;
    request: WalletRequest;
    /** AUTH.EXTERNAL (default) for an external message, AUTH.INTERNAL for a whitelisted relayer. */
    authMode?: AuthMode;
};

export type SignedRequest = {
    body: Cell;
    payload: Cell;
    msgHash: bigint;
    leafIndex: number;
    blindedPreimage: bigint;
};

export function signRequest(p: SignRequestParams): SignedRequest {
    const authMode = p.authMode ?? AUTH.EXTERNAL;
    const root = treeRoot(p.tree);
    if (p.leafIndex < 0 || p.leafIndex >= TREE_MAX_LEAVES)
        throw new Error('leafIndex out of range');
    const now = Math.floor(Date.now() / 1000);
    if (p.validUntil > now + MAX_VALID_UNTIL_DELTA) {
        throw new Error('validUntil is more than 24h in the future; the contract will reject it');
    }

    const blindedPreimage = deriveBlindedPreimage(p.keys.blindedMasterSeed, p.blindedIndex);
    const reqType = requestType(p.request);
    const payload = buildPayload(
        {
            walletId: p.keys.walletId,
            validUntil: p.validUntil,
            seqno: p.seqno,
            policy: p.keys.policy,
            blindedPreimage
        },
        p.request
    );
    const msgHash = hashRequest(
        p.walletAddress,
        payload,
        reqType,
        authMode,
        commitBlindedKey(blindedPreimage)
    );
    const sig = wotsSign(p.keys.secretSeed, p.keys.publicSeed, p.leafIndex, msgHash);
    const path = authPath(p.tree, p.leafIndex);

    if (rootFromSignature(sig, path, p.keys.publicSeed, p.leafIndex, msgHash) !== root) {
        throw new Error('self-check failed: signature does not verify against the tree root');
    }

    return {
        body: buildBody(authMode, buildProof(p.leafIndex, p.keys.publicSeed, sig, path), payload),
        payload,
        msgHash,
        leafIndex: p.leafIndex,
        blindedPreimage
    };
}
