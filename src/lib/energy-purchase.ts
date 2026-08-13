import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { TronWeb } from 'tronweb';
import { validateTrustedUrl } from './trusted-url.js';
import { validateAddress } from './tronweb.js';

export const ENERGY_PURCHASE_PATHS = {
  config: '/v1/config',
  currentPrice: '/v1/price/current',
  poolHealth: '/v1/pool/health',
  quote: '/v1/price',
  buy: '/v1/consumer/energy/buy',
  order: (id: string | number) => `/v1/consumer/energy/orders/${encodeURIComponent(String(id))}`,
} as const;

export const ENERGY_PURCHASE_TERMINAL_STATES = ['delivered', 'partial', 'failed', 'expired', 'cancelled'] as const;

const ORDER_TTL_MS = 5 * 60 * 1000;
const PAYMENT_RETRY_TIMEOUT_MS = 2 * 60 * 1000;
const PURCHASE_INTENT_TTL_MS = 15 * 60 * 1000;
const DETERMINISTIC_PRE_BROADCAST_CODES = new Set([
  'ADDR_OVERFLOW', 'BAD_REQUEST', 'CONFIG_INVALID', 'EMPTY_RECEIVERS',
  'INVALID_DURATION', 'INVALID_RECEIVERS', 'PAYMENT_CALC_FAILED',
  'POOL_INSUFFICIENT', 'PRICE_MOVED', 'RECEIVER_IS_CONTRACT', 'TX_EXPIRED',
]);
const RISK_MUTATION_LOCK_WAIT_MS = 2_000;
const RISK_MUTATION_LOCK_RETRY_MS = 10;
const RISK_FILE = path.join(os.homedir(), '.justlend-cli', 'energy-payment-risks.json');
const mutationLockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

export class EnergyPurchaseError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly isBusinessError: boolean;
  readonly retryable: boolean;
  readonly details?: unknown;
  paymentRisk?: EnergyPaymentRisk;

  constructor(code: string, message?: string, options: {
    status?: number;
    isBusinessError?: boolean;
    retryable?: boolean;
    details?: unknown;
    cause?: unknown;
  } = {}) {
    super(message || code, { cause: options.cause });
    this.name = 'EnergyPurchaseError';
    this.code = code;
    this.status = options.status;
    this.isBusinessError = options.isBusinessError === true;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export interface EnergyPurchaseConfig {
  min_energy: number;
  max_energy: number;
  max_batch_receivers: number;
  energy_presets: number[];
  activation_fee_sun?: number;
  supported_durations: string[];
  payment_address: string;
  [key: string]: unknown;
}

export interface EnergyPurchaseQuote {
  total_sun: number;
  total_trx?: string;
  payment_address: string;
  [key: string]: unknown;
}

export interface SignedEnergyPurchaseRequest {
  receivers: string[];
  energy: number;
  duration: string;
  payer_address: string;
  signed_transaction: {
    txID: string;
    raw_data_hex: string;
    signature: string[];
    visible: boolean;
  };
}

export interface EnergyPaymentRisk {
  payerAddress: string;
  signedTxId: string;
  createdAt: number;
  expiresAt: number;
  paymentConfirmed: boolean;
  networkFingerprint?: string;
  signedRequest?: SignedEnergyPurchaseRequest;
  recoveredOrder?: Record<string, unknown>;
}

export interface StorageLike {
  list(payerAddress: string): EnergyPaymentRisk[];
  save(risk: EnergyPaymentRisk): void;
  remove(payerAddress: string, signedTxId?: string): void;
  acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string;
  releasePurchaseIntent(payerAddress: string, token: string): void;
  finalizePurchaseIntent?(payerAddress: string, token: string, risk: EnergyPaymentRisk): void;
}

interface PurchaseIntent {
  payerAddress: string;
  token: string;
  pid: number;
  createdAt: number;
  expiresAt: number;
}

interface RiskMutationLock {
  token: string;
  pid: number;
  createdAt: number;
}

function storageError(message: string, cause?: unknown): EnergyPurchaseError {
  return new EnergyPurchaseError('RISK_STORAGE_ERROR', message, { cause });
}

function isNodeError(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException)?.code === code;
}

