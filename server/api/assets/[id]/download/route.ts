import { readFile } from 'node:fs/promises';
import { api, apiUser, ApiError } from '@/lib/api';
import { db } from '@/lib/db';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const asset = await db.asset.findFirst({ where: { id, userId: user.id } });
    if (!asset) throw new ApiError(404, '文件不存在。');
    const meta = (asset.metadata || {}) as { path?: string };
    if (!meta.path) throw new ApiError(404, '该文件未落盘。');
    const data = await readFile(/*turbopackIgnore: true*/ meta.path);
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${asset.id}.latent.gz"`,
        'content-length': String(data.byteLength),
      },
    });
  });
}
