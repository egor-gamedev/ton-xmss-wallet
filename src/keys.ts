// Key material for one XMSS tree ("epoch") of the wallet.
//
//   secretSeed        — WOTS+ secret; anyone holding it can sign.          SECRET
//   blindedMasterSeed — derives the 256-bit blinded-key preimages.         SECRET
//   publicSeed        — WOTS+ chain randomizer, stored on-chain.           public
//   policy            — opaque 256-bit value every request must repeat.    public
//
// The recovery phrase (src/recovery.ts) packs both secrets plus the wallet address.

import { createHash, randomBytes } from 'node:crypto';
import { beginCell } from '@ton/core';
import { bytesToBigint, commitBlindedKey, fromHex256, toHex256 } from './crypto';
import { TREE_MAX_LEAVES } from './constants';

export type XmssKeySet = {
    walletId: number;
    secretSeed: bigint;
    publicSeed: bigint;
    blindedMasterSeed: bigint;
    policy: bigint;
};

export type XmssKeySetJson = {
    walletId: number;
    secretSeed: string;
    publicSeed: string;
    blindedMasterSeed: string;
    policy: string;
};

/**
 * Policy hash used by the original deployment scripts:
 * cell_hash of the UTF-8 JSON `{"role":"user","walletId":<id>}`.
 * The contract treats policy as an opaque value — any 256-bit number works.
 */
export function defaultPolicyHash(walletId: number, role = 'user'): bigint {
    const json = JSON.stringify({ role, walletId });
    return bytesToBigint(beginCell().storeBuffer(Buffer.from(json)).endCell().hash());
}

export function generateKeySet(walletId: number, policy?: bigint): XmssKeySet {
    if (!Number.isInteger(walletId) || walletId < 0 || walletId > 0xffffffff) {
        throw new Error('walletId must be uint32');
    }
    return {
        walletId,
        secretSeed: bytesToBigint(randomBytes(32)),
        publicSeed: bytesToBigint(randomBytes(32)),
        blindedMasterSeed: bytesToBigint(randomBytes(32)),
        policy: policy ?? defaultPolicyHash(walletId)
    };
}

/** preimage_i = SHA-256("BLND" || masterSeed || i as u64 little-endian). */
export function deriveBlindedPreimage(blindedMasterSeed: bigint, index: number): bigint {
    const idx = Buffer.alloc(8);
    idx.writeBigUInt64LE(BigInt(index));
    const material = Buffer.concat([
        Buffer.from('BLND', 'ascii'),
        Buffer.from(toHex256(blindedMasterSeed), 'hex'),
        idx
    ]);
    return bytesToBigint(createHash('sha256').update(material).digest());
}

/** On-chain commitments for blinded keys [0, count). */
export function blindedCommitments(blindedMasterSeed: bigint, count = TREE_MAX_LEAVES): bigint[] {
    const out: bigint[] = [];
    for (let i = 0; i < count; i++) {
        out.push(commitBlindedKey(deriveBlindedPreimage(blindedMasterSeed, i)));
    }
    return out;
}

export function keySetToJson(k: XmssKeySet): XmssKeySetJson {
    return {
        walletId: k.walletId,
        secretSeed: toHex256(k.secretSeed),
        publicSeed: toHex256(k.publicSeed),
        blindedMasterSeed: toHex256(k.blindedMasterSeed),
        policy: toHex256(k.policy)
    };
}

export function keySetFromJson(j: XmssKeySetJson): XmssKeySet {
    return {
        walletId: Number(j.walletId),
        secretSeed: fromHex256('secretSeed', j.secretSeed),
        publicSeed: fromHex256('publicSeed', j.publicSeed),
        blindedMasterSeed: fromHex256('blindedMasterSeed', j.blindedMasterSeed),
        policy: fromHex256('policy', j.policy)
    };
}
