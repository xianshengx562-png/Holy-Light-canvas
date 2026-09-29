'use client';

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { axisDragDelta, drawDirectorScene, groundPointAt, pickActorAt, pickGizmoAxis } from '@/lib/directorRender';
import { ratioOf, snapToStep, type DirectorCamera, type DirectorScene } from '@/lib/director';

/**
 * 3D 导演台的视口：一块 canvas，外加三样手势。
 *
 * ⚠️ 三件事别搞混：
 *
 * 1. **尺寸由视口自己算**，不由 CSS 的 `aspect-ratio` 算。画幅是要跟着用户选的
 *    （16:9 / 9:16 / 1:1…），而 9:16 竖构图在固定高度的框里用 CSS 比例算会**溢出**：
 *    浏览器给的是「宽撑满 → 高随便长」，长出来的部分被外层裁掉，看着就像相机坏了。
 *    所以这里量出可用区域，自己取 `min(可用宽, 可用高 × 比例)`，两边都不越界。
 *
 * 2. **滚轮必须是非被动监听**。React 的 `onWheel` 在根节点上是 passive 的，
 *    里面调 `preventDefault()` 会被浏览器忽略（并在控制台留一句警告），
 *    结果就是「推拉镜头的时候整块面板一起滚」。所以这里自己挂一个 `{ passive: false }`。
 *
 * 3. **存参考图读的是这块 canvas 自己的像素**（`toDataURL`）。视口是按需重画的
 *    （每次场景变了才画一帧），所以取之前先强制画一帧，免得存到上一帧。
 */

export type DirectorStageHandle = {
  /** 当前视口的 PNG（`data:image/png;base64,…`）。视口还没尺寸时返回 null。 */
  capture: () => string | null;
};

/** 拖动手势：记下起点和起点的机位 / 站位，之后每一帧都从**起点**算，不累加 —— 累加会漂。 */
type Gesture =
  | { mode: 'orbit'; id: number; x: number; y: number; camera: DirectorCamera }
  | { mode: 'move'; id: number; actorId: string }
  /** 抓着 gizmo 的某根轴：base 记的是**按下那一刻**的底面位置，每帧从它算偏移。 */
  | { mode: 'axis'; id: number; actorId: string; axis: 'x' | 'y' | 'z'; base: { x: number; y: number; z: number } };

