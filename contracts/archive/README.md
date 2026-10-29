# Archive

Earlier iterations of the XMSS wallet, kept for history. Not maintained, not tested, do not deploy.
The current contract is `../xmss_wallet.fc`.

| File | Notes |
| --- | --- |
| `xmss_wallet_v0.fc` | First RFC 8391-inspired draft with separate user/admin trees |
| `xmss_wallet_v1.fc`, `xmss_wallet_v2.fc` | Intermediate versions |
| `xmss_wallet_v3.fc` | Blinded keys introduced |
| `xmss_wallet_v4_storage_v2.fc` | First published version (storage v2, code hash `ff6a94b4…f5d7`), deployed on testnet. Has the fee-griefing and freeze issues fixed in the current contract (see docs/SECURITY.md). The SDK can still read and sign for it. |
