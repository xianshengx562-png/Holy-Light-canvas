/**
 * 聊天式主界面（2026-10-13）：底部说一句话 → 气泡里出图。
 *
 * 会话只存在内存里 —— 规格 A4：第一版不做历史记录，退出即丢，不落盘。
 * 「保存到相册 / 复制链接」在每张图下面，跟豆包一样顺手。
 */
import { useEffect, useRef, useState } from 'react';
import type { CustomMediaResult } from '../providers/generateImage';
import { copyText, saveToGallery } from '../save';

export type ChatMessage =
  | { role: 'user'; id: number; text: string }
  | { role: 'assistant'; id: number; state: 'pending'; prompt: string }
  | {
      role: 'assistant';
      id: number;
      state: 'done';
      prompt: string;
      result: CustomMediaResult;
      /** 出图后的自动保存结果（成功/失败原因）。 undefined = 还没跑完。 */
      autoSave?: string;
    }
  | { role: 'assistant'; id: number; state: 'failed'; prompt: string; error: string };

/** 空状态时给的几句种子 —— 点一下进输入框，改改就能发。 */
const EXAMPLES = [
  '日系少女，柔和逆光，浅景深',
  '赛博朋克夜城，霓虹，雨后路面反光',
  '水墨山水，大片留白，雾气',
  '极简产品海报，高级灰背景',
];

function srcOf(result: CustomMediaResult): string {
  if (result.b64) {
    return result.b64.startsWith('data:') ? result.b64 : `data:image/png;base64,${result.b64}`;
  }
  return result.url || '';
}

/** 图加载完再渐显 —— 从 0 直接跳出来看着像闪了一下。 */
function ResultImage({ src, alt }: { src: string; alt: string }) {
  const [loaded, setLoaded] = useState(false);
  return (
    <div
      className="img-box"
      style={loaded ? { minHeight: 0, background: 'none', animation: 'none' } : undefined}
    >
      <img
        className={`msg-img${loaded ? ' loaded' : ''}`}
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
      />
    </div>
  );
}

/** 一张图下面的两颗小按钮。文案直接给结论（成功/失败原因），不弹浮层。 */
function ImageActions({ result, autoSave }: { result: CustomMediaResult; autoSave?: string }) {
  /*
   * 🔴 `note` 只放**手动操作**的结果，不能把 props 的 autoSave 塞进 useState 当初始值 ——
   * 自动保存是出图之后才跑完的，那时组件早已用 undefined 初始化过，props 再变也不会进去。
   * 显示顺序：手动结果 → 自动保存状态。
   */
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = note || autoSave || '';

  const run = async (action: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(true);
    const outcome = await action();
    setNote(outcome.message);
    setBusy(false);
  };

  return (
    <div className="msg-actions">
      <button className="chip" onClick={() => run(() => saveToGallery(result))} disabled={busy}>
        保存到相册
      </button>
      {result.url ? (
        <button className="chip" onClick={() => run(() => copyText(result.url || ''))} disabled={busy}>
          复制链接
        </button>
      ) : null}
      {shown ? <div className="msg-note">{shown}</div> : null}
    </div>
  );
}

type Props = {
  messages: ChatMessage[];
  busy: boolean;
  model: string;
  hasCredential: boolean;
  onSend: (prompt: string) => void;
  onOpenSettings: () => void;
  onGoAuth: () => void;
};

export default function ChatPage({
  messages,
  busy,
  model,
  hasCredential,
  onSend,
  onOpenSettings,
  onGoAuth,
}: Props) {
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  /* 新消息 / 状态变化都滚到底部 —— 聊天界面的基本盘。 */
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages]);

  /** 输入框跟着字数长高，到上限就不长了（自己内部滚动）。 */
  const autoGrow = () => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 130)}px`;
  };

  const submit = () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput('');
    /* 发完把高度收回去，不然下一次输入从很高的一行开始。 */
    requestAnimationFrame(() => {
      if (inputRef.current) inputRef.current.style.height = 'auto';
    });
    onSend(text);
  };

  const useExample = (example: string) => {
    setInput(example);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      autoGrow();
    });
  };

  return (
    <>
      <div className="chat-list">
        {messages.length === 0 ? (
          <div className="chat-empty">
            <div className="chat-empty-badge">对话式生图</div>
            <div className="chat-empty-title">想要什么画面，说一句就行</div>
            <div className="chat-empty-sub">
              出图后点图下面的按钮就能存进相册、复制链接。
              {hasCredential ? '' : ' 第一次用要先登录站点账号。'}
            </div>
            {hasCredential ? (
              <div className="example-row">
                {EXAMPLES.map(example => (
                  <button key={example} className="example-chip" onClick={() => useExample(example)}>
                    {example}
                  </button>
                ))}
              </div>
            ) : (
              <div className="example-row">
                <button className="example-chip" onClick={onGoAuth}>
                  登录站点账号（自动开通令牌）
                </button>
                <button className="example-chip" onClick={onOpenSettings}>
                  手动粘贴令牌
                </button>
              </div>
            )}
          </div>
        ) : null}

        {messages.map(message =>
          message.role === 'user' ? (
            <div key={message.id} className="row-user">
              <div className="bubble-user">{message.text}</div>
            </div>
          ) : message.state === 'pending' ? (
            <div key={message.id} className="row-assistant">
              <div className="bubble-assistant">
                <div className="typing">
                  <span className="dot" />
                  <span className="dot" />
                  <span className="dot" />
                  <span className="typing-text">正在画…（最多 150 秒）</span>
                </div>
              </div>
            </div>
          ) : message.state === 'done' ? (
            <div key={message.id} className="row-assistant">
              <div className="bubble-assistant">
                <ResultImage src={srcOf(message.result)} alt={message.prompt} />
                <ImageActions result={message.result} autoSave={message.autoSave} />
              </div>
            </div>
          ) : (
            <div key={message.id} className="row-assistant">
              <div className="bubble-assistant bubble-error">{message.error}</div>
            </div>
          ),
        )}
        <div ref={bottomRef} />
      </div>

      {!hasCredential && messages.length > 0 ? (
        <div className="chat-setup">
          <span>还没有令牌 —— 登录站点账号会自动开通。</span>
          <span className="inline-actions">
            <button className="chip" onClick={onGoAuth}>
              登录
            </button>
            <button className="chip" onClick={onOpenSettings}>
              手动粘贴
            </button>
          </span>
        </div>
      ) : null}

      <div className="composer">
        <textarea
          ref={inputRef}
          className="composer-input"
          rows={1}
          placeholder={busy ? '正在画…' : '描述你想要的画面…'}
          value={input}
          disabled={busy}
          onChange={event => {
            setInput(event.target.value);
            autoGrow();
          }}
          onKeyDown={event => {
            /* 手机上回车就是换行；桌面调试时 Ctrl/⌘ + Enter 发送。 */
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <button
          className={`send-btn${input.trim() && !busy ? ' on' : ''}`}
          onClick={submit}
          disabled={busy || !input.trim()}
          aria-label="发送"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M12 19V5M12 5l-6 6M12 5l6 6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      <div className="composer-hint">
        {model ? `当前模型：${model}` : '还没拉到模型清单'}
        <button type="button" className="linklike" onClick={onOpenSettings}>
          设置
        </button>
      </div>
    </>
  );
}