export default forwardRef<DirectorStageHandle, {
  scene: DirectorScene;
  /** 改机位（拖空白处 / 滚轮 / 预设都走这里）。 */
  onCamera: (patch: Partial<DirectorCamera>) => void;
  /** 把某个灰模挪到地面上的这一点。 */
  onActorMove: (id: string, x: number, z: number) => void;
  /** 沿 gizmo 的某根轴把灰模挪到某个绝对坐标（x / z 是地面位置，y 是离地高度）。 */
  onActorAxis: (id: string, axis: 'x' | 'y' | 'z', value: number) => void;
  /** 点中了哪个灰模（点空白传 null）。 */
  onActorPick: (id: string | null) => void;
}>(function DirectorStage({ scene, onCamera, onActorMove, onActorAxis, onActorPick }, ref) {
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  /** 可用区域（父容器给的），画布按它和画幅算自己的大小。 */
  const [room, setRoom] = useState({ width: 0, height: 0 });
  const gestureRef = useRef<Gesture | null>(null);
  /** 手势回调里要读最新的场景，但不能把它放进 deps（那会反复摘挂监听）。 */
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const sizeRef = useRef({ width: 0, height: 0 });
  const onCameraRef = useRef(onCamera);
  onCameraRef.current = onCamera;
  const onActorMoveRef = useRef(onActorMove);
  onActorMoveRef.current = onActorMove;
  const onActorAxisRef = useRef(onActorAxis);
  onActorAxisRef.current = onActorAxis;

  const ratio = ratioOf(scene.ratio);
  const width = Math.max(0, Math.floor(Math.min(room.width, room.height * ratio)));
  const height = width > 0 ? Math.max(0, Math.floor(width / ratio)) : 0;
  sizeRef.current = { width, height };

  /* 可用区域变了就重新量：面板可以拖宽，窗口也能缩放。 */
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const measure = () => setRoom({ width: box.clientWidth, height: box.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    return () => observer.disconnect();
  }, []);

  /** 画一帧。`dpr` 只影响清晰度，不改坐标系 —— 画的时候一律按 CSS 像素算。 */
  const paint = useCallback(() => {
    const canvas = canvasRef.current;
    const { width: w, height: h } = sizeRef.current;
    if (!canvas || w <= 0 || h <= 0) return;
    const dpr = Math.min(2, typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
    const pixelW = Math.round(w * dpr);
    const pixelH = Math.round(h * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawDirectorScene(ctx, sceneRef.current, w, h);
  }, []);

  useEffect(() => { paint(); }, [paint, scene, width, height]);

  useImperativeHandle(ref, () => ({
    capture: () => {
      /* 存之前先画一帧：视口是按需重画的，直接读可能读到上一次的姿态。 */
      paint();
      const canvas = canvasRef.current;
      if (!canvas || !canvas.width || !canvas.height) return null;
      try {
        return canvas.toDataURL('image/png');
      } catch {
        return null;
      }
    },
  }), [paint]);

  /*
   * 滚轮推拉镜头：必须非被动，否则 `preventDefault()` 会被浏览器忽略（面板跟着一起滚）。
   *
   * ⚠️ 依赖里**必须有尺寸**。canvas 是条件渲染的（量到可用区域之前不画），
   * 挂 `[]` 的话首次渲染时 `canvasRef.current` 还是 null，这里直接 return ——
   * 而 effect 再也不会跑第二次，于是滚轮从此一辈子没反应，且**不报任何错**。
   * （真机探针就是靠「滚轮前后距离纹丝不动」把这条抓出来的。）
   */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const current = sceneRef.current.camera;
      onCameraRef.current({ distance: current.distance * (event.deltaY > 0 ? 1.08 : 0.92) });
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [width, height]);

  /** 指针位置换算成画布内的坐标（画布是居中的，不能拿容器的左上角算）。 */
  const localPoint = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const { width: w, height: h } = sizeRef.current;
    const point = localPoint(event);
    /*
     * 优先级：gizmo 轴 > 灰模身体 > 机位环绕。
     * gizmo 在最上面画，就也在最上面接 —— 不然箭头画在人身上，点下去永远是人，
     * 上下那根轴就成了摆设。只认 12px 的窄范围，所以抓身体自由走位依然顺手。
     */
    const axis = pickGizmoAxis(sceneRef.current, w, h, point.x, point.y);
    if (axis && sceneRef.current.selectedId) {
      const picked = sceneRef.current.actors.find(actor => actor.id === sceneRef.current.selectedId);
      if (picked) {
        gestureRef.current = {
          mode: 'axis', id: event.pointerId, actorId: picked.id, axis,
          base: { x: picked.x, y: picked.y, z: picked.z },
        };
        onActorPick(picked.id);
        event.currentTarget.setPointerCapture?.(event.pointerId);
        return;
      }
    }
    const hit = pickActorAt(sceneRef.current, w, h, point.x, point.y);
    if (hit) {
      gestureRef.current = { mode: 'move', id: event.pointerId, actorId: hit };
      onActorPick(hit);
    } else {
      gestureRef.current = { mode: 'orbit', id: event.pointerId, x: event.clientX, y: event.clientY, camera: sceneRef.current.camera };
      onActorPick(null);
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = gestureRef.current;
    if (!gesture || gesture.id !== event.pointerId) return;
    const { width: w, height: h } = sizeRef.current;
    if (gesture.mode === 'orbit') {
      onCameraRef.current({
        azimuth: gesture.camera.azimuth - (event.clientX - gesture.x) * 0.4,
        elevation: gesture.camera.elevation + (event.clientY - gesture.y) * 0.3,
      });
      return;
    }
    if (gesture.mode === 'axis') {
      const point = localPoint(event);
      const delta = axisDragDelta(sceneRef.current, w, h, point.x, point.y, gesture.axis, gesture.base);
      const raw = gesture.axis === 'x' ? gesture.base.x + delta
        : gesture.axis === 'y' ? gesture.base.y + delta
          : gesture.base.z + delta;
      onActorAxisRef.current(gesture.actorId, gesture.axis, snapToStep(raw, sceneRef.current.snap));
      return;
    }
    const point = localPoint(event);
    const ground = groundPointAt(sceneRef.current, w, h, point.x, point.y);
    if (ground) {
      const snap = sceneRef.current.snap;
      onActorMoveRef.current(gesture.actorId, snapToStep(ground.x, snap), snapToStep(ground.z, snap));
    }
  };

  const endGesture = () => { gestureRef.current = null; };

  return (
    <div className="cv-dir-stage" ref={boxRef}>
      {width > 0 && height > 0 && (
        <canvas
          ref={canvasRef}
          className="cv-dir-canvas"
          style={{ width, height }}
          role="img"
          aria-label={`导演台视口：${scene.ratio}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endGesture}
          onPointerCancel={endGesture}
        />
      )}
    </div>
  );
});
