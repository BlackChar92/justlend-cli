import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const SERVE_DIR = path.join(os.homedir(), '.justlend-cli');
const SERVE_STATE_FILE = path.join(SERVE_DIR, 'serve.json');
const SERVE_LOCK_FILE = path.join(SERVE_DIR, 'serve.lock');
const SOCKET_PATH = path.join(SERVE_DIR, 'serve.sock');

interface ServeState {
  pid: number;
  port: number;
  startedAt: string;
  token?: string;
}

export function getServeDir(): string {
  return SERVE_DIR;
}

function ensureServeDir(): void {
  if (!fs.existsSync(SERVE_DIR)) {
    fs.mkdirSync(SERVE_DIR, { recursive: true, mode: 0o700 });
  }
  // This must happen while acquiring the daemon lock, before any await in the
  // signer startup path. A best-effort chmod leaves a shared-group umask window
  // in which another local user can plant serve.json as a symlink.
  const stat = fs.lstatSync(SERVE_DIR);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Refusing to use an unsafe signer state directory: ${SERVE_DIR}`);
  }
  fs.chmodSync(SERVE_DIR, 0o700);
}

export function createIPCAuthToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function writeServeState(port: number, token = createIPCAuthToken()): string {
  ensureServeDir();
  const state: ServeState = { pid: process.pid, port, startedAt: new Date().toISOString(), token };
  const tempPath = `${SERVE_STATE_FILE}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(state, null, 2));
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // rename replaces a pre-existing symlink itself rather than following it.
    fs.renameSync(tempPath, SERVE_STATE_FILE);
    fs.chmodSync(SERVE_STATE_FILE, 0o600);
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original error */ }
    }
    try { fs.unlinkSync(tempPath); } catch { /* best effort cleanup */ }
    throw error;
  }
  return token;
}

export function readServeState(): ServeState | null {
  try {
    if (!fs.existsSync(SERVE_STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(SERVE_STATE_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

export function clearServeState(): void {
  try { fs.unlinkSync(SERVE_STATE_FILE); } catch { /* ignore */ }
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
  try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ }
}

export function acquireServeLock(): (() => void) | null {
  ensureServeDir();
  try {
    const fd = fs.openSync(SERVE_LOCK_FILE, 'wx');
    fs.writeSync(fd, String(process.pid));
    fs.closeSync(fd);
    return () => {
      try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ }
    };
  } catch {
    try {
      const pid = parseInt(fs.readFileSync(SERVE_LOCK_FILE, 'utf-8'), 10);
      process.kill(pid, 0);
      return null;
    } catch {
      try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ }
      try {
        const fd = fs.openSync(SERVE_LOCK_FILE, 'wx');
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return () => {
          try { fs.unlinkSync(SERVE_LOCK_FILE); } catch { /* ignore */ }
        };
      } catch {
        return null;
      }
    }
  }
}

export type RequestHandler = (
  method: string,
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export function startIPCServer(expectedToken: string, handler: RequestHandler): Promise<net.Server> {
  try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }

  const server = net.createServer((conn) => {
    let buffer = '';
    const activeAborts = new Set<AbortController>();

    conn.on('error', () => {});

    conn.on('data', (chunk) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        handleMessage(conn, line, expectedToken, handler, activeAborts);
      }
    });

    conn.on('close', () => {
      for (const controller of activeAborts) controller.abort();
      activeAborts.clear();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(SOCKET_PATH, () => {
      server.removeListener('error', reject);
      // The parent dir is already 0o700 (writeServeState), so no other uid can
      // traverse to the socket even in the listen→chmod window. We still tighten
      // the socket itself, and — unlike before — abort on chmod failure instead
      // of silently leaving the signing channel at the umask default. A swallowed
      // chmod is exactly the failure that matters if the parent-dir guarantee
      // ever regresses.
      try {
        fs.chmodSync(SOCKET_PATH, 0o600);
      } catch (err) {
        try { fs.unlinkSync(SOCKET_PATH); } catch { /* ignore */ }
        server.close(() => {});
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      resolve(server);
    });
  });
}

export function validateIPCRequest(
  msg: { token?: unknown; method?: unknown },
  expectedToken: string,
): void {
  if (typeof expectedToken !== 'string' || expectedToken.length === 0) {
    throw new Error('IPC authentication unavailable');
  }
  if (typeof msg.token !== 'string' || msg.token.length === 0) {
    throw new Error('IPC authentication required');
  }
  if (expectedToken.length !== msg.token.length) {
    throw new Error('IPC authentication failed');
  }
  if (!crypto.timingSafeEqual(Buffer.from(expectedToken) as unknown as NodeJS.ArrayBufferView, Buffer.from(msg.token) as unknown as NodeJS.ArrayBufferView)) {
    throw new Error('IPC authentication failed');
  }
}

function handleMessage(
  conn: net.Socket,
  raw: string,
  expectedToken: string,
  handler: RequestHandler,
  activeAborts: Set<AbortController>,
): void {
  let msg: { id: number; method: string; token?: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  try {
    validateIPCRequest(msg, expectedToken);
  } catch (err) {
    if (!conn.destroyed) {
      conn.write(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }) + '\n');
    }
    return;
  }
  const controller = new AbortController();
  activeAborts.add(controller);

  handler(msg.method, msg.params || {}, controller.signal)
    .then((result) => {
      activeAborts.delete(controller);
      if (!conn.destroyed) {
        conn.write(JSON.stringify({ id: msg.id, result }) + '\n');
      }
    })
    .catch((err) => {
      activeAborts.delete(controller);
      if (!conn.destroyed) {
        conn.write(JSON.stringify({ id: msg.id, error: err instanceof Error ? err.message : String(err) }) + '\n');
      }
    });
}

export async function tryConnectIPC(): Promise<IPCClient | null> {
  const state = readServeState();
  if (!state) return null;
  try { process.kill(state.pid, 0); } catch {
    clearServeState();
    return null;
  }
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        conn.destroy();
        resolve(null);
      }
    }, 1000);
    const conn = net.createConnection(SOCKET_PATH, () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(new IPCClient(conn, state.token));
      }
    });
    conn.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        clearServeState();
        resolve(null);
      }
    });
  });
}

export class IPCClient {
  private conn: net.Socket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = '';
  private token: string | undefined;

  constructor(conn: net.Socket, token?: string) {
    this.conn = conn;
    this.token = token;
    conn.on('data', (chunk) => {
      this.buffer += chunk.toString();
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        this.handleResponse(line);
      }
    });
    conn.on('error', () => this.rejectAll('IPC connection lost'));
    conn.on('close', () => this.rejectAll('IPC connection closed'));
  }

  private handleResponse(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    } catch { /* ignore */ }
  }

  private rejectAll(reason: string): void {
    for (const [, p] of this.pending) p.reject(new Error(reason));
    this.pending.clear();
  }

  async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 300_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`IPC call "${method}" timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.conn.write(JSON.stringify({ id, method, params, token: this.token }) + '\n');
    });
  }

  disconnect(): void {
    this.conn.destroy();
    this.pending.clear();
  }
}
