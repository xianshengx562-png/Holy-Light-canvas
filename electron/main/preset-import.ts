/*
 * 创作预设的**导入**（2026-10-07）—— 把 ComfyUI-Easy-Use 那套 styles JSON 收进本机。
 *
 * 为什么要走主进程：渲染进程没有 `node:fs`，既读不了用户选的目录，也**复制不了**预览图。
 * 而预览图必须复制 —— 用户选的那个目录是 ComfyUI 整合包里的，哪天整合包挪了 / 删了 / 升级了
 * 被覆盖，卡片就全变成占位符。所以导入做的其实是两件事：**读 JSON** + **把图搬进数据目录**。
 *
 * 🔴 与内置那批（AIFISHER 的 285 条，`src/components/canvas/creativeCatalog.ts`）的分工：
 * 内置那批是**生成物**、烤进 asar 的，改一次要重新打包；导入的这批是**用户数据**，
 * 存在 `<dataDir>/creative-presets/` 下，随时能换能删，也不进安装包（3946 条 + 88 MB 预览图）。
 *
 * 🔴 存的形状必须能被 `normalizePreset()` 认下来（`src/components/canvas/creativePresets.ts`）：
 * 画布 JSON 里存的是**整条快照**，导入源没了 / 组被删了，老画布上那条预设照样能显示、能提交。
 * 这是「存快照而不是存 id」那条规矩的另一半。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

/** 导入的预设落在哪：`<dataDir>/creative-presets/`。 */
export function presetImportRoot(): string {
  return path.join(runtimePaths().dataDir, 'creative-presets');
}

/** 预览图的落点：`<dataDir>/creative-presets/assets/<group>/`。 */
function assetDirOf(group: string): string {
  return path.join(presetImportRoot(), 'assets', safeSlug(group));
}

/** 清单文件。 */
function manifestPath(): string {
  return path.join(presetImportRoot(), 'imported.json');
}

/**
 * 组 id：分类名转成的文件名安全串。
 *
 * 🔴 不能直接用用户填的原名当目录名 —— 「摄影/超现实」「a:b」「..」这些在 Windows 上
 * 要么是非法文件名，要么会跳出这个目录（路径穿越）。一律压成 `[a-z0-9-_]`。
 * 显示用的原名另外存在 `group.name` 里，界面上看到的仍然是「摄影超现实」。
 */
