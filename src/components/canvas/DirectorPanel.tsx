'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Crosshair, Layers, Plus, Trash2, X } from 'lucide-react';
import CanvasOverlay from './CanvasOverlay';
import DirectorStage, { type DirectorStageHandle } from './DirectorStage';
import {
  DIRECTOR_MAX_ACTORS, DIRECTOR_PRESETS, DIRECTOR_RATIOS, DIRECTOR_SCENE_PRESETS, DIRECTOR_SNAPS,
  addActor, applyScenePreset, applyUserPreset, clampCamera, describeShot,
  duplicateActor, duplicateActors, faceCameraActors, initialDirectorScene, mirrorActors,
  nudgeActors, patchActor, removeActor, removeActors, setSelection, spreadActors,
  toggleSelection, userPresetOf,
  type DirectorCamera, type DirectorScene, type DirectorUserPreset,
} from '@/lib/director';
import { dropUserPreset, loadUserPresets, putUserPreset, writeUserPresets } from '@/lib/directorPresets';

/**
 * 3D 导演台。
 *
 * 它做的是**构图参考图**：摆几个灰模当人，调好机位，存一张图下来，
 * 连给图片生成 / 视频生成节点当参考图，让模型照着这个机位和站位出画面。
 *
 * ⚠️ 三条边界：
 *
 * 1. **不调用模型、不产生费用**。存参考图是浏览器里画完直接导出 PNG，
 *    跟「生成」完全是两件事 —— 面板上那句说明不是客套，是防止用户以为点一下要花钱。
 *
 * 2. **改的是节点里的场景，不是画布**。场景存在节点的 `data` 上跟着画布一起存，
 *    所以关掉面板再打开，站位还在。这也是它和「一次性弹窗」的区别。
 *
 * 3. **存下来的图落在本项目下**（`/api/tools/archive`）。提交生成时服务端按
 *    `/api/assets/...` 读盘重传，所以这里不需要先传到远端平台 ——
 *    出一张构图草图不该被另一个平台的凭据卡住。
 */

/** 一行滑块。导演台里所有连续量（角度、距离、身高）都靠它调。 */
function Slider({
  label, unit, min, max, step, value, disabled, onChange,
}: {
  label: string;
  unit: string;
  min: number;
  max: number;
  step: number;
  value: number;
  disabled?: boolean;
  onChange: (next: number) => void;
}) {
  return (
    <label className="cv-dir-slider">
      <span>{label}</span>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={event => onChange(Number(event.currentTarget.value))}
      />
      <b>{`${Number(value.toFixed(2))}${unit}`}</b>
    </label>
  );
}

