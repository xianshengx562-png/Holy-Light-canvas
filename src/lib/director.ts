/**
 * 3D 导演台的场景模型。
 *
 * 这一层**只有数据和纯函数**，不碰 DOM、不碰 React —— 渲染在 `directorRender.ts`，
 * 界面在 `components/canvas/DirectorPanel.tsx`。分开是为了能在 node 里直接跑断言：
 * 站位和机位算错的表现是「参考图看着别扭但说不出口哪里别扭」，这种错只能靠
 * 一批数学断言挡住，靠肉眼看截图挡不住。
 *
 * 场景的形状（灰模、机位、画幅）与那份参考应用一致：迁移过来的是**同一套概念**，
 * 换一套值就等于换掉用户已经熟悉的手感。常量下面的注释标了哪些是照搬、哪些是这边的取舍。
 */

export type DirectorActorKind = 'person' | 'prop';

export type DirectorActor = {
  id: string;
  kind: DirectorActorKind;
  /** 卡片上和提示词里叫它的名字（人物默认 A / B / C…，道具默认「道具 1」）。 */
  label: string;
  /** 地面上的左右位置（米）。 */
  x: number;
  /** 地面上的前后位置（米）。 */
  z: number;
  /**
   * 离地高度（米），0 = 站在 / 摆在地面上。
   * 人物上台阶、道具摞在桌上，靠的都是它 —— 以前没有这一维，
   * 道具只能贴地摆，「放在桌上」这种构图摆不出来。
   */
  y: number;
  /** 朝向（度），0 = 面向 +z。 */
  rotation: number;
  /** 人物的身高 / 道具的高度（米）。 */
  height: number;
};

export type DirectorCamera = {
  /** 环绕角（度）。 */
  azimuth: number;
  /** 俯仰角（度）。 */
  elevation: number;
  /** 机位到注视点的距离（米）。 */
  distance: number;
  /** 竖直视角（度）。 */
  fov: number;
  /** 注视点的高度（米）。 */
  targetHeight: number;
};

export type DirectorScene = {
  /** 画幅，形如 `16:9`。 */
  ratio: string;
  actors: DirectorActor[];
  camera: DirectorCamera;
  selectedId: string | null;
  /**
   * 多选的灰模 id —— 批量复制 / 删除 / 整体挪动的对象。空数组 = 不在批量模式。
   *
   * 放在场景里而不是组件的 state：撤销重做、套预设都要它跟着一起变，
   * 分成两份状态迟早会出现「多选里存着一个早删掉的灰模」。
   */
  selectedIds: string[];
  /**
   * 站位吸附步长（米），0 = 不吸附。
   * 跟网格对齐是 3D 软件的惯例（Blender 的 Ctrl 拖、Unity 的 snap settings）——
   * 对齐网格的站位图，模型照着摆的时候才不会摆出 3.27 米这种没来由的数。
   */
  snap: number;
};

/** 可选的画幅。与参考应用同一份顺序。 */
export const DIRECTOR_RATIOS = ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'] as const;

/** 可选的吸附步长（米）。0 = 不吸附。 */
export const DIRECTOR_SNAPS = [0, 0.1, 0.5] as const;

/** 一个场景最多摆几个灰模。再多人就分不清谁是谁了，参考应用也是这个数。 */
export const DIRECTOR_MAX_ACTORS = 8;

/** 地面半边长：站位能挪到的范围（±6 米），超出就走出网格了。 */
export const DIRECTOR_EXTENT = 6;

/** 离地高度的上限（米）。再高就飞出网格视野了。 */
export const DIRECTOR_MAX_Y = 5;

/** 地面尺寸（米）。网格画在这块板的范围内。 */
export const DIRECTOR_GROUND = 24;

/** 网格一格多大（米）。 */
export const DIRECTOR_GRID_STEP = 1;

/** 人物默认名字，用完再退回数字。 */
const ACTOR_LABELS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

export type DirectorPreset = { id: string; label: string; camera: DirectorCamera };

