import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { readWorkflowProvider, type WorkflowProvider } from '@/lib/workflows/local';
import { readGeneratorKind, type GeneratorKind } from '@/lib/workflows/purpose';
import { readWorkflowOperation, type WorkflowOperation } from '@/lib/workflows/operation';

/**
 * **内置（预设）工作流**（2026-10-02 徐先：「添加两个预设 runninghub 的超清工作流」）。
 *
 * 这两条是 RunningHub 上的超清（VOSR 2）工作流，图片一条、视频一条 —— 随软件带，
 * **不用用户自己填 ID、也不用自己配字段**：打开画布 / 工作流库时就地补进他自己的库，
 * 之后就和一份普通的用户工作流没区别（能改、能被「超清」按钮取用）。
 *
 * 🔴 **只补、不覆盖**：`ensureBuiltinWorkflows()` 先看 `(userId, workflowId)` 在不在，
 * 在就**一个字都不动**。用户改过名字 / 改过字段 / 改过用途，都以**他那一份**为准 ——
 * 预设不是「每次启动强制同步回出厂设置」，那会把人自己配的东西吃掉。
 *
 * 🔴 **为什么写库，而不是读的时候合进来**：写库之后列表、筛选、超清候选、配置页
 * 全都走原有那几条路，一处不用改；「读时合并」要在每一个读接口上各加一次，漏一处就是
 * 「下拉里没有 / 超清按钮取不到」—— 而这两处的症状**一模一样**，最难查。
 */

/** 一份内置工作流的种子。字段与 `WorkflowDraft` 那几列一一对应。 */
export type BuiltinWorkflow = {
  workflowId: string;
  provider: WorkflowProvider;
  kind: GeneratorKind;
  category: string;
  operation: WorkflowOperation;
  name: string;
  /** `config` 那一列的内容：一份标准的字段清单（`configurationSchema` 认的形状）。 */
  fields: Array<Record<string, unknown>>;
};

/*
 * 字段清单是从**配好的那份**原样搬过来的：绝大部分 `enabled: false`（走工作流自己的默认值），
 * 只留承接待加工媒体的那一个开着 —— 超清只要把媒体喂进去，别的一概不动。
 *
 * ⚠️ 那两个字段的 `value` 是**空串**（本机那份带着具体文件名，是调试时留下的）：
 * 空串 = 「等运行时填」，服务端 `resolveUpscaleInput` 会把这一份换掉；
 * 留着文件名的话，绑不上时会拿一个别人机器上不存在的文件名去提交，报出来的话牛头不对马嘴。
 */
