/**
 * 手机端就三屏：聊天 / 设置 / 账号（登录注册）。没有路由库，一个 `view` 状态够了。
 *
 * 🔴 这个 App **不碰**桌面端那套画布 / 项目 / 数据库，也不碰本地 ComfyUI 和本地大模型 ——
 * 它的全部职责是：拿令牌打一次 OpenAI 兼容的文生图接口，把回来的图显示出来。
 *
 * 会话只存在内存里（规格 A4：不做历史记录）。
 */
import { useEffect, useRef, useState } from 'react';
import SettingsPage from './pages/Settings';
import ChatPage, { type ChatMessage } from './pages/Chat';
import AuthPage, { type AuthDone } from './pages/Auth';
import { generateCustomImage } from './providers/generateImage';
import { probeSite } from './http/capacitorHttp';
import { saveToGallery } from './save';
import {
  loadSettings,
  saveSettings,
  loadLastModel,
  saveLastModel,
  loadCachedModels,
  saveCachedModels,
  loadAccount,
  saveAccount,
  clearAccount,
  type Settings,
  type SiteAccount,
} from './storage';

export default function App() {
  /*
   * 默认模型：**不能拿清单第一个**。
   * 2026-10-13 实测：清单第一个是 `gemini-3.1-flash-image-preview`，站点那边「分组 image 下
   * 该模型的可用渠道不存在」直接 500 —— 拉得到清单不等于能出图。
   * 徐先指定的型号排第一（gpt-image-2.5-sunburst），往下是其它实测能出图的 gpt-image。
   */
  const PREFERRED_MODELS = [
    'gpt-image-2.5-sunburst',
    'gpt-image-2.5',
    'gpt-image-2',
    'gemini-3-pro-image-preview',
  ];
  const pickDefault = (list: string[]) =>
    PREFERRED_MODELS.find(id => list.includes(id)) ||
    list.find(id => /^gpt-image/i.test(id)) ||
    list.find(id => /image/i.test(id)) ||
    list[0] ||
    '';
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<'chat' | 'settings' | 'auth'>('chat');
  const [settings, setSettings] = useState<Settings>({ baseUrl: '', apiKey: '' });
  const [account, setAccount] = useState<SiteAccount | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [model, setModel] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [busy, setBusy] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    void (async () => {
      const [loaded, cached, last, who] = await Promise.all([
        loadSettings(),
        loadCachedModels(),
        loadLastModel(),
        loadAccount(),
      ]);
      setSettings(loaded);
      setModels(cached);
      /* 上次选的模型还在清单里才沿用，否则按「能出图的优先」挑。 */
      setModel(cached.includes(last) ? last : pickDefault(cached));
      setAccount(who);
      setReady(true);
    })();
  }, []);

  /*
   * 每次启动自动跑一次网络自检，结果打进控制台（`adb logcat` 能抓到）。
   * 2026-10-13 加的：手机上 shell 里 `nc` 测 TCP 443 是通的，但 App 就是登不进去 ——
   * 只能靠真机日志把两条通道的结果分别打出来，不然全靠猜。
   */
  useEffect(() => {
    if (!ready || !settings.baseUrl) return;
    void (async () => {
      const results = await probeSite(settings.baseUrl);
      console.error('[hl-probe] ' + JSON.stringify(results));
    })();
  }, [ready, settings.baseUrl]);

  const applySettings = async (next: Settings) => {
    setSettings(next);
    await saveSettings(next);
  };

  const applyModels = async (list: string[]) => {
    setModels(list);
    await saveCachedModels(list);
    if (list.length && !list.includes(model)) setModel(list[0]);
  };

  /** 登录/注册回来：key 和模型清单都有了，直接回聊天页。 */
  const applyAuth = async (done: AuthDone) => {
    await applySettings({ baseUrl: settings.baseUrl, apiKey: done.apiKey });
    await applyModels(done.models);
    const next: SiteAccount = { username: done.username, jwt: done.jwt, expiresAt: done.expiresAt };
    setAccount(next);
    await saveAccount(next);
    await saveLastModel(pickDefault(done.models) || done.models[0] || '');
    setView('chat');
  };

  const logout = async () => {
    await clearAccount();
    setAccount(null);
  };

  const send = async (prompt: string) => {
    if (busy) return;
    const userId = ++seq.current;
    const botId = ++seq.current;
    setMessages(m => [
      ...m,
      { role: 'user', id: userId, text: prompt },
      { role: 'assistant', id: botId, state: 'pending', prompt },
    ]);
    setBusy(true);
    const outcome = await generateCustomImage(settings, { model, prompt });
    const success = outcome.status === 'SUCCESS' && outcome.results.length > 0;
    setMessages(m =>
      m.map(message => {
        if (message.id !== botId) return message;
        if (success) {
          return {
            role: 'assistant',
            id: botId,
            state: 'done',
            prompt,
            result: outcome.results[0],
          } as ChatMessage;
        }
        /* 上游原话（额度 / 鉴权 / 回的是网页）一律原样显示，不改成「网络错误」。 */
        return {
          role: 'assistant',
          id: botId,
          state: 'failed',
          prompt,
          error: outcome.errorMessage || '生成失败，但没有拿到失败原因。',
        } as ChatMessage;
      }),
    );
    setBusy(false);
    void saveLastModel(model);

    /*
     * 自动落盘（2026-10-13）：出图成功就立刻存相册，不等他点按钮 ——
     * 会话不落盘（规格 A4），退出就没了，图必须当场保住。
     * 保存完把结果写回气泡；失败了他还能点「保存到相册」重试。
     */
    if (success) {
      const result = outcome.results[0];
      const saved = await saveToGallery(result);
      setMessages(m =>
        m.map(message =>
          message.id === botId && message.role === 'assistant' && message.state === 'done'
            ? {
                ...message,
                autoSave: saved.ok
                  ? '已自动存入相册 ✓'
                  : `自动保存没成（${saved.message}）—— 点下面「保存到相册」再试。`,
              }
            : message,
        ),
      );
    }
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <div className="brand-mark">光</div>
          <div className="brand-text">
            <div className="brand-title">
              {view === 'settings' ? '设置' : view === 'auth' ? '站点账号' : 'Holy Light画布'}
            </div>
            <div className="brand-sub">
              {view === 'settings'
                ? '站点、令牌、模型'
                : view === 'auth'
                  ? '登录后自动开通令牌'
                  : model || '还没有模型清单'}
            </div>
          </div>
        </div>
        <div className="spacer" />
        {view === 'settings' ? (
          <button className="iconbtn" onClick={() => setView('chat')}>
            完成
          </button>
        ) : view === 'auth' ? (
          <button className="iconbtn" onClick={() => setView('settings')} disabled={busy}>
            取消
          </button>
        ) : (
          <button className="iconbtn" onClick={() => setView('settings')}>
            设置
          </button>
        )}
      </div>

      {!ready ? (
        <div className="main">
          <div className="empty">读取设置…</div>
        </div>
      ) : view === 'settings' ? (
        <SettingsPage
          settings={settings}
          onChange={applySettings}
          onModels={applyModels}
          models={models}
          model={model}
          onModel={setModel}
          account={account}
          onGoAuth={() => setView('auth')}
          onLogout={logout}
        />
      ) : view === 'auth' ? (
        <AuthPage baseUrl={settings.baseUrl} onDone={applyAuth} onBack={() => setView('settings')} />
      ) : (
        <ChatPage
          messages={messages}
          busy={busy}
          model={model}
          hasCredential={Boolean(settings.apiKey)}
          onSend={send}
          onOpenSettings={() => setView('settings')}
          onGoAuth={() => setView('auth')}
        />
      )}
    </div>
  );
}
