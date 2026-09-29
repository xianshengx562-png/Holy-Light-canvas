import { Prisma } from '@prisma/client';
import { NextResponse } from 'next/server';
import { currentUser } from '@/lib/auth/session';
export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
export async function apiUser() { const user = await currentUser(); if (!user) throw new ApiError(401,'请先登录。'); return user; }
/**
 * CSRF 来源检查。
 *
 * 同源请求**没有** `Origin` 头 —— 这是浏览器的规矩：只有跨源才自动带。
 * 而 web 版的写请求来自 <form> / fetch 都是同源，所以「没有 Origin」不是可疑，
 * 那正是正常情况。（旧写法要求 Origin 必须存在且相等，会把所有同源写请求挡在门外。）
 *
 * 所以判据改为：带了 Origin 就必须等于本站；没带就放行。
 * 挡 CSRF 靠的本来就是「跨站请求会带上攻击者的 Origin」这一条 ——
 * 攻击者伪造不了它，也不该因为「老实没带」而被放行的是我们这一侧。
 */
export function checkOrigin(request: Request) {
  const actual = request.headers.get('origin');
  if (!actual) return;
  const expected = new URL(process.env.APP_URL || 'http://localhost:3000').origin;
  if (actual !== expected) throw new ApiError(403,'请求来源无效，请从本站重新操作。');
}
export async function jsonBody(request: Request, maxBytes = 8192): Promise<Record<string, unknown>> {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new ApiError(400,'请使用 JSON 格式。');
  if (Number(request.headers.get('content-length')) > maxBytes) throw new ApiError(400,'请求内容过长。');
  if (!request.body) throw new ApiError(400,'请求不能为空。');
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  while (true) { const {done,value} = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { await reader.cancel(); throw new ApiError(400,'请求内容过长。'); } chunks.push(value); }
  try { const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error(); return body as Record<string,unknown>; } catch { throw new ApiError(400,'请求格式无效。'); }
}
export async function api(handler: () => Promise<Response>) {
  try { return await handler(); } catch (error) {
    if (error instanceof ApiError) return NextResponse.json({error:error.message},{status:error.status});
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return NextResponse.json({error:'信息已被使用，请登录或更换后重试。'},{status:409});
    /*
     * ⚠️ 这条分支必须绑在「真的配了数据库」上。
     *
     * 桌面版没有外部数据库（数据写在 userData 的 JSON 里），`DATABASE_URL` 天然是空的。
     * 旧写法把条件写成「没配数据库 **或** 是连接异常」，于是只要任意一个路由抛出任何未预期的
     * 异常，都会被渲染成「数据库尚未连接」的 503，真实的错误连一行日志都没有 ——
     * 画布保存失败就是这么被藏掉的：看上去是没接库，其实是别的地方炸了。
     */
    if (process.env.DATABASE_URL && error instanceof Prisma.PrismaClientInitializationError) return NextResponse.json({error:'数据库尚未连接，请管理员完成数据库配置。'},{status:503});
    /* 未预期的异常必须落日志：这一层对前端只回一句「服务暂时不可用」，
       服务端什么都不打的话，500 就成了一个没有现场的黑盒（注册那次 P2021 就是这么查了半天）。 */
    console.error('[api] 未处理的接口异常', error);
    return NextResponse.json({error:'服务暂时不可用，请稍后重试。'},{status:500});
  }
}
