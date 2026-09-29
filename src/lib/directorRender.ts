/**
 * 3D 导演台视口的那支笔。
 *
 * ⚠️ 这里是**自己算的 3D**，没有引 three.js。理由与 `lib/motion.ts` 那套运镜一致：
 * 这个项目到今天只有 5 个运行时依赖，为一个「灰模站位」的视口拉进一个 3D 引擎
 * 不划算 —— 场景里只有球、胶囊、方块三种体，透视是十几行矩阵，画在 2D canvas 上
 * 反而更稳（不依赖 WebGL 上下文，也不存在 `preserveDrawingBuffer` 读回像素那一类坑）。
 *
 * 三条硬规矩：
 *
 * 1. **深度排序**。没有深度缓冲，只能按「体到相机的距离」从远到近画。
 *    每个体取一个代表点（胶囊取中点、球取球心、方块的每个面各算一次）——
 *    取错了表现是「手臂画在躯干前面」这类说不出哪里怪的错。
 *
 * 2. **近平面裁剪**。相机身后（或贴着相机）的点投影会翻到画面另一侧，
 *    画出来是横穿整个视口的一道长条。所以线段和多边形都要先在相机空间里
 *    裁掉 `z > -NEAR` 的那一段，再投影。
 *
 * 3. **光照只有一个方向光 + 一份环境光**，值照参考应用（0.85 / 1.4 缩到 0~1 区间）。
 *    灰模的作用是让人看清站位和体积，不是为了好看 —— 别加高光、别加阴影。
 */

import {
  DIRECTOR_EXTENT, DIRECTOR_GRID_STEP, DIRECTOR_GROUND,
  cameraPositionOf, type DirectorActor, type DirectorCamera, type DirectorScene,
} from './director';

type V3 = { x: number; y: number; z: number };
type RGB = readonly [number, number, number];

const sub = (a: V3, b: V3): V3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const add = (a: V3, b: V3): V3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
const scale = (a: V3, k: number): V3 => ({ x: a.x * k, y: a.y * k, z: a.z * k });
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;
const cross = (a: V3, b: V3): V3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
const length = (a: V3) => Math.hypot(a.x, a.y, a.z);
const unit = (a: V3): V3 => {
  const len = length(a) || 1;
  return { x: a.x / len, y: a.y / len, z: a.z / len };
};
const distance = (a: V3, b: V3) => length(sub(a, b));

/** 相机前这么多米以内的东西不画：贴着相机投影出来的是一道横贯画面的长条。 */
const NEAR = 0.05;

/**
 * 灰模的离地高度。
 *
 * 全文件读 `actor.y` 都走这里：场景可能来自旧版本数据 / 测试字面量（没有 y 字段），
 * 直接读会带进 undefined，一路算成 NaN —— 表现是「整幅画面里少几个体」这种静默错。
 */
const liftOf = (actor: DirectorActor) => Number(actor.y) || 0;

/**
 * 裁剪面比拒绝线再往里让一段。
 *
 * ⚠️ 这两个数**不能是同一个**。`clipSegment` / `clipPolygon` 算出来的新点正好落在
 * z = -裁剪面 上，而 `project()` 对 `depth <= NEAR` 是**拒绝**的（回一个 `(0,0)`）——
 * 于是那个「刚好贴在裁剪面上」的点被投影到画布**左上角**，整条线段就变成
 * 一道从左上角横穿画面的斜线。
 *
 * 真机探针里仰拍那张图上「天空里凭空多了几道细线」就是它。
 * 让开一个量级（0.05 → 0.2 米）就绕过了这个浮点边界，而 0.2 米处的东西
 * 本来也已经贴在相机上了，丢掉看不出区别。
 */
const CLIP_NEAR = NEAR * 4;

