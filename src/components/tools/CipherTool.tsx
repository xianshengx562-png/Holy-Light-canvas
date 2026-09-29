'use client';

/*
 * 图片加密 / 解密。
 *
 * ⚠️ 入口叫「加密」，但做的其实是**视觉置乱**（算法见 `src/lib/scramble.ts` 文件头第 1 条）：
 * 产物仍然是一张正常能打开的 PNG，只是画面按密码搬乱了。它能挡住「随手点开看一眼」，
 * 挡不住懂行的人拿去还原 —— 所以这一页**必须**把这句话写在明面上，不能让人拿它当保险箱。
 *
 * 三条界面上的硬规矩：
 *
 * 1. **密码不落盘、不进任何请求。** 只活在这一页的 state 里，刷新就没了。
 *    存下来等于把钥匙贴在锁上 —— 置乱本来就只防随手一眼，再把密码一起存了就什么都不剩。
 * 2. **加密产物不入库。** 打乱后的图在资产库里就是一堆噪点缩略图，只会把资产列表搅乱，
 *    所以加密那一档只给「下载」；解密还原出来的原图才走 `ToolResult` 的入库流程。
 * 3. **格式锁死 PNG。** 置乱是「差一个字节就还原不回来」的运算，JPEG 有损压缩会直接毁掉它。
 *    这里干脆不给格式选择器 —— 让用户能选，就等于给了他一个「做完发现废了」的按钮。
 *
 * 解密侧的两个兜底（都不需要用户回忆自己当时选了什么）：
 *  - 强度档写在 PNG 的 `tEXt` 块里，读不到再按文件名猜，还猜不出就三档各还原一次、
 *    挑画面最「像照片」的那档（`guessLevel`）。
 *  - 还原完如果画面**还是噪点**，说明密码不对 —— 直接提示，而不是让用户自己盯着眼看。
 */
import { useState } from 'react';
import { KeyRound, Loader2, Lock, LockOpen } from 'lucide-react';
import ToolShell from '@/components/tools/ToolShell';
import ToolResult, { type ToolOutput } from '@/components/tools/ToolResult';
import { baseName, formatBytes } from '@/lib/image-tools';
import {
  META_KEY,
  SCRAMBLE_LEVELS,
  deriveSeed,
  fileToPixels,
  guessLevel,
  levelConfig,
  levelFromName,
  pixelsToPngBlob,
  readPngText,
  roughness,
  scramblePixels,
  unscramblePixels,
  type ScrambleLevel,
} from '@/lib/scramble';

/** 一次批量上限：和格式转换对齐 —— 这里每张图都要走一遍纯 JS 逐像素运算。 */
const MAX_FILES = 60;

/**
 * 「还原出来还是噪点」的阈值。
 *
 * `roughness` 是相邻采样点的平均色差：照片通常是个位数到几十，纯噪点在 200 往上
 * （两个均匀随机值的平均差约 85 × 3 通道）。取 90 留足余量 —— 阈值松一点只会漏报，
 * 紧一点会把「细节很碎的照片」误判成密码错误，后者烦人得多。
 */
const NOISE_ROUGHNESS = 90;

type Mode = 'lock' | 'unlock';
/** 解密侧多一个 `auto`：让用户不用回忆自己当初选的哪一档。 */
type UnlockLevel = ScrambleLevel | 'auto';

type Picked = { key: string; file: File };

/** 读我们自己写进 PNG 文本块的强度档。读到别的（或压根不是 PNG）就当没有。 */
async function readMeta(file: File): Promise<ScrambleLevel | null> {
  try {
    const value = readPngText(new Uint8Array(await file.arrayBuffer()), META_KEY);
    return value === 'light' || value === 'medium' || value === 'strong' ? value : null;
  } catch {
    return null;
  }
}

/** 把 `xxx_已加密_medium` 剥回 `xxx`：来回倒腾几次不该让名字越来越长。 */
function stemOf(name: string): string {
  return baseName(name)
    .replace(/_已加密(?:[_-](?:light|medium|strong))?$/i, '')
    .replace(/_已解密$/i, '')
    .replace(/[_-](light|medium|strong)$/i, '');
}

