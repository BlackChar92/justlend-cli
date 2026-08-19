/**
 * Placeholder commands so the help tree mirrors the plan.
 * Each prints "not yet implemented" with the phase tag from the plan.
 *
 * Real impl ports MCP services as planned in development documentation.
 */
import type { Command } from 'commander';
import { emitJson } from '../lib/output.js';

interface Stub {
  /** Command path. Use space-separated tokens; first token is the (sub)command name. */
  cmd: string;
  description: string;
  phase: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
}

/**
 * Domain prefixes that group their stubs under a parent command.
 * Anything not in this set is registered as a top-level command.
 */
const DOMAINS = new Set([
  'v1',
  'strx',
  'stusdt',
  'energy',
  'gov',
  'mining',
  'airdrop',
  'sun',
  'liquidation',
  'collateral',
  // already registered top-level groups — stubs for them attach as subcommands:
  'market',
  'vault',
]);

/**
 * Top-level commands already implemented. Stubs that share these names are skipped
 * (their subcommands may still be registered if they include a domain prefix).
 */
const ALREADY_REGISTERED_TOP = new Set([
  'network',
  'price',
  'market',
  'vault',
  'position',
  'liquidation',
  'history',
  'v1',
  'serve',
  'connect',
]);

const ALREADY_IMPLEMENTED_STUBS = new Set([
  'position <address>',
  'position-market <marketId> <address>',
  'position-vault <vaultAddress> <address>',
  'liquidation list',
  'liquidation records',
  'v1 market-list',
  'v1 market-info <token>',
  'v1 position <address>',
  'history <address>',
  'serve',
  'connect',
  'stusdt info',
  'stusdt position <address>',
  'stusdt mint <amount>',
  'stusdt unstake <amount>',
  'stusdt claim <requestIds...>',
  'airdrop list [address]',
  'airdrop claim',
  'strx info',
  'strx position <address>',
  'strx stake <amount>',
  'strx unstake <amount>',
  'strx withdraw',
  'strx claim',
  'energy info',
  'energy orders <address>',
  'energy estimate <amount>',
  'energy rent <amount>',
  'energy renew <orderId>',
  'energy cancel <orderId>',
  'gov list',
  'gov info <proposalId>',
  'gov power <address>',
  'gov vote <proposalId> <choice>',
  'gov redeem <proposalId>',
  'gov exchange <amount>',
  'mining apy <vaultAddress>',
  'mining accruing <address>',
  'mining pending <address>',
  'mining resolver <vaultAddress>',
  'mining claim <vaultAddress> <periodId>',
  'approve <token> [spender]',
  'v1 deposit <token> <amount>',
  'v1 withdraw <token> <amount>',
  'v1 borrow <token> <amount>',
  'v1 repay <token> <amount>',
  'v1 collateral-enable <token>',
  'v1 collateral-disable <token>',
  'supply <marketId> <amount>',
  'withdraw <marketId> <amount>',
  'borrow <marketId> <amount>',
  'repay <marketId> <amount>',
  'collateral supply <marketId> <amount>',
  'collateral withdraw <marketId> <amount>',
  'liquidate <marketId> <borrower> <amount>',
  'simulate <command...>',
  'watch <address>',
  'portfolio <address>',
  'rewards <address>',
  'rewards summary <address>',
  'rewards claim',
]);

