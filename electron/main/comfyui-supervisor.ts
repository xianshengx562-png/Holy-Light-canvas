import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 本机 ComfyUI 的**启动器**。
 *
 * 和 `backend-supervisor.ts` 长得像，但有**三条关键区别**，动手改之前先看这里：
 *
 * 1. **绝不自动重启。** 后端是我们自己的东西，崩了就退避重启；ComfyUI 是用户的软件，
 *    里面可能正跑着一个 20 分钟的生成。它退了就是退了，只如实报状态，不许偷偷拉起来
 *    —— 那会把用户排队/在跑的任务反复打断，比不启动还糟。
 * 2. **只管「起」，不管「配」。** 参数（端口 / listen 地址）从连接配置里的 baseUrl 反推，
 *    目录从 `comfyuiDir` 来。这里不猜、不写、不改用户 ComfyUI 的任何文件。
 * 3. **就绪判据是「端口能答 `/system_stats`」**，不是「进程还活着」。
 *    ComfyUI 起一次要 40 秒到 3 分钟（插件多，实测 comfy-mtb 一个就吃 35 秒），
 *    进程活着但还没监听是**正常中间态**，这时候必须报 `starting` 而不是 `ready`。
 *
 * 状态机（**没有 reconnecting** —— 见第 1 条）：
 *   idle ──► starting ──► ready
 *              │            │
 *              │            ▼ 进程退出
 *              ▼        stopped
 *            failed（起不来：找不到 python / 端口被占 / 启动超时）
 */
export type ComfyuiState = 'idle' | 'starting' | 'ready' | 'stopped' | 'failed';

export type ComfyuiStatus = {
  state: ComfyuiState;
  /** 给界面直接显示的一句话。失败时这里就是诊断线索，不要吞。 */
  message: string;
  /** 正在起的那个进程的 pid，没有则 null。 */
  pid: number | null;
  /** 这次启动是什么时候发起的（ISO），没有则 null。界面用它显示「已等待 1 分 20 秒」。 */
  startedAt: string | null;
  /** 启动命令与工作目录，**只读展示用** —— 出问题时用户一眼能看出我们用的是哪个 python。 */
  command: string | null;
  cwd: string | null;
};

/**
 * 启动超时。给到 **5 分钟**：实测同样一份整合包，第一次 40 秒、第二次 178 秒
 * （插件目录缓存冷热不同）。按「快点超时」设会把人正常的首次启动判成失败。
 */
const READY_TIMEOUT_MS = 5 * 60_000;
/** 轮询 `/system_stats` 的间隔。ComfyUI 起不来时我们要能相对及时地发现问题。 */
const PROBE_INTERVAL_MS = 1500;
/** 单次探活超时。**必须短**：端口还没监听时这个请求会立刻被拒，不需要长等。 */
const PROBE_TIMEOUT_MS = 2000;
/** 停止后的等待上限，超了就强杀。 */
const STOP_TIMEOUT_MS = 15_000;

export type ComfyuiLaunchSpec = {
  /** ComfyUI 根目录（里面应有 `main.py`）。 */
  comfyuiDir: string;
  /** 便携包根目录（里面应有 `python_embeded/python.exe`）。缺席则从 comfyuiDir 往上找。 */
  portableRoot?: string;
  /** 监听地址与端口，从 baseUrl 反推。 */
  host: string;
  port: number;
};

export type ComfyuiSupervisor = {
  start: (spec: ComfyuiLaunchSpec) => Promise<ComfyuiStatus>;
  stop: () => Promise<ComfyuiStatus>;
  status: () => ComfyuiStatus;
  onState: (listener: (status: ComfyuiStatus) => void) => () => void;
  /** 应用退出时调：把子进程收掉，不要让 ComfyUI 变成孤儿。 */
  dispose: () => void;
};

/** 从 `http://127.0.0.1:8188` 里拆出 host 和 port；拆不出来退回 ComfyUI 的默认值。 */
export function parseBaseUrl(baseUrl: string): { host: string; port: number } {
  try {
    const url = new URL(String(baseUrl || '').trim());
    const port = Number(url.port);
    if (Number.isFinite(port) && port > 0) return { host: url.hostname || '127.0.0.1', port };
  } catch { /* 不是合法 URL，落回默认 */ }
  return { host: '127.0.0.1', port: 8188 };
}

/**
 * 找出该用哪个 python。
 *
 * TE 整合包是**便携式**的：`python_embeded` 跟 ComfyUI 平级或在其上一级，
 * 用系统 python 起会因为缺 torch 立刻失败。所以按可能性从高到低依次找，
 * 全都找不到就返回 null（**不回退 `python`** —— 那样报出来的错会离真相很远）。
 */
