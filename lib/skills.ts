import 'server-only';
import fs from 'node:fs';
import path from 'node:path';
import { runtimePaths } from '@/lib/runtime-paths';

/**
 * SKILL 社区的数据层（2026-09-25，模块从 AIFISHER 迁过来）。
 *
 * 一个技能 = **一个真实目录**，不是数据库里的一行：
 *
 *   <dataDir>/skills/<slug>/
 *     SKILL.md                —— 正文，带 YAML frontmatter（name / description）
 *     agent-skill.json        —— instructionReferences：正文之外还要读哪些参考
 *     references/*.md         —— 参考资料，按需读，不塞进 prompt
 *     skill.json              —— Holy Light画布自己加的：中文标题 / 简介 / 用法 / 是否用于优化
 *
 * **只有一层，没有「官方 / 我的」两个分组**（徐先 2026-09-25：官方推荐那栏不要了，
 * 七个内置技能直接落进来，跟自己导入的放一起）。分层只会让用户先纠结「我该看哪一栏」，
 * 而两栏里的东西长得一模一样、操作也一模一样。
 *
 * 为什么必须是**磁盘上的真目录**而不是数据库里的一行文本：
 * 技能最终是给 Codex 用的，而 Codex 是主进程 spawn 出去的**另一个进程** ——
 * 它只会读文件系统。存进库里等于每次调用前还要先落一遍盘，而且库里那份和盘上那份
 * 迟早会对不上。让磁盘当唯一事实，库里只放标记。
 *
 * ⚠️ 内置技能**必须**复制（seed）到数据目录，不能原地引用包内的那份：
 * 打包后包内是 `app.asar`，asar 里的路径只有 Electron 自己的进程认，
 * Codex 拿 `…/app.asar/builtin-skills/…` 这样的路径是读不到的。
 */

/**
 * 技能的用法分类（AIFISHER 那边的两栏）。
 * - `use`  拿来用：按它的写法产出东西。
 * - `edit` 拿来改：它描述的是「怎么改已有的东西」。
 */
export type SkillUsage = 'use' | 'edit';

export type SkillView = {
  /** 就是 slug —— 目录名，也是前端的 id。拼路径前一定过 `SLUG_RE`。 */
  id: string;
  slug: string;
  /** 中文标题。frontmatter 里的 `name` 是英文 id，不能直接显示。 */
  title: string;
  description: string;
  usage: SkillUsage;
  /** 是否出现在 dock「优化提示词」旁边那个下拉里。 */
  optimize: boolean;
  /** 用户自己打的分类标签（一个技能可以打多个）。分类表见文件顶上那段。 */
  tags: string[];
  /** 绝对路径。给 Codex 的就是它。 */
  dir: string;
  /** 目录里的文件清单（相对路径），界面上让用户知道这个技能带了多少资料。 */
  files: string[];
  /** `agent-skill.json` 里点名的参考文件 —— 调用时优先读这些。 */
  references: string[];
  updatedAt: number;
};

/** 单个技能目录里允许的文件后缀。二进制（案例图）一律不要。 */
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.py']);
const SKILL_FILE = 'SKILL.md';
const META_FILE = 'skill.json';
const AGENT_FILE = 'agent-skill.json';
/** 分类表。**不放 skills/ 里** —— 那边要保持「一个目录就是一个技能」，
 *  它跟 frame.db 一起躺数据目录。 */
const CAT_FILE = 'skill-categories.json';
/** 一个技能最多几个标签 / 分类名最长多少 / 分类表最多几条。 */
const TAG_MAX = 12;
const NAME_MAX = 24;
const CAT_MAX = 60;
/** 技能显示名最长多少。只是界面上显示用的，跟目录名（slug）无关。 */
const TITLE_MAX = 60;

/** slug 只允许这些字符：它会被拼进路径，不能让 `../` 这种东西混进来。 */
const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** 早期那两个分组目录，见 `migrateLegacy()`。 */
const LEGACY_SCOPES = ['official', 'mine'];

export function skillsRoot(): string {
  return path.join(runtimePaths().dataDir, 'skills');
}

