import { createHash } from 'node:crypto';
import { db } from '@/lib/db';
import { ApiError } from '@/lib/api';
export async function limitAuth(email: string, action: string) {
  const window = Math.floor(Date.now() / 900_000);
  const key = createHash('sha256').update(`${action}:${email}:${window}`).digest('hex');
  const attempt = await db.authRateLimit.upsert({where:{key},create:{key,expiresAt:new Date((window + 1) * 900_000)},update:{count:{increment:1}}});
  if (attempt.count > 10) throw new ApiError(429,'尝试次数过多，请 15 分钟后重试。');
}
