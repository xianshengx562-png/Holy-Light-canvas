/**
 * 原生插件 `NetworkFix` 的 JS 封装（安卓端实现在
 * `android/app/src/main/java/cn/holylight/canvas/NetworkFix.java`）。
 *
 * 用途：原生通道全挂时探一次「哪条 socket 通路还活着」。
 */
import { Capacitor, registerPlugin } from '@capacitor/core';

type ProbeResult = {
  raw: string;
  unbound: string;
  bound: string[];
  best: string;
};

const plugin = Capacitor.isNativePlatform()
  ? registerPlugin<{ probe(): Promise<ProbeResult> }>('NetworkFix')
  : null;

/** 跑一次通路探测，把每条路的结果原样带回来（CDP / 设置页都能看）。 */
export async function probePaths(): Promise<ProbeResult | null> {
  if (!plugin) return null;
  try {
    const result = await plugin.probe();
    console.error('[hl-netprobe] ' + JSON.stringify(result));
    return result;
  } catch {
    return null;
  }
}
