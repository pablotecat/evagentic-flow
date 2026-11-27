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

export type EvidenceRef = { captureID: string; arrival: number; eventID: string | null; type?: string };

export type TraceDelegation = {
  parentSessionID: string;
  callID: string | null;
  evidence: EvidenceRef;
};

export type TraceRelation =
  | 'view-root'
  | 'delegation-call-observed'
  | 'parent-observed-call-unknown'
  | 'unknown';

export type TraceNode = {
  sessionID: string;
  isViewRoot: boolean;
  agentIDs: string[];
  observedParents: string[];
  delegations: TraceDelegation[];
  relation: TraceRelation;
};

export type TraceTree = { nodes: TraceNode[]; sessionIDs: string[] };

export type DiagnosticError = { type: string; message: string; status?: number } | null;

export type ExecutionInterval = {
  type: 'diagnostic.execution-interval';
  projectID: string;
  sessionID: string;
  messageID: string | null;
  callID: string | null;
  intervalRef?: EvidenceRef | null;
  startedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  durationSource: string;
  outcome: string;
  state: string | null;
  reason: string | null;
  error: DiagnosticError;
  pendingWork: null;
  evidence: EvidenceRef[];
  omissions: string[];
};

export type ExternalWait = {
  type: 'diagnostic.wait';
  projectID: string;
  sessionID: string;
  kind: 'permission' | 'form';
  requestID: string | null;
  startedAt: number | null;
  endedAt: number | null;
  outcome: string;
  state: string | null;
  elapsedMs: number | null;
  durationSource: string;
  evidence: EvidenceRef[];
  omissions: string[];
};

export type TraceTimeline = { intervals: ExecutionInterval[]; waits: ExternalWait[] };

export type MetricEntry<T = unknown> = {
  value: T | null;
  status: string;
  source: string | null;
  scope: string;
};

export type TokenCounts = {
  input: number;
  output: number;
  reasoning: number;
  cache: { read: number; write: number };
};

export type TokensMetric = MetricEntry<TokenCounts> & { basis?: string; providerReported?: null };

export type CostMetric = MetricEntry<number> & { basis?: string };

export type ModelIdentity = { providerID: string; id: string };

export type StepDispatch = {
  startedAt: number | null;
  model: MetricEntry<ModelIdentity>;
  tokens: null;
  costUSD: null;
  evidence: EvidenceRef;
};

export type StepRetry = {
  kind: string;
  attempt: number;
  at: number;
  error: NonNullable<DiagnosticError>;
  tokens: null;
  costUSD: null;
  scheduledDelayMs: number | null;
  actualWaitMs: null;
  evidence: EvidenceRef;
};

export type StepResult = {
  phase: string;
  finish: string | null;
  error: DiagnosticError;
  tokens: TokensMetric;
  costUSD: CostMetric;
  evidence: EvidenceRef;
};

export type ModelStep = {
  type: 'diagnostic.model-step';
  sessionID: string;
  messageID: string | null;
  callID: string | null;
  model: MetricEntry<ModelIdentity>;
  tokens: TokensMetric;
  costUSD: CostMetric;
  startedAt: number | null;
  streamedAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  providerBodyMs: number | null;
  outcome: string;
  state: string | null;
  finish: string | null;
  error: DiagnosticError;
  durationSource: string;
  skillConsumption: null;
  dispatches: StepDispatch[];
  retries: StepRetry[];
  results: StepResult[];
  evidence: EvidenceRef[];
  omissions: string[];
};

export type TraceMeasurement = {
  type: 'diagnostic.measurement';
  kind: string;
  sessionID: string | null;
  model: MetricEntry<ModelIdentity>;
  tokens: TokensMetric;
  costUSD: CostMetric;
  outcome: string;
  error: DiagnosticError;
  evidence: EvidenceRef[];
  omissions: string[];
};

export type PendingInboxItem = {
  type: 'diagnostic.pending-inbox';
  sessionID: string;
  messageID: string | null;
  state: string;
  evidence: EvidenceRef[];
  omissions: string[];
};

export type MetricCoverage = {
  type: 'diagnostic.metric-coverage';
  flowElapsedMs: number | null;
  omissions: string[];
  recorderDiagnostics: Array<EvidenceRef & { reason: string | null }>;
};

export type TraceMetrics = {
  steps: ModelStep[];
  measurements: TraceMeasurement[];
  pendingInbox: PendingInboxItem[];
  coverage: MetricCoverage | null;
};

export type ToolOutputPart = { type: 'text'; text: string };

export type ToolAttempt = {
  type: 'diagnostic.tool-attempt';
  projectID: string;
  sessionID: string;
  messageID: string | null;
  callID: string | null;
  toolName: string | null;
  input: unknown;
  inputText: string | null;
  output: ToolOutputPart[] | null;
  error: DiagnosticError;
  outcome: string | null;
  startedAt: number | null;
  calledAt: number | null;
  endedAt: number | null;
  elapsedMs: number | null;
  durationSource: string | null;
  retryOf: null;
  operationID: null;
  consumption: null;
  incident: { kind: string; cause: string | null } | null;
  evidence: EvidenceRef[];
  omissions: string[];
};

export type CaptureHorizon = { captureID: string; arrival: number; observedAt: number };

export type SkillRecord = {
  id: string;
  name: string | null;
  text: string;
  sha256: string;
  origin: 'successful-skill-tool-result' | 'runtime-activation-event';
  contextID: null;
  consumption: null;
};

export type ObservedSkill = {
  sessionID: string;
  messageID: string | null;
  callID: string | null;
  type: string;
  skill: SkillRecord;
  evidence: EvidenceRef;
};

export type SkillObservation = {
  observationTime: number;
  source: string;
  identity: string | null;
  sessionID: string;
  messageID: string | null;
  eventID: string | null;
  status: string;
  omissions: string[];
  redactions: string[];
  value: unknown;
  sha256: string | null;
  hashBasis: string;
  evidence: EvidenceRef;
};

export type TraceSkills = {
  observed: ObservedSkill[];
  admitted: SkillObservation[];
  available: SkillObservation[];
  definitions: SkillObservation[];
  environment: SkillObservation[];
};

export type CaptureCoverage = {
  type: 'diagnostic.capture-coverage';
  readiness: string;
  scope: string;
  sessionID: string | null;
  sessions: string[];
  declarations: Record<string, unknown>[];
  observed: Array<{ type: string | null; source: string | null; stage: string | null; status: string | null; count: number }>;
  omissions: string[];
  diagnostics: Record<string, unknown>[];
  horizons: CaptureHorizon[];
};

export type TraceResponse = {
  executionID: string;
  rootSessionID?: string;
  readable: true;
  selectedSessionID: string;
  tree: TraceTree;
  timeline: TraceTimeline;
  tools: { attempts: ToolAttempt[] };
  metrics: TraceMetrics;
  captureDiagnostics: CaptureCoverage | null;
  skills: TraceSkills;
  horizon: string | null;
};

export type TraceUnreadable = {
  executionID: string;
  rootSessionID?: string;
  readable: false;
  reason: string;
};

export type TraceBody = TraceResponse | TraceUnreadable;
