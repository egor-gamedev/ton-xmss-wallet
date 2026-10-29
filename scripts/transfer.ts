// Sends TON from the XMSS wallet.
//   TO=<address> AMOUNT=0.1 [COMMENT=hi] [MODE=1] [BOUNCE=false] npx blueprint run transfer --testnet --tonconnect
// The blueprint sender is not used for signing; it is only required by the CLI.
import { Address, comment, internal, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { env, loadKeys, signAndSend } from './lib/common';

export async function run(provider: NetworkProvider) {
    const message = internal({
        to: Address.parse(env('TO')),
        value: toNano(env('AMOUNT')),
        bounce: process.env.BOUNCE === 'true',
        body: process.env.COMMENT ? comment(process.env.COMMENT) : undefined
    });
    await signAndSend(provider, loadKeys(), {
        type: 'transfer',
        mode: Number(process.env.MODE ?? 1),
        message
    });
}
