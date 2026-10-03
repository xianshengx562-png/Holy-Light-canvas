import { readFile } from 'node:fs/promises';
import { api, apiUser, ApiError } from '@/lib/api';
import { db } from '@/lib/db';
import { resolveStoredPath } from '@/lib/output-dir';
import { latentUploadName } from '@/lib/latent-name';
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  return api(async () => {
    const user = await apiUser();
    const { id } = await params;
    const asset = await db.asset.findFirst({ where: { id, userId: user.id } });
    if (!asset) throw new ApiError(404, '文件不存在。');
    const meta = (asset.metadata || {}) as { path?: string; sequence?: string; kind?: string };
    if (!meta.path) throw new ApiError(404, '该文件未落盘。');
    const data = await readFile(/*turbopackIgnore: true*/ await resolveStoredPath(meta.path));
    /*
     * A latent is downloaded under the name it is *used* by — `L002-fine.safetensors` —
     * so the file can be dropped into a local ComfyUI (or handed straight to the
     * upstream node) without renaming. Non-latent downloads keep the previous
     * behaviour untouched.
     */
    if (asset.type === 'latent') {
      return new Response(new Uint8Array(data), {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${latentUploadName(meta.sequence, meta.kind)}"`,
          'content-length': String(data.byteLength),
        },
      });
    }
    return new Response(new Uint8Array(data), {
      headers: {
        'content-type': 'application/gzip',
        'content-disposition': `attachment; filename="${asset.id}.latent.gz"`,
        'content-length': String(data.byteLength),
      },
    });
  });
}
