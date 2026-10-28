import { Command } from 'commander';
import { MERKLE_DISTRIBUTOR_V2_ABI } from '../lib/abis.js';
import { JUSTLEND_ADDRESSES } from '../lib/chains.js';
import { fetchMoolahJson } from '../lib/api/v2.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult, outputList } from '../lib/output.js';
import { sendContractTx } from '../lib/tx.js';
import { validateAddress } from '../lib/tronweb.js';

interface ClaimInput {
  merkleIndex: string | number;
  index: string | number;
  amounts: Array<string | number>;
  merkleProof: string[];
}

interface AirdropEntryRaw {
  merkleIndex?: number;
  index?: number;
  amount?: string | string[];
  tokenSymbol?: string | string[];
  tokenAddress?: string | string[];
  proof?: string[];
  claimed?: boolean;
  [extra: string]: any;
}

const asList = (v: string | string[] | undefined): string[] =>
  v === undefined ? [] : Array.isArray(v) ? v : String(v).split(',');

export function registerAirdropCommands(program: Command): void {
  const airdrop = program.command('airdrop')
    .description('V2 airdrop multiClaim commands (MerkleDistributorV2)');

  airdrop
    .command('list <address>')
    .description('List V2 multi-token airdrop rounds claimable by <address> (calls /v2/getAllUnClaimedAirDrop)')
    .option('--include-claimed', 'Also include already-claimed rounds', false)
    .action(async function (this: Command, address: string) {
      validateAddress(address);
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const includeClaimed = Boolean((this.opts() as any).includeClaimed);
      const raw = await fetchMoolahJson<Record<string, AirdropEntryRaw>>(network, '/v2/getAllUnClaimedAirDrop', {
        addr: address,
        getUnclaimedOnly: includeClaimed ? 'false' : 'true',
      });
      const rounds = Object.entries(raw ?? {}).map(([periodKey, entry]) => {
        const tokens = asList(entry.tokenSymbol);
        const addrs = asList(entry.tokenAddress);
        const amounts = asList(entry.amount);
        return {
          periodKey,
          merkleIndex: entry.merkleIndex,
          index: entry.index,
          claimed: entry.claimed ?? false,
          tokens: tokens.map((sym, i) => ({ symbol: sym, address: addrs[i], amountRaw: amounts[i] })),
          proofLen: entry.proof?.length ?? 0,
        };
      });
      if (rounds.length === 0) {
        outputResult({
          address,
          network,
          status: 'empty',
          note: 'No airdrop rounds returned by /v2/getAllUnClaimedAirDrop. Either no rewards yet, or merkle root not published.',
        }, 'V2 Airdrop Claimables', Boolean(opts.json));
        return;
      }
      outputList(rounds, `V2 Airdrop Claimables (${address})`, Boolean(opts.json));
    });

  airdrop
    .command('claim')
    .description('Call MerkleDistributorV2.multiClaim. Provide --period (resolved from `airdrop list`) or --claims JSON.')
    .option('--period <periodKey>', 'Single round key returned by `airdrop list`')
    .option('--address <address>', 'Owner address (defaults to wallet)')
    .option('--claims <json>', 'JSON array of { merkleIndex, index, amounts, merkleProof } — bypasses backend lookup')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const local = this.opts() as { period?: string; address?: string; claims?: string };
      const network = getNetworkFromCommand(this);
      const distributor = JUSTLEND_ADDRESSES[network].merkleDistributorV2;
      if (!distributor) throw new Error(`MerkleDistributorV2 is not configured for ${network}`);

      let claims: Array<[string, string, string[], string[]]>;
      let preview: Record<string, string>;

      if (local.claims) {
        const parsed = JSON.parse(local.claims) as ClaimInput[];
        if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('--claims must be a non-empty JSON array');
        claims = parsed.map(c => [
          c.merkleIndex.toString(),
          c.index.toString(),
          c.amounts.map(a => a.toString()),
          c.merkleProof,
        ]);
        preview = { action: 'V2 airdrop multiClaim', mode: 'raw', claims: String(claims.length) };
      } else if (local.period) {
        if (!local.address) throw new Error('--address <owner> is required when using --period');
        validateAddress(local.address);
        const raw = await fetchMoolahJson<Record<string, AirdropEntryRaw>>(network, '/v2/getAllUnClaimedAirDrop', {
          addr: local.address,
          getUnclaimedOnly: 'true',
        });
        const entry = raw?.[local.period];
        if (!entry) throw new Error(`Round '${local.period}' not found for ${local.address}`);
        if (entry.claimed) throw new Error(`Round '${local.period}' is already claimed`);
        const amounts = asList(entry.amount);
        const proof = entry.proof ?? [];
        if (amounts.length === 0) throw new Error(`Round '${local.period}' returned no token amounts`);
        if (proof.length === 0) throw new Error(`Round '${local.period}' has no merkle proof — backend may still be indexing`);
        if (entry.merkleIndex === undefined || entry.index === undefined) {
          throw new Error(`Round '${local.period}' is missing merkleIndex/index`);
        }
        claims = [[
          String(entry.merkleIndex),
          String(entry.index),
          amounts,
          proof,
        ]];
        preview = {
          action: 'V2 airdrop multiClaim',
          mode: 'period',
          period: local.period,
          merkleIndex: String(entry.merkleIndex),
          index: String(entry.index),
        };
      } else {
        throw new Error('Provide either --period <key> (with --address) or --claims <json>');
      }

      await sendContractTx({
        command: this,
        contractAddress: distributor,
        abi: MERKLE_DISTRIBUTOR_V2_ABI,
        functionName: 'multiClaim',
        args: [claims],
        preview,
      });
      void opts;
    });
}
