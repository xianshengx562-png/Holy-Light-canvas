'use client';

/*
 * 用户档案：改昵称 + 换头像。
 *
 * 桌面版**默认免登录**（`lib/auth/session.ts` 里那个「本机用户」），但 2026-09-25 起
 * **允许登录**：有会话时给「退出登录」，没有时给「登录 / 换账号」的入口 ——
 * 徐先问「怎么不能退出账号」，答案是它按设计被藏起来了，现在补成可选的。
 *
 * ⚠️ 桌面版的登录**不靠 cookie**：页面跑在 `app://` 下，Chromium 不为它存 cookie
 * （见 `src/lib/session-token.ts`）。所以这里登录是「调接口 → 拿回 token → 存 localStorage」，
 * 退出是「调接口 → 清掉 token」，全程没有整页跳转 —— web 版那套 `<form action="/api/auth/...">`
 * 在桌面版会被主进程的导航接管吃掉，点了就是没反应。
 *
 * 至于「以后要对接网站」：这一页刻意**不写任何关于网站的东西**（没有网站登录按钮、
 * 没有绑定入口，只有一个跳过去的链接）。到时候要加的是**另一块**（账号 / 同步），
 * 而不是把这一块改掉 —— 昵称和头像无论账号怎么变，都还是那两个字段。
 */
import { useEffect, useRef, useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import UserAvatar from '@/components/UserAvatar';
import { apiDelete, apiPost, useApi, type SessionUser } from '@/lib/client';
import { clearSessionToken, setSessionToken } from '@/lib/session-token';
import { isDesktop } from '@/lib/edition';
import {
  applySiteAccount, formatYuan, siteAccountLabel, useSiteAccount,
  type SiteAccountView,
} from '@/lib/site-account';
import './user.css';

const NAME_MAX = 40;
/** 徐先自己的中转站 —— 只是给「站点地址」一个默认值，手填别的站照样能用。 */
const DEFAULT_SITE = 'https://www.myvigna.top';
/** 与后端 `server/api/auth/me/route.ts` 的 `AVATAR_MAX` 一致，压完还是超了就在本地挡掉。 */
const AVATAR_MAX = 600_000;
const AVATAR_SIZE = 256;

type Notice = { kind: 'ok' | 'err'; text: string } | null;

/**
 * 把任意一张图**居中裁成方形**并压到 256×256，返回一个 data URL。
 *
 * 为什么非要过这一趟 canvas：头像在界面上最大也就显示到 96px，而用户可能选一张
 * 4000px 的手机照片（好几 MB）。原图一旦写进 `User.avatar`，此后每个页面问一次
 * `/api/auth/me` 都要把那几 MB 拉回来 —— 纯属白给。256px 够 @2x 显示，正常压完 ~30KB。
 *
 * ⚠️ 输出固定是 **PNG**，别图 JPEG 小：头像最终是圆形的，而 `toDataURL('image/jpeg')`
 * 会把**透明区域画成黑块** —— 那些自带透明的 PNG logo / 头像会被当场变成黑方块。
 * PNG 在同尺寸下体积未必占优，但它保住了透明，也不引这个坑。
 */
async function readAvatar(file: File): Promise<string> {
  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('这个环境不支持画布处理，换一张图试试。');
    /* cover 式居中裁：取短边当边长，两边各切掉一半多余部分 —— 不拉伸变形。 */
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    return canvas.toDataURL('image/png');
  } finally {
    /* ImageBitmap 占的是显存/位图内存，不是普通 JS 对象 —— 不 close 会被 GC 慢慢收，
       连着换几张头像就能看见内存涨上去。 */
    bitmap?.close();
  }
}

