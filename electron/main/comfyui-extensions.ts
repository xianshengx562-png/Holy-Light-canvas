import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

/**
 * ComfyUI **扩展**（`custom_nodes/` 下的插件）的检测与安装。
 *
 * 与 `comfyui-detect.ts`（只读侦探）、`comfyui-supervisor.ts`（起进程）是同一族里的第三块：
 * 这一个**会往用户的 ComfyUI 里写文件**，所以它是三个里唯一需要设防的。
 *
 * ## 为什么要把扩展随包发出去、再复制进 custom_nodes
 *
 * Holy Light画布的「工作流配置」里每个字段都写成 `NODE 32.text` 这种定位，而 ComfyUI 画布上
 * 默认看不到节点实例编号 —— 用户只能靠节点标题和位置猜「哪个是 32」。猜错的代价不是报错，
 * 是**生成照跑、图照出，只是提示词没生效**。所以这两个扩展不是可选的装饰：
 * 装不装直接决定「配参数」这一步能不能配对。
 *
 * 但它们仍然是**可选**的：不装也能导入、也能生成，只是要自己数节点。
 * 界面上的文案必须留着这句话，否则用户会以为不装就不能用。
 *
 * ## 四条纪律
 *
 * 1. **只写 `custom_nodes/<id>` 这一个子目录**，不碰 ComfyUI 的其它任何地方，
 *    不写 `extra_model_paths.yaml`、不动 `models/`、不 pip install。
 * 2. **目标路径必须夹在 custom_nodes 里面**（`contained()`）。`id` 是我们自己写死的常量，
 *    但仍然逐层校验 —— 一次目录穿越就能把文件写到用户整个磁盘上。
 * 3. **原子写**：先全部写进 `<目标>.<pid>.<uuid>.tmp`，全部成功后再一起 rename。
 *    直接覆盖的话，中途失败会留下「一半新一半旧」的扩展，那比没装更难查。
 * 4. **不重启 ComfyUI**。写文件不影响已经在跑的进程（Python 那边模块早就 import 完了），
 *    重启会打断队列里的任务。只在回执里说一句「重启后生效」。
 *
 * ## 「装好了」的判据：随包自有的比哈希，和 AIFISHER 共用的只看在不在
 *
 * 目录在、文件缺一个（用户删过、杀毒软件删过、上次安装中断过）都是常见状态。
 * 只看目录存在与否会显示「已安装」，而实际是坏的 —— 那种「说好了其实是坏的」最难查。
 *
 * 但**这条规则只对 Holy Light画布自己随包的扩展成立**。现在这两个是和 AIFISHER **共用**的
 * 同一份目录（`fisherai_*`），AIFISHER 也在管它们、也会自己升级。我们若按内容哈希去判，
 * 它一升级我们就判成「需要修复」并覆盖回去，它再检测又覆盖回来 —— 两个应用互相踩。
 *
 * 所以共用的一律走 `presence`：目录里能读到 `__init__.py` 就算装好了，
 * **不比内容、也不写**，它升到几版都不关我们的事。只有当入口文件确实不在
 * （没装 / 装了一半）时才补一份进去。
 */

/** 一份随包扩展的说明。`files` 是**相对扩展根目录**的路径，用 `/` 分隔。 */
export type ComfyuiExtensionSpec = {
  id: string;
  /** 要复制进 `custom_nodes/<id>/` 的文件，缺一个都算没装好。 */
  files: readonly string[];
  /** 这个扩展是干什么的（界面上直接显示，不写「提升体验」这类空话）。 */
  purpose: string;
  /** 装了之后具体好在哪 —— 必须是一句用户能自己验证的话。 */
  benefit: string;
  /** 不装会怎样。留着这句，界面才不会让人误以为它们是必需的。 */
  optional: string;
  /**
   * 怎么算「装好了」：
   * - `presence`：**只看在不在**（能读到 `__init__.py` 就算好）。用于和别的应用共用的扩展 ——
   *   共用目录的升级归对方管，我们按哈希判会互相覆盖。
   * - `exact`：**逐文件哈希**比对，对不上就重写。用于 Holy Light画布自己独占的扩展。
   */
  managed: 'presence' | 'exact';
};

