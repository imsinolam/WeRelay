import type { BridgeAdapter, BridgeResumeSessionCandidate } from "../bridge/bridge-types.ts";
import type { RuntimeHost } from "./runtime-types.ts";

export class LegacyAdapterRuntime implements RuntimeHost {
  readonly runtimeKind = "legacy_adapter" as const;
  readonly sendInputToSession: BridgeAdapter["sendInputToSession"];
  readonly sendInputItemsToSession: BridgeAdapter["sendInputItemsToSession"];
  readonly createSessionInProject: BridgeAdapter["createSessionInProject"];
  readonly renameSession: BridgeAdapter["renameSession"];
  readonly followSession: BridgeAdapter["followSession"];
  readonly unfollowSession: BridgeAdapter["unfollowSession"];
  readonly getLatestSessionMessage: BridgeAdapter["getLatestSessionMessage"];
  readonly getSessionMessages: BridgeAdapter["getSessionMessages"];
  readonly getSessionMessageMedia: BridgeAdapter["getSessionMessageMedia"];
  readonly getSessionMessagePage: BridgeAdapter["getSessionMessagePage"];
  readonly getSessionProgress: BridgeAdapter["getSessionProgress"];
  readonly getSessionRunSummary: BridgeAdapter["getSessionRunSummary"];
  readonly getSessionModelState: BridgeAdapter["getSessionModelState"];
  readonly setSessionModel: BridgeAdapter["setSessionModel"];
  readonly setSessionReasoningEffort: BridgeAdapter["setSessionReasoningEffort"];
  readonly getSessionPermissionState: BridgeAdapter["getSessionPermissionState"];
  readonly setSessionPermission: BridgeAdapter["setSessionPermission"];
  readonly getQueuedTaskInputs: BridgeAdapter["getQueuedTaskInputs"];
  readonly updateQueuedTaskInput: BridgeAdapter["updateQueuedTaskInput"];
  readonly deleteQueuedTaskInput: BridgeAdapter["deleteQueuedTaskInput"];
  readonly steerQueuedTaskInput: BridgeAdapter["steerQueuedTaskInput"];
  readonly interruptSession: BridgeAdapter["interruptSession"];
  readonly resolveApprovalRequest: BridgeAdapter["resolveApprovalRequest"];
  readonly resolveTaskApprovals: BridgeAdapter["resolveTaskApprovals"];
  readonly getPendingTaskApprovals: BridgeAdapter["getPendingTaskApprovals"];
  readonly submitTaskUserInput: BridgeAdapter["submitTaskUserInput"];
  private readonly adapter: BridgeAdapter;

  constructor(adapter: BridgeAdapter) {
    this.adapter = adapter;
    this.sendInputToSession = adapter.sendInputToSession?.bind(adapter);
    this.sendInputItemsToSession = adapter.sendInputItemsToSession?.bind(adapter);
    this.createSessionInProject = adapter.createSessionInProject?.bind(adapter);
    this.renameSession = adapter.renameSession?.bind(adapter);
    this.followSession = adapter.followSession?.bind(adapter);
    this.unfollowSession = adapter.unfollowSession?.bind(adapter);
    this.getLatestSessionMessage = adapter.getLatestSessionMessage?.bind(adapter);
    this.getSessionMessages = adapter.getSessionMessages?.bind(adapter);
    this.getSessionMessageMedia = adapter.getSessionMessageMedia?.bind(adapter);
    this.getSessionMessagePage = adapter.getSessionMessagePage?.bind(adapter);
    this.getSessionProgress = adapter.getSessionProgress?.bind(adapter);
    this.getSessionRunSummary = adapter.getSessionRunSummary?.bind(adapter);
    this.getSessionModelState = adapter.getSessionModelState?.bind(adapter);
    this.setSessionModel = adapter.setSessionModel?.bind(adapter);
    this.setSessionReasoningEffort = adapter.setSessionReasoningEffort?.bind(adapter);
    this.getSessionPermissionState = adapter.getSessionPermissionState?.bind(adapter);
    this.setSessionPermission = adapter.setSessionPermission?.bind(adapter);
    this.getQueuedTaskInputs = adapter.getQueuedTaskInputs?.bind(adapter);
    this.updateQueuedTaskInput = adapter.updateQueuedTaskInput?.bind(adapter);
    this.deleteQueuedTaskInput = adapter.deleteQueuedTaskInput?.bind(adapter);
    this.steerQueuedTaskInput = adapter.steerQueuedTaskInput?.bind(adapter);
    this.interruptSession = adapter.interruptSession?.bind(adapter);
    this.resolveApprovalRequest = adapter.resolveApprovalRequest?.bind(adapter);
    this.resolveTaskApprovals = adapter.resolveTaskApprovals?.bind(adapter);
    this.getPendingTaskApprovals = adapter.getPendingTaskApprovals?.bind(adapter);
    this.submitTaskUserInput = adapter.submitTaskUserInput?.bind(adapter);
  }

  setEventSink(sink: Parameters<BridgeAdapter["setEventSink"]>[0]): void {
    this.adapter.setEventSink(sink);
  }

  async start(): Promise<void> {
    await this.adapter.start();
  }

  async sendInput(text: string): Promise<void> {
    await this.adapter.sendInput(text);
  }

  async listResumeSessions(limit?: number): Promise<BridgeResumeSessionCandidate[]> {
    return await this.adapter.listResumeSessions(limit);
  }

  async resumeSession(sessionId: string): Promise<void> {
    await this.adapter.resumeSession(sessionId);
  }

  async createSession(): Promise<void> {
    if (!this.adapter.createSession) {
      throw new Error(`/${this.adapter.getState().kind} does not support creating sessions from WeChat.`);
    }
    await this.adapter.createSession();
  }

  async interrupt(): Promise<boolean> {
    return await this.adapter.interrupt();
  }

  async reset(): Promise<void> {
    await this.adapter.reset();
  }

  async resolveApproval(action: "confirm" | "deny"): Promise<boolean> {
    return await this.adapter.resolveApproval(action);
  }

  async resolveAllApprovals(action: "confirm" | "deny"): Promise<number> {
    return await this.adapter.resolveAllApprovals(action);
  }

  async resolveApprovalForSession(): Promise<boolean> {
    return await (this.adapter.resolveApprovalForSession?.() ?? Promise.resolve(false));
  }

  async resolveAllApprovalsForSession(): Promise<number> {
    return await (
      this.adapter.resolveAllApprovalsForSession?.() ?? Promise.resolve(0)
    );
  }

  async submitUserInput(answers: Record<string, string[]>): Promise<boolean> {
    return await this.adapter.submitUserInput(answers);
  }

  async dispose(): Promise<void> {
    await this.adapter.dispose();
  }

  getState() {
    return this.adapter.getState();
  }
}
