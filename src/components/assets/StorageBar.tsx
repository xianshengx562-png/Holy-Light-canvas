'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader, Trash2 } from 'lucide-react';

/*
 * 不从 `@/lib/assets` 引类型（那个模块标了 `server-only`），字段在这里重述一遍。
 * 体积已经是服务端格式化好的字符串，客户端不要再算一次。
 */
export type StorageSummary = {
  diskLabel: string;
  total: number;
  counts: { video: number; image: number; audio: number; latent: number };
  missing: number;
  orphans: number;
  orphanLabel: string;
  orphanRecent: number;
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

  return (
    <div className="assets-storage">
      <span><b>落盘占用 {storage.diskLabel}</b></span>
      <span className="muted">
        全部 {storage.total} 项：图片 {storage.counts.image} · 视频 {storage.counts.video} · 音频 {storage.counts.audio} · Latent {storage.counts.latent}
      </span>
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
