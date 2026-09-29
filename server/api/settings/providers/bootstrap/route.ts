import { api, apiUser } from '@/lib/api';
import { walletOverview } from '@/lib/wallet';
import { describeConnection } from '@/lib/providers/runninghub/connection';
import { runningHubConfig } from '@/lib/providers/runninghub/config';

/**
 * 「设置 · 服务连接」页的一次性取数。
 *
 * 这一页原来在服务端同时调 `describeConnection` / `walletOverview`
 * 两个函数，桌面版没有服务端渲染这一步，所以合到一个接口里 **一次拿全** ——
 * 不是图省事：RunningHub 的「填没填自己的 key」和「余额够不够」本来就是同一件事的两面，
 * 分三次取会有一瞬间显示「已配置 + 余额未知」，那种半张脸的状态最难解释。
 *
 * `defaultWorkflowId` 单独带出来，是因为它来自环境变量（不是用户数据），
 * 页面上那句「当前默认工作流：xxx」要用。
 *
 * ⚠️ 只返回 `runningHubConfig.workflowId` 这一个字段 —— 同模块的 baseUrl / configured
 * 属于部署信息，不该出现在界面上。
 */
export async function GET() {
  return api(async () => {
    const user = await apiUser();
    const [connection, wallet] = await Promise.all([
      describeConnection(user.id),
      walletOverview(user),
    ]);
    return Response.json({ connection, wallet, defaultWorkflowId: runningHubConfig.workflowId });
  });
}
