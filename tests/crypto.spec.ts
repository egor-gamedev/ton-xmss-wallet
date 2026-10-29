import { Address, beginCell } from '@ton/core';
import {
    authPath,
    buildTree,
    bytesToBigint,
    chainStep,
    commitBlindedKey,
    decodeRecoveryPhrase,
    encodeRecoveryPhrase,
    generateKeySet,
    lTree,
    ltreeHash,
    merkleHash,
    rootFromSignature,
    TAG,
    treeRoot,
    whitelistKey,
    wotsDigits,
    wotsPublicKey,
    wotsSecretElement,
    wotsSign
} from '../src';

const h = (b: ReturnType<typeof beginCell>) => bytesToBigint(b.endCell().hash());
const rnd = () => bytesToBigint(require('node:crypto').randomBytes(32));

describe('hash primitives match TVM cell_hash', () => {
    const a = rnd();
    const b = rnd();

    it('chain / ltree / merkle', () => {
        expect(chainStep(a, b)).toBe(
            h(beginCell().storeUint(TAG.WOTS_CHAIN, 32).storeUint(a, 256).storeUint(b, 256))
        );
        expect(ltreeHash(a, b)).toBe(
            h(beginCell().storeUint(TAG.LTREE, 32).storeUint(a, 256).storeUint(b, 256))
        );
        expect(merkleHash(a, b)).toBe(
            h(beginCell().storeUint(TAG.MERKLE, 32).storeUint(a, 256).storeUint(b, 256))
        );
    });

    it('blinded commitment and PRF', () => {
        expect(commitBlindedKey(a)).toBe(
            h(beginCell().storeUint(TAG.BLINDED_KEY, 32).storeUint(a, 256))
        );
        expect(wotsSecretElement(a, 77, 66)).toBe(
            h(
                beginCell()
                    .storeUint(TAG.WOTS_PRF, 32)
                    .storeUint(a, 256)
                    .storeUint(77, 64)
                    .storeUint(66, 8)
            )
        );
    });

    it('whitelist key', () => {
        const addr = new Address(-1, Buffer.alloc(32, 7));
        expect(whitelistKey(addr)).toBe(
            h(
                beginCell()
                    .storeUint(TAG.WL_KEY, 32)
                    .storeInt(-1, 8)
                    .storeBuffer(Buffer.alloc(32, 7))
            )
        );
    });
});

describe('WOTS+ / XMSS', () => {
    it('checksum digits are well-formed', () => {
        const d = wotsDigits((1n << 256n) - 1n);
        expect(d).toHaveLength(67);
        expect(d.slice(64)).toEqual([0, 0, 0]);
        expect(wotsDigits(0n).slice(64)).toEqual([3, 12, 0]); // 960 = 0x3C0
    });

    it('layered L-tree equals the stack-based L-tree used by the original keygen', () => {
        const pk = Array.from({ length: 67 }, rnd);
        const stack: { v: bigint; h: number }[] = [];
        for (const v of pk) {
            stack.push({ v, h: 0 });
            while (stack.length >= 2 && stack[stack.length - 1].h === stack[stack.length - 2].h) {
                const top = stack.pop()!;
                const prev = stack.pop()!;
                stack.push({ v: ltreeHash(prev.v, top.v), h: prev.h + 1 });
            }
        }
        while (stack.length > 1) {
            const top = stack.pop()!;
            const prev = stack.pop()!;
            stack.push({ v: ltreeHash(prev.v, top.v), h: Math.max(prev.h, top.h) + 1 });
        }
        expect(lTree(pk)).toBe(stack[0].v);
    });

    it('sign -> verify roundtrip against the tree root', () => {
        const keys = generateKeySet(1);
        const tree = buildTree(keys.secretSeed, keys.publicSeed);
        const msg = rnd();
        for (const leaf of [0, 1, 64, 127]) {
            const sig = wotsSign(keys.secretSeed, keys.publicSeed, leaf, msg);
            expect(rootFromSignature(sig, authPath(tree, leaf), keys.publicSeed, leaf, msg)).toBe(
                treeRoot(tree)
            );
            expect(
                rootFromSignature(sig, authPath(tree, leaf), keys.publicSeed, leaf, msg ^ 1n)
            ).not.toBe(treeRoot(tree));
        }
        expect(tree[0][5]).toBe(lTree(wotsPublicKey(keys.secretSeed, keys.publicSeed, 5)));
    });
});

describe('recovery phrase', () => {
    it('roundtrips and detects corruption', () => {
        const d = {
            address: new Address(0, Buffer.alloc(32, 9)),
            secretSeed: rnd(),
            blindedMasterSeed: rnd()
        };
        const phrase = encodeRecoveryPhrase(d);
        expect(phrase.split(' ')).toHaveLength(79);
        const back = decodeRecoveryPhrase(phrase);
        expect(back.address.equals(d.address)).toBe(true);
        expect(back.secretSeed).toBe(d.secretSeed);
        expect(back.blindedMasterSeed).toBe(d.blindedMasterSeed);

        const words = phrase.split(' ');
        words[10] = words[10] === 'abandon' ? 'ability' : 'abandon';
        expect(() => decodeRecoveryPhrase(words.join(' '))).toThrow();
    });
});
