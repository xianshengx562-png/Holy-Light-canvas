import { useEffect } from 'react';
import ThemeProvider from '@/components/theme/ThemeProvider';
import SiteBackground from '@/components/theme/SiteBackground';
import AnnouncementModal from '@/components/AnnouncementModal';
import BackendStatusBanner from '@/components/BackendStatusBanner';
import UpdateBanner from '@/components/UpdateBanner';
import CloseConfirmDialog from '@/components/CloseConfirmDialog';
import SiteBalance from '@/components/SiteBalance';
import NavTogglePortal from '@/components/NavTogglePortal';
import BootGate from '@/components/BootGate';

import Home from '@/app/page';
import ImagePage from '@/app/image/page';
import About from '@/app/about/page';
import Assets from '@/app/assets/page';
import Login from '@/app/login/page';
import Register from '@/app/register/page';
import NewProject from '@/app/projects/new/page';
import Projects from '@/app/projects/page';
import Project from '@/app/projects/[id]/page';
import Appearance from '@/app/settings/appearance/page';
import ComfyuiService from '@/app/settings/comfyui/page';
import ModelServicesPage from '@/app/settings/model-services/page';
import Output from '@/app/settings/output/page';
import UpdateSettings from '@/app/settings/update/page';
import Workflows from '@/app/settings/providers/workflows/page';
import UserSettings from '@/app/user/page';
import Splitter from '@/app/tools/splitter/page';
import Converter from '@/app/tools/converter/page';
import Motion from '@/app/tools/motion/page';
import Mosaic from '@/app/tools/mosaic/page';
import Cipher from '@/app/tools/cipher/page';
import VideoJoinerPage from '@/app/tools/video/page';
import Unavailable from '@/app/unavailable/page';

import { setParams, usePathname } from './shims/router';
import { isDesktopWindows } from '@/lib/desktop-titlebar';

/* 兜底拖拽条只在桌面版 Windows 上渲染（判定理由见 lib/desktop-titlebar.ts）。 */
const showDragbar = isDesktopWindows();

/**
 * 路由表。
 *
 * 原来是 Next 的 App Router（文件夹即路由）；桌面版没有这一步，所以在渲染进程里自己匹配。
 * `[id]` 这种动态段编译成正则，匹配到的值写进 router，`useParams()` 就能读到 ——
 * 那些页面里的 `params: Promise<{ id: string }>` 签名也就不用改。
 */
type Entry = { pattern: string; regex: RegExp; keys: string[]; Page: React.ComponentType };

