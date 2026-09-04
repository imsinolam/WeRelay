import type { BridgeAdapterKind } from "./bridge-providers.ts";

export type { BridgeAdapterKind } from "./bridge-providers.ts";
export type BridgeLifecycleMode = "persistent" | "companion_bound";
export type BridgeSessionStartMode = "restore" | "new";
export type BridgeTurnOrigin = "wechat" | "local";
export type BridgeSessionSwitchSource = BridgeTurnOrigin | "restore";
export type BridgeSessionSwitchReason =
  | "local_follow"
  | "local_session_fallback"
  | "local_turn"
  | "wechat_resume"
  | "startup_restore";
export type BridgeThreadSwitchSource = BridgeSessionSwitchSource;
export type BridgeThreadSwitchReason = BridgeSessionSwitchReason;

export type BridgeWorkerStatus =
  | "starting"
  | "idle"
  | "busy"
  | "awaiting_approval"
  | "awaiting_input"
  | "stopped"
  | "error";

export type BridgeNoticeLevel = "info" | "warning";
export type BridgeTaskOutcome = "completed" | "interrupted" | "failed";

export type ApprovalSource = "shell" | "cli";

export type ApprovalRequest = {
  source: ApprovalSource;
  threadId?: string;
  turnId?: string;
  origin?: BridgeTurnOrigin;
  summary: string;
  commandPreview: string;
  allowForSession?: boolean;
  toolName?: string;
  detailLabel?: string;
  detailPreview?: string;
  requestId?: string;
  createdAt?: string;
  confirmInput?: string;
  denyInput?: string;
};

export type PendingApproval = ApprovalRequest & {
  code: string;
  createdAt: string;
};

export type UserInputRequestOption = {
  label: string;
  description: string;
};

export type UserInputRequestQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  multiSelect?: boolean;
  options?: UserInputRequestOption[] | null;
};

export type UserInputRequest = {
  summary: string;
  threadId?: string;
  turnId?: string;
  origin?: BridgeTurnOrigin;
  questions: UserInputRequestQuestion[];
};

export type PendingUserInputRequest = UserInputRequest & {
  createdAt: string;
};

export type BridgeResumeSessionActiveFlag =
  | "waitingOnApproval"
  | "waitingOnUserInput";

export type BridgeResumeSessionRuntimeStatus =
  | { type: "notLoaded" }
  | { type: "idle" }
  | { type: "systemError" }
  | {
      type: "active";
      activeFlags: BridgeResumeSessionActiveFlag[];
    };

export type BridgeResumeSessionCandidate = {
  sessionId: string;
  title: string;
  lastUpdatedAt: string;
  source?: string;
  threadId?: string;
  cwd?: string;
  projectId?: string;
  projectName?: string;
  projectOrder?: number;
  projectThreadOrder?: number;
  runtimeStatus?: BridgeResumeSessionRuntimeStatus;
};

export type BridgeResumeThreadCandidate = BridgeResumeSessionCandidate;

export type BridgeSessionSendResult = {
  turnId?: string;
  queued?: boolean;
  duplicate?: boolean;
  queuedMessageId?: string;
  queuePosition?: number;
};

export type BridgeSessionModelOption = {
  id: string;
  label?: string;
  description?: string;
  /** Provider/source group this model belongs to, rendered as a section heading. */
  group?: string;
  defaultReasoningEffort?: string;
  reasoningEffortOptions?: BridgeSessionReasoningEffortOption[];
};

export type BridgeSessionReasoningEffortOption = {
  id: string;
  label?: string;
  description?: string;
};

export type BridgeSessionModelState = {
  currentModel?: string;
  options: BridgeSessionModelOption[];
  canChange: boolean;
  unavailableReason?: string;
  currentReasoningEffort?: string;
  reasoningEffortOptions?: BridgeSessionReasoningEffortOption[];
  canChangeReasoningEffort?: boolean;
  reasoningEffortUnavailableReason?: string;
};

export type BridgeSessionPermissionOption = {
  id: string;
  label?: string;
  description?: string;
  /** High-risk choices such as unrestricted filesystem access need an explicit UI confirmation. */
  requiresConfirmation?: boolean;
};

export type BridgeSessionPermissionState = {
  currentPermission?: string;
  options: BridgeSessionPermissionOption[];
  canChange: boolean;
  unavailableReason?: string;
};

export type BridgeTurnInputItem =
  | { type: "text"; text: string }
  | { type: "localImage"; path: string }
  | { type: "image"; url: string };

export type BridgeQueuedTaskInput = {
  id: string;
  text: string;
  imageCount: number;
  createdAtMs?: number;
};

export type BridgeMessageImage =
  | {
      source: "local";
      path: string;
      alt?: string;
    }
  | {
      source: "remote";
      url: string;
      alt?: string;
    };

