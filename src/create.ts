// One-call wallet creation: keys + address + init + recovery phrase. No network access.

import { Address, Cell } from '@ton/core';
import { blindedCommitments, generateKeySet, XmssKeySet } from './keys';
import { buildTree, treeRoot, XmssTree } from './crypto';
import { encodeRecoveryPhrase } from './recovery';
import { XmssWallet } from './XmssWallet';
import { TREE_MAX_LEAVES } from './constants';

export type CreateWalletOptions = {
    /** Compiled contract code (build/xmss_wallet.compiled.json -> Cell.fromHex(hex)). */
    code: Cell;
    walletId?: number;
    workchain?: number;
    /** Relayer addresses allowed to submit signed internal requests. */
    whitelist?: Address[];
};

export type CreatedWallet = {
    keys: XmssKeySet;
    tree: XmssTree;
    /** Wallet contract with `init` attached: the first signed external deploys it. */
    wallet: XmssWallet;
    address: Address;
    /** 79 words. Together with the chain state it restores full control. */
    recoveryPhrase: string;
};

/**
 * Generates a key set and computes the wallet. The wallet becomes active the first time
 * a signed external is sent with its StateInit attached (done automatically by
 * `provider.external()` for contracts opened with `init`), after the address has been
 * funded with a non-bounceable transfer.
 */
export function createWallet(opts: CreateWalletOptions): CreatedWallet {
    const keys = generateKeySet(opts.walletId ?? 1);
    const tree = buildTree(keys.secretSeed, keys.publicSeed);
    const wallet = XmssWallet.createFromConfig(
        {
            walletId: keys.walletId,
            policy: keys.policy,
            root: treeRoot(tree),
            publicSeed: keys.publicSeed,
            blindedCommitments: blindedCommitments(keys.blindedMasterSeed, TREE_MAX_LEAVES),
            whitelist: opts.whitelist ?? []
        },
        opts.code,
        opts.workchain ?? 0
    );
    return {
        keys,
        tree,
        wallet,
        address: wallet.address,
        recoveryPhrase: encodeRecoveryPhrase({
            address: wallet.address,
            secretSeed: keys.secretSeed,
            blindedMasterSeed: keys.blindedMasterSeed
        })
    };
}