/** 机位预设。值与参考应用逐一对应 —— 换一个数字就换掉了「平视中景」这几个字的意思。 */
export const DIRECTOR_PRESETS: DirectorPreset[] = [
  { id: 'eye', label: '平视中景', camera: { azimuth: 0, elevation: 4, distance: 6, fov: 40, targetHeight: 1.3 } },
  { id: 'close', label: '近景特写', camera: { azimuth: 12, elevation: 2, distance: 2.4, fov: 28, targetHeight: 1.55 } },
  { id: 'wide', label: '远景全身', camera: { azimuth: -18, elevation: 10, distance: 12, fov: 45, targetHeight: 1 } },
  { id: 'high', label: '俯拍', camera: { azimuth: 25, elevation: 48, distance: 9, fov: 40, targetHeight: 0.8 } },
  { id: 'low', label: '仰拍', camera: { azimuth: -12, elevation: -22, distance: 4.5, fov: 35, targetHeight: 1.4 } },
  { id: 'top', label: '顶视站位', camera: { azimuth: 0, elevation: 85, distance: 14, fov: 40, targetHeight: 0 } },
];

/* ============================================================================
 * 构图预设（2026-09-26）
 *
 * 上面那组 `DIRECTOR_PRESETS` 只改**机位**；这组是**整套构图** —— 站位 + 机位 + 画幅
 * 一起换。徐先要的是「按一下就是皇宫朝堂」「按一下就是两人对峙」，
 * 而不是先摆八个人再去调相机。
 *
 * 数据里**不带 id**：套用时按 `preset-<预设 id>-<序号>` 重新分配，
 * 所以同一个预设套一百遍也不会跟场上的灰模撞 id（撞了的表现是「拖一个动两个」）。
 * ========================================================================== */

/** 写预设时少打点字：`personAt('文臣1', -2.4, -2.6, 90, 1.72)`。 */
const personAt = (label: string, x: number, z: number, rotation: number, height: number, y = 0): Omit<DirectorActor, 'id'> =>
  ({ kind: 'person', label, x, z, y, rotation, height });

/** 道具在这个视口里是**方块**（半边长 = 高度的 0.45），所以「台阶 / 御座」都按高度给。 */
const propAt = (label: string, x: number, z: number, height: number, y = 0): Omit<DirectorActor, 'id'> =>
  ({ kind: 'prop', label, x, z, y, rotation: 0, height });

export type DirectorScenePreset = {
  id: string;
  label: string;
  /** 一句话说清它摆的是什么 —— 按钮的 title，也是将来给别人看的说明。 */
  hint: string;
  ratio: string;
  camera: DirectorCamera;
  actors: Omit<DirectorActor, 'id'>[];
};

/**
 * 内置的构图预设。
 *
 * 四条都卡在 8 个灰模以内（`DIRECTOR_MAX_ACTORS`），站位取网格整数、朝向取 ±90 的倍数 ——
 * 用户套用之后顺手把吸附开到 0.5m 继续微调，不会一拖就散开。
 *
 * 朝向的算法：`rotation` 是绕 Y 轴、0 = 面向 +z（相机默认在 +z 那一侧）。
 * 所以「面朝镜头」是 0、「背对镜头」是 180、左列的人面朝 +x 是 90、右列面朝 -x 是 -90。
 */
