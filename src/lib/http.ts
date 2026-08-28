const DEFAULT_FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

import { debugLog } from './diagnostics.js';

export interface HttpRequestContext {
  code?: string;
  module?: string;
  network?: string;
  host?: string;
  path?: string;
  hint?: string;
  /**
   * Caller asserts this request has no side effects and can be safely retried
   * on transient 5xx / network errors. Never set this for signer/broadcast paths.
   */
  idempotent?: boolean;
}

export class HttpRequestError extends Error {
  readonly code: string;
  readonly module?: string;
  readonly network?: string;
  readonly host?: string;
  readonly path?: string;
  readonly hint?: string;
  readonly status?: number;
  readonly statusText?: string;
  override readonly cause?: unknown;

  constructor(message: string, context: HttpRequestContext & { status?: number; statusText?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'HttpRequestError';
    this.code = context.code ?? 'HTTP_REQUEST_FAILED';
    this.module = context.module;
    this.network = context.network;
    this.host = context.host;
    this.path = context.path;
    this.hint = context.hint;
    this.status = context.status;
    this.statusText = context.statusText;
    this.cause = context.cause;
  }
}

function contextFromInput(input: string | URL, context?: HttpRequestContext): HttpRequestContext {
  const url = typeof input === 'string' ? new URL(input) : input;
  return {
    ...context,
    host: context?.host ?? url.origin,
    path: context?.path ?? `${url.pathname}${url.search}`,
  };
}

function causeMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Execute a fetch with a default timeout to avoid indefinitely hung upstream
 * HTTP requests tying up CLI sessions.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);

  if (!init?.signal) {
    return fetch(input, { ...init, redirect: init?.redirect ?? 'error', signal: timeoutSignal });
  }

  if (typeof AbortSignal.any === "function") {
    return fetch(input, {
      ...init,
      redirect: init.redirect ?? 'error',
      signal: AbortSignal.any([init.signal, timeoutSignal]),
    });
  }

  return fetch(input, { ...init, redirect: init.redirect ?? 'error', signal: timeoutSignal });
}

function isRetriableError(err: unknown): boolean {
  if (err instanceof HttpRequestError) {
    return typeof err.status === 'number' && err.status >= 500 && err.status < 600;
  }
  if (err instanceof Error) {
    const lower = err.message.toLowerCase();
    return (
      lower.includes('econnreset') ||
      lower.includes('etimedout') ||
      lower.includes('enotfound') ||
      lower.includes('econnrefused') ||
      lower.includes('network error') ||
      lower.includes('failed to fetch') ||
      lower === 'fetch failed' ||
      lower.includes('socket hang up')
    );
  }
  return false;
}

function jitteredDelay(baseMs: number, jitterMs: number): number {
  return baseMs + Math.floor(Math.random() * jitterMs);
}

async function performFetch(
  input: string | URL,
  requestContext: HttpRequestContext,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<Response> {
  const started = Date.now();
  debugLog('http.request', { method: init?.method ?? 'GET', ...requestContext });
  try {
    const res = await fetchWithTimeout(input, init, timeoutMs);
    debugLog('http.response', { method: init?.method ?? 'GET', status: res.status, elapsedMs: Date.now() - started, ...requestContext });
    if (!res.ok) {
      throw new HttpRequestError(`HTTP ${res.status} ${res.statusText}`, {
        ...requestContext,
        code: requestContext.code ?? 'HTTP_STATUS_ERROR',
        status: res.status,
        statusText: res.statusText,
      });
    }
    return res;
  } catch (err) {
    if (err instanceof HttpRequestError) throw err;
    throw new HttpRequestError(causeMessage(err), {
      ...requestContext,
      code: requestContext.code ?? 'BACKEND_FETCH_FAILED',
      cause: err,
    });
  }
}

export async function fetchWithContext(
  input: string | URL,
  context?: HttpRequestContext,
  init?: RequestInit,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const requestContext = contextFromInput(input, context);
  const attempts = requestContext.idempotent ? 2 : 1;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await performFetch(input, requestContext, init, timeoutMs);
    } catch (err) {
      lastErr = err;
      const more = i + 1 < attempts;
      if (!more || !isRetriableError(err)) throw err;
      const delayMs = jitteredDelay(300, 400);
      debugLog('http.retry', {
        method: init?.method ?? 'GET',
        attempt: i + 1,
        nextDelayMs: delayMs,
        reason: err instanceof Error ? err.message : String(err),
        ...requestContext,
      });
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  // Unreachable: loop either returns or throws, but keep for type-checker.
  throw lastErr;
}

export async function promiseWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  timeoutMessage = `Operation timed out after ${timeoutMs}ms`,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export { DEFAULT_FETCH_TIMEOUT_MS, DEFAULT_RPC_TIMEOUT_MS };