/** slug → 目录。非法就抛 —— 宁可报错，也不能让路径走出 skills 根目录。 */
export function skillDir(slug: string): string {
  if (!SLUG_RE.test(slug)) throw new Error(`技能标识不合法：${slug}`);
  const dir = path.join(skillsRoot(), slug);
  const root = path.resolve(skillsRoot());
  if (!path.resolve(dir).startsWith(root + path.sep)) throw new Error('技能路径越界了。');
  return dir;
}

function readJson(file: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
/* ---------------- 分类（2026-09-25 徐先：技能要能自己归类、自己建分类） ----------------
 *
 * 分类只有**名字**，没有 id、没有层级 —— 它唯一的用处是「把技能分成几堆来看」，
 * 做成树只会让人先纠结该放哪一层。名字就是主键：改名要把技能上的标签一起换掉。
 */

function writeJson(file: string, value: Record<string, unknown>) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/** 分类名 / 标签名：去首尾空白、压掉中间连续空白、限长。返回空串＝这个名字不能用。 */
function cleanName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX);
}

/** 一组标签：只留能用的，去重，限个数。**不写盘**，纯清洗。 */
function normalizeTags(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const item of raw) {
    const name = cleanName(item);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, TAG_MAX);
}

function categoriesFile(): string {
  return path.join(runtimePaths().dataDir, CAT_FILE);
}

/** 分类表。文件不存在 / 坏了就是「还没有分类」—— 列表页还得照常开，别抛。 */
export function listCategories(): string[] {
  let raw: unknown = null;
  try {
    raw = JSON.parse(fs.readFileSync(categoriesFile(), 'utf8')) as unknown;
  } catch {
    return [];
  }
  const arr = Array.isArray(raw) ? raw : [];
  const out: string[] = [];
  for (const item of arr) {
    const name = cleanName(item);
    if (name && !out.includes(name)) out.push(name);
  }
  return out.slice(0, CAT_MAX);
}

function saveCategories(list: string[]): string[] {
  const out: string[] = [];
  for (const item of list) {
    const name = cleanName(item);
    if (name && !out.includes(name)) out.push(name);
  }
  const kept = out.slice(0, CAT_MAX);
  fs.mkdirSync(path.dirname(categoriesFile()), { recursive: true });
  fs.writeFileSync(categoriesFile(), `${JSON.stringify(kept, null, 2)}\n`, 'utf8');
  return kept;
}

/** 数据目录里现有的技能 slug（改名 / 删分类时要逐个改它们的 skill.json）。 */
function allSlugs(): string[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(skillsRoot(), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter(entry => entry.isDirectory() && SLUG_RE.test(entry.name)).map(entry => entry.name);
}

/** 把某个技能上的标签整组换成 `next()` 算出来的那组，别的字段一个字节都不动。 */
function retag(slug: string, next: (tags: string[]) => string[]) {
  const dir = skillDir(slug);
  if (!fs.existsSync(path.join(dir, SKILL_FILE))) return;
  const own = readJson(path.join(dir, META_FILE));
  own.tags = next(normalizeTags(own.tags));
  writeJson(path.join(dir, META_FILE), own);
}

export function addCategory(name: string): string[] {
  const clean = cleanName(name);
  if (!clean) throw new Error('分类名不能是空的。');
  const list = listCategories();
  if (!list.includes(clean)) list.push(clean);
  return saveCategories(list);
}

/**
 * 改名：**已经打在技能上的那个标签也要跟着换** —— 只改表不换标签的话，
 * 那些技能会一夜之间掉回「未分类」，用户还以为是数据丢了。
 */
export function renameCategory(from: string, to: string): string[] {
  const oldName = cleanName(from);
  const newName = cleanName(to);
  if (!oldName || !newName) throw new Error('分类名不能是空的。');
  const list = listCategories();
  if (!list.includes(oldName)) throw new Error('这个分类已经不在了。');
  if (oldName !== newName && list.includes(newName)) throw new Error('已经有同名的分类了。');
  saveCategories(list.map(item => (item === oldName ? newName : item)));
  if (oldName !== newName) {
    for (const slug of allSlugs()) retag(slug, tags => tags.map(tag => (tag === oldName ? newName : tag)));
  }
  return listCategories();
}

/** 删分类：从表里去掉，并且从每个技能上把这个标签摘掉（不然它会留在卡片上下不来）。 */
export function removeCategory(name: string): string[] {
  const clean = cleanName(name);
  const kept = saveCategories(listCategories().filter(item => item !== clean));
  for (const slug of allSlugs()) retag(slug, tags => tags.filter(tag => tag !== clean));
  return kept;
}

/** 界面上要列的分类：分类表 ∪ 技能上已经打着的标签（表被手删了也不至于把标签丢了）。 */
function categoriesInUse(): string[] {
  const out = listCategories();
  for (const slug of allSlugs()) {
    const own = readJson(path.join(skillDir(slug), META_FILE));
    for (const tag of normalizeTags(own.tags)) {
      if (!out.includes(tag)) out.push(tag);
    }
  }
  return out.slice(0, CAT_MAX);
}


/**
 * 拆 SKILL.md 的 YAML frontmatter。
 *
 * 只认最前面那一段 `---`，而且**只取 name / description 两个键** ——
 * 真去解析 YAML 要引依赖，而这两个字段从来不会写成嵌套结构。
 */
function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const trimmed = text.replace(/^﻿/, '');
  if (!trimmed.startsWith('---')) return { meta, body: text };
  const end = trimmed.indexOf('\n---', 3);
  if (end < 0) return { meta, body: text };
  const head = trimmed.slice(3, end);
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '');
  for (const line of head.split(/\r?\n/)) {
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.+)$/.exec(line.trim());
    if (m) meta[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body };
}