export const DIRECTOR_SCENE_PRESETS: DirectorScenePreset[] = [
  {
    id: 'palace',
    label: '皇宫朝堂',
    hint: '皇帝立于御座台上，文武大臣分列两侧，正面全景',
    ratio: '16:9',
    camera: { azimuth: 0, elevation: 8, distance: 8.5, fov: 40, targetHeight: 1.2 },
    actors: [
      /* 御座台只有 0.7 米高、0.63 米宽 —— 一格楼梯的量级，皇帝站上去刚好。 */
      propAt('御座台', 0, -2.8, 0.7),
      personAt('皇帝', 0, -2.8, 0, 1.78, 0.7),
      personAt('文臣1', -2.4, -2.6, 90, 1.72),
      personAt('文臣2', -2.4, -1.2, 90, 1.70),
      personAt('文臣3', -2.4, 0.2, 90, 1.74),
      personAt('武将1', 2.4, -2.6, -90, 1.80),
      personAt('武将2', 2.4, -1.2, -90, 1.78),
      personAt('武将3', 2.4, 0.2, -90, 1.76),
    ],
  },
  {
    id: 'court',
    label: '文武大臣站两边',
    hint: '文臣武将各一列、相对而立，中央留空，略高的正面机位',
    ratio: '16:9',
    camera: { azimuth: 0, elevation: 14, distance: 9, fov: 45, targetHeight: 1 },
    actors: [
      personAt('文臣1', -2.4, -2.4, 90, 1.72),
      personAt('文臣2', -2.4, -1.0, 90, 1.70),
      personAt('文臣3', -2.4, 0.4, 90, 1.74),
      personAt('文臣4', -2.4, 1.8, 90, 1.68),
      personAt('武将1', 2.4, -2.4, -90, 1.80),
      personAt('武将2', 2.4, -1.0, -90, 1.78),
      personAt('武将3', 2.4, 0.4, -90, 1.82),
      personAt('武将4', 2.4, 1.8, -90, 1.76),
    ],
  },
  {
    id: 'standoff',
    label: '两人对峙',
    hint: '两人相对而立、相距约 3 米，斜侧机位，21:9 宽画幅',
    ratio: '21:9',
    /* 机位偏到 32° 的斜侧面：正侧面会把两个人叠成一条线，正面又看不出「相向」。 */
    camera: { azimuth: 32, elevation: 4, distance: 5.4, fov: 38, targetHeight: 1.35 },
    actors: [
      personAt('A', -1.6, 0, 90, 1.78),
      personAt('B', 1.6, 0, -90, 1.72),
    ],
  },
  {
    id: 'solo',
    label: '单人入画',
    hint: '一个人站在画面中央，平视中景',
    ratio: '16:9',
    camera: { azimuth: 0, elevation: 3, distance: 3.2, fov: 40, targetHeight: 1.5 },
    actors: [personAt('A', 0, 0, 0, 1.75)],
  },
];

/** 用户自己存的预设最多留这么多条，再多 localStorage 就没边了。 */
export const DIRECTOR_USER_PRESET_MAX = 24;

/** 用户存下来的一条构图预设。内置那组不带 id 的模板，这里带 —— 删除时靠它认。 */
export type DirectorUserPreset = {
  id: string;
  label: string;
  ratio: string;
  camera: DirectorCamera;
  actors: DirectorActor[];
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));

/** 归一化角度到 (-180, 180]：拖一圈半之后滑块不该跳到 540。 */
const wrapDegrees = (value: number) => ((((Number.isFinite(value) ? value : 0) + 180) % 360) + 360) % 360 - 180;

export function clampCamera(camera: Partial<DirectorCamera>): DirectorCamera {
  return {
    azimuth: wrapDegrees(camera.azimuth ?? 0),
    elevation: clamp(camera.elevation ?? 8, -35, 85),
    distance: clamp(camera.distance ?? 6, 1.2, 24),
    fov: clamp(camera.fov ?? 40, 12, 90),
    targetHeight: clamp(camera.targetHeight ?? 1.2, 0, 3),
  };
}

export function clampActor(actor: DirectorActor): DirectorActor {
  const person = actor.kind === 'person';
  return {
    ...actor,
    x: clamp(actor.x, -DIRECTOR_EXTENT, DIRECTOR_EXTENT),
    z: clamp(actor.z, -DIRECTOR_EXTENT, DIRECTOR_EXTENT),
    y: clamp(actor.y, 0, DIRECTOR_MAX_Y),
    rotation: wrapDegrees(actor.rotation),
    height: clamp(actor.height, person ? 0.8 : 0.2, person ? 2.2 : 4),
  };
}

