import {
    Address,
    beginCell,
    Cell,
    Contract,
    contractAddress,
    ContractProvider,
    Sender,
    SendMode
} from '@ton/core';
import { commitBlindedKey } from './crypto';
import { deriveBlindedPreimage } from './keys';
import { MIN_INTERNAL_MSG_VALUE } from './constants';
import {
    buildInitialStorage,
    InitialStorageParams,
    parseStorage,
    XmssWalletStorage
} from './storage';

export class XmssWallet implements Contract {
    constructor(readonly address: Address, readonly init?: { code: Cell; data: Cell }) {}

    static createFromAddress(address: Address) {
        return new XmssWallet(address);
    }

    static createFromConfig(config: InitialStorageParams, code: Cell, workchain = 0) {
        const data = buildInitialStorage(config);
        const init = { code, data };
        return new XmssWallet(contractAddress(workchain, init), init);
    }

    /** Deploys the wallet by sending `value` with StateInit from any funded wallet. */
    async sendDeploy(provider: ContractProvider, via: Sender, value: bigint) {
        await provider.internal(via, {
            value,
            sendMode: SendMode.PAY_GAS_SEPARATELY,
            bounce: false,
            body: beginCell().endCell()
        });
    }

    /** Sends a body produced by signRequest(..., authMode: AUTH.EXTERNAL) as an external message. */
    async sendExternalSigned(provider: ContractProvider, body: Cell) {
        await provider.external(body);
    }

    /**
     * Relays a body produced by signRequest(..., authMode: AUTH.INTERNAL).
     * `via` must be whitelisted; `value` pays the gas (min 0.05 TON).
     */
    async sendInternalSigned(provider: ContractProvider, via: Sender, body: Cell, value: bigint) {
        if (value < MIN_INTERNAL_MSG_VALUE) throw new Error('value must be >= 0.05 TON');
        await provider.internal(via, { value, sendMode: SendMode.PAY_GAS_SEPARATELY, body });
    }

    // ── get methods ────────────────────────────────────────────────────────

    async getSeqno(provider: ContractProvider): Promise<number> {
        return (await provider.get('seqno', [])).stack.readNumber();
    }

    async getWalletId(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_wallet_id', [])).stack.readNumber();
    }

    async getPolicyHash(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_policy_hash', [])).stack.readBigNumber();
    }

    async getRoot(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_root', [])).stack.readBigNumber();
    }

    async getPublicSeed(provider: ContractProvider): Promise<bigint> {
        return (await provider.get('get_public_seed', [])).stack.readBigNumber();
    }

    async getLeafLimit(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_leaf_limit', [])).stack.readNumber();
    }

    async getNextLeaf(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_next_leaf', [])).stack.readNumber();
    }

    async getLeavesRemaining(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_leaves_remaining', [])).stack.readNumber();
    }

    async getTreeHeight(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_tree_height', [])).stack.readNumber();
    }

    async getBlindedKeysRemaining(provider: ContractProvider): Promise<number> {
        return (await provider.get('get_blinded_keys_remaining', [])).stack.readNumber();
    }

    async getIsWhitelisted(provider: ContractProvider, addr: Address): Promise<boolean> {
        const res = await provider.get('is_whitelisted', [
            { type: 'slice', cell: beginCell().storeAddress(addr).endCell() }
        ]);
        return res.stack.readBoolean();
    }

    /** True once the contract code is on-chain. */
    async isActive(provider: ContractProvider): Promise<boolean> {
        return (await provider.getState()).state.type === 'active';
    }

    /**
     * Full decoded storage. For a not-yet-activated wallet opened with `init`, returns the
     * initial storage, so the first request can be signed (and deploys the wallet).
     */
    async getStorage(provider: ContractProvider): Promise<XmssWalletStorage> {
        const state = await provider.getState();
        if (state.state.type === 'active' && state.state.data) {
            return parseStorage(Cell.fromBoc(state.state.data)[0]);
        }
        if (state.state.type !== 'frozen' && this.init) return parseStorage(this.init.data);
        throw new Error(`wallet is not active (state: ${state.state.type}) and no init is known`);
    }

    /**
     * Lowest index i such that the blinded key derived from `blindedMasterSeed` at i
     * is still present on-chain. Returns -1 if none of the first `scanLimit` is available.
     */
    async getUnusedBlindedIndex(
        provider: ContractProvider,
        blindedMasterSeed: bigint,
        scanLimit = 1024
    ): Promise<number> {
        const { blindedKeys } = await this.getStorage(provider);
        for (let i = 0; i < scanLimit; i++) {
            if (blindedKeys.has(commitBlindedKey(deriveBlindedPreimage(blindedMasterSeed, i))))
                return i;
        }
        return -1;
    }
}
