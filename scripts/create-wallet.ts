// ONE COMMAND: creates a ready-to-use XMSS wallet (keys, address, recovery phrase). Offline.
//
//   npm run create-wallet                       # testnet address format (default)
//   NETWORK=mainnet npm run create-wallet
//   npm run create-wallet -- --json             # machine-readable output (for agents)
//
// Optional env: WALLET_ID (default 1 on testnet, 0 on mainnet), WHITELIST=<addr1>,<addr2>,
// KEYS_DIR (default ./keys), FORCE=1 to overwrite an existing key set.
//
// Next step: send TON (non-bounceable) to the printed address, then run any request,
// e.g. `TO=... AMOUNT=0.1 npx blueprint run transfer --testnet --tonconnect`.
// The first request attaches StateInit and activates the wallet — no separate deploy.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Address, Cell } from '@ton/core';
import { createWallet, toHex256, treeRoot } from '../src';
import { DEPLOY_FILE, KEYS_FILE, RECOVERY_FILE, saveKeys, writeSecretJson } from './lib/common';

const EXPECTED_CODE_HASH = 'ff6a94b4e2174005bbf87215a9f7d9b69b284b4bc6cca30327ee9f5f1887f5d7';

function main() {
    const json = process.argv.includes('--json');
    const network = (process.env.NETWORK ?? 'testnet').toLowerCase();
    if (network !== 'testnet' && network !== 'mainnet')
        throw new Error('NETWORK must be testnet or mainnet');
    if (fs.existsSync(KEYS_FILE) && process.env.FORCE !== '1') {
        throw new Error(
            `${KEYS_FILE} already exists — refusing to overwrite a wallet (FORCE=1 to override)`
        );
    }

    const compiled = path.resolve(__dirname, '../build/xmss_wallet.compiled.json');
    if (!fs.existsSync(compiled))
        throw new Error('build/xmss_wallet.compiled.json missing — run "npm run build"');
    const code = Cell.fromHex(JSON.parse(fs.readFileSync(compiled, 'utf8')).hex);
    if (code.hash().toString('hex') !== EXPECTED_CODE_HASH) {
        console.warn(
            `warning: code hash ${code.hash().toString('hex')} differs from the reference build`
        );
    }

    const created = createWallet({
        code,
        walletId: Number(process.env.WALLET_ID ?? (network === 'mainnet' ? 0 : 1)),
        whitelist: (process.env.WHITELIST ?? '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean)
            .map(s => Address.parse(s))
    });
    const testOnly = network === 'testnet';
    const address = created.address.toString({ bounceable: true, testOnly });
    const fundingAddress = created.address.toString({ bounceable: false, testOnly });

    saveKeys(created.keys);
    fs.writeFileSync(RECOVERY_FILE, created.recoveryPhrase + '\n', {
        encoding: 'utf8',
        mode: 0o600
    });
    writeSecretJson(DEPLOY_FILE, {
        address,
        rawAddress: created.address.toRawString(),
        network,
        walletId: created.keys.walletId,
        root: toHex256(treeRoot(created.tree)),
        initCode: created.wallet.init!.code.toBoc().toString('base64'),
        initData: created.wallet.init!.data.toBoc().toString('base64'),
        createdAt: new Date().toISOString()
    });

    if (json) {
        console.log(
            JSON.stringify(
                {
                    network,
                    address,
                    fundingAddress,
                    walletId: created.keys.walletId,
                    recoveryPhrase: created.recoveryPhrase,
                    files: { keys: KEYS_FILE, recovery: RECOVERY_FILE, wallet: DEPLOY_FILE }
                },
                null,
                2
            )
        );
        return;
    }

    const line = '='.repeat(72);
    console.log(`\nXMSS wallet created (${network}).\n`);
    console.log(`Address (send TON here, non-bounceable): ${fundingAddress}`);
    console.log(`Address (bounceable form):               ${address}`);
    console.log(
        `\n${line}\nRECOVERY PHRASE — 79 words. Write it down offline. Anyone with it controls the wallet.\n${line}`
    );
    console.log(created.recoveryPhrase);
    console.log(line);
    console.log(`\nSaved: ${KEYS_FILE} (secret), ${RECOVERY_FILE} (secret), ${DEPLOY_FILE}`);
    console.log('\nNext:');
    console.log(
        `  1. Send at least 1 TON to ${fundingAddress} (each operation costs ~0.25 TON in fees).`
    );
    console.log(
        `  2. TO=<address> AMOUNT=0.1 npx blueprint run transfer --${network} --tonconnect`
    );
    console.log('     (the first request activates the wallet automatically)');
    console.log('  3. npx blueprint run status --' + network + ' --tonconnect');
    console.log(
        '\nThis phrase is NOT a standard BIP-39 seed: it only works with this project (scripts/recover.ts).'
    );
}

try {
    main();
} catch (e) {
    console.error(`error: ${(e as Error).message}`);
    process.exit(1);
}
