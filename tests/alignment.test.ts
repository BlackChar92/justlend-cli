import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { getApiHost, getMoolahApiHost, getJustLendAddresses } from '../src/lib/chains.js';
import { registerRewardsCommand } from '../src/commands/rewards.js';
const env = { ...process.env };
afterEach(() => { mock.restoreAll(); process.env = { ...env }; });
for (const network of ['', 'unknown', 'mainnett', 'eth']) {
  it(`rejects ${JSON.stringify(network)} even with an API override`, () => {
    process.env.JUSTLEND_API_HOST = 'https://labc.ablesdxd.link';
    process.env.JUSTLEND_MOOLAH_API_HOST = 'https://zenvora.ablesdxd.link';
    assert.throws(() => getApiHost(network), /Unsupported network/);
    assert.throws(() => getMoolahApiHost(network), /Unsupported network/);
  });
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/deployments.verified.json', import.meta.url), 'utf8'));
for (const item of fixture.assertions) it(`${item.network} ${item.path} matches independently verified source`, () => {
  assert.deepEqual(item.path.split('.').reduce((row: any, key: string) => row[key], getJustLendAddresses(item.network)), item.expected);
});
for (const data of [null, {}, { assetList: null }]) it(`missing V1 rewards response is unavailable, not zero: ${JSON.stringify(data)}`, async () => {
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ code: 0, data })));
  let output = '';
  mock.method(process.stdout, 'write', (value: unknown) => { output += value; return true; });
  const program = new Command().option('--network <network>', '', 'nile').option('--json', '', true);
  registerRewardsCommand(program);
  await program.parseAsync(['rewards', 'summary', 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb'], { from: 'user' });
  const result = JSON.parse(output).data;
  assert.equal(result.v1.status, 'unavailable');
  assert.equal(result.v1.totalUnclaimedUSD, undefined);
});
it('does not present historical SUN registry as current campaign evidence', () => {
  const source = readFileSync(new URL('../src/commands/sun.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /only active mining|only currently-active mining|currently ships only ONE active/);
  assert.match(source, /legacy/);
});