export function safeSlug(raw: string): string {
  const base = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\:*?"<>|.]+/g, '-')
    .replace(/[^a-z0-9\-_一-龥]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'preset';
}

/** 一条导入的预设（形状与渲染层的 `CreativePreset` 一致）。 */
export type ImportedPreset = {
  id: string;
  kind: 'style';
  category: string;
  name: string;
  description: string;
  prompt: string;
  preview: string;
  /** 属于哪一组（= 导入时填的分类名转成的 id）。界面上「删掉这一组」用它。 */
  group: string;
};

/** 一组导入的预设。 */
export type ImportedGroup = {
  id: string;
  /** 用户填的分类名（显示用，可能含中文 / 斜杠）。 */
  name: string;
  /** 来源目录或文件，只是给用户看的出处。 */
  source: string;
  importedAt: string;
  count: number;
};

export type PresetImportManifest = {
  version: 1;
  groups: ImportedGroup[];
  presets: ImportedPreset[];
};

/** 一个 style 条目在 JSON 里的样子（ComfyUI-Easy-Use 的格式）。 */
type StyleEntry = {
  name?: string;
  prompt?: string;
  negative_prompt?: string;
  name_cn?: string;
  thumbnail?: string;
};

function emptyManifest(): PresetImportManifest {
  return { version: 1, groups: [], presets: [] };
}

export function readManifest(): PresetImportManifest {
  try {
    const raw = fs.readFileSync(manifestPath(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<PresetImportManifest>;
    if (!parsed || !Array.isArray(parsed.groups) || !Array.isArray(parsed.presets)) return emptyManifest();
    return { version: 1, groups: parsed.groups, presets: parsed.presets };
  } catch {
    /* 第一次导入 / 文件被手删 / 写坏了 —— 都当成「还没有」。导入是可重复的，丢了不致命。 */
    return emptyManifest();
  }
}

/**
 * 写清单。**先写临时文件再改名**：写到一半崩了也不会留下半份坏清单
 * （那种文件下次读出来 JSON.parse 直接抛，整个预设面板就空了 —— 而用户根本不知道发生过什么）。
 *
 * 🔴 改名失败要**兜住改直接写**（2026-10-07）：改名会被杀软 / 备份软件 / 索引器拦一下，
 * 而走到这一步时那 88 MB 预览图已经搬完了 —— 因为一次 rename 被拦就把整趟作废，
 * 用户看到的是「导入失败」，却不知道重来一次还要再等一分钟。
 * 直接写丢了原子性，但清单只有一两 MB、写完即刻返回，风险远小于「整趟白干」。
 */
function writeManifest(manifest: PresetImportManifest): void {
  fs.mkdirSync(presetImportRoot(), { recursive: true });
  const target = manifestPath();
  const tmp = target + '.tmp';
  const body = JSON.stringify(manifest);
  try {
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, target);
    return;
  } catch {
    /* 落到下面：直接写。 */
  }
  try {
    fs.writeFileSync(target, body, 'utf8');
    return;
  } catch {
    /* 再落一档：先删掉旧的再建一个新的。 */
  }
  /*
   * 🔴 最后一档是「**删掉再建**」，不是随便加的（2026-10-07 实测）：
   * 有的机器（杀软 / 索引器 / 备份软件正在看那个文件）既不让 rename 覆盖、
   * 也不让直接覆盖写，但**允许删掉旧的、再建一个新的**。真机上真遇到了
   * `EPERM: rename ... imported.json`，而那一趟的 88 MB 已经搬完了 ——
   * 为了一次 rename 把整趟作废，用户只看到「导入失败」、不知道重来还要等一分钟。
   */
  try {
    if (fs.existsSync(target)) fs.unlinkSync(target);
    fs.writeFileSync(target, body, 'utf8');
    return;
  } catch (e) {
    throw new Error('清单写不进去：' + String((e as Error)?.message || e));
  }
}

/**
 * 把 JSON 里的一条变成内部形状。
 *
 * 🔴 `name_cn` 优先：这批有中文名（ComfyUI-Easy-Use 的汉化字段）。但它是**机器翻的**，
 * 有的被截断（"Cozy Isometric Minia"），所以 description 留英文原名 —— 界面上鼠标悬停 /
 * 卡片副标题能看到原词，认不出中文时还有英文名兜着。
 *
 * 🔴 `prompt` **一个字都不改**，包括那个 `Subject:{prompt}` 占位符。
 * 替换是提交时的事（`composeCreativePrompt`）—— 现在改了，用户换一句正文就得重新导入一次。
 */
function toPreset(entry: StyleEntry, group: string, category: string, seq: number): ImportedPreset | null {
  const en = String(entry.name || '').trim();
  const cn = String(entry.name_cn || '').trim();
  const name = cn || en;
  const prompt = String(entry.prompt || '').trim();
  if (!name || !prompt) return null;
  /*
   * id 必须**稳定**：收藏存在 localStorage 里是一串 id，改名 / 重排之后 id 跟着变，
   * 用户收藏的那几条就「丢了」。所以取「组 + 英文名」的哈希，而不是序号。
   */
  const hash = crypto.createHash('md5').update(group + '\u0000' + en).digest('hex').slice(0, 10);
  return {
    id: `${group}-${hash}-${seq}`,
    kind: 'style',
    category,
    name,
    description: en && en !== name ? en : '',
    prompt,
    preview: '',
    group,
  };
}

/** 收一个目录 / 一批文件里的 styles JSON。返回按文件名排好序的绝对路径。 */
export function collectStyleFiles(payload: { dir?: string; files?: string[] }): string[] {
  const out: string[] = [];
  if (payload.dir) {
    const dir = String(payload.dir);
    let names: string[] = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return out;
    }
    for (const name of names.sort()) {
      if (!name.toLowerCase().endsWith('.json')) continue;
      /* 示例文件不是真数据（`your_styles.json.example` 结尾不是 .json，但保个险）。 */
      if (name.toLowerCase().endsWith('.example')) continue;
      out.push(path.join(dir, name));
    }
    return out;
  }
  for (const file of payload.files || []) {
    const p = String(file || '').trim();
    if (p && p.toLowerCase().endsWith('.json')) out.push(p);
  }
  return out;
}

/** 读一个 styles JSON 里的条目（坏文件跳过，不让它拖垮整批）。 */
function readEntries(file: string): { entries: StyleEntry[]; error: string } {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) return { entries: parsed as StyleEntry[], error: '' };
    /* 有的包把 styles 包了一层对象。 */
    const inner = (parsed as Record<string, unknown>)?.styles;
    if (Array.isArray(inner)) return { entries: inner as StyleEntry[], error: '' };
    return { entries: [], error: '不是预设数组' };
  } catch (e) {
    return { entries: [], error: String((e as Error)?.message || e).slice(0, 120) };
  }
}

