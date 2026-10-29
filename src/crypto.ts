// Hash-based signature primitives (WOTS+ / L-tree / Merkle) — byte-exact with the contract.
//
// Every on-chain hash is TVM `cell_hash` of a single ordinary cell without refs.
// For such a cell with a byte-aligned payload of N bytes the representation hash is
//     SHA-256( 0x00 || 2N || payload )
// (d1 = 0 refs / level 0, d2 = 2 * N). We compute that directly with node:crypto,
// which is ~10x faster than building cells with @ton/core. `tests/crypto.spec.ts`
// checks the shortcut against @ton/core for every hash shape used here.

import { createHash } from 'node:crypto';
import {
    TAG,
    TREE_HEIGHT,
    TREE_MAX_LEAVES,
    WOTS_CSUM_MAX,
    WOTS_LEN,
    WOTS_LEN1,
    WOTS_LEN2,
    WOTS_W
} from './constants';

export function bigintToBytes(v: bigint, bytes: number): Buffer {
    if (v < 0n || v >= 1n << BigInt(bytes * 8)) {
        throw new Error(`value does not fit in ${bytes * 8} bits`);
    }
    return Buffer.from(v.toString(16).padStart(bytes * 2, '0'), 'hex');
}

export function bytesToBigint(b: Uint8Array): bigint {
    return b.length === 0 ? 0n : BigInt('0x' + Buffer.from(b).toString('hex'));
}

export function toHex256(v: bigint): string {
    return v.toString(16).padStart(64, '0');
}

export function fromHex256(name: string, hex: string): bigint {
    const h = hex.trim().toLowerCase().replace(/^0x/, '');
    if (!/^[0-9a-f]{64}$/.test(h)) throw new Error(`${name} must be 64 hex chars`);
    return BigInt('0x' + h);
}

/** cell_hash() of a ref-less cell whose data is exactly `data` (byte-aligned). */
export function cellHashBytes(data: Buffer): bigint {
    if (data.length > 127) throw new Error('cell data too long');
    const h = createHash('sha256');
    h.update(Buffer.from([0x00, data.length * 2]));
    h.update(data);
    return bytesToBigint(h.digest());
}

const u32 = (v: number) => bigintToBytes(BigInt(v), 4);
const u256 = (v: bigint) => bigintToBytes(v, 32);

function tagged2(tag: number, a: bigint, b: bigint): bigint {
    return cellHashBytes(Buffer.concat([u32(tag), u256(a), u256(b)]));
}

/** One WOTS+ chain step: H(WOCH || public_seed || x). Matches chain_step(). */
export function chainStep(publicSeed: bigint, x: bigint): bigint {
    return tagged2(TAG.WOTS_CHAIN, publicSeed, x);
}

export function chainIter(publicSeed: bigint, x: bigint, steps: number): bigint {
    let v = x;
    for (let i = 0; i < steps; i++) v = chainStep(publicSeed, v);
    return v;
}

export function ltreeHash(left: bigint, right: bigint): bigint {
    return tagged2(TAG.LTREE, left, right);
}

export function merkleHash(left: bigint, right: bigint): bigint {
    return tagged2(TAG.MERKLE, left, right);
}

/** H(BLND || preimage) — the commitment stored on-chain in the blinded-key dict. */
export function commitBlindedKey(preimage: bigint): bigint {
    return cellHashBytes(Buffer.concat([u32(TAG.BLINDED_KEY), u256(preimage)]));
}

/** WOTS+ secret element i of leaf idx: H(WOTF || secret_seed || idx:u64 || i:u8). Off-chain only. */
export function wotsSecretElement(secretSeed: bigint, leafIndex: number, i: number): bigint {
    return cellHashBytes(
        Buffer.concat([
            u32(TAG.WOTS_PRF),
            u256(secretSeed),
            bigintToBytes(BigInt(leafIndex), 8),
            Buffer.from([i])
        ])
    );
}

