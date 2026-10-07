'use client';
import { useMemo, useState } from 'react';
import { FolderOpen, Loader2, Trash2, Upload, X } from 'lucide-react';
import { pickFilesPath, pickFolderPath } from '@/lib/desktop-fs';
import {
  importPresetBatch, removePresetGroup, useImportedPresets,
} from '@/lib/importedPresetStore';

/**
 * 导入创作预设（2026-10-07）—— ComfyUI-Easy-Use 那套 `styles/*.json`。
 *
 * 为什么是一个「面板里的面板」而不是独立弹窗：导入只发生在「我正在挑风格、发现没有我要的」
 * 这个上下文里。做成独立弹窗的话，导完还得关掉它再重新开一次预设面板 ——
 * 而那批图有 88 MB，用户要等的时间已经够长了，不该再多两步。
 *
 * 🔴 分类名是**用户填的**，默认 `krea2`。这就是「自定义分组」：
 * 想按来源分开就多导几次、每次填一个名字（「摄影」「插画」…），
 * 面板的分类胶囊会自动多出对应的那一颗。
 * 同名再导一次 = **覆盖**那一组（主进程那边定的语义），不是叠加。
 */

const DEFAULT_CATEGORY = 'krea2';

export default function PresetImportPanel({
  onBack,
  onPicked,
}: {
  /** 回预设列表。 */
  onBack: () => void;
  /** 导入完成后要不要顺手跳到那一组（导完就能看见，不用再找）。 */
  onPicked?: (category: string) => void;
}) {
  const { groups, presets } = useImportedPresets();
  const [category, setCategory] = useState(DEFAULT_CATEGORY);
  const [source, setSource] = useState<{ dir?: string; files?: string[] }>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);

  /** 选了什么 —— 目录优先，其次是文件列表。这一行是给按钮的启用条件用的。 */
  const hasSource = Boolean(source.dir || (source.files || []).length);
  const sourceLabel = source.dir
    ? source.dir
    : (source.files || []).length
      ? `已选 ${(source.files || []).length} 个文件`
      : '';

  /** 每组的实际条数（清单里记的 `count` 和真在 `presets` 里的可能对不上，以实际的为准）。 */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const item of presets) {
      const key = (item as unknown as { group?: string }).group ?? '';
      if (!key) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [presets]);

  async function run() {
    if (!hasSource || busy) return;
    const name = String(category || '').trim() || DEFAULT_CATEGORY;
    setBusy(true);
    setFailed(false);
    /*
     * 🔴 搬 88 MB 预览图要几十秒，这句提示**必须**在这一趟之前就显示出来：
     * IPC 挂着的那段时间界面收不到任何别的响应，不说一句话的话用户只会以为卡死了。
     */
    setMessage('正在导入并复制预览图，条数多的时候要等一会儿…');
    const result = await importPresetBatch({
      dir: source.dir,
      files: source.files,
      category: name,
    });
    setBusy(false);
    setMessage(result.message || (result.ok ? '导入完成。' : '导入没成功。'));
    setFailed(!result.ok);
    if (result.ok) onPicked?.(name);
  }

  async function drop(group: string) {
    if (busy) return;
    setBusy(true);
    const result = await removePresetGroup(group);
    setBusy(false);
    setMessage(result.message);
    setFailed(!result.ok);
  }

  return (
    <div className="cv-cpk-import">
      <div className="cv-cpk-import-head">
        <strong>导入预设</strong>
        <button type="button" className="cv-cpk-import-back" onClick={onBack} disabled={busy}>
          <X size={13} strokeWidth={1.8} aria-hidden />
          返回预设库
        </button>
      </div>

      <div className="cv-cpk-import-body">
        <label className="cv-cpk-import-row">
          <span>归入分类</span>
          <input
            value={category}
            onChange={event => setCategory(event.target.value)}
            placeholder={DEFAULT_CATEGORY}
            disabled={busy}
          />
        </label>
        <p className="cv-cpk-import-hint">
          填什么名字，预设库里就多一颗叫什么的分类胶囊。同名再导一次会**覆盖**那一组。
        </p>

        <div className="cv-cpk-import-row">
          <span>从哪儿导</span>
          <div className="cv-cpk-import-src">
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const dir = await pickFolderPath({ title: '选装着 styles JSON 的目录' });
                if (dir) setSource({ dir });
              }}
            >
              <FolderOpen size={13} strokeWidth={1.8} aria-hidden />
              选目录
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                const files = await pickFilesPath({
                  title: '选 styles JSON（可多选）',
                  filters: [{ name: '预设 JSON', extensions: ['json'] }],
                });
                if (files.length) setSource({ files });
              }}
            >
              <Upload size={13} strokeWidth={1.8} aria-hidden />
              选文件
            </button>
          </div>
        </div>
        {sourceLabel && <p className="cv-cpk-import-path" title={sourceLabel}>{sourceLabel}</p>}

        <button
          type="button"
          className="cv-cpk-import-go"
          disabled={!hasSource || busy}
          onClick={() => void run()}
        >
          {busy
            ? <><Loader2 size={13} strokeWidth={1.8} className="cv-spin" aria-hidden />正在导入…</>
            : <><Upload size={13} strokeWidth={1.8} aria-hidden />开始导入</>}
        </button>

        {message && (
          <p className={`cv-cpk-import-msg${failed ? ' bad' : ''}`}>{message}</p>
        )}

        {groups.length > 0 && (
          <div className="cv-cpk-import-list">
            <strong>已导入的分组</strong>
            {groups.map(group => (
              <div key={group.id} className="cv-cpk-import-item">
                <span className="cv-cpk-import-name">{group.name}</span>
                <span className="cv-cpk-import-count">{counts.get(group.id) ?? group.count} 条</span>
                <button
                  type="button"
                  className="cv-cpk-import-del"
                  disabled={busy}
                  aria-label={`删除分组 ${group.name}`}
                  title="删掉这一组（连预览图一起）"
                  onClick={() => void drop(group.id)}
                >
                  <Trash2 size={12} strokeWidth={1.8} aria-hidden />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