const STUBS: Stub[] = [
  // P1 — V2 read remainders
  { cmd: 'position <address>',                          description: 'V2 user portfolio overview',                phase: 'P1' },
  { cmd: 'position-market <marketId> <address>',        description: 'User position in a V2 market',               phase: 'P1' },
  { cmd: 'position-vault <vaultAddress> <address>',     description: 'User position in a V2 vault',                phase: 'P1' },
  { cmd: 'liquidation list',                            description: 'V2 pending liquidations',                    phase: 'P1' },
  { cmd: 'liquidation records',                         description: 'V2 historical liquidation records',          phase: 'P1' },
  // P1 — V1 read
  { cmd: 'v1 market-list',                              description: 'V1 jToken market list',                      phase: 'P1' },
  { cmd: 'v1 market-info <token>',                      description: 'V1 single market detail',                    phase: 'P1' },
  { cmd: 'v1 position <address>',                       description: 'V1 user supply/borrow position',             phase: 'P1' },
  // P1 — sTRX / stUSDT read
  { cmd: 'strx info',                                   description: 'sTRX dashboard',                             phase: 'P1' },
  { cmd: 'strx position <address>',                     description: 'User sTRX position + claimable rewards',     phase: 'P1' },
  { cmd: 'stusdt info',                                 description: 'stUSDT dashboard (rebase / APY)',            phase: 'P1' },
  { cmd: 'stusdt position <address>',                   description: 'User stUSDT balance + accrued',              phase: 'P1' },
  // P1 — Energy read
  { cmd: 'energy info',                                 description: 'Energy rental market overview',              phase: 'P1' },
  { cmd: 'energy orders <address>',                     description: 'User energy rental orders',                  phase: 'P1' },
  { cmd: 'energy estimate <amount>',                    description: 'Estimate rental cost for amount of energy',  phase: 'P1' },
  // P1 — Gov read
  { cmd: 'gov list',                                    description: 'Governance proposal list',                   phase: 'P1' },
  { cmd: 'gov info <proposalId>',                       description: 'Proposal detail + vote breakdown',           phase: 'P1' },
  { cmd: 'gov power <address>',                         description: 'Voting power held by address',               phase: 'P1' },
  // P1 — Mining (V2)
  { cmd: 'mining apy <vaultAddress>',                   description: 'V2 vault mining APY',                        phase: 'P1' },
  { cmd: 'mining accruing <address>',                   description: 'V2 mining rewards currently accruing',       phase: 'P1' },
  { cmd: 'mining pending <address>',                    description: 'V2 mining periods awaiting claim',           phase: 'P1' },
  { cmd: 'mining resolver <vaultAddress>',              description: 'V2 mining resolver config',                  phase: 'P1' },
  // P1 — generic
  { cmd: 'history <address>',                           description: 'Cross-module transaction history',           phase: 'P1' },
  { cmd: 'rewards <address>',                           description: 'V1 mining + V2 airdrop claimable summary',   phase: 'P1' },
  // Daemon (sits at top level)
  { cmd: 'serve',                                       description: 'Run signer daemon (browser tab reused)',     phase: 'P1' },
  { cmd: 'connect',                                     description: 'Verify TronLink wallet connection',          phase: 'P1' },

  // P2 — V2 writes
  { cmd: 'supply <marketId> <amount>',                  description: 'V2 supply',                                  phase: 'P2' },
  { cmd: 'withdraw <marketId> <amount>',                description: 'V2 withdraw supply',                         phase: 'P2' },
  { cmd: 'borrow <marketId> <amount>',                  description: 'V2 borrow',                                  phase: 'P2' },
  { cmd: 'repay <marketId> <amount>',                   description: 'V2 repay',                                   phase: 'P2' },
  { cmd: 'collateral supply <marketId> <amount>',       description: 'V2 supply collateral',                       phase: 'P2' },
  { cmd: 'collateral withdraw <marketId> <amount>',     description: 'V2 withdraw collateral',                     phase: 'P2' },
  { cmd: 'approve <token> [spender]',                   description: 'TRC20 approve',                              phase: 'P2' },
  { cmd: 'liquidate <marketId> <borrower> <amount>',    description: 'V2 liquidate',                               phase: 'P2' },

  // P3 — V1 writes
  { cmd: 'v1 deposit <token> <amount>',                 description: 'V1 mint jToken',                             phase: 'P3' },
  { cmd: 'v1 withdraw <token> <amount>',                description: 'V1 redeem jToken',                           phase: 'P3' },
  { cmd: 'v1 borrow <token> <amount>',                  description: 'V1 borrow',                                  phase: 'P3' },
  { cmd: 'v1 repay <token> <amount>',                   description: 'V1 repay',                                   phase: 'P3' },
  { cmd: 'v1 collateral-enable <token>',                description: 'V1 enable as collateral',                    phase: 'P3' },
  { cmd: 'v1 collateral-disable <token>',               description: 'V1 disable as collateral',                   phase: 'P3' },

  // P4 — staking writes
  { cmd: 'strx stake <amount>',                         description: 'Stake TRX → sTRX',                           phase: 'P4' },
  { cmd: 'strx unstake <amount>',                       description: 'Unstake sTRX',                               phase: 'P4' },
  { cmd: 'strx withdraw',                               description: 'Withdraw unlocked TRX',                      phase: 'P4' },
  { cmd: 'strx claim',                                  description: 'Claim sTRX multi-token rewards',             phase: 'P4' },
  { cmd: 'stusdt mint <amount>',                        description: 'Deposit USDT → stUSDT',                      phase: 'P4' },
  { cmd: 'stusdt unstake <amount>',                     description: 'Redeem stUSDT → USDT',                       phase: 'P4' },
  { cmd: 'stusdt claim <requestIds...>',                description: 'Claim completed stUSDT unstake withdrawals', phase: 'P4' },

  // P5 — energy + gov writes
  { cmd: 'energy rent <amount>',                        description: 'Create energy rental order',                 phase: 'P5' },
  { cmd: 'energy renew <orderId>',                      description: 'Renew rental order',                         phase: 'P5' },
  { cmd: 'energy cancel <orderId>',                     description: 'Cancel rental order',                        phase: 'P5' },
  { cmd: 'gov vote <proposalId> <choice>',              description: 'Cast vote (for | against)',                  phase: 'P5' },
  { cmd: 'gov redeem <proposalId>',                     description: 'Withdraw votes from proposal',               phase: 'P5' },
  { cmd: 'gov exchange <amount>',                       description: 'Exchange JST for voting power',              phase: 'P5' },

  // P6 — advanced
  { cmd: 'simulate <command...>',                       description: 'Simulate any tx (energy estimate)',          phase: 'P6' },
  { cmd: 'watch <address>',                             description: 'Poll position health (V1 + V2)',             phase: 'P6' },
  { cmd: 'portfolio <address>',                         description: 'Cross-module portfolio overview',            phase: 'P6' },
  { cmd: 'mining claim <vaultAddress> <periodId>',      description: 'Claim a single V2 mining period',            phase: 'P6' },
  { cmd: 'airdrop list [address]',                      description: 'List V2 multi-token airdrop claimables',     phase: 'P6' },
  { cmd: 'airdrop claim',                               description: 'multiClaim from MerkleDistributorV2',        phase: 'P6' },
];