/** 图扩展名白名单 —— 只搬这些，别的东西一律不进数据目录。 */
const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];

/** 一次最多并发多少个复制。太大了会把磁盘打满队列，太小了 88 MB 要搬很久。 */
const COPY_CONCURRENCY = 16;

async function copyBatch(jobs: { from: string; to: string }[]): Promise<number> {
  let done = 0;
  for (let i = 0; i < jobs.length; i += COPY_CONCURRENCY) {
    const slice = jobs.slice(i, i + COPY_CONCURRENCY);
    const results = await Promise.all(
      slice.map(job =>
        fs.promises
          .copyFile(job.from, job.to)
          .then(() => true)
          .catch(() => false),
      ),
    );
    done += results.filter(Boolean).length;
  }
  return done;
}

export type PresetImportResult = {
  ok: boolean;
  message: string;
  group: ImportedGroup | null;
  /** 读到多少条 JSON 记录 / 多少条真的成了预设 / 多少张图搬成功了。 */
  scanned: number;
  imported: number;
  images: number;
  /** 跳过的原因（坏文件、没图、重名），给界面显示前几条。 */
  skipped: string[];
};

/**
 * 导入。
 *
 * 🔴 同名分组 = **覆盖**：用户把分类名填成一样的再导一次，意图是「刷新这批」，
 * 而不是「再叠一份」—— 叠上去的话界面里会有 7892 条同名预设，删都不知道删哪个。
 * 所以先把旧组（含它的图目录）整个清掉，再写新的。
 */
