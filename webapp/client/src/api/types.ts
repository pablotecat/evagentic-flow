export type EngineHealth = { reachable: boolean; version: string | null };

export type CaptureStatus = 'prepared' | 'failed' | 'no-evidence' | 'unavailable';

export type CaptureHealth = { status: CaptureStatus; reason?: string };

export type Health = {
  engine: EngineHealth;
  capture: CaptureHealth;
  index: { status: 'available' | 'review-required' };
};

export type AgentOption = { id: string; name: string; description: string | null; mode: string };

export type ModelOption = {
  value: string;
  name: string;
  providerID: string;
  modelID: string;
  variant: string | null;
};

export type CommandOption = { name: string; description: string | null };

export type Options = {
  state: 'ready' | 'engine-unreachable' | 'unavailable';
  engine: EngineHealth | null;
  agents: AgentOption[] | null;
  models: ModelOption[] | null;
  commands: CommandOption[] | null;
};

export type ExecutionStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'interrupted';

export type CommandMetadata = { name: string };

export type ExecutionModel = {
  value: string;
  providerID: string;
  modelID: string;
  variant: string | null;
};

export type Execution = {
  id: string;
  requestKey: string;
  project: string;
  status: ExecutionStatus;
  dispatch: string;
  createdAt: number;
  dispatchedAt: number | null;
  finishedAt: number | null;
  sessionID: string | null;
  promptMessageID: string | null;
  requestedAgent: string | null;
  requestedModel: string | null;
  requestedCommand: CommandMetadata | null;
  knownAgent: string | null;
  knownAgentSource: string | null;
  knownModel: ExecutionModel | null;
  knownModelSource: string | null;
  selectionObservedAt: number | null;
  stop: { requested: boolean; requestedAt: number | null };
};

export type ConversationEntry = { text: string };

export type ExecutionDetail = {
  execution: Execution;
  recorder: {
    readable: boolean;
    reason?: string;
    status?: string | null;
    reviewRequired?: boolean;
    source?: string;
  };
  conversation: { entries: ConversationEntry[]; responses: ConversationEntry[] };
  capture: {
    readable: boolean;
    reason?: string;
    captureIDs: string[];
    recorderFailed: boolean;
    horizon: string | null;
  };
};

export type ApiFailure = { status: number; body: Record<string, unknown> | null };
