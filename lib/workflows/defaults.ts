import raw from './runninghub-fields.json';
import { applyDefaultBindings, configurationSchema } from './configuration';
import { readGeneratorKind, type GeneratorKind } from './purpose';

/** 默认（视频）工作流。它同时是 `.env` 里 `RUNNINGHUB_WORKFLOW_ID` 的值。 */
export const defaultWorkflowId = '2099453228814528513';

/**
 * 某种用途的默认工作流。
 *
 * 视频有默认值（就是现在在用的那条），**图片故意没有** —— 出图工作流必须由用户明确选，
 * 把视频那条当兜底递过去只会跑出一段视频，而且是「成功」的那种（这个坑踩过了，
 * 见 CanvasEditor 里那条 `isImage ? '' : 常量`）。
 */
export function defaultWorkflowIdFor(kind: GeneratorKind | string) {
  return readGeneratorKind(kind) === 'video' ? defaultWorkflowId : '';
}

export function defaultConfiguration(workflowId: string) {
  return configurationSchema.parse(applyDefaultBindings(workflowId === defaultWorkflowId ? raw : { fields: [] }));
}
