'use client';

/*
 * 画布的撤回 / 下一步（2026-10-04 徐先：「ctrl+z撤回，ctrl+shift+z下一步」）。
 *
 * 🔴 只记**结构改动**：加 / 删节点、连线与断线、挪位置、改尺寸、粘贴、删除、导入素材。
 *    参数区里敲的提示词、下拉、开关**一步都不记** —— 否则每敲一个字就是一步，
 *    撤起来像在跟输入框打架（他选的就是这一档）。
 *    所以这里不订阅 `onNodesChange`，而是由 CanvasEditor 在那十来个「真的改了图」的
 *    函数里**手动**调一次 `record()` —— 记什么完全由调用点决定。
 *
 * 🔴 只给快捷键：界面上不出现任何入口（他选的也是这一档）。所以这里没有 canUndo / canRedo
 *    之类的对外读数 —— 没有可撤 / 可进的时候 `undo()` / `redo()` 直接返回 null，
 *    调用方什么都不做、什么都不弹。
 *
 * 这个文件的上半部分是**零依赖纯函数**（只 `import type`），可以单独编译成 CJS 跑单测
 * （见 `C:\FRAME\_test-canvas-history.py`）；下半部分是那个 React hook。
 */

import type { Edge, Node } from '@xyflow/react';
import { useCallback, useRef } from 'react';
import type { NodeData } from './types';

/** 一份冻住的画布：把每张卡片、每条线放回原样所需的全部信息。 */
export type CanvasSnapshot = {
  nodes: Node<NodeData>[];
  edges: Edge[];
};

/** 最多留多少步。再多是白占内存 —— 撤到第 50 步之前早就重画了。 */
export const HISTORY_LIMIT = 50;

/**
 * 快照只拷**结构**这一层：节点对象、它的位置、它的 `data` 各拷一份浅拷贝。
 *
 * 🔴 为什么是浅拷贝而不是 `structuredClone`：`data` 里挂着 `onResize` 这类回调
 *    （`hydrated` 现注进去的），深拷贝会把函数也一起丢了；而我们要还原的
 *    只是 `position` / `data.width` 这些值，浅拷贝一层就够。
 *    `position` 和 `measured` 这两层是对象，得单独拷 —— 不拷的话 React Flow
 *    量完会直接改在原对象上，快照跟着变，等于没拍。
 */
export function snapshotCanvas(
  nodes: Node<NodeData>[],
  edges: Edge[],
): CanvasSnapshot {
  return {
    nodes: nodes.map(node => ({
      ...node,
      position: { x: node.position.x, y: node.position.y },
      data: { ...node.data },
      measured: node.measured ? { ...node.measured } : node.measured,
    })),
    edges: edges.map(edge => ({ ...edge })),
  };
}

/**
 * 两份快照的**结构**是不是一样：节点集合、每个节点的位置与尺寸、连线集合。
 *
 * 🔴 刻意只看这几项：`data` 里的提示词、生成结果、上传状态变没变**不算结构变了**
 *    （拖一把没拖动、点一下把手没改尺寸，都该判定为「没变」，不能白记一步）。
 */
export function sameCanvas(a: CanvasSnapshot, b: CanvasSnapshot): boolean {
  if (a.nodes.length !== b.nodes.length) return false;
  if (a.edges.length !== b.edges.length) return false;
  const before = new Map(a.nodes.map(node => [node.id, node]));
  for (const node of b.nodes) {
    const old = before.get(node.id);
    if (!old) return false;
    if (old.position.x !== node.position.x || old.position.y !== node.position.y) return false;
    if (old.data.width !== node.data.width || old.data.height !== node.data.height) return false;
  }
  const wires = new Set(a.edges.map(edge => edge.id));
  for (const edge of b.edges) if (!wires.has(edge.id)) return false;
  return true;
}

/**
 * 走一步：从 `past` / `future` 里取出该还原的那一份，并把**当前**这份推到另一边。
 *
 * @param current 走这一步之前画布的现状（撤回时要塞进 future，下一步时塞进 past）。
 * @returns 没有可走的那一步就是 `null` —— 调用方据此「什么都不做」。
 */
