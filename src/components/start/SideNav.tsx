'use client';

import Link from 'next/link';
import {
  Clapperboard,
  Film,
  FolderOpen,
  Images,
  Lock,
  Repeat,
  Scissors,
  Settings,
  ShieldOff,
} from 'lucide-react';
import { isDesktop } from '@/lib/edition';
import { useSession } from '@/lib/client';
import { siteAccountLabel, useSiteAccount } from '@/lib/site-account';
import { useAppearance } from '@/components/theme/ThemeProvider';
import UserAvatar from '@/components/UserAvatar';

/**
 * 登录后各页面左侧的导航。
 *
 * 抽出来的原因很直接：**原来是五个页面各手写一遍**，加一个入口就要改五处，
 * 漏掉一处的表现是「在资产页能跳到某一项，在设置页跳不回去」—— 用户会以为自己点错了。
 * 顺序与文案集中在这里，页面只声明「我是哪一项」（`active`）。
 *
 * ⚠️ `active` 用的是**项名**而不是 `href`：设置下面已经有好几页
 * （`/settings/model-services`、`/settings/comfyui`、…），拿 href 判断的话，进到子页时
 * 「设置」这一项就不再高亮了。e2e 脚本里那条 `.sidebar nav a.active` 的断言
 * 依赖的正是「有且只有一个是 active」—— 这条规矩对下面的「实用工具」同样成立，
 * 所以那几个工具页各自有独立的 key，而不是共用一个 `tools`。
 *
 * ⚠️ 底部那颗「用户」**故意放在 `<nav>` 外面**（`2026-09-23` 从设置二级导航搬下来的）：
 *    - 它不是导航分组里的一项，是「这块界面属于谁」—— 像仪表盘的账号位，钉在最底下；
 *    - 那条「有且只有一个是 active」的断言只看 `nav a`，把入口留在 nav 里就得让它
 *      参与争抢，而它和「设置」是可以同时成立的（用户档案页属于设置区之外的新页）。
 */
export type SideNavKey =
  | 'projects'
  | 'assets'
  | 'settings'
  /* 底部那颗用户卡片自己的 key（`/user` 页用它高亮）。 */
  | 'user'
  /* 实用工具：一项一个工具，它们的 key 直接对应路由 —— 见上面那条断言的说明。 */
  | 'splitter'
  | 'converter'
  | 'motion'
  | 'mosaic'
  | 'cipher'
  /* 视频拼接：要用本机 FFmpeg，web 版里这一项不出现（见下面  的说明）。 */
  | 'video';

type NavItem = { key: SideNavKey; href: string; label: string; icon: typeof FolderOpen };

const WEB_ITEMS: NavItem[] = [
  { key: 'projects', href: '/', label: '项目', icon: FolderOpen },
  { key: 'assets', href: '/assets', label: '资产', icon: Images },
  /* 设置永远收尾，那是这个侧栏没说出口的规矩。 */
  { key: 'settings', href: '/settings/providers', label: '设置', icon: Settings },
];

/*
 * 桌面版两处不同：
 *  - 去掉「对话」：整个对话功能（对话页、工作台的小精灵、那套中转 API）已在 2026-09-21 移除。
 *  - 「设置」指向 `/settings/comfyui` 而不是 `/settings/providers` —— 桌面版里没有服务连接那一页
 *    （中间件已经把它 rewrite 到说明页），点进去只会看到一句「没有这个界面」。
 *    2026-09-21 之前指到 `/settings/local`，那一页已并入 ComfyUI 服务页。
 */
const DESKTOP_ITEMS: NavItem[] = [
  { key: 'projects', href: '/', label: '项目', icon: FolderOpen },
  { key: 'assets', href: '/assets', label: '资产', icon: Images },
  { key: 'settings', href: '/settings/comfyui', label: '设置', icon: Settings },
];

/*
 * 「实用工具」这一组。
 *
 * 放在主导航**之下**而不是打散进去，是因为它们各自是一个独立的小工具：
 * 既不参与项目流程，也不修改任何已有数据（产出是新的资产，原图一个字节都不动）。
 * web 版与桌面版都要看见它们 —— 这些工具全在浏览器里算，不依赖本机任何额外的东西。
 */
const TOOL_ITEMS: NavItem[] = [
  { key: 'splitter', href: '/tools/splitter', label: '图片分割', icon: Scissors },
  { key: 'converter', href: '/tools/converter', label: '格式转换', icon: Repeat },
  { key: 'motion', href: '/tools/motion', label: '运镜效果', icon: Clapperboard },
  { key: 'mosaic', href: '/tools/mosaic', label: '人脸马赛克', icon: ShieldOff },
  { key: 'cipher', href: '/tools/cipher', label: '图片加解密', icon: Lock },
];

