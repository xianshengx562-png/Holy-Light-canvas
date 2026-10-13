# Holy Light画布 · 安卓端（手机生图）

只做一件事：**在聊天里说一句话 → 调 OpenAI 兼容接口出图 → 保存到相册 / 复制链接**。
没有画布、没有项目、没有本地数据库、没有本地 ComfyUI。

界面是 2026-10-13 改过的**对话式**（参照豆包）：你发一句提示词，它在同一个气泡流里回你一张图，
图下面直接是「保存到相册 / 复制链接」。会话只在内存里，退出即丢（规格 A4：不做历史记录）。

规格正文：`../安卓端-手机生图.md`（那一份是开工依据，改需求先改那边）。

## 跑起来

```bash
npm install
npm run dev        # 浏览器里调试（此时请求走 fetch，不是 CapacitorHttp）
npm run typecheck
npm run smoke      # 逻辑层冒烟：地址兜底 / 取值 / 报错，不花额度不发真请求
npm run cap:sync   # build + 把 dist 拷进 android/
```

安卓工程已经生成好了（`android/`），改完前端跑一次 `npm run cap:sync` 就行。

⚠️ **装依赖时如果 npm 卡住不动**：默认源 `registry.npmjs.org` 在这台机器上慢到 12 秒一次请求。
换成国内镜像：`npm install --registry=https://registry.npmmirror.com`。
镜像还可能在 esbuild 那一步漏掉平台二进制（报 `The package "@esbuild/win32-x64" could not be found`），
补一条 `npm install @esbuild/win32-x64@<版本> --no-save` 即可。

## 出 APK（编译环境已经装好了，2026-10-13）

装在 `C:\Android\`（全是命令行版，没装 Android Studio）：

| 目录 | 内容 |
|---|---|
| `C:\Android\jdk21` | Temurin JDK **21.0.12.1** |
| `C:\Android\jdk17` | JDK 17（留着备用，构建用不上） |
| `C:\Android\sdk` | Android SDK：`platforms;android-35` / `build-tools;35.0.0` / `platform-tools` |
| `C:\Android\gradle-home` | Gradle 缓存（wrapper 8.11.1 + 依赖） |

用户级环境变量已设好：`JAVA_HOME`、`ANDROID_HOME`、`ANDROID_SDK_ROOT`、`GRADLE_USER_HOME`
—— **新开的终端才生效**，旧窗口里要么重开，要么手动 `export`。

```bash
npm run android:run                  # build + sync + 装到手机并打开（最常用）

cd android && ./gradlew assembleDebug # 只出包：app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

⚠️ 三个已经踩过并修掉的坑，别回退：

1. **要 JDK 21，不是 17** —— `@capacitor/filesystem` 那几个插件的编译要求 `languageVersion=21`，
   用 17 会报 `Cannot find a Java installation ... {languageVersion=21}`。
2. **工程路径含中文**（`E:\codex网站开发\本地\studio`）→ `android/gradle.properties` 里加了
   `android.overridePathCheck=true`。删掉它，AGP 会直接拒绝构建。
3. **Gradle 和 Maven 都指到了腾讯镜像**（`gradle-wrapper.properties` 的 `distributionUrl`、
   `android/build.gradle` 的 `repositories`）。国外源在这台机器上慢到分钟级。

调试用 `assembleDebug` 就够了，不用管签名。

## 真机调试（推荐这条路，别用模拟器）

**手机 USB 连电脑省不掉 SDK 和 JDK** —— 编译是在电脑上做的，手机只是「装到哪」。
但它比模拟器省事太多：不用下几 GB 的系统镜像、不用开虚拟化，装一次几秒钟。

1. 手机：设置 → 关于本机 → **连点「版本号」** 开开发者选项 → 打开 **USB 调试**。
2. USB 连上电脑，手机上点「允许这台电脑调试」。
3. `adb devices` 能看到那台机器，就通了。

然后二选一：

```bash
# 打包 + 装到手机 + 自动打开（改一次代码跑一次）
npm run android:run

# 免打包：壳装一次，页面从电脑的 dev server 加载，改代码手机秒刷新
npx cap run android --live-reload --host <电脑的局域网IP> --port 5178
```

