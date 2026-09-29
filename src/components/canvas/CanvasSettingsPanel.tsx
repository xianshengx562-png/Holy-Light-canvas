'use client';

import CanvasOverlay from './CanvasOverlay';
import CanvasWorkflowPanel from './CanvasWorkflowPanel';
import RunningHubKeyForm from '@/components/settings/RunningHubKeyForm';
import ComfyuiServicePanel from '@/components/settings/ComfyuiServicePanel';
import OutputDirForm from '@/components/settings/OutputDirForm';
import AppearanceForm from '@/components/settings/AppearanceForm';
import ModelServices, { type ModelServicesPayload } from '@/components/settings/ModelServices';
import { SETTING_TABS } from '@/components/settings/SettingsNav';
import { useApi } from '@/lib/client';
import { isDesktop } from '@/lib/edition';
import type { ConnectionView } from '@/lib/providers/runninghub/connection';
import type { LocalConnectionView } from '@/lib/providers/local/connection';
import type { OutputDirView } from '@/lib/output-dir';
import type { WalletOverview } from '@/lib/wallet';
/* 这三份原来只在各自那一页的壳里 import。浮层里要自己引，否则输入框 / 服务面板会退回浏览器默认的样子。 */
import '@/app/comfyui-service.css';
import '@/app/settings/model-services/model-services.css';

/**
 * 画布左轨「设置」弹出的大浮层：左列是设置的那几页，右边是那一页的内容。
 *
 * 组件直接搬设置页里那几个（模型服务 / 服务连接 / ComfyUI 服务 / 输出目录 / 外观），
 * **不为画布重写一份** —— 同一套设置两处实现，改了一处忘另一处只是时间问题。
 *
 * ⚠️ 三件事别搞混：
 *
 * 1. **取数是「切到哪一页才取哪一页」**（`useApi` 传 null 就不发）。七页一起取的话，
 *    开一次浮层就是七个接口，其中几个还要去问本机 ComfyUI 活没活着 —— 那是几秒钟的事。
 *
 * 2. **内容里那些 `<Link href="/settings/...">` 会被壳拦下来切成左列切页**（`onHref`）。
 *    ComfyUI 服务那句「设置 · 工作流配置」原本是整页跳转，
 *    在画布里照字面跳就是「点了一句话，画布没了」。
 *
 * 3. 桌面版与 web 版的左列不一样（web 版多一个「计费」），这份清单从 `SettingsNav` 导出，
 *    不在这儿另抄一份。
 */

type ProvidersPayload = {
  connection: ConnectionView;
  wallet: WalletOverview;
  defaultWorkflowId: string;
};

