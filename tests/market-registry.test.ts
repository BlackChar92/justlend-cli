import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { JUSTLEND_ADDRESSES, TronNetwork } from '../src/lib/chains.js';

describe('JustLend market registry parity with mcp-server-justlend', () => {
  it('keeps the mainnet V2 mining distributor aligned with the app/SDK registry', () => {
    assert.equal(
      JUSTLEND_ADDRESSES[TronNetwork.Mainnet].merkleDistributorV2,
      'TRiE1tGxBitNAMUazZ6Kk7GA36hpPdzUSL',
    );
    assert.equal(
      JUSTLEND_ADDRESSES[TronNetwork.Nile].merkleDistributorV2,
      'TLSPGyZRYeoZsPX2V9tpGYKF85zFyUAb1u',
    );
  });

  it('includes the HTX market on mainnet', () => {
    assert.deepEqual(JUSTLEND_ADDRESSES[TronNetwork.Mainnet].jTokens.jHTX, {
      address: 'TDA1mWPyAjTRATMGA55UTswGAHhV2itEXR',
      underlying: 'TUPM7K8REVzD2UdV4R5fe5M8XbnR2DdoJ6',
      symbol: 'jHTX',
      underlyingSymbol: 'HTX',
      decimals: 8,
      underlyingDecimals: 18,
    });
  });

  it('includes the HTX market on Nile', () => {
    assert.deepEqual(JUSTLEND_ADDRESSES[TronNetwork.Nile].jTokens.jHTX, {
      address: 'TD6FMHLmG4uGq9JqVuSX1NgvBeS2HbuRAt',
      underlying: 'TC9wyHyAQqnvz6oQBfoLMu4kJpfqdp9nMY',
      symbol: 'jHTX',
      underlyingSymbol: 'HTX',
      decimals: 8,
      underlyingDecimals: 18,
    });
  });
});
