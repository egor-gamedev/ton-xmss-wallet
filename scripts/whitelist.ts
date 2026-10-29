// Adds or removes a relayer address in the whitelist (consumes one leaf).
//   ACTION=add ADDRESS=<addr> npx blueprint run whitelist --testnet --tonconnect
import { Address } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';
import { env, loadKeys, signAndSend } from './lib/common';

export async function run(provider: NetworkProvider) {
    const action = env('ACTION');
    if (action !== 'add' && action !== 'remove') throw new Error('ACTION must be add or remove');
    await signAndSend(provider, loadKeys(), {
        type: action === 'add' ? 'wl_add' : 'wl_remove',
        address: Address.parse(env('ADDRESS'))
    });
}