`<电脑的局域网IP>` 用 `ipconfig` 查（手机和电脑要在同一个 Wi-Fi / 同一网段下 USB 也行）。
live-reload 模式下 `CapacitorHttp` 照旧走原生层，所以出网 / 保存相册这些还是真机行为。

🔴 **这几项只有真机测得出来**（规格 §8 验收清单本来就写的是「真机，不是浏览器」）：
保存到相册、复制网址到剪贴板、断网提示、`CapacitorHttp` 有没有真的绕开 WebView 的 CORS。
浏览器里 `npm run dev` 只能看界面，测不到这些。

## 目录

| 文件 | 作用 |
|---|---|
| `src/http/capacitorHttp.ts` | 唯一出网通道。原生走 `CapacitorHttp`（绕过 WebView 的 CORS），浏览器退回 `fetch` |
| `src/providers/customHttp.ts` | 从桌面端 `lib/providers/custom/http.ts` **原样**搬的端点兜底逻辑 |
| `src/providers/generateImage.ts` | 文生图 + 拉模型清单（从桌面端 `custom/client.ts` 搬的文生图那一支） |
| `src/storage.ts` | 站点地址 / 令牌 / 上次模型（`Preferences`） |
| `src/save.ts` | 保存到相册 / 复制链接 / 分享 |
| `src/pages/Chat.tsx` | 聊天界面：气泡流 + 底部输入条 + 每张图下面的保存/复制 |
| `src/pages/Auth.tsx` | 站点账号：登录 / 注册 + 自动开通令牌 |
| `src/pages/Settings.tsx` | 设置：账号状态 / 站点 / 令牌 / 测试连接 / 选模型 |
| `src/providers/site.ts` | 站点账号接口（验证码 / 注册 / 登录 / 建令牌 / 取密钥） |

## 站点账号（登录 / 注册会自动把令牌开好）

规格 §4.2 那一版，2026-10-13 接进来了。用户不用再去站点后台复制 `sk-...`：

登录（或注册）成功后自动走三步 —— **复用/建专用令牌 → 取完整密钥 → 拉一次模型清单**，
然后把 key 写进设置。令牌名字沿用桌面端那把 `Holy Light画布`，站点上已经有了就复用，不重复建。

🔴 `src/providers/site.ts` 的头注释列了 **8 条实测出来的事实**（都不是常识，别照一般 REST 的手感改），
抄录几条最贵的：

- 建令牌**必须**带 `unlimited_quota: true` —— 只给 `name` 建出来的是**额度 0 的废令牌**，
  `/v1/models` 照样 200，一真调用就报额度不足。
- 建令牌的回包**不给 id**，建完要**列清单按名字找回**。
- 列表里的 key 是**打码的**，要再打 `/api/token/<id>/key` 取真的，且**必须带 JWT**。
- 发验证码是 **`GET /api/verification?email=...`**（`POST` 是 404）；
  站点**对不存在的邮箱也回 success**，所以按钮**不能**写「已发送」。
- 注册字段名是 **`verification_code`**，写成 `code` 会被静默忽略。

站点当前实测（2026-10-13）：`/api/status` 里 `register_enabled: true`、`email_verification: true`
→ **能注册，注册要邮箱验证码**。

## 现状（2026-10-13）

- 包名 `cn.holylight.canvas` / 应用名 `Holy Light画布`（沿用桌面端）。**图标还是 Capacitor 默认的**，没换。
- 默认模型：第一次拉清单后取**第一个**（不是写死的）—— 徐先的站点现在能出图的至少有
  `gpt-image-2`、`gpt-image-2.5`、`gemini-3-pro-image-preview`。
- 没做历史记录（规格 A4），刷新即丢；没做应用内登录（规格 §4.2，第二版再说）。
- `AndroidManifest.xml` 里除了 `INTERNET`，只多了一条 `WRITE_EXTERNAL_STORAGE`（`maxSdkVersion="28"`，
  给 Android 9 及以下写相册用）。Android 10 起靠 MediaStore，不需要权限。

## 两条不能踩的线

1. **不要直接用 `fetch` 发业务请求** —— 打包成 App 之后会被 WebView 的 CORS 拦掉。
   一律 `send()`（`src/http/capacitorHttp.ts`）。
2. **不要拿 HTTP 200 当成功** —— 中转站的后台首页也是 200。判 `looksLikeHtml()`。
   搬来的那两个文件里的注释是有代价换来的，别删。
