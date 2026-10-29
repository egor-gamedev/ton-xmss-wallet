// Recovery phrase: packs the wallet address and both secrets into BIP-39 English words.
//
//   "XMSSR3" (6) | version=2 (1) | workchain:int8 (1) | addr_hash (32)
//   | secretSeed (32) | blindedMasterSeed (32) | SHA-256(previous)[0..4]
//
// 108 bytes -> 79 words. This is NOT a BIP-39 mnemonic (no PBKDF2, no standard checksum);
// it only reuses the word list. It is NOT compatible with any other wallet app.
// publicSeed / policy / walletId are recoverable from the chain via get methods.

import { createHash, timingSafeEqual } from 'node:crypto';
import { Address } from '@ton/core';
import { wordlists } from 'bip39';
import { bigintToBytes, bytesToBigint } from './crypto';

const WORDS = wordlists.english;
const WORD_INDEX = new Map<string, number>(WORDS.map((w, i) => [w, i]));
const MAGIC = Buffer.from('XMSSR3', 'ascii');
const VERSION = 2;

export type RecoveryData = {
    address: Address;
    secretSeed: bigint;
    blindedMasterSeed: bigint;
};

const checksum4 = (b: Buffer) => createHash('sha256').update(b).digest().subarray(0, 4);

function bytesToWords(data: Buffer): string[] {
    let acc = 0n;
    let bits = 0n;
    const out: string[] = [];
    for (const byte of data) {
        acc = (acc << 8n) | BigInt(byte);
        bits += 8n;
        while (bits >= 11n) {
            bits -= 11n;
            out.push(WORDS[Number((acc >> bits) & 2047n)]);
            acc &= (1n << bits) - 1n;
        }
    }
    if (bits > 0n) out.push(WORDS[Number((acc << (11n - bits)) & 2047n)]);
    return out;
}

function wordsToBytes(words: string[]): Buffer {
    let acc = 0n;
    let bits = 0n;
    const out: number[] = [];
    for (const w of words) {
        const idx = WORD_INDEX.get(w);
        if (idx === undefined) throw new Error(`unknown word "${w}"`);
        acc = (acc << 11n) | BigInt(idx);
        bits += 11n;
        while (bits >= 8n) {
            bits -= 8n;
            out.push(Number((acc >> bits) & 0xffn));
            acc &= (1n << bits) - 1n;
        }
    }
    return Buffer.from(out);
}

export function encodeRecoveryPhrase(d: RecoveryData): string {
    const payload = Buffer.concat([
        MAGIC,
        Buffer.from([VERSION, d.address.workChain & 0xff]),
        Buffer.from(d.address.hash),
        bigintToBytes(d.secretSeed, 32),
        bigintToBytes(d.blindedMasterSeed, 32)
    ]);
    return bytesToWords(Buffer.concat([payload, checksum4(payload)])).join(' ');
}

export function decodeRecoveryPhrase(phrase: string): RecoveryData {
    const words = phrase.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const blob = wordsToBytes(words);
    const len = MAGIC.length + 2 + 32 * 3;
    if (blob.length < len + 4) throw new Error('phrase too short');
    const payload = blob.subarray(0, len);
    if (!timingSafeEqual(blob.subarray(len, len + 4), checksum4(payload))) {
        throw new Error('checksum mismatch — wrong or corrupted phrase');
    }
    if (!payload.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('bad magic');
    if (payload[MAGIC.length] !== VERSION)
        throw new Error(`unsupported version ${payload[MAGIC.length]}`);
    let o = MAGIC.length + 1;
    const wc = payload.readInt8(o);
    o += 1;
    const hash = payload.subarray(o, o + 32);
    o += 32;
    return {
        address: new Address(wc, Buffer.from(hash)),
        secretSeed: bytesToBigint(payload.subarray(o, o + 32)),
        blindedMasterSeed: bytesToBigint(payload.subarray(o + 32, o + 64))
    };
}
