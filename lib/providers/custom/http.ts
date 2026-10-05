/**
 * 中转站地址的兜底（2026-09-23）。
 *
 * ## 这一个模块为什么存在
 *
 * 徐先那条真实的中转站（`https://www.myvigna.top`，New API 那类网关）把**后台首页挂在根路径上**：
 *
 *   GET  https://x.top/models               → 200 + 一整页 HTML（New API 的控制台）
 *   GET  https://x.top/chat/completions     → 200 + 一整页 HTML
 *   GET  https://x.top/v1/models            → 200 + 真的模型清单
 *   POST https://x.top/v1/chat/completions  → 200 + 真的回答
 *
 * 也就是说：**不带 `/v1` 的地址，每一个 OpenAI 风格的端点都会打到一页网页上**，
 * 而网页是 200，所以「连不上」这种判断根本不会触发 —— 表现是「拉不到模型」、
 * 「优化提示词没有返回内容」，而用户完全看不出是地址少了一段。
 *
 * 所以凡是拼 OpenAI 风格端点的地方，都走这里的两件东西：
 *   1. `endpointCandidates` —— 把 `/v1/...` 与 `/...` 都作为候选；
 *   2. `requestFirstJson` —— 依次试，**跳过回网页的那些**，并且失败时优先报
 *      上游真正的 JSON 错误（400「模型不支持」比「回的是网页」有用得多）。
 */
/** 响应体是不是一个网页（后台首页被当成接口返回时就是这种）。 */
export function looksLikeHtml(text: string) {
  const head = String(text ?? '').slice(0, 512).trim().toLowerCase();
  return head.startsWith('<!doctype') || head.startsWith('<html')
    || head.startsWith('<head') || head.startsWith('<body');
}

/**
 * 一个端点的一串候选地址，按顺序试。
 *
 * - base 已经带 `/v1` → `<base>/xxx` 先，再退回去掉版本号的原域名；
 * - base 只有域名     → `<base>/v1/xxx` 先（中转站几乎都是这种），再 `<base>/xxx`。
 */
export function endpointCandidates(base: string, path: string): string[] {
  const root = String(base || '').trim().replace(/\/+$/, '');
  if (!root) return [];
  const out: string[] = [];
  const add = (url: string) => { if (!out.includes(url)) out.push(url); };
  const suffix = path.startsWith('/') ? path : `/${path}`;
  const versioned = /\/v\d+(?:\.\d+)?$/i.test(root);
  if (versioned) {
    add(`${root}${suffix}`);
    add(`${root.replace(/\/v\d+(?:\.\d+)?$/i, '')}${suffix}`);
  } else {
    add(`${root}/v1${suffix}`);
    add(`${root}${suffix}`);
  }
  return out;
}

export type JsonAttempt =
  | { ok: true; body: unknown; url: string }
  | { ok: false; message: string };

/** 失败原因的分类。**回网页**单独一类：它最容易被误读成「接口坏了」。 */
type Note = {
  kind: 'api' | 'html' | 'network';
  message: string;
  url: string;
  /** HTTP 状态。连不上是 0。 */
  status: number;
  /** 回网页时那页的 `<title>` —— 「New API」这种一眼就知道是中转站后台。 */
  title: string;
};

/**
 * 网页的标题。报「回的是网页」时带上它，用户自己就能对上「这是不是我那个后台首页」。
 */
export function htmlPageTitle(text: string): string {
  const found = /<title[^>]*>([^<]{0,60})<\/title>/i.exec(String(text ?? '').slice(0, 4000));
  return found ? found[1].trim() : '';
}

/**
 * 「回的是网页」这一档的完整说明。
 *
 * 🔴 地址里**已经带 `/v1`** 时绝对不能再叫人去加 `/v1`（2026-10-05 徐先截图踩到）：
 * 报错里写着 `https://www.myvigna.top/v1/images/generations 回的是网页…
 * 把地址改成带 /v1 的那种再试` —— 照做还是同一个地址，等于把人往死胡同里推。
 * 那种情况下地址是对的，是**站点这一刻没把接口接上**（重启 / 维护 / 被限流，
 * 整站都掉回后台首页），得照这个方向说。
 */
export function htmlEndpointMessage(url: string, status: number, title = ''): string {
  const head = `${url} 回的是一页网页（HTTP ${status || 200}${title ? `，标题「${title}」` : ''}），不是接口。`;
  return /\/v\d+(?:\.\d+)?\//i.test(url)
    ? `${head}地址里已经带 /v1 了 —— 多半是站点这一刻没把接口接上（重启 / 维护 / 被限流），过一会儿再试；一直这样就去中转站后台确认 /v1 那条通路还在不在。`
    : `${head}把地址改成带 /v1 的那种再试。`;
}

/**
 * 依次试候选地址，返回**第一份 JSON**。
 *
 * ⚠️ 为什么不是「第一个 200 就用」：中转站的后台首页就是 200。
 * 只有拿到一份能 parse 的 JSON（并且不是错误体）才算这一档地址对了。
 *
 * ⚠️ 全都没成时，**优先报上游真正的 JSON 错误** —— `400 这个模型不支持对话`
 * 比 `回的是网页` 有用得多；只有在一条 JSON 错误都没拿到时才说「回的是网页」。
 */
export async function requestFirstJson(
  urls: string[],
  send: (url: string) => Promise<Response>,
  detailOf?: (body: unknown) => string,
): Promise<JsonAttempt> {
  const notes: Note[] = [];
  for (const url of urls) {
    let response: Response;
    try {
      response = await send(url);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      notes.push({
        kind: 'network',
        message: /timed out|abort/i.test(reason) ? `${url} 响应超时。` : `${url} 连不上：${reason}`,
        url,
        status: 0,
        title: '',
      });
      continue;
    }
    const text = await response.text().catch(() => '');
    if (looksLikeHtml(text)) {
      notes.push({ kind: 'html', message: '', url, status: response.status, title: htmlPageTitle(text) });
      continue;
    }
    let body: unknown = null;
    try { body = JSON.parse(text); } catch { body = null; }
    if (!response.ok) {
      const detail = body === null ? text.slice(0, 200).trim() : (detailOf ? detailOf(body) : '');
      notes.push({
        kind: 'api',
        message: `${url} 返回 HTTP ${response.status}${detail ? `：${detail}` : ''}`,
        url,
        status: response.status,
        title: '',
      });
      continue;
    }
    if (body === null) {
      notes.push({
        kind: 'api',
        message: `${url} 返回的不是 JSON（HTTP ${response.status}）：${text.slice(0, 120).trim()}`,
        url,
        status: response.status,
        title: '',
      });
      continue;
    }
    return { ok: true, body, url };
  }
  const api = notes.find(item => item.kind === 'api');
  if (api) return { ok: false, message: api.message };
  const htmls = notes.filter(item => item.kind === 'html');
  if (htmls.length) {
    /*
     * **每一个候选都回网页** = 整站都掉回后台首页了（地址填错只会错一个：
     * 带 `/v1` 那个是好的）。这两种情况的补救完全不同，得分开说。
     */
    const all = urls.length > 1 && htmls.length === urls.length
      ? `（试过的 ${urls.length} 个地址都这样 —— 整站都掉回后台首页了，不是地址拼错。）`
      : '';
    return { ok: false, message: `${htmlEndpointMessage(htmls[0].url, htmls[0].status, htmls[0].title)}${all}` };
  }
  const network = notes.find(item => item.kind === 'network');
  if (network) return { ok: false, message: network.message };
  return { ok: false, message: '一个地址都没试（接口地址是空的）。' };
}
