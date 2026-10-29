// Constants mirrored from contracts/xmss_wallet.fc.
// If you change any of these in the contract you MUST change them here too.

export const WOTS_W = 16;
export const WOTS_LOG_W = 4;
export const WOTS_LEN1 = 64;
export const WOTS_LEN2 = 3;
export const WOTS_LEN = WOTS_LEN1 + WOTS_LEN2; // 67
export const WOTS_CSUM_MAX = WOTS_LEN1 * (WOTS_W - 1); // 960

export const TREE_HEIGHT = 7;
export const TREE_MAX_LEAVES = 1 << TREE_HEIGHT; // 128

/** valid_until may be at most this many seconds in the future. */
export const MAX_VALID_UNTIL_DELTA = 86400;

/** Minimum value (nanoTON) for a signed internal (relayed) request. */
export const MIN_INTERNAL_MSG_VALUE = 50_000_000n;

export const PROOF_VERSION = 0x01;
export const STORAGE_VERSION = 2;

export const OP = {
    SIGNED_EXTERNAL: 0x7369676e, // "sign"
    SIGNED_INTERNAL: 0x73696e74 // "sint"
} as const;

export const REQ = {
    TRANSFER: 0x00,
    ROTATE_ROOT: 0x01,
    WL_ADD: 0x02,
    WL_REMOVE: 0x03
} as const;
export type ReqType = (typeof REQ)[keyof typeof REQ];

export const AUTH = {
    EXTERNAL: 1,
    INTERNAL: 2
} as const;
export type AuthMode = (typeof AUTH)[keyof typeof AUTH];

/** Domain-separation tags (32-bit ASCII). */
export const TAG = {
    WOTS_PRF: 0x574f5446, // "WOTF" — off-chain only (secret key derivation)
    WOTS_CHAIN: 0x574f4348, // "WOCH"
    LTREE: 0x4c545245, // "LTRE"
    MERKLE: 0x4d52544c, // "MRTL"
    XMSS_MSG: 0x584d5347, // "XMSG"
    WL_KEY: 0x574c4954, // "WLIT"
    BLINDED_KEY: 0x424c4e44 // "BLND"
} as const;

/** Send modes the contract accepts for REQ.TRANSFER. 128 / 160 are NOT allowed. */
export const ALLOWED_SEND_MODES = [0, 1, 2, 64, 65, 66] as const;

/** Exit codes thrown by the contract. */
export const ERR = {
    INVALID_SEQNO: 133,
    INVALID_WALLET_ID: 134,
    INVALID_SIGNATURE: 135,
    EXPIRED: 136,
    INVALID_OP: 138,
    POLICY_MISMATCH: 148,
    INVALID_LEAF_INDEX: 151,
    WALLET_EXHAUSTED: 153,
    INVALID_PROOF_FORMAT: 154,
    BAD_STORAGE: 156,
    BAD_MODE: 157,
    NOT_WHITELISTED: 158,
    INSUFFICIENT_VALUE: 159,
    INVALID_BLINDED_KEY: 160
} as const;
