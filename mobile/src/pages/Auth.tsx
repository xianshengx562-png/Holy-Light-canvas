/**
 * 站点账号：登录 / 注册 + 自动开通（规格 §4.2 那一版）。
 *
 * 登录（或注册）成功之后**自动做三件事**：找到/建那把专用令牌 → 取完整密钥 → 拉一次模型清单，
 * 然后把 key 写进设置 —— 用户不需要去站点后台复制 `sk-...` 再粘回来。
 *
 * 界面上两处措辞是故意这么写的：
 *  - 验证码按钮**不写「已发送」**：站点对不存在的邮箱也回 success（见 `providers/site.ts` 头注 5）；
 *  - 「注册并开通」失败时明确说**账号已经建好了**：这趟失败也不该让用户再注册一遍。
 */
import { useState } from 'react';
import {
  loginSite,
  provisionApiKey,
  registerAndProvision,
  sendSiteEmailCode,
  type SiteSession,
} from '../providers/site';

export type AuthDone = { apiKey: string; models: string[]; username: string; jwt: string; expiresAt: number };

type Props = {
  baseUrl: string;
  onDone: (done: AuthDone) => void;
  onBack: () => void;
};

export default function AuthPage({ baseUrl, onDone, onBack }: Props) {
  const [tab, setTab] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const sendCode = async () => {
    setBusy('code');
    setNotice(null);
    const outcome = await sendSiteEmailCode(baseUrl, email);
    if (outcome.ok) {
      setNotice({
        kind: 'ok',
        text: '站点说这一步过了。如果邮箱没写错，验证码应该在路上了 —— 收不到翻一下垃圾邮件。',
      });
    } else {
      setNotice({ kind: 'err', text: outcome.message });
    }
    setBusy('');
  };

  /** 登录 / 注册拿到 JWT 之后共用的那一段：自动开通 → 回填。 */
  const finish = async (session: SiteSession, loginName: string) => {
    const provisioned = await provisionApiKey(baseUrl, session.jwt);
    if (!provisioned.ok) {
      setNotice({ kind: 'err', text: provisioned.message });
      return;
    }
    onDone({
      apiKey: provisioned.value.apiKey,
      models: provisioned.value.models,
      username: loginName,
      jwt: session.jwt,
      expiresAt: session.expiresAt,
    });
  };

  const login = async () => {
    setBusy('login');
    setNotice(null);
    const session = await loginSite(baseUrl, username, password);
    if (!session.ok) {
      setNotice({ kind: 'err', text: session.message });
      setBusy('');
      return;
    }
    await finish(session.value, username.trim());
    setBusy('');
  };

  const register = async () => {
    setBusy('register');
    setNotice(null);
    const outcome = await registerAndProvision({ baseUrl, username, password, email, code });
    if (!outcome.ok) {
      setNotice({ kind: 'err', text: outcome.message });
      setBusy('');
      return;
    }
    const { session, provisioned } = outcome.value;
    onDone({
      apiKey: provisioned.apiKey,
      models: provisioned.models,
      username: username.trim(),
      jwt: session.jwt,
      expiresAt: session.expiresAt,
    });
    setBusy('');
  };

  const busyNow = busy !== '';

  return (
    <div className="main">
      <div className="tabs">
        <button
          className={`tab ${tab === 'login' ? 'on' : ''}`}
          onClick={() => setTab('login')}
          disabled={busyNow}
        >
          登录
        </button>
        <button
          className={`tab ${tab === 'register' ? 'on' : ''}`}
          onClick={() => setTab('register')}
          disabled={busyNow}
        >
          注册
        </button>
      </div>

      <div className="auth-head">
        <div className="auth-title">{tab === 'login' ? '登录站点账号' : '创建站点账号'}</div>
        <div className="auth-sub">
          {tab === 'login' ? '登进去就自动把出图令牌开好' : '注册后自动登录并开通，不用再管 key'}
        </div>
      </div>

      <div className="card">
        <div className="card-title">站点</div>
        <div className="static-field">{baseUrl}</div>
        <div className="hint">地址在设置页改。令牌就建在这个站点上。</div>
      </div>

      {tab === 'login' ? (
        <div className="card">
          <div className="card-title">账号密码</div>
          <div className="field">
            <label htmlFor="auth-user">用户名</label>
            <input
              id="auth-user"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={username}
              onChange={event => setUsername(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-pass">密码</label>
            <input
              id="auth-pass"
              type="password"
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </div>
          <button className="btn" onClick={login} disabled={busyNow || !username.trim() || !password}>
            {busy === 'login' ? '登录中…' : '登录并开通'}
          </button>
        </div>
      ) : (
        <div className="card">
          <div className="card-title">注册信息</div>
          <div className="field">
            <label htmlFor="auth-new-user">用户名</label>
            <input
              id="auth-new-user"
              type="text"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              placeholder="3 位以上，21 个字符太长会被拒"
              value={username}
              onChange={event => setUsername(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-email">邮箱</label>
            <input
              id="auth-email"
              type="email"
              inputMode="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={email}
              onChange={event => setEmail(event.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="auth-code">邮箱验证码</label>
            <div className="inline-field">
              <input
                id="auth-code"
                type="text"
                inputMode="numeric"
                value={code}
                onChange={event => setCode(event.target.value)}
              />
              <button className="chip" onClick={sendCode} disabled={busyNow || !email.trim()}>
                {busy === 'code' ? '发送中…' : '获取验证码'}
              </button>
            </div>
          </div>
          <div className="field">
            <label htmlFor="auth-new-pass">密码</label>
            <input
              id="auth-new-pass"
              type="password"
              placeholder="至少 8 位"
              value={password}
              onChange={event => setPassword(event.target.value)}
            />
          </div>
          <button
            className="btn"
            onClick={register}
            disabled={busyNow || !username.trim() || !email.trim() || !password}
          >
            {busy === 'register' ? '注册中…' : '注册并开通'}
          </button>
        </div>
      )}

      {notice ? <div className={`notice ${notice.kind}`}>{notice.text}</div> : null}

      <button className="btn ghost" style={{ marginTop: 16 }} onClick={onBack} disabled={busyNow}>
        返回
      </button>
    </div>
  );
}
