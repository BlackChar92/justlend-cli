import { afterEach, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Command } from 'commander';
import { createRiskAlertReadClient } from '../src/lib/risk-alerts.js';
import { registerAlertCommands } from '../src/commands/alerts.js';
const address = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const baseUrl = 'https://alerts.example.test';
afterEach(() => mock.restoreAll());
const response = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
for (const [command, payload, path, body] of [
  ['list', { emailBound: false, alerts: [] }, 'list', { address }],
  ['rules', [{ alertType: 1, thresholds: [{ conditionKey: 'ALERT', value: null }] }], 'rule-defaults', undefined],
  ['markets', [{ marketId: 'm1', marketStatus: 'unavailable' }], 'v2/markets', { address, chain: 'tron' }]
] as const) it(`alerts ${command} is a wallet-free public read`, async () => {
  const fetch = mock.method(globalThis, 'fetch', async () => response(payload));
  let output = '';
  mock.method(process.stdout, 'write', (value: unknown) => { output += value; return true; });
  const program = new Command().option('--network <network>', '', 'mainnet').option('--json', '', true);
  registerAlertCommands(program);
  await program.parseAsync(['alerts', '--api-url', baseUrl, command, ...(command === 'rules' ? [] : [address])], { from: 'user' });
  const result = JSON.parse(output).data;
  assert.equal(result.network, 'mainnet');
  assert.equal(result.transactionSubmitted, false);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, options] = fetch.mock.calls[0].arguments as unknown as [string, RequestInit];
  assert.equal(url, `${baseUrl}/notice/alert/${path}`);
  assert.equal(options.method, command === 'rules' ? 'GET' : 'POST');
  assert.deepEqual(options.body ? JSON.parse(String(options.body)) : undefined, body);
});
it('exposes no write command and does not initialize a wallet', () => {
  const program = new Command(); registerAlertCommands(program);
  assert.deepEqual(program.commands[0].commands.map(cmd => cmd.name()), ['list', 'rules', 'markets']);
});
for (const network of ['nile', '', 'eth']) it(`fails closed for ${network}`, () => {
  assert.throws(() => createRiskAlertReadClient({ baseUrl, network }), /mainnet/);
});
for (const value of [null, {}, { emailBound: false, alerts: null }, { emailBound: 'false', alerts: [] }]) it(`does not synthesize empty success for ${JSON.stringify(value)}`, async () => {
  const fetch = mock.fn(async () => response(value));
  await assert.rejects(createRiskAlertReadClient({ baseUrl, fetch }).list(address), /response/);
});
it('omits email, session and signatures from public output', async () => {
  const fetch = mock.fn(async () => response({ emailBound: true, email: 'private@example.test', cookieId: 'secret', alerts: [{ id: 'a1', alertType: 1, enabled: true, signature: 'secret' }] }));
  assert.deepEqual(await createRiskAlertReadClient({ baseUrl, fetch }).list(address), { emailBound: true, alerts: [{ id: 'a1', alertType: 1, enabled: true }] });
});
it('does not echo server errors or treat failures as an empty list', async () => {
  const fetch = mock.fn(async () => new Response('private@example.test secret', { status: 500 }));
  await assert.rejects(createRiskAlertReadClient({ baseUrl, fetch }).rules(), error => error instanceof Error && /unknown/.test(error.message) && !/private@|secret/.test(error.message));
});
