import { Blockchain, SandboxContract, SendMessageResult, TreasuryContract } from '@ton/sandbox';
import { beginCell, Cell, fromNano, internal, storeMessageRelaxed, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import { setGasCredit, useMainnetFees } from './network-config';
import '@ton/test-utils';
import {
    AUTH,
    authPath,
    blindedCommitments,
    buildProof,
    commitBlindedKey,
    deriveBlindedPreimage,
    hashRequest,
    REQ,
    RotateRootRequest,
    wotsSign,
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

    const rotateTo = (next: Signer): RotateRootRequest => ({
        type: 'rotate_root',
        newRoot: treeRoot(next.tree),
        newPublicSeed: next.keys.publicSeed,
        newPolicy: next.keys.policy,
        newLimit: 128,
        newBlindedCommitments: blindedCommitments(next.keys.blindedMasterSeed, 128)
    });

    /** Keeps the genuine proof header (seqno, leaf, pub_seed) but garbles the signature. */
    const forge = (body: Cell, payload: Cell) => {
        const proof = body.refs[0];
        const forgedProof = beginCell()
            .storeBits(proof.beginParse().loadBits(8 + 64 + 256))
            .storeUint(0, 256)
            .storeUint(0, 256)
            .storeRef(proof.refs[0])
            .endCell();
        return buildBody(AUTH.EXTERNAL, forgedProof, payload);
    };

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
            `external transfer: gasUsed=${cp.gasUsed} computeFee=${fromNano(cp.gasFees)} GRAM ` +
                `totalFees=${fromNano(r.transactions[0].totalFees.coins)} GRAM ` +
                `bodyCells=${countCells(signed.body)}`
        );
    });

    it('pre-accept checks fit the 10k gas credit with a safety margin (accepted at 8000)', async () => {
        setGasCredit(blockchain, 8000); // measured usage ≈ 7000
        const r = await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
        expect(r.transactions).toHaveTransaction({ on: wallet.address, success: true });
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

    describe('griefing protection (storage v3)', () => {
        it('a forged proof is charged once, burns the attempt and cannot be replayed', async () => {
            // An attacker who saw a pending message knows a valid (seqno, leaf, pub_seed, blinded preimage).
            const signed = await sign(transfer());
            const forged = forge(signed.body, signed.payload);

            const balance0 = (await blockchain.getContract(wallet.address)).balance;
            const r1 = await wallet.sendExternalSigned(forged);
            expect(r1.transactions).toHaveTransaction({
                on: wallet.address,
                exitCode: ERR.INVALID_SIGNATURE, // attempt committed (burned) before the throw
                outMessagesCount: 0
            });
            const spent = balance0 - (await blockchain.getContract(wallet.address)).balance;
            console.log(`griefing: one forged external cost the wallet ${fromNano(spent)} GRAM`);

            // The attempt was burned: seqno, leaf and blinded key moved on although it failed.
            expect(await wallet.getSeqno()).toBe(1);
            expect(await wallet.getNextLeaf()).toBe(1);
            expect(await wallet.getBlindedKeysRemaining()).toBe(127);

            // Neither the forgery nor the leaked genuine message can be accepted again (free rejection).
            await expect(wallet.sendExternalSigned(forged)).rejects.toThrow();
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();

            // The owner simply signs a new request with the next leaf — no WOTS+ key reuse.
            const ok = await wallet.sendExternalSigned((await sign(transfer())).body);
            expect(ok.transactions).toHaveTransaction({ on: wallet.address, success: true });
            expect(await wallet.getNextLeaf()).toBe(2);
        });

        it('an expired message is rejected before accept (free, nothing changes)', async () => {
            const signed = await sign(transfer(), { validUntil: blockchain.now! + 60 });
            blockchain.now = blockchain.now! + 120;
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(0);
            expect(await wallet.getNextLeaf()).toBe(0);
        });

        it('valid_until more than 24 h ahead is rejected before accept', async () => {
            const header = await sign(transfer());
            const far = buildPayload(
                {
                    walletId: 1,
                    validUntil: blockchain.now! + 2 * 86400,
                    seqno: 0,
                    policy: signer.keys.policy,
                    blindedPreimage: header.blindedPreimage
                },
                transfer()
            );
            const body = buildBody(AUTH.EXTERNAL, header.body.refs[0], far);
            await expect(wallet.sendExternalSigned(body)).rejects.toThrow();
        });

        it('a wrong wallet_id is rejected before accept', async () => {
            const s: Signer = { keys: { ...signer.keys, walletId: 2 }, tree: signer.tree };
            await expect(
                wallet.sendExternalSigned((await sign(transfer(), { s })).body)
            ).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(0);
        });

        it('a wrong policy is rejected before accept', async () => {
            const s: Signer = { keys: { ...signer.keys, policy: 42n }, tree: signer.tree };
            await expect(
                wallet.sendExternalSigned((await sign(transfer(), { s })).body)
            ).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(0);
        });

        it('any post-accept failure (here: a forbidden send mode) burns the leaf', async () => {
            const s = await wallet.getStorage();
            const blindedPreimage = deriveBlindedPreimage(signer.keys.blindedMasterSeed, 0);
            const payload = beginCell()
                .storeUint(1, 32)
                .storeUint(blockchain.now! + 600, 32)
                .storeUint(s.seqno, 32)
                .storeUint(signer.keys.policy, 256)
                .storeUint(REQ.TRANSFER, 8)
                .storeUint(blindedPreimage, 256)
                .storeUint(128, 8) // mode 128 — rejected by validate_send_mode
                .storeRef(
                    beginCell()
                        .store(
                            storeMessageRelaxed(
                                internal({ to: recipient.address, value: 0n, bounce: false })
                            )
                        )
                        .endCell()
                )
                .endCell();
            const msgHash = hashRequest(
                wallet.address,
                payload,
                REQ.TRANSFER,
                AUTH.EXTERNAL,
                commitBlindedKey(blindedPreimage)
            );
            const sig = wotsSign(signer.keys.secretSeed, signer.keys.publicSeed, 0, msgHash);
            const proof = buildProof(0, signer.keys.publicSeed, sig, authPath(signer.tree, 0));
            const r = await wallet.sendExternalSigned(buildBody(AUTH.EXTERNAL, proof, payload));
            expect(r.transactions).toHaveTransaction({
                on: wallet.address,
                exitCode: ERR.BAD_MODE, // attempt committed (burned) before the throw
                outMessagesCount: 0
            });
            expect(await wallet.getNextLeaf()).toBe(1);
            expect(await wallet.getSeqno()).toBe(1);
        });

        it('SDK refuses send mode 128', () => {
            const header = {
                walletId: 1,
                validUntil: blockchain.now! + 600,
                seqno: 0,
                policy: signer.keys.policy,
                blindedPreimage: 0n
            };
            expect(() => buildPayload(header, transfer('1', 128))).toThrow(/not allowed/);
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
                )} GRAM`
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

        it('the last leaf is reserved for rotate_root, so the wallet cannot freeze', async () => {
            await deploy(signer, 2);
            await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            expect(await wallet.getLeavesRemaining()).toBe(1);

            // A transfer on the last leaf is refused for free.
            await expect(
                wallet.sendExternalSigned((await sign(transfer('0.1'))).body)
            ).rejects.toThrow();
            expect(await wallet.getSeqno()).toBe(1);

            const next = makeSigner();
            const r = await wallet.sendExternalSigned((await sign(rotateTo(next))).body);
            expect(r.transactions).toHaveTransaction({ on: wallet.address, success: true });
            expect(await wallet.getRoot()).toBe(treeRoot(next.tree));
            expect(await wallet.getLeavesRemaining()).toBe(128);
        });

        it('a forged rotation on the last leaf does not burn it: externals lock until the message expires', async () => {
            await deploy(signer, 2);
            await wallet.sendExternalSigned((await sign(transfer('0.1'))).body);
            const next = makeSigner();
            const validUntil = blockchain.now! + 300;
            const signed = await sign(rotateTo(next), { validUntil });

            const r = await wallet.sendExternalSigned(forge(signed.body, signed.payload));
            expect(r.transactions).toHaveTransaction({
                on: wallet.address,
                exitCode: ERR.INVALID_SIGNATURE, // attempt committed (burned) before the throw
                outMessagesCount: 0
            });
            expect(await wallet.getLeavesRemaining()).toBe(1); // not burned
            expect(await wallet.getExternalLockUntil()).toBe(validUntil);

            // Locked: neither the forgery nor the leaked genuine message is accepted (free).
            await expect(wallet.sendExternalSigned(signed.body)).rejects.toThrow();

            // The relayer path is not locked: the owner can still rotate right away.
            const relayed = await sign(rotateTo(next), { authMode: AUTH.INTERNAL });
            const rr = await wallet.sendInternalSigned(
                relayer.getSender(),
                relayed.body,
                toNano('0.1')
            );
            expect(rr.transactions).toHaveTransaction({ to: wallet.address, success: true });
            expect(await wallet.getRoot()).toBe(treeRoot(next.tree));
            expect(await wallet.getExternalLockUntil()).toBe(0);
        });

        it('rotation rejects a tree with fewer than 2 leaves (SDK)', () => {
            const next = makeSigner();
            expect(() =>
                buildPayload(
                    {
                        walletId: 1,
                        validUntil: blockchain.now! + 600,
                        seqno: 0,
                        policy: 0n,
                        blindedPreimage: 0n
                    },
                    { ...rotateTo(next), newLimit: 1 }
                )
            ).toThrow(/2\.\.128/);
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
            exitCode: ERR.INVALID_SIGNATURE, // attempt committed (burned) before the throw
            outMessagesCount: 0
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