/** 正文第一行能读的话就拿来当简介（去掉 `#` 和多余空白）。 */
function firstLine(body: string): string {
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.replace(/^[#>\s*-]+/, '').trim();
    if (line.length >= 6) return line.slice(0, 200);
  }
  return '';
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (base: string, rel: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = path.join(base, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(child, childRel);
        continue;
      }
      if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

function toView(slug: string, dir: string): SkillView | null {
  const skillPath = path.join(dir, SKILL_FILE);
  if (!fs.existsSync(skillPath)) return null;
  let stat: fs.Stats | null = null;
  try {
    stat = fs.statSync(dir);
  } catch {
    stat = null;
  }
  const raw = fs.readFileSync(skillPath, 'utf8');
  const { meta, body } = splitFrontmatter(raw);
  const own = readJson(path.join(dir, META_FILE));
  const agent = readJson(path.join(dir, AGENT_FILE));
  const references = Array.isArray(agent.instructionReferences)
    ? agent.instructionReferences.filter((item): item is string => typeof item === 'string')
    : [];
  const usage: SkillUsage = own.usage === 'edit' ? 'edit' : 'use';
  return {
    id: slug,
    slug,
    title: String(own.title ?? meta.name ?? slug),
    description: String(meta.description ?? own.note ?? firstLine(body) ?? '').slice(0, 400),
    usage,
    optimize: own.optimize === true,
    tags: normalizeTags(own.tags),
    dir,
    files: collectFiles(dir),
    references,
    updatedAt: stat ? Math.round(stat.mtimeMs) : 0,
  };
}

/**
 * 包内那份内置技能在哪。
 *
 * 两种布局都试：`files` 打进 asar 时是 `<appDir>/builtin-skills`，
 * 走 extraResources 时落在 `<appDir>/../builtin-skills`。哪个存在用哪个。
 */
function builtinSource(): string | null {
  const appDir = runtimePaths().appDir;
  for (const candidate of [path.join(appDir, 'builtin-skills'), path.join(appDir, '..', 'builtin-skills')]) {
    try {
      if (fs.existsSync(path.join(candidate, 'closed-drama', SKILL_FILE))) return candidate;
    } catch {
      /* 继续试下一个 */
    }
  }
  return null;
}

function copyDir(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else if (TEXT_EXT.has(path.extname(entry.name).toLowerCase())) fs.copyFileSync(from, to);
  }
}

/**
 * 把包内的内置技能复制进数据目录（**跟用户自己的技能放在同一层**）。
 *
 * **`overwrite=false`（补缺）是默认值**：只复制数据目录里还没有的那些。
 * 用户要是改过某个内置技能的正文，一次升级不该把他的改动冲掉。
 * 「恢复内置」那种场景才传 `overwrite=true`。
 */
export function seedBuiltin(overwrite = false): { seeded: string[]; source: string | null } {
  const source = builtinSource();
  if (!source) return { seeded: [], source: null };
  const root = skillsRoot();
  const seeded: string[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isDirectory() || !SLUG_RE.test(entry.name)) continue;
    if (LEGACY_SCOPES.includes(entry.name)) continue;
    const dst = path.join(root, entry.name);
    if (!overwrite && fs.existsSync(path.join(dst, SKILL_FILE))) continue;
    copyDir(path.join(source, entry.name), dst);
    seeded.push(entry.name);
  }
  return { seeded, source };
}

/**
 * 老版本留下来的 `skills/official/` 和 `skills/mine/` 两个子目录搬平。
 *
 * 分组取消之后那两层就是孤儿目录 —— 不搬的话，**用户以前导入的技能会凭空消失**。
 * 自己导入的那份（mine）逐个 rename 到根上；官方那份是包内副本，搬完直接丢，
 * 反正 `seedBuiltin()` 会重新种一份。
 */
function migrateLegacy() {
  const root = skillsRoot();
  for (const legacy of LEGACY_SCOPES) {
    const base = path.join(root, legacy);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch {
      continue; /* 不存在（绝大多数情况）：直接跳过 */
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SLUG_RE.test(entry.name)) continue;
      const to = path.join(root, entry.name);
      if (fs.existsSync(to)) continue;
      try {
        fs.renameSync(path.join(base, entry.name), to);
      } catch {
        /* 跨盘或被占用就放弃这一个，下次启动再试 */
      }
    }
    try {
      /* 只在搬空了的时候删 —— 还有剩的说明上面有没搬成的，留着下一轮再试。 */
      if (!fs.readdirSync(base).length) fs.rmSync(base, { recursive: true, force: true });
    } catch {
      /* 删不掉无所谓，它已经不在列表里了 */
    }
  }
}