function compile(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      const m = /^\[(.+)\]$/.exec(seg);
      if (m) {
        keys.push(m[1]);
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

const ROUTES: Entry[] = [
  { pattern: '/', Page: Home },
  { pattern: '/image', Page: ImagePage },
  { pattern: '/about', Page: About },
  { pattern: '/assets', Page: Assets },
  { pattern: '/login', Page: Login },
  { pattern: '/register', Page: Register },
  { pattern: '/projects', Page: Projects },
  { pattern: '/projects/new', Page: NewProject },
  { pattern: '/projects/[id]', Page: Project },
  { pattern: '/settings/appearance', Page: Appearance },
  { pattern: '/settings/comfyui', Page: ComfyuiService },
  { pattern: '/settings/model-services', Page: ModelServicesPage },
  { pattern: '/settings/output', Page: Output },
  { pattern: '/settings/update', Page: UpdateSettings },
  /* 桌面版这一页整页并进了「模型服务」（2026-09-22）—— 这里换页过去，而不是再挂一遍
     那份界面（挂一遍＝桌面版又有第二个 RunningHub 设置界面，等于这次的合并白做）。 */
  { pattern: '/settings/providers', Page: ProvidersMoved },
  { pattern: '/settings/providers/workflows', Page: Workflows },
  { pattern: '/user', Page: UserSettings },
  { pattern: '/tools/splitter', Page: Splitter },
  { pattern: '/tools/converter', Page: Converter },
  { pattern: '/tools/motion', Page: Motion },
  { pattern: '/tools/mosaic', Page: Mosaic },
  { pattern: '/tools/cipher', Page: Cipher },
  { pattern: '/tools/video', Page: VideoJoinerPage },
  { pattern: '/unavailable', Page: Unavailable },
].map(({ pattern, Page }) => ({ pattern, ...compile(pattern), Page }));

/* `/dashboard` 在 2026-09-17 让位给主界面 `/`，老书签要能落回首页而不是 404。
 * `/settings` 本身没有页面（那一层在 Next 里只是个 layout，子页才是内容），
 * 直接访问会落到「没有这个页面」，所以送去默认子页「模型服务」。
 * `/settings/local` 在 2026-09-21 整页并入「ComfyUI 服务」—— 老书签、旧链接、
 * 以及别的页面里没改干净的 href 指过来都要能落到新页面，而不是「没有这个页面」。 */
const REDIRECTS: Record<string, string> = {
  '/dashboard': '/',
  /* 「这次生成走谁」是设置区的第一页，光秃秃的 `/settings` 送它最合用。 */
  '/settings': '/settings/model-services',
  /* 2026-09-25：「密钥中心」整页撤了 —— 桌面版里它永远是空的（各家 key 本来就在
     「模型服务」里填，那一页再摆一份就是点开什么都没有）。老书签一律送到模型服务。 */
  '/settings/keys': '/settings/model-services',
  '/settings/local': '/settings/comfyui',
  /* 2026-09-23：「用户」整页搬出设置区（入口改到侧栏底部那颗用户卡片，路由改 `/user`）。
     老地址一律换到新页 —— 同 `/author`、`/settings/local` 的规矩，别落成「没有这个页面」。 */
  '/settings/user': '/user',
  /* 2026-09-21：「作者菌」那一页整页删掉了（首页卡 + 侧栏项 + 页面 + 数据 + 样式一起清）。
     老书签和手输的地址指过来要落回首页，而不是「没有这个页面」。 */
  '/author': '/',
  /* 2026-09-23：用户协议整块删掉了（弹窗页签 + `/agreement` 页 + 条款数据）。
     同理 —— 老书签、别的页面里没改干净的 href 指过来都回首页，别让人看到「没有这个页面」。 */
  '/agreement': '/',
};

/**
 * 「设置 · 服务连接」在桌面版整页并进了「设置 · 模型服务」（2026-09-22）。
 *
 * 老书签、别的页面里没改干净的 href、以及手输的地址指过来，都要能落到新页面 ——
 * 把路由整条删掉会让他们看到「没有这个页面」，那比跳过去更像坏了。
 */
function ProvidersMoved() {
  useEffect(() => { window.location.hash = '#/settings/model-services'; }, []);
  return <div className="empty" style={{ padding: 48 }}>
    <div className="empty-icon">→</div>
    <h3>这一页并进「模型服务」了</h3>
    <p className="muted">正在打开…</p>
  </div>;
}

function NotFound({ path }: { path: string }) {
  return (
    <div className="empty" style={{ padding: 48 }}>
      <div className="empty-icon">？</div>
      <h3>没有这个页面</h3>
      <p className="muted">{path}</p>
      <a className="button" href="#/">
        回主界面
      </a>
    </div>
  );
}

function match(pathname: string): { Page: React.ComponentType; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    const m = route.regex.exec(pathname);
    if (!m) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, i) => {
      params[key] = decodeURIComponent(m[i + 1]);
    });
    return { Page: route.Page, params };
  }
  return null;
}

