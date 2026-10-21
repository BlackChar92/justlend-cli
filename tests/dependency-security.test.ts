import { createRequire } from 'node:module';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Exercise the parser and proxy resolver actually loaded by the signing UI.
const signerRequire = createRequire(import.meta.resolve('tronlink-signer'));
const expressRequire = createRequire(signerRequire.resolve('express'));
const proxyAddr = expressRequire('proxy-addr');
const qs = expressRequire('qs');

describe('patched HTTP dependency boundaries', () => {
  // GHSA-jqcg-44mw-7w3h: short IPv6 prefixes must not trust arbitrary IPv4 hops.
  for (const subnet of ['::ffff:10.0.0.0/8', '::/1']) {
    it(`${subnet} does not trust an external IPv4 client`, () => {
      const trust = proxyAddr.compile(subnet);
      assert.equal(trust('203.0.113.9', 0), false);
      const req = {
        socket: { remoteAddress: '203.0.113.9' },
        headers: { 'x-forwarded-for': '10.1.2.3' },
      };
      assert.equal(proxyAddr(req, trust), '203.0.113.9');
    });
  }

  it('preserves correctly scoped IPv4 and IPv4-mapped IPv6 trust', () => {
    for (const subnet of ['10.0.0.0/8', '::ffff:10.0.0.0/104']) {
      const trust = proxyAddr.compile(subnet);
      assert.equal(trust('10.1.2.3', 0), true);
      assert.equal(trust('203.0.113.9', 0), false);
    }
  });

  // GHSA-x5fp-wj9c-mxmx: bracket keys must not bypass comma-array limits.
  for (const input of ['a=1,2,3,4', 'a[]=1,2,3,4']) {
    it(`rejects oversized comma arrays in ${input}`, () => {
      assert.throws(() => qs.parse(input, {
        comma: true, arrayLimit: 3, throwOnLimitExceeded: true,
      }), RangeError);
    });
  }

  it('still parses a comma array within its configured limit', () => {
    assert.deepEqual(qs.parse('a=1,2,3', {
      comma: true, arrayLimit: 3, throwOnLimitExceeded: true,
    }), { a: ['1', '2', '3'] });
  });
});
