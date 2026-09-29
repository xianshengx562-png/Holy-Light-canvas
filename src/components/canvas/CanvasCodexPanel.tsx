'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CornerDownLeft, LogIn, Loader2, Plus, Sparkles, Square, X } from 'lucide-react';
import SkillLibrary from './SkillLibrary';
import { workbuddyAvailable, workbuddyLaunch } from '@/lib/desktop-workbuddy';
import {
  OFF_CODEX_STATUS, codexInterrupt, codexLogin, codexNewThread, codexSend, codexStart, codexStatus,
  onCodexEvent, type CodexEvent, type CodexSkill, type CodexStatus,
} from '@/lib/desktop-codex';

/**
 * 画布里的 Codex 对话侧栏。
 *
 * 它是「让 Codex 操作画布」的入口，但**自己不实现任何画布操作**：
 * 能力全部来自 `tools/frame-mcp` 那 14 个工具，Codex 作为 MCP client 去调。
 * 所以这里真正要负责的是三件小事：
 *
 *  1. **把流式增量拼回成一条消息。** 协议给的是 `item/agentMessage/delta`
 *     这种一小段一小段的东西，按 `itemId` 累加即可 —— 不要按「第几条消息」去猜顺序。
 *  2. **把工具调用说成人话。** 用户不需要看 `frame_add_node` 这串名字，
 *     但**必须**看到它动了什么（改了哪个节点、连了哪条线），否则就是个黑盒。
 *  3. **改完画布要通知画布。** 主进程推来 `canvas` 事件时转给 `onCanvasChanged` ——
 *     这一步漏掉的话，Codex 加的节点用户一个都看不见（数据在库里，画布没重画）。
 */

/** 工具名 → 一句中文。看不懂 `frame_*` 的人在等这句话。 */
const TOOL_LABEL: Record<string, string> = {
  frame_add_node: '加节点',
  frame_update_node: '改节点',
  frame_remove_node: '删节点',
  frame_connect: '连线',
  frame_disconnect: '断开连线',
  frame_get_canvas: '读画布',
  frame_describe_canvas: '看画布现状',
  frame_run_generation: '跑生成',
  frame_get_task: '查任务',
  frame_list_projects: '列项目',
  frame_create_project: '建项目',
  frame_get_project: '读项目',
  frame_list_workflows: '列工作流',
  frame_status: '查状态',
};

type Block =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'reasoning'; id: string; text: string }
  | { kind: 'tool'; id: string; server: string; tool: string; state: string; args: string; result?: string; error?: string | null };