export type BridgeSessionMessage = {
  role: "user" | "assistant";
  text: string;
  id?: string;
  turnId?: string;
  phase?: "commentary" | "final_answer";
  createdAtMs?: number;
  model?: string;
  images?: BridgeMessageImage[];
};

export type BridgeSessionReadOptions = {
  /**
   * Use local persisted data plus already-cached live state only. This must not
   * subscribe to or load an entire remote conversation merely to answer a
   * mobile polling request.
   */
  lightweight?: boolean;
};

export type BridgeSessionMessagePageOptions = BridgeSessionReadOptions & {
  before?: string | null;
  limit?: number;
  /** Skip live state, progress, and approval enrichment for a fast history-first response. */
  historyOnly?: boolean;
};

export type BridgeSessionMessagePage = {
  messages: BridgeSessionMessage[];
  hasMore: boolean;
  nextBefore: string | null;
  source?: "native" | "openagentlog";
  caughtUp?: boolean;
};

export type BridgeSessionProgressItem = {
  id: string;
  turnId?: string;
  kind:
    | "reasoning"
    | "plan"
    | "command"
    | "file"
    | "image"
    | "web"
    | "tool";
  status: "running" | "completed" | "failed";
  text: string;
  createdAtMs?: number;
};

export type BridgeSessionRunSummary = {
  turnId?: string;
  status: "running" | "completed" | "interrupted" | "failed" | "unknown";
  startedAtMs?: number;
  completedAtMs?: number;
  durationMs?: number;
  errorMessage?: string;
};

export type BridgeState = {
  instanceId: string;
  adapter: BridgeAdapterKind;
  command: string;
  cwd: string;
  profile?: string;
  bridgeStartedAtMs: number;
  authorizedUserId: string;
  ignoredBacklogCount: number;
  sharedSessionId?: string;
  sharedThreadId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
  pendingConfirmation?: PendingApproval | null;
  pendingUserInput?: PendingUserInputRequest | null;
  lastActivityAt?: string;
};

export type BridgeAdapterState = {
  kind: BridgeAdapterKind;
  status: BridgeWorkerStatus;
  pid?: number;
  cwd: string;
  command: string;
  profile?: string;
  startedAt?: string;
  lastInputAt?: string;
  lastOutputAt?: string;
  pendingApproval?: ApprovalRequest | null;
  sharedSessionId?: string;
  sharedThreadId?: string;
  activeRuntimeSessionId?: string;
  resumeConversationId?: string;
  transcriptPath?: string;
  lastSessionSwitchAt?: string;
  lastSessionSwitchSource?: BridgeSessionSwitchSource;
  lastSessionSwitchReason?: BridgeSessionSwitchReason;
  lastThreadSwitchAt?: string;
  lastThreadSwitchSource?: BridgeThreadSwitchSource;
  lastThreadSwitchReason?: BridgeThreadSwitchReason;
  activeTurnId?: string;
  activeTurnOrigin?: BridgeTurnOrigin;
  pendingApprovalOrigin?: BridgeTurnOrigin;
  pendingUserInput?: UserInputRequest | null;
  pendingUserInputOrigin?: BridgeTurnOrigin;
};

export type BridgeEvent =
  | {
      type: "stdout";
      text: string;
      timestamp: string;
    }
  | {
      type: "stderr";
      text: string;
      timestamp: string;
    }
  | {
      type: "final_reply";
      text: string;
      timestamp: string;
      threadId?: string;
      turnId?: string;
      origin?: BridgeTurnOrigin;
    }
  | {
      type: "status";
      status: BridgeWorkerStatus;
      message?: string;
      timestamp: string;
    }
  | {
      type: "notice";
      text: string;
      level: BridgeNoticeLevel;
      timestamp: string;
    }
  | {
      type: "thinking";
      text: string;
      timestamp: string;
    }
  | {
      type: "approval_required";
      request: ApprovalRequest | PendingApproval;
      timestamp: string;
      threadId?: string;
      turnId?: string;
      origin?: BridgeTurnOrigin;
    }
  | {
      type: "user_input_required";
      request: UserInputRequest | PendingUserInputRequest;
      timestamp: string;
      threadId?: string;
      turnId?: string;
      origin?: BridgeTurnOrigin;
    }
  | {
      type: "mirrored_user_input";
      text: string;
      timestamp: string;
      origin: "local";
      threadId?: string;
      turnId?: string;
    }
  | {
      type: "session_switched";
      sessionId: string;
      source: BridgeSessionSwitchSource;
      reason: BridgeSessionSwitchReason;
      timestamp: string;
    }
  | {
      type: "thread_switched";
      threadId: string;
      source: BridgeThreadSwitchSource;
      reason: BridgeThreadSwitchReason;
      timestamp: string;
    }
  | {
      type: "task_complete";
      exitCode?: number;
      summary?: string;
      outcome?: BridgeTaskOutcome;
      timestamp: string;
      threadId?: string;
      turnId?: string;
      origin?: BridgeTurnOrigin;
    }
  | {
      type: "task_failed";
      message: string;
      timestamp: string;
      threadId?: string;
      turnId?: string;
      origin?: BridgeTurnOrigin;
    }
  | {
      type: "fatal_error";
      message: string;
      timestamp: string;
    }
  | {
      type: "shutdown_requested";
      reason: "companion_closed" | "companion_reconnect_timeout";
      message: string;
      exitCode?: number;
      timestamp: string;
    };