/** base-16 digits of the message hash followed by the 3-digit checksum (67 digits). */
export function wotsDigits(msgHash: bigint): number[] {
    const digits: number[] = [];
    let sum = 0;
    for (let i = 0; i < WOTS_LEN1; i++) {
        const d = Number((msgHash >> BigInt((WOTS_LEN1 - 1 - i) * 4)) & 15n);
        digits.push(d);
        sum += d;
    }
    const csum = WOTS_CSUM_MAX - sum;
    for (let j = 0; j < WOTS_LEN2; j++) {
        digits.push((csum >> ((WOTS_LEN2 - 1 - j) * 4)) & 15);
    }
    return digits;
}

export function wotsPublicKey(secretSeed: bigint, publicSeed: bigint, leafIndex: number): bigint[] {
    const pk: bigint[] = [];
    for (let i = 0; i < WOTS_LEN; i++) {
        pk.push(chainIter(publicSeed, wotsSecretElement(secretSeed, leafIndex, i), WOTS_W - 1));
    }
    return pk;
}

export function wotsSign(
    secretSeed: bigint,
    publicSeed: bigint,
    leafIndex: number,
    msgHash: bigint
): bigint[] {
    return wotsDigits(msgHash).map((d, i) =>
        chainIter(publicSeed, wotsSecretElement(secretSeed, leafIndex, i), d)
    );
}

/** Recover the WOTS+ public key from a signature (what the contract does). */
export function wotsPublicKeyFromSignature(
    sig: bigint[],
    publicSeed: bigint,
    msgHash: bigint
): bigint[] {
    return wotsDigits(msgHash).map((d, i) => chainIter(publicSeed, sig[i], WOTS_W - 1 - d));
}

/** L-tree compression of the 67 WOTS+ public elements (odd node is carried up unchanged). */
export function lTree(pk: bigint[]): bigint {
    let nodes = [...pk];
    while (nodes.length > 1) {
        const next: bigint[] = [];
        let k = 0;
        for (; k + 1 < nodes.length; k += 2) next.push(ltreeHash(nodes[k], nodes[k + 1]));
        if (k < nodes.length) next.push(nodes[k]);
        nodes = next;
    }
    return nodes[0];
}

/** Full Merkle tree: levels[0] = 128 leaves, levels[TREE_HEIGHT][0] = root. */
export type XmssTree = bigint[][];

export function buildTree(secretSeed: bigint, publicSeed: bigint): XmssTree {
    const levels: XmssTree = [[]];
    for (let i = 0; i < TREE_MAX_LEAVES; i++) {
        levels[0].push(lTree(wotsPublicKey(secretSeed, publicSeed, i)));
    }
    for (let h = 0; h < TREE_HEIGHT; h++) {
        const next: bigint[] = [];
        for (let i = 0; i < levels[h].length; i += 2) {
            next.push(merkleHash(levels[h][i], levels[h][i + 1]));
        }
        levels.push(next);
    }
    return levels;
}

export function treeRoot(tree: XmssTree): bigint {
    return tree[TREE_HEIGHT][0];
}

export function authPath(tree: XmssTree, leafIndex: number): bigint[] {
    const path: bigint[] = [];
    let i = leafIndex;
    for (let h = 0; h < TREE_HEIGHT; h++) {
        path.push(tree[h][i ^ 1]);
        i >>= 1;
    }
    return path;
}

/** Off-chain mirror of verify_xmss(): recompute the root from a signature. */
export function rootFromSignature(
    sig: bigint[],
    path: bigint[],
    publicSeed: bigint,
    leafIndex: number,
    msgHash: bigint
): bigint {
    let node = lTree(wotsPublicKeyFromSignature(sig, publicSeed, msgHash));
    let pos = leafIndex;
    for (const sib of path) {
        node = pos & 1 ? merkleHash(sib, node) : merkleHash(node, sib);
        pos >>= 1;
    }
    return node;
}

export function serializeTree(tree: XmssTree): string[][] {
    return tree.map(level => level.map(toHex256));
}

export function deserializeTree(raw: string[][]): XmssTree {
    return raw.map(level => level.map(h => fromHex256('tree node', h)));
}