export default function CanvasCodexPanel({
  projectId,
  projectName,
  skill,
  onSkillChange,
  onCanvasChanged,
}: {
  projectId: string;
  projectName: string;
  /**
   * 挂在 Codex 上的技能（受控：存在画布那一层）。
   *
   * 为什么不放在这个面板里自己存：左轨那张 SKILL 浮层也能选技能，
   * 两边各存一份的话，在左轨选完还得再到 Codex 里选一次 —— 那就等于没接。
   */
  skill: CodexSkill | null;
  onSkillChange: (next: CodexSkill | null) => void;
  /** 画布被 frame 工具改过了 —— 由画布那边决定是重拉还是提示冲突。 */
  onCanvasChanged: () => void;
}) {
  const [status, setStatus] = useState<CodexStatus>(OFF_CODEX_STATUS);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState('');
  const [skillOpen, setSkillOpen] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  const frameTools = useMemo(() => {
    const hit = status.mcp.find(item => item.name === 'frame');
    return hit ?? null;
  }, [status.mcp]);

  /* 打开侧栏就连上：没连的时候这个面板里所有按钮都没有意义。 */
  useEffect(() => {
    let alive = true;
    void codexStatus().then(next => { if (alive) setStatus(next); });
    const off = onCodexEvent((event: CodexEvent) => {
      if (!alive) return;
      switch (event.kind) {
        case 'status':
          setStatus(event.status);
          break;
        case 'message':
          setBlocks(prev => appendText(prev, { kind: 'assistant', id: event.itemId, text: event.text }));
          break;
        case 'reasoning':
          setBlocks(prev => appendText(prev, { kind: 'reasoning', id: event.itemId, text: event.text }));
          break;
        case 'item':
          setBlocks(prev => upsertTool(prev, event.item));
          break;
        case 'canvas':
          onCanvasChanged();
          break;
        case 'error':
          setNotice(event.message);
          break;
        default:
          break;
      }
    });
    return () => { alive = false; off(); };
  }, [onCanvasChanged]);

  useEffect(() => {
    if (status.phase !== 'off') return;
    /* 稍微等一下再连：侧栏刚滑出来的那 200ms 里同时起进程，动画会卡。 */
    const timer = setTimeout(() => { void codexStart().then(setStatus); }, 260);
    return () => clearTimeout(timer);
  }, [status.phase]);

  /* 新内容进来就贴到底。只在块数/长度变化时做 —— 每次都滚会让用户没法往上翻。 */
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [blocks]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || status.busy) return;
    setDraft('');
    setNotice('');
    setBlocks(prev => [...prev, { kind: 'user', id: `u-${Date.now()}`, text }]);
    const result = await codexSend(text, { projectId, projectName, skill });
    if (!result.ok) setNotice(result.message);
  }, [draft, projectId, projectName, skill, status.busy]);

  const newThread = useCallback(async () => {
    setBlocks([]);
    setNotice('');
    setStatus(await codexNewThread());
  }, []);

  const login = useCallback(async () => {
    const result = await codexLogin();
    setNotice(result.message);
  }, []);

  /*
   * 交给 WorkBuddy（2026-09-30）：提示词进剪贴板 + 唤起它。
   *
   * 输入框里已经写好的那句话会**一起带过去** —— 用户往往是先在这里打了一半，
   * 才想起要换个地方问。空着也能点：那一段只交代「改哪张画布」，到那边再写要求。
   */
  const handOver = useCallback(async () => {
    const result = await workbuddyLaunch({ projectId, projectName, ask: draft.trim() });
    setNotice(result.message);
  }, [draft, projectId, projectName]);

  const connected = status.phase === 'ready';
  const needsLogin = connected && status.requiresAuth;
  /** 这一版有没有「交给 WorkBuddy」那条通道 —— web 版没有，入口就不显示。 */
  const workbuddy = workbuddyAvailable();

  return (
    <div className="cv-codex" data-codex-panel="">
      <div className="cv-codex-status">
        <span className={`cv-codex-dot ${status.phase}`} aria-hidden />
        <span className="cv-codex-status-text">
          {status.phase === 'ready' && `已连接${status.model ? ` · ${status.model}` : ''}`}
          {status.phase === 'starting' && '正在连接 Codex…'}
          {status.phase === 'off' && (status.message || '还没连接 Codex。')}
          {status.phase === 'error' && status.message}
        </span>
        {frameTools && (
          <span className="cv-codex-tag" title={frameTools.error ?? ''}>
            画布工具 {frameTools.tools} 个{frameTools.status === 'connected' ? '' : `（${frameTools.status}）`}
          </span>
        )}
        <div className="cv-spacer" />
        {needsLogin && (
          <button className="cv-btn ghost sm" type="button" data-codex-login="" onClick={() => void login()}>
            <LogIn size={12} strokeWidth={2} aria-hidden /> 登录 Codex
          </button>
        )}
        {status.phase === 'error' && (
          <button className="cv-btn ghost sm" type="button" onClick={() => void codexStart().then(setStatus)}>重试</button>
        )}
        {workbuddy && (
          <button
            className="cv-btn ghost sm"
            type="button"
            data-codex-workbuddy=""
            onClick={() => void handOver()}
            title="交给 WorkBuddy：把「哪张画布 + 你要改什么」复制到剪贴板并打开它（它那边装的是同一套画布工具，改的还是这张画布）"
          >
            <Sparkles size={12} strokeWidth={2} aria-hidden /> WorkBuddy
          </button>
        )}
        <button
          className="cv-btn ghost sm"
          type="button"
          data-codex-skills=""
          onClick={() => setSkillOpen(true)}
          title="SKILL 社区：挑一个技能，让 Codex 照它的写法干活"
        >
          <BookOpen size={12} strokeWidth={2} aria-hidden /> {skill ? '换技能' : 'SKILL 社区'}
        </button>
        <button
          className="cv-btn ghost sm"
          type="button"
          data-codex-new-thread=""
          disabled={!connected}
          onClick={() => void newThread()}
        >
          <Plus size={12} strokeWidth={2} aria-hidden /> 新会话
        </button>
      </div>

      <div className="cv-codex-list" ref={listRef} data-codex-list="">
        {blocks.length === 0 && (
          <div className="cv-codex-empty">
            <p>让 Codex 直接改这张画布。</p>
            <ul>
              <li>「加一个文生图节点，提示词写一只在雨里的猫」</li>
              <li>「把提示词节点连到生图节点上」</li>
              <li>「现在这张画布上都有什么」</li>
            </ul>
            <p className="cv-codex-empty-note">
              它改的是项目里的画布数据；这一栏关掉、甚至应用重启，会话都还在主进程那边。
            </p>
            {workbuddy && (
              <p className="cv-codex-empty-note">
                想让 WorkBuddy 来做，就点上面的「WorkBuddy」：这段要求会复制到剪贴板，它会被打开，
                在那边 Ctrl+V 发送即可 —— 它改的是同一张画布。
              </p>
            )}
          </div>
        )}

        {blocks.map(block => {
          if (block.kind === 'user') {
            return <div key={block.id} className="cv-codex-msg user" data-codex-msg="user">{block.text}</div>;
          }
          if (block.kind === 'assistant') {
            return <div key={block.id} className="cv-codex-msg bot" data-codex-msg="bot">{block.text}</div>;
          }
          if (block.kind === 'reasoning') {
            return <div key={block.id} className="cv-codex-msg reasoning" data-codex-msg="reasoning">{block.text}</div>;
          }
          const label = TOOL_LABEL[block.tool] ?? block.tool;
          return (
            <div key={block.id} className="cv-codex-tool" data-codex-tool={block.tool}>
              <span className="cv-codex-tool-name">
                {block.state === 'completed' && block.error ? '✕' : block.state === 'completed' ? '✓' : '…'} {label}
              </span>
              <span className="cv-codex-tool-raw">{block.server}.{block.tool}</span>
              {block.error ? <div className="cv-codex-tool-err">{block.error}</div> : null}
            </div>
          );
        })}

        {status.busy && (
          <div className="cv-codex-msg bot pending" data-codex-pending="">
            <Loader2 size={13} className="cv-spin" aria-hidden /> 正在想…
          </div>
        )}
      </div>

      {notice && <div className="cv-codex-notice" data-codex-notice="">{notice}</div>}

      {skill && (
        <div className="cv-codex-skill" data-codex-skill={skill.id}>
          <BookOpen size={12} strokeWidth={2} aria-hidden />
          <span>技能：{skill.title}</span>
          <div className="cv-spacer" />
          <button
            className="cv-codex-skill-x"
            type="button"
            data-codex-skill-clear=""
            aria-label="不带技能了"
            onClick={() => onSkillChange(null)}
          >
            <X size={12} strokeWidth={2} aria-hidden />
          </button>
        </div>
      )}

      <div className="cv-codex-compose">
        <textarea
          className="cv-codex-input"
          value={draft}
          rows={2}
          spellCheck={false}
          placeholder={connected ? '要让 Codex 对画布做什么？Enter 发送，Shift+Enter 换行' : '正在连接 Codex…'}
          data-codex-input=""
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key !== 'Enter' || event.shiftKey) return;
            event.preventDefault();
            void send();
          }}
        />
        {status.busy
          ? (
            <button className="cv-btn ghost sm" type="button" data-codex-stop="" onClick={() => void codexInterrupt()}>
              <Square size={12} strokeWidth={2} aria-hidden /> 停止
            </button>
          )
          : (
            <button
              className="cv-btn primary sm"
              type="button"
              data-codex-send=""
              disabled={!connected || !draft.trim()}
              onClick={() => void send()}
            >
              <CornerDownLeft size={12} strokeWidth={2} aria-hidden /> 发送
            </button>
          )}
      </div>

      <SkillLibrary
        open={skillOpen}
        activeId={skill?.id ?? null}
        onClose={() => setSkillOpen(false)}
        onPick={(next) => {
          onSkillChange(next);
          setSkillOpen(false);
          setNotice(`已挂上技能「${next.title}」，接下来这几句都会照它的写法来。`);
        }}
      />
    </div>
  );
}

