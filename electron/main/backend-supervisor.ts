import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';

/**
 * 后端进程的监管器。
 *
 * 后端是**独立进程**，跑在 Electron 的 utilityProcess 里（纯 Node，拿不到 electron 模块），
 * 只通过一条 Windows 命名管道跟本进程说话。它崩了不影响窗口，退出前还能自己收尾。
 *
 * 状态机（会推给窗口，让界面能显示「本机服务正在重新连接」）：
 *   stopped ──► starting ──► ready
 *                  │           │
 *                  │           ▼ 崩溃
 *                  │       reconnecting ──► ready（退避后重启）
 *                  ▼       太多崩溃
 *                failed
 *   ready ──► stopping ──► stopped（先发 stop 让它刷盘，超时才强杀）
 */
export type BackendState = 'stopped' | 'starting' | 'ready' | 'reconnecting' | 'stopping' | 'failed';

/** 一次崩溃一个延迟；窗口内崩超过这个次数就认定后端坏了，不再白重试。 */
const RESTART_DELAYS_MS = [300, 1000, 2000, 4000, 8000];
const RESTART_WINDOW_MS = 120_000;
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 10_000;

export type BackendSupervisor = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onState: (listener: (state: BackendState) => void) => () => void;
  state: () => BackendState;
  /** 只有 ready 才给管道名 —— 给出去就要能连上。 */
  pipePath: () => string | null;
  /**
   * 等后端真的 ready（最多 `timeoutMs` 毫秒）。给「后端还在起、请求先别急着失败」那条路用。
   * 已经坏了（`failed` / `stopped`）**立刻**回 false —— 那时候等下去只是干耗。
   */
  awaitReady: (timeoutMs: number) => Promise<boolean>;
};

