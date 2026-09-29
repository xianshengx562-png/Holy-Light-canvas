/**
 * 「上传文档」那条路：把用户挑的一个文档变成一段**能放进文本节点**的文字。
 *
 * 三种来源，从便宜到贵：
 *   1. 纯文本（`.txt` / `.md` / `.json` / `.csv` / `.srt` …，以及任何 `text/*`）—— 直接读；
 *   2. `.docx` —— 它其实是个 zip，正文在 `word/document.xml` 里。浏览器自带
 *      `DecompressionStream`，自己走一遍中央目录就够，不为此引一个解压库；
 *   3. 其余（`.doc` / pdf / 图片 / 视频…）—— 认不出来，返回 `null`，
 *      由调用方给一句明白话（**不能静默什么都不发生**）。
 *
 * 不解析版式、不做 OCR：这条路的目的只有一个 —— 把文档里的字拿来当提示词。
 */

/** 当成纯文本读的扩展名。`.doc` **不在**里面：那是二进制格式，读出来是乱码。 */
const TEXT_EXTS = [
  'txt', 'text', 'md', 'markdown', 'json', 'csv', 'tsv', 'srt', 'vtt',
  'log', 'yml', 'yaml', 'ini', 'cfg', 'conf', 'xml', 'html', 'htm', 'tsv',
];

function extOf(name: string) {
  const tail = String(name || '').split('/').pop() || '';
  const dot = tail.lastIndexOf('.');
  return dot > 0 ? tail.slice(dot + 1).toLowerCase() : '';
}

/** 这个文件我们能不能读出文字来（拿不准的一律当「不能」，由界面上说明）。 */
export function isDocumentFile(file: File): boolean {
  if (file.type.startsWith('text/')) return true;
  const ext = extOf(file.name);
  return ext === 'docx' || TEXT_EXTS.includes(ext);
}

/** 读出来是文字，读不出来是 `null` —— 不抛异常，也不返回空串冒充成功。 */
export async function readDocumentText(file: File): Promise<string | null> {
  const ext = extOf(file.name);
  if (ext === 'docx') {
    try { return await readDocx(file); } catch { return null; }
  }
  if (file.type.startsWith('text/') || TEXT_EXTS.includes(ext)) {
    try { return await file.text(); } catch { return null; }
  }
  return null;
}

async function readDocx(file: File): Promise<string | null> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const xml = await zipEntryText(buf, 'word/document.xml');
  return xml ? docxXmlToText(xml) : null;
}

/**
 * 从 zip 里取一条 entry 的文本。
 *
 * 走**中央目录**而不是从头扫本地头：中央目录是权威索引（本地头里那条「数据描述符」
 * 位置不固定，顺序扫容易跑偏）。取到之后仍要回本地头重新算数据起点 ——
 * 本地头里的 name/extra 长度与中央目录里那份**可以不一样**（尤其 extra）。
 */
async function zipEntryText(buf: Uint8Array, wanted: string): Promise<string | null> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  /* 尾记录 22 字节起，后面可能跟最多 65535 字节注释 —— 从尾部往回找签名。 */
  const floor = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= floor; i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;

  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (offset + 46 > buf.length || view.getUint32(offset, true) !== 0x02014b50) return null;
    const method = view.getUint16(offset + 10, true);
    const compressed = view.getUint32(offset + 20, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const local = view.getUint32(offset + 42, true);
    const name = decoder.decode(buf.subarray(offset + 46, offset + 46 + nameLen));
    offset += 46 + nameLen + extraLen + commentLen;
    if (name !== wanted) continue;

    if (local + 30 > buf.length || view.getUint32(local, true) !== 0x04034b50) return null;
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = buf.subarray(start, start + compressed);
    if (method === 0) return decoder.decode(raw);
    if (method !== 8) return null;
    /* 拷一份再进 Blob：`subarray` 的 buffer 是 `ArrayBufferLike`（可能指向 SharedArrayBuffer），
       而 `BlobPart` 只收 `ArrayBuffer`。 */
    const owned = new Uint8Array(raw);
    const stream = new Blob([owned.buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return await new Response(stream).text();
  }
  return null;
}

/**
 * `word/document.xml` → 纯文本。
 *
 * 只做三件事：段落结束换行、手动换行 `<w:br/>` 换行、制表位算一个空格。
 * 其余标签一律剥掉 —— 段落样式、批注、域代码都不是用户想粘进提示词的东西。
 */
function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