export default function CipherTool() {
  const [mode, setMode] = useState<Mode>('lock');
  const [picked, setPicked] = useState<Picked[]>([]);
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [level, setLevel] = useState<ScrambleLevel>('medium');
  const [unlockLevel, setUnlockLevel] = useState<UnlockLevel>('auto');
  const [outputs, setOutputs] = useState<ToolOutput[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  /* 列表里的 File 只是引用，不吃内存；key 带上序号，同名文件不会互相顶掉。 */
  const add = (files: FileList | null) => {
    if (!files?.length) return;
    const list = Array.from(files);
    const rest = Math.max(0, MAX_FILES - picked.length);
    setPicked((prev) => [
      ...prev,
      ...list.slice(0, rest).map((file, index) => ({ key: `${prev.length}-${index}-${file.name}`, file })),
    ]);
    setOutputs([]);
    setError(list.length > rest ? `最多 ${MAX_FILES} 张，多出来的没加进来。` : null);
  };

  async function run() {
    if (!picked.length) return;
    if (!password) {
      setError('先填密码：加密和解密必须用同一个。密码不会保存，忘了就恢复不回来。');
      return;
    }
    setBusy(true);
    setError(null);
    setProgress({ done: 0, total: picked.length });
    /* 密码只在开头折一次种子 —— 后面每张图都用它，保证同一批产出互相能对上。 */
    const seed = await deriveSeed(password);
    const results: ToolOutput[] = [];
    let noisy = 0;
    try {
      for (const [index, item] of picked.entries()) {
        const { pixels, width, height } = await fileToPixels(item.file);
        let used: ScrambleLevel;
        let guessed = false;
        if (mode === 'lock') {
          used = level;
        } else if (unlockLevel !== 'auto') {
          used = unlockLevel;
        } else {
          /* 三级兜底：写进图里的 → 文件名 → 三档各还原一次挑最像照片的。 */
          const found = await readMeta(item.file);
          if (found) {
            used = found;
          } else {
            used = levelFromName(item.file.name) ?? guessLevel(pixels, width, height, seed);
            guessed = true;
          }
        }
        const out =
          mode === 'lock'
            ? scramblePixels(pixels, width, height, seed, used)
            : unscramblePixels(pixels, width, height, seed, used);

        /* 解密才判「还是噪点」：加密出来的本来就该是噪点。 */
        if (mode === 'unlock' && roughness(out, width, height) > NOISE_ROUGHNESS) noisy += 1;

        const stem = stemOf(item.file.name);
        const name = mode === 'lock' ? `${stem}_已加密_${used}.png` : `${stem}_已解密.png`;
        const blob = await pixelsToPngBlob(out, width, height, mode === 'lock' ? used : undefined);
        results.push({
          key: `${item.key}->${name}`,
          name,
          blob,
          note: `${width}×${height} · ${levelConfig(used).label}${guessed ? '（自动判定）' : ''} · ${formatBytes(blob.size)}`,
        });
        setProgress({ done: index + 1, total: picked.length });
      }
      setOutputs(results);
      if (noisy) {
        setError(`有 ${noisy} 张还原出来还是噪点 —— 密码多半不对，或者强度档选错了。`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '处理失败。');
      setOutputs([]);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  const totalIn = picked.reduce((sum, item) => sum + item.file.size, 0);

  return (
    <ToolShell
      active="cipher"
      eyebrow="IMAGE CIPHER"
      title="图片加解密"
      intro="用密码把画面打乱成看不懂的样子，同一个密码能原样还原"
      tabs={
        <nav className="settings-tabs tool-tabs" aria-label="工具模式">
          <button className={mode === 'lock' ? 'active' : undefined} type="button" data-tool-mode="lock" onClick={() => setMode('lock')}>
            <Lock size={14} aria-hidden /> 加密
          </button>
          <button className={mode === 'unlock' ? 'active' : undefined} type="button" data-tool-mode="unlock" onClick={() => setMode('unlock')}>
            <LockOpen size={14} aria-hidden /> 解密
          </button>
        </nav>
      }
    >
      <section className="tool-panel">
        <div className="tool-pane">
          <label className="tool-drop">
            <input
              type="file"
              accept="image/png,image/*"
              multiple
              data-tool-input="cipher-files"
              onChange={(event) => add(event.target.files)}
            />
            <span className="tool-drop-icon">
              <KeyRound size={22} strokeWidth={1.4} aria-hidden />
            </span>
            <strong>{picked.length ? `已选 ${picked.length} 张图` : mode === 'lock' ? '选一批要加密的图' : '选一批要解密的图'}</strong>
            <small className="muted">可以多选 · 最多 {MAX_FILES} 张 · 原图不会被改动</small>
          </label>

          {picked.length > 0 && (
            <ul className="tool-filelist">
              {picked.map((item) => (
                <li key={item.key}>
                  <span>{item.file.name}</span>
                  <small className="muted">{formatBytes(item.file.size)}</small>
                  <button className="text-link" type="button" onClick={() => setPicked((prev) => prev.filter((row) => row.key !== item.key))}>
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {totalIn > 0 && <p className="tool-meta">合计 {formatBytes(totalIn)}</p>}
        </div>

        <div className="tool-pane">
          <label className="field">
            <span>密码</span>
            <input
              type={reveal ? 'text' : 'password'}
              value={password}
              placeholder="加密和解密要用同一个"
              data-tool-input="password"
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="tool-result-actions">
            <button className="assets-chip" type="button" data-tool-run="reveal" onClick={() => setReveal(!reveal)}>
              {reveal ? '藏起来' : '显示密码'}
            </button>
          </div>

          {mode === 'lock' ? (
            <>
              <div className="field">
                <span>强度</span>
                <div className="assets-chips">
                  {SCRAMBLE_LEVELS.map((item) => (
                    <button
                      key={item.id}
                      className={`assets-chip${level === item.id ? ' active' : ''}`}
                      type="button"
                      data-tool-level={item.id}
                      onClick={() => setLevel(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="tool-hint">{levelConfig(level).hint}</p>
              <p className="tool-hint">
                产物是 <strong>PNG</strong>（有损格式会让还原差一个字节就废掉），强度档会写进图里 —— 解密时不用再回忆选的哪一档。
              </p>
            </>
          ) : (
            <>
              <div className="field">
                <span>强度</span>
                <div className="assets-chips">
                  <button
                    className={`assets-chip${unlockLevel === 'auto' ? ' active' : ''}`}
                    type="button"
                    data-tool-unlock-level="auto"
                    onClick={() => setUnlockLevel('auto')}
                  >
                    自动
                  </button>
                  {SCRAMBLE_LEVELS.map((item) => (
                    <button
                      key={item.id}
                      className={`assets-chip${unlockLevel === item.id ? ' active' : ''}`}
                      type="button"
                      data-tool-unlock-level={item.id}
                      onClick={() => setUnlockLevel(item.id)}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="tool-hint">
                默认「自动」：先读图里记的强度档，读不到就按文件名猜，还猜不出就三档各还原一次挑最像照片的那档（会慢一点）。
              </p>
            </>
          )}

          <p className="tool-hint">
            这是<strong>视觉置乱</strong>，不是文件加密：图仍然能打开，只是画面被打乱了。防的是随手点开看一眼，不是防专业还原。
          </p>

          {progress && (
            <div className="tool-progress" data-tool-progress={`${progress.done}/${progress.total}`}>
              <i style={{ width: `${(progress.done / progress.total) * 100}%` }} />
            </div>
          )}

          {error && <p className="error">{error}</p>}

          <button className="button" type="button" disabled={!picked.length || busy} onClick={run} data-tool-run="cipher">
            {busy ? <Loader2 className="asset-spin" size={14} aria-hidden /> : mode === 'lock' ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />}
            {busy ? '正在处理…' : mode === 'lock' ? `加密 ${picked.length} 张` : `解密 ${picked.length} 张`}
          </button>
        </div>
      </section>

      {mode === 'lock' ? (
        <ToolResult
          outputs={outputs}
          emptyHint="还没有产出：左边选图、右边填密码挑强度，点「加密」。加密产物只下载不入库 —— 存进资产库的就是一堆噪点缩略图。"
          allowArchive={false}
          archiveHint="加密产物只给下载：它是一堆噪点，存进资产库只会把列表搅乱。想要留底，解密还原出原图再存。"
          onReset={() => setOutputs([])}
        />
      ) : (
        <ToolResult
          outputs={outputs}
          emptyHint="还没有产出：左边选加密过的 PNG、右边填当时的密码，点「解密」。还原出来的原图可以存进资产库。"
          onReset={() => setOutputs([])}
        />
      )}
    </ToolShell>
  );
}
