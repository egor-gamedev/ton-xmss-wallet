// Deploys a wallet for keys/wallet.keys.json.
//   WHITELIST=<addr1>,<addr2> DEPLOY_VALUE=0.5 npx blueprint run deploy --testnet --tonconnect
import * as fs from 'node:fs';
import { Address, toNano } from '@ton/core';
import { compile, NetworkProvider } from '@ton/blueprint';
import {
    blindedCommitments,
    buildTree,
    encodeRecoveryPhrase,
    toHex256,
    treeRoot,
    XmssWallet
} from '../src';
import { DEPLOY_FILE, loadKeys, RECOVERY_FILE, writeSecretJson } from './lib/common';

export async function run(provider: NetworkProvider) {
    const keys = loadKeys();
    const root = treeRoot(buildTree(keys.secretSeed, keys.publicSeed));
    const whitelist = (process.env.WHITELIST ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean)
        .map(s => Address.parse(s));

    const wallet = provider.open(
        XmssWallet.createFromConfig(
            {
                walletId: keys.walletId,
                policy: keys.policy,
                root,
                publicSeed: keys.publicSeed,
                blindedCommitments: blindedCommitments(keys.blindedMasterSeed, 128),
                whitelist
            },
            await compile('xmss_wallet')
        )
    );

    const phrase = encodeRecoveryPhrase({
        address: wallet.address,
        secretSeed: keys.secretSeed,
        blindedMasterSeed: keys.blindedMasterSeed
    });
    fs.writeFileSync(RECOVERY_FILE, phrase + '\n', { encoding: 'utf8', mode: 0o600 });

    await wallet.sendDeploy(provider.sender(), toNano(process.env.DEPLOY_VALUE ?? '0.5'));
    await provider.waitForDeploy(wallet.address, 30);

    writeSecretJson(DEPLOY_FILE, {
        address: wallet.address.toString(),
        rawAddress: wallet.address.toRawString(),
        network: provider.network(),
        walletId: keys.walletId,
        root: toHex256(root),
        whitelist: whitelist.map(a => a.toString()),
        deployedAt: new Date().toISOString()
    });
    provider.ui().write(`Deployed ${wallet.address.toString()}`);
    provider.ui().write(`Recovery phrase (79 words) saved to ${RECOVERY_FILE} — copy it offline.`);
}
