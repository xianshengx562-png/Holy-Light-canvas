/**
 * 支付渠道适配层的契约。
 *
 * 这个文件**刻意不引 `server-only`**，也不碰数据库 —— 纯逻辑才好在回归脚本里
 * 用 `typescript.transpileModule` 直接加载来测。签名的算法、验签的严格程度、
 * 「未配置时该报什么错」这类东西全在这里定死，换渠道时只实现接口、不改调用方。
 */

/** 下单时给渠道的输入。`orderNo` 是我们自己的单号，回调和查单都按它对齐。 */
export type CreateChargeInput = {
  orderNo: string;
  /** 单位「分」。渠道方收的也必须是分，不要在这一层换成元。 */
  amountFen: number;
  /** 商品标题，会显示在用户的支付页面上 */
  subject: string;
  /** 回调地址（必须是外网可达的绝对地址） */
  notifyUrl: string;
  /** 支付完成后跳回哪一页 */
  returnUrl?: string;
};

/**
 * 下发给前端的支付参数。三种形态覆盖了主流渠道：
 * 扫码（微信 Native / 支付宝当面付）、跳转（H5 / 网银）、JSAPI（微信内调起）。
 * `manual` 是假网关专用的：页面上给个「模拟支付」按钮就行。
 */
export type ChargePayload =
  | { mode: 'qr'; qrText: string }
  | { mode: 'redirect'; url: string }
  | { mode: 'jsapi'; params: Record<string, string> }
  | { mode: 'manual'; note: string };

export type CreateChargeResult = { provider: string; payload: ChargePayload };

/** 解析回调的结果。**验签失败必须走 ok:false**，那是唯一的真实性把关点。 */
export type NotifyResult =
  | {
      ok: true;
      orderNo: string;
      /** 对方说这笔钱付了没有。有的渠道会推「已关闭」这类非支付事件，所以要有这个字段。 */
      paid: boolean;
      amountFen: number;
      externalTradeNo?: string;
      /** 回调原文，落库留证 */
      raw: unknown;
    }
  | { ok: false; reason: string; raw?: unknown };

/** 主动查单的结果。回调会丢（网络抖动、回调地址配错、对方重试放弃），这是补单的兜底。 */
export type QueryResult = {
  status: 'pending' | 'paid' | 'failed';
  amountFen?: number;
  externalTradeNo?: string;
};

export interface PaymentProvider {
  readonly name: string;
  /**
   * 这个渠道现在能不能用（密钥、证书齐不齐）。
   * **不齐就明确报错，绝不静默降级到别的渠道** —— 静默降级意味着用户以为在付钱给微信，
   * 实际走的是假网关。
   */
  available(): boolean;
  /** 密钥缺失时给出的、能照着做的说明 */
  unavailableReason(): string;
  createCharge(input: CreateChargeInput): Promise<CreateChargeResult>;
  /** 解析 + 验签。签名不合法、时间戳过期、字段缺失，一律 ok:false。 */
  parseNotify(input: { headers: Record<string, string>; body: string }): Promise<NotifyResult>;
  queryOrder(orderNo: string): Promise<QueryResult>;
  /**
   * 回调处理成功后该回什么。
   *
   * **这不是小事**：各渠道的「收到并处理了」应答格式不一样，回错就等着被反复重推 ——
   * 而反复重推会一遍遍打到我们的幂等逻辑上，真出问题时会掩盖成「回调风暴」。
   * 既然它属于渠道契约，就放在适配器里，别写成路由里的 if-else。
   */
  notifyAck(): { body: string; contentType: string };
  /** 渠道支持退款时实现。返回 ok:false 时调用方**不能**改订单状态。 */
  refund?(input: { orderNo: string; amountFen: number; externalTradeNo?: string }): Promise<{ ok: boolean; note?: string }>;
}
