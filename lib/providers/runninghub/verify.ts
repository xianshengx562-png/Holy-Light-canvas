import 'server-only';
import { queryTask } from '@/lib/providers/runninghub/client';
import { markConnectionStatus, resolveRunningHub, type RunningHubSite } from '@/lib/providers/runninghub/connection';
import { markKeyChecked } from '@/lib/providers/keys';

export type ConnectionCheck = { ok: boolean; message: string };

/**
 * Probes with a non-existent task id: taskId 0 is rejected by parameter validation
 * before authentication, so any non-zero id is required to actually exercise the key.
 * Valid keys answer 1004 (task not found); invalid ones answer 806 (APIKEY_USER_NOT_FOUND).
 */
const probeTaskId = '999999999';
const authErrorCodes = new Set(['805', '806', '807', '2001']);

/**
 * 探活一次连接。
 *
 * ⚠️ 2026-09-21 起要**带站**：两个站的 Key 互不通用，不传 baseUrl 的话海外站的 Key
 * 会拿去打国内站，结果必然是「Key 无效」—— 而用户的 Key 其实是对的。
 * 这种「指错了方向的否定结论」比不探活更糟，因为它会让人去换一把没问题的 Key。
 *
 * 回填状态的地方也分两路：国内站是历史单把连接（`RunningHubConnection`），
 * 海外站走的是密钥池（`ProviderKey`），两边记的不是同一张表。
 */
export async function verifyConnection(userId: string, site?: RunningHubSite): Promise<ConnectionCheck> {
  const resolved = await resolveRunningHub(userId, site);
  if (!resolved.apiKey) return { ok: false, message: resolved.message || '尚未配置 API Key。' };
  let check: ConnectionCheck;
  try {
    const result = await queryTask(probeTaskId, resolved.apiKey, resolved.baseUrl);
    const code = result.errorCode ? String(result.errorCode) : '';
    if (!code) check = { ok: true, message: 'API Key 有效，RunningHub 连接正常。' };
    else if (code === '1004') check = { ok: true, message: 'API Key 有效，RunningHub 连接正常（探测任务不存在属预期结果）。' };
    else if (authErrorCodes.has(code)) check = { ok: false, message: 'API Key 无效或已失效，请重新填写。' };
    else check = { ok: false, message: `连接失败（${code}）：${result.errorMessage || '未知错误。'}` };
  } catch (error) {
    check = { ok: false, message: error instanceof Error ? `连接失败：${error.message}` : '连接失败。' };
  }
  if (resolved.site === 'ai') {
    if (resolved.keyId) await markKeyChecked(resolved.keyId, check.ok, check.message);
  } else {
    await markConnectionStatus(userId, check.ok ? 'verified' : 'failed');
  }
  return check;
}