function parsePaymentRisks(raw: string): EnergyPaymentRisk[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy payment risk file contains invalid JSON; purchases are blocked until it is repaired.', cause);
  }
  if (!Array.isArray(parsed) || !parsed.every((risk): risk is EnergyPaymentRisk => {
    if (!risk || typeof risk !== 'object') return false;
    const candidate = risk as Partial<EnergyPaymentRisk>;
    return typeof candidate.payerAddress === 'string' && candidate.payerAddress.length > 0 &&
      typeof candidate.signedTxId === 'string' && candidate.signedTxId.length > 0 &&
      Number.isSafeInteger(candidate.createdAt) && Number(candidate.createdAt) >= 0 &&
      Number.isSafeInteger(candidate.expiresAt) && Number(candidate.expiresAt) >= 0 &&
      typeof candidate.paymentConfirmed === 'boolean' &&
      (candidate.networkFingerprint === undefined ||
        (typeof candidate.networkFingerprint === 'string' && candidate.networkFingerprint.length > 0)) &&
      (candidate.signedRequest === undefined ||
        candidate.signedRequest?.signed_transaction?.txID === candidate.signedTxId);
  })) {
    throw storageError('Energy payment risk file has an invalid schema; purchases are blocked until it is repaired.');
  }
  return parsed;
}

function parsePurchaseIntent(raw: string): PurchaseIntent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy purchase intent lock contains invalid JSON; purchases remain blocked.', cause);
  }
  const intent = parsed as Partial<PurchaseIntent> | null;
  if (
    !intent || typeof intent !== 'object' || typeof intent.payerAddress !== 'string' ||
    typeof intent.token !== 'string' || intent.token.length === 0 || !Number.isSafeInteger(intent.pid) ||
    !Number.isSafeInteger(intent.createdAt) || !Number.isSafeInteger(intent.expiresAt)
  ) {
    throw storageError('Energy purchase intent lock has an invalid schema; purchases remain blocked.');
  }
  return intent as PurchaseIntent;
}

function parseRiskMutationLock(raw: string): RiskMutationLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw storageError('Energy payment risk lock contains invalid JSON; purchases remain blocked.', cause);
  }
  const lock = parsed as Partial<RiskMutationLock> | null;
  if (
    !lock || typeof lock !== 'object' || typeof lock.token !== 'string' || lock.token.length === 0 ||
    !Number.isSafeInteger(lock.pid) || Number(lock.pid) <= 0 ||
    !Number.isSafeInteger(lock.createdAt) || Number(lock.createdAt) < 0
  ) {
    throw storageError('Energy payment risk lock has an invalid schema; purchases remain blocked.');
  }
  return lock as RiskMutationLock;
}

export class FileEnergyPaymentRiskStore implements StorageLike {
  constructor(private readonly filePath = RISK_FILE) {}