export function createBackendSupervisor(options: {
  entry: string;
  cwd: string;
  environment: Record<string, string | undefined>;
  logsDir: string;
  /**
   * 开发态端口。给了就走「只绑回环地址的端口」而不是命名管道 ——
   * Vite 的 dev server 只能代理 HTTP，代理不了管道。打包后这里一定是空的。
   */
  devPort?: number;
}): BackendSupervisor {
  let state: BackendState = 'stopped';
  let child: UtilityProcess | null = null;
  let pipe: string | null = null;
  let restartTimer: NodeJS.Timeout | null = null;
  let crashes: number[] = [];
  let generation = 0;
  const listeners = new Set<(state: BackendState) => void>();

  function publish(next: BackendState): void {
    if (state === next) return;
    state = next;
    for (const listener of [...listeners]) listener(next);
  }

  function onState(listener: (state: BackendState) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** stdout/stderr 追加写盘：打包后没有控制台，没有日志就等于没有现场。 */
  function openLogs(current: UtilityProcess): () => void {
    try {
      fs.mkdirSync(options.logsDir, { recursive: true });
    } catch {
      /* 日志目录建不出来也得继续起后端 */
    }
    const streams: [NodeJS.ReadableStream | null, fs.WriteStream][] = [
      [current.stdout ?? null, fs.createWriteStream(path.join(options.logsDir, 'backend.stdout.log'), { flags: 'a' })],
      [current.stderr ?? null, fs.createWriteStream(path.join(options.logsDir, 'backend.stderr.log'), { flags: 'a' })],
    ];
    for (const [source, target] of streams) source?.pipe(target);
    return () => {
      for (const [source, target] of streams) {
        source?.unpipe?.(target);
        target.end();
      }
    };
  }

  function handleExit(current: UtilityProcess): void {
    if (child !== current) return;
    child = null;
    pipe = null;
    if (state === 'stopping' || state === 'stopped') {
      publish('stopped');
      return;
    }
    const now = Date.now();
    crashes = [...crashes.filter((time) => now - time < RESTART_WINDOW_MS), now];
    if (crashes.length > RESTART_DELAYS_MS.length) {
      publish('failed');
      return;
    }
    publish('reconnecting');
    restartTimer = setTimeout(() => {
      restartTimer = null;
      void launch();
    }, RESTART_DELAYS_MS[crashes.length - 1]);
  }

  function launch(): void {
    const mine = generation;
    /*
     * 每次启动换一个新的管道名：上一轮没退干净的进程不会占着同名管道，
     * 也就不会出现「新后端连不上旧管道」这种诡异状态。
     * 非 Windows 没有命名管道，退回只绑回环地址的端口。
     */
    const usePipe = process.platform === 'win32' && !options.devPort;
    const launchPipe = usePipe ? `\\\\.\\pipe\\frame-backend-${randomUUID()}` : '';
    const env: Record<string, string | undefined> = {
      ...options.environment,
      HOLYLIGHT_BACKEND_PIPE: launchPipe,
      HOLYLIGHT_BACKEND_PORT: usePipe ? '' : String(options.devPort ?? 5174),
    };

    let current: UtilityProcess;
    try {
      current = utilityProcess.fork(options.entry, [], {
        serviceName: 'HolyLight Backend',
        cwd: options.cwd,
        env,
        stdio: 'pipe',
      });
    } catch (error) {
      console.error('[backend] fork 失败', error);
      publish('failed');
      return;
    }
    child = current;
    pipe = launchPipe;
    const closeLogs = openLogs(current);
    const timeout = setTimeout(() => current.kill(), READY_TIMEOUT_MS);

    current.on('message', (message: { type?: string }) => {
      if (message?.type !== 'ready') return;
      clearTimeout(timeout);
      if (child === current) publish('ready');
    });
    current.on('exit', (code: number) => {
      clearTimeout(timeout);
      closeLogs();
      /*
       * 退出码必须记下来：后端最常见的死法是「一启动就退」（入口路径不对、cwd 是 asar 内部、
       * 缺模块），而 utilityProcess 不会替我们把子进程的 stderr 转发到主进程的控制台 ——
       * 没有这一行就只有一个「failed」，完全没有线索。
       */
      if (code !== 0) console.error(`[backend] 进程退出 code=${code} entry=${options.entry} cwd=${options.cwd}`);
      handleExit(current);
    });
    void mine;
  }

  async function waitFor(predicate: (state: BackendState) => boolean, failure: BackendState[]): Promise<void> {
    if (predicate(state)) return;
    await new Promise<void>((resolve, reject) => {
      const off = onState((next) => {
        if (predicate(next)) {
          off();
          resolve();
        } else if (failure.includes(next)) {
          off();
          reject(new Error(`后端进入 ${next} 状态`));
        }
      });
    });
  }

  async function start(): Promise<void> {
    if (['starting', 'ready'].includes(state)) {
      await waitFor((s) => s === 'ready', ['failed', 'stopped']);
      return;
    }
    if (child || restartTimer) await stop();
    generation += 1;
    crashes = [];
    publish('starting');
    const ready = waitFor((s) => s === 'ready', ['failed', 'stopped']);
    launch();
    await ready;
  }

  /**
   * 等后端进入 ready（2026-09-29）。
   *
   * 为什么需要它：窗口是**先开**的（等后端再开窗，启动看起来像卡死），
   * 于是页面第一批请求常常撞在「后端还没 ready」那一两秒上，拿回来一个 503。
   * 以前那是终局 —— 那一趟失败就定死了，界面上整场会话少一个档位。
   * 现在主进程可以先把请求挂住等一下，ready 一到就照常转发。
   */
  async function awaitReady(timeoutMs: number): Promise<boolean> {
    if (state === 'ready') return true;
    if (state === 'failed' || state === 'stopped' || state === 'stopping') return false;
    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        resolve(value);
      };
      const timer = setTimeout(() => finish(state === 'ready'), Math.max(0, timeoutMs));
      const off = onState((next) => {
        if (next === 'ready') finish(true);
        else if (next === 'failed' || next === 'stopped' || next === 'stopping') finish(false);
      });
    });
  }

  async function stop(): Promise<void> {
    generation += 1;
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
    }
    const current = child;
    if (!current) {
      publish('stopped');
      return;
    }
    publish('stopping');
    const exited = new Promise<void>((resolve) => current.once('exit', () => resolve()));
    const killer = setTimeout(() => current.kill(), STOP_TIMEOUT_MS);
    try {
      /*
       * 先礼后兵：让后端自己 flush 数据。直接 kill 的话，
       * 最后一批改动会留在内存里。
       */
      current.postMessage({ type: 'stop' });
    } catch {
      current.kill();
    }
    await exited;
    clearTimeout(killer);
    publish('stopped');
  }

  return {
    start,
    stop,
    onState,
    state: () => state,
    pipePath: () => (state === 'ready' ? pipe : null),
    awaitReady,
  };
}
