import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';

export function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    'cache-control': 'no-store',
  });
  res.end(json);
}

export async function readJsonBody(req: IncomingMessage, maxBytes = 4 * 1024 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new Error('request body too large');
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('request body must be valid JSON');
  }
}

export function parseCliArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith('--')) continue;
    const withoutPrefix = token.slice(2);
    const equals = withoutPrefix.indexOf('=');
    if (equals >= 0) {
      args[withoutPrefix.slice(0, equals)] = withoutPrefix.slice(equals + 1);
    } else {
      const key = withoutPrefix;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

export function requireStringArg(args: Record<string, string | boolean>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`missing required --${key}`);
  }
  return value;
}

export function numberArg(
  args: Record<string, string | boolean>,
  key: string,
  defaultValue: number,
): number {
  const value = args[key];
  if (value === undefined || value === true) return defaultValue;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a number`);
  return parsed;
}

export async function fetchJson(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
): Promise<{ status: number; body: any; text: string }> {
  const { timeoutMs = 5000, headers, ...rest } = init;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    const response = await fetch(url, {
      ...rest,
      headers,
      signal: controller.signal,
    });
    const text = await response.text();
    let body: any = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reports whether a fixed port already has a listening socket. This is only a
 * pre-flight signal: the authoritative readiness signal is the spawned
 * process's own health answer carrying its instance id (see
 * waitForInstanceHealth). Nothing is closed or killed by this probe, so an
 * existing occupant keeps running and answering.
 */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const done = (occupied: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      done(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      done(false);
    });
    socket.connect({ port, host });
  });
}

export interface InstanceHealth {
  status: number;
  body: any;
  text: string;
}

/**
 * Waits for a health answer that belongs to THIS startup's process. A 200 from
 * a pre-existing port occupant whose health body carries a different instance
 * id (or no instance id) never satisfies the wait, and the child exiting
 * early fails fast instead of polling until the deadline.
 */
export async function waitForInstanceHealth(
  url: string,
  instanceId: string,
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    didExit?: () => { exited: boolean; code?: number | null; signal?: NodeJS.Signals | null };
    label?: string;
  } = {},
): Promise<void> {
  const { timeoutMs = 15_000, signal, didExit, label = url } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error('启动在组件就绪前被中断（Ctrl+C）');
    const exit = didExit?.();
    if (exit?.exited) {
      throw new Error(
        `${label} 进程在就绪前退出（code=${exit.code ?? ''} signal=${exit.signal ?? ''}）`,
      );
    }
    let result: InstanceHealth;
    try {
      result = await fetchJson(`${url}/health`, { timeoutMs: 500 });
    } catch (error) {
      lastError = error;
      await abortableDelay(signal);
      continue;
    }
    if (result.status === 200 && result.body?.instanceId === instanceId) return;
    if (result.status === 200) {
      lastError = new Error(
        `端口 ${new URL(url).port} 上的健康应答来自其他占用者（instanceId=${String(
          result.body?.instanceId ?? 'none',
        )}），不能算作本次启动就绪`,
      );
    } else {
      lastError = new Error(`health status ${result.status}; body=${result.text.slice(0, 200)}`);
    }
    await abortableDelay(signal);
  }
  throw new Error(`${label} 未在 ${timeoutMs}ms 内报告本次实例就绪: ${String(lastError)}`);
}

function abortableDelay(signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('启动在组件就绪前被中断（Ctrl+C）'));
      return;
    }
    const timer = setTimeout(resolve, 80);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('启动在组件就绪前被中断（Ctrl+C）'));
      },
      { once: true },
    );
  });
}
