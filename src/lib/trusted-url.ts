import chalk from 'chalk';

export type TrustedUrlKind = 'fullHost' | 'apiHost' | 'moolahApiHost' | 'energyApiHost';

const TRUSTED_HOSTS = new Set([
  'api.trongrid.io',
  'nile.trongrid.io',
  'labc.ablesdxd.link',
  'nileapi.justlend.org',
  'zenvora.ablesdxd.link',
  'tegrow.ablesdxd.link',
]);

const warned = new Set<string>();

export interface TrustedUrlOptions {
  allowInsecure?: boolean;
  allowUntrusted?: boolean;
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

export function allowUntrustedHostsFromEnv(): boolean {
  return envFlag('JUSTLEND_ALLOW_UNTRUSTED_HOSTS');
}

export function allowInsecureHostsFromEnv(): boolean {
  return envFlag('JUSTLEND_ALLOW_INSECURE_HOSTS');
}

export function validateTrustedUrl(input: string, kind: TrustedUrlKind, options: TrustedUrlOptions = {}): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid ${kind} URL: ${input}`);
  }

  const allowInsecure = options.allowInsecure || allowInsecureHostsFromEnv();
  const allowUntrusted = options.allowUntrusted || allowUntrustedHostsFromEnv();
  const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';

  if (url.protocol !== 'https:' && !(allowInsecure && isLocal)) {
    throw new Error(`${kind} must use https. Local http endpoints require JUSTLEND_ALLOW_INSECURE_HOSTS=1.`);
  }

  if (!TRUSTED_HOSTS.has(url.hostname) && !allowUntrusted) {
    throw new Error(
      `${kind} host "${url.hostname}" is not in the trusted allowlist. ` +
      `Set JUSTLEND_ALLOW_UNTRUSTED_HOSTS=1 only if you intentionally trust this endpoint.`,
    );
  }

  if (!TRUSTED_HOSTS.has(url.hostname) || url.protocol !== 'https:') {
    const key = `${kind}:${url.toString()}`;
    if (!warned.has(key)) {
      warned.add(key);
      process.stderr.write(chalk.yellow(`Warning: using custom ${kind} endpoint ${url.toString()}; ensure it is trusted.\n`));
    }
  }

  return url.toString().replace(/\/$/, '');
}

export function isTrustedUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === 'https:' && TRUSTED_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export function resetTrustedUrlWarningsForTests(): void {
  warned.clear();
}
