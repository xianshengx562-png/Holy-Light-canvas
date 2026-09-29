'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { LocalConnectionView } from '@/lib/providers/local/connection';
import { isDesktop } from '@/lib/edition';
import {
  canBrowseFolders, canDetectComfyui, canLaunchComfyui, canManageComfyuiExtensions,
  comfyuiDetectProcesses, comfyuiExtensions, comfyuiFindInstalls, comfyuiInstallExtension,
  comfyuiLegacyExtensions, comfyuiRemoveLegacyExtension,
  comfyuiStart, comfyuiStatus, comfyuiStop,
  onComfyuiState, pickFolderPath,
  type ComfyuiExtensionView, type ComfyuiInstallHit, type ComfyuiLegacyExtensionView,
  type ComfyuiProcessHit, type ComfyuiStatus,
} from '@/lib/desktop-fs';

/**
 * 「ComfyUI 服务」面板 —— 本机 ComfyUI 的**配置 + 状态 + 一键启动**，一页走完。
 *
 * （2026-09-21）原来还有一页「本机 ComfyUI」（`/settings/local`），和这一页重复了四样东西：
 * 服务地址、安装目录、测试连接、目录扫描。两页并存的代价是「改地址要去 A 页、看连没连上要去 B 页」，
 * 而新做的进程发现 / 模型清单还只在这一页有。现在那一页删了，全部并到这儿 ——
 * 顺序就是一条龙：**填地址 / 找目录 → 看连没连上 → 没起来就一键启动 → 看模型清单**。
 *
 * 信息层级照着用户给的参考图：GPU/显存 → 本地模型 → 连接状态 → 连接设置 → 安装目录 → 启动 → 模型目录。
 * 每一块都是**先给结论、再给一句「该怎么办」**：这一页最常见的用法是「跑不了了，来看看」，
 * 所以「未检测到」后面必须紧跟「把模型文件放到 models/checkpoints 等对应目录」这种可执行的话。
 *
 * 三个刻意的设计取舍：
 *
 * 1. **启动不阻塞界面。** ComfyUI 起一次要 1～3 分钟（实测同一份整合包，
 *    插件缓存冷时 178 秒、热时 40 秒）。所以按钮点下去立刻返回，界面靠订阅
 *    `onComfyuiState` 推进，并在等待期间显示已经等了多久 —— 让人知道它**在动**。
 * 2. **状态与「启动器的状态」分开算。** 「端口上有没有 ComfyUI」是探测出来的（后端那条
 *    `/api/local/connection/test`），「我们起的那个进程怎么样了」是主进程报的。
 *    两者可能不一致（比如你自己手动开着 ComfyUI），界面要能说清是哪一种。
 * 3. **不给「自动启动」开关。** 用户 2026-09-20 明确要的是「一键启动」，
 *    不是「跟着应用自动起」—— 自动起一个吃 8 GB 显存的进程是越界的。
 */
