// Basechain fee parameters as on TON mainnet after the 2026 gas-price cut (6x cheaper).
// Fetched 2026-10-29 via toncenter `getConfigParam`. The sandbox default config still carries
// the old prices (400 nanoTON per gas unit), so tests patch these params in to report real fees.
import { beginCell, Cell, Dictionary } from '@ton/core';
import { Blockchain } from '@ton/sandbox';

const MAINNET_PARAMS: Record<number, string> = {
    // GasLimitsPrices, basechain: 66.67 nanoGRAM/gas, gas_limit 1M, gas_credit 10k
    21: 'te6cckEBAQEATAAAlNEAAAAAAAAAZAAAAAAAABoL3gAAAAAAQqqrAAAAAAAPQkAAAAAAAA9CQAAAAAAAACcQAAAAAACYloAAAAAABfXhAAAAAAA7msoAgyFv5Q==',
    // MsgForwardPrices, basechain
    25: 'te6cckEBAQEAIwAAQuoAAAAAAAEEawAAAAAAQqqrAAAAABoKqqsAAYAAVVVVVXUQ/H0='
};

export function useMainnetFees(blockchain: Blockchain) {
    const dict = Dictionary.loadDirect(
        Dictionary.Keys.Int(32),
        Dictionary.Values.Cell(),
        blockchain.config
    );
    for (const [id, boc] of Object.entries(MAINNET_PARAMS)) {
        if (boc) dict.set(Number(id), Cell.fromBase64(boc));
    }
    blockchain.setConfig(beginCell().storeDictDirect(dict).endCell());
}
