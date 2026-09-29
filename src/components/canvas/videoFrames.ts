/**
 * 从一段视频里取帧 —— 浏览器原生解码 + canvas，不依赖 ffmpeg、不依赖主进程。
 *
 * 三条约定，改这个文件前先读一遍：
 *
 * 1. **只吃「能解码的地址」**。`blob:`、同源的 `/api/assets/...` 都能画进 canvas；
 *    别的域的 http 地址**必须**带 CORS 头，否则浏览器会把画布标成「已污染」，
 *    `toBlob` 直接抛 SecurityError。这里用 `crossOrigin='anonymous'` 试一次，
 *    失败就把原因说成「读不到像素」而不是笼统的「提取失败」 —— 前者用户能自行
 *    （换成本地文件 / 等上传完成），后者只能干等。
 * 2. **每一帧都要先 seek 再画**。`drawImage(video)` 画的是**当前**帧，不 seek 就永远
 *    拿到第一帧，症状是「首帧尾帧一模一样」。
 * 3. **seek 必须有超时**。`seeked` 不一定来（编码特殊、流太长、`currentTime` 已经等于
 *    目标值时根本不会触发），没有超时这个 Promise 会永远挂着，界面一直转圈。
 */

/** 抽一帧最多等多久。超过就报超时，不让「正在提取…」永远转下去。 */
const SEEK_TIMEOUT_MS = 10_000;
/**
 * 首帧往后挪这么久。
 *
 * 很多视频的第 0 帧是纯黑（转场/淡入、编码器补的起始帧），直接取 0 会得到一张黑图，
 * 用户只会觉得「这个功能坏了」。0.1 秒对 30fps 来说是第 3 帧，画面已经成型。
 * 视频本身比 0.2 秒还短时就取它的一半，别越界。
 */
const HEAD_OFFSET = 0.1;
/**
 * 尾帧往回退这么久。
 *
 * 直接 seek 到 `duration` 是最容易踩的坑：不少视频定位到末尾会**停在最后一帧之前**
 * 或者干脆触发不了 `seeked`（见文件头第 3 条），画出来是黑屏或倒数第二帧。
 * 退 0.04 秒（比一帧略长）能稳稳落在最后一帧上，而肉眼看不出差别。
 */
const TAIL_OFFSET = 0.04;

export type ExtractedFrame = {
  blob: Blob;
  width: number;
  height: number;
};

export type EdgeFrames = {
  first: ExtractedFrame;
  last: ExtractedFrame;
  /** 视频时长（秒），拿不到就是 0 —— 只用于界面上显示，不参与任何判断。 */
  duration: number;
};

/** 等视频加载到「当前帧已经能画」这一步。 */
function loadVideo(src: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    /*
     * ⚠️ `crossOrigin` 必须在 `src` **之前**设：赋值顺序反了这一次加载就不带 CORS 头，
     * 而同一个元素改了属性也不会重新去取 —— 症状是「明明设置了却还是被污染」。
     */
    video.crossOrigin = 'anonymous';
    const onError = () => reject(new Error('视频加载失败：地址取不到，或这个域不允许读取像素'));
    const onLoaded = () => {
      video.removeEventListener('error', onError);
      resolve(video);
    };
    video.addEventListener('loadeddata', onLoaded, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.src = src;
  });
}

/** 定位到某一秒。见文件头第 3 条：必须有超时，且电流时间已经等于目标时直接返回。 */
function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
  const target = Math.max(0, time);
  if (Math.abs(video.currentTime - target) < 1e-3) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeEventListener('seeked', onSeeked);
      video.removeEventListener('error', onError);
      if (error) reject(error); else resolve();
    };
    const onSeeked = () => finish();
    const onError = () => finish(new Error('视频解码失败'));
    const timer = setTimeout(() => finish(new Error('定位到这一帧超时了（视频太长或编码特殊）')), SEEK_TIMEOUT_MS);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.addEventListener('error', onError, { once: true });
    video.currentTime = target;
  });
}

/** 把当前帧画进 canvas 并编码成 JPEG。跨域时会在这里炸，错误信息要能指回原因。 */
function grab(video: HTMLVideoElement): Promise<ExtractedFrame> {
  const width = video.videoWidth || 640;
  const height = video.videoHeight || 360;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('拿不到 canvas 上下文，无法取帧'));
  try {
    ctx.drawImage(video, 0, 0, width, height);
  } catch {
    return Promise.reject(new Error('读不到这段视频的像素：它来自别的域，而那个域不允许跨域读取'));
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => (blob && blob.size
        ? resolve({ blob, width, height })
        : reject(new Error('这一帧没能编码出来（画面太大或解码不完整）'))),
      'image/jpeg',
      0.92,
    );
  });
}

/** 视频时长。webm 之类的流媒体可能给 Infinity，那种只能退回已缓冲区间的末端。 */
function durationOf(video: HTMLVideoElement) {
  if (Number.isFinite(video.duration) && video.duration > 0) return video.duration;
  if (video.seekable.length) {
    const end = video.seekable.end(video.seekable.length - 1);
    if (Number.isFinite(end) && end > 0) return end;
  }
  return 0;
}

/**
 * 取一帧。`at` 给数字就是第几秒，给 `'first' / 'last'` 按文件头那两个偏移量算。
 *
 * 用完一定把 `<video>` 的 src 摘掉 —— 它是个真实的网络/解码资源，
 * 留着一段 4K 视频的解码器挂在内存里，多提几次界面就卡了。
 */
export async function extractFrame(src: string, at: number | 'first' | 'last' = 'first'): Promise<ExtractedFrame> {
  const video = await loadVideo(src);
  try {
    const duration = durationOf(video);
    const time = at === 'first'
      ? Math.min(HEAD_OFFSET, duration / 2)
      : at === 'last'
        ? Math.max(0, duration - TAIL_OFFSET)
        : at;
    await seekTo(video, time);
    return await grab(video);
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * 一次把首帧和尾帧都取出来。
 *
 * 两次 seek 走**同一个 `<video>`**：重新建一个元素要再解一遍码、再等一次 `loadeddata`，
 * 大文件上那是一两秒的差别，而这里已经有了一个解码好的实例。
 */
export async function extractEdgeFrames(src: string): Promise<EdgeFrames> {
  const video = await loadVideo(src);
  try {
    const duration = durationOf(video);
    await seekTo(video, Math.min(HEAD_OFFSET, duration / 2));
    const first = await grab(video);
    await seekTo(video, Math.max(0, duration - TAIL_OFFSET));
    const last = await grab(video);
    return { first, last, duration };
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/**
 * 只要首帧的 blob —— 视频输入节点上传完顺手取首帧当参考图用的就是这一条。
 *
 * 单独留一个入口而不是让调用方去取 `extractEdgeFrames().first.blob`：
 * 那边会**多 seek 一次、多编码一张图**，而这里只用到首帧。
 */
export async function firstFrameBlob(src: string): Promise<Blob> {
  return (await extractFrame(src, 'first')).blob;
}