/** 一个技能都没有时补一次内置。每次列表都调它，成本可以忽略（几个 existsSync）。 */
function ensureSeeded() {
  migrateLegacy();
  const root = skillsRoot();
  let has = false;
  try {
    has = fs.existsSync(root) && fs.readdirSync(root, { withFileTypes: true })
      .some(entry => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, SKILL_FILE)));
  } catch {
    has = false;
  }
  if (!has) seedBuiltin(false);
}

export function listSkills(): {
  skills: SkillView[];
  /** 已经建好的分类（∪ 技能上正打着的标签）。 */
  categories: string[];
  root: string;
  builtin: string | null;
} {
  ensureSeeded();
  const root = skillsRoot();
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    entries = [];
  }
  const out: SkillView[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !SLUG_RE.test(entry.name)) continue;
    const view = toView(entry.name, path.join(root, entry.name));
    if (view) out.push(view);
  }
  return {
    skills: out.sort((a, b) => a.title.localeCompare(b.title, 'zh')),
    categories: categoriesInUse(),
    root,
    builtin: builtinSource(),
  };
}

/** 读一个技能。找不到返回 null（前端按「没了」处理，别抛）。 */
export function readSkill(slug: string): SkillView | null {
  const dir = skillDir(slug);
  return fs.existsSync(path.join(dir, SKILL_FILE)) ? toView(slug, dir) : null;
}

/** 技能正文（去掉 frontmatter）。给「优化提示词」当写作规范用。 */
export function readSkillBody(slug: string): string {
  const dir = skillDir(slug);
  const raw = fs.readFileSync(path.join(dir, SKILL_FILE), 'utf8');
  return splitFrontmatter(raw).body.trim();
}

export type SkillFile = { path: string; content: string };

/**
 * 导入一个技能。
 *
 * `files` 至少要有 SKILL.md；没有的话用标题+简介现生成一个 ——
 * 用户从「新建」那个入口进来时只有一段正文，不该因为缺文件就导入失败。
 */
