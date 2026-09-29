import { z } from 'zod';
import { api, ApiError, checkOrigin, jsonBody } from '@/lib/api';
import { importSkill, listSkills, type SkillFile, type SkillView } from '@/lib/skills';

/**
 * SKILL 社区：列（GET）与导入（POST）。
 *
 * 导入支持**一次多个**：界面上「批量导入」选的是一个文件夹，里面往往不止一个技能，
 * 一个一个发请求的话中途失败就会留下一半。这里整批收下，失败的那个单独报错。
 */
const fileSchema = z.object({
  path: z.string().trim().min(1).max(300),
  content: z.string().max(2_000_000),
});

const oneSchema = z.object({
  title: z.string().trim().min(1).max(120),
  note: z.string().trim().max(600).optional(),
  usage: z.enum(['use', 'edit']).optional(),
  /** 相对路径 → 内容。至少要能凑出一个 SKILL.md，没有就按标题现生成一个。 */
  files: z.array(fileSchema).max(200).optional(),
});

const schema = z.object({
  /** 单个技能时用的三个字段（界面上的「新建」走这条）。 */
  title: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(600).optional(),
  usage: z.enum(['use', 'edit']).optional(),
  files: z.array(fileSchema).max(200).optional(),
  /** 批量导入：一次多个。 */
  skills: z.array(oneSchema).max(60).optional(),
});

export async function GET() {
  return api(async () => Response.json(await Promise.resolve(listSkills())));
}

export async function POST(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request, 32 * 1024 * 1024));
    if (!parsed.success) throw new ApiError(400, parsed.error.issues[0]?.message || '请求体格式不对。');
    const body = parsed.data;
    const batch = body.skills?.length
      ? body.skills
      : body.title
        ? [{ title: body.title, note: body.note, usage: body.usage, files: body.files as SkillFile[] | undefined }]
        : [];
    if (!batch.length) throw new ApiError(400, '先选一个技能文件夹，或者给这个技能起个名字。');
    /* 显式给类型：`const imported = []` 会被推成 never[]，push 进去的每一项都对不上。 */
    const imported: SkillView[] = [];
    const failed: string[] = [];
    for (const item of batch) {
      try {
        imported.push(importSkill({
          title: item.title,
          note: item.note,
          usage: item.usage,
          files: (item.files ?? []) as SkillFile[],
        }));
      } catch (error) {
        failed.push(`${item.title}：${error instanceof Error ? error.message : '导入失败'}`);
      }
    }
    if (!imported.length) throw new ApiError(400, failed.join('；') || '一个都没导入成功。');
    return Response.json({ imported, failed });
  });
}