export default function App() {
  const pathname = usePathname();

  /**
   * 没有 hash 就先补一个 `#/`。
   *
   * 场景：外部（或老书签）直接打开 `app://app/index.html` —— 没有任何 hash。
   * 这时 `usePathname()` 按约定回 `/`，于是**在渲染上等同于首页**；但 `location.hash`
   * 又是空的，下面那条 REDIRECTS 会把「首页」再送回首页：地址没变、路由没变，
   * React 一帧都提交不出来 —— 界面是纯白的（2026-09-19 那个「打开工作流配置后是空白的」
   * 就是这个死循环的产物，只不过那次的入口是 `target="_blank"` 开出来的新窗）。
   *
   * 补上 hash 之后，这个空转状态在一帧内就被打破；顺手也让地址栏变得可分享、可刷新。
   * 写在 effect 里而不是渲染期间：它是**改地址栏**这种副作用，渲染期间做会触发警告。
   */
  useEffect(() => {
    if (!window.location.hash) window.location.hash = '#/';
  }, []);

  useEffect(() => {
    const target = REDIRECTS[pathname];
    if (target) window.location.hash = target;
  }, [pathname]);

  const hit = match(pathname);
  /*
   * ⚠️ 这里有三件事必须一起成立，顺序和写法都不能随意动：
   *
   * 1. `setParams` 要在**渲染期间**写，不能挪进 `useEffect` —— 子组件要靠这次渲染就
   *    读到动态段的值。写进 effect 会慢一帧，`useParams()` 首次拿到的是空对象。
   * 2. 匹配同一页面的两个不同 URL（`/projects/a` → `/projects/b`）时，React 会**复用**
   *    同一个组件实例而不是重新挂载，`useState` 的初值不会重算。所以给 `<Page>` 带上
   *    `key={pathname}`：换项目就换实例，画布才会真的换成另一张。
   * 3. key 里带上 pathname 不影响静态页 —— 那些页面每个路径本来就是各自一个组件。
   */
  setParams(hit?.params ?? {});
  const Page = hit?.Page;

  /*
   * 根布局对应原来的 `app/layout.tsx`：`<html>` 上的主题属性已由挂载前的
   * `applyAppearance` 写好（见 main.tsx），这里只需要主题态与进站公告这两层壳。
   */
  return (
    <ThemeProvider>
      {/*
        启动画面的收尾：会话第一问回来 + 首屏真画出来 → 撤掉 `index.html` 里那块牌子。
        牌子本身是内联的（不等 JS bundle），所以「窗口出来了但界面还是空的」那一段它是盖得住的。
      */}
      <BootGate />
      {/* 兜底拖拽条：见 globals.css 末尾那段说明 —— 给没有页头的页面留一个能拖窗口的地方。 */}
      {showDragbar && <div className="app-dragbar" aria-hidden />}
      {Page ? <Page key={pathname} /> : <NotFound path={pathname} />}
      {/* 进站公告挂在根上，落在哪个路由都会弹 */}
      {/* 全站背景图（用户自己传的那张）：与路由无关，挂根上。没有图时它自己不渲染。 */}
      <SiteBackground />
      <AnnouncementModal />
      {/* 后端（独立进程）重连提示，同样与路由无关；web 版里它自己不渲染 */}
      <BackendStatusBanner />
      {/* 有新版时的提示条：与路由无关，挂根上 —— 用户不该只有逛到设置页才知道有新版本。 */}
      <UpdateBanner />
      {/* 点右上角 X 的关闭确认框：与路由无关；web 版里 onRequestClose 是空操作，不渲染 */}
      <CloseConfirmDialog />
      {/* 中转站账号的余额：自己找到当前页的页头挂进去，没登录时不渲染 */}
      <SiteBalance />
      {/* 侧栏收纳钮：同样自己找到当前页的页头挂进去（首页那套外壳本来就带了，会跳过）。
          排在 SiteBalance **后面** —— portal 是按挂载顺序插进容器的，
          这样在页头里它落在最右端，不会把余额挤到中间去。 */}
      <NavTogglePortal />
    </ThemeProvider>
  );
}