/**
 * 随包的扩展清单。
 *
 * ⚠️ 这里的 `files` 必须和 `integrations/comfyui/<id>/` 里**真实存在的文件**一一对应：
 * 少写一个 → 那个文件永远装不进去；多写一个 → 安装时报「随包扩展不完整」。
 * 单测会拿真实目录来对，不靠人肉同步。
 */
export const COMFYUI_EXTENSIONS: readonly ComfyuiExtensionSpec[] = Object.freeze([
  Object.freeze({
    id: 'fisherai_node_ids',
    files: Object.freeze(['__init__.py', 'manifest.json', 'README.md', 'web/fisherai-node-ids.js']),
    managed: 'presence' as const,
    purpose: '在 ComfyUI 的每个节点标题后面显示它的编号。这个扩展与 AIFISHER 共用同一份。',
    benefit: '配置参数时按编号对照，一眼看出改的是哪个节点，工作流节点多时不会选错。',
    optional: '不装也能导入工作流，只是只能靠节点名称和顺序辨认。',
  }),
  Object.freeze({
    id: 'fisherai_canvas_inputs',
    files: Object.freeze(['__init__.py', 'manifest.json', 'README.md']),
    managed: 'presence' as const,
    purpose: '给 ComfyUI 添加一组「画布输入」节点：文本、数值、整数、种子、开关、图片、蒙版。这个扩展与 AIFISHER 共用同一份。',
    benefit: '在 ComfyUI 里把它们接到想让画布控制的输入上，填好名称和分组，导入时参数就照这个自动摆好。',
    optional: '不装也能导入，只是每个参数都要在参数配置里自己勾选和命名。',
  }),
]);

/**
 * 上一版 Holy Light画布自己装的扩展（`frame_*`）。改用 AIFISHER 那两个之后，这两个就是多余的。
 *
 * ⚠️ **必须提示用户删掉，不能只是「留着不管」**：`frame_node_ids` 的编号徽标和
 * `fisherai_node_ids` 用的是同一套坐标算法（同一张 `onDrawTitle` 钩子、同样的圆角与字体），
 * 两个都装时两块徽标会画在**同一个位置**，界面上就是一团糊字。
 */
export const LEGACY_EXTENSIONS: readonly string[] = Object.freeze(['frame_node_ids', 'frame_canvas_inputs']);

/** ComfyUI 加载一个扩展认的入口文件名。判「在不在」就看它。 */
const ENTRY_FILE = '__init__.py';

/** 扩展目录名的合法形状。**只允许我们自己定的这种**：小写字母开头，下划线分隔。 */
const EXTENSION_ID_RE = /^[a-z][a-z0-9_]{2,40}$/;
/** `manifest.json` 里的版本号。带预发布后缀也认（`1.0.1-beta.2`）。 */
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** 安装器能报出来的状态。`unavailable` 是「还装不了」，其余都是「能装」。 */
export type ComfyuiExtensionStatus =
  /** 没配 ComfyUI 目录、或那边的 custom_nodes 不安全 —— 装不了，但这不是错误。 */
  | 'unavailable'
  /** 目标目录里一个文件都没有。 */
  | 'missing'
  /** 逐文件比对完全一致。 */
  | 'up-to-date'
  /** 文件都在但内容对不上（被改过 / 上次装了一半）。 */
  | 'needs-repair'
  /** 内容对不上，而且版本号也不同 —— 是随包那份更新。 */
  | 'update-available';

/** 装完之后新出现的两种状态（`inspect` 不会返回它们）。 */
export type ComfyuiExtensionInstallStatus = 'installed' | 'updated' | 'up-to-date';

/** 给渲染进程的一份扩展视图。字段名与 `src/lib/desktop-fs.ts` 里那份保持一致。 */
export type ComfyuiExtensionView = {
  id: string;
  name: string;
  purpose: string;
  benefit: string;
  optional: string;
  /** 随包那份的版本；`manifest.json` 读不出来就是 null。 */
  bundledVersion: string | null;
  /** 目标目录里那份的版本；没装或读不出来是 null。 */
  installedVersion: string | null;
  status: ComfyuiExtensionStatus;
  /** 能不能点「安装」。`unavailable` 时为 false。 */
  installable: boolean;
  /** 装不了 / 出问题时的原因，直接显示给用户。 */
  message?: string;
};

