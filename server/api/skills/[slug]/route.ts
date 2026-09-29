import { z } from 'zod';
import { api, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { deleteSkill, readSkill, readSkillBody, setSkillFlags } from '@/lib/skills';

/**
 * 单个技能：看正文（GET）· 改名 + 改标记（PATCH）· 删（DELETE）。
 *
 * 路径上只有 slug —— 技能就一层目录，没有分组（见 `lib/skills.ts` 顶部）。
 *
 * **删内置技能也照删** —— 用户明确点删除就该删掉，别换成「隐藏」那种自作聪明的行为。
 * 想找回来用 `/api/skills/reset`（重新从包内复制一份）。
 */
type Ctx = { params: Promise<{ slug: string }> };

export async function GET(_request: Request, { params }: Ctx) {
  return api(async () => {
    const { slug } = await params;
    const skill = readSkill(slug);
    if (!skill) throw new ApiError(404, '这个技能已经不在了。');
    return Response.json({ skill, body: readSkillBody(slug) });
  });
}

const patchSchema = z.object({
  /** 界面上显示的名字。**不动目录名**（那是 id），也不动 SKILL.md 的 frontmatter。 */
  title: z.string().trim().min(1).max(60).optional(),
  usage: z.enum(['use', 'edit']).optional(),
  /** 是否出现在 dock「优化提示词」旁边的下拉里。 */
  optimize: z.boolean().optional(),
  /** 分类标签。**传了就是覆盖**（前端每次都把整组发回来），空数组＝取消全部分类。 */
  tags: z.array(z.string().trim().min(1).max(24)).max(12).optional(),
});

export async function PATCH(request: Request, { params }: Ctx) {
  return api(async () => {
    checkOrigin(request);
    const { slug } = await params;
    const parsed = patchSchema.safeParse(await jsonBody(request));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    if (
      parsed.data.title === undefined
      && parsed.data.usage === undefined
      && parsed.data.optimize === undefined
      && parsed.data.tags === undefined
    ) {
      throw new ApiError(400, '没有要改的东西。');
    }
    return Response.json({ skill: setSkillFlags(slug, parsed.data) });
  });
}

export async function DELETE(request: Request, { params }: Ctx) {
  return api(async () => {
    checkOrigin(request);
    const { slug } = await params;
    return Response.json({ deleted: deleteSkill(slug) });
  });
}
