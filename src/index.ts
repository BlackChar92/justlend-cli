import { Command, InvalidArgumentError } from 'commander';
import { setJsonMode, setQuietMode, isJsonMode } from './lib/error.js';
import { configureDiagnostics } from './lib/diagnostics.js';
import { CLI_VERSION } from './version.js';

import { registerNetworkCommand } from './commands/network.js';
import { registerPriceCommand } from './commands/price.js';
import { registerMarketCommands } from './commands/market/index.js';
import { registerVaultCommands } from './commands/vault/index.js';
import { registerPositionCommands } from './commands/position/index.js';
import { registerLiquidationCommands } from './commands/liquidation/index.js';
import { registerHistoryCommand } from './commands/history/index.js';
import { registerV1Commands } from './commands/v1/index.js';
import { registerDaemonCommands } from './commands/daemon.js';
import { registerStusdtCommands } from './commands/stusdt.js';
import { registerAirdropCommands } from './commands/airdrop.js';
import { registerSunCommands } from './commands/sun.js';
import { registerStrxCommands } from './commands/strx.js';
import { registerWtrxCommands } from './commands/wtrx.js';
import { registerEnergyCommands } from './commands/energy.js';
import { registerGovCommands } from './commands/gov.js';
import { registerMiningCommands } from './commands/mining.js';
import { registerApproveCommand } from './commands/approve.js';
import { registerMoolahWriteCommands } from './commands/moolah-writes.js';
import { registerAdvancedCommands } from './commands/advanced.js';
import { registerRewardsCommand } from './commands/rewards.js';
import { registerConfigCommand } from './commands/config.js';
import { registerStubs } from './commands/_stubs.js';

