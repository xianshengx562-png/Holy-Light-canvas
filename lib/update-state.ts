/**
 * 软件内更新的**状态机**（2026-09-29）。
 *
 * 徐先的问题：「如果已经到 2.0 了，用户才 1.0，用户怎么在软件内实现更新的效果。」
 * 答案拆成两半：`electron-updater` 负责「问、下、装」，这一层负责「现在是什么情况、
 * 界面该说什么、按钮该不该能点」—— 后者是纯函数，所以它**不 import electron**，
 * 可以单独编成 CJS 跑断言（`FRAME\_test-update-state.py`）。
 *
 * 为什么值得单独抽出来：更新这件事的失败几乎全在**状态的边角** ——
 * 「下载完了又去点检查」「正在下载时又点下载」「出错之后按钮死灰点不动」。
 * 这些在真机上要凑出来很慢（要起一个假更新源、要等 120MB），而断言是毫秒级的。
 *
 * ⚠️ 与 `electron/main/updater.ts` 是一对：那边把 electron-updater 的事件翻译成
 * 这里的 `UpdateEvent`，这边算完再推给界面。改一边要同步另一边。
 */

/**
 * 更新进行到哪一步。
 *
 * 九个状态而不是四个布尔，是因为「没更新」这件事有**三种完全不同的原因**，
 * 界面要说的是三句不同的话：
 *   - `unsupported`：这一份自己升不了（便携版、没打包、非 Windows）→ 只能去下载新安装包；
 *   - `unconfigured`：能升，但不知道该问谁（没填更新源）→ 让人去填；
 *   - `not-available`：问过了，确实没有 → 「已经是最新版」。
 * 三句合在一起说成「暂无更新」，用户就不知道该做什么了。
 */
export type UpdatePhase =
  | 'unsupported'
  | 'unconfigured'
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export type UpdateState = {
  phase: UpdatePhase;
  /** 这一份自己的版本号（来自 package.json）。 */
  currentVersion: string;
  /** 更新源地址；空串表示没配。 */
  source: string;
  /** 发现的新版本号；没有就是 null。 */
  version: string | null;
  /** 0–100。只在 `downloading` 有意义，别的状态一律 0。 */
  percent: number;
  /** 给界面直接显示的一句话。出错时它就是诊断线索。 */
  message: string;
  /** 更新说明（latest.yml 里的 releaseNotes），可能很长，界面自己截断。 */
  notes: string;
};

export type UpdateEvent =
  /** 初始化 / 改了更新源：回到「待检查」。 */
  | { kind: 'reset'; currentVersion: string; source: string; supported: boolean }
  | { kind: 'checking' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'not-available'; version?: string }
  | { kind: 'progress'; percent: number }
  | { kind: 'downloaded'; version: string }
  | { kind: 'error'; message: string };

export const INITIAL_UPDATE_STATE: UpdateState = {
  phase: 'idle',
  currentVersion: '',
  source: '',
  version: null,
  percent: 0,
  message: '',
  notes: '',
};

/**
 * 版本比较：`a` 比 `b` 新才返回 true。
 *
 * 只按**点分数字**逐段比（1.0.24 / 2.0.0），不是完整 semver —— 这里要回答的只有一句
 * 「latest.yml 里那个号是不是比我这份新」。
 *
 * 非数字段（预发布后缀那种，`2.0.0-beta` 里的 `0-beta`）的处理是**判成不新**：
 * 于是 `2.0.0-beta` 盖不过 `2.0.0`（正式版不会被测试版顶掉），
 * 但它相对 `1.0.24` 仍然算新 —— 它确实比 1.0 新，那是对的。
 * 这软件目前不发预发布版，这条规矩只是别让「谁手滑在 latest.yml 里写了个 beta」
 * 变成「所有人被推去装测试版」。
 */
export function isNewer(a: string, b: string): boolean {
  const pa = String(a || '').split('.');
  const pb = String(b || '').split('.');
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) {
    const x = Number.parseInt(pa[i] ?? '0', 10);
    const y = Number.parseInt(pb[i] ?? '0', 10);
    /*
     * 有一边不是数字（`'2.0.0-beta'` 的第三段 `0-beta`）→ 判成**不新**。
     * 所以正式版 2.0.0 不会被 2.0.0-beta 顶掉；空串（`''.split('.')` 得 `['']`）同理。
     */
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      if (String(pa[i] ?? '') === String(pb[i] ?? '')) continue;
      return false;
    }
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * 把用户填的更新源**收拾干净**。返回空串表示「这个地址不能用」。
 *
 * 只认 http(s)（含 `http://127.0.0.1:8899/` 这种本机地址 —— 端到端探针就靠它：
 * 探针在本机起一个静态站当假更新源，才能真的走一遍「发现新版 → 下载 → 可安装」，
 * 而不用真去公网上下 120MB）。`file://` 一律不认：electron-updater 走的是 HTTP，
 * 放行它只会得到一个看不懂的错。
 *
 * 末尾统一补一个 `/`：electron-updater 是 `url + 'latest.yml'` 拼出地址的，
 * 少了这个斜杠就变成 `.../updateslatest.yml` —— 404，而且报错里看不出来。
 */