/** 把一段增量并进对应 id 的块里（没有就新建）。 */
function appendText(blocks: Block[], next: Extract<Block, { kind: 'assistant' | 'reasoning' }>): Block[] {
  const index = blocks.findIndex(item => item.id === next.id && item.kind === next.kind);
  if (index < 0) return [...blocks, next];
  const copy = blocks.slice();
  const old = copy[index] as Extract<Block, { kind: 'assistant' | 'reasoning' }>;
  copy[index] = { ...old, text: old.text + next.text };
  return copy;
}

/** 工具调用块：started 先占位，completed 补结果。 */
function upsertTool(blocks: Block[], item: {
  id: string; type: string; server?: string; tool?: string; status?: string;
  arguments?: string; result?: string; error?: string | null;
}): Block[] {
  if (item.type !== 'mcpToolCall') return blocks;
  const index = blocks.findIndex(block => block.id === item.id && block.kind === 'tool');
  const next: Block = {
    kind: 'tool',
    id: item.id,
    server: item.server ?? '',
    tool: item.tool ?? '',
    state: item.status ?? 'inProgress',
    args: item.arguments ?? '',
    result: item.result ?? '',
    error: item.error ?? null,
  };
  if (index < 0) return [...blocks, next];
  const copy = blocks.slice();
  copy[index] = { ...(copy[index] as Extract<Block, { kind: 'tool' }>), ...next };
  return copy;
}