/** 新建一个场景：两个人（A / B）对站着，机位走第一个预设。 */
export function initialDirectorScene(): DirectorScene {
  const first: DirectorActor = { id: 'actor-1', kind: 'person', label: 'A', x: -0.8, z: 0, y: 0, rotation: 20, height: 1.7 };
  const second: DirectorActor = { id: 'actor-2', kind: 'person', label: 'B', x: 0.9, z: 0.4, y: 0, rotation: -30, height: 1.65 };
  return {
    ratio: '16:9',
    actors: [first, second],
    camera: clampCamera(DIRECTOR_PRESETS[0].camera),
    selectedId: first.id,
    selectedIds: [],
    snap: 0,
  };
}

/** `16:9` → 1.777…。认不出来的值一律按 16:9，别让画面算出一个 NaN 比例。 */
export function ratioOf(ratio: string): number {
  const [w, h] = String(ratio || '').split(':').map(Number);
  return w > 0 && h > 0 ? w / h : 16 / 9;
}

/**
 * 视角换算成等效焦距（毫米）。
 *
 * 参考图里写「40°」对模型毫无意义，写「33mm」它才认得出是个什么镜头 ——
 * 这一步是把机位翻译成摄影语言的那道桥。按 24mm 片幅（半高 12mm）算。
 */
export function focalLengthOf(fov: number): number {
  const degrees = clamp(fov, 12, 90);
  return Math.round(12 / Math.tan(degrees * Math.PI / 360));
}

/** 这一机位用摄影的话怎么说：俯仰 · 景别 · 方位 · 焦距。 */
export function describeShot(camera: DirectorCamera): string {
  const angle = camera.elevation >= 70 ? '顶视' : camera.elevation >= 25 ? '俯拍' : camera.elevation <= -10 ? '仰拍' : '平视';
  const range = camera.distance <= 3 ? '近景' : camera.distance <= 7.5 ? '中景' : '远景';
  const abs = Math.abs(camera.azimuth);
  const side = abs < 20 ? '正面'
    : abs > 160 ? '背面'
      : abs > 70 && abs < 110 ? (camera.azimuth > 0 ? '右侧面' : '左侧面')
        : (camera.azimuth > 0 ? '右前侧' : '左前侧');
  return `${angle} · ${range} · ${side} · ${focalLengthOf(camera.fov)}mm`;
}

/**
 * 存参考图时一并写进去的那段构图提示词。
 *
 * 它是这段功能的**正主**：光把灰模图丢给模型，模型照抄灰模的塑料感和网格地面；
 * 这段话的作用就是先把话说在前头 —— 沿用机位和站位，不要沿用外观。
 */
export function compositionPrompt(scene: DirectorScene): string {
  const names = scene.actors.filter(actor => actor.kind === 'person').map(actor => actor.label);
  const props = scene.actors.filter(actor => actor.kind === 'prop').length;
  const lifted = scene.actors.filter(actor => actor.y > 0.05);
  return [
    `构图参考（3D 导演台）：${describeShot(scene.camera)}，画幅 ${scene.ratio}。`,
    names.length ? `灰模 ${names.join('、')} 只表示人物的站位、朝向和身高比例` : '画面中没有人物灰模',
    props ? `，方块表示 ${props} 件道具或陈设的位置。` : '。',
    lifted.length ? `其中有 ${lifted.length} 个灰模抬高了（站在台阶 / 架子 / 另一人身上），请沿用这个上下关系。` : '',
    '请严格沿用参考图的机位、景别、人物相对位置和透视，不要照搬灰模的外观、颜色和网格地面。',
  ].join('');
}

