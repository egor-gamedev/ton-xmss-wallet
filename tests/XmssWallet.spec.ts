import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, fromNano, internal, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { useMainnetFees } from './network-config';
import '@ton/test-utils';
import {
    AUTH,
    blindedCommitments,
    buildBody,
    buildPayload,
    buildTree,
    ERR,
    generateKeySet,
    assertLeafBudget,
    createWallet,
    decodeRecoveryPhrase,
    signRequest,
    treeRoot,
    WalletRequest,
    XmssKeySet,
    XmssTree,
    XmssWallet
} from '../src';

type Signer = { keys: XmssKeySet; tree: XmssTree };

function makeSigner(walletId = 1): Signer {
    const keys = generateKeySet(walletId);
    return { keys, tree: buildTree(keys.secretSeed, keys.publicSeed) };
}

function computePhase(r: SendMessageResult) {
    const d = r.transactions[0].description;
    if (d.type !== 'generic' || d.computePhase.type !== 'vm')
        throw new Error('no vm compute phase');
    return d.computePhase;
}

describe('XmssWallet', () => {
    let code: Cell;
    let signer: Signer;

    beforeAll(async () => {
        code = await compile('xmss_wallet');
        signer = makeSigner();
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let relayer: SandboxContract<TreasuryContract>;
    let recipient: SandboxContract<TreasuryContract>;
    let wallet: SandboxContract<XmssWallet>;

    async function deploy(s: Signer, limit = 128) {
        wallet = blockchain.openContract(
            XmssWallet.createFromConfig(
                {
                    walletId: s.keys.walletId,
                    policy: s.keys.policy,
                    root: treeRoot(s.tree),
                    publicSeed: s.keys.publicSeed,
                    blindedCommitments: blindedCommitments(s.keys.blindedMasterSeed, 128),
                    whitelist: [relayer.address],
                    limit
                },
                code
            )
        );
        const r = await wallet.sendDeploy(deployer.getSender(), toNano('10'));
        expect(r.transactions).toHaveTransaction({
            to: wallet.address,
            deploy: true,
            success: true
        });
    }

    async function sign(
        request: WalletRequest,
        opts: {
            s?: Signer;
            authMode?: 1 | 2;
            leaf?: number;
            blinded?: number;
            validUntil?: number;
        } = {}
    ) {
        const s = opts.s ?? signer;
        return signRequest({
            keys: s.keys,
            tree: s.tree,
            walletAddress: wallet.address,
            seqno: await wallet.getSeqno(),
            leafIndex: opts.leaf ?? (await wallet.getNextLeaf()),
            blindedIndex:
                opts.blinded ?? (await wallet.getUnusedBlindedIndex(s.keys.blindedMasterSeed)),
            validUntil: opts.validUntil ?? blockchain.now! + 600,
            request,
            authMode: opts.authMode
        });
    }

    const transfer = (amount = '1', mode = 1): WalletRequest => ({
        type: 'transfer',
        mode,
        message: internal({ to: recipient.address, value: toNano(amount), bounce: false })
    });

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        useMainnetFees(blockchain);
        blockchain.now = Math.floor(Date.now() / 1000);
        deployer = await blockchain.treasury('deployer');
        relayer = await blockchain.treasury('relayer');
        recipient = await blockchain.treasury('recipient');
        await deploy(signer);
    });

    it('exposes initial state through get methods', async () => {
        expect(await wallet.getSeqno()).toBe(0);
        expect(await wallet.getWalletId()).toBe(1);
        expect(await wallet.getRoot()).toBe(treeRoot(signer.tree));
        expect(await wallet.getPublicSeed()).toBe(signer.keys.publicSeed);
        expect(await wallet.getPolicyHash()).toBe(signer.keys.policy);
        expect(await wallet.getLeafLimit()).toBe(128);
        expect(await wallet.getNextLeaf()).toBe(0);
        expect(await wallet.getLeavesRemaining()).toBe(128);
        expect(await wallet.getTreeHeight()).toBe(7);
        expect(await wallet.getBlindedKeysRemaining()).toBe(128);
        expect(await wallet.getIsWhitelisted(relayer.address)).toBe(true);
        expect(await wallet.getIsWhitelisted(recipient.address)).toBe(false);
    });

    it('executes a signed external transfer and reports its cost', async () => {
        const before = await recipient.getBalance();
        const signed = await sign(transfer('1'));
        const r = await wallet.sendExternalSigned(signed.body);

        expect(r.transactions).toHaveTransaction({
            on: wallet.address,
            success: true,
            outMessagesCount: 1
        });
        expect(r.transactions).toHaveTransaction({
            from: wallet.address,
            to: recipient.address,
            success: true
        });
        expect((await recipient.getBalance()) - before).toBeGreaterThan(toNano('0.99'));
        expect(await wallet.getSeqno()).toBe(1);
        expect(await wallet.getNextLeaf()).toBe(1);
        expect(await wallet.getBlindedKeysRemaining()).toBe(127);

        const cp = computePhase(r);
        console.log(
            `external transfer: gasUsed=${cp.gasUsed} computeFee=${fromNano(cp.gasFees)} TON ` +
                `totalFees=${fromNano(r.transactions[0].totalFees.coins)} TON ` +
                `bodyCells=${countCells(signed.body)}`
        );
    });

    it('sends many transfers in a row (leaves and blinded keys advance together)', async () => {
        for (let i = 0; i < 5; i++) {
            const r = await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            expect(r.transactions).toHaveTransaction({ on: wallet.address, success: true });
        }
        expect(await wallet.getNextLeaf()).toBe(5);
        expect(await wallet.getSeqno()).toBe(5);
        expect(await wallet.getBlindedKeysRemaining()).toBe(123);
    });

    describe('rejected before accept_message (no gas charged)', () => {
        it('replay of an executed message', async () => {
            const signed = await sign(transfer());
            await wallet.sendExternalSigned(signed.body);
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();
        });

        it('wrong leaf index', async () => {
            const signed = await sign(transfer(), { leaf: 5 });
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();
        });

        it('blinded key that was never committed', async () => {
            const signed = await sign(transfer(), { blinded: 500 });
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();
        });

        it('blinded key that was already consumed', async () => {
            await wallet.sendExternalSigned((await sign(transfer(), { blinded: 0 })).body);
            const signed = await sign(transfer(), { blinded: 0 });
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();
        });

        it('signature from a different key set', async () => {
            const other = makeSigner();
            const signed = await sign(transfer(), { s: other, blinded: 0 });
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow(); // pub_seed mismatch
        });
    });

    describe('KNOWN ISSUE: failures after accept_message are paid by the wallet', () => {
        it('a forged proof that passes the cheap header checks is charged and replayable', async () => {
            // An attacker who saw a pending message knows a valid (seqno, leaf, pub_seed, blinded preimage).
            const signed = await sign(transfer());
            const proof = signed.body.refs[0];
            const forgedProof = beginCell()
                .storeBits(proof.beginParse().loadBits(8 + 64 + 256)) // genuine header
                .storeUint(0, 256)
                .storeUint(0, 256)
                .storeRef(proof.refs[0])
                .endCell();
            const forged = buildBody(AUTH.EXTERNAL, forgedProof, signed.payload);

            const balance0 = (await blockchain.getContract(wallet.address)).balance;
            const r1 = await wallet.sendExternalSigned(forged);
            expect(r1.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.INVALID_SIGNATURE
            });
            const r2 = await wallet.sendExternalSigned(forged); // state unchanged -> replayable
            expect(r2.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.INVALID_SIGNATURE
            });
            const spent = balance0 - (await blockchain.getContract(wallet.address)).balance;
            console.log(`griefing: 2 forged externals cost the wallet ${fromNano(spent)} TON`);
            expect(spent).toBeGreaterThan(0n);

            // The genuine message still works afterwards.
            const ok = await wallet.sendExternalSigned(signed.body);
            expect(ok.transactions).toHaveTransaction({ on: wallet.address, success: true });
        });

        it('an expired message is accepted, fails with exit 136, and can be replayed by anyone', async () => {
            const signed = await sign(transfer(), { validUntil: blockchain.now! + 60 });
            blockchain.now = blockchain.now! + 120;
            const r1 = await wallet.sendExternalSigned(signed.body);
            expect(r1.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.EXPIRED
            });
            const r2 = await wallet.sendExternalSigned(signed.body);
            expect(r2.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.EXPIRED
            });
            expect(await wallet.getNextLeaf()).toBe(0); // the same WOTS+ leaf must be signed again => key reuse
        });
    });

    describe('post-accept validation', () => {
        it('rejects send mode 128 (carry all balance)', async () => {
            const header = {
                walletId: 1,
                validUntil: blockchain.now! + 600,
                seqno: 0,
                policy: signer.keys.policy,
                blindedPreimage: 0n
            };
            expect(() => buildPayload(header, transfer('1', 128))).toThrow(/not allowed/);
        });

        it('rejects a wrong wallet_id with exit 134', async () => {
            const s: Signer = { keys: { ...signer.keys, walletId: 2 }, tree: signer.tree };
            const r = await wallet.sendExternalSigned((await sign(transfer(), { s })).body);
            expect(r.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.INVALID_WALLET_ID
            });
        });

        it('rejects a wrong policy with exit 148', async () => {
            const s: Signer = { keys: { ...signer.keys, policy: 42n }, tree: signer.tree };
            const r = await wallet.sendExternalSigned((await sign(transfer(), { s })).body);
            expect(r.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.POLICY_MISMATCH
            });
        });
    });

    describe('internal (relayed) requests', () => {
        it('a whitelisted relayer can submit a signed request and pays the gas', async () => {
            const signed = await sign(transfer('1'), { authMode: AUTH.INTERNAL });
            const r = await wallet.sendInternalSigned(
                relayer.getSender(),
                signed.body,
                toNano('0.5')
            );
            expect(r.transactions).toHaveTransaction({
                from: relayer.address,
                to: wallet.address,
                success: true
            });
            expect(r.transactions).toHaveTransaction({
                from: wallet.address,
                to: recipient.address
            });
            expect(await wallet.getSeqno()).toBe(1);
        });

        it('the 0.05 minimum covers verification gas at current prices (it did not before the 2026 cut)', async () => {
            // No accept_message on this path: gas is capped at msg_value / gas_price.
            // 0.05 GRAM / 66.67 nanoGRAM = 750k gas; at the old 400 nanoTON it was only 125k.
            const signed = await sign(transfer('1'), { authMode: AUTH.INTERNAL });
            const r = await wallet.sendInternalSigned(
                relayer.getSender(),
                signed.body,
                toNano('0.05')
            );
            expect(r.transactions).toHaveTransaction({ to: wallet.address, success: true });
            expect(await wallet.getSeqno()).toBe(1);
        });

        it('a non-whitelisted sender is rejected with exit 158', async () => {
            const signed = await sign(transfer('1'), { authMode: AUTH.INTERNAL });
            const r = await wallet.sendInternalSigned(
                recipient.getSender(),
                signed.body,
                toNano('0.5')
            );
            expect(r.transactions).toHaveTransaction({
                to: wallet.address,
                success: false,
                exitCode: ERR.NOT_WHITELISTED
            });
        });

        it('an external signature cannot be relayed internally (auth mode is signed)', async () => {
            const signed = await sign(transfer('1'), { authMode: AUTH.EXTERNAL });
            const internalBody = buildBody(AUTH.INTERNAL, signed.body.refs[0], signed.payload);
            const r = await wallet.sendInternalSigned(
                relayer.getSender(),
                internalBody,
                toNano('0.5')
            );
            expect(r.transactions).toHaveTransaction({
                to: wallet.address,
                success: false,
                exitCode: ERR.INVALID_SIGNATURE
            });
        });

        it('plain top-ups are accepted from anyone', async () => {
            const r = await recipient.send({
                to: wallet.address,
                value: toNano('1'),
                body: beginCell().endCell()
            });
            expect(r.transactions).toHaveTransaction({ to: wallet.address, success: true });
        });
    });

    describe('whitelist management', () => {
        it('adds and removes an address (each change consumes one leaf)', async () => {
            await wallet.sendExternalSigned(
                (
                    await sign({ type: 'wl_add', address: recipient.address })
                ).body
            );
            expect(await wallet.getIsWhitelisted(recipient.address)).toBe(true);
            await wallet.sendExternalSigned(
                (
                    await sign({ type: 'wl_remove', address: relayer.address })
                ).body
            );
            expect(await wallet.getIsWhitelisted(relayer.address)).toBe(false);
            expect(await wallet.getNextLeaf()).toBe(2);
        });
    });

    describe('key rotation', () => {
        it('rotates to a fresh tree; old keys stop working, new keys work', async () => {
            await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            const next = makeSigner();
            const r = await wallet.sendExternalSigned(
                (
                    await sign({
                        type: 'rotate_root',
                        newRoot: treeRoot(next.tree),
                        newPublicSeed: next.keys.publicSeed,
                        newPolicy: next.keys.policy,
                        newLimit: 128,
                        newBlindedCommitments: blindedCommitments(next.keys.blindedMasterSeed, 128)
                    })
                ).body
            );
            expect(r.transactions).toHaveTransaction({ on: wallet.address, success: true });
            console.log(
                `rotate_root: gasUsed=${computePhase(r).gasUsed} totalFees=${fromNano(
                    r.transactions[0].totalFees.coins
                )} TON`
            );
            expect(await wallet.getRoot()).toBe(treeRoot(next.tree));
            expect(await wallet.getNextLeaf()).toBe(0);
            expect(await wallet.getBlindedKeysRemaining()).toBe(128);

            await expect(
                wallet.sendExternalSigned((await sign(transfer(), { s: signer, blinded: 1 })).body)
            ).rejects.toThrow();
            const ok = await wallet.sendExternalSigned(
                (
                    await sign(transfer('0.1'), { s: next })
                ).body
            );
            expect(ok.transactions).toHaveTransaction({ on: wallet.address, success: true });
        });

        it('KNOWN ISSUE: once every leaf is spent the wallet is frozen forever', async () => {
            await deploy(signer, 2);
            await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            expect(await wallet.getLeavesRemaining()).toBe(0);
            const next = makeSigner();
            const r = await wallet.sendExternalSigned(
                (
                    await sign({
                        type: 'rotate_root',
                        newRoot: treeRoot(next.tree),
                        newPublicSeed: next.keys.publicSeed,
                        newPolicy: next.keys.policy,
                        newLimit: 128,
                        newBlindedCommitments: blindedCommitments(next.keys.blindedMasterSeed, 128)
                    })
                ).body
            );
            expect(r.transactions).toHaveTransaction({
                on: wallet.address,
                success: false,
                exitCode: ERR.WALLET_EXHAUSTED
            });
        });
    });

    it('createWallet(): fund the address, the first signed external activates the wallet', async () => {
        const created = createWallet({ code, walletId: 7 });
        expect(decodeRecoveryPhrase(created.recoveryPhrase).address.equals(created.address)).toBe(
            true
        );
        await deployer.send({ to: created.address, value: toNano('3'), bounce: false });
        wallet = blockchain.openContract(created.wallet);
        expect(await wallet.isActive()).toBe(false);

        const s = await wallet.getStorage(); // falls back to init data
        const signed = signRequest({
            keys: created.keys,
            tree: created.tree,
            walletAddress: wallet.address,
            seqno: s.seqno,
            leafIndex: s.nextLeaf,
            blindedIndex: await wallet.getUnusedBlindedIndex(created.keys.blindedMasterSeed),
            validUntil: blockchain.now! + 600,
            request: transfer('1')
        });
        const r = await wallet.sendExternalSigned(signed.body);
        expect(r.transactions).toHaveTransaction({
            on: wallet.address,
            success: true,
            deploy: true
        });
        expect(r.transactions).toHaveTransaction({ from: wallet.address, to: recipient.address });
        expect(await wallet.isActive()).toBe(true);
        expect(await wallet.getWalletId()).toBe(7);
    });

    it('signatures are bound to the wallet address', async () => {
        const signed = await sign(transfer());
        const twin = blockchain.openContract(
            XmssWallet.createFromConfig(
                {
                    walletId: 1,
                    policy: signer.keys.policy,
                    root: treeRoot(signer.tree),
                    publicSeed: signer.keys.publicSeed,
                    blindedCommitments: blindedCommitments(signer.keys.blindedMasterSeed, 128),
                    whitelist: [] // different init data -> different address
                },
                code
            )
        );
        await twin.sendDeploy(deployer.getSender(), toNano('2'));
        const r = await twin.sendExternalSigned(signed.body);
        expect(r.transactions).toHaveTransaction({
            on: twin.address,
            success: false,
            exitCode: ERR.INVALID_SIGNATURE
        });
    });

    it('assertLeafBudget reserves the last leaf for rotate_root', () => {
        const rotate: WalletRequest = {
            type: 'rotate_root',
            newRoot: 1n,
            newPublicSeed: 1n,
            newPolicy: 1n,
            newLimit: 128,
            newBlindedCommitments: [1n]
        };
        expect(() => assertLeafBudget(126, 128, transfer())).not.toThrow();
        expect(() => assertLeafBudget(127, 128, transfer())).toThrow(/reserved/);
        expect(() => assertLeafBudget(127, 128, rotate)).not.toThrow();
        expect(() => assertLeafBudget(128, 128, rotate)).toThrow(/exhausted/);
    });
});

function countCells(c: Cell, seen = new Set<string>()): number {
    const k = c.hash().toString('hex');
    if (seen.has(k)) return 0;
    seen.add(k);
    return 1 + c.refs.reduce((n, r) => n + countCells(r, seen), 0);
}