export const BUILTIN_WORKFLOWS: BuiltinWorkflow[] = [
  {
    workflowId: '2096958059879952385',
    provider: 'runninghub',
    kind: 'image',
    category: 'none',
    operation: 'upscale',
    name: "Vosr 2图像高清化(T8)",
    fields: [
      { key: "1.vae_tile_overlap", nodeId: "1", fieldName: "vae_tile_overlap", label: "vae_tile_overlap", kind: "number", value: "64", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.seed", nodeId: "1", fieldName: "seed", label: "seed", kind: "number", value: "141386989863540", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.upscale", nodeId: "1", fieldName: "upscale", label: "upscale", kind: "number", value: "4", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.vae_tile_size", nodeId: "1", fieldName: "vae_tile_size", label: "vae_tile_size", kind: "number", value: "512", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.tile_size", nodeId: "1", fieldName: "tile_size", label: "tile_size", kind: "number", value: "512", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.color_alignment", nodeId: "1", fieldName: "color_alignment", label: "color_alignment", kind: "text", value: "wavelet", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.tile_overlap", nodeId: "1", fieldName: "tile_overlap", label: "tile_overlap", kind: "number", value: "64", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "2.dtype", nodeId: "2", fieldName: "dtype", label: "dtype", kind: "text", value: "default", enabled: false, binding: "manual", recommended: true, classType: "VOSR2ModelLoader" },
      { key: "2.model", nodeId: "2", fieldName: "model", label: "model", kind: "text", value: "VOSR2", enabled: false, binding: "manual", recommended: true, classType: "VOSR2ModelLoader" },
      { key: "3.image", nodeId: "3", fieldName: "image", label: "image", kind: "image", value: "", enabled: true, binding: "reference_image_1", recommended: true, classType: "LoadImage" },
      { key: "4.filename_prefix", nodeId: "4", fieldName: "filename_prefix", label: "filename_prefix", kind: "text", value: "ComfyUI", enabled: false, binding: "manual", recommended: true, classType: "SaveImage" },
      { key: "7.interpolation", nodeId: "7", fieldName: "interpolation", label: "interpolation", kind: "text", value: "bicubic", enabled: false, binding: "manual", recommended: true, classType: "PDIMAGE_LongerSize" },
      { key: "7.size", nodeId: "7", fieldName: "size", label: "size", kind: "number", value: "1024", enabled: false, binding: "manual", recommended: true, classType: "PDIMAGE_LongerSize" },
    ],
  },
  {
    workflowId: '2096970443046612993',
    provider: 'runninghub',
    kind: 'video',
    category: 'none',
    operation: 'upscale',
    name: "Vosr 2视频高清化（级联2K）",
    fields: [
      { key: "1.vae_tile_overlap", nodeId: "1", fieldName: "vae_tile_overlap", label: "vae_tile_overlap", kind: "number", value: "64", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.seed", nodeId: "1", fieldName: "seed", label: "seed", kind: "number", value: "803610043855046", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.upscale", nodeId: "1", fieldName: "upscale", label: "upscale", kind: "number", value: "2", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.vae_tile_size", nodeId: "1", fieldName: "vae_tile_size", label: "vae_tile_size", kind: "number", value: "512", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.tile_size", nodeId: "1", fieldName: "tile_size", label: "tile_size", kind: "number", value: "512", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.color_alignment", nodeId: "1", fieldName: "color_alignment", label: "color_alignment", kind: "text", value: "wavelet", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "1.tile_overlap", nodeId: "1", fieldName: "tile_overlap", label: "tile_overlap", kind: "number", value: "64", enabled: false, binding: "manual", recommended: true, classType: "VOSR2Upscale" },
      { key: "2.dtype", nodeId: "2", fieldName: "dtype", label: "dtype", kind: "text", value: "default", enabled: false, binding: "manual", recommended: true, classType: "VOSR2ModelLoader" },
      { key: "2.model", nodeId: "2", fieldName: "model", label: "model", kind: "text", value: "VOSR2", enabled: false, binding: "manual", recommended: true, classType: "VOSR2ModelLoader" },
      { key: "7.custom_height", nodeId: "7", fieldName: "custom_height", label: "custom_height", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.force_rate", nodeId: "7", fieldName: "force_rate", label: "force_rate", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.custom_width", nodeId: "7", fieldName: "custom_width", label: "custom_width", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.select_every_nth", nodeId: "7", fieldName: "select_every_nth", label: "select_every_nth", kind: "video", value: "1", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.frame_load_cap", nodeId: "7", fieldName: "frame_load_cap", label: "frame_load_cap", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.format", nodeId: "7", fieldName: "format", label: "format", kind: "video", value: "AnimateDiff", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.video", nodeId: "7", fieldName: "video", label: "video", kind: "video", value: "", enabled: true, binding: "video_input", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.skip_first_frames", nodeId: "7", fieldName: "skip_first_frames", label: "skip_first_frames", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "7.force_size", nodeId: "7", fieldName: "force_size", label: "force_size", kind: "video", value: "Disabled", enabled: false, binding: "manual", recommended: true, classType: "VHS_LoadVideo" },
      { key: "8.interpolation", nodeId: "8", fieldName: "interpolation", label: "interpolation", kind: "text", value: "bicubic", enabled: false, binding: "manual", recommended: true, classType: "PDIMAGE_LongerSize" },
      { key: "8.size", nodeId: "8", fieldName: "size", label: "size", kind: "number", value: "640", enabled: false, binding: "manual", recommended: true, classType: "PDIMAGE_LongerSize" },
      { key: "11.resize_type", nodeId: "11", fieldName: "resize_type", label: "resize_type", kind: "text", value: "scale by multiplier", enabled: false, binding: "manual", recommended: true, classType: "RTXVideoSuperResolution" },
      { key: "11.resize_type.scale", nodeId: "11", fieldName: "resize_type.scale", label: "resize_type.scale", kind: "number", value: "2", enabled: false, binding: "manual", recommended: true, classType: "RTXVideoSuperResolution" },
      { key: "11.quality", nodeId: "11", fieldName: "quality", label: "quality", kind: "text", value: "ULTRA", enabled: false, binding: "manual", recommended: true, classType: "RTXVideoSuperResolution" },
      { key: "12.pix_fmt", nodeId: "12", fieldName: "pix_fmt", label: "pix_fmt", kind: "video", value: "yuv420p", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.format", nodeId: "12", fieldName: "format", label: "format", kind: "video", value: "video/h264-mp4", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.pingpong", nodeId: "12", fieldName: "pingpong", label: "pingpong", kind: "video", value: "false", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.save_output", nodeId: "12", fieldName: "save_output", label: "save_output", kind: "video", value: "true", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.filename_prefix", nodeId: "12", fieldName: "filename_prefix", label: "filename_prefix", kind: "video", value: "AnimateDiff", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.loop_count", nodeId: "12", fieldName: "loop_count", label: "loop_count", kind: "video", value: "0", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.save_metadata", nodeId: "12", fieldName: "save_metadata", label: "save_metadata", kind: "video", value: "true", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.crf", nodeId: "12", fieldName: "crf", label: "crf", kind: "video", value: "19", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.trim_to_audio", nodeId: "12", fieldName: "trim_to_audio", label: "trim_to_audio", kind: "video", value: "false", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
      { key: "12.no_preview", nodeId: "12", fieldName: "no_preview", label: "no_preview", kind: "video", value: "false", enabled: false, binding: "manual", recommended: true, classType: "VHS_VideoCombine" },
    ],
  },
];

/** 这些 ID 是内置的（`BUILTIN_WORKFLOWS` 的子集，查表比查数组快不了多少，但只有一处说了算）。 */
const BUILTIN_IDS = new Set(BUILTIN_WORKFLOWS.map(item => item.workflowId));

/**
 * 这份工作流是不是软件自带的预设。
 *
 * 界面据此标「内置」、不给删；删接口据此拒绝 —— 删了它下次开库又会被补回来，
 * 与其让人删一次回一次，不如**一开始就不给删**。
 */
export function isBuiltinWorkflowId(workflowId: string): boolean {
  return BUILTIN_IDS.has(workflowId);
}

/**
 * 把所有内置工作流补进这个用户的库 —— **只补他还没有的那几条**。
 *
 * 调用点只有一处：`GET /api/workflows`（列表）。所有要用到工作流的地方（画布下拉、
 * 工作流库、超清候选）都要先过这一支，所以「打开软件就有」这件事只需要守这一个口子。
 */
export async function ensureBuiltinWorkflows(userId: string): Promise<void> {
  for (const preset of BUILTIN_WORKFLOWS) {
    const existing = await db.workflowDraft.findUnique({
      where: { userId_workflowId: { userId, workflowId: preset.workflowId } },
      select: { id: true },
    });
    if (existing) continue;
    try {
      await db.workflowDraft.create({
        data: {
          userId,
          workflowId: preset.workflowId,
          provider: readWorkflowProvider(preset.provider),
          kind: readGeneratorKind(preset.kind),
          category: preset.category,
          operation: readWorkflowOperation(preset.operation),
          name: preset.name,
          config: { fields: preset.fields } as Prisma.InputJsonValue,
          version: 0,
        },
      });
    } catch (error) {
      /*
       * 两个列表请求同时进来时，第二路的 `create` 会撞 `(userId, workflowId)` 唯一键。
       * 那不是错误 —— 想要的那一行已经在了。**只吞这一种**，别的照抛：
       * 静默吞掉所有写库失败，表现是「预设没了但谁也不知道为什么」。
       */
      const code = (error as { code?: string } | null)?.code;
      if (code !== 'P2002') throw error;
    }
  }
}