export function normalizeSource(raw: string): string {
  const s = String(raw || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) return '';
  /* 去掉行尾的 latest.yml：有人会直接把完整地址贴进来，那也是同一个源。 */
  const trimmed = s.replace(/latest\.yml$/i, '');
  return trimmed.endsWith('/') ? trimmed : trimmed + '/';
}

/** 下载进度。`total` 为 0（体积未知）时给 0，不要除出 NaN。 */
export function percentOf(transferred: number, total: number): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  const p = (Number(transferred) / total) * 100;
  if (!Number.isFinite(p)) return 0;
  return Math.max(0, Math.min(100, Math.round(p)));
}

/**
 * 状态机：进一个事件，出一个新状态。
 *
 * 三条要紧的规矩（都是断言在钉的）：
 *   1. `available` 之后还能再 `checking` —— 用户手动点「检查更新」时就是这样，
 *      别把它当非法转移忽略掉（忽略了就是「点了没反应」）。
 *   2. `error` 之后 `phase` 必须是 `error` 但**保留**上一次的版本信息，
 *      这样界面还能说「刚才在装 2.0.0 时出错了」，而不是一片空白。
 *   3. `downloading` 时进度只升不降：electron-updater 偶尔会回填一个更小的
 *      transferred（重试/换源），界面上的进度条往回缩看着像卡住了。
 */
export function reduce(state: UpdateState, event: UpdateEvent): UpdateState {
  switch (event.kind) {
    case 'reset': {
      const source = normalizeSource(event.source);
      const phase: UpdatePhase = !event.supported ? 'unsupported' : !source ? 'unconfigured' : 'idle';
      return {
        phase,
        currentVersion: event.currentVersion,
        source,
        version: null,
        percent: 0,
        message: !event.supported
          ? '这一份是便携版或开发版，装不了自动更新 —— 要升级请重新下载安装包。'
          : !source
            ? '还没填更新源，不知道该去哪儿问。填上之后这里就能检查更新了。'
            : '',
        notes: '',
      };
    }
    case 'checking':
      /* 没配源 / 不支持时，检查是个空操作，别把状态改成 checking（界面会一直转圈）。 */
      if (state.phase === 'unsupported' || state.phase === 'unconfigured') return state;
      return { ...state, phase: 'checking', percent: 0, message: '正在检查更新…', notes: '' };
    case 'available':
      return {
        ...state,
        phase: 'available',
        version: event.version,
        percent: 0,
        message: `发现新版本 ${event.version}（当前 ${state.currentVersion || '未知'}）。`,
        notes: event.notes ?? '',
      };
    case 'not-available':
      return {
        ...state,
        phase: 'not-available',
        version: event.version ?? state.currentVersion,
        percent: 0,
        message: '已经是最新版了。',
        notes: '',
      };
    case 'progress':
      return { ...state, phase: 'downloading', percent: Math.max(state.percent, percentOf(event.percent, 100)) };
    case 'downloaded':
      return {
        ...state,
        phase: 'downloaded',
        version: event.version,
        percent: 100,
        message: `新版本 ${event.version} 已经下载好了，重启软件就会装上。`,
      };
    case 'error':
      return { ...state, phase: 'error', message: event.message || '检查更新失败。' };
    default:
      return state;
  }
}

/** 这一个状态下，「检查更新」按钮该不该能点。 */
export function canCheck(state: UpdateState): boolean {
  return state.phase !== 'unsupported' && state.phase !== 'unconfigured' && state.phase !== 'checking'
    && state.phase !== 'downloading';
}

/** 「下载」只在**已经发现新版**之后才有意义 —— 不然点了是静默无反应。 */
export function canDownload(state: UpdateState): boolean {
  return state.phase === 'available' || state.phase === 'error';
}

/** 「重启并安装」只在**下载完**之后能点：没下载完就退出安装会装到一半。 */
export function canInstall(state: UpdateState): boolean {
  return state.phase === 'downloaded';
}

/** 要不要打扰用户（显示那条全局提示条）。 */
export function isNoticeWorthy(state: UpdateState): boolean {
  return state.phase === 'available' || state.phase === 'downloading' || state.phase === 'downloaded';
}