  private readAll(): EnergyPaymentRisk[] {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, 'utf8');
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return [];
      throw storageError('Unable to read the energy payment risk file; purchases are blocked.', cause);
    }
    return parsePaymentRisks(raw);
  }

  private writeAll(risks: EnergyPaymentRisk[]): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temp, JSON.stringify(risks, null, 2), { mode: 0o600 });
        fs.renameSync(temp, this.filePath);
      } finally {
        try {
          fs.unlinkSync(temp);
        } catch (cause) {
          if (!isNodeError(cause, 'ENOENT')) throw cause;
        }
      }
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to persist the energy payment risk file; purchases are blocked.', cause);
    }
  }

  private mutationLockPath(): string {
    return `${this.filePath}.mutation.lock`;
  }

  private acquireMutationLock(): string {
    const lockPath = this.mutationLockPath();
    const deadline = Date.now() + RISK_MUTATION_LOCK_WAIT_MS;
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    for (;;) {
      const token = randomUUID();
      let descriptor: number;
      try {
        descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      } catch (cause) {
        if (!isNodeError(cause, 'EEXIST')) {
          throw storageError('Unable to lock the energy payment risk file; purchases are blocked.', cause);
        }
        if (Date.now() >= deadline) {
          throw new EnergyPurchaseError(
            'RISK_STORAGE_BUSY',
            'The energy payment risk file is busy or its previous writer exited unexpectedly; purchases remain blocked.',
            { retryable: true },
          );
        }
        Atomics.wait(mutationLockWaitBuffer, 0, 0, RISK_MUTATION_LOCK_RETRY_MS);
        continue;
      }

      try {
        fs.writeFileSync(descriptor, JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }));
        fs.fsyncSync(descriptor);
        fs.closeSync(descriptor);
      } catch (cause) {
        try { fs.closeSync(descriptor); } catch { /* Preserve the original persistence error. */ }
        try { fs.unlinkSync(lockPath); } catch { /* Best effort after a failed exclusive create. */ }
        throw storageError('Unable to persist the energy payment risk lock; purchases remain blocked.', cause);
      }
      return token;
    }
  }

  private releaseMutationLock(token: string): void {
    const lockPath = this.mutationLockPath();
    let current: RiskMutationLock;
    try {
      current = parseRiskMutationLock(fs.readFileSync(lockPath, 'utf8'));
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to verify the energy payment risk lock; it was preserved.', cause);
    }
    if (current.token !== token) {
      throw storageError('Energy payment risk lock ownership changed; the current lock was preserved.');
    }
    try {
      fs.unlinkSync(lockPath);
    } catch (cause) {
      if (isNodeError(cause, 'ENOENT')) return;
      throw storageError('Unable to release the energy payment risk lock; purchases remain blocked.', cause);
    }
  }

  private mutateAll(mutator: (risks: EnergyPaymentRisk[]) => EnergyPaymentRisk[]): void {
    const token = this.acquireMutationLock();
    try {
      this.writeAll(mutator(this.readAll()));
    } finally {
      this.releaseMutationLock(token);
    }
  }

  private intentPath(payerAddress: string): string {
    return path.join(`${this.filePath}.locks`, `${encodeURIComponent(payerAddress)}.json`);
  }

  private readIntent(lockPath: string): PurchaseIntent {
    try {
      return parsePurchaseIntent(fs.readFileSync(lockPath, 'utf8'));
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to read the energy purchase intent lock; purchases remain blocked.', cause);
    }
  }

  private createIntent(lockPath: string, intent: PurchaseIntent): void {
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      fs.writeFileSync(descriptor, JSON.stringify(intent));
      fs.fsyncSync(descriptor);
    } catch (cause) {
      if (descriptor !== undefined) {
        try { fs.unlinkSync(lockPath); } catch { /* The failed lock remains fail-closed if cleanup is denied. */ }
      }
      throw cause;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  acquirePurchaseIntent(payerAddress: string, createdAt: number, expiresAt: number): string {
    const lockPath = this.intentPath(payerAddress);
    const recoveryPath = `${lockPath}.recovery`;
    const intent: PurchaseIntent = { payerAddress, token: randomUUID(), pid: process.pid, createdAt, expiresAt };
    try {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
      try {
        this.createIntent(lockPath, intent);
        return intent.token;
      } catch (cause) {
        if (!isNodeError(cause, 'EEXIST')) throw cause;
      }

      const current = this.readIntent(lockPath);
      if (current.expiresAt > createdAt) {
        throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
      }

      let recoveryDescriptor: number | undefined;
      try {
        recoveryDescriptor = fs.openSync(
          recoveryPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
          0o600,
        );
        const refreshed = this.readIntent(lockPath);
        if (refreshed.expiresAt > createdAt) {
          throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
        }
        fs.unlinkSync(lockPath);
        try {
          this.createIntent(lockPath, intent);
          return intent.token;
        } catch (cause) {
          if (isNodeError(cause, 'EEXIST')) {
            throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
          }
          throw cause;
        }
      } catch (cause) {
        if (isNodeError(cause, 'EEXIST')) {
          throw storageError('A stale energy purchase lock is already being recovered; purchases remain blocked.', cause);
        }
        throw cause;
      } finally {
        if (recoveryDescriptor !== undefined) {
          fs.closeSync(recoveryDescriptor);
          try { fs.unlinkSync(recoveryPath); } catch { /* A leftover recovery marker keeps recovery fail-closed. */ }
        }
      }
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to acquire the energy purchase intent lock; purchases are blocked.', cause);
    }
  }

  releasePurchaseIntent(payerAddress: string, token: string): void {
    const lockPath = this.intentPath(payerAddress);
    try {
      const current = this.readIntent(lockPath);
      if (current.payerAddress !== payerAddress || current.token !== token) {
        throw storageError('Energy purchase intent lock ownership changed; the lock was not removed.');
      }
      fs.unlinkSync(lockPath);
    } catch (cause) {
      if (cause instanceof EnergyPurchaseError) throw cause;
      throw storageError('Unable to release the energy purchase intent lock; purchases remain blocked.', cause);
    }
  }

  finalizePurchaseIntent(payerAddress: string, token: string, risk: EnergyPaymentRisk): void {
    const lockPath = this.intentPath(payerAddress);
    const current = this.readIntent(lockPath);
    if (current.payerAddress !== payerAddress || current.token !== token) {
      throw storageError('Energy purchase intent lock ownership changed; no payment risk was published.');
    }
    this.save(risk);
    try {
      fs.unlinkSync(lockPath);
    } catch (cause) {
      throw storageError('Payment risk was persisted but the purchase intent lock could not be released.', cause);
    }
  }

  list(payerAddress: string): EnergyPaymentRisk[] {
    return this.readAll().filter(risk => risk.payerAddress === payerAddress);
  }

  save(risk: EnergyPaymentRisk): void {
    this.mutateAll((risks) => {
      const remaining = risks.filter(item => !(item.payerAddress === risk.payerAddress && item.signedTxId === risk.signedTxId));
      remaining.push(risk);
      return remaining;
    });
  }

  remove(payerAddress: string, signedTxId?: string): void {
    this.mutateAll(risks => risks.filter(risk =>
      risk.payerAddress !== payerAddress || (signedTxId !== undefined && risk.signedTxId !== signedTxId),
    ));
  }
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EnergyPurchaseClientOptions {
  baseUrl?: string;
  fetch?: FetchLike;
  tronWeb?: InstanceType<typeof TronWeb>;
  storage?: StorageLike;
  requestTimeoutMs?: number;
  paymentRetryIntervalMs?: number;
  paymentRetryTimeoutMs?: number;
  orderPollIntervalMs?: number;
  orderPollTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  networkFingerprint?: string;
}

function resolveBaseUrl(explicit?: string): string {
  const value = explicit || process.env.JUSTLEND_ENERGY_API_URL;
  if (!value) {
    throw new EnergyPurchaseError(
      'CONFIG_MISSING',
      'Set JUSTLEND_ENERGY_API_URL (or --energy-api-url). No production fallback is configured.',
    );
  }
  return validateTrustedUrl(value, 'energyApiHost');
}

function positiveInteger(value: unknown, label: string): number {
  const numberValue = Number(value);
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `${label} must be a positive safe integer.`);
  }
  return numberValue;
}

