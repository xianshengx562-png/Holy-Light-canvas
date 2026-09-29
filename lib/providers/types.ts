export type TaskStatus = 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
export type TaskInput = { workflowId: string; inputs: Record<string, string | number | boolean>; idempotencyKey: string };
export type TaskResult = { assets: { type: 'image' | 'video'; url: string }[] };
export interface AIProvider {
  testConnection(): Promise<{ connected: boolean }>;
  submitTask(input: TaskInput): Promise<{ externalTaskId: string }>;
  getTaskStatus(taskId: string): Promise<{ status: TaskStatus; progress?: number }>;
  getTaskResult(taskId: string): Promise<TaskResult>;
}
export type WorkflowInputMapping = Record<string, { nodeId: string; fieldName: string }>;
