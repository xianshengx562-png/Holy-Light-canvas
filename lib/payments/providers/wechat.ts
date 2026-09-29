import { createDecipheriv, randomBytes, verify as cryptoVerify, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { storageRoot } from '@/lib/storage-root';
import type {
  CreateChargeInput, CreateChargeResult, NotifyResult, PaymentProvider, QueryResult,
} from '../types';

/**
 * 微信支付 v3 适配器（Native 扫码支付）。
 *
 * 设计要点（与 `mock.ts` 同构，但全是真链路）：
 * - 不引 `server-only`、不碰数据库，纯逻辑好测。
 * - 下单走 `/v3/pay/transactions/native`，回一个 `code_url`，前端拿去渲染二维码。
 * - 回调是 JSON + **平台证书签名 + AES-256-GCM 加密的 `resource`**。验签用 `Wechatpay-Serial`
 *   对应的**平台证书**（不是商户证书），通过后再用 APIv3 密钥解密 `resource`。
 * - **平台证书会轮换**：不能写死一份。这里做了内存 + 磁盘双缓存，遇到不认识的 serial 就主动
 *   去 `/v3/certificates` 拉一份新的（那份本身也是 APIv3 加密的，要再解一层）。
 * - 金额单位是**分**，直接跟 `order.amountFen` 比，对不上拒绝入账。
 *
 * 证书/密钥的环境变量（缺一个 `available()` 就是 false）：
 *   WECHAT_PAY_APPID / WECHAT_PAY_MCHID / WECHAT_PAY_SERIAL_NO（商户证书序列号）
 *   WECHAT_PAY_PRIVATE_KEY（商户私钥 PEM，多行可用 \n 转义）/ WECHAT_PAY_APIV3_KEY（回调解密）
 *   WECHAT_PAY_PLATFORM_CERT（平台证书 PEM，仅作兜底；优先走 /v3/certificates 动态获取）
 *
 * ⚠️ `notify_url` 必须是外网可达的 https，微信不接受 IP 与 http。本机没公网入口，
 * 所以这个适配器只有部署之后才真正验证得了回调。
 */

const REQUIRED_ENV = [
  'WECHAT_PAY_APPID',
  'WECHAT_PAY_MCHID',
  'WECHAT_PAY_SERIAL_NO',
  'WECHAT_PAY_PRIVATE_KEY',
  'WECHAT_PAY_APIV3_KEY',
];

function missingEnv() {
  return REQUIRED_ENV.filter(name => !process.env[name]?.trim());
}

/** 商户私钥：把可能的 `\n` 转义还原成真实换行，再交给 crypto。 */
function merchantPrivateKey(): string {
  return String(process.env.WECHAT_PAY_PRIVATE_KEY || '').replace(/\\n/g, '\n').trim();
}

function apiv3Key(): Buffer {
  const raw = String(process.env.WECHAT_PAY_APIV3_KEY || '').trim();
  if (!raw) throw new Error('缺少 WECHAT_PAY_APIV3_KEY');
  // APIv3 密钥是 32 字节；用户可能填了 base64 也可能是原始 32 字符，统一按「原始字节」处理：
  // 若正好是 32 位可打印字符直接当字节，否则按 base64 解码。
  if (raw.length === 32) return Buffer.from(raw, 'utf8').subarray(0, 32);
  return Buffer.from(raw, 'base64');
}

const API_BASE = 'https://api.mch.weixin.qq.com';

// ───────────────────────── 纯函数：供回归脚本 roundtrip 自测 ─────────────────────────

/**
 * 构造微信 v3 请求签名串与 Authorization 头。
 * 签名原文：`{method}\n{url}\n{timestamp}\n{nonce}\n{body}\n`（body 为空串时仍是 `\n`）。
 */
export function wechatAuthHeaders(input: {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  mchid: string;
  serialNo: string;
  privateKeyPem: string;
  timestamp?: string;
  nonce?: string;
}): Record<string, string> {
  const timestamp = input.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? randomBytes(16).toString('hex');
  const body = input.body ?? '';
  const message = `${input.method}\n${input.url}\n${timestamp}\n${nonce}\n${body}\n`;
  const signature = cryptoSign('RSA-SHA256', Buffer.from(message, 'utf8'), input.privateKeyPem).toString('base64');
  return {
    Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${input.mchid}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${input.serialNo}"`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'frame-payments/1.0',
  };
}

/**
 * 验签：回调原文 `{timestamp}\n{nonce}\n{body}\n` 用平台证书验 RSA-SHA256。
 * 返回 false 的情况（签名不符、证书缺失）一律交给调用方拒绝入账。
 */
export function wechatVerifySignature(input: {
  timestamp: string;
  nonce: string;
  body: string;
  signature: string;
  publicCertPem: string;
}): boolean {
  const message = `${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  try {
    return cryptoVerify(
      'RSA-SHA256',
      Buffer.from(message, 'utf8'),
      input.publicCertPem,
      Buffer.from(input.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

/**
 * 解密回调里的 `resource`（AES-256-GCM）。
 * `ciphertext` 是 base64，最后 16 字节是 authTag；`associated_data` 可空。
 */
export function wechatDecryptResource(resource: {
  ciphertext: string;
  nonce: string;
  associated_data?: string | null;
}, key: Buffer): unknown {
  const data = Buffer.from(resource.ciphertext, 'base64');
  const authTag = data.subarray(data.length - 16);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(resource.nonce, 'utf8'));
  cipher.setAuthTag(authTag);
  if (resource.associated_data) cipher.setAAD(Buffer.from(resource.associated_data, 'utf8'));
  const plaintext = Buffer.concat([
    cipher.update(data.subarray(0, data.length - 16)),
    cipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

// ───────────────────────── 平台证书缓存（轮换） ─────────────────────────

type CertEntry = { serial: string; cert: string; expireAt: number };

const certCache = new Map<string, CertEntry>();
const certFile = path.join(storageRoot(), 'wechat-certs.json');

function loadCertCache() {
  if (certCache.size > 0) return;
  try {
    if (existsSync(/*turbopackIgnore: true*/ certFile)) {
      const arr = JSON.parse(readFileSync(/*turbopackIgnore: true*/ certFile, 'utf8')) as CertEntry[];
      for (const e of arr) certCache.set(e.serial, e);
    }
  } catch {
    /* 缓存读不到就当没有，下次重新拉 */
  }
}

function persistCertCache() {
  try {
    mkdirSync(/*turbopackIgnore: true*/ path.dirname(certFile), { recursive: true });
    writeFileSync(/*turbopackIgnore: true*/ certFile, JSON.stringify([...certCache.values()]), 'utf8');
  } catch {
    /* 落盘失败不影响内存缓存 */
  }
}

/** 兜底：把 .env 里写死的平台证书也塞进缓存，省得没配 /v3/certificates 时就完全用不了。 */
function seedStaticPlatformCert() {
  const staticCert = process.env.WECHAT_PAY_PLATFORM_CERT?.trim();
  if (staticCert && !certCache.has('static')) {
    certCache.set('static', { serial: 'static', cert: staticCert, expireAt: Number.MAX_SAFE_INTEGER });
  }
}

/**
 * 取平台证书公钥。优先内存/磁盘缓存；不认识这个 serial 就去 `/v3/certificates` 拉一份新的。
 * 拉回来的证书本身也是 APIv3 加密的，要先解一层。
 */
async function platformCertFor(serial: string): Promise<string> {
  loadCertCache();
  seedStaticPlatformCert();
  const now = Date.now();
  const cached = certCache.get(serial);
  if (cached && cached.expireAt > now) return cached.cert;

  const list = await fetchPlatformCerts();
  for (const e of list) certCache.set(e.serial, e);
  persistCertCache();

  const fresh = certCache.get(serial);
  if (!fresh) throw new Error(`微信平台证书序列号 ${serial} 不在已下载列表中。`);
  return fresh.cert;
}

async function fetchPlatformCerts(): Promise<CertEntry[]> {
  const mchid = process.env.WECHAT_PAY_MCHID!.trim();
  const serialNo = process.env.WECHAT_PAY_SERIAL_NO!.trim();
  const headers = wechatAuthHeaders({
    method: 'GET', url: '/v3/certificates', mchid, serialNo, privateKeyPem: merchantPrivateKey(),
  });
  const res = await fetch(`${API_BASE}/v3/certificates`, { method: 'GET', headers });
  if (!res.ok) {
    throw new Error(`拉取微信平台证书失败：HTTP ${res.status}`);
  }
  const json = await res.json() as { data?: Array<{
    serial_no: string; effective_time: string; expire_time: string;
    encrypt_certificate: { algorithm: string; nonce: string; associated_data?: string; ciphertext: string };
  }> };
  const key = apiv3Key();
  return (json.data ?? []).map(item => {
    const certText = String(wechatDecryptResource(item.encrypt_certificate, key));
    return {
      serial: item.serial_no,
      cert: certText,
      expireAt: Date.parse(item.expire_time) || Number.MAX_SAFE_INTEGER,
    };
  });
}

// ───────────────────────── 调微信开放接口 ─────────────────────────

async function wechatRequest<T>(method: 'GET' | 'POST', urlPath: string, bodyObj?: unknown): Promise<T> {
  const body = bodyObj ? JSON.stringify(bodyObj) : '';
  const headers = wechatAuthHeaders({
    method, url: urlPath, body,
    mchid: process.env.WECHAT_PAY_MCHID!.trim(),
    serialNo: process.env.WECHAT_PAY_SERIAL_NO!.trim(),
    privateKeyPem: merchantPrivateKey(),
  });
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers,
    body: method === 'POST' ? body : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`微信接口 ${urlPath} 返回 ${res.status}：${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as T;
}

// ───────────────────────── 适配器本体 ─────────────────────────

export const wechatPayProvider: PaymentProvider = {
  name: 'wechat',

  available() {
    return missingEnv().length === 0;
  },

  unavailableReason() {
    const missing = missingEnv();
    return `微信支付未配置，缺少：${missing.join(' / ')}`;
  },

  /** Native 下单：返回 `code_url`，前端渲染成二维码让用户扫。 */
  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    if (missingEnv().length) throw new Error(this.unavailableReason());
    const resp = await wechatRequest<{ code_url?: string }>('POST', '/v3/pay/transactions/native', {
      appid: process.env.WECHAT_PAY_APPID!.trim(),
      mchid: process.env.WECHAT_PAY_MCHID!.trim(),
      description: input.subject,
      notify_url: input.notifyUrl,
      out_trade_no: input.orderNo,
      amount: { total: input.amountFen, currency: 'CNY' },
    });
    if (!resp.code_url) throw new Error('微信 Native 下单未返回 code_url。');
    return { provider: 'wechat', payload: { mode: 'qr', qrText: resp.code_url } };
  },

  /** 回调：验签 → 解密 resource → 取订单号/金额/状态。任一环节失败都 ok:false。 */
  async parseNotify({ headers, body }): Promise<NotifyResult> {
    const signature = headers['wechatpay-signature'] || '';
    const timestamp = headers['wechatpay-timestamp'] || '';
    const nonce = headers['wechatpay-nonce'] || '';
    const serial = headers['wechatpay-serial'] || '';
    if (!signature || !timestamp || !nonce || !serial) {
      return { ok: false, reason: '回调缺少微信签名头' };
    }
    // 时间戳防重放（5 分钟）
    if (Math.abs(Number(timestamp) * 1000 - Date.now()) > 5 * 60 * 1000) {
      return { ok: false, reason: '回调时间戳过期' };
    }
    let cert: string;
    try {
      cert = await platformCertFor(serial);
    } catch (error) {
      return { ok: false, reason: `无法获取微信平台证书：${errorMsg(error)}` };
    }
    if (!wechatVerifySignature({ timestamp, nonce, body, signature, publicCertPem: cert })) {
      return { ok: false, reason: '回调签名不匹配' };
    }
    let decrypted: { out_trade_no: string; transaction_id?: string; trade_state: string; amount?: { total?: number } };
    try {
      decrypted = wechatDecryptResource(
        JSON.parse(body).resource as { ciphertext: string; nonce: string; associated_data?: string | null },
        apiv3Key(),
      ) as typeof decrypted;
    } catch {
      return { ok: false, reason: '回调 resource 解密失败' };
    }
    const orderNo = decrypted.out_trade_no;
    if (!orderNo) return { ok: false, reason: '回调缺少订单号' };
    const paid = decrypted.trade_state === 'SUCCESS';
    const amountFen = decrypted.amount?.total;
    if (paid && (typeof amountFen !== 'number' || !Number.isInteger(amountFen) || amountFen <= 0)) {
      return { ok: false, reason: '回调金额不合法' };
    }
    return {
      ok: true,
      orderNo,
      paid,
      amountFen: paid ? amountFen! : 0,
      externalTradeNo: decrypted.transaction_id,
      raw: JSON.parse(body),
    };
  },

  /** 主动查单：回调漏投时兜底补单。 */
  async queryOrder(orderNo: string): Promise<QueryResult> {
    if (missingEnv().length) throw new Error(this.unavailableReason());
    const mchid = process.env.WECHAT_PAY_MCHID!.trim();
    const resp = await wechatRequest<{
      trade_state: string; transaction_id?: string; amount?: { total?: number };
    }>('GET', `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(mchid)}`);
    const state = resp.trade_state;
    if (state === 'SUCCESS') {
      return { status: 'paid', amountFen: resp.amount?.total, externalTradeNo: resp.transaction_id };
    }
    if (state === 'CLOSED' || state === 'REVOKED' || state === 'PAYERROR') {
      return { status: 'failed' };
    }
    return { status: 'pending' };
  },

  /** 退款：调微信退款接口。微信退款是异步的（成功以退款回调为准），这里只确认接口受理，
   * 真正标记本地已退款由调用方（orders.ts）在拿到 ok 之后做。 */
  async refund(input: { orderNo: string; amountFen: number; externalTradeNo?: string }): Promise<{ ok: boolean; note?: string }> {
    if (missingEnv().length) return { ok: false, note: this.unavailableReason() };
    try {
      const resp = await wechatRequest<{ refund_id?: string; status?: string }>('POST', '/v3/refund/domestic/refunds', {
        out_trade_no: input.orderNo,
        ...(input.externalTradeNo ? { transaction_id: input.externalTradeNo } : {}),
        amount: { refund: input.amountFen, total: input.amountFen, currency: 'CNY' },
        reason: '用户退款',
      });
      if (!resp.refund_id) return { ok: false, note: '微信退款接口未返回 refund_id' };
      return { ok: true, note: `微信退款受理：${resp.refund_id}` };
    } catch (error) {
      return { ok: false, note: errorMsg(error) };
    }
  },

  /** 微信 v3 要求回 200 + `{"code":"SUCCESS","message":"成功"}`，否则会持续重推。 */
  notifyAck() {
    return { body: JSON.stringify({ code: 'SUCCESS', message: '成功' }), contentType: 'application/json' };
  },
};

function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
