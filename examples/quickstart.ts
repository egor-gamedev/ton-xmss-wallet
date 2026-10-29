// Complete integration template — runs end to end in a local sandbox, no network, no keys needed:
//
//   npm run example
//
// Copy this file into your app and replace the sandbox with a real provider
// (TonClient.open(...) or blueprint's provider.open(...)); the calls are identical.
import { Blockchain } from '@ton/sandbox';
import { Cell, fromNano, internal, toNano } from '@ton/core';
import compiled from '../build/xmss_wallet.compiled.json';
import { assertLeafBudget, createWallet, signRequest, WalletRequest } from '../src';
import { useMainnetFees } from '../tests/network-config';

async function main() {
    const code = Cell.fromHex(compiled.hex);

    // 1. Create the wallet: keys + address + 79-word recovery phrase (offline, ~1 s).
    const created = createWallet({ code, walletId: 1 });
    console.log(
        'address:        ',
        created.address.toString({ bounceable: false, testOnly: true })
    );
    console.log(
        'recovery phrase:',
        created.recoveryPhrase.split(' ').slice(0, 6).join(' '),
        '... (79 words)'
    );

    // 2. Fund the (not yet deployed) address with a non-bounceable transfer.
    const chain = await Blockchain.create();
    useMainnetFees(chain); // current mainnet gas prices
    const funder = await chain.treasury('funder');
    const alice = await chain.treasury('alice');
    await funder.send({ to: created.address, value: toNano('5'), bounce: false });

    // `wallet` carries StateInit, so the first external message also deploys the contract.
    const wallet = chain.openContract(created.wallet);

    // 3. A generic "sign and send" — this is the function to reuse in a real integration.
    async function send(request: WalletRequest) {
        const s = await wallet.getStorage(); // on-chain seqno / next leaf (or initial state)
        assertLeafBudget(s.nextLeaf, s.limit, request); // never burn the last leaf on a transfer
        const blindedIndex = await wallet.getUnusedBlindedIndex(created.keys.blindedMasterSeed);
        const signed = signRequest({
            keys: created.keys,
            tree: created.tree,
            walletAddress: wallet.address,
            seqno: s.seqno,
            leafIndex: s.nextLeaf,
            blindedIndex,
            validUntil: Math.floor(Date.now() / 1000) + 600,
            request
        });
        const res = await wallet.sendExternalSigned(signed.body);
        return res.transactions[0].totalFees.coins;
    }

    // 4. Use it.
    const fee1 = await send({
        type: 'transfer',
        mode: 1,
        message: internal({ to: alice.address, value: toNano('1'), bounce: false })
    });
    console.log(`transfer #1 (activates the wallet): fee ${fromNano(fee1)} GRAM`);

    const fee2 = await send({
        type: 'transfer',
        mode: 1,
        message: internal({
            to: alice.address,
            value: toNano('0.5'),
            body: 'hello from a post-quantum wallet'
        })
    });
    console.log(`transfer #2: fee ${fromNano(fee2)} GRAM`);

    console.log('leaves remaining:', await wallet.getLeavesRemaining(), '/ 128');
    console.log(
        'wallet balance:  ',
        fromNano((await chain.getContract(wallet.address)).balance),
        'GRAM'
    );
}

main().catch(e => {
    console.error(e);
    process.exit(1);
});
