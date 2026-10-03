import Link from 'next/link';
import { isDesktop } from '@/lib/edition';

/*
 * 云端完整版：服务连接、本地模式（可选项）、计费、外观。
 *
 * 「本地模式」这一项**指向 `/settings/comfyui`**：2026-09-21 起 `/settings/local`
 * 那一页已经删了（它和 ComfyUI 服务那页重复了地址 / 目录 / 测试连接 / 目录扫描四样），
 * web 版也走同一页 —— 区别只是 web 版那一页里多一个「本地模式」开关、没有启动按钮。
 */
const WEB_TABS = [
  { href: '/settings/providers', label: '服务连接' },
  { href: '/settings/comfyui', label: '本地模式' },
  { href: '/settings/billing', label: '计费' },
  { href: '/settings/appearance', label: '外观' },
];

/*
 * 桌面版：整个软件本来就跑在本机，再叫「本地模式」等于没有信息量 ——
 * 那一页在这里就叫「ComfyUI 服务」，它表达的是「图和算力来自你这台机器上的 ComfyUI」。
 * 工作流配置必须留下：画布的字段绑定（`nodeInfoList`）是照那份配置写的，
 * 桌面版只是把「图跑在哪」换成本机，**绑定怎么配一点没变**。
 * **没有「计费」这一项**：桌面版不卖积分、也没有钱包，那整块在桌面版被摘掉了。
 */
const DESKTOP_TABS = [
  /* 模型服务排第一（2026-09-21）：「这次生成走谁」是来设置页的人第一件要定的事 ——
     RunningHub 走哪个站、提示词优化用哪家、有没有自定义接口，都在这页；
     各家的 key 也在这页填 —— 2026-09-25「密钥中心」整页撤掉之后，这里是唯一填 key 的地方。 */
  { href: '/settings/model-services', label: '模型服务' },
  /* 「服务连接」这一项 2026-09-22 撤了。
     它整页只有一个 RunningHub，而 RunningHub 的选站 / Key / 测试在这之前就已经在「模型服务」里
     —— 同一件事摆两页，用户不知道该信哪一页（徐先就是看到这个才提的）。
     填 Key 与清除密钥现在落在模型服务页「站点账号」下面的「RunningHub 密钥」段里
     （2026-10-03 从「图片」段搬出来）；`/settings/providers` 仍能访问，
     会直接换到模型服务（老书签不落空，桌面版也不会再多出第二份设置界面）。 */
  { href: '/settings/providers/workflows', label: '工作流配置' },
  /* 这一页同时是**配置页和仪表盘**：填地址 / 找目录 → 看连没连上 → 没起来就一键启动 → 看模型清单。
     2026-09-21 之前它和「本机 ComfyUI」是两页，重复了地址、目录、测试连接、目录扫描四样东西，
     改地址要去 A 页、看状态要去 B 页；现在合成一页，一条龙走完。 */
  { href: '/settings/comfyui', label: 'ComfyUI 服务' },
  { href: '/settings/output', label: '输出目录' },
  { href: '/settings/appearance', label: '外观' },
  /* 「版本与更新」只进桌面版（2026-09-29）：web 版刷新一下就是最新版，
     根本没有「用户手上的旧版」这回事 —— 摆一项在那里只会让人以为要手动升浏览器。 */
  { href: '/settings/update', label: '版本与更新' },
  /* 「用户」2026-09-23 搬走了：入口改到侧栏底部那颗用户卡片，页面也从设置区独立成 `/user`。
     它跟「跑不跑得起来」不是一类事 —— 摆在这一排里，想改个昵称得先猜自己在找"设置"。
     ⚠️ 画布上那个设置浮层读的是本文件导出的 `SETTING_TABS`，所以那边跟着一起收掉了。 */
];

const TABS = isDesktop ? DESKTOP_TABS : WEB_TABS;

/**
 * 画布上「设置」那个大浮层（2026-09-21）要的是**同一份顺序与措辞** ——
 * 两处各写一份列表，迟早出现「浮层里少一页」或者「同一页在两处叫两个名字」。
 * 所以从这儿导出，浮层那边只管按 `href` 切内容。
 */
export const SETTING_TABS: { href: string; label: string }[] = TABS;

/** 设置区内部的二级导航。settings 下每新增一个页面都要挂上它（两个版本都要考虑）。 */
export default function SettingsNav({ active }: { active: string }) {
  return <nav className="settings-tabs">
    {TABS.map(tab => (
      <Link key={tab.href} href={tab.href} className={tab.href === active ? 'active' : ''}>
        {tab.label}
      </Link>
    ))}
  </nav>;
}
