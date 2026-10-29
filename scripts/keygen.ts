// Generates a fresh XMSS key set into keys/wallet.keys.json (no network access).
//   WALLET_ID=1 npm run keygen
// Use a different WALLET_ID on testnet and mainnet (signatures are not network-bound).
import * as fs from 'node:fs';
import { buildTree, generateKeySet, toHex256, treeRoot } from '../src';
import { KEYS_FILE, saveKeys } from './lib/common';

const walletId = Number(process.env.WALLET_ID ?? 1);
if (fs.existsSync(KEYS_FILE) && process.env.FORCE !== '1') {
    console.error(`${KEYS_FILE} already exists. Refusing to overwrite (set FORCE=1 to override).`);
    process.exit(1);
}

const keys = generateKeySet(walletId);
const t0 = Date.now();
const root = treeRoot(buildTree(keys.secretSeed, keys.publicSeed));
saveKeys(keys);

console.log(`Key set written to ${KEYS_FILE} (tree built in ${Date.now() - t0} ms)`);
console.log(`walletId   ${walletId}`);
console.log(`root       ${toHex256(root)}`);
console.log(`publicSeed ${toHex256(keys.publicSeed)}`);
console.log(
    'This file contains SECRETS. Back it up offline; the recovery phrase is produced at deploy time.'
);
