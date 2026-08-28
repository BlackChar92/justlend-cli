import { Command } from 'commander';
import { outputResult } from '../lib/output.js';

const CONFIG_KEYS = [
  'network',
  'fullHost',
  'apiHost',
  'moolahApiHost',
  'energyApiHost',
  'apiKey',
] as const;

type ConfigKey = typeof CONFIG_KEYS[number];

function envName(key: ConfigKey): string {
  switch (key) {
    case 'network': return 'JUSTLEND_NETWORK';
    case 'fullHost': return 'JUSTLEND_FULL_HOST';
    case 'apiHost': return 'JUSTLEND_API_HOST';
    case 'moolahApiHost': return 'JUSTLEND_MOOLAH_API_HOST';
    case 'energyApiHost': return 'JUSTLEND_ENERGY_API_URL';
    case 'apiKey': return 'JUSTLEND_API_KEY';
  }
}

function redact(key: ConfigKey, value: string | undefined): string | undefined {
  if (!value) return value;
  return key === 'apiKey' ? '[REDACTED]' : value;
}

function collectConfig(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const value = process.env[envName(key)];
    out[key] = {
      env: envName(key),
      value: redact(key, value),
      source: value ? 'env' : 'default',
    };
  }
  out.legacy = {
    TRON_API_KEY: process.env.TRON_API_KEY ? '[REDACTED]' : undefined,
    TRONGRID_API_KEY: process.env.TRONGRID_API_KEY ? '[REDACTED]' : undefined,
  };
  return out;
}

export function registerConfigCommand(program: Command): void {
  const config = program
    .command('config')
    .description('Show JustLend CLI runtime config and supported environment overrides');

  config
    .command('list')
    .description('List effective environment-backed config')
    .action(function (this: Command) {
      const opts = this.optsWithGlobals();
      outputResult(collectConfig(), 'Config', Boolean(opts.json));
    });

  config
    .command('get <key>')
    .description(`Get a config value (${CONFIG_KEYS.join(', ')})`)
    .action(function (this: Command, key: string) {
      const opts = this.optsWithGlobals();
      if (!CONFIG_KEYS.includes(key as ConfigKey)) {
        throw new Error(`Unknown config key: ${key}. Available: ${CONFIG_KEYS.join(', ')}`);
      }
      const typed = key as ConfigKey;
      outputResult({
        key: typed,
        env: envName(typed),
        value: redact(typed, process.env[envName(typed)]),
        source: process.env[envName(typed)] ? 'env' : 'default',
      }, 'Config Value', Boolean(opts.json));
    });
}