function validateQuoteInput(receivers: string[], energyPerReceiver: number, duration: string, config: EnergyPurchaseConfig): void {
  if (!Array.isArray(receivers) || receivers.length === 0) {
    throw new EnergyPurchaseError('EMPTY_RECEIVERS', 'At least one receiver is required.');
  }
  receivers.forEach((receiver, index) => validateAddress(receiver, `receiver[${index}]`));
  const energy = positiveInteger(energyPerReceiver, 'energyPerReceiver');
  const min = positiveInteger(config?.min_energy, 'config.min_energy');
  const max = positiveInteger(config?.max_energy, 'config.max_energy');
  const maxReceivers = positiveInteger(config?.max_batch_receivers, 'config.max_batch_receivers');
  if (max < min) throw new EnergyPurchaseError('INVALID_RESPONSE', 'API returned max_energy below min_energy.');
  if (energy < min || energy > max) {
    throw new EnergyPurchaseError('INVALID_AMOUNT', `Energy per receiver must be between ${min} and ${max}.`);
  }
  if (receivers.length > maxReceivers) {
    throw new EnergyPurchaseError('ADDR_OVERFLOW', `A maximum of ${maxReceivers} receivers is allowed.`);
  }
  if (!Array.isArray(config.supported_durations) || !config.supported_durations.includes(duration)) {
    throw new EnergyPurchaseError('INVALID_DURATION', 'duration must come from the live supported_durations list.');
  }
  validateAddress(config.payment_address, 'config payment_address');
}

function normalizeHex(value: unknown): string {
  return typeof value === 'string' ? value.replace(/^0x/i, '').toLowerCase() : '';
}

