import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { registerMiningCommands } from '../src/commands/mining.js';

const OWNER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

describe('mining claim informational status', () => {
  afterEach(() => mock.restoreAll());

  function harness(payload: Record<string, unknown>, network = 'mainnet') {
    const output: string[] = [];
    const fetch = mock.method(globalThis, 'fetch', async () =>
      new Response(JSON.stringify({ code: 0, data: payload }), { status: 200 }));
    mock.method(process.stdout, 'write', (chunk: unknown) => { output.push(String(chunk)); return true; });
    const program = new Command().option('--network <network>', '', network).option('--json', '', true);
    registerMiningCommands(program);
    return {
      fetch,
      run: () => program.parseAsync(['mining', 'claim', 'round', '--address', OWNER], { from: 'user' }),
      result: () => JSON.parse(output.join('')).data,
    };
  }

  for (const proof of [[], ['00'.repeat(32)]]) {
    it(`does not promise claimability for an unclaimed payload with ${proof.length} proof entries`, async () => {
      const h = harness({ round: { claimed: false, amount: ['1'], merkleIndex: 0, index: 0, proof } });
      await h.run();
      const result = h.result();
      assert.equal(result.status, 'payload_available');
      assert.equal(result.claimability, 'not_checked');
      assert.equal(result.transactionSubmitted, false);
      assert.equal(result.proofLen, proof.length);
      assert.match(result.nextStep, /airdrop claim/);
      assert.equal(h.fetch.mock.callCount(), 1, 'only the backend read is performed');
    });
  }

  it('reports a backend-claimed round without sending a transaction', async () => {
    const h = harness({ round: { claimed: true } });
    await h.run();
    assert.equal(h.result().status, 'claimed');
    assert.equal(h.result().transactionSubmitted, false);
    assert.match(h.result().reason, /backend/);
  });

  it('rejects a missing round', async () => {
    const h = harness({});
    await assert.rejects(h.run(), /Round 'round' not found/);
  });

  it('rejects Nile before fetching a backend payload', async () => {
    const h = harness({}, 'nile');
    await assert.rejects(h.run(), /mainnet-only/);
    assert.equal(h.fetch.mock.callCount(), 0);
  });
});
