'use client';

import { useId } from 'react';
import { BaseEdge, getBezierPath, useStore, type EdgeProps } from '@xyflow/react';

/**
 * 画布连线：平时就是一条普通的贝塞尔线，**只有在跑的时候**才在上面撒几颗流动的星星。
 *
 * 徐先 2026-10-01："我希望画布运行时会有这种星星的效果（平时隐藏）"。
 *
 * 「平时隐藏」是这条需求里最硬的一条：**不跑的时候一个元素都不多画**（那颗 `<g>` 直接
 * 不进 DOM）。不是 opacity:0、不是缩到 0 —— 那样画布上几十条边就多了几十个常驻动画，
 * 什么都不干也在烧 CPU（实测过的那种「什么都没点，风扇先转起来」多半就是这么来的）。
 *
 * 「在跑」怎么判：这条线**两端**任意一个节点处于 running / uploading。
 * 用 `useStore` 直接读 React Flow 的 `nodeLookup` 而不是从父组件把状态传进来 ——
 * 传进来的话 `displayEdges` 就得依赖 `nodes`，而 `nodes` 在**拖动节点时每帧都变**，
 * 于是每帧都要重建整份边数组；用 store selector 只在「真的有节点开始跑 / 跑完」时重渲染。
 *
 * 星星本身是 SVG `animateMotion` + `mpath`：把路径（`d`）挂在一个隐藏 `<path>` 上，
 * 让星星沿它走。好处是节点被拖走、路径变了，星星自动跟着新的曲线走，不用在 JS 里
 * 每帧算坐标（那条路要自己插值，还要自己管 rAF，白写一遍）。
 */
export default function StarEdge({
  id, source, target, sourceX, sourceY, targetX, targetY,
  sourcePosition, targetPosition, markerEnd, style,
}: EdgeProps) {
  /** 路径 id 必须全局唯一：页面上同时有几十条边，撞了就会全部沿同一条线跑。 */
  const pathId = `cv-star-path-${useId().replace(/:/g, '')}`;

  const [path] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const live = useStore(state =>
    busyOf(state.nodeLookup.get(source)) || busyOf(state.nodeLookup.get(target)),
  );

  return (
    <>
      <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
      {live && (
        <g className="cv-star-flow" aria-hidden>
          {/* 星星要沿它走的那条线本身不画（fill / stroke 都没给）。 */}
          <path id={pathId} d={path} fill="none" stroke="none" />
          {STAR_OFFSETS.map(offset => (
            <g key={offset}>
              <circle className="cv-star-halo" r={5.2}>
                <animateMotion
                  dur={`${STAR_DUR_S}s`}
                  /* 负 begin：三颗星错开出场，不必等第一颗走完才看到第二颗。 */
                  begin={`-${(STAR_DUR_S * offset / STAR_OFFSETS.length).toFixed(2)}s`}
                  repeatCount="indefinite"
                  rotate="0"
                  calcMode="linear"
                >
                  <Mpath href={`#${pathId}`} />
                </animateMotion>
              </circle>
              {/* 四角星：二次贝塞尔把四个角往里收，比菱形更像「闪」。 */}
              <path
                className="cv-star-spark"
                d="M0 -3.4 Q0.55 -0.9 3.4 0 Q0.55 0.9 0 3.4 Q-0.55 0.9 -3.4 0 Q-0.55 -0.9 0 -3.4 Z"
              >
                <animateMotion
                  dur={`${STAR_DUR_S}s`}
                  begin={`-${(STAR_DUR_S * offset / STAR_OFFSETS.length).toFixed(2)}s`}
                  repeatCount="indefinite"
                  rotate="0"
                  calcMode="linear"
                >
                  <Mpath href={`#${pathId}`} />
                </animateMotion>
              </path>
            </g>
          ))}
        </g>
      )}
    </>
  );
}

/** 一颗星从头走到尾要几秒。慢一点才看得出「在流」，太快就变成一条闪线。 */
const STAR_DUR_S = 2.6;

/** 三颗星，各自的相位（0 / 1 / 2）。 */
const STAR_OFFSETS = [0, 1, 2];

/**
 * `<mpath>` 要同时给 `href`（SVG2）和 `xlink:href`（老浏览器）：
 * React 对 SVG 属性是按驼峰收的，`xlinkHref` 是它认的那个写法。
 */
function Mpath({ href }: { href: string }) {
  return <mpath href={href} xlinkHref={href} />;
}

/** 这两个状态都算「在跑」：上传也是在为这一轮生成做准备，链上同样该有动静。 */
function busyOf(node: { data?: Record<string, unknown> } | undefined): boolean {
  const status = String(node?.data?.status || '');
  return status === 'running' || status === 'uploading';
}
