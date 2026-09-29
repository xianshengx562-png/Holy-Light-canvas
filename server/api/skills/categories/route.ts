import { z } from 'zod';
import { api, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { addCategory, listCategories, removeCategory, renameCategory } from '@/lib/skills';

/**
 * 分类表：列（GET）· 建（POST）· 改名（PATCH）· 删（DELETE）。
 *
 * 分类**只有名字**，没有 id、没有层级（见 `lib/skills.ts` 里那段注释）：
 * 所以它存成一份扁平的字符串数组，落在数据目录的 `skill-categories.json`。
 *
 * ⚠️ 改名和删都不是「改一份表」就完事 —— **已经打在技能上的标签要一起跟着变**
 * （`renameCategory` / `removeCategory` 内部会逐个改 `skill.json`）。
 * 只改表不换标签的话，那些技能会一夜之间掉回「未分类」。
 *
 * ⚠️ 这条是**静态段**，必须排在 `/api/skills/[slug]` 前面 —— `gen-routes.py` 那条
 * 「同位置静态段优先于动态段」的规则就是为它准备的（否则会被 `[slug]` 截走，返回 405）。
 */
const nameSchema = z.string().trim().min(1).max(24);

export async function GET() {
  return api(async () => Response.json({ categories: listCategories() }));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const parsed = z.object({ name: nameSchema }).safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, '分类名不能是空的（最多 24 个字）。');
    try {
      return Response.json({ categories: addCategory(parsed.data.name) });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '分类没建成。');
    }
  });
}

const renameSchema = z.object({ from: nameSchema, to: nameSchema });

export async function PATCH(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const parsed = renameSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, '请求体格式不对。');
    try {
      return Response.json({ categories: renameCategory(parsed.data.from, parsed.data.to) });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '改名没保存。');
    }
  });
}

/** 删哪个走 query —— `apiDelete()` 不带 body，塞在 body 里它发不出来。 */
export async function DELETE(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const name = String(new URL(request.url).searchParams.get('name') || '').trim();
    if (!name) throw new ApiError(400, '先指定要删哪个分类。');
    try {
      return Response.json({ categories: removeCategory(name) });
    } catch (error) {
      throw new ApiError(400, error instanceof Error ? error.message : '分类没删掉。');
    }
  });
}
