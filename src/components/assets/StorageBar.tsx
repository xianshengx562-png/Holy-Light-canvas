'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader, Trash2 } from 'lucide-react';

/*
 * 不从 `@/lib/assets` 引类型（那个模块标了 `server-only`），字段在这里重述一遍。
 * 体积已经是服务端格式化好的字符串，客户端不要再算一次。
 */
export type StorageSummary = {
  /** 库里有记录、磁盘上文件已经没了（手动删过 storage/、或落盘中途失败）。 */
  missing: number;
  /** 磁盘上有文件、库里已经没有对应记录。 */
  orphans: number;
  orphanLabel: string;
  orphanRecent: number;
  /*
   * 🔴 2026-10-01：「落盘占用 X」与「全部 N 项：图片 … / 视频 …」那两行常态统计
   * **不再显示**（徐先：「这个选项卡隐藏」），所以 `diskLabel` / `total` / `counts`
   * 三个字段连同服务端那头的计算一起删了（见 `lib/assets.ts` 的 `StorageOverview`）。
   * 别因为「看着有用」再加回来：常态统计不该常驻，而总项数页头已经写着「N 项」了。
   */
};

/**
 * 落盘占用那一条。
 *
 * 「孤儿文件」（磁盘上有、库里没有）以前只能报个数字，用户看着它一直涨却无从下手，
 * 所以这里配一个清理入口。删除不可逆 → 沿用资产删除那套「先点一下、再确认一下」两步，
 * 不做一步到位的红按钮。
 */
export default function StorageBar({ storage }: { storage: StorageSummary }) {
  const router = useRouter();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');

  const clean = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/assets/orphans', { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(String(body.error || '清理失败。'));
        setArmed(false);
        return;
      }
      const bits = [`清掉 ${body.removed} 个文件，释放 ${body.sizeLabel}`];
      // 这两个数不说明白，用户会以为「点了没生效」
      if (body.failed) bits.push(`${body.failed} 个没删掉`);
      if (body.recent) bits.push(`刚写入的 ${body.recent} 个先留着`);
      setNote(bits.join(' · '));
      setArmed(false);
      router.refresh();
    } catch {
      setError('网络异常，稍后再试。');
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  /*
   * 🔴 2026-10-01 徐先：「这个选项卡隐藏」—— 原来常驻的那两行（落盘占用 / 全部 N 项）删掉。
   * 判据沿用第七轮（工具 · 视频拼接那条 FFmpeg 状态栏）：
   * **状态栏的意义是告诉人「哪里不对」；一切正常是常态，常态不该占一整行版面。**
   *
   * ⚠️ 这一条**不是永远不显示**：下面这两种「账对不上」不主动扫就永远发现不了，
   * 所以 missing / orphans 有值时整条照旧出现 —— 那一刻它正好是唯一能修的地方
   * （「清理」按钮就在里面）。`note` / `error` 也一起兜着：清理完那条反馈
   * 要是跟着整条消失，用户会以为「点了没生效」。
   */
  if (!storage.missing && !storage.orphans && !note && !error) return null;

  return (
    <div className="assets-storage">
      {/* 这两种「账对不上」的情况不主动扫就永远发现不了，所以放在明面上 */}
      {storage.missing > 0 && (
        <span className="error">{storage.missing} 条记录的文件已不在磁盘上</span>
      )}
      {storage.orphans > 0 && (
        <>
          <span className="notice">
            {storage.orphans} 个文件没有对应记录（约 {storage.orphanLabel}）
          </span>
          {!armed ? (
            <button className="button small" type="button" onClick={() => { setArmed(true); setNote(''); setError(''); }}>
              <Trash2 size={13} strokeWidth={2} aria-hidden /> 清理
            </button>
          ) : (
            <span className="assets-cleanup-actions">
              <button className="button secondary small" type="button" onClick={() => setArmed(false)} disabled={busy}>
                取消
              </button>
              <button className="button danger small" type="button" onClick={clean} disabled={busy}>
                {busy
                  ? <Loader size={13} strokeWidth={2} className="asset-spin" aria-hidden />
                  : <Trash2 size={13} strokeWidth={2} aria-hidden />}
                确认清理
              </button>
            </span>
          )}
        </>
      )}
      {note && <span className="muted">{note}</span>}
      {error && <span className="error" role="alert">{error}</span>}
    </div>
  );
}
