import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { handleError, setJsonMode, setQuietMode } from '../src/lib/error.js';
import { EnergyPurchaseError } from '../src/lib/energy-purchase.js';
import { HttpRequestError } from '../src/lib/http.js';

function capture(): { restore: () => void; err: string[]; exits: number[] } {
  const err: string[] = [];
  const exits: number[] = [];
  const origStderr = process.stderr.write.bind(process.stderr);
  const origExit = process.exit;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any) => { err.push(String(chunk)); return true; };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process as any).exit = (code?: number) => {
    exits.push(code ?? 0);
    throw new Error('__process_exit__');
  };
  return {
    err,
    exits,
    restore: () => {
      process.stderr.write = origStderr;
      process.exit = origExit;
    },
  };
}

describe('structured JSON errors', () => {
  let cap: ReturnType<typeof capture>;

  beforeEach(() => {
    cap = capture();
    setJsonMode(true);
    setQuietMode(false);
  });

  afterEach(() => {
    cap.restore();
    setJsonMode(false);
    setQuietMode(false);
  });

  it('emits HTTP request context in JSON mode', () => {
    assert.throws(() => handleError(new HttpRequestError('fetch failed', {
      code: 'V1_MARKETS_FETCH_FAILED',
      module: 'v1.market.list',
      network: 'nile',
      host: 'https://example.invalid',
      path: '/justlend/markets',
      hint: 'Nile V1 market backend may be unavailable.',
    })), /__process_exit__/);

    assert.deepEqual(cap.exits, [1]);
    const payload = JSON.parse(cap.err.join(''));
    assert.equal(payload.schemaVersion, '1.0.0');
    assert.equal(payload.success, false);
    assert.equal(payload.error, 'fetch failed');
    assert.equal(payload.code, 'V1_MARKETS_FETCH_FAILED');
    assert.equal(payload.retryable, true);
    assert.equal(payload.module, 'v1.market.list');
    assert.equal(payload.network, 'nile');
    assert.equal(payload.host, 'https://example.invalid');
    assert.equal(payload.path, '/justlend/markets');
    assert.equal(payload.hint, 'Nile V1 market backend may be unavailable.');
  });

  it('preserves energy purchase codes and retry semantics in JSON mode', () => {
    assert.throws(() => handleError(new EnergyPurchaseError(
      'PAYMENT_RESULT_UNKNOWN',
      'The payment submission result is unknown.',
      { status: 503, retryable: true },
    )), /__process_exit__/);

    assert.deepEqual(cap.exits, [1]);
    const payload = JSON.parse(cap.err.join(''));
    assert.equal(payload.schemaVersion, '1.0.0');
    assert.equal(payload.success, false);
    assert.equal(payload.error, 'The payment submission result is unknown.');
    assert.equal(payload.code, 'PAYMENT_RESULT_UNKNOWN');
    assert.equal(payload.retryable, true);
    assert.equal(payload.module, 'energy.purchase');
    assert.equal(payload.status, 503);
  });
});