export function findPython(comfyuiDir: string, portableRoot?: string): string | null {
  const roots = [portableRoot, comfyuiDir, path.dirname(comfyuiDir), path.dirname(path.dirname(comfyuiDir))]
    .filter((item): item is string => Boolean(item));
  const seen = new Set<string>();
  for (const root of roots) {
    for (const rel of [
      path.join('python_embeded', 'python.exe'),
      path.join('python_embeded', 'python'),
      path.join('venv', 'Scripts', 'python.exe'),
      path.join('.venv', 'Scripts', 'python.exe'),
    ]) {
      const candidate = path.join(root, rel);
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* 不存在就试下一个 */ }
    }
  }
  return null;
}

/** 启动前把该拦的当场拦下，让失败信息指向具体缺了什么，而不是一句「起不来」。 */
export function preflight(spec: ComfyuiLaunchSpec): { ok: true; python: string; main: string } | { ok: false; message: string } {
  const dir = String(spec.comfyuiDir || '').trim();
  if (!dir) return { ok: false, message: '还没配 ComfyUI 安装目录。到「设置 · ComfyUI 服务」里选一下它装在哪。' };
  let isDir = false;
  try {
    isDir = fs.statSync(dir).isDirectory();
  } catch { /* 下面统一报 */ }
  if (!isDir) return { ok: false, message: `ComfyUI 安装目录不存在：${dir}` };
  const main = path.join(dir, 'main.py');
  if (!fs.existsSync(main)) {
    return { ok: false, message: `${dir} 里没有 main.py —— 这里要选 ComfyUI 本身的根目录（里面有 main.py、custom_nodes、models），不是整合包的上一层。` };
  }
  const python = findPython(dir, spec.portableRoot);
  if (!python) {
    return { ok: false, message: `在 ${dir} 附近找不到 python（找过 python_embeded / venv / .venv）。便携包请把「整合包根目录」也填上，好让我们知道用哪个解释器。` };
  }
  return { ok: true, python, main };
}

