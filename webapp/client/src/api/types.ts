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

export type FormFieldOption = { value?: string; label?: string };

export type FormFieldWhen = { field: string; equals?: string | number | boolean } | Record<string, unknown> | null;

export type FormField = {
  key: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect';
  title?: string;
  description?: string;
  required?: boolean;
  options?: FormFieldOption[];
  custom?: boolean;
  when?: FormFieldWhen;
};

export type InteractionRequest = {
  title?: string;
  fields?: FormField[];
  action?: string;
  resources?: string[];
  message?: string;
} | null;

export type PendingInteraction = {
  kind: 'form' | 'permission';
  sessionID: string;
  requestID: string;
  request: InteractionRequest;
  observedAt: number;
};

export type ResolvedInteraction = {
  kind: 'form' | 'permission';
  sessionID: string;
  requestID: string;
  phase: string;
  response: Record<string, unknown> | null;
};

export type InteractionReadError = { sessionID?: string | null; error: string };

export type Interactions = {
  pending: PendingInteraction[];
  resolved: ResolvedInteraction[];
  readErrors: InteractionReadError[];
};

export type StopSessionState = { sessionID: string; outcome: string | null; stop?: string };

export type StopSessionRequest = { sessionID: string; result: string; stop: string };

export type StopState = {
  requested: boolean;
  requestedAt?: number | null;
  sessions?: StopSessionState[];
  readError?: string | null;
  treeVerified?: boolean;
};

export type StopResponseBody = {
  requested: boolean;
  requestedAt: number | null;
  sessions: StopSessionRequest[];
};

export type RecorderInterruption = { requested?: boolean; stop?: string } | null;

export type RecorderState = {
  readable: boolean;
  reason?: string | null;
  status?: string | null;
  reviewRequired?: boolean;
  pilotReady?: boolean;
  notice?: string | null;
  interruption?: RecorderInterruption;
  source?: string | null;
};

export type CaptureGap = { captureID: string; arrival: number; observedAt: number; scope?: string; reason?: string };

export type CaptureOmission = { sessionID: string; captureID?: string; arrival?: number; type?: string; omissions?: string[] };

export type EvidenceScope = { kind?: string; rootSessionID?: string; sessionIDs?: string[] };

export type CaptureDetail = {
  readable: boolean;
  reason?: string;
  captureIDs: string[];
  recorderFailed: boolean;
  horizon: string | null;
  scope?: EvidenceScope;
  gaps?: CaptureGap[];
  omissions?: CaptureOmission[];
};

export type ExecutionDetail = {
  execution: Execution;
  stop?: StopState;
  recorder: RecorderState;
  conversation: { entries: ConversationEntry[]; responses: ConversationEntry[] };
  capture: CaptureDetail;
  interactions?: Interactions;
};

export type ApiFailure = { status: number; body: Record<string, unknown> | null };
