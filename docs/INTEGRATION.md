# Integration guide

Everything is in the TypeScript SDK (`src/`, import from `./src` or the package root).
A complete, runnable template is [`examples/quickstart.ts`](../examples/quickstart.ts)
(`npm run example`, local sandbox, no network).

## 1. Create a wallet

CLI (one command, offline):

```bash
npm run create-wallet
```

Prints the address and the 79-word recovery phrase and writes `keys/wallet.keys.json`,
`keys/wallet.recovery.txt`, `keys/wallet.deploy.json`. Add `-- --json` for machine-readable
output, `NETWORK=mainnet` for mainnet. It refuses to overwrite an existing key set.

Code:

```ts
import { Cell } from '@ton/core';
import compiled from './build/xmss_wallet.compiled.json';
import { createWallet, keySetToJson } from './src';

const created = createWallet({ code: Cell.fromHex(compiled.hex), walletId: 1 });
created.address;          // where to send TON (use bounceable: false for the first top-up)
created.recoveryPhrase;   // 79 words — show once, store offline
keySetToJson(created.keys); // persist securely (contains secrets)
created.wallet.init;      // StateInit; keep it until the wallet is active
```

**Activation:** fund the address with a non-bounceable transfer, then send any signed request
through a contract opened *with* `init` (`created.wallet`, or `new XmssWallet(address, init)`).
`provider.external()` attaches StateInit automatically while the account is not active.
Alternative: `scripts/deploy.ts` deploys from another wallet with an internal message.

## 2. Sign and send a request

```ts
import { internal, toNano } from '@ton/core';
import { assertLeafBudget, buildTree, signRequest, XmssWallet } from './src';

const wallet = client.open(new XmssWallet(address, init)); // TonClient / blueprint / sandbox
const tree = buildTree(keys.secretSeed, keys.publicSeed);  // ~1 s, cache it in memory

const request = {
    type: 'transfer' as const,
    mode: 1, // allowed: 0, 1, 2, 64, 65, 66
    message: internal({ to: dest, value: toNano('1'), bounce: false, body: 'memo' })
};

const s = await wallet.getStorage();                 // seqno, nextLeaf, limit, ...
assertLeafBudget(s.nextLeaf, s.limit, request);      // MUST: keeps the last leaf for rotation
const signed = signRequest({
    keys, tree,
    walletAddress: wallet.address,
    seqno: s.seqno,
    leafIndex: s.nextLeaf,                           // always from chain, never a local counter
    blindedIndex: await wallet.getUnusedBlindedIndex(keys.blindedMasterSeed),
    validUntil: Math.floor(Date.now() / 1000) + 600, // ≤ now + 86400
    request
});
await wallet.sendExternalSigned(signed.body);
// Poll getSeqno() until it increases. If it does not, re-broadcast signed.body unchanged.
```

Other request types:

```ts
{ type: 'wl_add', address }      // allow a relayer
{ type: 'wl_remove', address }
{ type: 'rotate_root', newRoot, newPublicSeed, newPolicy, newLimit: 128,
  newBlindedCommitments: blindedCommitments(next.blindedMasterSeed, 128) }
```

Jetton / NFT transfers: put the standard transfer body into `internal({ to: senderJettonWallet,
value: toNano('0.05'), body })`. One outgoing message per request.

## 3. Rotation (mandatory every ≤ 127 operations)

```ts
const next = generateKeySet(keys.walletId, keys.policy);
const nextTree = buildTree(next.secretSeed, next.publicSeed);
// persist `next` BEFORE sending, so a crash cannot lose the new keys
await send({
    type: 'rotate_root',
    newRoot: treeRoot(nextTree),
    newPublicSeed: next.publicSeed,
    newPolicy: next.policy,
    newLimit: 128,
    newBlindedCommitments: blindedCommitments(next.blindedMasterSeed, 128)
});
// after confirmation (get_root == new root): switch to `next`, produce a NEW recovery phrase
```

## 4. Relayer (gasless / anti-griefing) flow

1. Whitelist the relayer: `{ type: 'wl_add', address: relayer }` (or pass `whitelist` at creation).
2. The user signs with `authMode: AUTH.INTERNAL` and hands `signed.body` to the relayer.
3. The relayer sends it: `wallet.sendInternalSigned(via, body, toNano('0.4'))`.
   Attach **≥ 0.4 TON**: no `accept_message` in this path, so gas is capped by the value;
   with 0.1 TON it fails with exit −14. The remainder stays in the user wallet.

The relayer cannot alter the request (it is signed) and cannot replay it (seqno). To remove
external-message griefing entirely, compile with `ALLOW_EXTERNAL = 0` (new code hash /
new address) and use only this path.

## 5. Restore from the recovery phrase

```ts
const r = decodeRecoveryPhrase(phrase);          // address, secretSeed, blindedMasterSeed
const s = await client.open(XmssWallet.createFromAddress(r.address)).getStorage();
const keys = { walletId: s.walletId, policy: s.policy, publicSeed: s.publicSeed,
               secretSeed: r.secretSeed, blindedMasterSeed: r.blindedMasterSeed };
// verify: treeRoot(buildTree(keys.secretSeed, keys.publicSeed)) === s.root
```

CLI: `PHRASE_FILE=phrase.txt npx blueprint run recover --mainnet --tonconnect`.

## 6. Monitoring checklist

- `get_leaves_remaining` ≤ 8 → rotate now; = 1 → only `rotate_root` is allowed.
- `get_blinded_keys_remaining` must stay > 0 (rotation refills it).
- Failed transactions on the wallet with exit 135/136 → someone is griefing; lower the balance
  or switch to relayer mode.
- Error codes: [SPECIFICATION.md §6](SPECIFICATION.md#6-exit-codes).

## SDK reference (exports of `src/index.ts`)

| Module | Main exports |
| --- | --- |
| `create.ts` | `createWallet` |
| `keys.ts` | `generateKeySet`, `deriveBlindedPreimage`, `blindedCommitments`, `defaultPolicyHash`, `keySetToJson/FromJson` |
| `crypto.ts` | `buildTree`, `treeRoot`, `authPath`, `wotsSign`, `rootFromSignature`, `commitBlindedKey`, hex helpers |
| `messages.ts` | `signRequest`, `assertLeafBudget`, `buildPayload`, `buildProof`, `buildBody`, `hashRequest` |
| `storage.ts` | `buildInitialStorage`, `parseStorage`, `whitelistKey` |
| `recovery.ts` | `encodeRecoveryPhrase`, `decodeRecoveryPhrase` |
| `XmssWallet.ts` | contract wrapper: `createFromConfig`, `sendExternalSigned`, `sendInternalSigned`, `sendDeploy`, get methods, `getStorage`, `getUnusedBlindedIndex`, `isActive` |
| `constants.ts` | `REQ`, `AUTH`, `ERR`, `OP`, tree / WOTS parameters |
