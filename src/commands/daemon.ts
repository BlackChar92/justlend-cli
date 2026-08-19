import { Command } from 'commander';
import { TronSigner } from 'tronlink-signer';
import { acquireServeLock, clearServeState, getServeDir, startIPCServer, writeServeState } from '../lib/ipc.js';
import { dispatchSignerCall, initSigner, resolveSignerTimeout, shutdownSigner } from '../lib/signer.js';
import { getNetworkFromCommand } from '../lib/command-utils.js';
import { emitJson, outputResult } from '../lib/output.js';

export function registerDaemonCommands(program: Command): void {
  program
    .command('connect')
    .description('Verify TronLink wallet connection')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      const network = getNetworkFromCommand(this);
      const handle = await initSigner(opts.port);
      try {
        const result = await handle.call('connect', { network }, resolveSignerTimeout()) as Record<string, unknown>;
        outputResult(result, 'TronLink Connected', Boolean(opts.json));
      } finally {
        if (!handle.isIPC()) await shutdownSigner();
      }
    });

  program
    .command('serve')
    .description('Run signer daemon and IPC server')
    .option('--idle-timeout <minutes>', 'Auto-shut down after this many idle minutes (0 disables)', '10')
    .action(async function (this: Command) {
      const opts = this.optsWithGlobals();
      if (opts.port) process.env.TRON_HTTP_PORT = String(opts.port);
      const release = acquireServeLock();
      if (!release) throw new Error(`justlend serve is already running. State dir: ${getServeDir()}`);

      // Idle auto-shutdown window. NaN/negative input falls back to the 10-min
      // default (mirrors the JUSTLEND_TIMEOUT NaN guard); 0 disables it.
      const idleParsed = Number(opts.idleTimeout);
      const idleMinutes = Number.isFinite(idleParsed) && idleParsed >= 0 ? idleParsed : 10;
      const IDLE_TIMEOUT_MS = idleMinutes * 60_000;

      const signer = new TronSigner();
      await signer.start();
      const port = signer.getConfig().httpPort;
      writeServeState(port);

      // Activity tracking for idle auto-shutdown. A long-running call (e.g. a
      // signature awaiting browser approval) is held open by inFlightRequests,
      // so the daemon never shuts down mid-operation.
      let lastActivityAt = Date.now();
      let inFlightRequests = 0;
      const server = await startIPCServer(async (method, params, signal) => {
        lastActivityAt = Date.now();
        inFlightRequests++;
        try {
          return await dispatchSignerCall(signer, method, params, signal);
        } finally {
          inFlightRequests--;
          lastActivityAt = Date.now();
        }
      });

      if (opts.json) {
        emitJson({ status: 'running', pid: process.pid, port, dir: getServeDir() });
      } else {
        process.stdout.write(`justlend signer daemon running (pid ${process.pid}, port ${port})\nState: ${getServeDir()}\n`);
      }

      let idleTimer: NodeJS.Timeout | undefined;
      const shutdown = async () => {
        if (idleTimer) clearInterval(idleTimer);
        server.close();
        clearServeState();
        release();
        try {
          await signer.stop();
        } catch (err) {
          process.stderr.write(`Warning: signer shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
          process.exitCode = 1;
        }
        process.exit(process.exitCode ?? 0);
      };
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);

      // Gracefully exit when no IPC activity for IDLE_TIMEOUT_MS and nothing is
      // in flight — a lingering signer daemon is unnecessary attack surface. The
      // interval itself keeps the event loop alive, so no separate keepalive is
      // needed; disabled (idleMinutes === 0) falls back to an idle keepalive.
      if (IDLE_TIMEOUT_MS > 0) {
        idleTimer = setInterval(() => {
          if (inFlightRequests > 0) return;
          if (Date.now() - lastActivityAt < IDLE_TIMEOUT_MS) return;
          process.stderr.write(`justlend serve idle for ${idleMinutes} minute(s) — shutting down.\n`);
          void shutdown();
        }, 60_000);
      } else {
        setInterval(() => {}, 60_000);
      }
      await new Promise<void>(() => {});
    });
}