/** 机位在世界坐标里的位置。绕注视点转，注视点在 y 轴上。 */
export function cameraPositionOf(camera: DirectorCamera) {
  const az = camera.azimuth * Math.PI / 180;
  const el = camera.elevation * Math.PI / 180;
  const flat = Math.cos(el) * camera.distance;
  return {
    x: Math.sin(az) * flat,
    /** 别让机位钻到地面以下（低角度 + 低注视点时会算出来） —— 钻下去就什么都看不见了。 */
    y: Math.max(0.05, camera.targetHeight + Math.sin(el) * camera.distance),
    z: Math.cos(az) * flat,
  };
}

/** 加一个灰模。满了就原样退回 —— 界面上「添加」按钮会先置灰，这里是兜底。 */
export function addActor(scene: DirectorScene, kind: DirectorActorKind, makeId: () => string): DirectorScene {
  if (scene.actors.length >= DIRECTOR_MAX_ACTORS) return scene;
  const taken = new Set(scene.actors.map(actor => actor.label));
  const label = kind === 'person'
    ? (ACTOR_LABELS.find(item => !taken.has(item)) || String(scene.actors.length + 1))
    : `道具${scene.actors.filter(actor => actor.kind === 'prop').length + 1}`;
  const index = scene.actors.length;
  const actor = clampActor({
    id: makeId(),
    kind,
    label,
    /* 新加的往边上排，别叠在上一个身上（一叠上就分不清是几个了）。 */
    x: (index % 4 - 1.5) * 1.1,
    z: Math.floor(index / 4) * 1.4 + (kind === 'prop' ? 1.2 : 0.6),
    y: 0,
    rotation: 0,
    height: kind === 'person' ? 1.7 : 0.9,
  });
  return { ...scene, actors: [...scene.actors, actor], selectedId: actor.id, selectedIds: [] };
}

export function patchActor(scene: DirectorScene, id: string, patch: Partial<DirectorActor>): DirectorScene {
  return {
    ...scene,
    actors: scene.actors.map(actor => (actor.id === id ? clampActor({ ...actor, ...patch, id: actor.id, kind: actor.kind }) : actor)),
  };
}

export function removeActor(scene: DirectorScene, id: string): DirectorScene {
  const actors = scene.actors.filter(actor => actor.id !== id);
  return {
    ...scene,
    actors,
    selectedIds: scene.selectedIds.filter(item => item !== id),
    selectedId: scene.selectedId === id ? (actors[0]?.id ?? null) : scene.selectedId,
  };
}

/**
 * 复制一个灰模。
 *
 * 市面上的 3D / 分镜工具（Blender、Unity、即梦的构图台）都有「复制」：
 * 摆好一个人，复制一个再微调，比从头加一个再拖到位快得多。名字跟人走
 * （A → 下一个空位字母，道具 → 道具 N+1）。
 *
 * `offset` 是副本跟原件的错开距离（米），两种用法：
 * - **0.7（默认）**：往右前错半步，一眼看得出是两份；
 * - **0（原地复制）**：坐标一模一样，两份完全重叠。这是「只想换一个参数」的用法 ——
 *   复制完只改身高或朝向，站位不动，省掉「复制完还得把人拖回原位」那一步。
 */
export function duplicateActor(scene: DirectorScene, id: string, makeId: () => string, offset = 0.7): DirectorScene {
  if (scene.actors.length >= DIRECTOR_MAX_ACTORS) return scene;
  const source = scene.actors.find(actor => actor.id === id);
  if (!source) return scene;
  const taken = new Set(scene.actors.map(actor => actor.label));
  const label = source.kind === 'person'
    ? (ACTOR_LABELS.find(item => !taken.has(item)) || `${source.label}2`)
    : `道具${scene.actors.filter(actor => actor.kind === 'prop').length + 1}`;
  const step = Number.isFinite(offset) ? offset : 0.7;
  const copy = clampActor({
    ...source,
    id: makeId(),
    label,
    /* 错开的方向跟着朝向走没有意义，固定往右前错半步，看得清是两份。 */
    x: clamp(source.x + step, -DIRECTOR_EXTENT, DIRECTOR_EXTENT),
    z: clamp(source.z + step, -DIRECTOR_EXTENT, DIRECTOR_EXTENT),
  });
  return { ...scene, actors: [...scene.actors, copy], selectedId: copy.id, selectedIds: [] };
}

