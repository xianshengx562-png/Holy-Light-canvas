/**
 * 设置页：站点地址 + 令牌 + 「测试连接」+ 模型选择。
 *
 * 「测试连接」就是拉一次 `/v1/models`（见 `providers/generateImage.ts` 的 `fetchCustomModels`）：
 * 拿到 N > 0 个模型才算通。🔴 不能拿 HTTP 200 当成功 —— 中转站的后台首页也是 200。
 *
 * 2026-10-13：界面改成对话式之后，模型从生图页挪到了这里。
 */
import { useState } from 'react';
import { fetchCustomModels } from '../providers/generateImage';
import { probeSite, type ProbeResult } from '../http/capacitorHttp';
import { probePaths } from '../http/networkFix';
import { DEFAULT_BASE_URL, type Settings, type SiteAccount } from '../storage';

type Props = {
  settings: Settings;
  onChange: (next: Settings) => void;
  /** 拉到的模型清单回填给父级（顺带缓存）。 */
  onModels: (models: string[]) => void;
  models: string[];
  model: string;
  onModel: (value: string) => void;
  account: SiteAccount | null;
  onGoAuth: () => void;
  onLogout: () => void;
};

export default function SettingsPage({
  settings,
  onChange,
  onModels,
  models,
  model,
  onModel,
  account,
  onGoAuth,
  onLogout,
}: Props) {
  const [draft, setDraft] = useState<Settings>(settings);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<ProbeResult[] | null>(null);
  const [fixing, setFixing] = useState(false);
  const [fixed, setFixed] = useState<string | null>(null);

  /** 原生通道被系统绑死时的自救：实测每条 socket 通路，看哪条能出站。 */
  const runFix = async () => {
    setFixing(true);
    setFixed(null);
    const result = await probePaths();
    if (result) {
      const lines = [
        `裸 socket：${result.raw}`,
        result.unbound ? `解绑后：${result.unbound}` : '',
        ...result.bound,
      ].filter(Boolean);
      setFixed(`通路探测 → ${result.best}\n${lines.join('\n')}`);
    } else {
      setFixed('这个环境没有原生探针。');
    }
    setFixing(false);
  };

  const test = async () => {
    setBusy(true);
    setNotice(null);
    const result = await fetchCustomModels({ baseUrl: draft.baseUrl, apiKey: draft.apiKey });
    if (result.ok) {
      onModels(result.models);
      setNotice({ kind: 'ok', text: `通了 —— 拿到 ${result.models.length} 个模型，在下面挑一个。` });
    } else {
      /* 上游原话直接显示：额度不足 / 鉴权失败 / 回的是网页，都比「网络错误」有用。 */
      setNotice({ kind: 'err', text: result.message });
    }
    setBusy(false);
  };

  const save = async () => {
    onChange({ baseUrl: draft.baseUrl.trim() || DEFAULT_BASE_URL, apiKey: draft.apiKey.trim() });
    setNotice({ kind: 'ok', text: '已保存。' });
  };

  /** 登不进去的时候先跑这个：两条出网通道各打一次，看是哪一层断了。 */
  const runProbe = async () => {
    setProbing(true);
    setProbe(null);
    const results = await probeSite(draft.baseUrl || DEFAULT_BASE_URL);
    setProbe(results);
    setProbing(false);
  };

  return (
    <div className="main">
      {/* 账号：登录过的话这里能直接看到是谁，也能一键退 */}
      <div className="card">
        <div className="card-title">账号</div>
        {account ? (
          <div className="account-card" style={{ marginBottom: 0, background: 'transparent', border: 'none', padding: 0 }}>
            <div className="account-avatar">{account.username.slice(0, 1).toUpperCase()}</div>
            <div className="account-info">
              <div className="account-name">{account.username}</div>
              <div className="hint" style={{ marginTop: 2 }}>
                JWT 到 {new Date(account.expiresAt).toLocaleDateString('zh-CN')} 过期 —— 过期了重新登录一次就行，令牌不受影响
              </div>
            </div>
            <button className="chip" onClick={onLogout}>
              退出
            </button>
          </div>
        ) : (
          <>
            <div className="hint" style={{ marginTop: 0, marginBottom: 12 }}>
              登录后在站点上自动建一把专用令牌，不用去后台复制 key。
            </div>
            <button className="btn" onClick={onGoAuth}>
              注册 / 登录站点账号
            </button>
          </>
        )}
      </div>

      <div className="card">
        <div className="card-title">接口</div>
        <div className="field">
          <label htmlFor="baseUrl">站点地址</label>
          <input
            id="baseUrl"
            type="url"
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder={DEFAULT_BASE_URL}
            value={draft.baseUrl}
            onChange={event => setDraft({ ...draft, baseUrl: event.target.value })}
          />
          <div className="hint">
            默认就是他那条中转站。地址里不需要自己加 /v1 —— 程序会把带 /v1 和不带的两种都试一遍。
          </div>
        </div>

        <div className="field">
          <label htmlFor="apiKey">令牌（sk-…）</label>
          <input
            id="apiKey"
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            placeholder="登录成功后会自动填，不用自己管"
            value={draft.apiKey}
            onChange={event => setDraft({ ...draft, apiKey: event.target.value })}
          />
          <div className="hint">也可以在中转站网页端的「API 令牌」页复制过来。只存在这台手机上。</div>
        </div>

        <button className="btn" onClick={test} disabled={busy}>
          {busy ? '连接中…' : '测试连接'}
        </button>

        {notice ? <div className={`notice ${notice.kind}`}>{notice.text}</div> : null}
      </div>

      <div className="card">
        <div className="card-title">出图模型</div>
        {models.length ? (
          <select id="model" value={model} onChange={event => onModel(event.target.value)}>
            {models.map(id => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        ) : (
          <div className="hint" style={{ marginTop: 0 }}>
            还没拉到清单 —— 先填好令牌，点上面的「测试连接」。
          </div>
        )}
        <div className="hint">
          已知能出图的：gpt-image-2 / gpt-image-2.5 / gemini-3-pro-image-preview。挑不准就先拿第一个试。
        </div>
      </div>

      <button className="btn ghost" onClick={save}>
        保存地址和令牌
      </button>

      <div className="card" style={{ marginTop: 14 }}>
        <div className="card-title">网络自检</div>
        <div className="hint" style={{ marginTop: 0, marginBottom: 10 }}>
          登不进去 / 生不出图时先跑一次：看是 App 的原生通道到不了站点，还是这台手机根本连不到它。
        </div>
        <button className="btn ghost" onClick={runProbe} disabled={probing}>
          {probing ? '检测中…' : '跑一次自检'}
        </button>
        {probe && !probe.every(row => row.channel.includes('原生') && row.ok) ? (
          <>
            <button className="btn ghost" style={{ marginTop: 8 }} onClick={runFix} disabled={fixing}>
              {fixing ? '自救中…' : '换一条能用的网络（自救）'}
            </button>
            {fixed ? <div className="hint" style={{ marginTop: 6 }}>{fixed}</div> : null}
          </>
        ) : null}
        {probe ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {probe.map(row => (
              <div key={row.channel} className={`notice ${row.ok ? 'ok' : 'err'}`} style={{ marginTop: 0 }}>
                {row.channel}：{row.ok ? '通' : '不通'}
                {' — '}
                {row.detail}
              </div>
            ))}
            <div className="hint">
              {(() => {
                const native = probe.find(row => row.channel.includes('原生'));
                const webNet = probe.find(row => row.channel.includes('网络层'));
                if (probe.every(row => !row.ok)) {
                  return '两条路都不通 = 这台手机的网络到不了这个站点（换流量 / 关 VPN 再试）。';
                }
                if (native && !native.ok && webNet && webNet.ok) {
                  return '原生被拦、WebView 网络层通 = 手机的系统网络引擎把本应用拦了（不是断网）。按顺序试：杀掉 App 重开 → 流量管理/联网管理里放行本应用 → 电池设为不受限制 → 重启手机（实测只有重启确定能解）。';
                }
                if (native && native.ok) {
                  return '原生通 = App 出网正常，登录不上就是账号/接口层面的问题了。';
                }
                return '原生不通 —— 看上面每行的具体原因。';
              })()}
            </div>
          </div>
        ) : null}
      </div>

      <div className="hint" style={{ marginTop: 18 }}>
        聊天记录不保存，退出 App 就没了；图生成后记得点「保存到相册」。
      </div>
    </div>
  );
}
