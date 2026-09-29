'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Images, ImagePlus, Workflow } from 'lucide-react';
import '@/app/start.css';
import { START_ENTRIES, type StartEntryIcon } from '@/lib/start/entries';
import { autoCanvasProjectName, resolveEntryTarget, type EntryContext } from '@/lib/start/entryTarget';
import { isDesktop } from '@/lib/edition';
import { apiPost, useApi, useSession } from '@/lib/client';

/**
 * 开始界面上的创作入口卡片组。
 *
 * 数据来自 `lib/start/entries.ts`，这里只负责三件事：图标映射、
 * 「有落点的渲染成链接 / 要现场建项目的渲染成按钮 / 去不了的渲染成不可点卡片」、
 * 以及**把落点算出来**（见 `lib/start/entryTarget.ts`）。
 *
 * ## 为什么要自己取一次项目列表
 *
 * 「画布」这条入口没有固定地址（它是 `/projects/<id>`），落点要看**当前有什么项目**
 * —— 见 `lib/start/entryTarget.ts` 里那段事故说明（写死 `/` 的结果是「点了没反应」）。
 * 首页 `app/page.tsx` 其实也取了同一份列表，但它只喂给「最近项目」那块，
 * 没往这里传。这一层是卡片组自己的数据依赖，自己取一次最省心：
 * 组件已经是客户端组件，而**把 context 提成 prop 才是真正的坏味道** ——
 * 每加一个动态入口，所有渲染这张卡片的地方都得跟着改签名。
 * 代价是多一趟请求（`useApi` **没有**跨组件缓存，见 `src/lib/client.ts`）——
 * 那是本机 SQLite 的一次读，比让签名长出第二个参数划算。
 *
 * ## 拿不到列表时不乱点
 *
 * 列表还在路上时落点算成 `none`，这张卡就渲染成不可点的形态；
 * 列表一到（本机 SQLite 或同机 HTTP，通常几十毫秒）它自己变成链接或按钮。
 * 不这么做的话，点下去会走进「空库」那一支 —— **凭空多出一个项目**，
 * 而这恰恰是最难解释的一种「坏」：用户什么都没做，项目列表里多了一条。
 */
const ICONS: Record<StartEntryIcon, typeof Images> = {
  canvas: Workflow,
  image: ImagePlus,
  assets: Images,
};

/** `GET /api/projects` 的结果里我们只关心 id（要按最近更新在前）。 */
type ProjectRow = { id: string };

export default function StartEntries() {
  const { user } = useSession();
  const router = useRouter();
  const { data: projects } = useApi<ProjectRow[]>(user ? '/api/projects' : null);
  /** 正在建的是哪一条。建的过程要几百毫秒，期间按钮得禁掉 —— 手快连点会建出两个项目。 */
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const context: EntryContext = {
    projectIds: (projects ?? []).map(row => row.id),
    /* 挂起中的「空列表」和「真的没有项目」是两回事：前者不许当成事实用。 */
    ready: Boolean(projects),
    signedIn: Boolean(user),
    isDesktop,
  };

  /**
   * 空库时点「画布」：**当场建一个再进去**。
   *
   * 走 `POST /api/projects`（老接口，桌面版与 web 版同一条），复用它的名字校验与
   * 「连带建一张空画布」的行为 —— 这里**不要**另起一套建项目的逻辑，
   * 否则「建出来的项目长什么样」就有了两份说法。
   *
   * 拿到 id 之后和「新建项目」页一样用前端路由跳 `/projects/<id>`：
   * 桌面版没有服务端跳转那一步（`app://` 下重定向会被 fetch 静默跟掉），
   * 必须自己把地址推过去 —— 见 `src/app/projects/new/page.tsx` 那段说明。
   *
   * ⚠️ 名字由**前端**按本机时间取：服务端不知道用户在哪个时区，
   * 而这个名字是他之后在项目列表里对上号的唯一线索。
   */
  async function createCanvas(entryId: string) {
    if (busy) return;
    setBusy(entryId);
    setError('');
    try {
      const project = await apiPost<{ id?: string }>('/api/projects', { name: autoCanvasProjectName() });
      if (!project?.id) throw new Error('没建成项目，再试一次。');
      router.push(`/projects/${project.id}`);
      /* 成功这一支**不要**把 busy 清掉：清掉之后按钮会变回能点的样子，
         而这一页要等路由切换才卸载 —— 中间那一瞬再点一下就是第二个项目。 */
    } catch (err) {
      setError(err instanceof Error ? err.message : '新建项目失败，请重试。');
      setBusy('');
    }
  }

  /* 桌面版把 `webOnly` 的入口整条去掉，而不是渲染成灰卡片：那些功能在桌面版根本不存在，
     留个坑位等于给用户一个「点了发现是坏的」的链接。 */
  const entries = isDesktop ? START_ENTRIES.filter(entry => !entry.webOnly) : START_ENTRIES;
  return <>
    {/* 失败要说出来，而且要说在卡片旁边：点的是卡片，反馈就得在这一块视野里。 */}
    {error && <p className="entry-error" role="alert">{error}</p>}
    <div className="entry-grid">
      {entries.map(entry => {
        const Icon = ICONS[entry.icon];
        const target = resolveEntryTarget(entry, context);
        const busyHere = busy === entry.id;
        const clickable = target.kind !== 'none';
        /* 「去不了」的原因要分开说：没登录 / 列表还在读 / 功能本身没做好。
           全塞进一句「暂时去不了」，没登录的人会以为是画布坏了。 */
        const targetNote = !entry.dynamic
          ? '暂时去不了'
          : context.signedIn ? '正在读取你的项目…' : '登录后可用';
        const body = <>
          <span className="entry-icon"><Icon size={20} strokeWidth={1.6} aria-hidden /></span>
          <strong>{entry.title}</strong>
          <p className="muted">{entry.description}</p>
          {entry.status !== 'ready'
            ? <span className="entry-note">{entry.plannedNote || '开发中'}</span>
            : clickable
              /* 空库这一支写「新建画布」而不是「进入」：这一次点击**会多出一个项目**，
                 用户有权在点之前就知道。 */
              ? <span className="entry-cta">{target.kind === 'create-canvas' ? (busyHere ? '正在打开…' : '新建画布 →') : '进入 →'}</span>
              : <span className="entry-note">{targetNote}</span>}
        </>;
        if (target.kind === 'href') {
          return <Link key={entry.id} className="entry-card" href={target.href} data-entry={entry.id}>{body}</Link>;
        }
        if (target.kind === 'create-canvas') {
          return <button key={entry.id} type="button" className="entry-card" data-entry={entry.id}
            aria-busy={busyHere || undefined}
            disabled={Boolean(busy)}
            onClick={() => createCanvas(entry.id)}>{body}</button>;
        }
        /* 不可点：用 div 而不是 disabled 的 button —— 后者会被读屏当成「有个按钮按不了」，
           而这里的事实是「这个功能还没有」或「这一下没有落点」，那就干脆不要渲染成一个控件。 */
        return <div key={entry.id} className="entry-card planned" data-entry={entry.id} aria-disabled="true">{body}</div>;
      })}
    </div>
  </>;
}
