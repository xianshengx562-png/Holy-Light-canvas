/**
 * 逻辑层冒烟（不用真机就能跑的那部分）。
 *
 * 手机装 App 之前，先在电脑上把**搬过来的那套地址兜底和取值逻辑**过一遍：
 *   npm run smoke
 *
 * 它跑的是 `src/providers/` 下的纯 TS（先把它们打成 CJS 再 require），
 * **不发任何真实请求** —— 请求函数都是这里 mock 的。
 *
 * 为什么要留这个脚本：规格 §8 验收清单里有两条最容易回归的
 *   - 「地址不带 /v1 时必须报回网页，不能报生成成功」；
 *   - 「令牌错时报上游原话，不能报网络错误」。
 * 这两条在真机上测要花额度、还要等限流，用 mock 跑一遍更快也更稳。
 */
const http = require('../node_modules/.cache/smoke-http.cjs');
const gen = require('../node_modules/.cache/smoke-gen.cjs');
const m = { ...http, ...gen };

let fails = 0;
function eq(actual, expected, name) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n      got  ${JSON.stringify(actual)}\n      want ${JSON.stringify(expected)}`}`);
}

/** 一个假的 Response：`requestFirstJson` 只用到 status / ok / text()。 */
const reply = (status, body) => ({ status, text: async () => body, ok: status >= 200 && status < 300 });

/* ---- 端点候选（§3.1） ---- */
eq(
  m.endpointCandidates('https://x.top', '/images/generations'),
  ['https://x.top/v1/images/generations', 'https://x.top/images/generations'],
  '候选地址：域名 → 先 /v1 再不带',
);
eq(
  m.endpointCandidates('https://x.top/v1', '/models'),
  ['https://x.top/v1/models', 'https://x.top/models'],
  '候选地址：带 /v1 → 先原样再退回',
);
eq(m.endpointCandidates('https://x.top/', '/models')[0], 'https://x.top/v1/models', '候选地址：末尾斜杠');

/* ---- 网页判定（§3.1：不能拿 200 当成功） ---- */
eq(m.looksLikeHtml('<!DOCTYPE html><html><head>'), true, 'looksLikeHtml：<!doctype');
eq(m.looksLikeHtml('  <html lang=zh>'), true, 'looksLikeHtml：前导空格 + <html');
eq(m.looksLikeHtml('{"data":[]}'), false, 'looksLikeHtml：JSON 不是网页');

/* ---- 宽容取值（§3.3） ---- */
eq(m.readMediaResults({ data: [{ b64_json: 'AAA' }] }), [{ b64: 'AAA' }], '取值：data[].b64_json');
eq(m.readMediaResults({ data: [{ url: 'https://i/1.png' }] }), [{ url: 'https://i/1.png' }], '取值：data[].url');
eq(m.readMediaResults({ output: { images: [{ b64: 'BBB' }] } }), [{ b64: 'BBB' }], '取值：output.images[].b64');
eq(m.readMediaResults({ url: 'https://i/2.png' }), [{ url: 'https://i/2.png' }], '取值：裸 url 兜底');
eq(m.readMediaResults({}), [], '取值：什么都没有 → 空（会走「没有拿到任何图片」）');

/* ---- 错误文案（§3.3） ---- */
eq(m.pickErrorMessage({ error: { message: '额度不足' } }), '额度不足', '错误取值：error.message');
eq(m.pickErrorMessage({ msg: '令牌无效' }), '令牌无效', '错误取值：msg');

void (async () => {
  /* 第一个候选回网页 → 换第二个 */
  const got = await m.requestFirstJson(
    ['https://x.top/v1/images/generations', 'https://x.top/images/generations'],
    async url => (url.includes('/v1/')
      ? reply(200, '{"data":[{"url":"https://i/ok.png"}]}')
      : reply(200, '<html><head><title>New API</title></head></html>')),
    m.pickErrorMessage,
  );
  eq(got.ok, true, 'requestFirstJson：跳过回网页的那个候选');
  eq(got.url, 'https://x.top/v1/images/generations', 'requestFirstJson：命中的是带 /v1 的');

  /* 全回网页（且地址已带 /v1）→ 报「回的是网页」，且不再叫人去加 /v1（2026-10-05 那条） */
  const html = await m.requestFirstJson(
    ['https://x.top/v1/images/generations'],
    async () => reply(200, '<!doctype html><title>New API</title>'),
    m.pickErrorMessage,
  );
  eq(html.ok, false, 'requestFirstJson：全回网页 → 失败');
  eq(/已经带 \/v1/.test(html.message), true, '报错里不再叫人去加 /v1');
  eq(/New API/.test(html.message), true, '报错里带上网页标题');

  /* 上游 400 → 优先报真正的 JSON 错误，而不是「回的是网页」 */
  const bad = await m.requestFirstJson(
    ['https://x.top/v1/images/generations', 'https://x.top/images/generations'],
    async url => (url.includes('/v1/')
      ? reply(400, '{"error":{"message":"这个模型不支持对话"}}')
      : reply(200, '<html><title>New API</title></html>')),
    m.pickErrorMessage,
  );
  eq(/这个模型不支持对话/.test(bad.message), true, '优先报上游 JSON 错误');

  /* 连不上 → network 那一档 */
  const net = await m.requestFirstJson(
    ['https://x.top/v1/models'],
    async () => { throw new Error('timeout'); },
    m.pickErrorMessage,
  );
  eq(/超时/.test(net.message), true, '连不上 / 超时有明确说法');

  console.log(fails ? `\n${fails} 项没过` : '\n全部通过');
  process.exit(fails ? 1 : 0);
})();
