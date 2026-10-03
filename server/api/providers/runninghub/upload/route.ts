import { api, apiUser, ApiError, checkOrigin } from '@/lib/api';
import { uploadMediaCached } from '@/lib/providers/runninghub/client';
import { resolveRunningHub } from '@/lib/providers/runninghub/connection';

const maxBytes = 100 * 1024 * 1024;
export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    if (!request.headers.get('content-type')?.startsWith('multipart/form-data'))
      throw new ApiError(400, '请选择文件。');
    if (Number(request.headers.get('content-length')) > maxBytes + 65536)
      throw new ApiError(413, '文件不能超过 100 MB。');
    // Bound multipart bytes before parsing, including requests without Content-Length.
    if (!request.body) throw new ApiError(400, '上传内容为空。');
    const chunks: Uint8Array[] = [];
    const reader = request.body.getReader();
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes + 65536) { await reader.cancel(); throw new ApiError(413, '文件不能超过 100 MB。'); }
      chunks.push(value);
    }
    const form = await new Response(Buffer.concat(chunks), { headers: { 'content-type': request.headers.get('content-type')! } }).formData();
    const file = form.get('file');
    if (!(file instanceof File) || !file.size) throw new ApiError(400, '请选择非空文件。');
    if (file.size > maxBytes) throw new ApiError(413, '文件不能超过 100 MB。');
    const { apiKey, message: keyMessage, baseUrl } = await resolveRunningHub(user.id);
    if (!apiKey) throw new ApiError(400, keyMessage || '尚未配置 RunningHub API Key。');
    /*
     * 失败原因要带出去。原来这里只回一句「上传失败，请检查连接或文件格式后重试」——
     * 那是在让人猜：是 Key 不认、还是文件太大、还是上游抽风？（同 `lib/upload.ts` 那条规矩）
     */
    /* Cached like the generation path: uploading the same bytes twice should be free. */
    try { return Response.json(await uploadMediaCached(file, apiKey, baseUrl)); }
    catch (error) { throw new ApiError(502, error instanceof Error ? error.message : 'RunningHub 上传失败。'); }
  });
}