/** 背景（参考应用里的场景底色）。 */
const COLOR_BACKGROUND: RGB = [28, 28, 28];
/** 地面那块板。 */
const COLOR_GROUND: RGB = [43, 43, 43];
/** 网格：正中间那两根稍亮，其余稍暗。 */
const COLOR_GRID_CENTER: RGB = [90, 90, 90];
const COLOR_GRID: RGB = [58, 58, 58];
/** 灰模：人物 / 选中 / 道具。 */
const COLOR_PERSON: RGB = [185, 185, 185];
const COLOR_PERSON_ON: RGB = [230, 230, 230];
const COLOR_PROP: RGB = [141, 141, 141];
const COLOR_PROP_ON: RGB = [185, 185, 185];
/** 选中脚下的那圈蓝色。 */
const COLOR_RING = '#3b82f6';
/** 离地的灰模从脚下落到地面那根虚线。 */
const COLOR_DROP = 'rgba(148, 163, 184, 0.55)';
/** 移动 gizmo 的三根轴：X 红 / Y 绿 / Z 蓝（Blender、Unity 同一套配色）。 */
export const GIZMO_AXIS_LENGTH = 1.0;
const GIZMO_COLORS = { x: '#ff5d5d', y: '#3ecf6f', z: '#5b8cff' } as const;
/** 指针离轴箭头多近算抓到（CSS 像素）。 */
const GIZMO_HIT_PX = 12;

/** 方向光的方向（世界坐标），与参考应用里那盏灯同一个位置。 */
const LIGHT = unit({ x: 4, y: 8, z: 6 });

const css = (rgb: RGB, k: number) => {
  const c = (channel: number) => Math.max(0, Math.min(255, Math.round(channel * k)));
  return `rgb(${c(rgb[0])}, ${c(rgb[1])}, ${c(rgb[2])})`;
};

/** 绕 Y 轴转（three.js 的 `rotation: [0, θ, 0]`）。 */
const rotY = (p: V3, radians: number): V3 => {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  return { x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c };
};

type View = {
  eye: V3;
  right: V3;
  up: V3;
  /** 从注视点指向相机的那根轴（相机空间的 +z）。 */
  forward: V3;
  /** 焦距，单位是像素。 */
  focal: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
};

function makeView(camera: DirectorCamera, width: number, height: number): View {
  const eye = cameraPositionOf(camera);
  const target: V3 = { x: 0, y: camera.targetHeight, z: 0 };
  const forward = unit(sub(eye, target));
  /* 相机几乎正对着上下看时 forward 与 (0,1,0) 共线，叉乘会退化 —— 换一根参考轴。 */
  const ref: V3 = Math.abs(forward.y) > 0.999 ? { x: 0, y: 0, z: 1 } : { x: 0, y: 1, z: 0 };
  const right = unit(cross(ref, forward));
  const up = cross(forward, right);
  return {
    eye, right, up, forward,
    focal: (height / 2) / Math.tan(camera.fov * Math.PI / 360),
    cx: width / 2,
    cy: height / 2,
    width,
    height,
  };
}

/** 相机空间：相机看向 -z，所以「在前面」= z 为负。 */
function toCamera(view: View, p: V3): V3 {
  const d = sub(p, view.eye);
  return { x: dot(d, view.right), y: dot(d, view.up), z: dot(d, view.forward) };
}

/** 屏幕坐标 + 深度（米）。深度为负表示这个点在相机后面。 */
function project(view: View, p: V3) {
  const c = toCamera(view, p);
  const depth = -c.z;
  if (depth <= NEAR) return { x: 0, y: 0, depth };
  return {
    x: view.cx + view.focal * c.x / depth,
    y: view.cy - view.focal * c.y / depth,
    depth,
  };
}

/** 线段在相机空间里裁掉近平面之后的那一段（返回世界坐标）。 */
function clipSegment(view: View, a: V3, b: V3): [V3, V3] | null {
  const ca = toCamera(view, a);
  const cb = toCamera(view, b);
  const da = -ca.z;
  const db = -cb.z;
  if (da <= CLIP_NEAR && db <= CLIP_NEAR) return null;
  if (da > CLIP_NEAR && db > CLIP_NEAR) return [a, b];
  const t = (CLIP_NEAR - da) / (db - da);
  const mid = add(a, scale(sub(b, a), t));
  return da <= CLIP_NEAR ? [mid, b] : [a, mid];
}