export async function importPresets(payload: {
  dir?: string;
  files?: string[];
  category: string;
}): Promise<PresetImportResult> {
  const category = String(payload.category || '').trim() || 'krea2';
  const groupId = safeSlug(category);
  const files = collectStyleFiles(payload);
  if (!files.length) {
    return { ok: false, message: '那个目录里没有 .json 预设文件。', group: null, scanned: 0, imported: 0, images: 0, skipped: [] };
  }

  /* 先清旧组（覆盖语义）。图目录整个删掉 —— 反正马上要重搬一遍。 */
  const manifest = readManifest();
  const keptGroups = manifest.groups.filter(item => item.id !== groupId);
  const keptPresets = manifest.presets.filter(item => item.group !== groupId);
  try {
    fs.rmSync(assetDirOf(groupId), { recursive: true, force: true });
  } catch {
    /* 目录不存在 / 被占用 —— 反正下面会重建，图缺几张也不致命。 */
  }

  const destDir = assetDirOf(groupId);
  fs.mkdirSync(destDir, { recursive: true });

  const presets: ImportedPreset[] = [];
  const copyJobs: { from: string; to: string }[] = [];
  const skipped: string[] = [];
  const usedPreview = new Set<string>();
  let scanned = 0;
  const sourceLabel = payload.dir || (payload.files || [])[0] || '';

  for (const file of files) {
    const { entries, error } = readEntries(file);
    if (error) {
      skipped.push(`${path.basename(file)}：${error}`);
      continue;
    }
    const baseDir = path.dirname(file);
    for (const entry of entries) {
      scanned++;
      const preset = toPreset(entry, groupId, category, presets.length);
      if (!preset) continue;

      /* 预览图：路径是相对 styles 目录的（`./samples/xxx.webp`）。 */
      const rel = String(entry.thumbnail || '').replace(/^\.\//, '').replace(/^\.\//, '');
      if (rel) {
        const ext = path.extname(rel).toLowerCase();
        if (!IMAGE_EXT.includes(ext)) {
          preset.preview = '';
        } else {
          const abs = path.resolve(baseDir, rel);
          if (fs.existsSync(abs)) {
            /* 图名去重：不同分类下可能有同名图，直接用原名会互相覆盖。 */
            const digest = crypto.createHash('md5').update(rel).digest('hex').slice(0, 12);
            const stored = `${digest}${ext}`;
            preset.preview = `/ipassets/${groupId}/${stored}`;
            if (!usedPreview.has(stored)) {
              usedPreview.add(stored);
              copyJobs.push({ from: abs, to: path.join(destDir, stored) });
            }
          } else {
            preset.preview = '';
          }
        }
      }
      presets.push(preset);
    }
  }

  const images = await copyBatch(copyJobs);

  const group: ImportedGroup = {
    id: groupId,
    name: category,
    source: sourceLabel,
    importedAt: new Date().toISOString(),
    count: presets.length,
  };

  writeManifest({
    version: 1,
    groups: [...keptGroups, group],
    presets: [...keptPresets, ...presets],
  });

  const noImage = presets.filter(item => !item.preview).length;
  return {
    ok: presets.length > 0,
    message: presets.length
      ? `导入 ${presets.length} 条到「${category}」，搬了 ${images} 张预览图${noImage ? `（${noImage} 条没图）` : ''}。`
      : '没有读到可用的预设。',
    group,
    scanned,
    imported: presets.length,
    images,
    skipped: skipped.slice(0, 5),
  };
}

/** 删掉一组（连它的图目录一起）。 */
export function removePresetGroup(groupId: string): { ok: boolean; message: string } {
  const id = safeSlug(groupId);
  const manifest = readManifest();
  const group = manifest.groups.find(item => item.id === id);
  if (!group) return { ok: false, message: '找不到这一组。' };
  writeManifest({
    version: 1,
    groups: manifest.groups.filter(item => item.id !== id),
    presets: manifest.presets.filter(item => item.group !== id),
  });
  try {
    fs.rmSync(assetDirOf(id), { recursive: true, force: true });
  } catch {
    /* 删不掉就算了：清单里已经没有它了，下次启动不会再显示。磁盘上剩点文件用户自己清。 */
  }
  return { ok: true, message: `已删除「${group.name}」。` };
}

/** 预览图的真实落点（供协议处理器读）。路径穿越在这道关上被挡掉。 */
export function resolvePresetAsset(urlPath: string): string | null {
  const clean = String(urlPath || '').replace(/^\/+/, '');
  const parts = clean.split('/').filter(Boolean);
  /* 只认 `/ipassets/<group>/<file>` 这两段，多一段少一段都不行。 */
  if (parts.length !== 2) return null;
  const [group, file] = parts;
  if (!/^[a-z0-9\-_一-龥]+$/.test(group)) return null;
  if (!/^[a-f0-9]{8,16}\.(jpg|jpeg|png|webp|gif)$/i.test(file)) return null;
  const target = path.join(assetDirOf(group), file);
  const root = path.join(presetImportRoot(), 'assets');
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return target;
}
