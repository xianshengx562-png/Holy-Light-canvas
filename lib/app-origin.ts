/**
 * 桌面版的「本站」origin。
 *
 * `app://` 不是特殊协议，`new URL('app://app/index.html').origin` 拿到的是字符串 `"null"`，
 * 而 `checkOrigin()` 比的是 `process.env.APP_URL` 的 origin（默认 `http://localhost:3000`）。
 * 两边对不上 → 所有带 `checkOrigin` 的写接口（新建项目、保存密钥…）一律 403。
 * 所以这里固定一个值，主进程把它写进 `APP_URL`、后端给请求补的头也是它 ——
 * 补的和比的是同一个，语义上就是「同源请求」，跟 web 版的检查是同一件事。
 *
 * 放在 `lib/` 而不是 `electron/main/` 是因为**两侧都要用**：
 * 主进程（转发前写 `APP_URL`）和后端进程（给请求补 `Origin`）是不同进程，
 * 而这个值必须两边一字不差。
 */
export const APP_ORIGIN = 'http://localhost:3000';
