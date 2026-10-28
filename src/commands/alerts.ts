import { Command } from 'commander';
import { createRiskAlertReadClient } from '../lib/risk-alerts.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { outputResult } from '../lib/output.js';

export function registerAlertCommands(program: Command): void {
  const alerts = program.command('alerts')
    .description('Public read-only risk alerts; no wallet, signatures, sessions or email writes')
    .option('--api-url <url>', 'Explicit trusted HTTPS risk-alert endpoint (or JUSTLEND_ALERT_API_URL)');
  for (const name of ['list', 'rules', 'markets'] as const) {
    alerts.command(name === 'rules' ? name : `${name} <address>`)
      .description(`Read risk alert ${name}; mainnet TRON only, failures are unknown rather than empty`)
      .action(async function (this: Command, address?: string) {
        const options = this.optsWithGlobals();
        const network = getNetworkFromCommand(this);
        const client = createRiskAlertReadClient({ network, baseUrl: options.apiUrl });
        const result = name === 'rules' ? { rules: await client.rules() }
          : name === 'markets' ? { markets: await client.markets(address!) } : await client.list(address!);
        outputResult({ network, transactionSubmitted: false, ...result }, 'Risk Alerts', Boolean(options.json));
      });
  }
}
