import * as fs from 'node:fs';
import * as path from 'node:path';
import { Address, Cell } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import {
    assertLeafBudget,
    buildTree,
    keySetFromJson,
    keySetToJson,
    signRequest,
    treeRoot,
    WalletRequest,
    XmssKeySet,
    XmssWallet
} from '../../src';

export const KEYS_DIR = path.resolve(process.cwd(), process.env.KEYS_DIR ?? 'keys');
export const KEYS_FILE = path.join(KEYS_DIR, 'wallet.keys.json');
export const NEXT_KEYS_FILE = path.join(KEYS_DIR, 'wallet.keys.next.json');
export const DEPLOY_FILE = path.join(KEYS_DIR, 'wallet.deploy.json');
export const RECOVERY_FILE = path.join(KEYS_DIR, 'wallet.recovery.txt');

export function writeSecretJson(file: string, data: unknown) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
}

export function loadKeys(file = KEYS_FILE): XmssKeySet {
    if (!fs.existsSync(file)) throw new Error(`key file not found: ${file} (run "npm run keygen")`);
    return keySetFromJson(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function saveKeys(keys: XmssKeySet, file = KEYS_FILE) {
    writeSecretJson(file, keySetToJson(keys));
}

export function env(name: string, fallback?: string): string {
    const v = process.env[name] ?? fallback;
    if (v === undefined || v === '') throw new Error(`environment variable ${name} is required`);
    return v;
}

export function walletAddress(): Address {
    if (process.env.WALLET_ADDRESS) return Address.parse(process.env.WALLET_ADDRESS);
    if (!fs.existsSync(DEPLOY_FILE))
        throw new Error(`set WALLET_ADDRESS or deploy first (${DEPLOY_FILE})`);
    return Address.parse(JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8')).address);
}

/** Opens the wallet; attaches StateInit (from create-wallet) so the first request can deploy it. */
export function openWallet(provider: NetworkProvider) {
    const address = walletAddress();
    let init: { code: Cell; data: Cell } | undefined;
    if (fs.existsSync(DEPLOY_FILE)) {
        const d = JSON.parse(fs.readFileSync(DEPLOY_FILE, 'utf8'));
        if (d.initCode && d.initData && Address.parse(d.address).equals(address)) {
            init = { code: Cell.fromBase64(d.initCode), data: Cell.fromBase64(d.initData) };
        }
    }
    return provider.open(new XmssWallet(address, init));
}

async function sleep(ms: number) {
    return new Promise(r => setTimeout(r, ms));
}

/**
 * Reads on-chain state, checks it matches the local keys, signs `request`
 * and sends it as an external message. Waits until seqno advances.
 */
export async function signAndSend(
    provider: NetworkProvider,
    keys: XmssKeySet,
    request: WalletRequest,
    opts: { validForSec?: number } = {}
) {
    const wallet = openWallet(provider);
    const ui = provider.ui();

    const storage = await wallet.getStorage();
    const tree = buildTree(keys.secretSeed, keys.publicSeed);
    if (treeRoot(tree) !== storage.root)
        throw new Error('local keys do not match the on-chain root');
    if (storage.walletId !== keys.walletId) throw new Error('walletId mismatch');
    if (storage.policy !== keys.policy) throw new Error('policy mismatch');
    assertLeafBudget(storage.nextLeaf, storage.limit, request);

    const blindedIndex = await wallet.getUnusedBlindedIndex(keys.blindedMasterSeed);
    if (blindedIndex < 0) throw new Error('no unused blinded keys left — rotate keys');

    const signed = signRequest({
        keys,
        tree,
        walletAddress: wallet.address,
        seqno: storage.seqno,
        leafIndex: storage.nextLeaf,
        blindedIndex,
        validUntil: Math.floor(Date.now() / 1000) + (opts.validForSec ?? 600),
        request
    });

    ui.write(
        `Signing with leaf ${storage.nextLeaf}/${storage.limit}, blinded key #${blindedIndex}, seqno ${storage.seqno}`
    );
    await wallet.sendExternalSigned(signed.body);
    ui.write('External message sent. Waiting for confirmation...');

    for (let i = 0; i < 40; i++) {
        await sleep(3000);
        try {
            if ((await wallet.isActive()) && (await wallet.getSeqno()) > storage.seqno) {
                ui.write(`Confirmed. Leaves remaining: ${await wallet.getLeavesRemaining()}`);
                return;
            }
        } catch {
            // transient API errors — keep polling
        }
    }
    ui.write(
        'Not confirmed within 2 minutes. Do NOT sign a different message yet: re-broadcast the same ' +
            'body or wait — signing new data with the same leaf weakens WOTS+ (see docs/SECURITY.md).'
    );
}