export interface BridgeAdapter {
  setEventSink(sink: (event: BridgeEvent) => void): void;
  start(): Promise<void>;
  sendInput(text: string): Promise<void>;
  sendInputToSession?(
    sessionId: string,
    text: string,
  ): Promise<BridgeSessionSendResult | void>;
  sendInputItemsToSession?(
    sessionId: string,
    items: BridgeTurnInputItem[],
  ): Promise<BridgeSessionSendResult | void>;
  listResumeSessions(limit?: number): Promise<BridgeResumeSessionCandidate[]>;
  resumeSession(sessionId: string): Promise<void>;
  renameSession?(sessionId: string, title: string): Promise<void>;
  followSession?(sessionId: string): Promise<void>;
  unfollowSession?(sessionId: string): Promise<void>;
  getLatestSessionMessage?(sessionId: string): Promise<BridgeSessionMessage | null>;
  getSessionMessages?(sessionId: string): Promise<BridgeSessionMessage[]>;
  /** Return a cheap opaque revision for persisted or already-cached live conversation changes. */
  getSessionContentRevision?(sessionId: string): string | null;
  /** Read local/native message metadata used to enrich accelerated history without replacing it. */
  getSessionMessageMedia?(
    sessionId: string,
    options?: BridgeSessionMessagePageOptions,
    targetMessages?: BridgeSessionMessage[],
  ): Promise<BridgeSessionMessage[]>;
  getSessionMessagePage?(
    sessionId: string,
    options?: BridgeSessionMessagePageOptions,
  ): Promise<BridgeSessionMessagePage>;
  getSessionProgress?(
    sessionId: string,
    options?: BridgeSessionReadOptions,
  ): Promise<BridgeSessionProgressItem[]>;
  getSessionRunSummary?(
    sessionId: string,
    options?: BridgeSessionReadOptions,
  ): Promise<BridgeSessionRunSummary | null>;
  getSessionModelState?(sessionId: string): Promise<BridgeSessionModelState>;
  setSessionModel?(
    sessionId: string,
    model: string,
  ): Promise<BridgeSessionModelState>;
  setSessionReasoningEffort?(
    sessionId: string,
    reasoningEffort: string,
  ): Promise<BridgeSessionModelState>;
  getSessionPermissionState?(sessionId: string): Promise<BridgeSessionPermissionState>;
  setSessionPermission?(
    sessionId: string,
    permission: string,
  ): Promise<BridgeSessionPermissionState>;
  getQueuedTaskInputs?(sessionId: string): BridgeQueuedTaskInput[];
  updateQueuedTaskInput?(
    sessionId: string,
    messageId: string,
    text: string,
  ): Promise<boolean>;
  deleteQueuedTaskInput?(
    sessionId: string,
    messageId: string,
  ): Promise<boolean>;
  steerQueuedTaskInput?(
    sessionId: string,
    messageId: string,
  ): Promise<boolean>;
  createSession?(): Promise<void>;
  createSessionInProject?(sourceSessionId: string): Promise<void>;
  interrupt(): Promise<boolean>;
  interruptSession?(sessionId: string): Promise<boolean>;
  reset(): Promise<void>;
  resolveApproval(action: "confirm" | "deny"): Promise<boolean>;
  resolveAllApprovals(action: "confirm" | "deny"): Promise<number>;
  resolveApprovalForSession?(): Promise<boolean>;
  resolveAllApprovalsForSession?(): Promise<number>;
  resolveApprovalRequest?(
    requestId: string,
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<boolean>;
  resolveTaskApprovals?(
    threadId: string,
    action: "confirm" | "confirm_session" | "deny",
  ): Promise<number>;
  getPendingTaskApprovals?(threadId: string): ApprovalRequest[];
  submitUserInput(answers: Record<string, string[]>): Promise<boolean>;
  submitTaskUserInput?(
    threadId: string,
    answers: Record<string, string[]>,
  ): Promise<boolean>;
  dispose(): Promise<void>;
  getState(): BridgeAdapterState;
}
