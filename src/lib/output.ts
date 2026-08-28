import chalk from 'chalk';
import Table from 'cli-table3';
import ora from 'ora';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { isJsonMode, isQuietMode } from './error.js';
import { jsonSuccess } from './json-contract.js';

const SENSITIVE_OUTPUT_KEY = /^(?:access[_-]?token|refund[_-]?token|order[_-]?token|api[_-]?key|authorization|private[_-]?key|mnemonic|secret)$/i;

export function redactSensitiveOutput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveOutput);
  if (!value || typeof value !== 'object') return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_OUTPUT_KEY.test(key) ? '[redacted]' : redactSensitiveOutput(item);
  }
  return result;
}

export function sanitizeTerminalText(value: unknown): string {
  return String(value)
    .replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\)?)/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
}

/**
 * JSON output envelope. All JSON-mode payloads (single result, list, signed tx)
 * are wrapped as `{ schemaVersion: "1.0.0", success: true, data: ... }` so downstream consumers
 * (AI agents, CI scripts) can rely on a single contract. Errors come out via
 * handleError() as a versioned `{ success: false, error, code, retryable }` envelope on stderr.
 *
 * Inspired by tronprotocol/wallet-cli's standard CLI mode.
 */
export function emitJson(data: unknown): void {
  process.stdout.write(JSON.stringify(jsonSuccess(redactSensitiveOutput(data)), null, 2) + '\n');
}

export function outputResult(
  data: Record<string, unknown>,
  title: string,
  json: boolean,
): void {
  if (json) {
    emitJson(data);
    return;
  }
  if (isQuietMode()) return;

  console.log(chalk.bold.green(`\n${sanitizeTerminalText(title)}`));
  const table = new Table();
  const redactedData = redactSensitiveOutput(data) as Record<string, unknown>;
  for (const [key, value] of Object.entries(redactedData)) {
    if (value !== undefined && value !== null) {
      table.push({ [chalk.cyan(sanitizeTerminalText(key))]: sanitizeTerminalText(value) });
    }
  }
  console.log(table.toString());
  console.log();
}

export function outputList(
  rows: Record<string, unknown>[],
  title: string,
  json: boolean,
  metadata?: Record<string, unknown>,
): void {
  if (json) {
    emitJson(metadata && Object.keys(metadata).length > 0 ? { rows, ...metadata } : rows);
    return;
  }
  if (isQuietMode()) return;
  console.log(chalk.bold.green(`\n${sanitizeTerminalText(title)}`));
  if (metadata && Object.keys(metadata).length > 0) {
    const meta = new Table();
    const redactedMetadata = redactSensitiveOutput(metadata) as Record<string, unknown>;
    for (const [key, value] of Object.entries(redactedMetadata)) {
      if (value !== undefined && value !== null) meta.push({ [chalk.cyan(sanitizeTerminalText(key))]: sanitizeTerminalText(value) });
    }
    console.log(meta.toString());
  }
  if (rows.length === 0) {
    console.log(chalk.yellow('(empty)\n'));
    return;
  }
  const redactedRows = redactSensitiveOutput(rows) as Record<string, unknown>[];
  const head = Object.keys(redactedRows[0]!);
  const table = new Table({ head: head.map(h => chalk.cyan(sanitizeTerminalText(h))) });
  for (const row of redactedRows) {
    table.push(head.map(h => {
      const v = row[h];
      return v === undefined || v === null ? '' : sanitizeTerminalText(v);
    }));
  }
  console.log(table.toString());
  console.log();
}

export function outputInfo(message: string): void {
  if (isJsonMode() || isQuietMode()) return;
  console.log(chalk.blue(sanitizeTerminalText(message)));
}

export function outputAction(details: Record<string, string | number | boolean | undefined>): void {
  if (isJsonMode() || isQuietMode()) return;
  console.log(chalk.bold.yellow('\nTransaction Preview'));
  const table = new Table();
  for (const [key, value] of Object.entries(details)) {
    if (value !== undefined && value !== null) table.push({ [chalk.cyan(sanitizeTerminalText(key))]: sanitizeTerminalText(value) });
  }
  console.log(table.toString());
}

export function outputSuccess(message: string): void {
  if (isJsonMode() || isQuietMode()) return;
  console.log(chalk.green(sanitizeTerminalText(message)));
}

export function outputWarning(message: string): void {
  if (isJsonMode() || isQuietMode()) return;
  console.log(chalk.yellow(`⚠ ${sanitizeTerminalText(message)}`));
}

export function requireExplicitWriteConsent(
  assumeYes = false,
  context: { interactive?: boolean; mode?: 'json' | 'quiet' | 'text' } = {},
): void {
  if (assumeYes) return;
  const interactive = context.interactive ?? process.stdin.isTTY;
  const mode = context.mode ?? (isJsonMode() ? 'json' : isQuietMode() ? 'quiet' : 'text');
  if (!interactive || mode === 'json' || mode === 'quiet') {
    throw new Error('Value-moving write requires explicit --yes in --json/--quiet/non-TTY mode. Re-run with --yes after reviewing the transaction preview or use --dry-run first.');
  }
}

export function outputSignedTx(signedTransaction: unknown, options: { dump?: boolean } = {}): void {
  const tx = signedTransaction as { txID?: unknown; txId?: unknown };
  const txId = tx?.txID ?? tx?.txId;
  if (!options.dump) {
    const redacted = { status: 'signed', txId, signedTransaction: '[redacted: pass --dump-signed-tx to print full payload; anyone can broadcast it]' };
    if (isJsonMode()) {
      emitJson(redacted);
      return;
    }
    if (isQuietMode()) return;
    console.log(chalk.bold.green('\nSigned Transaction Redacted'));
    console.log(JSON.stringify(redacted, null, 2));
    console.log();
    return;
  }
  if (isJsonMode()) {
    emitJson({ warning: 'Anyone can broadcast this signed transaction before it expires.', signedTransaction });
    return;
  }
  if (isQuietMode()) return;
  console.log(chalk.bold.red('\nWarning: anyone can broadcast this signed transaction before it expires.'));
  console.log(chalk.bold.green('\nSigned Transaction'));
  console.log(JSON.stringify(signedTransaction, null, 2));
  console.log();
}

interface SpinnerLike {
  succeed: (text?: string) => void;
  fail: (text?: string) => void;
  start: (text?: string) => void;
  stop: () => void;
}

export function createSpinner(text: string): SpinnerLike {
  if (isJsonMode() || isQuietMode()) {
    return { succeed: () => {}, fail: () => {}, start: () => {}, stop: () => {} };
  }
  return ora({ text, color: 'cyan' }).start();
}

export async function confirmProceed(message: string, assumeYes = false): Promise<void> {
  requireExplicitWriteConsent(assumeYes);
  const rl = createInterface({ input, output });
  try {
    const answer = (await rl.question(`${chalk.yellow(message)} Type yes to continue: `)).trim().toLowerCase();
    if (answer !== 'yes' && answer !== 'y') throw new Error('Cancelled by user');
  } finally {
    rl.close();
  }
}

export async function confirmOnChain(promise: Promise<void>): Promise<void> {
  const s = createSpinner('Waiting for on-chain confirmation...');
  try {
    await promise;
    s.succeed('Confirmed on-chain');
  } catch (err) {
    s.fail('On-chain execution failed');
    throw err;
  }
}