/* ============================================================================
 * 多选与批量操作（2026-09-26）
 *
 * 摆八个大臣的时候，「一个一个拖到位」和「选八个然后排开」是两种工作量。
 * 这一层只出纯函数，界面负责「哪些被选中」—— 数学对不对靠单测盯，
 * 靠肉眼看截图盯不出来（八个 1.37 米和八个 1.4 米长得一样）。
 * ========================================================================== */

/** 洗一遍多选：丢掉已经不存在的 id、去重，并按场景里的顺序排回来。 */
export function setSelection(scene: DirectorScene, ids: readonly string[]): DirectorScene {
  const picked = new Set(ids);
  return { ...scene, selectedIds: scene.actors.filter(actor => picked.has(actor.id)).map(actor => actor.id) };
}

/** Ctrl/⌘+点：加进来或者去掉。主选跟着点到的那个走（下面的参数卡才有对象）。 */
export function toggleSelection(scene: DirectorScene, id: string): DirectorScene {
  const has = scene.selectedIds.includes(id);
  const ids = has ? scene.selectedIds.filter(item => item !== id) : [...scene.selectedIds, id];
  return { ...setSelection(scene, ids), selectedId: id };
}

/**
 * 批量复制：选几个就复制几个。
 *
 * 副本整体进多选（接着挪、接着删都方便），并且**每份都要新 id** ——
 * `makeId` 是个生成器，连着取才不会「复制三个都叫 actor-3」（撞 id 的表现是拖一个动仨）。
 */
export function duplicateActors(scene: DirectorScene, ids: readonly string[], makeId: () => string, offset = 0.7): DirectorScene {
  let next = scene;
  const fresh: string[] = [];
  for (const id of ids) {
    if (next.actors.length >= DIRECTOR_MAX_ACTORS) break;
    const before = new Set(next.actors.map(actor => actor.id));
    const after = duplicateActor(next, id, makeId, offset);
    if (after === next) continue;
    const made = after.actors.find(actor => !before.has(actor.id));
    if (made) fresh.push(made.id);
    next = after;
  }
  return { ...next, selectedIds: fresh };
}

/** 批量删除。删完主选退回第一个还在的灰模（空场子则为 null）。 */
export function removeActors(scene: DirectorScene, ids: readonly string[]): DirectorScene {
  const gone = new Set(ids);
  const actors = scene.actors.filter(actor => !gone.has(actor.id));
  return {
    ...scene,
    actors,
    selectedIds: [],
    selectedId: actors.some(actor => actor.id === scene.selectedId) ? scene.selectedId : (actors[0]?.id ?? null),
  };
}

/** 整体挪动：Δ 直接加在 x / z 上，走出网格的由 clampActor 夹回来。 */
export function nudgeActors(scene: DirectorScene, ids: readonly string[], dx: number, dz: number): DirectorScene {
  const picked = new Set(ids);
  return {
    ...scene,
    actors: scene.actors.map(actor => (picked.has(actor.id) ? clampActor({ ...actor, x: actor.x + dx, z: actor.z + dz }) : actor)),
  };
}

/** 左右镜像：x 取反，朝向也取反 —— 只镜像位置的话，一排人会集体背对镜头。 */
export function mirrorActors(scene: DirectorScene, ids: readonly string[]): DirectorScene {
  const picked = new Set(ids);
  return {
    ...scene,
    actors: scene.actors.map(actor => (picked.has(actor.id) ? clampActor({ ...actor, x: -actor.x, rotation: -actor.rotation }) : actor)),
  };
}

/**
 * 等距排开：选中的几个沿 z 拉成间距相等的一排，**整体中心不动**。
 * 一排侍卫、一排大臣就是这么来的 —— 手拖永远拖不出严格等距，
 * 而站位图差 20 厘米，模型照着摆出来的队形就是歪的。
 */
