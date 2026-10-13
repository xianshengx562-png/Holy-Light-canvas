/**
 * 原生插件 `RawHttp` 的 JS 封装（安卓端实现在
 * `android/app/src/main/java/cn/holylight/canvas/RawHttpPlugin.java`）。
 *
 * 为什么需要：这台 ColorOS 上 CapacitorHttp（HttpURLConnection）全被系统代理路径拦死，
 * 而裸 socket（Proxy.NO_PROXY 的 OkHttp 等价）实测能通 —— 所以原生请求**优先**走它。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

type RawHttpPlugin = {
  request(options: {
    url: string;
    method?: string;
    headers?: Record<string, string>;
    body?: string | null;
    timeoutMs?: number;
  }): Promise<{ status?: number; data?: string; error?: string }>;
};

const plugin = Capacitor.isNativePlatform()
  ? registerPlugin<RawHttpPlugin>('RawHttp', { web: undefined })
  : null;

export type RawOutcome = { status: number; text: string } | { error: string };

export async function rawRequest(options: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | null;
  timeoutMs?: number;
}): Promise<RawOutcome> {
  if (!plugin) return { error: 'raw-http-unavailable' };
  try {
    const result = await plugin.request(options);
    if (typeof result.status === 'number' && typeof result.data === 'string') {
      return { status: result.status, text: result.data };
    }
    return { error: result.error || 'raw-http-failed' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