/**
 * 装完之后的那份。**必须 `Omit` 掉 `status` 再重新声明** ——
 * 写成 `ComfyuiExtensionView & { status: ComfyuiExtensionInstallStatus }` 的话，
 * 同名属性会被求成交集（`'up-to-date'` ∩ 三个 = 只剩 `'up-to-date'`），
 * 于是 `'installed'` 怎么都赋不进去，而报错位置指向 return 那一行、看不出是类型定义的问题。
 */
export type ComfyuiExtensionInstallResult = Omit<ComfyuiExtensionView, 'status'> & {
  status: ComfyuiExtensionInstallStatus;
  /** 这次真的动了文件没有。没动 = 本来就是好的。 */
  changed: boolean;
  /** 装完要不要重启 ComfyUI 才生效。 */
  restartRequired: boolean;
  /** 装到哪个目录去了（兜底文案要显示它）。 */
  targetDir: string;
};

/** 安装失败的原因。**每条都带一句人话**，让界面能直接显示，不用再翻译一遍。 */
export class ComfyuiExtensionError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ComfyuiExtensionError';
    this.code = code;
  }
}

export function findExtensionSpec(id: unknown): ComfyuiExtensionSpec {
  const spec = COMFYUI_EXTENSIONS.find(item => item.id === String(id ?? ''));
  if (!spec) throw new ComfyuiExtensionError('COMFYUI_EXTENSION_UNKNOWN', '未知的 ComfyUI 扩展。');
  return spec;
}

/**
 * 随包扩展在哪。**两种布局都试**（与 `lib/skills.ts` 的 `builtinSource()` 同一套路）：
 * 走 electron-builder 的 `files` 时打进 asar，落在 `<appDir>/integrations/...`；
 * 走 `extraResources` 时在 `<appDir>/../integrations/...`。哪个存在用哪个。
 *
 * 返回的是**候选路径**（纯函数，不碰磁盘）—— 单测要能直接断言这两个字符串。
 */
export function extensionSourceCandidates(appDir: string, id: string): string[] {
  return [
    path.join(appDir, 'integrations', 'comfyui', id),
    path.join(appDir, '..', 'integrations', 'comfyui', id),
  ];
}

