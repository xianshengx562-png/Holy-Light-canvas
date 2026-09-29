/*
 * 路由表 —— **由脚本扫描 server/api 生成，不要手改**。
 *
 * 这些文件就是从 Next 的 `app/api` 目录原样搬过来的：它们导出 `GET` / `POST` / …，
 * 签名与在 Next 里时一致（第二参数是 `{ params }`），所以迁移时一个字都没改。
 *
 * `[id]` 这类动态段在这里编译成正则，匹配出来的值仍以 params 交给处理函数。
 */

import type { ApiModule } from '../backend/dispatch';

import * as m0 from '@/server/api/tools/video/export/cancel/route';
import * as m1 from '@/server/api/local/connection/test/route';
import * as m2 from '@/server/api/local/graph/pull/route';
import * as m3 from '@/server/api/providers/custom/test/route';
import * as m4 from '@/server/api/providers/runninghub/connection/route';
import * as m5 from '@/server/api/providers/runninghub/test/route';
import * as m6 from '@/server/api/providers/runninghub/upload/route';
import * as m7 from '@/server/api/settings/providers/bootstrap/route';
import * as m8 from '@/server/api/tools/video/archive/route';
import * as m9 from '@/server/api/tools/video/export/route';
import * as m10 from '@/server/api/tools/video/ffmpeg/route';
import * as m11 from '@/server/api/tools/video/frame/route';
import * as m12 from '@/server/api/tools/video/probe/route';
import * as m13 from '@/server/api/tools/video/upload/route';
import * as m14 from '@/server/api/assets/categories/[id]/route';
import * as m15 from '@/server/api/providers/custom/[id]/route';
import * as m16 from '@/server/api/assets/[id]/download/route';
import * as m17 from '@/server/api/projects/[id]/canvas/route';
import * as m18 from '@/server/api/projects/[id]/custom-image/route';
import * as m19 from '@/server/api/projects/[id]/custom-video/route';
import * as m20 from '@/server/api/projects/[id]/generation/route';
import * as m21 from '@/server/api/projects/[id]/latents/route';
import * as m22 from '@/server/api/projects/[id]/videoapi/route';
import * as m23 from '@/server/api/provider-keys/[id]/test/route';
import * as m24 from '@/server/api/workflows/[workflowId]/config/route';
import * as m25 from '@/server/api/workflows/[workflowId]/fields/route';
import * as m26 from '@/server/api/assets/[id]/[file]/route';
import * as m27 from '@/server/api/assets/batch/route';
import * as m28 from '@/server/api/assets/categories/route';
import * as m29 from '@/server/api/assets/orphans/route';
import * as m30 from '@/server/api/assets/upload/route';
import * as m31 from '@/server/api/auth/login/route';
import * as m32 from '@/server/api/auth/logout/route';
import * as m33 from '@/server/api/auth/me/route';
import * as m34 from '@/server/api/auth/register/route';
import * as m35 from '@/server/api/auth/session/route';
import * as m36 from '@/server/api/local-llm/cancel/route';
import * as m37 from '@/server/api/local-llm/complete/route';
import * as m38 from '@/server/api/local-llm/estimate/route';
import * as m39 from '@/server/api/local-llm/models/route';
import * as m40 from '@/server/api/local-llm/scan/route';
import * as m41 from '@/server/api/local-llm/settings/route';
import * as m42 from '@/server/api/local-llm/start/route';
import * as m43 from '@/server/api/local-llm/status/route';
import * as m44 from '@/server/api/local-llm/stop/route';
import * as m45 from '@/server/api/local/connection/route';
import * as m46 from '@/server/api/local/diagnose/route';
import * as m47 from '@/server/api/local/inventory/route';
import * as m48 from '@/server/api/local/scan/route';
import * as m49 from '@/server/api/projects/batch/route';
import * as m50 from '@/server/api/projects/quick/route';
import * as m51 from '@/server/api/prompt/models/route';
import * as m52 from '@/server/api/prompt/optimize/route';
import * as m53 from '@/server/api/providers/custom/route';
import * as m54 from '@/server/api/settings/model-services/route';
import * as m55 from '@/server/api/settings/output/route';
import * as m56 from '@/server/api/site-account/refresh/route';
import * as m57 from '@/server/api/site-account/use-token/route';
import * as m58 from '@/server/api/skills/categories/route';
import * as m59 from '@/server/api/skills/reset/route';
import * as m60 from '@/server/api/studio/session/route';
import * as m61 from '@/server/api/studio/upload/route';
import * as m62 from '@/server/api/tools/archive/route';
import * as m63 from '@/server/api/workflows/local/route';
import * as m64 from '@/server/api/assets/[id]/route';
import * as m65 from '@/server/api/projects/[id]/route';
import * as m66 from '@/server/api/provider-keys/[id]/route';
import * as m67 from '@/server/api/skills/[slug]/route';
import * as m68 from '@/server/api/tasks/[id]/route';
import * as m69 from '@/server/api/workflows/[workflowId]/route';
import * as m70 from '@/server/api/assets/route';
import * as m71 from '@/server/api/projects/route';
import * as m72 from '@/server/api/provider-keys/route';
import * as m73 from '@/server/api/site-account/route';
import * as m74 from '@/server/api/skills/route';
import * as m75 from '@/server/api/workflows/route';
import * as m76 from '@/server/api/tasks/scan/route';