export function registerStubs(program: Command): void {
  // Map each domain to either an existing top command (if reservedTop) or a new one.
  const domainParents = new Map<string, Command>();

  const ensureDomainParent = (domain: string): Command => {
    if (domainParents.has(domain)) return domainParents.get(domain)!;
    const existing = program.commands.find(c => c.name() === domain);
    if (existing) {
      domainParents.set(domain, existing);
      return existing;
    }
    const created = program.command(domain).description(`${domain} commands`);
    domainParents.set(domain, created);
    return created;
  };

  for (const stub of STUBS) {
    if (ALREADY_IMPLEMENTED_STUBS.has(stub.cmd)) continue;
    const tokens = stub.cmd.split(/\s+/);
    const head = tokens[0]!;

    if (DOMAINS.has(head)) {
      // domain group — register the rest as a subcommand
      const parent = ensureDomainParent(head);
      const subSpec = tokens.slice(1).join(' ');
      registerLeaf(parent, subSpec, stub);
    } else {
      // top-level stub
      if (ALREADY_REGISTERED_TOP.has(head)) continue;
      registerLeaf(program, stub.cmd, stub);
    }
  }
}

function registerLeaf(parent: Command, spec: string, stub: Stub): void {
  if (!spec) return;
  parent
    .command(spec)
    .description(`[${stub.phase}] ${stub.description}`)
    .action(async function (this: Command, ...args: unknown[]) {
      const opts = this.optsWithGlobals();
      // Commander passes (...positional, options, command). Strip the last two.
      const passed = args.slice(0, Math.max(0, args.length - 2));
      const payload = {
        status: 'not_implemented',
        command: stub.cmd,
        phase: stub.phase,
        args: passed,
      };
      if (opts.json) {
        emitJson(payload);
      } else {
        process.stdout.write(`[${stub.phase}] ${stub.cmd} — not yet implemented (args: ${JSON.stringify(passed)})\n`);
      }
    });
}
