import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/session';
import { db } from '@/lib/db';
import { ApiError, api, apiUser, checkOrigin, jsonBody } from '@/lib/api';

/**
 * 桌面版没有登录页，但渲染进程仍然需要 `userId` 去拼接口地址。
 *
 * 新增接口（原 web 版没有）：web 版的用户信息是服务端组件里直接 `currentUser()`
 * 读出来的，不走 HTTP；桌面版没有服务端渲染这一步，只能补一个入口。
 * 只读、不含任何敏感字段（不返回 passwordHash）。
 */
export async function GET() {
  const user = await currentUser();
  return NextResponse.json(user ?? null);
}

/* 头像是一个**字符串**，不是文件：见下面的 `PATCH`，这里只框定它允许多大、是什么形状。 */
const NAME_MAX = 40;
/** 前端已经压到 256×256，正常一张 ~30KB；留 600KB 是给「压完还是不小」的照片一点余量。 */
const AVATAR_MAX = 600_000;

const USER_SELECT = { id: true, email: true, name: true, avatar: true };

/**
 * 改自己的昵称 / 头像。
 *
 * **头像为什么直接存字符串（`User.avatar`）而不是一张图片文件**：
 * 桌面版的产品线里，图片是要落在**某个项目**下的（`archiveToolMedia` 强制要 `projectId`，
 * 出来的东西会进资产库、出现在资产页和选图器里）。头像不是任何一个项目的素材，
 * 走那条路等于给每个项目都掺一张跟项目无关的图。所以头像自己在 `User` 上留一条字符串，
 * 不占资产表的名额。
 *
 * 而这恰恰是**为「以后对接网站」留的接口**：网站的头像本来就是一个 URL，
 * 将来同步下来的是一个地址，今天本机上传的是一个 data URL —— 同一个字段、同一种渲染方式
 * （`<img src>` 两种都认），换了来源也不用改数据结构和界面。
 *
 * ⚠️ `avatar: null` 是「移除头像」的意思，不是「不修改」 —— 「不修改」是**别传这个键**。
 */
export async function PATCH(request: Request) {
  return api(async () => {
    checkOrigin(request);
    const user = await apiUser();
    /* 上限给到 ~1MB：头像本体最多 600KB，JSON 包一层还有富余。 */
    const body = await jsonBody(request, 1_200_000);

    let name: string | undefined;
    let avatar: string | null | undefined;

    if ('name' in body) {
      if (typeof body.name !== 'string') throw new ApiError(400, '昵称格式不对。');
      /* trim 之后是空＝用户把名字删光了，这在界面上等于"我不知道自己叫什么"，直接挡掉，
         而不是悄悄写进去一个空串（空昵称会让首字兜底那一路也跟着失效）。 */
      const trimmed = body.name.trim();
      if (!trimmed) throw new ApiError(400, '昵称不能为空。');
      if (trimmed.length > NAME_MAX) throw new ApiError(400, `昵称最多 ${NAME_MAX} 个字。`);
      name = trimmed;
    }

    if ('avatar' in body) {
      const raw = body.avatar;
      if (raw === null || raw === '') {
        avatar = null;
      } else if (typeof raw === 'string') {
        /* 只认两种：本机上传的 data URL，**以及一个 http(s) 图片地址** ——
           后者今天用不上，是给将来「网站的头像地址同步进来」留的口子。 */
        const ok = /^data:image\/(png|jpeg|webp|gif);base64,/i.test(raw) || /^https?:\/\//i.test(raw);
        if (!ok) throw new ApiError(400, '头像只能是图片。');
        if (raw.length > AVATAR_MAX) throw new ApiError(400, '这张头像太大了，换一张小一点的。');
        avatar = raw;
      } else {
        throw new ApiError(400, '头像格式不对。');
      }
    }

    if (name === undefined && avatar === undefined) throw new ApiError(400, '没有要改的内容。');

    const updated = await db.user.update({
      where: { id: user.id },
      data: { ...(name !== undefined ? { name } : {}), ...(avatar !== undefined ? { avatar } : {}) },
      select: USER_SELECT,
    });
    return NextResponse.json(updated);
  });
}