/** `child` 是不是确实夹在 `parent` 里面。两侧都先 resolve，`..` 就没法绕出去。 */
export function contained(parent: string, child: string): boolean {
  const from = path.resolve(parent);
  const to = path.resolve(child);
  const rel = path.relative(from, to);
  return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 目标路径：`<ComfyUI 根>/custom_nodes/<id>`。
 *
 * ⚠️ `id` 先过正则，再过 `contained()`：正则挡住 `/`、`\`、`..`；
 * `contained()` 挡住「正则通过但拼出来仍跑到外面」的情况（比如 Windows 的短名/UNC）。
 * 两道都要，缺一道就等于只有一道。
 */
export function resolveExtensionTarget(comfyuiDir: string, id: string): { customNodesDir: string; targetDir: string } {
  if (!EXTENSION_ID_RE.test(id)) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_ID_INVALID', `扩展目录名不合法：${id}`);
  }
  const root = String(comfyuiDir || '').trim();
  if (!root) {
    throw new ComfyuiExtensionError('COMFYUI_ROOT_NOT_CONFIGURED', '还没配 ComfyUI 安装目录。先在「ComfyUI 安装目录」里选一下它装在哪。');
  }
  const customNodesDir = path.join(root, 'custom_nodes');
  const targetDir = path.join(customNodesDir, id);
  if (!contained(root, customNodesDir) || !contained(customNodesDir, targetDir)) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_TARGET_INVALID', 'ComfyUI 扩展安装目录无效。');
  }
  return { customNodesDir, targetDir };
}

/**
 * 一份扩展包的指纹：**逐文件「名字 + 内容」**摊进同一个 sha256。
 *
 * 为什么不用「所有文件内容的哈希」：只按内容哈希的话，把 `a.py` 改名成 `b.py`
 * 指纹不变 —— 而 ComfyUI 只认 `__init__.py` 这个文件名，改完就是加载不起来。
 * 名字必须进哈希。`\0` 当分隔符，防止「名字结尾恰好吃掉下一段内容」这种拼接歧义。
 */
export function packageHash(files: Map<string, Buffer>): string {
  const hash = createHash('sha256');
  for (const name of [...files.keys()].sort()) {
    hash.update(name);
    hash.update('\0');
    hash.update(files.get(name)!);
    hash.update('\0');
  }
  return hash.digest('hex');
}

/** 状态判定。**纯函数**，不碰磁盘 —— 这是安装器里最该被测到的一段。 */
export function extensionStatus(input: {
  installedHash: string | null;
  installedVersion: string | null;
  bundledHash: string;
  bundledVersion: string;
}): ComfyuiExtensionStatus {
  if (input.installedHash === null) return 'missing';
  if (input.installedHash === input.bundledHash) return 'up-to-date';
  return input.installedVersion === input.bundledVersion ? 'needs-repair' : 'update-available';
}

/**
 * 共用扩展（`managed: 'presence'`）的判定：入口文件在就算装好了。
 *
 * 刻意只有两档 —— 没有「需要修复」，也没有「有更新」。那两档的含义是「我该去改它」，
 * 而共用目录不由我们管：AIFISHER 升到 1.1.0 之后我们非但不该覆盖，连提示都不该给
 * （提示了用户会以为 Holy Light画布需要它做点什么，其实什么都不用做）。
 */
export function presenceStatus(input: { present: boolean }): ComfyuiExtensionStatus {
  return input.present ? 'up-to-date' : 'missing';
}

/** 读一个 `manifest.json`。读不出来 / 对不上 id 就是 null —— 不当成错误，很多扩展压根没有这个文件。 */
export function readManifestAt(file: string, expectedId: string | null): { id: string; name: string; version: string } | null {
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return null;
  }
  return parseManifest(bytes, expectedId);
}

/** 读 `manifest.json` 并校验。返回 null = 这个文件读不出来或不是我们要的那份。 */
export function parseManifest(bytes: Buffer | null, expectedId: string | null): { id: string; name: string; version: string } | null {
  if (!bytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : '';
  const version = typeof record.version === 'string' ? record.version : '';
  /* `name` 缺失不致命（界面回落到 id），但 id / version 不对就不能拿来当扩展用。 */
  if (!EXTENSION_ID_RE.test(id) || !VERSION_RE.test(version)) return null;
  if (expectedId !== null && id !== expectedId) return null;
  return { id, name: typeof record.name === 'string' ? record.name : id, version };
}

/** `lstat` 但把 ENOENT 当「没有」—— 其它错误照抛（权限之类不该被吞成「没装」）。 */
function optionalLstat(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw error;
  }
}

/** 读随包那份扩展。缺文件 / manifest 不对就抛 —— 那是**打包打错了**，不该当成用户的问题。 */
export function readExtensionPackage(sourceDir: string, spec: ComfyuiExtensionSpec): { manifest: { name: string; version: string }; files: Map<string, Buffer>; hash: string } {
  const files = new Map<string, Buffer>();
  for (const relative of spec.files) {
    const file = path.join(sourceDir, ...relative.split('/'));
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(file);
    } catch {
      throw new ComfyuiExtensionError('COMFYUI_EXTENSION_BUNDLE_INVALID', `随包的 ComfyUI 扩展「${spec.id}」不完整，请重新安装 Holy Light画布。`);
    }
    files.set(relative, bytes);
  }
  const manifest = parseManifest(files.get('manifest.json') ?? null, spec.id);
  if (!manifest) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_BUNDLE_INVALID', `随包的 ComfyUI 扩展「${spec.id}」的版本信息无效，请重新安装 Holy Light画布。`);
  }
  return { manifest, files, hash: packageHash(files) };
}

/** 读目标目录里那份。**任何一个文件缺失 / 不是普通文件就直接回 null**（= 当成没装）。 */
export function readInstalledFiles(targetDir: string, spec: ComfyuiExtensionSpec): Map<string, Buffer> | null {
  const files = new Map<string, Buffer>();
  for (const relative of spec.files) {
    const file = path.join(targetDir, ...relative.split('/'));
    let stat: fs.Stats | null;
    try {
      stat = optionalLstat(file);
    } catch {
      return null;
    }
    /*
     * 符号链接一律不算数：ComfyUI 会照着 `custom_nodes` 里的目录去 import，
     * 一个指向别处的链接在「装了什么」这件事上是不可信的，写进去也可能是往别处写。
     */
    if (!stat?.isFile()) return null;
    try {
      files.set(relative, fs.readFileSync(file));
    } catch {
      return null;
    }
  }
  return files;
}

/**
 * 目标目录能不能写。
 *
 * `lstat` 而不是 `stat`：我们关心的是**这个路径本身**是什么。用户可能把
 * `custom_nodes/fisherai_node_ids` 做成了一个指向别处的 junction —— 顺着它写进去，
 * 文件就落到 Holy Light画布完全不该碰的地方了。遇到这种直接拒绝，让人自己看一眼。
 */
function assertWritableTarget(targetDir: string): void {
  const stat = optionalLstat(targetDir);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_TARGET_UNSAFE', '扩展安装目录不是普通文件夹，请手动检查后重试。');
  }
}

/**
 * 原子写入：先把每个文件写进同目录下的 `.tmp`，**全部写完**再一起 rename。
 *
 * 分两段是为了「要么全到、要么全不到」。边写边覆盖的话，写到第七个文件失败时
 * 前面六个已经是新的了 —— 那种半新半旧的扩展在 ComfyUI 里加载得起来、但行为诡异，
 * 比直接报错难查得多。
 */
export function writePackageAtomically(targetDir: string, files: Map<string, Buffer>): void {
  fs.mkdirSync(targetDir, { recursive: true });
  const staged: { tmp: string; dest: string }[] = [];
  try {
    for (const [relative, bytes] of files) {
      const dest = path.join(targetDir, ...relative.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      const tmp = `${dest}.${process.pid}.${randomUUID()}.tmp`;
      fs.writeFileSync(tmp, bytes, { flag: 'wx' });
      staged.push({ tmp, dest });
    }
    for (const item of staged) fs.renameSync(item.tmp, item.dest);
  } catch (error) {
    throw new ComfyuiExtensionError(
      'COMFYUI_EXTENSION_WRITE_FAILED',
      `写入 ComfyUI 扩展目录失败：${error instanceof Error ? error.message : '未知原因'}。确认 ComfyUI 目录可写后重试。`,
    );
  } finally {
    /* rename 成功的那些 tmp 已经不在了，这里只会清掉失败时残留的。 */
    for (const item of staged) {
      try {
        fs.rmSync(item.tmp, { force: true });
      } catch {
        /* 清不掉也不该覆盖掉真正的错误 */
      }
    }
  }
}

/** 随包那份扩展在这台机器上的目录。找不到返回 null（打包漏了 `integrations/`）。 */
export function locateExtensionSource(appDir: string, spec: ComfyuiExtensionSpec): string | null {
  for (const candidate of extensionSourceCandidates(appDir, spec.id)) {
    try {
      if (fs.statSync(path.join(candidate, 'manifest.json')).isFile()) return candidate;
    } catch {
      /* 试下一个布局 */
    }
  }
  return null;
}

/** 检测一份扩展。**不写任何东西** —— 界面挂载时、每次存完目录都会调它。 */
export function inspectExtension(appDir: string, comfyuiDir: string, spec: ComfyuiExtensionSpec): ComfyuiExtensionView {
  const base = { id: spec.id, purpose: spec.purpose, benefit: spec.benefit, optional: spec.optional };
  let sourceDir: string | null;
  try {
    sourceDir = locateExtensionSource(appDir, spec);
  } catch {
    sourceDir = null;
  }
  if (!sourceDir) {
    return { ...base, name: spec.id, bundledVersion: null, installedVersion: null, status: 'unavailable', installable: false, message: '随包的扩展文件不完整，请重新安装 Holy Light画布。' };
  }

  let packaged: ReturnType<typeof readExtensionPackage>;
  try {
    packaged = readExtensionPackage(sourceDir, spec);
  } catch (error) {
    return {
      ...base,
      name: spec.id,
      bundledVersion: null,
      installedVersion: null,
      status: 'unavailable',
      installable: false,
      message: error instanceof Error ? error.message : '随包的扩展文件不完整。',
    };
  }

  const withVersion = { ...base, name: packaged.manifest.name, bundledVersion: packaged.manifest.version };

  let target: { customNodesDir: string; targetDir: string };
  try {
    target = resolveExtensionTarget(comfyuiDir, spec.id);
    assertWritableTarget(target.targetDir);
  } catch (error) {
    return {
      ...withVersion,
      installedVersion: null,
      status: 'unavailable',
      installable: false,
      message: error instanceof Error ? error.message : '还不能安装这个扩展。',
    };
  }

  /*
   * 共用扩展：只看在不在。AIFISHER 也在管这份目录，我们按哈希判就会在它升级后
   * 判成「需要修复」并覆盖回去 —— 所以它升到几版我们都当它是好的，也**不写**。
   */
  if (spec.managed === 'presence') {
    const entry = optionalLstat(path.join(target.targetDir, ENTRY_FILE));
    const present = Boolean(entry?.isFile()) && !entry?.isSymbolicLink();
    return {
      ...withVersion,
      installedVersion: readManifestAt(path.join(target.targetDir, 'manifest.json'), spec.id)?.version ?? null,
      status: presenceStatus({ present }),
      installable: true,
    };
  }

  const installed = readInstalledFiles(target.targetDir, spec);
  const installedManifest = installed ? parseManifest(installed.get('manifest.json') ?? null, spec.id) : null;
  const status = extensionStatus({
    installedHash: installed ? packageHash(installed) : null,
    installedVersion: installedManifest?.version ?? null,
    bundledHash: packaged.hash,
    bundledVersion: packaged.manifest.version,
  });
  return {
    ...withVersion,
    installedVersion: installedManifest?.version ?? null,
    status,
    installable: true,
  };
}

/** 检测全部。某一份炸了不该让整块空白 —— 那一份显示成「装不了 + 原因」，其它照常。 */
export function inspectExtensions(appDir: string, comfyuiDir: string): ComfyuiExtensionView[] {
  return COMFYUI_EXTENSIONS.map(spec => inspectExtension(appDir, comfyuiDir, spec));
}

/** 给渲染进程的一份「上一版遗留」视图。 */
export type ComfyuiLegacyExtensionView = {
  id: string;
  /** 它现在在哪个目录（`custom_nodes/<id>`）。目录不存在时也给，界面要显示路径。 */
  targetDir: string;
  /** 目录在不在。 */
  exists: boolean;
};

/**
 * 上一层 Holy Light画布自己装的 `frame_*` 还在不在。
 *
 * 配错目录 / 目录还没存时返回 `exists: false` 的空列表 —— 那是「还没装过」，
 * 不是错误，界面不该为它弹警告。
 */
export function inspectLegacyExtensions(comfyuiDir: string): ComfyuiLegacyExtensionView[] {
  const out: ComfyuiLegacyExtensionView[] = [];
  for (const id of LEGACY_EXTENSIONS) {
    try {
      const { targetDir } = resolveExtensionTarget(comfyuiDir, id);
      const stat = optionalLstat(targetDir);
      out.push({ id, targetDir, exists: Boolean(stat) });
    } catch {
      /* 目录没配好 / id 不合法：这条就当不存在，不让它变成一次报错 */
    }
  }
  return out;
}

/**
 * 删掉一个目录树。**每一层都拒绝符号链接 / junction**。
 *
 * ⚠️ 绝不能写 `fs.rmSync(dir, { recursive: true })`：Windows 上它会**顺着 junction
 * 走进去把链接那头真正的目录删光**。这里改成自己逐层走：任何一层是链接就直接抛错退出，
 * 子目录递归处理、文件逐个删，最后 rmdir（非空时会失败，等于又一道保险）。
 */
export function removeDirectoryTreeSafely(dir: string): void {
  const stat = optionalLstat(dir);
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_TARGET_UNSAFE', '要删除的目录不是普通文件夹，已停止。');
  }
  for (const entry of fs.readdirSync(dir)) {
    const child = path.join(dir, entry);
    const childStat = optionalLstat(child);
    if (!childStat) continue;
    /* 链接（含 junction）一律不跟 —— 跟进去删的是别人的目录。 */
    if (childStat.isSymbolicLink()) {
      throw new ComfyuiExtensionError('COMFYUI_EXTENSION_TARGET_UNSAFE', `目录里有链接「${entry}」，已停止删除。`);
    }
    if (childStat.isDirectory()) removeDirectoryTreeSafely(child);
    else fs.rmSync(child, { force: true });
  }
  fs.rmdirSync(dir);
}

/**
 * 移除上一版 Holy Light画布装的一个 `frame_*`。
 *
 * 三道门，缺一不可：
 * 1. **只认 `LEGACY_EXTENSIONS` 里写死的两个 id** —— 别的名字一概不动。
 * 2. **manifest 里的 id 必须正好是这个 id** —— 名字撞车但不是我们装的，不敢删。
 * 3. 逐层拒绝链接（见 `removeDirectoryTreeSafely`）。
 *
 * 不满足就抛错，**绝不静默跳过**：用户点了「移除」却什么都没发生，比报错难查得多。
 */
export function removeLegacyExtension(comfyuiDir: string, id: unknown): { id: string; targetDir: string; removed: boolean } {
  const wanted = String(id ?? '');
  if (!LEGACY_EXTENSIONS.includes(wanted)) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_UNKNOWN', '这不是 Holy Light画布上一版装的扩展，不能移除。');
  }
  const { targetDir } = resolveExtensionTarget(comfyuiDir, wanted);
  const stat = optionalLstat(targetDir);
  if (!stat) return { id: wanted, targetDir, removed: false };
  /*
   * 链接（含 junction）**在读 manifest 之前**就挡掉：读文件会顺着它走到链接那头去，
   * 于是「这不是我们装的」和「这是个链接」两种完全不同的情况会报成同一句 ——
   * 用户照着前者去改 manifest，而真正的问题在后者。
   */
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_TARGET_UNSAFE', `「${wanted}」不是普通文件夹（可能是指向别处的链接），为安全起见已停止。`);
  }
  const manifest = readManifestAt(path.join(targetDir, 'manifest.json'), wanted);
  if (!manifest) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_NOT_OURS', `「${wanted}」里没有 Holy Light画布的版本信息，为避免误删已停止。请手动确认后删除。`);
  }
  removeDirectoryTreeSafely(targetDir);
  if (optionalLstat(targetDir)) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_WRITE_FAILED', `「${wanted}」没能删干净，请手动删除：${targetDir}`);
  }
  return { id: wanted, targetDir, removed: true };
}

/**
 * 装一份。**已经是好的就直接返回，不动文件**（`changed: false`）。
 *
 * `running` 只影响回执里那句「重启后生效」—— 我们**不会**为装扩展去重启 ComfyUI，
 * 那会打断正在跑队列的任务。写文件对已经 import 完的 Python 进程也没有影响。
 */
export function installExtension(appDir: string, comfyuiDir: string, id: unknown, running: boolean): ComfyuiExtensionInstallResult {
  const spec = findExtensionSpec(id);
  const view = inspectExtension(appDir, comfyuiDir, spec);
  if (!view.installable) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_UNAVAILABLE', view.message || '现在还不能安装这个扩展。');
  }
  const sourceDir = locateExtensionSource(appDir, spec);
  const { targetDir } = resolveExtensionTarget(comfyuiDir, spec.id);
  /* 目标目录的符号链接要在**写之前**再挡一次：`inspect` 之后到这一刻之间它可能变过。 */
  assertWritableTarget(targetDir);

  if (view.status === 'up-to-date') {
    return { ...view, status: 'up-to-date', changed: false, restartRequired: false, targetDir };
  }

  const packaged = readExtensionPackage(sourceDir!, spec);
  /* 目录在不在，用来区分「新装」和「补上」—— 共用模式下里面可能缺文件但目录还在。 */
  const dirExisted = Boolean(optionalLstat(targetDir));
  writePackageAtomically(targetDir, packaged.files);

  /* 写完再读一遍比对 —— 写盘的谎话比读取的多，只有回读过的才算数。 */
  const after = readInstalledFiles(targetDir, spec);
  if (!after || packageHash(after) !== packaged.hash) {
    throw new ComfyuiExtensionError('COMFYUI_EXTENSION_VERIFY_FAILED', '扩展写入后校验失败，请检查 ComfyUI 目录权限。');
  }

  return {
    ...view,
    installedVersion: packaged.manifest.version,
    status: dirExisted ? 'updated' : 'installed',
    changed: true,
    restartRequired: running,
    targetDir,
  };
}
