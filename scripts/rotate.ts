// Rotates the wallet to a freshly generated XMSS tree (resets the leaf counter to 0).
//   npx blueprint run rotate --testnet --tonconnect
// Run it BEFORE the last leaf is used. A new recovery phrase is written afterwards.
import * as fs from 'node:fs';
import { NetworkProvider } from '@ton/blueprint';
import {
    blindedCommitments,
    buildTree,
    encodeRecoveryPhrase,
    generateKeySet,
    treeRoot
} from '../src';
import {
    KEYS_FILE,
    loadKeys,
    NEXT_KEYS_FILE,
    RECOVERY_FILE,
    saveKeys,
    signAndSend,
    openWallet
} from './lib/common';

export async function run(provider: NetworkProvider) {
    const current = loadKeys();
    // Reuse a pending key set if a previous rotation attempt did not complete.
    const next = fs.existsSync(NEXT_KEYS_FILE)
        ? loadKeys(NEXT_KEYS_FILE)
        : generateKeySet(current.walletId, current.policy);
    saveKeys(next, NEXT_KEYS_FILE);
    const nextRoot = treeRoot(buildTree(next.secretSeed, next.publicSeed));

    await signAndSend(provider, current, {
        type: 'rotate_root',
        newRoot: nextRoot,
        newPublicSeed: next.publicSeed,
        newPolicy: next.policy,
        newLimit: 128,
        newBlindedCommitments: blindedCommitments(next.blindedMasterSeed, 128)
    });

    const wallet = openWallet(provider);
    if ((await wallet.getRoot()) !== nextRoot) {
        provider.ui().write(`Rotation not confirmed yet. Pending keys kept in ${NEXT_KEYS_FILE}.`);
        return;
    }
    fs.renameSync(KEYS_FILE, KEYS_FILE.replace(/\.json$/, `.retired-${Date.now()}.json`));
    saveKeys(next, KEYS_FILE);
    fs.unlinkSync(NEXT_KEYS_FILE);
    const phrase = encodeRecoveryPhrase({
        address: wallet.address,
        secretSeed: next.secretSeed,
        blindedMasterSeed: next.blindedMasterSeed
    });
    fs.writeFileSync(RECOVERY_FILE, phrase + '\n', { encoding: 'utf8', mode: 0o600 });
    provider
        .ui()
        .write(
            `Rotated. NEW recovery phrase written to ${RECOVERY_FILE}; the old phrase is now useless.`
        );
}