export function spreadActors(scene: DirectorScene, ids: readonly string[], gap = 1.4): DirectorScene {
  const picked = new Set(ids);
  const rows = scene.actors.filter(actor => picked.has(actor.id));
  if (rows.length < 2) return scene;
  const center = rows.reduce((sum, actor) => sum + actor.z, 0) / rows.length;
  const from = center - (rows.length - 1) * gap / 2;
  let index = 0;
  return {
    ...scene,
    actors: scene.actors.map(actor => {
      if (!picked.has(actor.id)) return actor;
      const z = clamp(from + index * gap, -DIRECTOR_EXTENT, DIRECTOR_EXTENT);
      index += 1;
      return clampActor({ ...actor, z });
    }),
  };
}

/** 统一朝向：全部转成面朝镜头（rotation = 0）。 */
export function faceCameraActors(scene: DirectorScene, ids: readonly string[]): DirectorScene {
  const picked = new Set(ids);
  return {
    ...scene,
    actors: scene.actors.map(actor => (picked.has(actor.id) ? clampActor({ ...actor, rotation: 0 }) : actor)),
  };
}


/**
 * 从一个可能是旧版本（或手改过）的值里还原出场景。
 *
 * 场景存在节点的 `data` 里跟着画布一起序列化，而它跨版本、也可能被 MCP 写进去 ——
 * 读的时候一律过一遍夹取，免得一个 `distance: 0` 让整个视口算出 NaN 然后一片黑。
 */
export function readDirectorScene(value: unknown): DirectorScene {
  const raw = (value || {}) as Partial<DirectorScene>;
  const actors = Array.isArray(raw.actors) ? raw.actors : [];
  const clean = actors
    .filter((actor): actor is DirectorActor => !!actor && typeof actor.id === 'string')
    .slice(0, DIRECTOR_MAX_ACTORS)
    .map(actor => clampActor({
      id: actor.id,
      kind: actor.kind === 'prop' ? 'prop' : 'person',
      label: String(actor.label || '灰模').slice(0, 12),
      x: Number(actor.x) || 0,
      z: Number(actor.z) || 0,
      y: Number(actor.y) || 0,
      rotation: Number(actor.rotation) || 0,
      height: Number(actor.height) || (actor.kind === 'prop' ? 0.9 : 1.7),
    }));
  const ratio = DIRECTOR_RATIOS.includes(raw.ratio as (typeof DIRECTOR_RATIOS)[number])
    ? String(raw.ratio) : '16:9';
  const camera = clampCamera((raw.camera || {}) as DirectorCamera);
  const snapRaw = Number(raw.snap);
  const snap = DIRECTOR_SNAPS.includes(snapRaw as (typeof DIRECTOR_SNAPS)[number]) ? snapRaw : 0;
  if (!clean.length) {
    const fresh = initialDirectorScene();
    return { ...fresh, ratio, camera, snap };
  }
  const selectedId = clean.some(actor => actor.id === raw.selectedId) ? String(raw.selectedId) : clean[0].id;
  const rawIds = Array.isArray(raw.selectedIds) ? raw.selectedIds : [];
  const alive = new Set(clean.map(actor => actor.id));
  const pickedIds = rawIds.filter((item): item is string => typeof item === 'string' && alive.has(item));
  return { ratio, actors: clean, camera, snap, selectedId, selectedIds: [...new Set(pickedIds)] };
}

/**
 * 把一个坐标按吸附步长对齐。
 *
 * 拖拽的每一帧都调它，所以放在这一层而不是界面层 —— 界面上「吸附」一开，
 * 拖出来的每个数都该是步长的整数倍，包括滑块手动输入的值。
 */
export function snapToStep(value: number, step: number): number {
  if (!step || step <= 0) return Math.round(value * 100) / 100;
  /* toFixed(4) 吃掉二进制浮点尾巴：0.1×3 = 0.30000000000000004 这种数不该出现在站位上。 */
  return Number((Math.round(value / step) * step).toFixed(4));
}


