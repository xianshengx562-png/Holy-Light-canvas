/*
 * 模型元数据 —— **由脚本从 prisma/schema.prisma 生成，不要手改**。
 *
 * 桌面版没有 PostgreSQL：数据落在 userData 下的 JSON 文件里（见 `store.ts`），
 * 但上层 18 个文件仍然写 `db.user.findMany({ where: ..., select: ... })` 这种 Prisma 调用，
 * 所以这里保留一份「表结构」给查询引擎用：哪些字段、默认值是什么、哪些组合唯一。
 *
 * 改了 schema.prisma 之后重跑生成脚本即可。
 *
 * ⚠️ 仓库里**已经没有 `prisma/` 目录了**（生成脚本也一并没了），所以现在加模型、
 * 加字段只能**直接手改这一份**。`lib/db/store-sqlite.ts` 会在开库时按这份元数据
 * `CREATE TABLE IF NOT EXISTS` 并自动补列，不需要手写迁移。
 */

export type FieldKind = 'string' | 'int' | 'boolean' | 'datetime' | 'json' | 'enum';

export type FieldDefault =
  | { type: 'cuid' }
  | { type: 'now' }
  | { type: 'none' }
  | { type: 'literal'; value: string | number | boolean | null };

export type FieldMeta = {
  name: string;
  kind: FieldKind;
  /** 列可以为 null */
  optional: boolean;
  /** 写入时没给值就填这个 */
  default: FieldDefault;
  /** `@updatedAt`：任何一次 update 都要把它刷成当前时间 */
  updatedAt: boolean;
  /** `@unique`（单列） */
  unique: boolean;
  /** `@map("x")`：底层列名与字段名的映射（历史命名） */
  column?: string;
  /** 关联字段（另一端是别的 model）。`fk` 是本侧外键列，`ref` 是对方被引用列。 */
  relation?: { model: string; many: boolean; fk?: string; ref?: string };
};

export type ModelMeta = {
  name: string;
  /** 主键字段 */
  id: string;
  fields: FieldMeta[];
  /** `@@unique([a, b])` —— 含单列 unique 与主键 */
  uniques: string[][];
  /** `@@map("x")`：文件名 */
  table?: string;
};

