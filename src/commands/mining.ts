import { Command } from 'commander';
import { fetchMoolahJson } from '../lib/api/v2.js';
import { getNetworkFromCommand, requireMoolahMainnet, shorten } from '../lib/command-utils.js';
import { outputList, outputResult } from '../lib/output.js';
import { validateAddress } from '../lib/tronweb.js';

function firstList(payload: any): any[] {
  return payload?.list ?? payload?.records ?? payload?.rows ?? payload?.data ?? payload?.periods ?? [];
}

export function registerMiningCommands(program: Command): void {
  const mining = program.command('mining').description('V2 Moolah mining reward commands');

  mining.command('apy <vaultAddress>').description('Show V2 vault mining APY').action(async function (this: Command, vaultAddress: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    requireMoolahMainnet(network);
    const data = await fetchMoolahJson<Record<string, unknown>>(network, '/v2/tronbull', { pool: vaultAddress });
    outputResult(data, `Mining APY ${shorten(vaultAddress)}`, Boolean(opts.json));
  });

  mining.command('accruing <address>').description('Show currently accruing V2 mining rewards').action(async function (this: Command, address: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    requireMoolahMainnet(network);
    const data = await fetchMoolahJson<any>(network, '/v2/tronbullish', { addr: address });
    const rows = firstList(data);
    if (rows.length) outputList(rows, `Accruing Mining Rewards ${shorten(address)}`, Boolean(opts.json));
    else outputResult(data, `Accruing Mining Rewards ${shorten(address)}`, Boolean(opts.json));
  });

  mining.command('pending <address>').description('Show pending V2 mining reward periods').action(async function (this: Command, address: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    requireMoolahMainnet(network);
    const data = await fetchMoolahJson<any>(network, '/v2/getAllUnClaimedAirDrop', { addr: address, getUnclaimedOnly: 'true' });
    const rows = firstList(data);
    if (rows.length) outputList(rows, `Pending Mining Rewards ${shorten(address)}`, Boolean(opts.json));
    else outputResult(data, `Pending Mining Rewards ${shorten(address)}`, Boolean(opts.json));
  });

  mining.command('resolver <vaultAddress>').description('Show V2 mining resolver config').action(async function (this: Command, vaultAddress: string) {
    const opts = this.optsWithGlobals();
    const network = getNetworkFromCommand(this);
    requireMoolahMainnet(network);
    const data = await fetchMoolahJson<Record<string, unknown>>(network, '/v2/tronbull');
    outputResult(data, `Mining Resolver ${shorten(vaultAddress)}`, Boolean(opts.json));
  });

  for (const commandName of ['claim-info', 'claim']) {
    mining.command(`${commandName} <periodKey>`)
      .description(commandName === 'claim' ? '[deprecated read-only alias] Use mining claim-info' : 'Read V2 mining claim payload status; never signs')
      .requiredOption('--address <owner>', 'Owner address used to resolve the period payload')
      .action(async function (this: Command, periodKey: string) {
        const opts = this.optsWithGlobals();
        const network = getNetworkFromCommand(this);
        requireMoolahMainnet(network);
        const owner = (this.opts() as { address: string }).address;
        validateAddress(owner, 'owner');
        const raw = await fetchMoolahJson<Record<string, any>>(network, '/v2/getAllUnClaimedAirDrop', { addr: owner, getUnclaimedOnly: 'true' });
        const entry = raw?.[periodKey];
        if (!entry) throw new Error(`Round '${periodKey}' not found for ${owner}`);
        outputResult({
          status: entry.claimed ? 'claimed' : 'payload_available',
          reason: entry.claimed
            ? 'This mining round is already marked claimed by the backend.'
            : 'The backend returned this round. This informational command does not validate the proof, published root, or on-chain claim status.',
          claimability: 'not_checked',
          canonicalCommand: 'mining claim-info',
          deprecatedAlias: commandName === 'claim',
          ...(commandName === 'claim' ? { migration: 'Use mining claim-info; this alias remains read-only.' } : {}),
          transactionSubmitted: false,
          nextStep: entry.claimed ? 'No transaction is required based on the backend status.' : 'Preview with airdrop claim --period <periodKey> --address <owner> --dry-run before submitting a transaction.',
          periodKey,
          merkleIndex: entry.merkleIndex,
          index: entry.index,
          amount: entry.amount,
          proofLen: Array.isArray(entry.proof) ? entry.proof.length : 0,
          claimed: entry.claimed ?? false,
        }, 'V2 Mining Claim Status', Boolean(opts.json));
      });
  }
}
