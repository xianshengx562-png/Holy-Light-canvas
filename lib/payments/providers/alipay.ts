import { sign as cryptoSign, verify as cryptoVerify } from 'node:crypto';
import type {
  CreateChargeInput, CreateChargeResult, NotifyResult, PaymentProvider, QueryResult,
} from '../types';

/**
 * 支付宝适配器（当面付 alipay.trade.precreate，扫码支付）。
 *
 * 设计要点（与微信同构，但回调是**表单**不是 JSON）：
 * - 不引 `server-only`、不碰数据库，纯逻辑好测。
 * - 下单走 `alipay.trade.precreate`，回一个 `qr_code`，前端渲染成二维码。也可改 `alipay.trade.wap.pay`
 *   走 `redirect` 模式（手机浏览器）。这里选当面付，因为计费页是桌面端、且 `ChargePayload` 已有 `qr` 形态。
 * - 回调是 `application/x-www-form-urlencoded`，带 `sign` / `sign_type`。验签用**支付宝公钥**
 *   （不是应用私钥）：把 `sign`/`sign_type` 剔掉、按 key 升序拼 `k=v&k=v` 再 RSA2 验。
 *   ⚠️ 排序、剔空两步必须和签名侧完全一致，否则就是「偶发验签失败」——支付里最难查的一类。
 * - **金额单位是元（字符串 `"39.00"`）**，必须换算成**分**再和 `order.amountFen` 比。
 *   别用浮点：`Number("39.00") * 100` 在某些值上会差一分。这里用整数运算拆整数/小数。
 *
 * 环境变量（缺一个 `available()` 就是 false）：
 *   ALIPAY_APP_ID / ALIPAY_PRIVATE_KEY（应用私钥，PKCS1 base64 或 PEM）
 *   ALIPAY_PUBLIC_KEY（支付宝公钥，用于验签，PKIX base64 或 PEM）
 *   可选 ALIPAY_GATEWAY（默认 https://openapi.alipay.com/gateway.do，沙箱另有地址）
 */

const REQUIRED_ENV = ['ALIPAY_APP_ID', 'ALIPAY_PRIVATE_KEY', 'ALIPAY_PUBLIC_KEY'];

function missingEnv() {
  return REQUIRED_ENV.filter(name => !process.env[name]?.trim());
}

function gateway(): string {
  return process.env.ALIPAY_GATEWAY?.trim() || 'https://openapi.alipay.com/gateway.do';
}

/** 支付宝私钥可能是 base64（PKCS1），没有 PEM 头就包一层。 */
function alipayPrivateKey(): string {
  const raw = process.env.ALIPAY_PRIVATE_KEY!.trim();
  if (raw.includes('BEGIN')) return raw;
  const b64 = raw.replace(/\s+/g, '');
  return `-----BEGIN RSA PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END RSA PRIVATE KEY-----`;
}

/** 支付宝公钥可能是 base64（PKIX），没有 PEM 头就包一层。 */
function alipayPublicKey(): string {
  const raw = process.env.ALIPAY_PUBLIC_KEY!.trim();
  if (raw.includes('BEGIN')) return raw;
  const b64 = raw.replace(/\s+/g, '');
  return `-----BEGIN PUBLIC KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PUBLIC KEY-----`;
}

// ───────────────────────── 纯函数：供回归脚本 roundtrip 自测 ─────────────────────────

