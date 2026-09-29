import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';

/**
 * 本机 ComfyUI 的**侦探** —— 回答两个问题：
 *
 *   1. 「ComfyUI 是不是已经在我机器上跑着？跑在哪个端口？」（`detectComfyuiProcesses`）
 *   2. 「它装在哪？」（`findComfyuiInstalls`）
 *
 * 与 `comfyui-supervisor.ts`（**负责起进程**）分工明确：**这里只读**。
 * 不拉起、不杀掉、不修改任何东西 —— 它是给「连不上」这件事找答案的，
 * 而一个会自己动手的侦探比找不到答案更糟。
 *
 * 为什么必须扫**进程命令行**而不是只扫固定端口：ComfyUI 的默认端口是 8188，
 * 但只要有人改过一次（`--port 8190`、或者装了两个实例），扫端口就只能撞运气。
 * 命令行里的 `--port` 才是它真正在听的那个 —— 这条思路来自 AIFISHER 的实现
 * （`F:\本地画布\AIFISHER`），它用 `Get-CimInstance Win32_Process` 读出 python 进程的
 * 命令行再正则抠端口，比逐个端口试连准得多。
 *
 * ⚠️ 三条硬纪律：
 *   - **限时**：扫盘和读进程都有预算（8 秒）。这一页是「打开就想看到结论」，
 *     扫 24 个盘符加两层目录最坏能跑到几十秒，那已经等于没响应。
 *   - **限量**：访问目录 400 个封顶、候选 20 个封顶。装过整合包的机器根目录能有几千项。
 *   - **认不出就认不出**：目录推断不出来就给 `null`，绝不猜一个「大概是的」路径
 *     塞给用户 —— 拿去启动的时候猜错的代价是「起不来」，比空白更难查。
 */

/** ComfyUI 命令行里的端口。`--port 8190` 和 `--port=8190` 都要认。 */
const PORT_RE = /--port(?:=|\s+)(\d{2,5})\b/;
/** 命令行里得像 ComfyUI：要么在跑 `main.py`，要么路径里带 comfyui。 */
const COMFY_RE = /main\.py|comfyui/i;
/** 往下钻一层时才看目录名：只有这些名字的目录才可能是整合包/ComfyUI 的藏身处。 */
const INTERESTING_RE = /comfy|^ai$|^tools$|^apps$|^software$|整合包|绘世|绘图/i;
/** 扫盘的时间预算。超了就带着已经找到的收工。 */
const TIME_BUDGET_MS = 8_000;
/** 访问目录数上限，防止在巨型目录树里跑飞。 */
const MAX_VISITS = 400;
const MAX_HITS = 20;
/** 读进程列表的超时。PowerShell 冷启动一次要 1～2 秒，8 秒是留足余量又不至于卡死。 */
const PROCESS_TIMEOUT_MS = 8_000;

export type ComfyuiProcessHit = {
  pid: number;
  /** 它真正在听的端口。命令行里没写 `--port` 就是 null（那就是默认的 8188）。 */
  port: number | null;
  /** 从命令行里认出来的安装目录；认不出是 null（比如用 `python -s main.py` 起的，命令行里没有绝对路径）。 */
  dir: string | null;
  /** 原始命令行，给界面「只读展示」用 —— 出问题时用户一眼能看出是哪个实例。 */
  commandLine: string;
};

export type ComfyuiInstallHit = {
  dir: string;
  name: string;
  hasMain: boolean;
  hasModels: boolean;
  hasCustomNodes: boolean;
  /** 附近有能用的 python（`python_embeded` / venv）—— 没有的话我们起不来它。 */
  hasPython: boolean;
};

/** 执行一条命令并拿 stdout。**流式收集**：进程列表可以很长，别用有 maxBuffer 上限的 exec。 */
function runCommand(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const finish = (text: string) => {
      if (done) return;
      done = true;
      try { child.kill(); } catch { /* 已经退了 */ }
      resolve(text);
    };
    const timer = setTimeout(() => finish(out), PROCESS_TIMEOUT_MS);
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      out += chunk;
      /* 长到离谱就直接收手：这只是为了认端口，不需要几 MB 的命令行。 */
      if (out.length > 400_000) finish(out);
    });
    child.on('error', () => { clearTimeout(timer); finish(out); });
    child.on('close', () => { clearTimeout(timer); finish(out); });
  });
}

