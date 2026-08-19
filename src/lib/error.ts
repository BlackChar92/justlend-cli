import chalk from 'chalk';
import { CommanderError } from 'commander';
import { HttpRequestError } from './http.js';
import { JSON_SCHEMA_VERSION } from './json-contract.js';

export class CliError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'CliError';
  }
}

export interface JsonErrorPayload {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  success: false;
  error: string;
  code: string;
  retryable: boolean;
  module?: string;
  network?: string;
  host?: string;
  path?: string;
  status?: number;
  hint?: string;
}

let jsonMode = false;
let quietMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function setQuietMode(enabled: boolean): void {
  quietMode = enabled;
}

export function isQuietMode(): boolean {
  return quietMode;
}

export function handleError(err: unknown): never {
  const payload = classifyError(err);
  if (jsonMode) {
    process.stderr.write(JSON.stringify(payload) + '\n');
  } else {
    console.error(chalk.red(`Error: ${sanitizeChainText(payload.error)}`));
    const details = [
      payload.code ? `code=${payload.code}` : undefined,
      `retryable=${payload.retryable}`,
      payload.module ? `module=${payload.module}` : undefined,
      payload.network ? `network=${payload.network}` : undefined,
      payload.host ? `host=${payload.host}` : undefined,
      payload.path ? `path=${payload.path}` : undefined,
      payload.hint ? `hint=${payload.hint}` : undefined,
    ].filter(Boolean);
    if (details.length > 0) console.error(chalk.gray(details.join(' ')));
  }
  process.exit(1);
}

const USER_CANCEL_PATTERNS = [
  /\buser[\s_](rejected|denied|cancell?ed)\b/i,
  /\brejected\s+by\s+user\b/i,
  /\bcancell?ed\s+by\s+user\b/i,
  /^USER_(REJECTED|DENIED|CANCELL?ED)$/i,
  /^CANCELLED_BY_CALLER$/,
];

type ErrorDetails = Partial<Omit<JsonErrorPayload, 'schemaVersion' | 'success' | 'error' | 'code' | 'retryable'>>;

function errorPayload(
  error: string,
  code: string,
  retryable: boolean,
  details: ErrorDetails = {},
): JsonErrorPayload {
  return { schemaVersion: JSON_SCHEMA_VERSION, success: false, error, code, retryable, ...details };
}

export function classifyError(err: unknown): JsonErrorPayload {
  if (err instanceof CommanderError) {
    const message = err.message.replace(/^error:\s*/i, '').trim();
    return errorPayload(message, 'CLI_USAGE_ERROR', false, {
      hint: 'Run `justlend --help` or `justlend <command> --help` and correct the arguments.',
    });
  }

  if (err instanceof HttpRequestError) {
    const retryable = err.status === undefined || err.status === 429 || err.status >= 500;
    return errorPayload(err.message, err.code ?? 'HTTP_REQUEST_FAILED', retryable, {
      module: err.module,
      network: err.network,
      host: err.host,
      path: err.path,
      status: err.status,
      hint: err.hint,
    });
  }

  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  if (err instanceof CliError) {
    return errorPayload(msg, err.code, false);
  }
  if (USER_CANCEL_PATTERNS.some(pattern => pattern.test(msg))) {
    return errorPayload('Transaction cancelled by user in TronLink', 'USER_CANCELLED', false);
  }
  if (lower.includes('timeout') || lower.includes('timed out')) {
    return errorPayload(
      'TronLink approval timed out. Please try again',
      'SIGNER_TIMEOUT',
      true,
      { hint: 'Retry only while the user is present to approve the wallet request.' },
    );
  }
  if (lower.includes('insufficient') || lower.includes('balance is not sufficient')) {
    return errorPayload(`Insufficient balance: ${msg}`, 'INSUFFICIENT_BALANCE', false);
  }
  if (lower.includes('allowance')) {
    return errorPayload(
      `Insufficient allowance: ${msg}. Run \`justlend approve <token>\` first`,
      'INSUFFICIENT_ALLOWANCE',
      false,
    );
  }
  if (lower.includes('invalid address') || lower.includes('invalid base58')) {
    return errorPayload('Invalid TRON address provided', 'INVALID_ADDRESS', false);
  }
  if (lower.includes('ipc connection closed') || lower.includes('ipc connection lost')) {
    return errorPayload(
      'Signer disconnected (browser closed?). Keep the TronLink signer page open in your browser and retry.',
      'SIGNER_DISCONNECTED',
      true,
      { hint: 'Reconnect the signer before retrying; never auto-retry a pending write.' },
    );
  }
  if (
    lower.includes('econnrefused') || lower.includes('enotfound') ||
    lower.includes('etimedout') || lower.includes('network error') ||
    lower.includes('failed to fetch') || lower === 'fetch failed'
  ) {
    return errorPayload(
      'Network connection failed. Check your internet connection',
      'NETWORK_CONNECTION_FAILED',
      true,
    );
  }
  if (lower.includes('broadcast failed')) {
    return errorPayload(
      `Transaction broadcast failed: ${msg}`,
      'BROADCAST_FAILED',
      false,
      { hint: 'Inspect the transaction state manually; writes must never be auto-retried.' },
    );
  }

  return errorPayload(msg, 'UNKNOWN_ERROR', false);
}

export function sanitizeError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/0x[0-9a-fA-F]{40,}/g, m => `${m.slice(0, 8)}…${m.slice(-4)}`);
}

// Strip terminal-dangerous C0/C1 control characters (incl. ESC and DEL) from
// attacker-controlled chain text — decoded revert reasons, hex `resMessage`, and
// the like — before it is printed to a human terminal. Without this a malicious
// contract could embed ANSI escapes in a revert string to rewrite or erase prior
// terminal lines and spoof the output a signing decision relies on. Keeps
// \t \n \r so multi-line messages still render. JSON mode does not need this
// (JSON.stringify already escapes these code points), so only call it on the
// human/text rendering exits, never inside the JSON output paths.
export function sanitizeChainText(s: string): string {
  return s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
}