/** 阿里系时间戳：必须是东八区 `YYYY-MM-DD HH:mm:ss`（他们按这个校验 ±15 分钟）。 */
export function alipayTimestamp(now = new Date()): string {
  const bj = new Date(now.getTime() + 8 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}:${p(bj.getUTCSeconds())}`;
}

/** 把参与签名的参数拼成待签串：剔掉 sign / sign_type，按 key 升序拼 `k=v&k=v`。 */
export function alipayCanonical(params: Record<string, string>): string {
  return Object.keys(params)
    .filter(k => k !== 'sign' && k !== 'sign_type' && params[k] !== undefined && params[k] !== null && params[k] !== '')
    .sort()
    .map(k => `${k}=${params[k]}`)
    .join('&');
}

/** RSA2（SHA256withRSA）签名，返回 base64。 */
export function buildAlipaySign(params: Record<string, string>, privateKeyPem: string): string {
  return cryptoSign('RSA-SHA256', Buffer.from(alipayCanonical(params), 'utf8'), privateKeyPem).toString('base64');
}

/** 验签。返回 false（签名不符 / 公钥无效）一律交给调用方拒绝入账。 */
export function verifyAlipaySign(params: Record<string, string>, publicKeyPem: string): boolean {
  const sign = params.sign || '';
  if (!sign) return false;
  try {
    return cryptoVerify('RSA-SHA256', Buffer.from(alipayCanonical(params), 'utf8'), publicKeyPem, Buffer.from(sign, 'base64'));
  } catch {
    return false;
  }
}

/**
 * 元 → 分，整数运算，绝不用浮点。
 * "39.00" → 3900；"39" → 3900；"39.5" → 3950；"0.01" → 1。
 */
export function yuanToFen(yuan: string): number {
  const clean = String(yuan).trim();
  const [intPartRaw, decPartRaw = ''] = clean.split('.');
  const intPart = intPartRaw === '' || intPartRaw === '-' ? '0' : intPartRaw;
  const decPart = (decPartRaw + '00').slice(0, 2);
  return Number(intPart) * 100 + Number(decPart);
}

/** 分 → 元字符串（请求 body 用）。3900 → "39.00"。 */
export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(Math.trunc(fen));
  return `${sign}${(abs / 100).toFixed(2)}`;
}

// ───────────────────────── 调支付宝开放接口 ─────────────────────────

async function alipayRequest(method: string, bizContent: Record<string, unknown>): Promise<{ code: string; [k: string]: unknown }> {
  const common: Record<string, string> = {
    app_id: process.env.ALIPAY_APP_ID!.trim(),
    method,
    format: 'JSON',
    charset: 'utf-8',
    sign_type: 'RSA2',
    timestamp: alipayTimestamp(),
    version: '1.0',
    biz_content: JSON.stringify(bizContent),
  };
  common.sign = buildAlipaySign(common, alipayPrivateKey());
  const body = new URLSearchParams(common).toString();
  const res = await fetch(gateway(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
    body,
  });
  const text = await res.text();
  const json = JSON.parse(text) as Record<string, any>;
  const node = json[`${method.replace(/\./g, '_')}_response`] as Record<string, unknown> | undefined;
  if (!node) throw new Error(`支付宝接口 ${method} 无响应节点：${text.slice(0, 300)}`);
  if (node.code !== '10000') {
    throw new Error(`支付宝接口 ${method} 失败：${String(node.code)} ${String(node.sub_msg || node.msg || '')}`);
  }
  return node as { code: string; [k: string]: unknown };
}

// ───────────────────────── 适配器本体 ─────────────────────────

export const alipayProvider: PaymentProvider = {
  name: 'alipay',

  available() {
    return missingEnv().length === 0;
  },

  unavailableReason() {
    const missing = missingEnv();
    return `支付宝未配置，缺少：${missing.join(' / ')}`;
  },

  /** 当面付预创建：返回 `qr_code`，前端渲染成二维码让用户扫。 */
  async createCharge(input: CreateChargeInput): Promise<CreateChargeResult> {
    if (missingEnv().length) throw new Error(this.unavailableReason());
    const node = await alipayRequest('alipay.trade.precreate', {
      out_trade_no: input.orderNo,
      total_amount: fenToYuan(input.amountFen),
      subject: input.subject,
      notify_url: input.notifyUrl,
    });
    const qrCode = node.qr_code;
    if (typeof qrCode !== 'string' || !qrCode) throw new Error('支付宝预创建未返回 qr_code。');
    return { provider: 'alipay', payload: { mode: 'qr', qrText: qrCode } };
  },

  /** 回调：表单参数 → 验签 → 取订单号/金额/状态。 */
  async parseNotify({ body }): Promise<NotifyResult> {
    const params = parseForm(body);
    if (!verifyAlipaySign(params, alipayPublicKey())) {
      return { ok: false, reason: '回调签名不匹配', raw: params };
    }
    const orderNo = params.out_trade_no || '';
    if (!orderNo) return { ok: false, reason: '回调缺少订单号', raw: params };
    const tradeStatus = params.trade_status || '';
    const paid = tradeStatus === 'TRADE_SUCCESS' || tradeStatus === 'TRADE_FINISHED';
    if (paid) {
      const amountFen = yuanToFen(params.total_amount || '0');
      if (!Number.isInteger(amountFen) || amountFen <= 0) {
        return { ok: false, reason: '回调金额不合法', raw: params };
      }
      return {
        ok: true,
        orderNo,
        paid,
        amountFen,
        externalTradeNo: params.trade_no || undefined,
        raw: params,
      };
    }
    return { ok: true, orderNo, paid: false, amountFen: 0, raw: params };
  },

  /** 主动查单：回调漏投时兜底补单。 */
  async queryOrder(orderNo: string): Promise<QueryResult> {
    if (missingEnv().length) throw new Error(this.unavailableReason());
    const node = await alipayRequest('alipay.trade.query', { out_trade_no: orderNo });
    const status = String(node.trade_status || '');
    if (status === 'TRADE_SUCCESS' || status === 'TRADE_FINISHED') {
      return {
        status: 'paid',
        amountFen: yuanToFen(String(node.total_amount || '0')),
        externalTradeNo: node.trade_no as string | undefined,
      };
    }
    if (status === 'TRADE_CLOSED') return { status: 'failed' };
    return { status: 'pending' };
  },

  /** 退款：调支付宝退款接口。 */
  async refund(input: { orderNo: string; amountFen: number; externalTradeNo?: string }): Promise<{ ok: boolean; note?: string }> {
    if (missingEnv().length) return { ok: false, note: this.unavailableReason() };
    try {
      await alipayRequest('alipay.trade.refund', {
        out_trade_no: input.orderNo,
        refund_amount: fenToYuan(input.amountFen),
        refund_reason: '用户退款',
      });
      return { ok: true, note: '支付宝退款受理' };
    } catch (error) {
      return { ok: false, note: errorMsg(error) };
    }
  },

  /** 支付宝要求回**纯文本 `success`**（不能是 JSON、不能带引号），否则会持续重推。 */
  notifyAck() {
    return { body: 'success', contentType: 'text/plain' };
  },
};

function parseForm(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  const url = new URLSearchParams(body);
  url.forEach((value, key) => { out[key] = value; });
  return out;
}

function errorMsg(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
