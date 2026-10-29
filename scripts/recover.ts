// Restores keys/wallet.keys.json from a recovery phrase.
//   PHRASE_FILE=./phrase.txt npx blueprint run recover --mainnet --tonconnect
// publicSeed, policy and walletId are read from the chain.
import * as fs from 'node:fs';
import { NetworkProvider } from '@ton/blueprint';
import { buildTree, decodeRecoveryPhrase, treeRoot, XmssKeySet, XmssWallet } from '../src';
import { DEPLOY_FILE, env, KEYS_FILE, saveKeys, writeSecretJson } from './lib/common';

export async function run(provider: NetworkProvider) {
    if (fs.existsSync(KEYS_FILE)) throw new Error(`${KEYS_FILE} exists; move it away first`);
    const r = decodeRecoveryPhrase(fs.readFileSync(env('PHRASE_FILE'), 'utf8'));
    const wallet = provider.open(XmssWallet.createFromAddress(r.address));
    const s = await wallet.getStorage();
    const keys: XmssKeySet = {
        walletId: s.walletId,
        secretSeed: r.secretSeed,
        publicSeed: s.publicSeed,
        blindedMasterSeed: r.blindedMasterSeed,
        policy: s.policy
    };
    if (treeRoot(buildTree(keys.secretSeed, keys.publicSeed)) !== s.root) {
        throw new Error(
            'phrase does not match the on-chain root (was the wallet rotated after this phrase?)'
        );
    }
    saveKeys(keys);
    writeSecretJson(DEPLOY_FILE, {
        address: r.address.toString(),
        rawAddress: r.address.toRawString(),
        network: provider.network()
    });
    provider.ui().write(`Recovered keys for ${r.address.toString()} into ${KEYS_FILE}`);
}