/** 多边形（世界坐标，凸）裁掉近平面之后的那圈点。相机空间里是沿 z = -NEAR 一刀。 */
function clipPolygon(view: View, points: V3[]): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const dc = -toCamera(view, current).z;
    const dn = -toCamera(view, next).z;
    const inCurrent = dc > CLIP_NEAR;
    const inNext = dn > CLIP_NEAR;
    if (inCurrent) out.push(current);
    if (inCurrent !== inNext) {
      const t = (CLIP_NEAR - dc) / (dn - dc);
      out.push(add(current, scale(sub(next, current), t)));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ 画各样体 */

/**
 * 一个「体」。它自己不带深度 —— 深度要在画的时候按**当时的机位**算，
 * 所以拆体这一步只管几何，排序留给 `drawDirectorScene`。
 */
type Part =
  | { kind: 'capsule'; a: V3; b: V3; r: number; rgb: RGB }
  | { kind: 'sphere'; c: V3; r: number; rgb: RGB }
  | { kind: 'face'; points: V3[]; normal: V3; rgb: RGB };

/** 排序用的代表点：胶囊取中点、球取球心、面取四个角的中点。 */
function partCenter(part: Part): V3 {
  if (part.kind === 'capsule') return scale(add(part.a, part.b), 0.5);
  if (part.kind === 'sphere') return part.c;
  return scale(part.points.reduce((sum, p) => add(sum, p), { x: 0, y: 0, z: 0 }), 1 / part.points.length);
}

function drawCapsule(ctx: CanvasRenderingContext2D, view: View, item: Extract<Part, { kind: 'capsule' }>) {
  const pa = project(view, item.a);
  const pb = project(view, item.b);
  if (pa.depth <= NEAR || pb.depth <= NEAR) return;
  const ra = view.focal * item.r / pa.depth;
  const rb = view.focal * item.r / pb.depth;
  const width = (ra + rb) / 2;
  if (width < 0.35) return;

  /* 轴线在屏幕上的方向。 */
  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const len = Math.hypot(dx, dy) || 1;
  const ax = dx / len;
  const ay = dy / len;
  /* 光在屏幕上的方向：拿中点和「沿光走一小段」那点各自投影，连起来就是。 */
  const mid = scale(add(item.a, item.b), 0.5);
  const pm = project(view, mid);
  const pl = project(view, add(mid, scale(LIGHT, 0.5)));
  let lx = pl.x - pm.x;
  let ly = pl.y - pm.y;
  const ll = Math.hypot(lx, ly);
  if (ll > 1e-6) { lx /= ll; ly /= ll; } else { lx = 1; ly = 0; }
  /* 只取光向里**垂直于轴线**的那一份 —— 沿轴的那一份不产生明暗变化。 */
  const along = lx * ax + ly * ay;
  let nx = lx - ax * along;
  let ny = ly - ay * along;
  const nl = Math.hypot(nx, ny);
  if (nl < 1e-3) { nx = -ay; ny = ax; } else { nx /= nl; ny /= nl; }

  const gradient = ctx.createLinearGradient(
    pm.x - nx * width, pm.y - ny * width,
    pm.x + nx * width, pm.y + ny * width,
  );
  gradient.addColorStop(0, css(item.rgb, 0.6));
  gradient.addColorStop(0.5, css(item.rgb, 1.0));
  gradient.addColorStop(1, css(item.rgb, 1.2));

  ctx.strokeStyle = gradient;
  ctx.lineWidth = width * 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(pa.x, pa.y);
  ctx.lineTo(pb.x, pb.y);
  ctx.stroke();
}

function drawSphere(ctx: CanvasRenderingContext2D, view: View, item: Extract<Part, { kind: 'sphere' }>) {
  const p = project(view, item.c);
  if (p.depth <= NEAR) return;
  const r = view.focal * item.r / p.depth;
  if (r < 0.35) return;
  const pl = project(view, add(item.c, scale(LIGHT, item.r)));
  let lx = pl.x - p.x;
  let ly = pl.y - p.y;
  const ll = Math.hypot(lx, ly);
  if (ll > 1e-6) { lx /= ll; ly /= ll; } else { lx = 1; ly = 0; }
  const ox = lx * r * 0.45;
  const oy = ly * r * 0.45;
  const gradient = ctx.createRadialGradient(p.x + ox, p.y + oy, r * 0.05, p.x, p.y, r * 1.08);
  gradient.addColorStop(0, css(item.rgb, 1.22));
  gradient.addColorStop(0.55, css(item.rgb, 0.98));
  gradient.addColorStop(1, css(item.rgb, 0.52));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawFace(
  ctx: CanvasRenderingContext2D,
  view: View,
  points: V3[],
  rgb: RGB,
  shade: number,
) {
  const clipped = clipPolygon(view, points);
  if (clipped.length < 3) return;
  ctx.fillStyle = css(rgb, shade);
  ctx.beginPath();
  clipped.forEach((point, index) => {
    const p = project(view, point);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.fill();
}

/* ------------------------------------------------------------ 场景 → 一堆体 */

/** 一个灰模拆成哪些体。尺寸比例与参考应用一致（那套比例是照人身高量出来的）。 */
function actorParts(actor: DirectorActor, selected: boolean): Part[] {
  const h = actor.height;
  const head = h * 0.075;
  const torso = h * 0.82;
  const rgb = actor.kind === 'prop'
    ? (selected ? COLOR_PROP_ON : COLOR_PROP)
    : (selected ? COLOR_PERSON_ON : COLOR_PERSON);
  const spin = actor.rotation * Math.PI / 180;
  /**
   * 底座高度 = actor.y（离地）。人物站在台阶上、道具摆在桌上，靠它抬起来。
   * 原点放在**脚底 / 道具底面**：所有部件的高度都从底往上量，y 一改整只抬起。
   * `|| 0` 是给旧数据 / 测试字面量兜底 —— 没有 y 字段就当贴地。
   */
  const lift = liftOf(actor);
  const origin: V3 = { x: actor.x, y: lift, z: actor.z };
  /** 局部坐标 → 世界坐标：先绕自身转，再挪到站位上。 */
  const place = (p: V3): V3 => add(rotY(p, spin), origin);

  if (actor.kind === 'prop') {
    const half = { x: h * 0.45, y: h / 2, z: h * 0.45 };
    const corners: V3[] = [];
    for (let i = 0; i < 8; i += 1) {
      corners.push(place({
        x: (i & 1) ? half.x : -half.x,
        /** 底面贴着 actor.y：方块**坐**在地面上，不再一半埋进地里。 */
        y: (i & 2) ? h : 0,
        z: (i & 4) ? half.z : -half.z,
      }));
    }
    const faces: { normal: V3; corners: V3[] }[] = [
      { normal: { x: 1, y: 0, z: 0 }, corners: [corners[1], corners[3], corners[7], corners[5]] },
      { normal: { x: -1, y: 0, z: 0 }, corners: [corners[0], corners[4], corners[6], corners[2]] },
      { normal: { x: 0, y: 1, z: 0 }, corners: [corners[2], corners[6], corners[7], corners[3]] },
      { normal: { x: 0, y: -1, z: 0 }, corners: [corners[0], corners[1], corners[5], corners[4]] },
      { normal: { x: 0, y: 0, z: 1 }, corners: [corners[4], corners[5], corners[7], corners[6]] },
      { normal: { x: 0, y: 0, z: -1 }, corners: [corners[0], corners[2], corners[3], corners[1]] },
    ];
    /*
     * 六个面都交出去，让外面按深度排序 —— 方块是凸的，背面剔除 + 从远到近
     * 就等于正确的遮挡。法线要跟着灰模一起转（不然转动道具后明暗不动，很假）。
     */
    return faces.map(face => ({
      kind: 'face' as const,
      points: face.corners,
      normal: rotY(face.normal, spin),
      rgb,
    }));
  }

  return [
    /* 头。 */
    { kind: 'sphere', c: place({ x: 0, y: h - head, z: 0 }), r: head, rgb },
    /* 鼻子：一小截朝前的胶囊，用来一眼看出这个人是朝哪边的。 */
    {
      kind: 'capsule',
      a: place({ x: 0, y: h - head, z: head * 0.9 }),
      b: place({ x: 0, y: h - head, z: head * 1.35 }),
      r: head * 0.2,
      rgb,
    },
    /* 躯干。 */
    {
      kind: 'capsule',
      a: place({ x: 0, y: torso * 0.51, z: 0 }),
      b: place({ x: 0, y: torso * 0.85, z: 0 }),
      r: h * 0.105,
      rgb,
    },
    /* 两条腿。 */
    ...[-1, 1].map(side => ({
      kind: 'capsule' as const,
      a: place({ x: side * h * 0.055, y: torso * 0.05, z: 0 }),
      b: place({ x: side * h * 0.055, y: torso * 0.47, z: 0 }),
      r: h * 0.045,
      rgb,
    })),
    /* 两条胳膊：带一点点外撇（与参考应用同一个角度），不然贴着身体看不出有手。 */
    ...[-1, 1].map(side => {
      const tilt = side * 0.12;
      const halfLen = torso * 0.36 / 2;
      const cx = side * h * 0.15;
      const cy = torso * 0.66;
      return {
        kind: 'capsule' as const,
        a: place({ x: cx + Math.sin(tilt) * halfLen, y: cy - Math.cos(tilt) * halfLen, z: 0 }),
        b: place({ x: cx - Math.sin(tilt) * halfLen, y: cy + Math.cos(tilt) * halfLen, z: 0 }),
        r: h * 0.035,
        rgb,
      };
    }),
  ];
}

/* -------------------------------------------------------------------- 出口 */

/**
 * 画一帧。
 *
 * `width` / `height` 是 CSS 像素；调用方已经把 ctx 按 dpr 缩放过了，所以这里
 * 只管按比例算，不掺和分辨率。
 */
export function drawDirectorScene(
  ctx: CanvasRenderingContext2D,
  scene: DirectorScene,
  width: number,
  height: number,
) {
  if (width <= 0 || height <= 0) return;
  const view = makeView(scene.camera, width, height);

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = css(COLOR_BACKGROUND, 1);
  ctx.fillRect(0, 0, width, height);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  /*
   * 地面只在相机**在地面之上**时画。低角度 + 低注视点会把相机算到 y<0，
   * 那种时候看到的是这块板的背面，画上去只会糊住整幅画面。
   */
  if (view.eye.y > 0.02) {
    const half = DIRECTOR_GROUND / 2;
    const quad = [
      { x: -half, y: 0, z: -half },
      { x: half, y: 0, z: -half },
      { x: half, y: 0, z: half },
      { x: -half, y: 0, z: half },
    ];
    const clipped = clipPolygon(view, quad);
    if (clipped.length >= 3) {
      ctx.fillStyle = css(COLOR_GROUND, 1);
      ctx.beginPath();
      clipped.forEach((point, index) => {
        const p = project(view, point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.fill();
    }

    /* 网格：一格一米，正中间那两根亮一点（一眼能看出站位偏了多少）。 */
    const edge = DIRECTOR_EXTENT;
    for (let i = -edge; i <= edge; i += DIRECTOR_GRID_STEP) {
      const center = i === 0;
      ctx.strokeStyle = css(center ? COLOR_GRID_CENTER : COLOR_GRID, 1);
      ctx.lineWidth = 1;
      for (const line of [
        [{ x: -edge, y: 0, z: i }, { x: edge, y: 0, z: i }] as [V3, V3],
        [{ x: i, y: 0, z: -edge }, { x: i, y: 0, z: edge }] as [V3, V3],
      ]) {
        const seg = clipSegment(view, line[0], line[1]);
        if (!seg) continue;
        const pa = project(view, seg[0]);
        const pb = project(view, seg[1]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
      }
    }
  }

  /*
   * 离地的灰模：从脚下落到地面画一根虚线 + 地面一个小十字。
   * 悬空 1.8 米的人和贴地的人在侧视角里分得清，正面机位就分不清了 ——
   * 这根线是「他站在半空 / 台阶上」的唯一读法。
   */
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  for (const actor of scene.actors) {
    if (liftOf(actor) <= 0.05) continue;
    const seg = clipSegment(view, { x: actor.x, y: 0, z: actor.z }, { x: actor.x, y: liftOf(actor), z: actor.z });
    if (!seg) continue;
    const pa = project(view, seg[0]);
    const pb = project(view, seg[1]);
    ctx.strokeStyle = COLOR_DROP;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
    /* 地面上的落点：一个小十字，比一个点醒目。 */
    const cross = 0.12;
    for (const arm of [
      [{ x: actor.x - cross, y: 0.012, z: actor.z }, { x: actor.x + cross, y: 0.012, z: actor.z }] as [V3, V3],
      [{ x: actor.x, y: 0.012, z: actor.z - cross }, { x: actor.x, y: 0.012, z: actor.z + cross }] as [V3, V3],
    ]) {
      const s2 = clipSegment(view, arm[0], arm[1]);
      if (!s2) continue;
      const qa = project(view, s2[0]);
      const qb = project(view, s2[1]);
      ctx.beginPath();
      ctx.moveTo(qa.x, qa.y);
      ctx.lineTo(qb.x, qb.y);
      ctx.stroke();
    }
  }
  ctx.setLineDash([]);

  /* 选中脚下的那圈蓝环：贴在灰模**底面**的高度（人抬高了环跟着上去），在灰模之前画。 */
  const picked = scene.actors.find(actor => actor.id === scene.selectedId);
  if (picked) {
    const r = picked.kind === 'prop' ? picked.height * 0.8 : picked.height * 0.28;
    const ring: V3[] = [];
    for (let i = 0; i < 40; i += 1) {
      const angle = (i / 40) * Math.PI * 2;
      ring.push({ x: picked.x + Math.cos(angle) * r, y: liftOf(picked) + 0.012, z: picked.z + Math.sin(angle) * r });
    }
    const clipped = clipPolygon(view, ring);
    if (clipped.length >= 3) {
      ctx.strokeStyle = COLOR_RING;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      clipped.forEach((point, index) => {
        const p = project(view, point);
        if (index === 0) ctx.moveTo(p.x, p.y);
        else ctx.lineTo(p.x, p.y);
      });
      ctx.closePath();
      ctx.stroke();
    }
  }

  /* 灰模拆成体 → 按到相机的距离从远到近排 → 依次画。 */
  const queue: { part: Part; depth: number }[] = [];
  for (const actor of scene.actors) {
    for (const part of actorParts(actor, actor.id === scene.selectedId)) {
      const center = partCenter(part);
      /* 背对相机的面剔掉：它是凸体，看不见的面画上去只会盖住该看见的。 */
      if (part.kind === 'face' && dot(part.normal, sub(center, view.eye)) >= 0) continue;
      queue.push({ part, depth: distance(center, view.eye) });
    }
  }
  queue.sort((a, b) => b.depth - a.depth);
  for (const { part } of queue) {
    if (part.kind === 'capsule') drawCapsule(ctx, view, part);
    else if (part.kind === 'sphere') drawSphere(ctx, view, part);
    else drawFace(ctx, view, part.points, part.rgb, 0.5 + 0.78 * Math.max(0, dot(part.normal, LIGHT)));
  }

  /* 移动 gizmo 最后画：压在所有灰模上面（Blender / Unity 同款做法，遮挡了就没法点了）。 */
  if (picked) drawMoveGizmo(ctx, view, picked);
}

/* --------------------------------------------------------------- 移动 gizmo */

/** gizmo 原点：选中灰模的底面中心。三根轴从这里伸出。 */
function gizmoOriginOf(actor: DirectorActor): V3 {
  return { x: actor.x, y: liftOf(actor), z: actor.z };
}

function axisVector(axis: 'x' | 'y' | 'z'): V3 {
  return axis === 'x' ? { x: 1, y: 0, z: 0 } : axis === 'y' ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 };
}

/**
 * 画三轴移动 gizmo：X 红（左右）/ Y 绿（上下）/ Z 蓝（前后）。
 *
 * 画在 2D 层最上面、不做深度测试 —— 真做深度测试的表现是「人一转身箭头就消失，
 * 想拖拖不了」，市面上的 gizmo 全部常显。
 */
function drawMoveGizmo(ctx: CanvasRenderingContext2D, view: View, actor: DirectorActor) {
  const origin = gizmoOriginOf(actor);
  const o = project(view, origin);
  if (o.depth <= NEAR) return;
  ctx.lineCap = 'round';
  for (const axis of ['x', 'y', 'z'] as const) {
    const tip = add(origin, scale(axisVector(axis), GIZMO_AXIS_LENGTH));
    const p = project(view, tip);
    if (p.depth <= NEAR) continue;
    const dx = p.x - o.x;
    const dy = p.y - o.y;
    const len = Math.hypot(dx, dy);
    if (len < 6) continue;
    const ux = dx / len;
    const uy = dy / len;
    ctx.strokeStyle = GIZMO_COLORS[axis];
    ctx.fillStyle = GIZMO_COLORS[axis];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    /* 箭头：一个小三角，方向顺着轴在屏幕上的走向。 */
    const head = 6;
    ctx.beginPath();
    ctx.moveTo(p.x + ux * head, p.y + uy * head);
    ctx.lineTo(p.x - uy * head * 0.55, p.y + ux * head * 0.55);
    ctx.lineTo(p.x + uy * head * 0.55, p.y - ux * head * 0.55);
    ctx.closePath();
    ctx.fill();
  }
  /* 原点小圆点：三根轴的交汇处，也让「点这儿选中谁」有落点。 */
  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  ctx.beginPath();
  ctx.arc(o.x, o.y, 2.5, 0, Math.PI * 2);
  ctx.fill();
}

/** 指针到屏幕线段（a→b）的最近距离（像素）。 */
function screenDistToSegment(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 < 1e-6 ? 0 : Math.min(1, Math.max(0, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + dx * t), py - (a.y + dy * t));
}

/**
 * 这一点点抓到了 gizmo 的哪根轴。
 *
 * 在屏幕空间量距离（把三根轴投到屏幕上，指针离哪根够近就是哪根），
 * 不做射线求交 —— 轴本来就是画给人看的，人也是按「看着在哪」去点的。
 * 没选中任何灰模时永远 null。
 */
export function pickGizmoAxis(
  scene: DirectorScene,
  width: number,
  height: number,
  x: number,
  y: number,
): 'x' | 'y' | 'z' | null {
  const picked = scene.actors.find(actor => actor.id === scene.selectedId);
  if (!picked) return null;
  const view = makeView(scene.camera, width, height);
  const origin = gizmoOriginOf(picked);
  const o = project(view, origin);
  if (o.depth <= NEAR) return null;
  let best: { axis: 'x' | 'y' | 'z'; dist: number } | null = null;
  for (const axis of ['x', 'y', 'z'] as const) {
    const p = project(view, add(origin, scale(axisVector(axis), GIZMO_AXIS_LENGTH)));
    if (p.depth <= NEAR) continue;
    const dist = screenDistToSegment(x, y, o, p);
    if (dist <= GIZMO_HIT_PX && (!best || dist < best.dist)) best = { axis, dist };
  }
  return best?.axis ?? null;
}

/**
 * 拖某根轴时，指针移到屏幕这一点 = 沿轴移动了多少米（相对 base）。
 *
 * - X / Z：取指针射线与轴线的**公垂线**在轴上的落点 —— 指针斜着拖，落点也跟手。
 * - Y：指针射线打到「过 base、正对相机」的平面上，取交点的世界 y。
 *   用正对相机的平面而不是水平面，是因为拖「上下」时视线往往是平的，跟地面平行就求不出交点。
 */
export function axisDragDelta(
  scene: DirectorScene,
  width: number,
  height: number,
  sx: number,
  sy: number,
  axis: 'x' | 'y' | 'z',
  base: { x: number; y: number; z: number },
): number {
  const view = makeView(scene.camera, width, height);
  const ray = rayOf(scene, width, height, sx, sy);
  if (axis === 'y') {
    const n = view.forward;
    const denom = dot(ray.dir, n);
    if (Math.abs(denom) < 1e-6) return 0;
    const t = dot(sub(base, ray.origin), n) / denom;
    if (t <= 0) return 0;
    return add(ray.origin, scale(ray.dir, t)).y - base.y;
  }
  const u = axisVector(axis);
  const w0 = sub(ray.origin, base);
  const b = dot(ray.dir, u);
  const e = dot(u, w0);
  const denom = 1 - b * b;
  /* 射线跟轴几乎平行（顺着轴的方向看）：动一点像素就是好几米，锁死不动更安全。 */
  if (Math.abs(denom) < 1e-4) return 0;
  const d0 = dot(ray.dir, w0);
  /* 公垂线落在轴线上的参数 s：由 (P(s)-Q(t))·u = 0 与 (P(s)-Q(t))·d = 0 联立消 t。 */
  return (e - b * d0) / denom;
}

/* ------------------------------------------------------------------ 交互换算 */

/** 屏幕上的一点 → 世界里的一根射线。 */
function rayOf(scene: DirectorScene, width: number, height: number, x: number, y: number) {
  const view = makeView(scene.camera, width, height);
  const camDir = { x: (x - view.cx) / view.focal, y: -(y - view.cy) / view.focal, z: -1 };
  const dir = unit(add(add(scale(view.right, camDir.x), scale(view.up, camDir.y)), scale(view.forward, camDir.z)));
  return { origin: view.eye, dir };
}

/** 射线与竖直线段（从地面到头顶）的最近距离。用来判断「点到人了没有」。 */
function rayToSegment(origin: V3, dir: V3, a: V3, b: V3) {
  const axis = sub(b, a);
  const w0 = sub(origin, a);
  const d = dot(dir, dir);
  const e = dot(dir, axis);
  const f = dot(axis, axis);
  const g = dot(dir, w0);
  const h = dot(axis, w0);
  const denom = d * f - e * e;
  let u = denom < 1e-9 ? 0 : (d * h - e * g) / denom;
  u = Math.min(1, Math.max(0, u));
  const nearest = add(a, scale(axis, u));
  const t = Math.max(0, dot(sub(nearest, origin), dir));
  const point = add(origin, scale(dir, t));
  return { dist: distance(point, nearest), t };
}

/**
 * 这一点点到了哪个灰模。
 *
 * 不追求精确求交：把人当成一根从脚到头的竖线，指针离这根线够近就算点上了。
 * 灰模本来就是个示意，用体型去算精确命中不划算，而「点了半天选不中」是真的难受。
 */
export function pickActorAt(
  scene: DirectorScene,
  width: number,
  height: number,
  x: number,
  y: number,
): string | null {
  const ray = rayOf(scene, width, height, x, y);
  let best: { id: string; dist: number; t: number } | null = null;
  for (const actor of scene.actors) {
    /* 命中段跟着离地高度走：抬起来的灰模要能点到它半空里的身体，而不是地面上的影子。 */
    const base: V3 = { x: actor.x, y: liftOf(actor), z: actor.z };
    const top: V3 = { x: actor.x, y: liftOf(actor) + actor.height, z: actor.z };
    const hit = rayToSegment(ray.origin, ray.dir, base, top);
    const reach = actor.kind === 'prop' ? actor.height * 0.55 : actor.height * 0.2;
    if (hit.dist > reach) continue;
    /* 两个都够近时取**离相机近**的那个：前面那个挡着后面那个。 */
    if (!best || hit.t < best.t) best = { id: actor.id, dist: hit.dist, t: hit.t };
  }
  return best?.id ?? null;
}

/**
 * 这一点在地面上对应的位置。
 *
 * 拖着灰模走位时用它把指针落到地面上。视线与地面平行（或朝上）时给不出交点，
 * 返回 null —— 那种情况本来也拖不动。
 */
export function groundPointAt(
  scene: DirectorScene,
  width: number,
  height: number,
  x: number,
  y: number,
): { x: number; z: number } | null {
  const ray = rayOf(scene, width, height, x, y);
  if (Math.abs(ray.dir.y) < 1e-5) return null;
  const t = -ray.origin.y / ray.dir.y;
  if (t <= 0) return null;
  const point = add(ray.origin, scale(ray.dir, t));
  const round = (value: number) => Math.round(Math.min(DIRECTOR_EXTENT, Math.max(-DIRECTOR_EXTENT, value)) * 100) / 100;
  return { x: round(point.x), z: round(point.z) };
}