function providerFingerprint(tronWeb?: InstanceType<typeof TronWeb>): string {
  const values = [
    (tronWeb?.fullNode as any)?.host,
    (tronWeb?.solidityNode as any)?.host,
    (tronWeb?.eventServer as any)?.host,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return [...new Set(values.map(value => {
    try {
      const parsed = new URL(value);
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/$/, '')}`;
    } catch {
      return value.trim();
    }
  }))].join('|');
}

function consumerBuyMemo(receivers: string[], energy: number, duration: string): string {
  const payload = ['a6-buy-v1', String(energy), duration, ...receivers].join('\0');
  return `a6-buy-v1:${createHash('sha256').update(payload).digest('hex')}`;
}

function attachMemo(tronWeb: InstanceType<typeof TronWeb>, transaction: Record<string, any>, memo: string): Record<string, any> {
  const utils = (tronWeb as any)?.utils?.transaction;
  if (!transaction?.raw_data || typeof utils?.txJsonToPb !== 'function' ||
      typeof utils?.txPbToRawDataHex !== 'function' || typeof utils?.txPbToTxID !== 'function') {
    throw new EnergyPurchaseError('CONFIG_MISSING', 'TronWeb protobuf utilities are required to bind the payment memo safely.');
  }
  const payable: Record<string, any> = {
    ...transaction,
    raw_data: { ...transaction.raw_data, data: Buffer.from(memo, 'utf8').toString('hex') },
  };
  const protobuf = utils.txJsonToPb(payable);
  payable.raw_data_hex = normalizeHex(utils.txPbToRawDataHex(protobuf));
  payable.txID = normalizeHex(utils.txPbToTxID(protobuf));
  if (!payable.txID || !payable.raw_data_hex) {
    throw new EnergyPurchaseError('INVALID_UNSIGNED_TX', 'Unable to derive the memo-bound transaction identity.');
  }
  return payable;
}

function normalizeSignedTransaction(value: unknown, expected: Record<string, any>): Record<string, any> {
  const outer = value as Record<string, any> | undefined;
  const signed = outer?.signedTransaction || outer;
  if (
    !signed || typeof signed.txID !== 'string' || typeof signed.raw_data_hex !== 'string' || !signed.raw_data ||
    !Array.isArray(signed.signature) || signed.signature.length !== 1
  ) {
    throw new EnergyPurchaseError(
      'INVALID_SIGNED_TX',
      'Signer must return one signed TRX transfer with txID, raw_data, and exactly one signature.',
    );
  }
  if (normalizeHex(signed.txID) !== normalizeHex(expected.txID) ||
      normalizeHex(signed.raw_data_hex) !== normalizeHex(expected.raw_data_hex)) {
    throw new EnergyPurchaseError(
      'SIGNED_TX_MISMATCH',
      'Signer returned a transaction that does not match the confirmed payer, recipient, amount, and request memo.',
    );
  }
  return signed;
}

function signedTransactionForWire(signed: Record<string, any>): SignedEnergyPurchaseRequest['signed_transaction'] {
  return {
    txID: normalizeHex(signed.txID),
    raw_data_hex: normalizeHex(signed.raw_data_hex),
    signature: [...signed.signature],
    visible: signed.visible === true,
  };
}

function shouldClearSignedRisk(error: EnergyPurchaseError): boolean {
  return error.isBusinessError && Number(error.status) >= 400 && Number(error.status) < 500 &&
    DETERMINISTIC_PRE_BROADCAST_CODES.has(error.code);
}

export class EnergyPurchaseClient {
  private static readonly activePayers = new Set<string>();
  readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly tronWeb?: InstanceType<typeof TronWeb>;
  private readonly storage: StorageLike;
  private readonly requestTimeoutMs: number;
  private readonly paymentRetryIntervalMs: number;
  private readonly paymentRetryTimeoutMs: number;
  private readonly orderPollIntervalMs: number;
  private readonly orderPollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly networkFingerprint: string;
  private readonly activeIntentTokens = new Map<string, string>();

  constructor(options: EnergyPurchaseClientOptions = {}) {
    this.baseUrl = resolveBaseUrl(options.baseUrl);
    this.fetchImpl = options.fetch || fetch;
    this.tronWeb = options.tronWeb;
    this.storage = options.storage || new FileEnergyPaymentRiskStore();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.paymentRetryIntervalMs = options.paymentRetryIntervalMs ?? 5000;
    this.paymentRetryTimeoutMs = options.paymentRetryTimeoutMs ?? PAYMENT_RETRY_TIMEOUT_MS;
    this.orderPollIntervalMs = options.orderPollIntervalMs ?? 3000;
    this.orderPollTimeoutMs = options.orderPollTimeoutMs ?? 150000;
    this.sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.now = options.now || Date.now;
    const provider = options.networkFingerprint?.trim() || providerFingerprint(this.tronWeb);
    this.networkFingerprint = provider ? `api=${this.baseUrl};provider=${provider}` : '';
  }

  private async request<T>(method: string, apiPath: string, options: {
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  } = {}): Promise<T> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? this.requestTimeoutMs);
    const signal = options.signal && typeof AbortSignal.any === 'function'
      ? AbortSignal.any([options.signal, timeout])
      : options.signal || timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${apiPath}`, {
        method,
        headers: {
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.token ? { 'X-Consumer-Order-Token': options.token } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal,
      });
    } catch (cause) {
      throw new EnergyPurchaseError('NETWORK_ERROR', 'Energy purchase API request returned no response.', {
        retryable: true,
        cause,
      });
    }

    let envelope: { code?: string; msg?: string; data?: T };
    try {
      envelope = await response.json() as typeof envelope;
    } catch (cause) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase API returned non-JSON data.', {
        status: response.status,
        retryable: response.status >= 500,
        cause,
      });
    }
    if (!response.ok) {
      const code = typeof envelope.code === 'string' && envelope.code.length > 0
        ? String(envelope.code).toUpperCase()
        : 'HTTP_ERROR';
      throw new EnergyPurchaseError(code, envelope.msg || `Energy purchase API returned HTTP ${response.status}.`, {
        status: response.status,
        isBusinessError: response.status >= 400 && response.status < 500 && code !== 'HTTP_ERROR',
        retryable: response.status >= 500,
      });
    }
    if (envelope.code !== '0') {
      const business = typeof envelope.code === 'string' && envelope.code.length > 0;
      throw new EnergyPurchaseError(business ? String(envelope.code).toUpperCase() : 'INVALID_RESPONSE', envelope.msg, {
        status: response.status,
        isBusinessError: business,
      });
    }
    return envelope.data as T;
  }

  getConfig(signal?: AbortSignal): Promise<EnergyPurchaseConfig> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.config, { signal });
  }

  getCurrentPrice(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.currentPrice, { signal });
  }

  getPoolHealth(signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request('GET', ENERGY_PURCHASE_PATHS.poolHealth, { signal });
  }

  async quote(input: {
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    config?: EnergyPurchaseConfig;
    signal?: AbortSignal;
  }): Promise<EnergyPurchaseQuote> {
    const config = input.config || await this.getConfig(input.signal);
    validateQuoteInput(input.receivers, input.energyPerReceiver, input.duration, config);
    const quote = await this.request<Omit<EnergyPurchaseQuote, 'payment_address'>>('POST', ENERGY_PURCHASE_PATHS.quote, {
      body: { receivers: input.receivers, quantity: input.energyPerReceiver, duration: input.duration },
      signal: input.signal,
    });
    if (
      !Number.isSafeInteger(Number(quote?.total_sun)) || Number(quote.total_sun) <= 0
    ) {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase quote is missing required fields.');
    }
    return { ...quote, payment_address: config.payment_address } as EnergyPurchaseQuote;
  }

  getOrder(orderId: string | number, token?: string, signal?: AbortSignal): Promise<Record<string, any>> {
    if (String(orderId).length === 0) throw new EnergyPurchaseError('INVALID_ORDER_ID', 'orderId is required.');
    return this.request('GET', ENERGY_PURCHASE_PATHS.order(orderId), { token, signal });
  }

  getHistory(address: string, options: { page?: number; size?: number; signal?: AbortSignal } = {}): Promise<Record<string, any>> {
    void address;
    void options;
    return Promise.reject(new EnergyPurchaseError(
      'UNSUPPORTED_OPERATION',
      'The authoritative energy API has no order-history endpoint; persist the returned order ID and access token.',
    ));
  }

  getPaymentRisks(payerAddress: string): EnergyPaymentRisk[] {
    validateAddress(payerAddress, 'payerAddress');
    return this.storage.list(payerAddress);
  }

  private async buildAndSignPayment(input: {
    payerAddress: string;
    payAddress: string;
    amountSun: number;
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
  }): Promise<Record<string, any>> {
    if (!this.tronWeb?.transactionBuilder?.sendTrx) {
      throw new EnergyPurchaseError('CONFIG_MISSING', 'A TronWeb client is required to build the payment.');
    }
    validateAddress(input.payerAddress, 'payerAddress');
    validateAddress(input.payAddress, 'payAddress');
    const amountSun = positiveInteger(input.amountSun, 'amountSun');
    let unsigned = await this.tronWeb.transactionBuilder.sendTrx(input.payAddress, amountSun, input.payerAddress) as Record<string, any>;
    if (unsigned?.raw_data?.expiration && this.tronWeb.transactionBuilder.extendExpiration) {
      const seconds = Math.ceil((this.now() + ORDER_TTL_MS - Number(unsigned.raw_data.expiration)) / 1000);
      if (seconds > 0) {
        try {
          const candidate = { ...unsigned, raw_data: { ...unsigned.raw_data } };
          unsigned = await this.tronWeb.transactionBuilder.extendExpiration(candidate as any, seconds, { txLocal: true }) as Record<string, any>;
        } catch {
          // The shorter node-provided expiration remains a safe fallback.
        }
      }
    }
    unsigned = attachMemo(
      this.tronWeb,
      unsigned,
      consumerBuyMemo(input.receivers, input.energyPerReceiver, input.duration),
    );
    return normalizeSignedTransaction(await input.signTransaction(unsigned), unsigned);
  }

  private async lookupTransaction(txId: string): Promise<'found' | 'not_found' | 'unavailable'> {
    if (typeof this.tronWeb?.trx?.getTransaction !== 'function') return 'unavailable';
    try {
      const transaction = await this.tronWeb.trx.getTransaction(txId) as { txID?: string } | undefined;
      return transaction?.txID === txId ? 'found' : 'not_found';
    } catch (error) {
      return String((error as Error)?.message || error).toLowerCase().includes('transaction not found')
        ? 'not_found'
        : 'unavailable';
    }
  }

  private async pollOrder(orderId: string | number, token?: string, signal?: AbortSignal): Promise<Record<string, any> | null> {
    const deadline = this.now() + this.orderPollTimeoutMs;
    let detail: Record<string, any> | null = null;
    while (this.now() < deadline) {
      try {
        detail = await this.getOrder(orderId, token, signal);
        if ((ENERGY_PURCHASE_TERMINAL_STATES as readonly string[]).includes(detail.state)) return detail;
      } catch (error) {
        if (signal?.aborted) throw new EnergyPurchaseError('ABORTED', 'Order polling was aborted.', { cause: error });
        // Payment is already accepted; tolerate transient order-query failures until the deadline.
      }
      await this.sleep(this.orderPollIntervalMs);
    }
    return detail;
  }

  async reconcilePaymentRisks(payerAddress: string): Promise<EnergyPaymentRisk[]> {
    const risks = this.getPaymentRisks(payerAddress);
    for (const risk of risks) {
      if (!risk.networkFingerprint || !risk.signedRequest ||
          !this.networkFingerprint || risk.networkFingerprint !== this.networkFingerprint) {
        continue;
      }
      try {
        risk.recoveredOrder = await this.request<Record<string, unknown>>('POST', ENERGY_PURCHASE_PATHS.buy, {
          body: risk.signedRequest,
        });
        risk.paymentConfirmed = true;
        this.storage.save(risk);
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.code === 'TX_ALREADY_CLAIMED') {
          risk.paymentConfirmed = true;
          this.storage.save(risk);
        } else if (shouldClearSignedRisk(typed)) {
          this.storage.remove(payerAddress, risk.signedTxId);
        } else if (await this.lookupTransaction(risk.signedTxId) === 'found') {
          risk.paymentConfirmed = true;
          this.storage.save(risk);
        }
      }
    }
    return this.storage.list(payerAddress);
  }

  async purchase(input: {
    payerAddress: string;
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    expectedPayAddress: string;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
    onState?: (state: string) => void;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    validateAddress(input.payerAddress, 'payerAddress');
    if (EnergyPurchaseClient.activePayers.has(input.payerAddress)) {
      throw new EnergyPurchaseError('PAYMENT_IN_PROGRESS', 'Another energy purchase is already active for this payer.');
    }
    EnergyPurchaseClient.activePayers.add(input.payerAddress);
    let intentToken: string | undefined;
    try {
      const createdAt = this.now();
      intentToken = this.storage.acquirePurchaseIntent(
        input.payerAddress,
        createdAt,
        createdAt + PURCHASE_INTENT_TTL_MS,
      );
      this.activeIntentTokens.set(input.payerAddress, intentToken);
      return await this.purchaseWithIntent(input);
    } finally {
      try {
        if (intentToken !== undefined && this.activeIntentTokens.get(input.payerAddress) === intentToken) {
          this.storage.releasePurchaseIntent(input.payerAddress, intentToken);
        }
      } finally {
        if (this.activeIntentTokens.get(input.payerAddress) === intentToken) {
          this.activeIntentTokens.delete(input.payerAddress);
        }
        EnergyPurchaseClient.activePayers.delete(input.payerAddress);
      }
    }
  }

  private async purchaseWithIntent(input: {
    payerAddress: string;
    receivers: string[];
    energyPerReceiver: number;
    duration: string;
    expectedAmountSun: number;
    expectedPayAddress: string;
    signTransaction: (transaction: Record<string, any>) => Promise<unknown>;
    onState?: (state: string) => void;
    signal?: AbortSignal;
  }): Promise<Record<string, unknown>> {
    const existedBeforeReconciliation = this.getPaymentRisks(input.payerAddress);
    const existing = await this.reconcilePaymentRisks(input.payerAddress);
    if (existedBeforeReconciliation.length || existing.length) {
      throw Object.assign(
        new EnergyPurchaseError(
          'PAYMENT_RISK_UNRESOLVED',
          existing[0]?.paymentConfirmed
            ? 'A previous payment was recovered. Record its order result and resolve the marker before attempting another payment.'
            : 'A previous payment has an unknown result. Reconcile the exact signed request before attempting another payment.',
        ),
        { paymentRisk: existing[0] || existedBeforeReconciliation[0] },
      );
    }

    input.onState?.('quoting');
    const config = await this.getConfig(input.signal);
    const durations = Array.isArray(config.supported_durations) ? config.supported_durations.filter(item => typeof item === 'string' && item.trim()) : [];
    if (!durations.includes(input.duration)) {
      throw new EnergyPurchaseError('INVALID_DURATION', 'duration must come from the live /v1/config durations list.');
    }
    const quote = await this.quote({ ...input, config });
    const expectedAmountSun = positiveInteger(input.expectedAmountSun, 'expectedAmountSun');
    if (quote.total_sun !== expectedAmountSun) {
      throw new EnergyPurchaseError('AMOUNT_CHANGED', 'The authoritative quote differs from the exact amount confirmed.', {
        details: { expectedAmountSun: input.expectedAmountSun, amountSun: quote.total_sun },
      });
    }
    validateAddress(input.expectedPayAddress, 'expectedPayAddress');
    if (quote.payment_address !== input.expectedPayAddress) {
      throw new EnergyPurchaseError('PAYMENT_ADDRESS_CHANGED', 'The configured payment address differs from the confirmed address.');
    }
    if (!this.networkFingerprint) {
      throw new EnergyPurchaseError(
        'NETWORK_FINGERPRINT_REQUIRED',
        'Energy purchase requires a fixed network/provider fingerprint.',
      );
    }

    input.onState?.('signing');
    let signed: Record<string, any>;
    try {
      signed = await this.buildAndSignPayment({
        payerAddress: input.payerAddress,
        payAddress: quote.payment_address,
        amountSun: quote.total_sun,
        receivers: input.receivers,
        energyPerReceiver: input.energyPerReceiver,
        duration: input.duration,
        signTransaction: input.signTransaction,
      });
    } catch (cause) {
      // The callback may have completed wallet signing before its response was
      // lost. Preserve the O_EXCL intent lock until its conservative TTL.
      this.activeIntentTokens.delete(input.payerAddress);
      throw new EnergyPurchaseError(
        'SIGNING_RESULT_UNKNOWN',
        'The signer result is unknown; keep the payer blocked until the intent lock is reviewed.',
        { cause },
      );
    }
    const signedDeadline = Number.isFinite(Number(signed.raw_data?.expiration))
      ? Number(signed.raw_data.expiration)
      : this.now() + ORDER_TTL_MS;
    const retryDeadline = Math.min(signedDeadline, this.now() + this.paymentRetryTimeoutMs);
    const signedRequest: SignedEnergyPurchaseRequest = {
      receivers: [...input.receivers],
      energy: input.energyPerReceiver,
      duration: input.duration,
      payer_address: input.payerAddress,
      signed_transaction: signedTransactionForWire(signed),
    };
    const txId = signedRequest.signed_transaction.txID;
    const risk: EnergyPaymentRisk = {
      payerAddress: input.payerAddress,
      signedTxId: txId,
      createdAt: this.now(),
      expiresAt: signedDeadline,
      paymentConfirmed: false,
      networkFingerprint: this.networkFingerprint,
      signedRequest,
    };
    const intentToken = this.activeIntentTokens.get(input.payerAddress);
    if (intentToken && typeof this.storage.finalizePurchaseIntent === 'function') {
      this.activeIntentTokens.delete(input.payerAddress);
      this.storage.finalizePurchaseIntent(input.payerAddress, intentToken, risk);
    } else {
      // Custom stores must make save() durable before returning. The process
      // lock remains held until this call succeeds.
      this.storage.save(risk);
    }

    input.onState?.('submitting');
    let order: Record<string, any> | null = null;
    while (!order) {
      this.storage.save(risk);
      try {
        order = await this.request('POST', ENERGY_PURCHASE_PATHS.buy, {
          body: signedRequest,
          signal: input.signal,
        });
      } catch (error) {
        const typed = error as EnergyPurchaseError;
        if (typed.isBusinessError) {
          if (typed.code === 'TX_ALREADY_CLAIMED') {
            risk.paymentConfirmed = true;
            this.storage.save(risk);
            typed.paymentRisk = risk;
          } else if (shouldClearSignedRisk(typed)) {
            this.storage.remove(input.payerAddress, txId);
          }
          throw typed;
        }
        if (this.now() >= retryDeadline) {
          if (await this.lookupTransaction(txId) === 'found') {
            risk.paymentConfirmed = true;
            this.storage.save(risk);
            return { ok: true, orderId: null, txHash: txId, state: 'pending', confirmedOnChain: true };
          }
          throw Object.assign(
            new EnergyPurchaseError(
              'PAYMENT_RESULT_UNKNOWN',
              'Payment result is unknown. Do not create another signed payment until this risk is reconciled.',
              { cause: typed },
            ),
            { paymentRisk: risk },
          );
        }
        await this.sleep(this.paymentRetryIntervalMs);
      }
    }

    const batch = order.batch;
    const payment = order.payment;
    if (!batch || typeof batch.id !== 'string' || typeof batch.access_token !== 'string') {
      throw new EnergyPurchaseError('INVALID_RESPONSE', 'Energy purchase response is missing batch or access token.');
    }
    this.storage.remove(input.payerAddress, txId);
    const orderId = batch.id;
    const txHash = payment?.tx_hash || txId;
    input.onState?.('delivering');
    const detail = await this.pollOrder(orderId, batch.access_token, input.signal);
    const state = detail?.state || batch.state || 'pending';
    if (state === 'failed' || state === 'expired') {
      throw new EnergyPurchaseError('DELIVERY_FAILED', 'Payment was accepted but energy delivery failed.', {
        details: { orderId, txHash, state, detail },
      });
    }
    return { ok: true, orderId, txHash, state, detail };
  }
}
