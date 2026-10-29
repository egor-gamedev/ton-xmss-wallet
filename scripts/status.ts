// Prints the on-chain state of the wallet and safety warnings.
//   npx blueprint run status --testnet --tonconnect      (or WALLET_ADDRESS=<addr>)
import * as fs from 'node:fs';
import { fromNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { buildTree, toHex256, treeRoot } from '../src';
import { KEYS_FILE, loadKeys, openWallet } from './lib/common';

export async function run(provider: NetworkProvider) {
    const wallet = openWallet(provider);
    const s = await wallet.getStorage();
    const balance = (await provider.provider(wallet.address).getState()).balance;
    const ui = provider.ui();

    ui.write(`address            ${wallet.address.toString()}`);
    ui.write(`balance            ${fromNano(balance)} TON`);
    ui.write(`seqno              ${s.seqno}`);
    ui.write(`walletId           ${s.walletId}`);
    ui.write(
        `leaves             ${s.nextLeaf} used / ${s.limit} (remaining ${s.limit - s.nextLeaf})`
    );
    ui.write(`blinded keys left  ${s.blindedRemaining}`);
    ui.write(`whitelist entries  ${s.whitelist.size}`);
    ui.write(
        `storage version    ${s.version}${
            s.version < 3 ? ' (old contract: see docs/SECURITY.md)' : ''
        }`
    );
    if (s.extLockUntil > Math.floor(Date.now() / 1000)) {
        ui.write(
            `externals locked   until ${new Date(
                s.extLockUntil * 1000
            ).toISOString()} (relayer path still works)`
        );
    }
    ui.write(`root               ${toHex256(s.root)}`);

    if (fs.existsSync(KEYS_FILE)) {
        const keys = loadKeys();
        const match = treeRoot(buildTree(keys.secretSeed, keys.publicSeed)) === s.root;
        ui.write(`local keys match   ${match ? 'yes' : 'NO (wrong key file or rotation pending)'}`);
    }
    const remaining = s.limit - s.nextLeaf;
    if (remaining <= 0) ui.write('Warning: no leaves left, the wallet can never sign again.');
    else if (remaining <= 8)
        ui.write(`Warning: only ${remaining} leaves left. Run "npx blueprint run rotate" now.`);
}