export function importSkill(input: { title: string; note?: string; usage?: SkillUsage; files: SkillFile[] }): SkillView {
  const title = String(input.title ?? '').trim();
  if (!title) throw new Error('先给这个技能起个名字。');
  const slug = slugify(title);
  const dir = skillDir(slug);
  fs.mkdirSync(dir, { recursive: true });
  const wanted = input.files.filter(file => Boolean(file?.path) && typeof file.content === 'string');
  let wrote = 0;
  for (const file of wanted) {
    const rel = normalizeRel(file.path);
    if (!rel) continue;
    const target = path.join(dir, rel);
    if (!path.resolve(target).startsWith(path.resolve(dir) + path.sep)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
    wrote += 1;
  }
  if (wrote === 0) {
    const note = String(input.note ?? '').trim();
    fs.writeFileSync(
      path.join(dir, SKILL_FILE),
      `---\nname: ${slug}\ndescription: ${note || title}\n---\n\n# ${title}\n\n${note}\n`,
      'utf8',
    );
  }
  /* 已存在的目录要**接着用它的标记**：重名再导一次不该把用户打好的分类标签冲掉。 */
  const prev = readJson(path.join(dir, META_FILE));
  fs.writeFileSync(
    path.join(dir, META_FILE),
    `${JSON.stringify({
      ...prev,
      title,
      note: String(input.note ?? '').trim(),
      usage: input.usage === 'edit' ? 'edit' : 'use',
      optimize: prev.optimize === true,
      tags: normalizeTags(prev.tags),
    }, null, 2)}\n`,
    'utf8',
  );
  const view = toView(slug, dir);
  if (!view) throw new Error('技能写进去了但读不回来，检查一下目录权限。');
  return view;
}

/**
 * 改名 / 改标记。一律只动 `skill.json`，正文一个字节都不碰。
 *
 * ⚠️ `title` 只是**界面上显示的名字**（`toView()` 里 `skill.json.title` 优先于 frontmatter 的 `name`）：
 * 改它不会动目录名（slug = id，画布节点上记着它），也不会去改 `SKILL.md` 的 frontmatter ——
 * 那个 `name` 是给 Agent 认的英文 id，动了技能就失灵。
 */
export function setSkillFlags(
  slug: string,
  patch: { title?: string; usage?: SkillUsage; optimize?: boolean; tags?: string[] },
): SkillView {
  const dir = skillDir(slug);
  if (!fs.existsSync(path.join(dir, SKILL_FILE))) throw new Error('这个技能已经不在了。');
  const own = readJson(path.join(dir, META_FILE));
  if (typeof patch.title === 'string') {
    /* 换行一律压成空格：名字是一行显示的，塞个回车进去界面会裂。 */
    const title = patch.title.replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('名字不能是空的。');
    own.title = title.slice(0, TITLE_MAX);
  }
  if (patch.usage === 'use' || patch.usage === 'edit') own.usage = patch.usage;
  if (typeof patch.optimize === 'boolean') own.optimize = patch.optimize;
  if (Array.isArray(patch.tags)) {
    const tags = normalizeTags(patch.tags);
    own.tags = tags;
    /* 打标签时**顺手把没见过的名字建成分类**（徐先要的「既能维护也能随手加」）——
       不然界面上会出现「技能上有这个标签，分类条里却没有」的怪状态。 */
    const known = listCategories();
    const missing = tags.filter(tag => !known.includes(tag));
    if (missing.length) saveCategories([...known, ...missing]);
  }
  fs.writeFileSync(path.join(dir, META_FILE), `${JSON.stringify(own, null, 2)}\n`, 'utf8');
  return toView(slug, dir) as SkillView;
}

/** 删。内置技能也照删 —— 想找回来用 `/api/skills/reset`。 */
export function deleteSkill(slug: string): boolean {
  const dir = skillDir(slug);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/**
 * 名字 → slug。
 *
 * 中文标题直接当目录名在 Windows 上也能用，但跨盘复制、进 zip、给 Codex 拼路径时
 * 迟早会遇上编码问题；这里统一退化成拼音不行（没依赖），就取「保留的 ASCII 部分 + 序号」，
 * 实在一个都没有就用时间戳。目录名不重要，真正显示的是 skill.json 里的 title。
 */
function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (ascii) return ascii;
  return `skill-${Date.now().toString(36)}`;
}

/** 导入进来的相对路径：去掉盘符/前导斜杠/`..`，只留目录层级。 */
function normalizeRel(value: string): string {
  const raw = String(value ?? '').replace(/\\/g, '/').replace(/^[A-Za-z]:/, '');
  const parts = raw.split('/').filter(part => part && part !== '.' && part !== '..');
  if (!parts.length) return '';
  const name = parts[parts.length - 1];
  if (!TEXT_EXT.has(path.extname(name).toLowerCase())) return '';
  return parts.join('/').slice(0, 200);
}
