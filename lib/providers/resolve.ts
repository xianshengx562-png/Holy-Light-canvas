import 'server-only';
import { pickKey } from './keys';
import { videoApiKey, videoApiBaseUrl } from './videoapi/config';

export type ResolvedCredentials = {
  apiKey: string;
  baseUrl: string;
  /** 用了哪把用户级 key。`null` = 走的是环境变量那把，流水不该记到某把 key 名下。 */
  keyId: string | null;
  source: 'user' | 'env';
};

/**
 * 「这回用哪把 key」的唯一裁判。
 *
 * 顺序是**用户级优先，没有才回落环境变量** —— 反过来写的话，用户在界面上填了半天自己的 key，
 * 结果一直扣站点的额度，这种事最难查。
 *
 * 返回 null 表示一家都没有，调用方要说清楚「该怎么配」，而不是含糊地报一句失败。
 */
async function firstAvailable(
  userId: string,
  provider: 'videoapi',
  fallback: { key: string; url: string },
): Promise<ResolvedCredentials | null> {
  const picked = await pickKey(userId, provider);
  if (picked) {
    return {
      apiKey: picked.apiKey,
      baseUrl: picked.baseUrl || fallback.url,
      keyId: picked.id,
      source: 'user',
    };
  }
  if (!fallback.key) return null;
  return { apiKey: fallback.key, baseUrl: fallback.url, keyId: null, source: 'env' };
}

export function resolveVideoApiCredentials(userId: string) {
  return firstAvailable(userId, 'videoapi', { key: videoApiKey(), url: videoApiBaseUrl() });
}

/** 一家都没有时给用户的原话 —— 别让三家各写一套说法。 */
export function missingCredentialsMessage(label: string, envKeyName: string) {
  return `还没有可用的 ${label} 密钥：到「设置 · 密钥中心」给这个账号添一把，或者让站长在 .env 里配 ${envKeyName}。`;
}