export default function UserPanel() {
  const { data, loading, reload } = useApi<SessionUser | null>('/api/auth/me');
  /* 桌面版免登录时 `me` 照样返回「本机用户」，只有这个字段能区分「真登录着」和「没登录」。 */
  const { data: session } = useApi<{ hasSession: boolean; local: boolean; email: string | null }>('/api/auth/session');
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  /* 账号那一块自己的忙碌态：登录 / 退出走接口，按钮要能在等待时变灰。 */
  const [accBusy, setAccBusy] = useState(false);
  const [accEmail, setAccEmail] = useState('');
  const [accPass, setAccPass] = useState('');
  /*
   * 桌面版这一块是**登录你的中转站网站**（2026-09-26 改）。
   *
   * 原来这里是「登录 Holy Light画布自己的账号」：徐先填了他网站的账号，看到的是
   * 「服务暂时不可用」（那其实是 zod 在抱怨邮箱格式），而他一直以为这里就是登录网站的地方。
   * 桌面版只有一个使用者（`lib/auth/session.ts` 的「本机用户」），多账号那套在这里既没用、
   * 又刚好长成最容易被误解的样子 —— 所以桌面版这一块换成站点账号，web 版原样保留。
   */
  const { site } = useSiteAccount();
  const siteLabel = siteAccountLabel(site);
  const [siteBusy, setSiteBusy] = useState(false);
  const [siteNote, setSiteNote] = useState<Notice>(null);
  const [siteUrl, setSiteUrl] = useState(DEFAULT_SITE);
  const [siteUser, setSiteUser] = useState('');
  const [sitePass, setSitePass] = useState('');
  /* 换文件时先把 value 清空 —— 不然「选同一张图第二次」不会再触发 change。 */
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!data) return;
    setName(data.name);
    setAvatar(data.avatar);
  }, [data]);

  const dirty = !!data && (name.trim() !== data.name || avatar !== data.avatar);

  async function pick(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      if (!file.type.startsWith('image/')) throw new Error('这不是图片文件。');
      const next = await readAvatar(file);
      if (next.length > AVATAR_MAX) throw new Error('压完还是有点大，换一张小一点的图试试。');
      setAvatar(next);
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : '读不了这张图。' });
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setNotice(null);
    try {
      const payload: Record<string, unknown> = { name: name.trim() };
      /* ⚠️ 只有「头像从有变无」才传 null —— 本来就没有头像还传 null，
         后端会照单全收，等于做了一次没有变化的写。 */
      if (avatar !== data?.avatar) payload.avatar = avatar;
      const res = await fetch('/api/auth/me', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error || '保存失败，稍后再试。');
      await reload();
      setNotice({ kind: 'ok', text: '已保存。' });
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : '保存失败，稍后再试。' });
    } finally {
      setSaving(false);
    }
  }

  /**
   * 登录 / 注册。桌面版拿回的是**令牌**（不是 cookie），存进 localStorage 之后
   * 每个请求自己带上（见 `src/lib/client.ts`）。
   *
   * 注册时的昵称就用上面「昵称」那一栏里现在的值 —— 少一个输入框，
   * 而且那本来就是这个人给自己起的名字。
   */
  async function account(mode: 'login' | 'register') {
    if (accBusy) return;
    const email = accEmail.trim();
    if (!email || accPass.length < 8) return;
    setAccBusy(true);
    setNotice(null);
    try {
      const body = mode === 'login'
        ? { email, password: accPass }
        : { name: name.trim() || data?.name || '本机账号', email, password: accPass };
      const out = await apiPost<{ ok?: boolean; token?: string }>(
        mode === 'login' ? '/api/auth/login' : '/api/auth/register',
        body,
      );
      if (!out.token) throw new Error('没有拿到登录凭据，稍后再试。');
      setSessionToken(out.token);
      setAccPass('');
      /*
       * 换账号＝换 userId，页面上每一块数据（项目、资产、画布…）都属于另一个人了。
       * 整页 reload 是这里最省事、也最不会漏掉某一块的刷新方式。
       */
      window.location.reload();
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : '登录失败，稍后再试。' });
    } finally {
      setAccBusy(false);
    }
  }

  async function logout() {
    if (accBusy) return;
    setAccBusy(true);
    setNotice(null);
    try {
      await apiPost<{ ok?: boolean }>('/api/auth/logout');
      clearSessionToken();
      window.location.reload();
    } catch (error) {
      setNotice({ kind: 'err', text: error instanceof Error ? error.message : '退出失败，稍后再试。' });
    } finally {
      setAccBusy(false);
    }
  }

  /**
   * 登录中转站的网站账号（桌面版这一块的默认动作）。
   *
   * 拿回来的那份账号信息**直接写进共享 store**（`applySiteAccount`）—— 页头余额、
   * 侧栏那张卡、模型服务页读的是同一份，不用谁再去打一趟站点。
   */
  async function siteLogin() {
    if (siteBusy) return;
    setSiteBusy(true);
    setSiteNote(null);
    try {
      const out = await apiPost<{ site: SiteAccountView }>('/api/site-account', {
        baseUrl: siteUrl.trim(),
        username: siteUser.trim(),
        password: sitePass,
      });
      applySiteAccount(out.site);
      /* 密码已经加密落盘（换令牌 / 续期都用库里那份），内存里这份清掉。 */
      setSitePass('');
      const who = out.site.username || out.site.loginName;
      setSiteNote({
        kind: 'ok',
        text: `已登录${who ? `（${who}）` : ''} —— 界面上的账号就是它了；模型服务页能直接列出这个账号的密钥。`,
      });
    } catch (error) {
      setSiteNote({ kind: 'err', text: error instanceof Error ? error.message : '登录站点失败。' });
    } finally {
      setSiteBusy(false);
    }
  }

  /** 换一个网站账号：整行删掉（连密码一起），回到登录表单。 */
  async function siteSwitch() {
    if (siteBusy) return;
    setSiteBusy(true);
    setSiteNote(null);
    try {
      await apiDelete('/api/site-account');
      applySiteAccount(null);
      setSiteUrl(site?.baseUrl || DEFAULT_SITE);
      setSiteUser(site?.loginName || '');
      setSitePass('');
      setSiteNote({ kind: 'ok', text: '已退出网站账号 —— 换一个登录。' });
    } catch (error) {
      setSiteNote({ kind: 'err', text: error instanceof Error ? error.message : '退不出来，稍后再试。' });
    } finally {
      setSiteBusy(false);
    }
  }

  function revert() {
    if (!data) return;
    setName(data.name);
    setAvatar(data.avatar);
    setNotice(null);
  }

  if (loading && !data) return <p className="user-loading" data-user-loading>正在读取…</p>;
  if (!data) return <p className="user-loading" data-user-error>读不到用户信息。</p>;

  /*
   * 版式（2026-09-26 重排）：**两列**，列宽靠 `auto-fit` 自适应，窄了自动塌成一列。
   *
   * 原来是单张 `max-width: 660px` 的卡片贴在左边 —— 1080 宽的窗口里右边三分之一全空着，
   * 看着像页面没做完。现在按「这块事归谁管」拆成两张各自带标题的卡：
   *   左列：个人资料（昵称 + 头像，**唯一带「保存」的一块**）
   *   右列：网站账号（另一组按钮、自己的状态行）
   *
   * 2026-09-26 晚：原来右列最上面还有一张「账号（只读）」卡（邮箱 + 用户 ID）。桌面版
   *    只有一个固定的本机用户，把这两样摆出来是纯噪音，站点账号在下面那张卡里也已经
   *    写得很清楚 —— 整张删掉。
   *
   * ⚠️ 「保存 / 撤销」只属于个人资料那一张卡。原来它和「登录站点」并排躺在同一张卡的底部，
   *    很容易读成「登录完也要点保存」—— 那两件事各有各的按钮，本来就不该挤在一起。
   */
  return (
    <div className="user-grid">
      <div className="user-col">
        <section className="user-card" data-user-card="profile" data-dirty={dirty ? 'yes' : 'no'}>
          <header className="user-card-head">
            <h2>个人资料</h2>
            <p className="user-hint">改完点「保存」才生效 —— 昵称和头像是一起提交的。</p>
          </header>

          <div className="user-head">
            <UserAvatar avatar={avatar} name={name || data.name} email={data.email}
              className="user-avatar" attrs={{ 'data-avatar': 'user' }} />
            <div className="user-head-body">
              <label className="user-field">
                <span className="user-label">昵称</span>
                <input
                  value={name}
                  data-user-name
                  maxLength={NAME_MAX}
                  placeholder="给自己起个名字"
                  onChange={e => { setName(e.target.value); setNotice(null); }}
                />
              </label>
              <p className="user-hint">
                没有头像的时候，界面上用这个昵称的第一个字代替。最多 {NAME_MAX} 个字。
              </p>
            </div>
          </div>

          <div className="user-actions">
            <span className="user-upload-wrap">
              <button
                className="secondary"
                data-user-upload
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                <Upload size={15} /> {avatar ? '换一张' : '上传头像'}
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                data-user-file
                onChange={e => pick(e.target.files?.[0])}
              />
            </span>
            {avatar && (
              <button className="subtle" data-user-clear disabled={busy} onClick={() => setAvatar(null)}>
                <Trash2 size={15} /> 移除
              </button>
            )}
          </div>
          <p className="user-hint user-note">
            支持 PNG / JPG / WebP / GIF，会按短边居中裁成方形、压到 256×256 存在本机。
          </p>

          <footer className="user-card-foot">
            <button className="button" data-user-save disabled={!dirty || saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="subtle" data-user-reset disabled={!dirty || saving} onClick={revert}>
              撤销
            </button>
            {notice && (
              <p className={`user-status ${notice.kind}`} data-user-status>{notice.text}</p>
            )}
          </footer>
        </section>
      </div>

      <div className="user-col">
        <section className="user-card" data-user-card="site">
          <header className="user-card-head">
            <h2>{isDesktop ? '网站账号' : '登录'}</h2>
            {isDesktop ? (
              <p className="user-hint">
                用你自己中转站（new-api 那种）的网站账号登录 —— 登录后这里显示的就是它，
                模型服务页也能直接列出这个账号的密钥。
              </p>
            ) : (
              <p className="user-hint">
                换一个账号就登到那个账号的项目上；本机这些没丢，退出登录就回来。
              </p>
            )}
          </header>

          <div className="user-account" data-user-account-panel="">
            {isDesktop ? (
              site?.loggedIn ? (
                <>
                  <div className="user-live">
                    <p className="user-live-who" data-user-site-account>{siteLabel}</p>
                    <div className="user-stats">
                      <div className="user-stat">
                        <span>分组</span>
                        <strong>{site.group || '—'}</strong>
                      </div>
                      <div className="user-stat">
                        <span>余额</span>
                        <strong>{formatYuan(site.remainingYuan)}</strong>
                      </div>
                      <div className="user-stat">
                        <span>站点密钥</span>
                        <strong>{site.tokens.length} 把</strong>
                      </div>
                    </div>
                  </div>
                  <div className="user-actions">
                    <button
                      className="subtle"
                      type="button"
                      data-user-site-switch
                      disabled={siteBusy}
                      onClick={siteSwitch}
                    >
                      {siteBusy ? '正在退出…' : '换账号'}
                    </button>
                    <a className="button secondary" href="#/settings/model-services" data-user-site-manage>
                      去模型服务页管密钥
                    </a>
                  </div>
                </>
              ) : (
                <>
                  <div className="user-form">
                    <label className="user-field">
                      <span className="user-label">站点地址</span>
                      <input
                        value={siteUrl}
                        data-user-site-url
                        onChange={e => { setSiteUrl(e.target.value); setSiteNote(null); }}
                      />
                    </label>
                    <div className="user-form-row">
                      <label className="user-field">
                        <span className="user-label">用户名</span>
                        <input
                          value={siteUser}
                          data-user-site-user
                          autoComplete="username"
                          onChange={e => { setSiteUser(e.target.value); setSiteNote(null); }}
                        />
                      </label>
                      <label className="user-field">
                        <span className="user-label">密码</span>
                        <input
                          value={sitePass}
                          data-user-site-pass
                          type="password"
                          autoComplete="current-password"
                          onChange={e => { setSitePass(e.target.value); setSiteNote(null); }}
                        />
                      </label>
                    </div>
                    <button
                      className="button"
                      type="button"
                      data-user-site-login
                      disabled={siteBusy || !siteUser.trim() || !sitePass}
                      onClick={siteLogin}
                    >
                      {siteBusy ? '登录中…' : '登录'}
                    </button>
                  </div>
                  <p className="user-hint">
                    密码只用来换调用令牌，加密存在本机；站点地址默认 {DEFAULT_SITE}，手填别的站也行。
                  </p>
                </>
              )
            ) : session?.hasSession ? (
              <>
                <p className="user-hint">
                  已登录 <strong>{session.email}</strong>。退出后回到「本机用户」（免登录），
                  这个账号下的项目、画布、资产都还在 —— 重新登录就看得见。
                </p>
                <button className="subtle" type="button" data-user-logout disabled={accBusy} onClick={logout}>
                  {accBusy ? '正在退出…' : '退出登录'}
                </button>
              </>
            ) : (
              <>
                <p className="user-hint">
                  现在是「本机用户」，桌面版默认免登录 —— 不登录也能正常用。
                  想换一个账号就在下面登录；<strong>换过去之后看到的是那个账号的项目</strong>，
                  本机这些没丢，退出登录就回来。
                </p>
                <div className="user-form">
                  <div className="user-form-row">
                    <label className="user-field">
                      <span className="user-label">邮箱</span>
                      <input
                        value={accEmail}
                        data-user-acc-email
                        type="email"
                        autoComplete="username"
                        onChange={e => { setAccEmail(e.target.value); setNotice(null); }}
                      />
                    </label>
                    <label className="user-field">
                      <span className="user-label">密码</span>
                      <input
                        value={accPass}
                        data-user-acc-pass
                        type="password"
                        autoComplete="current-password"
                        placeholder="至少 8 位"
                        onChange={e => { setAccPass(e.target.value); setNotice(null); }}
                      />
                    </label>
                  </div>
                  <div className="user-actions">
                    <button
                      className="button"
                      type="button"
                      data-user-login
                      disabled={accBusy || !accEmail.trim() || accPass.length < 8}
                      onClick={() => account('login')}
                    >
                      {accBusy ? '请稍候…' : '登录'}
                    </button>
                    <button
                      className="subtle"
                      type="button"
                      data-user-register
                      disabled={accBusy || !accEmail.trim() || accPass.length < 8}
                      onClick={() => account('register')}
                    >
                      注册并登录
                    </button>
                  </div>
                </div>
                <p className="user-hint">
                  没有账号就点「注册并登录」，昵称用上面那一栏（{data.name}）。
                  只想拿网站的调用凭据、不想换账号，就
                  <a href="#/settings/model-services" data-user-site> 去模型服务页用网站账号登录</a>。
                </p>
              </>
            )}
            {isDesktop && siteNote && (
              <p className={`user-status ${siteNote.kind}`} data-user-site-status>{siteNote.text}</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