export default function DirectorPanel({
  scene, onChange, onClose, onSave,
}: {
  scene: DirectorScene;
  onChange: (next: DirectorScene) => void;
  onClose: () => void;
  /** 存参考图。抛出的错误会原样显示在面板底部（那是用户唯一能看懂的反馈）。 */
  onSave: (dataUrl: string, scene: DirectorScene) => Promise<void>;
}) {
  const stageRef = useRef<DirectorStageHandle>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  /* 「我的预设」：一进面板读一次，之后每次写盘都顺手更新这份 state。 */
  const [mine, setMine] = useState<DirectorUserPreset[]>([]);
  const [presetName, setPresetName] = useState('');

  const camera = (patch: Partial<DirectorCamera>) => apply({ ...scene, camera: clampCamera({ ...scene.camera, ...patch }) });
  const picked = scene.actors.find(actor => actor.id === scene.selectedId) ?? null;
  /** 多选集合。旧节点的场景里没有这个字段，这里兜一层空数组。 */
  const chosen = Array.isArray(scene.selectedIds) ? scene.selectedIds : [];
  const full = scene.actors.length >= DIRECTOR_MAX_ACTORS;

  useEffect(() => { setMine(loadUserPresets()); }, []);

  /**
   * 把当前构图存成一条用户预设。
   *
   * 名字留空就自动起「我的预设 N」，N 取**最小的空位**：删掉中间几条之后再存，
   * 不会撞上一个还活着的同名预设（撞了就会把它覆盖掉，用户会以为「存了没反应」）。
   */
  const savePreset = useCallback(() => {
    const taken = new Set(mine.map(item => item.label));
    let index = mine.length + 1;
    while (taken.has('我的预设' + index)) index += 1;
    const label = presetName.trim().slice(0, 12) || '我的预设' + index;
    const id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const next = putUserPreset(mine, userPresetOf(scene, id, label));
    writeUserPresets(next);
    setMine(next);
    setPresetName('');
  }, [mine, presetName, scene]);

  const removePreset = useCallback((id: string) => {
    const next = dropUserPreset(mine, id);
    writeUserPresets(next);
    setMine(next);
  }, [mine]);

  /*
   * 撤销 / 重做。
   *
   * 拖一个滑块会一分钟里打来几十次 onChange —— 每次都入栈的话，Ctrl+Z 一下只退
   * 0.05 米，退到天亮也退不完。所以按**时间**合并：连续改动（间隔 < 450ms）只记
   * 最初那一份，停手之后再改才是新的一步；增删复制这类结构性动作则必定单独成一步。
   */
  const historyRef = useRef<{ past: DirectorScene[]; future: DirectorScene[]; lastAt: number }>({ past: [], future: [], lastAt: 0 });
  const apply = useCallback((next: DirectorScene, structural?: boolean) => {
    const now = Date.now();
    const history = historyRef.current;
    if (structural || now - history.lastAt > 450) {
      history.past.push(scene);
      if (history.past.length > 60) history.past.shift();
      history.future.length = 0;
    }
    history.lastAt = now;
    onChange(next);
  }, [scene, onChange]);

  const undo = useCallback(() => {
    const history = historyRef.current;
    const previous = history.past.pop();
    if (!previous) return;
    history.future.push(scene);
    history.lastAt = 0;
    onChange(previous);
  }, [scene, onChange]);

  const redo = useCallback(() => {
    const history = historyRef.current;
    const next = history.future.pop();
    if (!next) return;
    history.past.push(scene);
    history.lastAt = 0;
    onChange(next);
  }, [scene, onChange]);

  /** 聚焦选中灰模：注视点对到它身上（Blender / Unity 的 F 键同款语义）。 */
  const focusPicked = useCallback(() => {
    if (!picked) return;
    camera({
      targetHeight: picked.y + picked.height / 2,
      distance: Math.min(24, Math.max(1.2, picked.height * 2.4)),
    });
  }, [picked, camera]);

  /**
   * 关面板之前问一句：正在多选的时候，Esc 只退多选、不关面板。
   *
   * 多选着按 Esc，想的是「别选了」，结果整块导演台连摆了一半的构图一起没了 ——
   * 这个坑是探针撞出来的：壳的 Esc 走捕获阶段并且先 `stopPropagation()`，
   * 面板自己那份（冒泡阶段）根本收不到，所以只能走壳提供的这道闸。
   * ✕ 和点灰也过同一道闸，于是它们也是「先退多选，再关」—— 一致的。
   */
  const guardClose = useCallback(() => {
    if (!chosen.length) return true;
    apply({ ...scene, selectedIds: [] }, true);
    return false;
  }, [chosen.length, scene, apply]);

  /**
   * 点角色 chip 的三种点法。
   *
   * Ctrl/⌘+点 = 加进 / 移出多选（批量模式的入口）；Shift+点 = 从主选连选到这一个；
   * 光点 = 单选，并顺手退出批量模式（不然「选了三个又点了一个」到底算谁说不清）。
   */
  const pickActor = (id: string, event: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => {
    if (event.ctrlKey || event.metaKey) {
      apply(toggleSelection(scene, id), true);
      return;
    }
    if (event.shiftKey && scene.selectedId && scene.selectedId !== id) {
      const from = scene.actors.findIndex(actor => actor.id === scene.selectedId);
      const to = scene.actors.findIndex(actor => actor.id === id);
      if (from >= 0 && to >= 0) {
        const lo = Math.min(from, to);
        const hi = Math.max(from, to);
        apply(setSelection(scene, scene.actors.slice(lo, hi + 1).map(actor => actor.id)), true);
        return;
      }
    }
    apply({ ...scene, selectedId: id, selectedIds: [] }, true);
  };

  /**
   * 复制一个（offset = 0.7 错开 / 0 原地）。
   *
   * 原地复制之后**必须**给一句提示：副本和原件像素级重叠，用户点完看见「什么都没变」
   * 会以为按钮坏了 —— 这句提示是这个按钮的一部分，不是客套。
   */
  const duplicateOne = (offset: number) => {
    if (!picked || full) return;
    apply(duplicateActor(scene, picked.id, newIds(), offset), true);
    setNote(offset ? '' : `已原地复制「${picked.label}」—— 副本跟原件完全重叠，挪一下或改个参数才看得出来。`);
  };

  /** 批量复制选中的几个。 */
  const duplicateMany = (offset: number) => {
    if (!chosen.length) return;
    const next = duplicateActors(scene, chosen, newIds(), offset);
    apply(next, true);
    const made = next.selectedIds.length;
    if (!made) setNote(`一个都没复制成 —— 一个场景最多 ${DIRECTOR_MAX_ACTORS} 个灰模。`);
    else if (offset) setNote(`已复制 ${made} 个（往右前错开半步）。`);
    else setNote(`已原地复制 ${made} 个 —— 副本跟原件完全重叠，整体挪一下才看得见。`);
  };

  /** 批量整体挪动半米。dz 为负 = 往画面深处走。 */
  const nudgeMany = (dx: number, dz: number) => {
    if (!chosen.length) return;
    apply(nudgeActors(scene, chosen, dx, dz), true);
  };

  /*
   * 键盘：Del 删除 / Ctrl+D 复制 / Ctrl+Shift+D 原地复制 / Ctrl+A 全选 /
   * Ctrl+Z 撤销 / Ctrl+Shift+Z（或 Ctrl+Y）重做 / F 聚焦 / Esc 退出多选。
   * 挂在 window 上（面板开着就生效），但焦点在输入框里时全部让路 ——
   * 不然改名打到 D 字母人就多出一个。
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const key = event.key.toLowerCase();
      if (key === 'escape') {
        if (!chosen.length) return;
        event.preventDefault();
        apply({ ...scene, selectedIds: [] }, true);
      } else if (key === 'delete' || key === 'backspace') {
        if (chosen.length > 1) {
          event.preventDefault();
          setNote('');
          apply(removeActors(scene, chosen), true);
          return;
        }
        if (!picked) return;
        event.preventDefault();
        apply(removeActor(scene, picked.id), true);
      } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'd') {
        event.preventDefault();
        duplicateOne(0);
      } else if ((event.ctrlKey || event.metaKey) && key === 'd') {
        event.preventDefault();
        duplicateOne(0.7);
      } else if ((event.ctrlKey || event.metaKey) && key === 'a') {
        event.preventDefault();
        apply(setSelection(scene, scene.actors.map(actor => actor.id)), true);
      } else if ((event.ctrlKey || event.metaKey) && !event.shiftKey && key === 'z') {
        event.preventDefault();
        undo();
      } else if (((event.ctrlKey || event.metaKey) && event.shiftKey && key === 'z') || ((event.ctrlKey || event.metaKey) && key === 'y')) {
        event.preventDefault();
        redo();
      } else if (key === 'f' && !event.ctrlKey && !event.metaKey) {
        focusPicked();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /**
   * 新灰模 id 的生成器（返回**函数**，不是一个 id）。
   *
   * 批量复制一次要发好几个：同一个生成器连着取才不会「复制三个都叫 actor-3」，
   * 撞 id 的表现是拖一个动仨。
   */
  const newIds = () => {
    const used = new Set(scene.actors.map(actor => actor.id));
    let index = scene.actors.length + 1;
    return () => {
      while (used.has(`actor-${index}`)) index += 1;
      const id = `actor-${index}`;
      used.add(id);
      index += 1;
      return id;
    };
  };
  const nextActorId = newIds();

  async function save() {
    if (busy) return;
    const dataUrl = stageRef.current?.capture();
    if (!dataUrl || !dataUrl.startsWith('data:image/png')) {
      setNote('视口还没准备好，稍后再试一次。');
      return;
    }
    setBusy(true);
    setNote('');
    try {
      await onSave(dataUrl, scene);
    } catch (error) {
      setNote(error instanceof Error ? error.message : '保存参考图失败，请重试。');
    } finally {
      setBusy(false);
    }
  }

  return (
    <CanvasOverlay
      title="3D 导演台"
      kicker="Holy Light画布"
      note="摆好站位和机位，存成构图参考图；不调用模型，不产生费用。"
      onClose={onClose}
      guard={guardClose}
      actions={(
        <>
          <button type="button" className="cv-btn sm ghost" aria-label="撤销" disabled={busy} onClick={undo}>撤销</button>
          <button type="button" className="cv-btn sm ghost" aria-label="重做" disabled={busy} onClick={redo}>重做</button>
          <button type="button" className="cv-btn sm ghost" disabled={busy} onClick={() => apply(initialDirectorScene(), true)}>
            重置
          </button>
          <button type="button" className="cv-btn sm primary" disabled={busy} onClick={() => void save()}>
            {busy ? '正在保存…' : '存为参考图'}
          </button>
        </>
      )}
    >
      <div className="cv-dir">
        <div className="cv-dir-left">
          <DirectorStage
            ref={stageRef}
            scene={scene}
            onCamera={camera}
            onActorMove={(id, x, z) => apply(patchActor(scene, id, { x, z }))}
            onActorAxis={(id, axis, value) => apply(patchActor(scene, id, axis === 'y' ? { y: value } : axis === 'x' ? { x: value } : { z: value }))}
            onActorPick={id => apply({ ...scene, selectedId: id })}
          />
          <div className="cv-dir-shot">{describeShot(scene.camera)}</div>
          <p className="cv-dir-hint">
            点灰模出三轴箭头：沿轴拖精调（绿 = 上下），抓身体自由走位；拖空白处环绕机位，滚轮推拉。Del 删除 · Ctrl+D 复制 · Ctrl+Shift+D 原地复制 · Ctrl+Z 撤销 · F 聚焦。
            {' '}
            Ctrl/⌘+点角色可多选（Shift 连选、Esc 取消），选完批量复制 / 挪动 / 排开 / 删除。
          </p>
        </div>

        <div className="cv-dir-right">
          <section>
            <h4>构图预设</h4>
            <div className="cv-dir-chips" role="group" aria-label="构图预设" data-dir-preset-group>
              {DIRECTOR_SCENE_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  className="cv-dir-chip"
                  data-dir-preset={preset.id}
                  title={preset.hint}
                  disabled={busy}
                  onClick={() => apply(applyScenePreset(scene, preset), true)}
                >
                  {preset.label}
                </button>
              ))}
            </div>

            <span className="cv-dir-sub">我的预设</span>
            <div className="cv-dir-chips" role="group" aria-label="我的预设" data-dir-mine-group>
              {mine.map(preset => (
                <span className="cv-dir-preset" key={preset.id} data-dir-mine={preset.id}>
                  <button
                    type="button"
                    className="use"
                    title={'套用「' + preset.label + '」'}
                    disabled={busy}
                    onClick={() => apply(applyUserPreset(scene, preset), true)}
                  >
                    {preset.label}
                  </button>
                  <button
                    type="button"
                    className="del"
                    aria-label={'删除预设 ' + preset.label}
                    data-dir-mine-del={preset.id}
                    disabled={busy}
                    onClick={() => removePreset(preset.id)}
                  >
                    <X size={11} strokeWidth={2.4} aria-hidden />
                  </button>
                </span>
              ))}
              {!mine.length && <span className="cv-dir-sub">还没有自己的预设 —— 摆好之后在下面存一个。</span>}
            </div>

            <div className="cv-dir-saverow">
              <input
                type="text"
                aria-label="预设名字"
                placeholder="预设名字（可留空）"
                maxLength={12}
                data-dir-preset-name
                value={presetName}
                disabled={busy}
                onChange={event => setPresetName(event.currentTarget.value)}
                onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); savePreset(); } }}
              />
              <button type="button" className="cv-dir-chip add" data-dir-preset-save disabled={busy} onClick={savePreset}>
                <Plus size={12} strokeWidth={2.4} aria-hidden />
                存为预设
              </button>
            </div>
          </section>

          <section>
            <h4>画幅</h4>
            <div className="cv-dir-chips" role="group" aria-label="画幅">
              {DIRECTOR_RATIOS.map(ratio => (
                <button
                  key={ratio}
                  type="button"
                  className={`cv-dir-chip${ratio === scene.ratio ? ' on' : ''}`}
                  aria-pressed={ratio === scene.ratio}
                  disabled={busy}
                  onClick={() => apply({ ...scene, ratio })}
                >
                  {ratio}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4>站位吸附</h4>
            <div className="cv-dir-chips" role="group" aria-label="站位吸附">
              {DIRECTOR_SNAPS.map(snap => (
                <button
                  key={snap}
                  type="button"
                  className={`cv-dir-chip${scene.snap === snap ? ' on' : ''}`}
                  aria-pressed={scene.snap === snap}
                  disabled={busy}
                  onClick={() => apply({ ...scene, snap })}
                >
                  {snap === 0 ? '关' : `${snap}m`}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4>机位预设</h4>
            <div className="cv-dir-chips" role="group" aria-label="机位预设">
              {DIRECTOR_PRESETS.map(preset => (
                <button
                  key={preset.id}
                  type="button"
                  className="cv-dir-chip"
                  disabled={busy}
                  onClick={() => camera(preset.camera)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
          </section>

          <section>
            <h4>镜头</h4>
            <Slider label="环绕" unit="°" min={-180} max={180} step={1} value={scene.camera.azimuth} disabled={busy} onChange={azimuth => camera({ azimuth })} />
            <Slider label="俯仰" unit="°" min={-35} max={85} step={1} value={scene.camera.elevation} disabled={busy} onChange={elevation => camera({ elevation })} />
            <Slider label="距离" unit="m" min={1.2} max={24} step={0.1} value={scene.camera.distance} disabled={busy} onChange={distance => camera({ distance })} />
            <Slider label="视角" unit="°" min={12} max={90} step={1} value={scene.camera.fov} disabled={busy} onChange={fov => camera({ fov })} />
            <Slider label="注视高度" unit="m" min={0} max={3} step={0.05} value={scene.camera.targetHeight} disabled={busy} onChange={targetHeight => camera({ targetHeight })} />
          </section>

          <section>
            <h4>{`角色与道具 · ${scene.actors.length}/${DIRECTOR_MAX_ACTORS}`}</h4>
            <div className="cv-dir-chips" role="group" aria-label="角色与道具">
              {scene.actors.map(actor => (
                <button
                  key={actor.id}
                  type="button"
                  className={`cv-dir-chip${actor.id === scene.selectedId ? ' on' : chosen.includes(actor.id) ? ' pick' : ''}`}
                  aria-pressed={actor.id === scene.selectedId || chosen.includes(actor.id)}
                  data-dir-actor={actor.id}
                  disabled={busy}
                  onClick={event => pickActor(actor.id, event)}
                >
                  {actor.label}
                </button>
              ))}
              {(['person', 'prop'] as const).map(kind => (
                <button
                  key={kind}
                  type="button"
                  className="cv-dir-chip add"
                  aria-label={kind === 'person' ? '添加人物' : '添加道具'}
                  disabled={busy || full}
                  onClick={() => apply(addActor(scene, kind, nextActorId), true)}
                >
                  <Plus size={12} strokeWidth={2.4} aria-hidden />
                  {kind === 'person' ? '人物' : '道具'}
                </button>
              ))}
            </div>

            {chosen.length > 1 && (
              <div className="cv-dir-bulk" data-dir-bulk>
                <div className="cv-dir-bulkhead">
                  <span>{`已选 ${chosen.length} 个`}</span>
                  <button
                    type="button"
                    className="cv-dir-chip"
                    data-dir-bulk-all
                    disabled={busy}
                    onClick={() => apply(setSelection(scene, scene.actors.map(actor => actor.id)), true)}
                  >
                    全选
                  </button>
                  <button
                    type="button"
                    className="cv-dir-chip"
                    data-dir-bulk-none
                    disabled={busy}
                    onClick={() => apply({ ...scene, selectedIds: [] }, true)}
                  >
                    取消
                  </button>
                </div>
                <div className="cv-dir-bulkrow" role="group" aria-label="批量操作">
                  <button type="button" className="cv-dir-chip" data-dir-bulk-dup disabled={busy || full} onClick={() => duplicateMany(0.7)}>
                    复制
                  </button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-dup-inplace disabled={busy || full} onClick={() => duplicateMany(0)}>
                    原地复制
                  </button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-mirror disabled={busy} onClick={() => apply(mirrorActors(scene, chosen), true)}>
                    左右镜像
                  </button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-spread disabled={busy} onClick={() => apply(spreadActors(scene, chosen), true)}>
                    等距排开
                  </button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-face disabled={busy} onClick={() => apply(faceCameraActors(scene, chosen), true)}>
                    面朝镜头
                  </button>
                  <button type="button" className="cv-dir-chip danger" data-dir-bulk-del disabled={busy} onClick={() => apply(removeActors(scene, chosen), true)}>
                    删除
                  </button>
                </div>
                <div className="cv-dir-bulkrow" role="group" aria-label="整体挪动">
                  <span className="cv-dir-sub">整体挪 0.5m</span>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-nudge="left" aria-label="整体左移" title="整体左移 0.5m" disabled={busy} onClick={() => nudgeMany(-0.5, 0)}>←</button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-nudge="right" aria-label="整体右移" title="整体右移 0.5m" disabled={busy} onClick={() => nudgeMany(0.5, 0)}>→</button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-nudge="back" aria-label="整体后移" title="整体往画面深处 0.5m" disabled={busy} onClick={() => nudgeMany(0, -0.5)}>↑</button>
                  <button type="button" className="cv-dir-chip" data-dir-bulk-nudge="front" aria-label="整体前移" title="整体往镜头前 0.5m" disabled={busy} onClick={() => nudgeMany(0, 0.5)}>↓</button>
                </div>
              </div>
            )}

            {picked && (
              <div className="cv-dir-actor" data-director-actor={picked.id}>
                <div className="cv-dir-name">
                  <input
                    type="text"
                    aria-label="名称"
                    maxLength={12}
                    value={picked.label}
                    disabled={busy}
                    onChange={event => apply(patchActor(scene, picked.id, { label: event.currentTarget.value }))}
                  />
                  <button
                    type="button"
                    className="cv-dir-del plain"
                    aria-label={`聚焦 ${picked.label}`}
                    title="聚焦（F）"
                    disabled={busy}
                    onClick={focusPicked}
                  >
                    <Crosshair size={13} strokeWidth={1.9} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="cv-dir-del plain"
                    aria-label={`复制 ${picked.label}`}
                    title="复制（Ctrl+D）"
                    disabled={busy || full}
                    onClick={() => duplicateOne(0.7)}
                  >
                    <Copy size={13} strokeWidth={1.9} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="cv-dir-del plain"
                    aria-label={`原地复制 ${picked.label}`}
                    data-dir-dup-inplace
                    title="原地复制（Ctrl+Shift+D）：副本跟原件完全重叠"
                    disabled={busy || full}
                    onClick={() => duplicateOne(0)}
                  >
                    <Layers size={13} strokeWidth={1.9} aria-hidden />
                  </button>
                  <button
                    type="button"
                    className="cv-dir-del"
                    aria-label={`删除 ${picked.label}`}
                    disabled={busy}
                    onClick={() => apply(removeActor(scene, picked.id), true)}
                  >
                    <Trash2 size={13} strokeWidth={1.9} aria-hidden />
                  </button>
                </div>
                <Slider label="左右" unit="m" min={-6} max={6} step={0.1} value={picked.x} disabled={busy} onChange={x => apply(patchActor(scene, picked.id, { x }))} />
                <Slider label="前后" unit="m" min={-6} max={6} step={0.1} value={picked.z} disabled={busy} onChange={z => apply(patchActor(scene, picked.id, { z }))} />
                <Slider label="离地" unit="m" min={0} max={5} step={0.05} value={picked.y} disabled={busy} onChange={y => apply(patchActor(scene, picked.id, { y }))} />
                <Slider label="朝向" unit="°" min={-180} max={180} step={5} value={picked.rotation} disabled={busy} onChange={rotation => apply(patchActor(scene, picked.id, { rotation }))} />
                <Slider
                  label={picked.kind === 'person' ? '身高' : '高度'}
                  unit="m"
                  min={picked.kind === 'person' ? 0.8 : 0.2}
                  max={picked.kind === 'person' ? 2.2 : 4}
                  step={0.05}
                  value={picked.height}
                  disabled={busy}
                  onChange={height => apply(patchActor(scene, picked.id, { height }))}
                />
              </div>
            )}
          </section>
        </div>
      </div>

      {note && <p className="cv-dir-note" role="status">{note}</p>}
    </CanvasOverlay>
  );
}