/*
 * 视频拼接**只给桌面版**：它要 spawn 本机的 ffmpeg，web 版没有主进程也没有那个可执行文件，
 * 放进去只会得到一个点了没反应的入口（另外四个工具全在浏览器里算，两边都能跑）。
 */
const DESKTOP_TOOL_ITEMS: NavItem[] = [
  ...TOOL_ITEMS,
  { key: 'video', href: '/tools/video', label: '视频拼接', icon: Film },
];

const TOOL_LIST = isDesktop ? DESKTOP_TOOL_ITEMS : TOOL_ITEMS;

const ITEMS = isDesktop ? DESKTOP_ITEMS : WEB_ITEMS;

export default function SideNav({ active }: { active: SideNavKey }) {
  /* 头像与昵称：档案存在库里（改成什么立刻显示什么），这一块只是**读**它。 */
  const { user } = useSession();
  /*
   * 登录了中转站的网站账号时，第二行换成**那个账号** —— 徐先要的就是「站内账号显示成
   * 我网站的账号」（2026-09-26）。昵称那一行不动：那是他在 Holy Light画布里自己起的名字，
   * 跟网站账号是两回事。没登录时保持原来的本机邮箱。
   */
  const { site } = useSiteAccount();
  const siteLabel = siteAccountLabel(site);

  /*
   * 收起成「窄图标条」时，标签被 CSS 的 `font-size: 0` 收掉了（见 globals.css 里那段），
   * 屏幕上只剩图标 —— 鼠标用户需要一个名字，靠原生 `title` 给。
   *
   * ⚠️ **展开态故意不给 title**：名字就在图标旁边，再叠一个和它一模一样的系统气泡
   *    纯属噪音（而且它晚 1 秒才弹，正好盖住你本来要点的东西）。
   * ⚠️ 首帧 `appearance` 是 `null`（还没读 localStorage）→ 按展开算，与防闪脚本一致。
   */
  const { appearance } = useAppearance();
  const collapsed = appearance?.navCollapsed ?? false;

  const entry = (item: NavItem) => {
    const Icon = item.icon;
    return (
      <Link
        key={item.key}
        className={item.key === active ? 'active' : undefined}
        href={item.href}
        title={collapsed ? item.label : undefined}
      >
        <Icon size={15} strokeWidth={1.8} aria-hidden /> {item.label}
      </Link>
    );
  };
  return <>
    <nav>
      {ITEMS.map(entry)}
      {/*
        分组标题：「中文 + 小号全大写拉丁」这一对是 2026-09-19 换皮后的统一记号，
        首页的区块标题（`01 / STUDIO ENTRIES 从这里开始`）用的是同一套。
        ⚠️ 拉丁那半截用 `aria-hidden` 藏掉：读屏念「实用工具 STUDIO TOOLS」是重复的，
        它只是版式上的第二行，不是第二个名字。
      */}
      <div className="nav-group">
        <span>实用工具</span>
        <em aria-hidden>Studio tools</em>
      </div>
      {TOOL_LIST.map(entry)}
    </nav>
    {/*
      用户入口（2026-09-23 从「设置 · 用户」搬到这里）：头像 + 昵称，点进 `/user` 改档案。
      为什么放侧栏最底下而不是留在设置里：改昵称 / 换头像跟「跑不跑得起来」那几页不是一类事，
      它是**这块界面属于谁**——每个页面都能一眼看到、一步点到，比藏在设置第三层里合理。
      没有用户时（未登录的 web 版）整块不渲染：那时候侧栏本来也没有账号可显示。
    */}
    {user && (
      <Link
        className={'side-user' + (active === 'user' ? ' active' : '')}
        href="/user"
        data-side-user
        title={collapsed ? user.name : undefined}
      >
        <UserAvatar avatar={user.avatar} name={user.name} email={user.email}
          className="side-user-avatar" attrs={{ 'data-avatar': 'side' }} />
        <span className="side-user-body">
          <strong data-side-user-name>{user.name}</strong>
          <small
            data-side-user-mail
            title={siteLabel ? `网站账号 ${siteLabel}｜本机账号 ${user.email}` : undefined}
          >{siteLabel || user.email}</small>
        </span>
      </Link>
    )}
  </>;
}
