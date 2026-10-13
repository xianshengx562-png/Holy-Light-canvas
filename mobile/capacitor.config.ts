import type { CapacitorConfig } from '@capacitor/cli';

/**
 * 安卓壳的配置。
 *
 * - `appId` / `appName` 沿用桌面端那套（桌面端 `package.json` 的 build 段是
 *   `cn.holylight.canvas` / `Holy Light画布`），改这个要连带改 `android/app/build.gradle`
 *   里的 applicationId，或者干脆删掉 android/ 重新 `npx cap add android`。
 * - `webDir` 指到 `dist`（Vite 的产物目录），`npx cap sync` 会把它拷进
 *   `android/app/src/main/assets/public`。
 */
const config: CapacitorConfig = {
  appId: 'cn.holylight.canvas',
  appName: 'Holy Light画布',
  webDir: 'dist',
  android: {
    /*
     * 中转站是 https，图床却可能是 http —— 不开这条，`<img>` 会被 WebView 拦掉
     * （表现是「出图成功但图显示为空白」）。
     */
    allowMixedContent: true,
  },
  server: {
    // 中转站是 https，这里不开明文；本地调试要连 http 时再手动打开
    androidScheme: 'https',
  },
};

export default config;
