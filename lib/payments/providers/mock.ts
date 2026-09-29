import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { storageRoot } from '@/lib/storage-root';
import type {
  ChargePayload, CreateChargeInput, CreateChargeResult, NotifyResult, PaymentProvider, QueryResult,
} from '../types';
import { mockPaymentsAllowed } from '../guard';

/**
 * 假支付网关。存在的唯一理由是：**在本地把「下单 → 支付 → 回调 → 到账」整条链路跑真。**
 *
 * 它刻意不省那一步 —— 模拟支付端点自己组装**带 HMAC 签名的回调报文**，
 * 再走一次真实 HTTP POST 打到 `/api/payments/notify/mock`。所以验签、金额核对、
 * 幂等、入账这些最容易出错的环节全都真的被执行了，而不是「进程内直接把订单改成已付」。
 * 后者看起来很省事，但等于把唯一值得测的部分（回调处理）从测试里摘掉了。
 *
 * **它自己维护一份独立的支付账**（`storage/mock-pay/<orderNo>.json`），
 * 和我们的 `PaymentOrder` 表是两个真相源 —— 这正是真实集成的样子。有了这份账，
 * `queryOrder` 才有意义，「回调丢了靠主动查单补上」这条兜底才验得出来。
 *
 * ⛔ 生产环境不可用（见 lib/payments/guard.ts）。一个能把任意订单标成已付的端点，
 * 就是「免登录自己给自己发积分」的后门。
 */

/** 回调报文里除 sign 外的字段。签名口径与微信/支付宝同构：明文参数 + HMAC 签名。 */
export const MOCK_FIELDS = ['orderNo', 'amountFen', 'tradeNo', 'status', 'timestamp'] as const;

/** 允许的时间偏差。回调是可重放的（对方会重试），但不能无限期可重放。 */
export const MOCK_MAX_SKEW_MS = 5 * 60 * 1000;

function secret() {
  return process.env.MOCK_PAY_SECRET?.trim() || '';
}

/**
 * 规范化签名串：只取非空字段、按 key 升序拼成 `k=v&k=v`。
 * **排序、剔空这两步必须和验签侧完全一致** —— 不一致就会变成「偶发验签失败」，
 * 而偶发的验签失败在支付场景里意味着用户付了钱到不了账。
 */
export function canonicalizeMockPayload(payload: Record<string, string>) {
  return Object.keys(payload)
    .filter(key => key !== 'sign' && payload[key] !== undefined && payload[key] !== '')
    .sort()
    .map(key => `${key}=${payload[key]}`)
    .join('&');
}

export function signMockPayload(payload: Record<string, string>, key = secret()) {
  return createHmac('sha256', key).update(canonicalizeMockPayload(payload), 'utf8').digest('hex');
}

/**
 * 验签。拿不到密钥、签名缺失、签名不符、时间戳过期，全部拒绝并给出原因。
 *
 * `timingSafeEqual` 要求两边等长，否则会抛 —— 所以先比长度。
 * 长度不等直接判失败不泄露额外信息（长度本来就不是秘密，签名算法是公开的）。
 */
export function verifyMockPayload(
  payload: Record<string, string>,
  key = secret(),
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  if (!key) return { ok: false, reason: '假网关未配置 MOCK_PAY_SECRET' };
  const sign = payload.sign || '';
  if (!sign) return { ok: false, reason: '回调缺少签名' };
  const expected = signMockPayload(payload, key);
  const given = Buffer.from(sign, 'utf8');
  const want = Buffer.from(expected, 'utf8');
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, reason: '回调签名不匹配' };
  const timestamp = Number(payload.timestamp);
  if (!Number.isFinite(timestamp)) return { ok: false, reason: '回调缺少时间戳' };
  if (Math.abs(now - timestamp) > MOCK_MAX_SKEW_MS) return { ok: false, reason: '回调已过期' };
  return { ok: true };
}

/** 假网关自己那份账，落在磁盘上，跨进程可见（dev server 可能有多个 worker）。 */
const ledgerRoot = path.join(storageRoot(), 'mock-pay');