export const MODELS: Record<string, ModelMeta> = {
  User: {
    name: 'User',
    id: 'id',
    uniques: [['id'], ['email']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'email', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'name', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'avatar', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'passwordHash', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
      { name: 'sessions', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Session', many: true } },
      { name: 'projects', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Project', many: true } },
      { name: 'runninghubConnection', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'RunningHubConnection', many: false } },
      { name: 'tasks', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Task', many: true } },
      { name: 'assets', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Asset', many: true } },
      { name: 'workflowDrafts', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'WorkflowDraft', many: true } },
      { name: 'wallet', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Wallet', many: false } },
      { name: 'walletEntries', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'WalletEntry', many: true } },
      { name: 'paymentOrders', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'PaymentOrder', many: true } },
      { name: 'subscription', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Subscription', many: false } },
      { name: 'providerKeys', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'ProviderKey', many: true } },
      { name: 'providerCalls', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'ProviderCall', many: true } },
      { name: 'localConnection', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'LocalConnection', many: false } },
      /*
       * 「提示词优化」用哪一家文本模型（2026-09-21）。空串 = 自动（按 `TEXT_PROVIDERS`
       * 的顺序挑第一家配了 key 的）。值也可以是某条自定义接口的 `custom:<id>`。
       * 见 `lib/promptAssistant.ts`。
       */
      { name: 'promptProvider', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /*
       * RunningHub 走哪个站：`cn`（国内站，历史连接表）还是 `ai`（海外站，密钥池里的
       * `runninghub-ai`）。两个站是**独立账号、独立 Key**，不能混用。
       */
      { name: 'runninghubSite', kind: 'string', optional: false, default: { type: 'literal', value: 'cn' }, updatedAt: false, unique: false },
      { name: 'customProviders', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'CustomProvider', many: true } },
    ],
  },
  Wallet: {
    name: 'Wallet',
    id: 'userId',
    table: 'credit_account',
    uniques: [['userId']],
    fields: [
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'balance', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  WalletEntry: {
    name: 'WalletEntry',
    id: 'id',
    table: 'credit_entry',
    uniques: [['id'], ['reason', 'refKey']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'delta', kind: 'int', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'balanceAfter', kind: 'int', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'reason', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'note', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'refKey', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
    ],
  },
  WorkflowDraft: {
    name: 'WorkflowDraft',
    id: 'id',
    uniques: [['id'], ['userId', 'workflowId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'workflowId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      /*
       * 这份配置跑在哪条路上：`runninghub`（云端，按数字 ID 调 RunningHub）还是 `local`
       * （本机 ComfyUI，图就存在本行的 `graph` 里）。本地那一份的 `workflowId` 自带
       * `local-` 前缀，读法见 `lib/workflows/local.ts`。
       */
      { name: 'provider', kind: 'string', optional: false, default: { type: 'literal', value: 'runninghub' }, updatedAt: false, unique: false },
      /*
       * 本地工作流独有的「图」本体：ComfyUI「导出（API）」出来的那份 JSON。
       * 云端工作流这一列永远是 NULL —— 它的图在 RunningHub 那边，本地不存。
       */
      { name: 'graph', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'kind', kind: 'string', optional: false, default: { type: 'literal', value: 'video' }, updatedAt: false, unique: false },
      { name: 'category', kind: 'string', optional: false, default: { type: 'literal', value: 'none' }, updatedAt: false, unique: false },
      { name: 'operation', kind: 'string', optional: false, default: { type: 'literal', value: 'generate' }, updatedAt: false, unique: false },
      { name: 'name', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'config', kind: 'json', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'version', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  PaymentOrder: {
    name: 'PaymentOrder',
    id: 'id',
    uniques: [['id'], ['orderNo']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'orderNo', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'kind', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'planId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'amountFen', kind: 'int', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'grantedFen', kind: 'int', optional: false, default: { type: 'none' }, updatedAt: false, unique: false, column: 'credits' },
      { name: 'status', kind: 'enum', optional: false, default: { type: 'literal', value: 'pending' }, updatedAt: false, unique: false },
      { name: 'externalTradeNo', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'paidAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'expiresAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'refundedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'raw', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'subscriptionId', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  Subscription: {
    name: 'Subscription',
    id: 'id',
    uniques: [['id'], ['userId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'planId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'status', kind: 'string', optional: false, default: { type: 'literal', value: 'active' }, updatedAt: false, unique: false },
      { name: 'currentPeriodStart', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'currentPeriodEnd', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'autoRenew', kind: 'boolean', optional: false, default: { type: 'literal', value: false }, updatedAt: false, unique: false },
      { name: 'amountPerPeriodFen', kind: 'int', optional: false, default: { type: 'none' }, updatedAt: false, unique: false, column: 'credits_per_period' },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  Session: {
    name: 'Session',
    id: 'id',
    uniques: [['id'], ['tokenHash']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'tokenHash', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'expiresAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
    ],
  },
  AuthRateLimit: {
    name: 'AuthRateLimit',
    id: 'key',
    uniques: [['key']],
    fields: [
      { name: 'key', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'count', kind: 'int', optional: false, default: { type: 'literal', value: 1 }, updatedAt: false, unique: false },
      { name: 'expiresAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
    ],
  },
  Project: {
    name: 'Project',
    id: 'id',
    uniques: [['id']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'name', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'thumbnail', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
      { name: 'canvas', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Canvas', many: false } },
      { name: 'tasks', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Task', many: true } },
      { name: 'assets', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Asset', many: true } },
    ],
  },
  Canvas: {
    name: 'Canvas',
    id: 'id',
    uniques: [['id'], ['projectId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'projectId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'project', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Project', many: false, fk: 'projectId', ref: 'id' } },
      { name: 'nodes', kind: 'json', optional: false, default: { type: 'literal', value: '[]' }, updatedAt: false, unique: false },
      { name: 'edges', kind: 'json', optional: false, default: { type: 'literal', value: '[]' }, updatedAt: false, unique: false },
      { name: 'viewport', kind: 'json', optional: false, default: { type: 'literal', value: '{\"x\":0,\"y\":0,\"zoom\":1}' }, updatedAt: false, unique: false },
      { name: 'version', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  RunningHubConnection: {
    name: 'RunningHubConnection',
    id: 'id',
    uniques: [['id'], ['userId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'literal', value: 'runninghub' }, updatedAt: false, unique: false },
      { name: 'encryptedApiKey', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'status', kind: 'string', optional: false, default: { type: 'literal', value: 'unverified' }, updatedAt: false, unique: false },
      { name: 'lastCheckedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  Workflow: {
    name: 'Workflow',
    id: 'id',
    uniques: [['id'], ['provider', 'workflowId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'name', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'description', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'workflowId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'type', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'inputSchema', kind: 'json', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'inputMapping', kind: 'json', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'enabled', kind: 'boolean', optional: false, default: { type: 'literal', value: false }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'tasks', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Task', many: true } },
    ],
  },
  Task: {
    name: 'Task',
    id: 'id',
    uniques: [['id'], ['idempotencyKey']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'projectId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'project', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Project', many: false, fk: 'projectId', ref: 'id' } },
      { name: 'nodeId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'workflowId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'workflow', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Workflow', many: false, fk: 'workflowId', ref: 'id' } },
      { name: 'externalTaskId', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      /*
       * 生成它的那个节点的名字（快照，2026-10-02 加）。
       * 历史已经改读 Task 表（见 `lib/runs.ts`），节点删掉之后**只有这里**还能回答
       * 「这条是谁跑的」—— 所以建单那一刻就写进来，事后回画布去查，节点可能已经不在了。
       */
      { name: 'nodeLabel', kind: 'string', optional: true, default: { type: 'literal', value: null }, updatedAt: false, unique: false },
      { name: 'idempotencyKey', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'status', kind: 'enum', optional: false, default: { type: 'literal', value: 'queued' }, updatedAt: false, unique: false },
      { name: 'input', kind: 'json', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'result', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'error', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'attempts', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'startedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'completedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'assets', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Asset', many: true } },
    ],
  },
  Asset: {
    name: 'Asset',
    id: 'id',
    uniques: [['id']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'projectId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'project', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Project', many: false, fk: 'projectId', ref: 'id' } },
      { name: 'name', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'type', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'url', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'thumbnailUrl', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      /* 图片的二级分类（角色 / 场景 / 道具）。没打标签是 null。见 `lib/asset-kinds.ts`。 */
      { name: 'category', kind: 'string', optional: true, default: { type: 'literal', value: null }, updatedAt: false, unique: false },
      { name: 'metadata', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'sourceTaskId', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'sourceTask', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'Task', many: false, fk: 'sourceTaskId', ref: 'id' } },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
    ],
  },
  ProviderKey: {
    name: 'ProviderKey',
    id: 'id',
    uniques: [['id']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'label', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'encryptedApiKey', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'baseUrl', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'model', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'enabled', kind: 'boolean', optional: false, default: { type: 'literal', value: true }, updatedAt: false, unique: false },
      { name: 'status', kind: 'string', optional: false, default: { type: 'literal', value: 'unverified' }, updatedAt: false, unique: false },
      { name: 'consecutiveFailures', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'errorMessage', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'expiresAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'lastCheckedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'lastUsedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  ProviderCall: {
    name: 'ProviderCall',
    id: 'id',
    uniques: [['id']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'provider', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'keyId', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'ok', kind: 'boolean', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'errorMessage', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'latencyMs', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
    ],
  },
  LocalConnection: {
    name: 'LocalConnection',
    id: 'id',
    uniques: [['id'], ['userId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'baseUrl', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'encryptedApiKey', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'graph', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      /**
       * ComfyUI 的**安装目录**（只读用）。配置了它，服务没开的时候也能答
       * 「这个节点装没装、这个模型文件在不在」，见 `lib/providers/local/directory.ts`。
       */
      { name: 'comfyuiDir', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'enabled', kind: 'boolean', optional: false, default: { type: 'literal', value: false }, updatedAt: false, unique: false },
      { name: 'status', kind: 'string', optional: false, default: { type: 'literal', value: 'unverified' }, updatedAt: false, unique: false },
      { name: 'lastCheckedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  /*
   * 「自定义接口」（2026-09-21，协议照 AIFISHER 的 `/custom-providers`）。
   *
   * 一条 = 一个 OpenAI 兼容的第三方网关（地址 + Key），**一条下面挂多个模型**，
   * 每个模型带 `kind`：image（出图）/ video（出片）/ text（提示词优化）。
   * 之所以是一条多模型而不是一个模型一条：同一个网关下十几个模型共用同一把 Key，
   * 让用户把 Key 抄十遍是最容易抄错的操作。
   *
   * Key 与 `ProviderKey` 一样是**加密后**存的（`encryptedApiKey`），明文不出库。
   */
  CustomProvider: {
    name: 'CustomProvider',
    id: 'id',
    uniques: [['id'], ['userId', 'name']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'name', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'baseUrl', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'encryptedApiKey', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** `[{ id, name, kind }]`，kind ∈ image | video | text。空数组 = 还没拉过模型清单。 */
      { name: 'models', kind: 'json', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'enabled', kind: 'boolean', optional: false, default: { type: 'literal', value: true }, updatedAt: false, unique: false },
      { name: 'status', kind: 'string', optional: false, default: { type: 'literal', value: 'unverified' }, updatedAt: false, unique: false },
      { name: 'errorMessage', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'lastCheckedAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  /*
   * 中转站（new-api / one-api 系）的**网站账号**（2026-09-25）。
   *
   * 一个用户一份（`uniques` 里有 `['userId']`）：Holy Light画布只连一个站，
   * 换站是「换账号」，不是「再加一个」。
   *
   * ⚠️ `encryptedPassword` 必须存：登录换来的 JWT 只有**一天**寿命，
   * 不存密码的话第二天打开就登不回去了，右上角余额和令牌列表也就跟着没了
   * —— 那等于「记住登录」根本没实现。密码用 `lib/providers/secret.ts` 的
   * `encryptSecret`（aes-256-gcm）落盘，读的时候才解。
   */
  SiteAccount: {
    name: 'SiteAccount',
    id: 'id',
    uniques: [['id'], ['userId']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: true },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'baseUrl', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'username', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** `encryptSecret(password)`。空串 = 没存（老数据或只存了令牌的情况）。 */
      { name: 'encryptedPassword', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** 登录换来的 JWT（`encryptSecret`）。过期了就用上面的密码重新登一次。 */
      { name: 'encryptedToken', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'tokenExpiresAt', kind: 'datetime', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      /** 站点回的显示名（可能和登录名不一样）。 */
      { name: 'siteUsername', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'group', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** 站点余额（单位 quota，不是元）。换算见 `site.ts` 的 `quotaPerYuan`。 */
      { name: 'quota', kind: 'int', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'usedQuota', kind: 'int', optional: true, default: { type: 'none' }, updatedAt: false, unique: false },
      /** 上一次失败的原因（站点原话）。成了就清空 —— 界面上不显示过期的错误。 */
      { name: 'lastError', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  /*
   * 资产的**自定义分类**（2026-09-26）。
   *
   * 改版前分类是写死的三选一（角色 / 场景 / 道具）、且只对图片生效；现在这张表由用户
   * 自己维护，**任何类型的资产都能打分类**。具体取舍见 `lib/asset-kinds.ts` 那段注释。
   *
   * `userId + name` 唯一：同一个名字在本人的列表里只能有一条，否则筛选器上会出现
   * 两颗长得一样、却筛出不同结果的 chip。（唯一约束由 `engine.ts` 的 `assertUnique` 挡，
   * SQLite 层刻意不建索引。）
   */
  AssetCategory: {
    name: 'AssetCategory',
    id: 'id',
    uniques: [['id'], ['userId', 'name']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'name', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** 列表里的排位，小的在前；没特意排过的都是 0，那时按 `createdAt` 先后。 */
      { name: 'sort', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
  /**
   * 工作流的**自定义分类**（2026-10-01 徐先：「分类我自己能加」）。
   *
   * 内置那五个（无参考 / 单图参考 / 多图参考 / 视频参考 / 音频 + 多图参考）是**代码里的枚举**，
   * 在 `lib/workflows/category.ts`；这张表只装用户自己起的分类。
   * 两边的值都存进 `WorkflowDraft.category` 那一列，**存的是名字本身**（与 `AssetCategory` 同一个取舍，
   * 好处是列表直接拿来显示、不用再查一次表；代价是改名要连带更新草稿 —— 见
   * `lib/workflows/customCategory.ts` 的 `renameWorkflowCategory`）。
   *
   * 🔴 因此读取那一步**不能只认枚举**：`readWorkflowCategory` 见到不认识的值要**原样保留**，
   * 否则用户刚起的分类名会在下一次读取时被悄悄换成「无参考」。
   */
  WorkflowCategoryItem: {
    name: 'WorkflowCategoryItem',
    id: 'id',
    uniques: [['id'], ['userId', 'name']],
    fields: [
      { name: 'id', kind: 'string', optional: false, default: { type: 'cuid' }, updatedAt: false, unique: false },
      { name: 'userId', kind: 'string', optional: false, default: { type: 'none' }, updatedAt: false, unique: false },
      { name: 'user', kind: 'string', optional: true, default: { type: 'none' }, updatedAt: false, unique: false, relation: { model: 'User', many: false, fk: 'userId', ref: 'id' } },
      { name: 'name', kind: 'string', optional: false, default: { type: 'literal', value: '' }, updatedAt: false, unique: false },
      /** 列表里的排位，小的在前；没特意排过的都是 0，那时按 `createdAt` 先后。 */
      { name: 'sort', kind: 'int', optional: false, default: { type: 'literal', value: 0 }, updatedAt: false, unique: false },
      { name: 'createdAt', kind: 'datetime', optional: false, default: { type: 'now' }, updatedAt: false, unique: false },
      { name: 'updatedAt', kind: 'datetime', optional: false, default: { type: 'none' }, updatedAt: true, unique: false },
    ],
  },
};

export const MODEL_NAMES = Object.keys(MODELS);