export type RouteEntry = {
  /** `/api/projects/[id]/canvas` 这样的原始模式，报错信息里要用 */
  pattern: string;
  regex: RegExp;
  keys: string[];
  mod: ApiModule;
};

export const ROUTES: RouteEntry[] = [
  {
    pattern: '/api/tools/video/export/cancel',
    regex: /^\/api\/tools\/video\/export\/cancel$/,
    keys: [],
    mod: m0 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/connection/test',
    regex: /^\/api\/local\/connection\/test$/,
    keys: [],
    mod: m1 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/graph/pull',
    regex: /^\/api\/local\/graph\/pull$/,
    keys: [],
    mod: m2 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/custom/test',
    regex: /^\/api\/providers\/custom\/test$/,
    keys: [],
    mod: m3 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/runninghub/connection',
    regex: /^\/api\/providers\/runninghub\/connection$/,
    keys: [],
    mod: m4 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/runninghub/test',
    regex: /^\/api\/providers\/runninghub\/test$/,
    keys: [],
    mod: m5 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/runninghub/upload',
    regex: /^\/api\/providers\/runninghub\/upload$/,
    keys: [],
    mod: m6 as unknown as ApiModule,
  },
  {
    pattern: '/api/settings/providers/bootstrap',
    regex: /^\/api\/settings\/providers\/bootstrap$/,
    keys: [],
    mod: m7 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/archive',
    regex: /^\/api\/tools\/video\/archive$/,
    keys: [],
    mod: m8 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/export',
    regex: /^\/api\/tools\/video\/export$/,
    keys: [],
    mod: m9 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/ffmpeg',
    regex: /^\/api\/tools\/video\/ffmpeg$/,
    keys: [],
    mod: m10 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/frame',
    regex: /^\/api\/tools\/video\/frame$/,
    keys: [],
    mod: m11 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/probe',
    regex: /^\/api\/tools\/video\/probe$/,
    keys: [],
    mod: m12 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/video/upload',
    regex: /^\/api\/tools\/video\/upload$/,
    keys: [],
    mod: m13 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/categories/[id]',
    regex: /^\/api\/assets\/categories\/([^\/]+)$/,
    keys: ['id'],
    mod: m14 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/custom/[id]',
    regex: /^\/api\/providers\/custom\/([^\/]+)$/,
    keys: ['id'],
    mod: m15 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/[id]/download',
    regex: /^\/api\/assets\/([^\/]+)\/download$/,
    keys: ['id'],
    mod: m16 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/canvas',
    regex: /^\/api\/projects\/([^\/]+)\/canvas$/,
    keys: ['id'],
    mod: m17 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/custom-image',
    regex: /^\/api\/projects\/([^\/]+)\/custom\-image$/,
    keys: ['id'],
    mod: m18 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/custom-video',
    regex: /^\/api\/projects\/([^\/]+)\/custom\-video$/,
    keys: ['id'],
    mod: m19 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/generation',
    regex: /^\/api\/projects\/([^\/]+)\/generation$/,
    keys: ['id'],
    mod: m20 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/latents',
    regex: /^\/api\/projects\/([^\/]+)\/latents$/,
    keys: ['id'],
    mod: m21 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]/videoapi',
    regex: /^\/api\/projects\/([^\/]+)\/videoapi$/,
    keys: ['id'],
    mod: m22 as unknown as ApiModule,
  },
  {
    pattern: '/api/provider-keys/[id]/test',
    regex: /^\/api\/provider\-keys\/([^\/]+)\/test$/,
    keys: ['id'],
    mod: m23 as unknown as ApiModule,
  },
  {
    pattern: '/api/workflows/[workflowId]/config',
    regex: /^\/api\/workflows\/([^\/]+)\/config$/,
    keys: ['workflowId'],
    mod: m24 as unknown as ApiModule,
  },
  {
    pattern: '/api/workflows/[workflowId]/fields',
    regex: /^\/api\/workflows\/([^\/]+)\/fields$/,
    keys: ['workflowId'],
    mod: m25 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/[id]/[file]',
    regex: /^\/api\/assets\/([^\/]+)\/([^\/]+)$/,
    keys: ['id', 'file'],
    mod: m26 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/batch',
    regex: /^\/api\/assets\/batch$/,
    keys: [],
    mod: m27 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/categories',
    regex: /^\/api\/assets\/categories$/,
    keys: [],
    mod: m28 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/orphans',
    regex: /^\/api\/assets\/orphans$/,
    keys: [],
    mod: m29 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/upload',
    regex: /^\/api\/assets\/upload$/,
    keys: [],
    mod: m30 as unknown as ApiModule,
  },
  {
    pattern: '/api/auth/login',
    regex: /^\/api\/auth\/login$/,
    keys: [],
    mod: m31 as unknown as ApiModule,
  },
  {
    pattern: '/api/auth/logout',
    regex: /^\/api\/auth\/logout$/,
    keys: [],
    mod: m32 as unknown as ApiModule,
  },
  {
    pattern: '/api/auth/me',
    regex: /^\/api\/auth\/me$/,
    keys: [],
    mod: m33 as unknown as ApiModule,
  },
  {
    pattern: '/api/auth/register',
    regex: /^\/api\/auth\/register$/,
    keys: [],
    mod: m34 as unknown as ApiModule,
  },
  {
    pattern: '/api/auth/session',
    regex: /^\/api\/auth\/session$/,
    keys: [],
    mod: m35 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/cancel',
    regex: /^\/api\/local\-llm\/cancel$/,
    keys: [],
    mod: m36 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/complete',
    regex: /^\/api\/local\-llm\/complete$/,
    keys: [],
    mod: m37 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/estimate',
    regex: /^\/api\/local\-llm\/estimate$/,
    keys: [],
    mod: m38 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/models',
    regex: /^\/api\/local\-llm\/models$/,
    keys: [],
    mod: m39 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/scan',
    regex: /^\/api\/local\-llm\/scan$/,
    keys: [],
    mod: m40 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/settings',
    regex: /^\/api\/local\-llm\/settings$/,
    keys: [],
    mod: m41 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/start',
    regex: /^\/api\/local\-llm\/start$/,
    keys: [],
    mod: m42 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/status',
    regex: /^\/api\/local\-llm\/status$/,
    keys: [],
    mod: m43 as unknown as ApiModule,
  },
  {
    pattern: '/api/local-llm/stop',
    regex: /^\/api\/local\-llm\/stop$/,
    keys: [],
    mod: m44 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/connection',
    regex: /^\/api\/local\/connection$/,
    keys: [],
    mod: m45 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/diagnose',
    regex: /^\/api\/local\/diagnose$/,
    keys: [],
    mod: m46 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/inventory',
    regex: /^\/api\/local\/inventory$/,
    keys: [],
    mod: m47 as unknown as ApiModule,
  },
  {
    pattern: '/api/local/scan',
    regex: /^\/api\/local\/scan$/,
    keys: [],
    mod: m48 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/batch',
    regex: /^\/api\/projects\/batch$/,
    keys: [],
    mod: m49 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/quick',
    regex: /^\/api\/projects\/quick$/,
    keys: [],
    mod: m50 as unknown as ApiModule,
  },
  {
    pattern: '/api/prompt/models',
    regex: /^\/api\/prompt\/models$/,
    keys: [],
    mod: m51 as unknown as ApiModule,
  },
  {
    pattern: '/api/prompt/optimize',
    regex: /^\/api\/prompt\/optimize$/,
    keys: [],
    mod: m52 as unknown as ApiModule,
  },
  {
    pattern: '/api/providers/custom',
    regex: /^\/api\/providers\/custom$/,
    keys: [],
    mod: m53 as unknown as ApiModule,
  },
  {
    pattern: '/api/settings/model-services',
    regex: /^\/api\/settings\/model\-services$/,
    keys: [],
    mod: m54 as unknown as ApiModule,
  },
  {
    pattern: '/api/settings/output',
    regex: /^\/api\/settings\/output$/,
    keys: [],
    mod: m55 as unknown as ApiModule,
  },
  {
    pattern: '/api/site-account/refresh',
    regex: /^\/api\/site\-account\/refresh$/,
    keys: [],
    mod: m56 as unknown as ApiModule,
  },
  {
    pattern: '/api/site-account/use-token',
    regex: /^\/api\/site\-account\/use\-token$/,
    keys: [],
    mod: m57 as unknown as ApiModule,
  },
  {
    pattern: '/api/skills/categories',
    regex: /^\/api\/skills\/categories$/,
    keys: [],
    mod: m58 as unknown as ApiModule,
  },
  {
    pattern: '/api/skills/reset',
    regex: /^\/api\/skills\/reset$/,
    keys: [],
    mod: m59 as unknown as ApiModule,
  },
  {
    pattern: '/api/studio/session',
    regex: /^\/api\/studio\/session$/,
    keys: [],
    mod: m60 as unknown as ApiModule,
  },
  {
    pattern: '/api/studio/upload',
    regex: /^\/api\/studio\/upload$/,
    keys: [],
    mod: m61 as unknown as ApiModule,
  },
  {
    pattern: '/api/tools/archive',
    regex: /^\/api\/tools\/archive$/,
    keys: [],
    mod: m62 as unknown as ApiModule,
  },
  {
    pattern: '/api/workflows/local',
    regex: /^\/api\/workflows\/local$/,
    keys: [],
    mod: m63 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets/[id]',
    regex: /^\/api\/assets\/([^\/]+)$/,
    keys: ['id'],
    mod: m64 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects/[id]',
    regex: /^\/api\/projects\/([^\/]+)$/,
    keys: ['id'],
    mod: m65 as unknown as ApiModule,
  },
  {
    pattern: '/api/provider-keys/[id]',
    regex: /^\/api\/provider\-keys\/([^\/]+)$/,
    keys: ['id'],
    mod: m66 as unknown as ApiModule,
  },
  {
    pattern: '/api/skills/[slug]',
    regex: /^\/api\/skills\/([^\/]+)$/,
    keys: ['slug'],
    mod: m67 as unknown as ApiModule,
  },
  /*
   * ⚠️ 静态段必须排在 `/api/tasks/[id]` **之前**：那条正则是 `/api/tasks/([^/]+)`，
   * 会把 `scan` 当成任务号吃掉（2026-09-29 加 `tasks/scan` 时踩的点）。
   */
  {
    pattern: '/api/tasks/scan',
    regex: /^\/api\/tasks\/scan$/,
    keys: [],
    mod: m76 as unknown as ApiModule,
  },
  {
    pattern: '/api/tasks/[id]',
    regex: /^\/api\/tasks\/([^\/]+)$/,
    keys: ['id'],
    mod: m68 as unknown as ApiModule,
  },
  {
    pattern: '/api/workflows/[workflowId]',
    regex: /^\/api\/workflows\/([^\/]+)$/,
    keys: ['workflowId'],
    mod: m69 as unknown as ApiModule,
  },
  {
    pattern: '/api/assets',
    regex: /^\/api\/assets$/,
    keys: [],
    mod: m70 as unknown as ApiModule,
  },
  {
    pattern: '/api/projects',
    regex: /^\/api\/projects$/,
    keys: [],
    mod: m71 as unknown as ApiModule,
  },
  {
    pattern: '/api/provider-keys',
    regex: /^\/api\/provider\-keys$/,
    keys: [],
    mod: m72 as unknown as ApiModule,
  },
  {
    pattern: '/api/site-account',
    regex: /^\/api\/site\-account$/,
    keys: [],
    mod: m73 as unknown as ApiModule,
  },
  {
    pattern: '/api/skills',
    regex: /^\/api\/skills$/,
    keys: [],
    mod: m74 as unknown as ApiModule,
  },
  {
    pattern: '/api/workflows',
    regex: /^\/api\/workflows$/,
    keys: [],
    mod: m75 as unknown as ApiModule,
  },
];