export function stepHistory(
  past: CanvasSnapshot[],
  future: CanvasSnapshot[],
  current: CanvasSnapshot,
  dir: 'undo' | 'redo',
): { restore: CanvasSnapshot; past: CanvasSnapshot[]; future: CanvasSnapshot[] } | null {
  if (dir === 'undo') {
    const restore = past[past.length - 1];
    if (!restore) return null;
    return { restore, past: past.slice(0, -1), future: [...future, current] };
  }
  const restore = future[future.length - 1];
  if (!restore) return null;
  return { restore, past: [...past, current], future: future.slice(0, -1) };
}

/** 把一份快照压进 past，并清掉 future（走了新的一步，原来那条「下一步」就作废了）。 */
export function pushHistory(
  past: CanvasSnapshot[],
  snap: CanvasSnapshot,
): CanvasSnapshot[] {
  const next = [...past, snap];
  /* 只留最近 HISTORY_LIMIT 步：超了从最早那一步开始丢。 */
  return next.length > HISTORY_LIMIT ? next.slice(next.length - HISTORY_LIMIT) : next;
}

type Refs = {
  nodesRef: { current: Node<NodeData>[] };
  edgesRef: { current: Edge[] };
};

/**
 * 撤销栈。
 *
 * 三件事分开给，是因为它们对应两种不同的动作：
 * - `record()` —— 一次改完就了事的（加节点、删节点、连 / 断线…）：**改之前**调一次；
 * - `beginGesture()` / `endGesture()` —— 拖节点、拖把手这种**连续**动作：
 *   开始各留一份，结束时才决定留不留（点一下没动不能算一步）。
 */
export function useCanvasHistory({ nodesRef, edgesRef }: Refs) {
  const past = useRef<CanvasSnapshot[]>([]);
  const future = useRef<CanvasSnapshot[]>([]);
  /** 手势开始那一刻的快照；手势结束后清掉，避免被下一次误用。 */
  const pending = useRef<CanvasSnapshot | null>(null);

  const now = useCallback(
    () => snapshotCanvas(nodesRef.current, edgesRef.current),
    [edgesRef, nodesRef],
  );

  /** 记一步：把**现在**这份推进 past。 */
  const record = useCallback(() => {
    past.current = pushHistory(past.current, now());
    future.current = [];
  }, [now]);

  /** 开始一次「可能改到画布」的手势（拖动 / 改尺寸）。 */
  const beginGesture = useCallback(() => {
    pending.current = now();
  }, [now]);

  /**
   * 结束手势：真的变了才记一步。
   *
   * @param changed 不传就当作「变了」。传函数是因为拖节点这类动作结束时，
   *   `nodesRef` 那一帧未必已经刷新（React 还在批处理），调用方手上有更准的
   *   那一刻的数据（React Flow 把拖动的节点直接递给 `onNodeDragStop`），
   *   让它自己跟 `before` 比一比更可靠。
   */
  const endGesture = useCallback((changed?: boolean | ((before: CanvasSnapshot) => boolean)) => {
    const before = pending.current;
    pending.current = null;
    if (!before) return;
    const moved = typeof changed === 'function' ? changed(before) : changed !== false;
    if (moved) {
      past.current = pushHistory(past.current, before);
      future.current = [];
    }
  }, []);

  const move = useCallback((dir: 'undo' | 'redo') => {
    const step = stepHistory(past.current, future.current, now(), dir);
    if (!step) return null;
    past.current = step.past;
    future.current = step.future;
    return step.restore;
  }, [now]);

  /** 撤回一步。没有可撤的就返回 null（调用方什么都不做、什么都不弹）。 */
  const undo = useCallback(() => move('undo'), [move]);
  /** 前进一步。没有可进的就返回 null —— 徐先：「没有下一步就什么都不显示」。 */
  const redo = useCallback(() => move('redo'), [move]);

  return { record, beginGesture, endGesture, undo, redo };
}