export function createProgram(argv: readonly string[] = process.argv.slice(2)): Command {
  const program = new Command();
  const jsonRequested = argv.includes('--json');

  // Commander reports parser failures before preAction runs. Detect JSON mode
  // from argv up front, suppress its human stderr, and throw instead of exiting
  // so bin/cli.ts can emit one valid structured error envelope.
  setJsonMode(jsonRequested);
  if (jsonRequested) program.exitOverride();

  program.configureOutput({
    writeErr: (str) => {
      if (!isJsonMode()) process.stderr.write(str);
    },
  });

  program
    .name('justlend')
    .description('CLI for JustLend DAO on TRON — V1 + V2 (Moolah) lending, staking, energy rental, governance')
    .version(CLI_VERSION)
    .option('--network <mainnet|nile>', 'Target network', process.env.JUSTLEND_NETWORK ?? 'mainnet')
    .option('--full-host <url>', 'Override Tron full/solidity/event host (or JUSTLEND_FULL_HOST env)')
    .option('--api-host <url>', 'Override JustLend V1 backend host (or JUSTLEND_API_HOST env)')
    .option('--moolah-api-host <url>', 'Override Moolah V2 backend host (or JUSTLEND_MOOLAH_API_HOST env)')
    .option('--energy-api-url <url>', 'Override the official energy direct-purchase API URL (or JUSTLEND_ENERGY_API_URL env)')
    .option('--json', 'Output as JSON')
    .option('--local-broadcast', 'Broadcast via CLI local TronWeb instead of signer TronWeb')
    .option('--allow-untrusted-host', 'Allow custom RPC/API hosts outside the built-in allowlist')
    .option('--allow-insecure-host', 'Allow http://localhost style custom hosts for local development only')
    .option('--dump-signed-tx', 'With --no-broadcast, print the full signed transaction payload (anyone can broadcast it)')
    .option('--no-broadcast', 'Sign only, do not broadcast (returns signedTx)')
    .option('--dry-run', 'Build calldata + run triggerconstantcontract simulation (no signer, no broadcast)')
    .option('--dry-run-owner <address>', 'Owner address to use for --dry-run simulation (Base58)')
    .option('--no-precheck', 'Skip the pre-sign balance/energy/revert preflight on contract writes')
    .option('--yes', 'Skip local CLI safety prompts where applicable')
    .option('--port <n>', 'TronLink Signer HTTP port', (val: string) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n < 1 || n > 65535) {
        throw new InvalidArgumentError(`Invalid port: "${val}". Must be an integer between 1 and 65535`);
      }
      return n;
    }, 3386)
    .option('--api-key <key>', 'TronGrid API key (or set JUSTLEND_API_KEY / TRON_API_KEY env)')
    .option('--verbose', 'Print diagnostic logs to stderr')
    .option('--debug', 'Print verbose diagnostic logs with sensitive values redacted')
    .option('--log-file <path>', 'Append diagnostic logs to a file instead of stderr')
    .option('--timeout <ms>', 'Signing timeout in ms (default: 300000)', (val: string) => {
      const n = Number(val);
      if (!Number.isInteger(n) || n <= 0) {
        throw new InvalidArgumentError(`Invalid timeout: "${val}". Must be a positive integer (ms)`);
      }
      process.env.JUSTLEND_TIMEOUT = val;
      return val;
    })
    .option('--fee-limit <trx>', 'Fee limit in TRX for TRC20 / V2 writes (default: 100)', (val: string) => {
      const n = Number(val);
      if (!Number.isFinite(n) || n <= 0) {
        throw new InvalidArgumentError(`Invalid fee-limit: "${val}". Must be a positive number (TRX)`);
      }
      return val;
    })
    .option('-q, --quiet', 'Suppress non-error output (errors still go to stderr)')
    .showSuggestionAfterError(true);

  program.hook('preAction', (thisCommand) => {
    const opts = thisCommand.optsWithGlobals();
    setJsonMode(!!opts.json);
    setQuietMode(!!opts.quiet);
    configureDiagnostics({ verbose: !!opts.verbose, debug: !!opts.debug, logFile: opts.logFile });
    if (opts.allowUntrustedHost) process.env.JUSTLEND_ALLOW_UNTRUSTED_HOSTS = '1';
    if (opts.allowInsecureHost) process.env.JUSTLEND_ALLOW_INSECURE_HOSTS = '1';
    if (opts.fullHost) process.env.JUSTLEND_FULL_HOST = opts.fullHost;
    if (opts.apiHost) process.env.JUSTLEND_API_HOST = opts.apiHost;
    if (opts.moolahApiHost) process.env.JUSTLEND_MOOLAH_API_HOST = opts.moolahApiHost;
    if (opts.energyApiUrl) process.env.JUSTLEND_ENERGY_API_URL = opts.energyApiUrl;
    if (opts.apiKey) process.env.JUSTLEND_API_KEY = opts.apiKey;
  });

  // Implemented in P0
  registerNetworkCommand(program);
  registerConfigCommand(program);
  registerPriceCommand(program);
  registerMarketCommands(program);
  registerVaultCommands(program);
  registerPositionCommands(program);
  registerLiquidationCommands(program);
  registerHistoryCommand(program);
  registerV1Commands(program);
  registerDaemonCommands(program);
  registerStusdtCommands(program);
  registerAirdropCommands(program);
  registerSunCommands(program);
  registerStrxCommands(program);
  registerWtrxCommands(program);
  registerEnergyCommands(program);
  registerGovCommands(program);
  registerMiningCommands(program);
  registerApproveCommand(program);
  registerMoolahWriteCommands(program);
  registerAdvancedCommands(program);
  registerRewardsCommand(program);

  // Placeholders that print "not yet implemented (Phase X)" so the help tree is visible
  registerStubs(program);

  // Walk the command tree and make every command reject excess arguments to catch typos
  const enforceStrictArgs = (cmd: Command): void => {
    cmd.allowExcessArguments(false);
    cmd.commands.forEach(enforceStrictArgs);
  };
  enforceStrictArgs(program);

  return program;
}