export type MockLedgerEntry = {
  orderNo: string;
  amountFen: number;
  tradeNo: string;
  status: 'paid' | 'failed';
  paidAt: string;
};

/** 文件名来自 orderNo，所以这里必须挡住路径穿越（orderNo 是我们自己生成的，但别依赖这一点）。 */
function ledgerPath(orderNo: string) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(orderNo)) throw new Error('订单号格式不合法。');
  return path.join(ledgerRoot, `${orderNo}.json`);
}

export async function readMockLedger(orderNo: string): Promise<MockLedgerEntry | null> {
  try {
    const raw = await readFile(/*turbopackIgnore: true*/ ledgerPath(orderNo), 'utf8');
    return JSON.parse(raw) as MockLedgerEntry;
  } catch {
    return null;
  }
}

export async function writeMockLedger(entry: MockLedgerEntry) {
  await mkdir(/*turbopackIgnore: true*/ ledgerRoot, { recursive: true });
  await writeFile(/*turbopackIgnore: true*/ ledgerPath(entry.orderNo), JSON.stringify(entry, null, 2), 'utf8');
}

/** 生成一份签好名的回调报文。模拟支付端点拿它去 POST 我们自己的 notify 路由。 */
export function buildMockNotifyBody(input: {
  orderNo: string;
  amountFen: number;
  status?: 'paid' | 'failed';
  tradeNo?: string;
  now?: number;
}) {
  const payload: Record<string, string> = {
    orderNo: input.orderNo,
    amountFen: String(input.amountFen),
    tradeNo: input.tradeNo || `MOCK${randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase()}`,
    status: input.status || 'paid',
    timestamp: String(input.now ?? Date.now()),
  };
  payload.sign = signMockPayload(payload);
  return payload;
}

export const mockProvider: PaymentProvider = {
  name: 'mock',

  available() {
    return mockPaymentsAllowed() && Boolean(secret());
  },

  unavailableReason() {
    if (!mockPaymentsAllowed()) return '假网关已关闭（PAYMENTS_ALLOW_MOCK=0，或运行在生产环境）。';
    return '假网关缺少 MOCK_PAY_SECRET，无法签名与验签。请在 .env 里补一个随机串。';
  },

  /** 假网关不需要向外部要支付参数，前端直接给一个「模拟支付」按钮。 */
  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    const payload: ChargePayload = {
      mode: 'manual',
      note: `这是本地假网关，点「模拟支付」即可完成 ${input.orderNo} 的支付流程。`,
    };
    return { provider: 'mock', payload };
  },

  async parseNotify({ body }): Promise<NotifyResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { ok: false, reason: '回调不是合法 JSON' };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, reason: '回调格式不正确' };
    }
    const flat: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      flat[key] = String(value);
    }
    const checked = verifyMockPayload(flat);
    if (!checked.ok) return { ok: false, reason: checked.reason, raw: parsed };

    const orderNo = flat.orderNo || '';
    const amountFen = Number(flat.amountFen);
    if (!orderNo) return { ok: false, reason: '回调缺少订单号', raw: parsed };
    if (!Number.isInteger(amountFen) || amountFen <= 0) return { ok: false, reason: '回调金额不合法', raw: parsed };

    return {
      ok: true,
      orderNo,
      paid: flat.status === 'paid',
      amountFen,
      externalTradeNo: flat.tradeNo || undefined,
      raw: parsed,
    };
  },

  /**
   * 查单。读的是**假网关自己那份账**，不是我们的订单表 —— 读订单表等于自问自答，
   * 「回调丢了能不能补上」就永远测不出来。
   */
  async queryOrder(orderNo: string): Promise<QueryResult> {
    const entry = await readMockLedger(orderNo);
    if (!entry) return { status: 'pending' };
    return { status: entry.status, amountFen: entry.amountFen, externalTradeNo: entry.tradeNo };
  },

  async refund() {
    // 假网关没有真的钱可退。返回 ok:true 让上层把订单标成已退款，积分照常扣回。
    return { ok: true, note: '假网关：无真实资金往来' };
  },

  notifyAck() {
    return { body: JSON.stringify({ code: 0, message: 'ok' }), contentType: 'application/json' };
  },
};