/* ============================================================================
 * 构图预设：套用 / 反存 / 解析
 * ========================================================================== */

/**
 * 把一套灰模装进场景。
 *
 * id **必须重发**（前缀区分来源）：场景里同时存在「预设带来的」和「用户后加的」灰模时，
 * 序号从 1 重新数不会跟已有的撞 —— 撞了的表现是拖一个动两个、删一个少两个。
 * `snap`（吸附步长）刻意保留：那是手感，不是构图的一部分，切预设不该把它带回默认值。
 */
function withActors(
  scene: DirectorScene,
  ratio: string,
  camera: DirectorCamera,
  prefix: string,
  actors: readonly Omit<DirectorActor, 'id'>[],
): DirectorScene {
  const next = actors
    .slice(0, DIRECTOR_MAX_ACTORS)
    .map((actor, index) => clampActor({ ...actor, id: prefix + '-' + (index + 1) }));
  return { ...scene, ratio, actors: next, camera: clampCamera(camera), selectedId: next[0]?.id ?? null, selectedIds: [] };
}

/** 套一个内置构图预设。 */
export function applyScenePreset(scene: DirectorScene, preset: DirectorScenePreset): DirectorScene {
  return withActors(scene, preset.ratio, preset.camera, 'preset-' + preset.id, preset.actors);
}

/** 套一条用户自己存的预设。 */
export function applyUserPreset(scene: DirectorScene, preset: DirectorUserPreset): DirectorScene {
  return withActors(scene, preset.ratio, preset.camera, 'user-' + preset.id, preset.actors);
}

/** 把当前构图反存成一条用户预设。 */
export function userPresetOf(scene: DirectorScene, id: string, label: string): DirectorUserPreset {
  return {
    id,
    label: String(label || '未命名预设').slice(0, 12),
    ratio: scene.ratio,
    camera: clampCamera(scene.camera),
    actors: scene.actors.slice(0, DIRECTOR_MAX_ACTORS).map(actor => clampActor({ ...actor })),
  };
}

/**
 * 解析存下来的用户预设。
 *
 * 这份数据来自 localStorage / 旧版本 / 手改 —— 一律过一遍夹取，并且
 * **一条坏的就只丢那一条**（不整份作废）：一个人手滑写坏了不该把整柜预设清空。
 * 灰模数为 0 的预设直接丢掉 —— 套用之后会是一块空台子，那不是预设该有的样子。
 */
export function readUserPresets(value: unknown): DirectorUserPreset[] {
  if (!Array.isArray(value)) return [];
  const out: DirectorUserPreset[] = [];
  for (const raw of value.slice(0, DIRECTOR_USER_PRESET_MAX)) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Partial<DirectorUserPreset>;
    const id = typeof item.id === 'string' ? item.id : '';
    if (!id) continue;
    const list = Array.isArray(item.actors) ? item.actors : [];
    const actors = list
      .filter((actor): actor is DirectorActor => !!actor && typeof actor.id === 'string')
      .slice(0, DIRECTOR_MAX_ACTORS)
      .map(actor => clampActor({
        id: actor.id,
        kind: actor.kind === 'prop' ? 'prop' : 'person',
        label: String(actor.label || '灰模').slice(0, 12),
        x: Number(actor.x) || 0,
        z: Number(actor.z) || 0,
        y: Number(actor.y) || 0,
        rotation: Number(actor.rotation) || 0,
        height: Number(actor.height) || (actor.kind === 'prop' ? 0.9 : 1.7),
      }));
    if (!actors.length) continue;
    const ratio = DIRECTOR_RATIOS.includes(item.ratio as (typeof DIRECTOR_RATIOS)[number])
      ? String(item.ratio) : '16:9';
    out.push({
      id,
      label: String(item.label || '未命名预设').slice(0, 12),
      ratio,
      camera: clampCamera((item.camera || {}) as DirectorCamera),
      actors,
    });
  }
  return out;
}