export function createComfyuiSupervisor(options: { logsDir: string }): ComfyuiSupervisor {
  let status: ComfyuiStatus = { state: 'idle', message: '还没启动过。', pid: null, startedAt: null, command: null, cwd: null };
  let child: ChildProcess | null = null;
  let probeTimer: NodeJS.Timeout | null = null;
  let readyTimer: NodeJS.Timeout | null = null;
  /** 每次启动发一个号：旧启动的轮询回调靠它认出「我已经过期了」，不会去动新进程的状态。 */
  let generation = 0;
  /** 子进程的 stdout/stderr 落盘用的两条流。`openLogs` / `closeLogs` 共用。 */
  let logStreams: fs.WriteStream[] = [];
  const listeners = new Set<(status: ComfyuiStatus) => void>();

  function publish(next: Partial<ComfyuiStatus>): ComfyuiStatus {
    status = { ...status, ...next };
    for (const listener of [...listeners]) listener(status);
    return status;
  }

  function clearTimers(): void {
    if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
    if (readyTimer) { clearTimeout(readyTimer); readyTimer = null; }
  }

  function onState(listener: (status: ComfyuiStatus) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /** stdout/stderr 追加写盘：GUI 应用里没有控制台，启动日志就是唯一的现场。 */
  function openLogs(pid: number): void {
    try {
      fs.mkdirSync(options.logsDir, { recursive: true });
    } catch { /* 日志目录建不出来也得继续起 */ }
    logStreams = [
      fs.createWriteStream(path.join(options.logsDir, 'comfyui.stdout.log'), { flags: 'a' }),
      fs.createWriteStream(path.join(options.logsDir, 'comfyui.stderr.log'), { flags: 'a' }),
    ];
    logStreams[0].write(`\n=== 启动 pid=${pid} ${new Date().toISOString()} ===\n`);
  }

  function closeLogs(): void {
    for (const stream of logStreams) {
      try { stream.end(); } catch { /* 已经关了 */ }
    }
    logStreams = [];
  }

  async function probeOnce(spec: ComfyuiLaunchSpec): Promise<boolean> {
    const url = `http://${spec.host}:${spec.port}/system_stats`;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
      return response.ok;
    } catch {
      return false;
    }
  }

  async function start(spec: ComfyuiLaunchSpec): Promise<ComfyuiStatus> {
    if (status.state === 'starting' || status.state === 'ready') return status;

    const checked = preflight(spec);
    if (!checked.ok) {
      return publish({ state: 'failed', message: checked.message, pid: null, command: null, cwd: null, startedAt: null });
    }
    const mine = ++generation;    const args = ['-s', 'main.py', '--listen', spec.host, '--port', String(spec.port)];
    const commandLine = `"${checked.python}" ${args.join(' ')}`;

    /* 端口已经有人应答 —— 那是用户自己开着的 ComfyUI。**不要再去起一个**，
       两个进程抢同一个端口，第二个会起来又立刻死，用户只会看到一堆莫名其妙的报错。 */
    if (await probeOnce(spec)) {
      return publish({
        state: 'ready',
        message: `端口 ${spec.port} 上已经有 ComfyUI 在跑（可能是你自己开的），直接用就好。`,
        pid: null, command: commandLine, cwd: spec.comfyuiDir, startedAt: null,
      });
    }

    publish({
      state: 'starting',
      message: `正在启动 ComfyUI…（它插件多的时候要 1～3 分钟，日志写在 comfyui.stdout.log）`,
      pid: null, command: commandLine, cwd: spec.comfyuiDir, startedAt: new Date().toISOString(),
    });

    try {
      child = spawn(checked.python, args, {
        cwd: spec.comfyuiDir,
        /* `windowsHide` 让那个黑框别闪出来；`CREATE_NO_WINDOW` 是更硬的一层保险。 */
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      return publish({ state: 'failed', message: `起不来：${error instanceof Error ? error.message : 'spawn 失败'}`, pid: null });
    }

    const pid = child.pid ?? null;
    openLogs(pid ?? -1);
    child.stdout?.pipe(logStreams[0]);
    child.stderr?.pipe(logStreams[1]);
    publish({ pid });

    child.on('error', (error) => {
      if (mine !== generation) return;
      clearTimers(); closeLogs();
      publish({ state: 'failed', message: `起不来：${error.message}`, pid: null });
    });

    child.on('exit', (code, signal) => {
      if (mine !== generation) return;
      clearTimers(); closeLogs();
      child = null;
      /*
       * 退出码必须报出来。最常见的死法是「起来又立刻退」（缺依赖、插件语法错、
       * 端口被占），而用户那边只会看到「没起来」——不给 code 就完全没线索。
       */
      const how = signal ? `信号 ${signal}` : `退出码 ${code}`;
      publish({
        state: code === 0 ? 'stopped' : 'failed',
        message: code === 0
          ? 'ComfyUI 已退出。'
          : `ComfyUI 退出了（${how}）。详细原因看 comfyui.stderr.log —— 常见的是端口被占、或某个插件装坏了。`,
        pid: null, startedAt: null,
      });
    });

    /* 起来之后死等端口答话，答上了才算 ready。 */
    await new Promise<void>((resolve) => {
      probeTimer = setInterval(() => {
        if (mine !== generation) { clearTimers(); resolve(); return; }
        void probeOnce(spec).then((alive) => {
          if (!alive || mine !== generation) return;
          clearTimers();
          publish({ state: 'ready', message: `ComfyUI 已就绪（http://${spec.host}:${spec.port}）。` });
          resolve();
        });
      }, PROBE_INTERVAL_MS);
      readyTimer = setTimeout(() => {
        if (mine !== generation) return;
        clearTimers();
        /* 超时不杀进程：它可能只是慢，还活着就留着，状态如实报 starting→failed 更好。 */
        publish({
          state: 'failed',
          message: `等了 ${Math.round(READY_TIMEOUT_MS / 60000)} 分钟还是没能连上 ${spec.host}:${spec.port}。它可能还在加载（看 comfyui.stdout.log 有没有 "Starting server"），也可能卡在某个插件上。`,
        });
        resolve();
      }, READY_TIMEOUT_MS);
    });

    return status;
  }

  async function stop(): Promise<ComfyuiStatus> {
    const target = child;
    generation += 1;
    clearTimers();
    if (!target || target.exitCode !== null) {
      child = null;
      return publish({ state: 'stopped', message: 'ComfyUI 没在跑。', pid: null, startedAt: null });
    }
    const mine = generation;
    const exited = new Promise<void>((resolve) => target.once('exit', () => resolve()));
    /* Windows 上 SIGTERM 不可靠，ComfyUI 对它的处理也不一定干净 —— 直接 kill 就好，
       它不是我们的进程，没有「刷盘」要照顾。 */
    try { target.kill(); } catch { /* 已经没了 */ }
    const timer = setTimeout(() => { try { target.kill('SIGKILL'); } catch { /* 已经没了 */ } }, STOP_TIMEOUT_MS);
    await exited;
    clearTimeout(timer);
    if (mine !== generation) return status;
    closeLogs();
    child = null;
    return publish({ state: 'stopped', message: '已关掉 ComfyUI。', pid: null, startedAt: null });
  }

  /** 应用退出时收尾。**同步**收：`before-quit` 里没时间等 Promise。 */
  function dispose(): void {
    generation += 1;
    clearTimers();
    closeLogs();
    const target = child;
    child = null;
    if (target && target.exitCode === null) {
      try { target.kill(); } catch { /* 已经没了 */ }
    }
  }

  return { start, stop, status: () => status, onState, dispose };
}