export default function ComfyuiServicePanel({ initial }: { initial: LocalConnectionView }) {
  const [view, setView] = useState(initial);
  const [baseUrl, setBaseUrl] = useState(initial.baseUrl);
  /** 密钥不回填：库里存的是密文，界面上只显示掩码。留空 = 不改动已保存的那把。 */
  const [apiKey, setApiKey] = useState('');
  const [comfyuiDir, setComfyuiDir] = useState(initial.comfyuiDir ?? '');
  const [launcher, setLauncher] = useState<ComfyuiStatus>({
    state: 'idle', message: '还没启动过。', pid: null, startedAt: null, command: null, cwd: null,
  });
  /** 探测结果（「端口上有没有 ComfyUI 在答话」）。与 launcher 是两件事，见文件头第 2 条。 */
  const [probe, setProbe] = useState<{ ok: boolean; message: string; stats?: unknown; reason?: string | null } | null>(null);
  /*
   * 保存 / 开关 / 清除的回话，**单独一份**，不写进 `probe`。
   *
   * `probe` 的 `ok` 决定了右上角那颗「已连接 / 未连接」的标签，往里塞一句「已保存」
   * 会让界面在根本没连上的时候显示成绿的。这类「操作回执」和「服务状态」是两件事，
   * 就该分开存。
   */
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  /**
   * 填的地址不通时，本机别处**探到的** ComfyUI。
   *
   * 为什么要额外扫一遍：「你填的那个地址上没有」这句话本身没有可执行的信息 ——
   * 用户接下来只能靠猜。告诉他「8189 上有一个，点一下就换过去」，事情才真的往前走了一步。
   */
  const [found, setFound] = useState<{ baseUrl: string; message: string }[]>([]);
  /** 扫了但一个都没找到时的一句话（找到了就不占版面）。 */
  const [scanNote, setScanNote] = useState('');
  /**
   * 本机**正在跑着**的 ComfyUI 实例（从进程命令行里认出来的）。
   *
   * 它和上面 `found`（扫端口扫到的）是两条**独立**的线索，都列出来：
   * 扫端口是「这个端口上有人在答话」，扫进程是「这台机器上确实起了 ComfyUI，端口是 X」。
   * 后者更准 —— 命令行里的 `--port` 就是它真正在听的那个，扫端口只能撞运气。
   */
  const [processes, setProcesses] = useState<ComfyuiProcessHit[]>([]);
  /** 连上之后的家底：模型清单 / 队列 / 节点类型数。没连上就是 null。 */
  const [inventory, setInventory] = useState<{
    modelCount: number;
    nodeTypeCount: number;
    queueRunning: number;
    queuePending: number;
    models?: Record<string, { count: number; names: string[] }>;
  } | null>(null);
  /** 自动扫出来的 ComfyUI 安装目录候选（用户点「自动找」之后才有）。 */
  const [installs, setInstalls] = useState<ComfyuiInstallHit[]>([]);
  const [installNote, setInstallNote] = useState('');
  const [busy, setBusy] = useState<'probe' | 'scan' | 'dir' | 'save' | 'toggle' | 'clear' | 'start' | 'stop' | 'detect' | 'installs' | null>(null);
  /** 等待启动期间每秒跳一下，好让「已等待 1 分 20 秒」真的在走。 */
  const [tick, setTick] = useState(0);
  const [canBrowse, setCanBrowse] = useState(false);
  const [canLaunch, setCanLaunch] = useState(false);
  /** 能不能扫本机进程 / 扫盘找 ComfyUI（web 版不行，按钮就不该出现）。 */
  const [canDetect, setCanDetect] = useState(false);
  /*
   * 随包的两个 ComfyUI 扩展装没装。
   *
   * ——为什么这一页要有这一块：Holy Light画布的「工作流配置」里每个字段都写成 `NODE 32.text`，
   * 而 ComfyUI 画布上默认看不到节点实例编号。不装编号扩展时，用户只能靠节点标题和位置
   * 猜「哪个是 32」，猜错的后果**不报错**（生成照跑、图照出，只是提示词没生效）。
   * 所以这两个扩展虽然可选，却是「配参数」这一步对得上号的前提。
   */
  const [extensions, setExtensions] = useState<ComfyuiExtensionView[] | null>(null);
  /** 正在装哪一个（`null` = 没在装）。按钮的文案和禁用都看它。 */
  const [extBusy, setExtBusy] = useState<string | null>(null);
  /** 自动补齐的回执。**单独一份**，不写进 `note`（那是连接设置的回执）。 */
  const [extNote, setExtNote] = useState<{ ok: boolean; message: string } | null>(null);
  /**
   * 上一版 Holy Light画布自己装的 `frame_*` 还在不在。
   *
   * 它们和现在的 `fisherai_node_ids` 是**两个都画编号徽标**的扩展，而且用的是同一套坐标算法 ——
   * 都在的话两块徽标叠在同一个位置，界面上就是一团糊字。所以这一栏不是「清理垃圾」，
   * 是让人能真正看清节点编号。
   */
  const [legacy, setLegacy] = useState<ComfyuiLegacyExtensionView[] | null>(null);
  /** 有没有「扩展」这一块（web 版读不到随包的扩展，整块就不出现）。 */
  const [canExt, setCanExt] = useState(false);

  useEffect(() => {
    setCanBrowse(canBrowseFolders());
    setCanLaunch(canLaunchComfyui());
    setCanDetect(canDetectComfyui());
    setCanExt(canManageComfyuiExtensions());
  }, []);

  /** 挂载时先对齐一次状态：推送只在**变化**时发，页面挂载得晚就一条都收不到。 */
  useEffect(() => {
    void comfyuiStatus().then(setLauncher);
    return onComfyuiState(setLauncher);
  }, []);

  useEffect(() => {
    if (launcher.state !== 'starting') return;
    const timer = setInterval(() => setTick(value => value + 1), 1000);
    return () => clearInterval(timer);
  }, [launcher.state]);

  /**
   * 连上之后读一次**家底**（模型清单 / 队列 / 节点类型）。
   *
   * 只在「已经连上了」之后才读：`/object_info` 插件多时第一次要十几秒，
   * 探活失败的时候去读它只会让人多等一轮，而那时的结论「连不上」根本用不上这些。
   */
  const loadInventory = useCallback(async () => {
    try {
      const response = await fetch('/api/local/inventory', { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data?.ok) { setInventory(null); return; }
      setInventory({
        modelCount: Number(data.modelCount) || 0,
        nodeTypeCount: Number(data.nodeTypeCount) || 0,
        queueRunning: Number(data.queueRunning) || 0,
        queuePending: Number(data.queuePending) || 0,
        models: data.models ?? undefined,
      });
    } catch {
      setInventory(null);
    }
  }, []);

  /** 问主进程「本机有没有 ComfyUI 正在跑」。扫不出来就是空数组，不当错误。 */
  const loadProcesses = useCallback(async () => {
    const hits = await comfyuiDetectProcesses();
    setProcesses(hits);
    return hits;
  }, []);

  const refresh = useCallback(async () => {
    setBusy('probe');
    let ok = false;
    try {
      const response = await fetch('/api/local/connection/test', { method: 'POST' });
      const data = await response.json();
      ok = Boolean(data?.ok);
      setProbe(response.ok
        ? { ok, message: data.message, stats: data.stats, reason: data.reason ?? null }
        : { ok: false, message: data.error || '探测失败。', reason: null });
    } catch {
      setProbe({ ok: false, message: '请求失败，请检查网络后重试。', reason: null });
    } finally {
      setBusy(null);
    }
    if (ok) {
      setFound([]);
      setScanNote('');
      setProcesses([]);
      await loadInventory();
      return;
    }
    setInventory(null);
    /*
     * 不通的时候顺手扫一遍本机端口 —— 这一步是「连不上」这个问题真正的解药：
     * 最常见的原因既不是 Holy Light画布配错、也不是 ComfyUI 坏了，而是它跑在另一个端口上。
     */
    setBusy('scan');
    try {
      const response = await fetch('/api/local/scan', { method: 'POST' });
      const data = await response.json();
      const list: { baseUrl: string; message: string }[] = Array.isArray(data?.candidates) ? data.candidates : [];
      setFound(list);
      setScanNote(list.length ? '' : '本机常见端口上都没有 ComfyUI —— 确认它是自己手动开的、地址填对了；或者用下面的「自动找 / 启动 ComfyUI」。');
    } catch {
      setScanNote('扫描本机端口失败。');
    } finally {
      setBusy(null);
    }
    /*
     * 端口扫不到，再去问一次进程：它可能是用 `--port 8190` 起的，
     * 那种端口扫固定列表永远撞不上，但命令行里写得清清楚楚。
     */
    setBusy('detect');
    try {
      await loadProcesses();
    } finally {
      setBusy(null);
    }
  }, [loadInventory, loadProcesses]);

  /* 挂载后自动探一次 —— 这一页打开时最想知道的就是「现在能不能用」，不该还要人再点一下。 */
  useEffect(() => { void refresh(); }, [refresh]);

  /** 采纳扫到的地址：存下来，然后立刻按新地址重探一次。 */
  async function useThisBaseUrl(next: string) {
    setBusy('dir');
    try {
      const response = await fetch('/api/local/connection', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ baseUrl: next }),
      });
      const data = await response.json();
      if (!response.ok) { setProbe({ ok: false, message: data.error || '保存失败。' }); return; }
      setView(data);
      setBaseUrl(data.baseUrl ?? next);
      await refresh();
    } catch {
      setProbe({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  /*
   * ⚠️ **启动完成后必须再探一次**，否则 GPU 那一块会一直显示「读不到显卡」。
   *
   * 坑在于 `comfyuiStart()` 是**不阻塞**的（ComfyUI 起一次要 1～3 分钟），它返回时
   * 状态还停在 `starting`。所以「返回时就绪了才重探」这个写法永远不成立 ——
   * 第一版就是这么写的，结果 2026-09-20 实测：面板明明写着「已连接」，
   * GPU 块却还是「未连接，读不到显卡」，因为 `probe` 里那次是挂载时 ComfyUI 还没起来时打的。
   *
   * 正确的做法是跟着**状态变化**走：状态一进 ready 就补一次探测。
   */
  useEffect(() => {
    if (launcher.state !== 'ready') return;
    void refresh();
  }, [launcher.state, refresh]);

  const dirDirty = comfyuiDir.trim() !== (view.comfyuiDir ?? '');

  /** 只查扩展状态；**不写任何东西**。顺带查一遍上一版遗留的那两个。 */
  const refreshExtensions = useCallback(async (dir: string) => {
    const [list, legacyList] = await Promise.all([comfyuiExtensions(dir), comfyuiLegacyExtensions(dir)]);
    setExtensions(list);
    setLegacy(legacyList);
    return list;
  }, []);

  /**
   * 自动补齐：查一遍，**缺哪个装哪个**。
   *
   * 为什么是自动的而不是让用户一个个点：见上面那段 state 说明 —— 少了这两个扩展，
   * 「配参数」这一步会静默配错，而用户很难自己定位到这儿。装它也不打断什么：
   * 只往 `custom_nodes/<id>` 里写文件，不重启 ComfyUI、不碰队列里的任务。
   *
   * 已经是好的（`up-to-date`）**绝不重写** —— 用户可能自己改过里面的脚本，
   * 一次进页面就把他的改动冲掉是不可接受的。
   */
  const ensureExtensions = useCallback(async (dir: string) => {
    const target = dir.trim();
    if (!target) {
      setExtensions(null);
      setLegacy(null);
      setExtNote(null);
      return;
    }
    setExtNote(null);
    const list = await refreshExtensions(target);
    const pending = list.filter(item => item.installable && item.status !== 'up-to-date');
    if (!pending.length) {
      if (list.length) setExtNote({ ok: true, message: '两个扩展都已就位，不用动。' });
      return;
    }
    /*
     * 只补**缺的**那一个。共用模式下「已安装」的判定是「目录里有入口文件」，
     * AIFISHER 装过/升过级都算已安装 —— 那种绝不能重写，那是人家的目录。
     */
    const notes: string[] = [];
    let allOk = true;
    for (const item of pending) {
      setExtBusy(item.id);
      const result = await comfyuiInstallExtension(item.id, target);
      if (result.extensions.length) setExtensions(result.extensions);
      if (!result.ok) allOk = false;
      if (result.message) notes.push(result.message);
    }
    setExtBusy(null);
    /* 收尾再查一次：上面每一步已经回读过，但那份是按「旧列表里的顺序」拼的，
       最后以磁盘为准对齐一遍，免得显示的状态和实际差半步。 */
    await refreshExtensions(target);
    if (notes.length) setExtNote({ ok: allOk, message: notes.join(' ') });
  }, [refreshExtensions]);

  /*
   * 目录一就绪就自动补齐扩展。
   *
   * 依赖的是**已保存的**目录（`view.comfyuiDir`），不是输入框里那个 ——
   * 用户正打字打一半的路径不该被拿去写文件。
   */
  useEffect(() => {
    if (!canExt) return;
    void ensureExtensions(view.comfyuiDir ?? '');
  }, [canExt, view.comfyuiDir, ensureExtensions]);

  /** 手动装 / 更新 / 修复某一个（自动那条路失败、或用户自己想重来一次时用）。 */
  async function installOne(id: string) {
    const target = (view.comfyuiDir ?? '').trim();
    if (!target) {
      setExtNote({ ok: false, message: '先在上面把 ComfyUI 安装目录填上，再装扩展。' });
      return;
    }
    setExtBusy(id);
    setExtNote(null);
    try {
      const result = await comfyuiInstallExtension(id, target);
      if (result.extensions.length) setExtensions(result.extensions);
      setExtNote({ ok: result.ok, message: result.message });
    } finally {
      setExtBusy(null);
    }
  }

  /**
   * 移除一个上一版装的 `frame_*`。
   *
   * **不做自动删除**：删目录是不可逆的，而且主进程那边只认自己写死的两个 id、
   * 还要求 manifest 对得上 —— 交给用户点一下，比自作主张删掉他的东西安全。
   */
  async function removeLegacy(id: string) {
    const target = (view.comfyuiDir ?? '').trim();
    if (!target) return;
    setExtBusy(id);
    setExtNote(null);
    try {
      const result = await comfyuiRemoveLegacyExtension(id, target);
      if (result.legacy.length) setLegacy(result.legacy);
      setExtNote({ ok: result.ok, message: result.message });
    } finally {
      setExtBusy(null);
    }
  }

  /** 写回一条连接配置。`note` 由调用方决定 —— 各操作的回话不一样，不该写死在这一层。 */
  async function putConnection(patch: Record<string, unknown>, okMessage: string, action: 'save' | 'dir' | 'toggle') {
    setBusy(action);
    setNote(null);
    try {
      const response = await fetch('/api/local/connection', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await response.json();
      if (!response.ok) { setNote({ ok: false, message: data.error || '保存失败。' }); return null; }
      setView(data);
      setBaseUrl(data.baseUrl ?? '');
      setComfyuiDir(data.comfyuiDir ?? '');
      setNote({ ok: true, message: okMessage });
      return data as LocalConnectionView;
    } catch {
      setNote({ ok: false, message: '请求失败，请检查网络后重试。' });
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function saveConnection() {
    const patch: Record<string, unknown> = { baseUrl: baseUrl.trim(), comfyuiDir: comfyuiDir.trim() };
    /** 密钥留空 = 不改动（本机大多不鉴权，没必要逼人填一串假 key）。 */
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    const saved = await putConnection(patch, '已保存。', 'save');
    if (!saved) return;
    setApiKey('');
    await refresh();
  }

  async function saveDir(next: string) {
    const saved = await putConnection(
      { comfyuiDir: next.trim() },
      `安装目录已保存。${''}`,
      'dir',
    );
    if (saved) setNote({ ok: true, message: `安装目录已保存。${saved.dir?.message ?? ''}`.trim() });
  }

  async function toggleEnabled(next: boolean) {
    await putConnection(
      { enabled: next },
      next ? '本地模式已开启 —— 生成改投你自己的 ComfyUI，不经过 RunningHub、也不扣余额。' : '本地模式已关闭，生成走回云端。',
      'toggle',
    );
  }

  /** 全部清除：地址、目录、密钥一起丢掉，回到「什么都没配」的默认值。 */
  async function clearAll() {
    setBusy('clear');
    setNote(null);
    try {
      const response = await fetch('/api/local/connection', { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok) { setNote({ ok: false, message: data.error || '清除失败。' }); return; }
      setView(data);
      setBaseUrl(data.baseUrl ?? '');
      setComfyuiDir(data.comfyuiDir ?? '');
      setApiKey('');
      setInventory(null);
      setProbe(null);
      setFound([]);
      setProcesses([]);
      setInstalls([]);
      setNote({ ok: true, message: '已清除本机 ComfyUI 的全部配置，回到默认值。' });
      await refresh();
    } catch {
      setNote({ ok: false, message: '请求失败，请检查网络后重试。' });
    } finally {
      setBusy(null);
    }
  }

  async function browseDir() {
    const picked = await pickFolderPath({ title: '选择 ComfyUI 的安装目录', defaultPath: comfyuiDir || undefined });
    if (!picked) return;
    setComfyuiDir(picked);
    /* 选完立刻存：这一项的意义就是「启动哪个 ComfyUI」，多一步「保存」没有价值。 */
    await saveDir(picked);
  }

  /**
   * 采纳一个**正在跑着**的实例：换到它的端口，顺手把它的安装目录也记下来。
   *
   * 为什么两件事一起做：命令行里认出来的那个端口，只有配上同一个目录才「完整」——
   * 之后应用要帮用户重启 ComfyUI 时，才知道该起哪个。只换端口的话，
   * 下次手动关掉 ComfyUI 就又回到「应用不知道它装在哪」。
   */
  async function useThisProcess(hit: ComfyuiProcessHit) {
    if (!hit.port) {
      setNote({ ok: false, message: '这个进程没在命令行里写 --port，认不出它在哪个端口上 —— 在上面的「服务地址」里手动填。' });
      return;
    }
    await useThisBaseUrl(`http://127.0.0.1:${hit.port}`);
    if (hit.dir && hit.dir !== view.comfyuiDir) {
      setComfyuiDir(hit.dir);
      await saveDir(hit.dir);
    }
  }

  /** 扫本机找 ComfyUI 装在哪。用户不记得装到哪个盘时用 —— 比手打路径省事得多。 */
  async function findInstalls() {
    setBusy('installs');
    setInstallNote('');
    try {
      const list = await comfyuiFindInstalls();
      setInstalls(list);
      setInstallNote(list.length ? '' : '这台机器上没扫到 ComfyUI。装在很深的目录里的话，点「浏览…」自己选一下。');
    } finally {
      setBusy(null);
    }
  }

  /** 采纳一个扫出来的目录：存下来，候选列表收起。 */
  async function useThisInstall(dir: string) {
    setComfyuiDir(dir);
    await saveDir(dir);
    setInstalls([]);
  }

  async function start() {
    setBusy('start');
    try {
      const result = await comfyuiStart();
      if (result.status) setLauncher(result.status);
      setProbe({ ok: result.ok, message: result.message });
      /* 起来之后的重探不在这里做 —— 这里返回时状态还是 `starting`（见上面那个 useEffect）。 */
    } finally {
      setBusy(null);
    }
  }

  async function stop() {
    setBusy('stop');
    try {
      const result = await comfyuiStop();
      if (result.status) setLauncher(result.status);
      setProbe({ ok: true, message: result.message });
    } finally {
      setBusy(null);
    }
  }

  const device = useMemo(() => {
    const stats = probe?.stats as { devices?: { name?: string; vramTotal?: number; vramFree?: number }[] } | undefined;
    return stats?.devices?.[0] ?? null;
  }, [probe]);

  const system = useMemo(() => {
    const stats = probe?.stats as { system?: { comfyuiVersion?: string; pythonVersion?: string; pytorchVersion?: string; ramFree?: number; ramTotal?: number } } | undefined;
    return stats?.system ?? null;
  }, [probe]);

  /*
   * 已等待多久。依赖里带 `tick` 是为了让它每秒重算一次 —— `tick` 本身不参与计算，
   * 只当触发器，所以下面那行 eslint 例外是**故意**留的（不然会被判成多余的依赖）。
   */
  const waited = useMemo(() => {
    if (!launcher.startedAt) return '';
    const seconds = Math.max(0, Math.round((Date.now() - new Date(launcher.startedAt).getTime()) / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [launcher.startedAt, tick]);

  const dirOk = Boolean(view.comfyuiDir) && view.dir?.looksLikeComfyui !== false;
  const running = launcher.state === 'ready' || probe?.ok === true;

  /*
   * 「本机有多少模型」优先用 ComfyUI 自己报的（`/object_info`），没有才回落到扫目录。
   *
   * 为什么以它为准：扫目录数的是 `models/` 下的文件，而 ComfyUI 认得的模型还包括
   * 靠 `extra_model_paths.yaml` 从别的盘挂进来的那些 —— 用户把模型放在 D 盘时，
   * 「扫目录说 0 个、ComfyUI 说 200 个」是最容易让人以为软件坏了的一幕。
   */
  const modelTotal = inventory?.modelCount ?? view.dir?.modelCount ?? 0;
  const modelRows = inventory?.models
    ? MODEL_KINDS
      .map(item => ({ ...item, bucket: inventory.models?.[item.key] }))
      .filter(item => item.bucket && item.bucket.count > 0)
    : [];

  const sourceText = SOURCE_TEXT[view.baseUrlSource];

  return <div className="comfy-service">
    {/* ---------- GPU / 显存 ---------- */}
    <section className="cfy-card" data-cfy-block="gpu">
      <div className="cfy-head"><h3>GPU</h3></div>
      {device?.name
        ? <>
          <p className="cfy-value">{device.name}</p>
          <p className="cfy-note">{formatBytes(device.vramFree)} 可用 / {formatBytes(device.vramTotal)}
            {system?.ramTotal ? <> · 内存 {formatBytes(system.ramFree)} / {formatBytes(system.ramTotal)}</> : null}</p>
          <p className="cfy-hint">显存低于 8 GB 的大工作流可能跑不动，遇到会直接报显存不足。</p>
        </>
        : <>
          <p className="cfy-value muted">未连接，读不到显卡</p>
          <p className="cfy-hint">ComfyUI 起来之后这里会显示显卡型号和显存占用。</p>
        </>}
    </section>

    {/* ---------- 本地模型 ---------- */}
    <section className="cfy-card" data-cfy-block="models">
      <div className="cfy-head">
        <h3>本地模型</h3>
        <span className={modelTotal ? 'cfy-tag ok' : 'cfy-tag'} data-cfy-models={modelTotal}>{modelTotal ? '已检测到' : '未检测到'}</span>
      </div>
      {modelTotal
        ? <>
          <p className="cfy-value">{modelTotal} 个模型{inventory ? '（ComfyUI 认得的）' : '文件（扫目录）'}</p>
          {modelRows.length
            ? <ul className="cfy-list" data-cfy-model-kinds={modelRows.length}>
              {modelRows.map(item => <li key={item.key}>
                {item.label} · {item.bucket!.count}
                {item.bucket!.names.length ? <span className="cfy-note"> — {item.bucket!.names.join('、')}{item.bucket!.count > item.bucket!.names.length ? ' …' : ''}</span> : null}
              </li>)}
            </ul>
            : null}
          {!inventory && <p className="cfy-hint">连上 ComfyUI 之后这里会换成它自己报的清单（含挂在别的盘上的模型）。</p>}
        </>
        : <>
          <p className="cfy-note">没有发现本机模型文件。</p>
          <ul className="cfy-list">
            <li>把模型文件放进 ComfyUI 的 <code>models</code> 下对应目录。</li>
            <li>模型放在别的盘时，用 ComfyUI 的 <code>extra_model_paths.yaml</code> 挂进来。</li>
          </ul>
        </>}
    </section>

    {/* ---------- 连接状态 ---------- */}
    <section className="cfy-card" data-cfy-block="connection">
      <div className="cfy-head">
        <h3>ComfyUI</h3>
        <span className={running ? 'cfy-tag ok' : 'cfy-tag'} data-cfy-state={running ? 'connected' : 'disconnected'}>
          {running ? '已连接' : '未连接'}
        </span>
      </div>
      <p className="cfy-note" data-cfy-probe={probe?.ok ? 'ok' : 'off'}>{probe?.message ?? '正在探测…'}</p>
      {system?.comfyuiVersion && <p className="cfy-note">
        ComfyUI {system.comfyuiVersion} · Python {system.pythonVersion} · PyTorch {system.pytorchVersion}
      </p>}
      {inventory && <p className="cfy-note" data-cfy-inventory={inventory.nodeTypeCount}>
        已装 {inventory.nodeTypeCount} 种节点 · 队列 {inventory.queueRunning} 个在跑 / {inventory.queuePending} 个在排
      </p>}
      {found.length > 0 && <div className="cfy-found" data-cfy-found={found.length}>
        <p className="cfy-note">本机这些地址上有 ComfyUI —— 点「改用这个」直接切过去：</p>
        {found.map(item => <div className="cfy-found-row" key={item.baseUrl}>
          <code>{item.baseUrl}</code>
          <span className="cfy-note">{item.message}</span>
          <button
            className="button secondary"
            type="button"
            data-cfy-action="use-base-url"
            disabled={busy !== null}
            onClick={() => void useThisBaseUrl(item.baseUrl)}
          >改用这个</button>
        </div>)}
      </div>}
      {!probe?.ok && scanNote && <p className="cfy-hint" data-cfy-scan="none">{scanNote}</p>}
      {!probe?.ok && processes.length > 0 && <div className="cfy-found" data-cfy-processes={processes.length}>
        <p className="cfy-note">这台机器上正跑着 ComfyUI —— 端口是从它的启动命令行里认出来的，点「连到这个」直接切过去：</p>
        {processes.map(item => <div className="cfy-found-row" key={item.pid}>
          <code>{item.port ? `127.0.0.1:${item.port}` : '端口认不出'}</code>
          <span className="cfy-note">{item.dir || '认不出安装目录'}</span>
          <button
            className="button secondary"
            type="button"
            data-cfy-action="use-process"
            disabled={busy !== null || !item.port}
            onClick={() => void useThisProcess(item)}
          >连到这个</button>
        </div>)}
      </div>}
      <ul className="cfy-list">
        <li>现在用的是 <code>{view.baseUrl}</code>（{sourceText}）。</li>
        <li>没起来就点下面的「启动 ComfyUI」。</li>
        <li>地址不对，在下面「连接设置」里改。</li>
      </ul>
    </section>

    {/* ---------- 连接设置（原「本机 ComfyUI」那页剩下的东西） ---------- */}
    <section className="cfy-card" data-cfy-block="settings">
      <div className="cfy-head"><h3>连接设置</h3></div>

      <label className="field">
        <span>服务地址</span>
        <input
          value={baseUrl}
          autoComplete="off"
          spellCheck={false}
          placeholder="http://127.0.0.1:8188"
          data-cfy-input="base-url"
          onChange={event => setBaseUrl(event.target.value)}
        />
      </label>

      <label className="field">
        <span>API Key（可留空）</span>
        <input
          type="password"
          value={apiKey}
          autoComplete="off"
          spellCheck={false}
          placeholder="本机一般没有鉴权，留空即可"
          data-cfy-input="api-key"
          onChange={event => setApiKey(event.target.value)}
        />
      </label>

      {/* 桌面版所有生成恒走本机（没有云端那条路），这个开关在桌面版没有任何意义，只在 web 版出现。 */}
      {!isDesktop && (
        <label className="cfy-switch">
          <input
            type="checkbox"
            checked={view.enabled}
            disabled={busy !== null}
            onChange={event => void toggleEnabled(event.target.checked)}
          />
          <span>{view.enabled ? '本地模式 · 开' : '本地模式 · 关'}</span>
        </label>
      )}
      {!isDesktop && <p className="cfy-hint">开了之后，画布上所有生成都投到你这台机器，不扣费、不经过 RunningHub。</p>}

      <div className="cfy-actions">
        <button className="button" type="button" data-cfy-action="save" disabled={busy !== null} onClick={() => void saveConnection()}>
          {busy === 'save' ? '保存中…' : '保存'}
        </button>
        <button className="button secondary" type="button" data-cfy-action="probe" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === 'probe' ? '探测中…' : busy === 'scan' ? '扫端口…' : busy === 'detect' ? '查进程…' : '测试连接'}
        </button>
        <button className="button secondary" type="button" data-cfy-action="clear" disabled={busy !== null} onClick={() => void clearAll()}>
          {busy === 'clear' ? '清除中…' : '全部清除'}
        </button>
      </div>

      <p className="cfy-note" data-cfy-masked={view.masked ? 'set' : 'unset'}>
        密钥：{view.masked || '未设置 · 本机一般不鉴权'}（AES-256-GCM 加密存库）
      </p>
      {note && <p className={note.ok ? 'cfy-note' : 'cfy-hint'} data-cfy-note={note.ok ? 'ok' : 'off'}>{note.message}</p>}
    </section>

    {/* ---------- 安装目录（启动要用，排在启动之前） ---------- */}
    <section className="cfy-card" data-cfy-block="dir">
      <div className="cfy-head"><h3>ComfyUI 安装目录</h3></div>
      <label className="field">
        <span>选整合包里包含 ComfyUI 与 <code>python_embeded</code> 的那一层</span>
        <input
          value={comfyuiDir}
          autoComplete="off"
          spellCheck={false}
          placeholder={'D:\\ComfyUI'}
          data-cfy-input="dir"
          onChange={event => setComfyuiDir(event.target.value)}
        />
      </label>
      <div className="cfy-actions">
        <button className="button secondary" type="button" data-cfy-action="save-dir" disabled={busy !== null || !dirDirty}
          onClick={() => void saveDir(comfyuiDir)}>{busy === 'dir' ? '保存中…' : '保存目录'}</button>
        {canBrowse && <button className="button secondary" type="button" data-cfy-action="browse-dir" disabled={busy !== null}
          onClick={() => void browseDir()}>{busy === 'dir' ? '选择中…' : '浏览…'}</button>}
        {canDetect && <button className="button secondary" type="button" data-cfy-action="find-installs" disabled={busy !== null}
          onClick={() => void findInstalls()}>{busy === 'installs' ? '正在找…' : '自动找'}</button>}
      </div>
      <p className={dirOk ? 'cfy-note' : 'cfy-hint'} data-cfy-dir={view.comfyuiDir ? (dirOk ? 'ok' : 'warn') : 'unset'}>
        {view.comfyuiDir
          ? (dirOk ? view.comfyuiDir : `${view.comfyuiDir}（这里没有 main.py，不是 ComfyUI 的根目录）`)
          : '还没设置。不设的话只能连你自己先开好的 ComfyUI，应用没法帮你启动。'}
      </p>
      {view.dir?.looksLikeComfyui && <p className="cfy-note">
        目录扫描：{view.dir.nodeTypeCount} 个节点类型 · {view.dir.customNodePackages} 个节点包
      </p>}
      {installs.length > 0 && <div className="cfy-found" data-cfy-installs={installs.length}>
        <p className="cfy-note">扫到这些地方像是 ComfyUI —— 点「用这个」填进去：</p>
        {installs.map(item => <div className="cfy-found-row" key={item.dir}>
          <code>{item.dir}</code>
          <span className="cfy-note">
            {item.hasModels ? '有 models' : '没有 models'}
            {item.hasCustomNodes ? ' · 有 custom_nodes' : ''}
            {item.hasPython ? ' · 找到 python' : ' · 附近没有 python（可能起不来）'}
          </span>
          <button
            className="button secondary"
            type="button"
            data-cfy-action="use-install"
            disabled={busy !== null}
            onClick={() => void useThisInstall(item.dir)}
          >用这个</button>
        </div>)}
      </div>}
      {installNote && <p className="cfy-hint">{installNote}</p>}
      <p className="cfy-hint">
        这个目录用来<strong>查缺什么、启动它，以及往 <code>custom_nodes</code> 里放下面那两个扩展</strong>：
        服务没开的时候，应用会只读扫一遍里面的 <code>custom_nodes</code>（哪些节点装了）和
        <code>models</code>（哪些模型文件在）。服务开着时以它自己的 <code>/object_info</code> 为准 —— 那个更准。
        <strong>不会下载任何东西</strong>，只把随包的两个扩展复制进去。
      </p>
    </section>

    {/* ---------- ComfyUI 扩展（排在安装目录之后：没有目录就没得装） ---------- */}
    {canExt && <section className="cfy-card" data-cfy-block="extensions">
      <div className="cfy-head">
        <h3>ComfyUI 扩展</h3>
        <span
          className={extensions && extensions.length > 0 && extensions.every(item => item.status === 'up-to-date') ? 'cfy-tag ok' : 'cfy-tag'}
          data-cfy-ext-ready={extensions ? extensions.filter(item => item.status === 'up-to-date').length : -1}
        >{!extensions
            ? '待检测'
            : `${extensions.filter(item => item.status === 'up-to-date').length} / ${extensions.length} 已就位`}</span>
      </div>
      <p className="cfy-note">
        这两个扩展与 AIFISHER <strong>共用同一份</strong>：已经装过就不会再复制一遍，
        AIFISHER 自己升级也不影响这里。都不是必需的，装不装由你决定；运行中的 ComfyUI 不会被自动重启。
      </p>
      <div className="cfy-ext-list" data-cfy-exts={extensions?.length ?? 0}>
        {(extensions ?? []).map(item => <div className="cfy-ext" key={item.id} data-cfy-ext={item.id} data-cfy-ext-status={item.status}>
          <div className="cfy-ext-head">
            <strong>{item.name}</strong>
            <span className={item.status === 'up-to-date' ? 'cfy-ext-state ok' : item.status === 'unavailable' ? 'cfy-ext-state off' : 'cfy-ext-state'}>
              {EXT_STATE_TEXT[item.status]}{item.status === 'up-to-date' && (item.installedVersion ?? item.bundledVersion) ? ` v${item.installedVersion ?? item.bundledVersion}` : ''}
            </span>
          </div>
          <p className="cfy-note">{item.purpose}</p>
          <p className="cfy-hint">装了以后：{item.benefit}</p>
          <p className="cfy-hint">{item.optional}</p>
          {item.status === 'update-available' && item.installedVersion && <p className="cfy-hint">现在装的是 v{item.installedVersion}。</p>}
          {item.status === 'unavailable' && item.message && <p className="cfy-hint" data-cfy-ext-why={item.id}>{item.message}</p>}
          <div className="cfy-actions">
            <button
              className="button secondary"
              type="button"
              data-cfy-action="install-ext"
              data-cfy-ext-install={item.id}
              disabled={!item.installable || extBusy !== null}
              onClick={() => void installOne(item.id)}
            >{extBusy === item.id
                ? '处理中…'
                : item.status === 'up-to-date'
                  /* 共用模式下「已安装」= 目录里有入口文件，点这一下不会重写 —— 所以叫「再检查一次」，不叫「重新安装」。 */
                  ? '再检查一次'
                  : item.status === 'update-available'
                    ? '更新'
                    : item.status === 'needs-repair' ? '修复' : '安装'}</button>
          </div>
        </div>)}
      </div>
      {legacy && legacy.some(item => item.exists) && <div className="cfy-legacy" data-cfy-legacy-block={legacy.filter(item => item.exists).length}>
        <p className="cfy-hint" data-cfy-legacy-why>
          检测到上一版 Holy Light画布装的扩展还在。它的编号徽标和上面那个画在<b>同一个位置</b>，
          两个都在时编号会糊成一团 —— 建议移除（只删这两个目录，不动别的）。
        </p>
        {legacy.filter(item => item.exists).map(item => <div className="cfy-legacy-row" key={item.id} data-cfy-legacy={item.id} data-cfy-legacy-exists="1">
          <code>{item.id}</code>
          <span className="cfy-hint">{item.targetDir}</span>
          <div className="cfy-actions">
            <button
              className="button secondary"
              type="button"
              data-cfy-action="remove-legacy"
              data-cfy-legacy-remove={item.id}
              disabled={extBusy !== null}
              onClick={() => void removeLegacy(item.id)}
            >{extBusy === item.id ? '移除中…' : '移除'}</button>
          </div>
        </div>)}
      </div>}
      {extNote && <p className={extNote.ok ? 'cfy-note' : 'cfy-hint'} data-cfy-ext-note={extNote.ok ? 'ok' : 'off'}>{extNote.message}</p>}
      <p className="cfy-hint">
        无法自动安装时，也可把 Holy Light画布随包 <code>integrations/comfyui</code> 下对应的文件夹
        （<code>fisherai_node_ids</code>、<code>fisherai_canvas_inputs</code>）复制到
        ComfyUI 的 <code>custom_nodes</code> 里，再重启 ComfyUI。
      </p>
    </section>}

    {/* ---------- 启动器 ---------- */}
    <section className="cfy-card" data-cfy-block="launcher">
      <div className="cfy-head">
        <h3>运行状态</h3>
        <span className={launcher.state === 'ready' ? 'cfy-tag ok' : launcher.state === 'failed' ? 'cfy-tag off' : 'cfy-tag'}
          data-cfy-launcher={launcher.state}>
          {STATE_TEXT[launcher.state]}
        </span>
      </div>
      <p className="cfy-note" data-cfy-message="">{launcher.message}</p>
      {launcher.state === 'starting' && waited && <p className="cfy-note">已等待 {waited}，插件多的时候要 1～3 分钟。</p>}
      {launcher.command && <p className="cfy-path">{launcher.command}</p>}

      <div className="cfy-actions">
        <button
          className="button"
          type="button"
          data-cfy-action="start"
          disabled={!canLaunch || busy !== null || launcher.state === 'starting' || running}
          onClick={() => void start()}
        >{busy === 'start' ? '启动中…' : launcher.state === 'starting' ? '正在启动…' : '启动 ComfyUI'}</button>
        <button
          className="button secondary"
          type="button"
          data-cfy-action="stop"
          disabled={!canLaunch || busy !== null || launcher.state !== 'ready'}
          onClick={() => void stop()}
        >{busy === 'stop' ? '停止中…' : '停止'}</button>
        <button className="button secondary" type="button" data-cfy-action="reprobe" disabled={busy !== null} onClick={() => void refresh()}>
          {busy === 'probe' ? '探测中…' : busy === 'scan' ? '扫端口…' : busy === 'detect' ? '查进程…' : '重新探测'}
        </button>
      </div>
      {!canLaunch && <p className="cfy-hint">只有桌面版能启动本机 ComfyUI。</p>}
    </section>

    {/* ---------- 工作流从哪来 ---------- */}
    <section className="cfy-card" data-cfy-block="workflow">
      <div className="cfy-head"><h3>工作流图</h3></div>
      <p className="cfy-note">
        图不再存在设置里 —— 它跟着工作流走。要在本机跑工作流，请到{' '}
        <Link className="cfy-link" href="/settings/providers/workflows">设置 · 工作流配置</Link>{' '}
        里用「本机 ComfyUI 导入」一条条导入：每一份自己带一张图、自己挑要用哪些字段，
        和云端那份的配置方式一模一样。
      </p>
      <p className="cfy-hint">
        图必须是 <strong>API 格式</strong>（节点里带的是 <code>inputs</code> 对象），不是 UI 格式 ——
        导成 UI 格式的话保存能成功，但生成时一个字段都写不进去。
      </p>
    </section>

    {/* ---------- 模型目录（可选） ---------- */}
    <section className="cfy-card" data-cfy-block="modeldir">
      <div className="cfy-head"><h3>模型目录</h3></div>
      <p className="cfy-hint">
        整合包自带模型目录时不用填。模型放在别处才需要在这里追加路径，
        改完重启 ComfyUI 生效 —— 这一项走的是 ComfyUI 自己的 <code>extra_model_paths.yaml</code>。
      </p>
    </section>
  </div>;
}

/**
 * `/object_info` 里那几类模型的显示名。**顺序就是界面上的顺序**：
 * 大模型排第一，因为「本机有没有 checkpoint」是这条路上第一个要回答的问题。
 */
const MODEL_KINDS: { key: string; label: string }[] = [
  { key: 'checkpoints', label: '大模型' },
  { key: 'diffusionModels', label: '扩散模型（UNET）' },
  { key: 'textEncoders', label: '文本编码器（CLIP）' },
  { key: 'vaes', label: 'VAE' },
  { key: 'loras', label: 'LoRA' },
  { key: 'controlnets', label: 'ControlNet' },
  { key: 'upscaleModels', label: '放大模型' },
];

/** 地址是哪来的 —— 填之前先说清，免得用户以为自己改过（其实读的是 .env）。 */
const SOURCE_TEXT: Record<LocalConnectionView['baseUrlSource'], string> = {
  user: '你自己填的',
  env: '服务端 .env 的 LOCAL_BASE_URL',
  default: '默认值（还没填过）',
};

const STATE_TEXT: Record<ComfyuiStatus['state'], string> = {
  idle: '未启动',
  starting: '正在启动',
  ready: '已就绪',
  stopped: '已停止',
  failed: '启动失败',
};

/**
 * 扩展状态 → 卡片右上角那句话。
 *
 * **`missing` 不写成错误色**：没装是默认状态，不是故障 —— 一进来就一片红会让人以为软件坏了。
 * 只有 `unavailable`（没配目录 / 目标目录不安全）才是真的「现在办不到」，那才用红色。
 */
const EXT_STATE_TEXT: Record<ComfyuiExtensionView['status'], string> = {
  unavailable: '还装不了',
  missing: '未安装',
  /*
   * 共用扩展的「已安装」是「目录里有入口文件」，不是「和随包那份字节一致」——
   * AIFISHER 可能已经把它升到更新的版本了。所以这里不写「最新版」，
   * 版本号也显示**实际装的那份**（见上面 `installedVersion ?? bundledVersion`）。
   */
  'up-to-date': '已安装',
  'needs-repair': '需要修复',
  'update-available': '有新版本',
};

/** 字节数转成人看的大小。0 / 缺失一律显示「—」，不要显示 `0 GB` 让人以为真的是 0。 */
function formatBytes(value?: number): string {
  if (!value || value <= 0) return '—';
  const gb = value / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(value / 1024 / 1024).toFixed(0)} MB`;
}