export default function CanvasSettingsPanel({
  tab, onTab, onClose,
}: {
  /** 当前那一页（就是设置页的 href，例如 `/settings/model-services`）。 */
  tab: string;
  onTab: (href: string) => void;
  onClose: () => void;
}) {
  /* 每一页自己取自己的数：切走就不取了，切回来 `useApi` 认路径变化会再取一次。 */
  const providers = useApi<ProvidersPayload>(tab === '/settings/providers' ? '/api/settings/providers/bootstrap' : null);
  const local = useApi<LocalConnectionView>(
    tab === '/settings/comfyui' ? '/api/local/connection' : null,
  );
  const output = useApi<OutputDirView>(tab === '/settings/output' ? '/api/settings/output' : null);
  /* 模型服务同样「切到才取」：这一页要问自定义接口在不在，没必要开浮层就问一遍。 */
  const modelServices = useApi<ModelServicesPayload>(
    tab === '/settings/model-services' ? '/api/settings/model-services' : null,
  );

  const active = SETTING_TABS.find(item => item.href === tab) ?? SETTING_TABS[0];
  const connection = providers.data?.connection;
  /** 桌面版没有钱包：给表单传 null，余额那一行整行不渲染（见 RunningHubKeyForm）。 */
  const credits = isDesktop ? null : (providers.data?.wallet ?? null);

  return (
    <CanvasOverlay
      title={active.label}
      kicker="SETTINGS"
      note="改完即刻生效，不用重启软件"
      nav={SETTING_TABS.map(item => ({ key: item.href, label: item.label }))}
      active={active.href}
      onNav={onTab}
      onClose={onClose}
      onHref={onTab}
    >
      {tab === '/settings/model-services' && (
        <>
          <div className="notice">
            「这次生成走谁」都在这页：RunningHub 走哪个站、提示词优化用哪家文本模型、
            自定义接口挂了哪些模型。配好自定义接口，图片 / 视频节点的引擎里会多出「自定义接口」这一项。
          </div>
          {modelServices.error && <div className="notice error">读不到模型服务：{modelServices.error}</div>}
          {modelServices.loading && !modelServices.data && <div className="notice">正在读取模型服务…</div>}
          {modelServices.data && (
            <ModelServices initial={modelServices.data} reload={modelServices.reload} />
          )}
        </>
      )}

      {/*
        * 桌面版左列里已经没有「服务连接」这一项（2026-09-22 并进模型服务），
        * 这一段只有 web 版浮层会走到。留着是因为左列清单来自 `SETTING_TABS`、两版共用，
        * 删掉反而会变成「导航里有、点开空白」。
        */}
      {tab === '/settings/providers' && (
        <section className="provider">
          <div className="provider-head">
            <div><h2>RunningHub</h2><p className="muted">工作流与算力服务</p></div>
            <span className="badge">{connection?.hasKey ? '已配置' : '未配置'}</span>
          </div>
          {providers.error && <div className="notice error">读不到服务连接：{providers.error}</div>}
          {providers.loading && !providers.data && <div className="notice">正在读取服务连接…</div>}
          <div className="notice">{connection?.source === 'user'
            ? `已为你的账号单独保存密钥，优先级高于服务端环境变量。当前默认工作流：${providers.data?.defaultWorkflowId ?? ''}`
            : connection?.source === 'env'
              ? `当前使用服务端环境变量中的密钥。你可以在下方填写自己的密钥覆盖它。当前默认工作流：${providers.data?.defaultWorkflowId ?? ''}`
              : '尚未配置密钥。请在下方填写，或由管理员在项目 .env 中配置 RUNNINGHUB_API_KEY。'}</div>
          {connection && <RunningHubKeyForm initial={connection} credits={credits} />}
        </section>
      )}

      {tab === '/settings/providers/workflows' && <CanvasWorkflowPanel embedded />}

      {tab === '/settings/comfyui' && (
        <>
          {local.error && <div className="notice error">读不到本机连接配置：{local.error}</div>}
          {local.loading && !local.data && <div className="notice">正在读取本机连接…</div>}
          {local.data && <ComfyuiServicePanel initial={local.data} />}
        </>
      )}

      {tab === '/settings/output' && (
        <section className="provider">
          <div className="provider-head">
            <div><h2>产出存在哪</h2><p className="muted">生成出来的图、视频与 latent 都落进这个文件夹</p></div>
            <span className="badge">{output.data?.source === 'custom' ? '自定义' : '默认'}</span>
          </div>
          {output.error && <div className="notice error">读不到输出目录配置：{output.error}</div>}
          {output.loading && !output.data && <div className="notice">正在读取输出目录…</div>}
          <div className="notice">默认落在软件自己的数据目录里（系统盘底下、路径很深）。换成你自己挑的文件夹之后，找文件、备份、挪到外接硬盘都方便。</div>
          {output.data && <OutputDirForm initial={output.data} />}
        </section>
      )}

      {tab === '/settings/appearance' && <AppearanceForm />}

      {/* web 版左列多一个「计费」：那一页带着钱包与充值按钮，画布里不做第二份，说明清楚就行。 */}
      {!SETTING_TABS.some(item => item.href === tab) && (
        <p className="cv-ov-empty">这一页只在设置页里有（画布里没做第二份）。</p>
      )}
    </CanvasOverlay>
  );
}
