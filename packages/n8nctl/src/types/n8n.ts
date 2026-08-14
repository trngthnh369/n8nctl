export interface Workflow {
  id: string;
  name: string;
  active: boolean;
  /**
   * Present since an EARLIER n8n release than the archive/unarchive endpoints
   * themselves — 1.122.5 returns this field but 404s on `POST /archive`. Never
   * infer endpoint availability from it; see scripts/SESSION_REST_CONTRACT.md.
   */
  isArchived?: boolean;
  nodes: WorkflowNode[];
  connections: Record<string, unknown>;
  settings?: Record<string, unknown>;
  staticData?: Record<string, unknown> | null;
  tags?: WorkflowTag[];
  createdAt?: string;
  updatedAt?: string;
  versionId?: string;
  meta?: Record<string, unknown>;
  pinData?: Record<string, unknown>;
}

export interface WorkflowNode {
  id: string;
  name: string;
  type: string;
  typeVersion: number;
  position: [number, number];
  parameters: Record<string, unknown>;
  credentials?: Record<string, unknown>;
  disabled?: boolean;
  notes?: string;
}

export interface WorkflowTag {
  id: string;
  name: string;
}

export interface Execution {
  id: string;
  finished: boolean;
  mode: string;
  retryOf?: string | null;
  retrySuccessId?: string | null;
  status?: ExecutionStatus;
  startedAt: string;
  stoppedAt?: string | null;
  workflowId: string;
  waitTill?: string | null;
  data?: unknown;
}

export type ExecutionStatus =
  | 'new'
  | 'running'
  | 'success'
  | 'error'
  | 'canceled'
  | 'crashed'
  | 'waiting';

export interface Credential {
  id: string;
  name: string;
  type: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  nextCursor?: string | null;
}