/**
 * Windows 上读 python 进程的命令行。
 *
 * 为什么先按**进程名**过滤（`Name LIKE 'python%'`）而不是列全部进程再筛命令行：
 * 一台机器几百个进程，全列出来再传过 IPC 又慢又吵；ComfyUI 一定是 python 起的，
 * 名字过滤一次就把范围缩到几个。
 *
 * `[Console]::OutputEncoding` 必须设：中文路径的整合包（「绘世」「ComfyUI 整合包」）
 * 用默认的 GBK 输出会变成问号，目录就认不出来了。
 */
function windowsProcessLines(): Promise<string[]> {
  const script = [
    '[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)',
    'Get-CimInstance Win32_Process -Filter "Name LIKE \'python%\'" | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }',
  ].join(';');
  return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
    .then(text => text.split(/\r?\n/).filter(Boolean));
}

/** macOS / Linux：`ps -eo pid=,command=`。 */
function posixProcessLines(): Promise<string[]> {
  return runCommand('ps', ['-eo', 'pid=,command=']).then(text => text.split(/\r?\n/).filter(Boolean));
}

/** 从命令行里抠出 `main.py` 所在的目录。**只认绝对路径**，相对路径（`python -s main.py`）一律放弃。 */
export function dirFromCommandLine(line: string): string | null {
  const match = /(?:[A-Za-z]:[\\/]|\/)[^\s"'|]+\\?main\.py/i.exec(line);
  if (!match) return null;
  const file = match[0].replace(/\//g, path.sep);
  const dir = path.dirname(file);
  try {
    return fs.statSync(dir).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

/** 一行 `pid<TAB>commandLine` → 一条命中；不是 ComfyUI 就 null。 */
export function parseProcessLine(line: string): ComfyuiProcessHit | null {
  const tab = line.indexOf('\t');
  if (tab <= 0) return null;
  const pid = Number(line.slice(0, tab).trim());
  const commandLine = line.slice(tab + 1).trim();
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!COMFY_RE.test(commandLine)) return null;
  const raw = PORT_RE.exec(commandLine)?.[1];
  const port = raw ? Number(raw) : null;
  return {
    pid,
    port: port && Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    dir: dirFromCommandLine(commandLine),
    /* 命令行可能极长，界面只展示前一段 —— 认端口 / 认目录用的信息都在开头。 */
    commandLine: commandLine.slice(0, 400),
  };
}

/** 本机**正在跑着的** ComfyUI 实例。没跑着就是空数组（不是报错）。 */
export async function detectComfyuiProcesses(): Promise<ComfyuiProcessHit[]> {
  let lines: string[] = [];
  try {
    lines = process.platform === 'win32' ? await windowsProcessLines() : await posixProcessLines();
  } catch {
    return [];
  }
  const hits = lines
    .map(parseProcessLine)
    .filter((item): item is ComfyuiProcessHit => Boolean(item));
  /* 同一个实例可能被多条命令行命中（比如父/子 python），按 pid 去重。 */
  const seen = new Set<number>();
  return hits.filter(item => (seen.has(item.pid) ? false : (seen.add(item.pid), true)));
}

/** 一个目录「像不像 ComfyUI 的根」—— 只看一眼，不递归。 */
export function inspectComfyuiDir(dir: string): ComfyuiInstallHit {
  const stat = (rel: string) => {
    try {
      return fs.statSync(path.join(dir, rel)).isDirectory();
    } catch {
      return false;
    }
  };
  const hasMain = (() => {
    try {
      return fs.statSync(path.join(dir, 'main.py')).isFile();
    } catch {
      return false;
    }
  })();
  return {
    dir,
    name: path.basename(dir) || dir,
    hasMain,
    hasModels: stat('models'),
    hasCustomNodes: stat('custom_nodes'),
    hasPython: findPythonNearby(dir) !== null,
  };
}

/**
 * 附近有没有能用的 python（便携包的 `python_embeded` 或 venv）。
 *
 * 与 `comfyui-supervisor.ts` 的 `findPython` 是**同一套候选**（两边改一边就要同步另一边），
 * 但这里只回答「有没有」，不返回路径 —— 侦探不负责启动，不该让人以为它选好了解释器。
 */
function findPythonNearby(dir: string): string | null {
  const roots = [dir, path.dirname(dir), path.dirname(path.dirname(dir))];
  for (const root of roots) {
    for (const rel of [
      path.join('python_embeded', 'python.exe'),
      path.join('python_embeded', 'python'),
      path.join('venv', 'Scripts', 'python.exe'),
      path.join('.venv', 'Scripts', 'python.exe'),
    ]) {
      try {
        if (fs.statSync(path.join(root, rel)).isFile()) return path.join(root, rel);
      } catch { /* 换下一个候选 */ }
    }
  }
  return null;
}

/** 扫盘的起点：用户目录 + 桌面 / 下载 / 文档 + 存在的盘符。 */
function scanRoots(): string[] {
  const home = os.homedir();
  const roots = [home, path.join(home, 'Desktop'), path.join(home, 'Downloads'), path.join(home, 'Documents')];
  if (process.platform === 'win32') {
    for (let code = 67; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        if (fs.statSync(drive).isDirectory()) roots.push(drive);
      } catch { /* 这个盘不存在 */ }
    }
  } else {
    roots.push('/opt', '/Applications');
  }
  return roots;
}

/** 让出事件循环。**必须分帧**：见下面 `findComfyuiInstalls` 的说明。 */
function yieldToEventLoop(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/**
 * 扫一遍本机，找 ComfyUI 装在哪。
 *
 * 广度优先、最多两层：整合包几乎都躺在 `<盘>:\xxx\ComfyUI` 或 `<盘>:\ComfyUI` 这种深度，
 * 再深就是用户自己的文件夹了，钻进去只会拖慢速度还带来一堆误报。
 *
 * ⚠️ **它是 async 的，而且每 20 个目录让出一次事件循环** —— 这个函数的调用方是
 * **主进程**，而主进程同时还负责窗口。同步扫 8 秒 = 整个应用假死 8 秒（标题栏点不动、
 * 页面不响应），比扫不到目录更糟。分帧之后每帧只做几毫秒，窗口照常响应。
 *
 * @param configuredDir 已经配好的目录。**它排在第一个**，且只做「确认还在不在」，
 *   不参与名字筛选 —— 用户自己选过的路径就算叫 `abc` 也应该继续列着。
 */
export async function findComfyuiInstalls(configuredDir = ''): Promise<ComfyuiInstallHit[]> {
  const started = Date.now();
  const hits: ComfyuiInstallHit[] = [];
  const seen = new Set<string>();
  const queue: { dir: string; depth: number }[] = [];

  const push = (dir: string, depth: number) => {
    let resolved: string;
    try {
      resolved = fs.realpathSync(dir);
    } catch {
      return;
    }
    const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) return;
    seen.add(key);
    queue.push({ dir: resolved, depth });
  };

  const configured = String(configuredDir || '').trim();
  if (configured) push(configured, 2);

  for (const root of scanRoots()) push(root, 0);

  let visits = 0;
  while (queue.length && hits.length < MAX_HITS && visits < MAX_VISITS) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const { dir, depth } = queue.shift()!;
    visits += 1;
    if (visits % 20 === 0) await yieldToEventLoop();

    const info = inspectComfyuiDir(dir);
    /* `main.py` 是硬指标：没有它就不是 ComfyUI 的根目录，只是个叫 comfy 的文件夹。 */
    if (info.hasMain) {
      hits.push(info);
      continue;
    }
    if (depth >= 2) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (hits.length >= MAX_HITS || visits >= MAX_VISITS) break;
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      /*
       * 第一层（盘根 / 用户目录）下面什么都可能有，只钻名字可疑的：
       * 这就是「限时 + 限量」之外第三道护栏 —— 不钻 `Windows`、`Program Files` 这种。
       */
      if (depth > 0 || INTERESTING_RE.test(entry.name)) {
        push(path.join(dir, entry.name), depth + 1);
      }
    }
  }

  /* 有 main.py 的排前面；同样有 main.py 的按「更像完整安装」（有 models / custom_nodes / python）排序。 */
  return hits.sort((a, b) => score(b) - score(a));
}

function score(hit: ComfyuiInstallHit): number {
  return (hit.hasMain ? 8 : 0) + (hit.hasModels ? 4 : 0) + (hit.hasCustomNodes ? 2 : 0) + (hit.hasPython ? 1 : 0);
}
