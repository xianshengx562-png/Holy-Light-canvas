'use client';
import { createContext, useContext } from 'react';

/**
 * 「右侧节点参数栏是不是开着」—— 画布上每张节点卡片都要拿它做决定。
 *
 * 🔴 为什么要有这个 Context（2026-10-08 徐先）：
 *   同一份节点参数现在有**两个落点** —— 选中那张卡片下方的浮条（`NodeCard` 里的
 *   `NodeParamBar`），以及右侧的参数栏（`NodeInspector` 里同一个组件）。两边同时画，
 *   屏幕上就是**一屏两份一模一样的表单**（那份下拉还会被探针数成两条）。
 *   徐先定的规矩：**参数栏开着就只在参数栏改，关掉参数栏才回到卡片下方。**
 *
 * ⚠️ 生成类节点（图片 / 视频 / RunningHub 应用…）走的是 `GenerateDock` 那条路，
 *   它在 `CanvasEditor` 里早就按 `inspectorOpen` 收放了（`!inspectorOpen && dockNode`），
 *   不经过这里 —— 但**两边用的是同一条判定**（都是 `inspectorOpen`），别各写一套。
 *
 * ⚠️ 值要带上 `&& !zen`：无遮挡模式下 `NodeInspector` 整个不渲染（见 CanvasEditor 里
 *   `inspectorOpen && !zen && <NodeInspector …>`）。只看 `inspectorOpen` 的话，进了无遮挡
 *   模式「参数栏开着但看不见」、卡片下方也不画 → 这个节点的参数**一个入口都没有**。
 *
 * ⚠️ 默认值 `true`（= 参数栏开着）是**故意保守**：万一某条渲染路径拿不到 Provider，
 *   宁可不画卡片下方那条浮条，也不能两边各画一份出来。
 */
export const ParamPanelOpenContext = createContext(true);

export const useParamPanelOpen = () => useContext(ParamPanelOpenContext);
