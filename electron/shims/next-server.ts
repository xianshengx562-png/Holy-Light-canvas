/**
 * `next/server` 的最小替身。
 *
 * 原来 38 个路由文件都写成 `return NextResponse.json(...)` / `NextResponse.redirect(...)`。
 * 迁移到主进程后这些文件**一个字都不用改**，只要这里提供同名的两个静态方法即可 ——
 * Node 18+ 自带 `Response`，直接拿它当底座。
 *
 * ⚠️ 这个文件**不许 import `@/lib/*`**：`lib/api.ts` 反过来 import `next/server`，
 * 一旦两头互相引用就成了循环依赖，打包成 CJS 时 `NextResponse` 可能拿到 undefined。
 * 替身就该是纯粹的替身，业务类型一律从各自本来的模块导入。
 */
export class NextResponse extends Response {
  static json(body: unknown, init?: ResponseInit): Response {
    const headers = new Headers(init?.headers);
    if (!headers.has('content-type')) headers.set('content-type', 'application/json; charset=utf-8');
    return new Response(body === undefined ? null : JSON.stringify(body), {
      status: init?.status ?? 200,
      statusText: init?.statusText,
      headers,
    });
  }

  /**
   * 重定向。默认 **307**（与 Next 一致）。
   *
   * 桌面版的 fetch 会自己跟着 `location` 头走，所以这里只需要把头写对；
   * 真正「跳到哪个页面」的决定权在渲染进程，不在这一层。
   */
  static redirect(url: string | URL, status = 307): Response {
    return new Response(null, { status, headers: { location: String(url) } });
  }
}

/** `NextRequest` 只在少数需要类型标注的地方出现，这里退化成标准 Request。 */
export class NextRequest extends Request {}
