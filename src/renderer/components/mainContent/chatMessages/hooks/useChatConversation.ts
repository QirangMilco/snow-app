import { useCallback, useRef, useState } from "react";
import type { ChatInputSendOptions } from "../../chatInput/types";
import type { ApiConfigRecord } from "../../../../../preload";

import type {
  ConversationContextValue,
  FileChangeRecord,
  PauseController,
  UseChatConversationResult,
} from "../utils/conversationTypes";
import { PENDING_SESSION_KEY } from "../utils/conversationTypes";

import { useConversationSession } from "./useConversationSession";
import { useToolAuthorization } from "./useToolAuthorization";
import { useUserQuestion } from "./useUserQuestion";
import { useCompaction } from "./useCompaction";
import { useRollback } from "./useRollback";
import { useAgentLoop } from "./useAgentLoop";
import { useConversationManagement } from "./useConversationManagement";

export const useChatConversation = (
  directoryId?: string,
  directoryPath?: string
): UseChatConversationResult => {
  // --- State ---
  const [sessions, setSessions] = useState<
    Record<string, ConversationContextValue["sessions"][string]>
  >({});
  const [activeConversationId, setActiveConversationId] = useState<
    string | undefined
  >(undefined);
  const [conversationVersion, setConversationVersion] = useState(0);
  // 侧边栏列表刷新信号：与 conversationVersion 分离，AI 响应迭代只 bump
  // conversationVersion（UserMessageRail 用），列表仅靠增量 upsert 同步。
  const [conversationListVersion, setConversationListVersion] = useState(0);
  const [upsertedConversation, setUpsertedConversation] =
    useState<ConversationContextValue["upsertedConversation"]>(null);
  const [subAgentSessionEvents, setSubAgentSessionEvents] = useState<
    ConversationContextValue["subAgentSessionEvents"]
  >({});
  // Upsert a single sub-agent event keyed by its conversationId so multiple
  // parallel sub-agents each keep their own live entry.
  const setSubAgentSessionEvent = useCallback(
    (event: ConversationContextValue["subAgentSessionEvents"][string]) => {
      setSubAgentSessionEvents((prev) => ({
        ...prev,
        [event.conversationId]: event,
      }));
    },
    []
  );
  // File-change stats collected at tool-execution time, keyed by
  // conversationId. Sub-agent changes are stored under the sub-agent's own
  // conversationId; the parent merges them via childSubAgentIds for display.
  // When a conversation is opened (or re-opened after a restart), the stats
  // are re-hydrated from persisted history — see mergeFileChangeStats and
  // fileChangeStatsHydratedRef.
  const [fileChangeStats, setFileChangeStats] = useState<
    ConversationContextValue["fileChangeStats"]
  >({});
  // Conversation ids whose file-change stats are already fully accounted for:
  // either re-hydrated from persisted history, or recorded live by the tool
  // pipeline (recordFileChange marks the id, so live sessions never get
  // double-counted by a later history re-hydration).
  const fileChangeStatsHydratedRef = useRef<Set<string>>(new Set());
  const recordFileChange = useCallback(
    (
      conversationId: string,
      record: ConversationContextValue["fileChangeStats"][string][number]
    ) => {
      fileChangeStatsHydratedRef.current.add(conversationId);
      setFileChangeStats((prev) => ({
        ...prev,
        [conversationId]: [...(prev[conversationId] ?? []), record],
      }));
    },
    []
  );
  const mergeFileChangeStats = useCallback(
    (conversationId: string, records: FileChangeRecord[]): void => {
      if (records.length === 0) {
        return;
      }
      setFileChangeStats((prev) => {
        const existing = prev[conversationId] ?? [];
        const existingKeys = new Set(
          existing.map((record) =>
            `${record.filePath}\u0000${record.kind}\u0000${record.timestamp}\u0000${record.agent}`
          )
        );
        const fresh = records.filter(
          (record) =>
            !existingKeys.has(
              `${record.filePath}\u0000${record.kind}\u0000${record.timestamp}\u0000${record.agent}`
            )
        );
        if (fresh.length === 0) {
          return prev;
        }
        return {
          ...prev,
          [conversationId]: [...existing, ...fresh],
        };
      });
    },
    []
  );
  const [streamingConversationIds, setStreamingConversationIds] = useState<
    Set<string>
  >(new Set());
  const [completedConversationIds, setCompletedConversationIds] = useState<
    Set<string>
  >(new Set());
  const [isLoadingInitialHistory, setIsLoadingInitialHistory] = useState(false);
  const [draftToRestore, setDraftToRestore] = useState<string | null>(null);
  const [autoSendToken, setAutoSendToken] = useState(0);
  const [rollbackPreview, setRollbackPreview] =
    useState<ConversationContextValue["rollbackPreview"]>(null);
  const [newChatRequested, setNewChatRequested] = useState(false);
  const [yoloMode, setYoloModeState] = useState(false);
  const [isUpdatingYoloMode, setIsUpdatingYoloMode] = useState(false);
  const [planMode, setPlanModeState] = useState(false);
  const [isUpdatingPlanMode, setIsUpdatingPlanMode] = useState(false);
  const [goalMode, setGoalModeState] = useState(false);
  const [isUpdatingGoalMode, setIsUpdatingGoalMode] = useState(false);
  const [goalModeTokenBudget, setGoalModeTokenBudgetState] = useState(2000000);
  const [pendingToolAuthorizations, setPendingToolAuthorizations] = useState<
    ConversationContextValue["pendingToolAuthorizations"]
  >([]);
  const [activePendingMessages, setActivePendingMessages] = useState<string[]>(
    []
  );
  const [compactionPreview, setCompactionPreview] = useState("");
  const [compactionError, setCompactionError] = useState<string | null>(null);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactingConversationId, setCompactingConversationId] = useState<
    string | null
  >(null);

  // --- Refs ---
  const sessionsRefData = useRef<
    ConversationContextValue["sessionsRefData"]["current"]
  >(new Map());
  const activeConversationIdRef = useRef<string | undefined>(undefined);
  const selectionRequestIdRef = useRef(0);
  const historyLoadPromisesRef = useRef(new Map<string, Promise<void>>());
  const loadingOlderConversationIdsRef = useRef(new Set<string>());
  const sessionsRef = useRef<
    ConversationContextValue["sessionsRef"]["current"]
  >({});
  sessionsRef.current = sessions;
  const newChatRequestedRef = useRef(false);
  newChatRequestedRef.current = newChatRequested;

  const pendingQueueRef = useRef<
    ConversationContextValue["pendingQueueRef"]["current"]
  >(new Map());
  const handleSendMessageRef = useRef<
    (message: string, options: ChatInputSendOptions) => void
  >(() => {});
  const performCompactionRef = useRef<
    (
      conversationId: string,
      model?: string,
      isAuto?: boolean,
      subAgentConfigProfile?: string,
      apiProfile?: string
    ) => Promise<string | null>
  >(async () => null);
  const yoloModeRef = useRef(yoloMode);
  const planModeRef = useRef(planMode);
  const goalModeRef = useRef(goalMode);
  const alwaysApprovedToolsRef = useRef(new Set<string>());
  const pendingToolAuthorizationRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingToolAuthorizationRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >()
  );
  const pendingUserQuestionRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingUserQuestionRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >()
  );
  const pendingHookDecisionRef = useRef(
    new Map<
      string,
      ConversationContextValue["pendingHookDecisionRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >()
  );
  const userQuestionTargetRef = useRef(
    new Map<
      string,
      ConversationContextValue["userQuestionTargetRef"]["current"] extends Map<
        string,
        infer V
      >
        ? V
        : never
    >()
  );
  yoloModeRef.current = yoloMode;
  planModeRef.current = planMode;
  goalModeRef.current = goalMode;

  // --- Pause controller ---
  // Per-session pause flags. When paused, the agent loop awaits the
  // `resolve` callback before proceeding to the next iteration.
  const pauseControllerRef = useRef<Map<string, PauseController>>(new Map());

  // Per-conversation Plan Mode approval keys (see
  // ConversationContextValue.planApprovedSessionKeysRef). Owned here so every
  // mode-management hook can clear it when Plan Mode is genuinely turned off.
  const planApprovedSessionKeysRef = useRef<Set<string>>(new Set());

  // --- Active API config accessor ---
  // Fetches the active config fresh from storage on every call so that user
  // edits (e.g. the auto-compress threshold) take effect immediately at the
  // next auto-compaction decision point, without requiring an app restart.
  const getActiveApiConfig = useCallback(
    async (profileName?: string): Promise<ApiConfigRecord | null> => {
      try {
        const configs = await window.snow.listApiConfigs();
        const activeConfig =
          configs.find((c) => c.isActive) ?? configs[0] ?? null;
        if (profileName) {
          // Mirror Rust's get_api_request_context_for_profile: a named profile
          // wins, falling back to the active config when it is unavailable.
          return (
            configs.find((c) => c.profileName === profileName) ?? activeConfig
          );
        }
        return activeConfig;
      } catch {
        // Best effort -- auto-compaction simply won't trigger if config is unavailable.
        return null;
      }
    },
    []
  );

  // --- Build context object ---
  const ctx: ConversationContextValue = {
    directoryId,
    directoryPath,
    sessions,
    activeConversationId,
    conversationVersion,
    conversationListVersion,
    upsertedConversation,
    subAgentSessionEvents,
    fileChangeStats,
    recordFileChange,
    mergeFileChangeStats,
    fileChangeStatsHydratedRef,
    streamingConversationIds,
    completedConversationIds,
    isLoadingInitialHistory,
    draftToRestore,
    rollbackPreview,
    newChatRequested,
    yoloMode,
    isUpdatingYoloMode,
    planMode,
    isUpdatingPlanMode,
    goalMode,
    isUpdatingGoalMode,
    goalModeTokenBudget,
    pendingToolAuthorizations,
    activePendingMessages,
    compactionPreview,
    compactionError,
    isCompacting,
    compactingConversationId,

    sessionsRefData,
    activeConversationIdRef,
    selectionRequestIdRef,
    historyLoadPromisesRef,
    loadingOlderConversationIdsRef,
    sessionsRef,
    newChatRequestedRef,
    pendingQueueRef,
    handleSendMessageRef,
    performCompactionRef,
    yoloModeRef,
    planModeRef,
    goalModeRef,
    alwaysApprovedToolsRef,
    planApprovedSessionKeysRef,
    pendingToolAuthorizationRef,
    pendingUserQuestionRef,
    pendingHookDecisionRef,
    userQuestionTargetRef,
    getActiveApiConfig,
    pauseControllerRef,

    setSessions,
    setActiveConversationId,
    setConversationVersion,
    setConversationListVersion,
    setUpsertedConversation,
    setSubAgentSessionEvent,
    setStreamingConversationIds,
    setCompletedConversationIds,
    setIsLoadingInitialHistory,
    setDraftToRestore,
    setRollbackPreview,
    setNewChatRequested,
    setYoloModeState,
    setIsUpdatingYoloMode,
    setPlanModeState,
    setIsUpdatingPlanMode,
    setGoalModeState,
    setIsUpdatingGoalMode,
    setGoalModeTokenBudgetState,
    setPendingToolAuthorizations,
    setActivePendingMessages,
    setCompactionPreview,
    setCompactionError,
    setIsCompacting,
    setCompactingConversationId,

    // These will be filled in after sub-hooks are called
    setActiveId: () => {},
    ensureSession: () => {},
    updateSessionMessages: () => {},
    updateSessionField: () => {},
    migrateSession: () => {},
    addStreamingId: () => {},
    removeStreamingId: () => {},
    notifyAiComplete: () => {},
    notifySensitiveCommandIntercepted: () => {},
    notifyUserInteractionRequired: () => {},
  };

  // --- 1. Conversation session management ---
  const sessionApi = useConversationSession(ctx);
  ctx.setActiveId = sessionApi.setActiveId;
  ctx.ensureSession = sessionApi.ensureSession;
  ctx.updateSessionMessages = sessionApi.updateSessionMessages;
  ctx.updateSessionField = sessionApi.updateSessionField;
  ctx.migrateSession = sessionApi.migrateSession;
  ctx.addStreamingId = sessionApi.addStreamingId;
  ctx.removeStreamingId = sessionApi.removeStreamingId;
  ctx.notifyAiComplete = sessionApi.notifyAiComplete;
  ctx.notifySensitiveCommandIntercepted =
    sessionApi.notifySensitiveCommandIntercepted;
  ctx.notifyUserInteractionRequired = sessionApi.notifyUserInteractionRequired;

  // --- 2. Tool authorization ---
  const toolAuthApi = useToolAuthorization(ctx);

  // --- 3. User question ---
  const userQuestionApi = useUserQuestion(ctx);

  // --- 4. Compaction ---
  const compactionApi = useCompaction(ctx);
  performCompactionRef.current = compactionApi.performCompaction;

  // --- 5. Agent loop (handleSendMessage) ---
  const agentLoopApi = useAgentLoop({
    ctx,
    requestToolAuthorizations: toolAuthApi.requestToolAuthorizations,
    rejectToolAuthorizations: toolAuthApi.rejectToolAuthorizations,
    rejectPendingUserQuestions: userQuestionApi.rejectPendingUserQuestions,
  });

  // --- 6. Conversation management (select, new, abort, fork, etc.) ---
  const conversationManagementApi = useConversationManagement({
    ctx,
    rejectToolAuthorizations: toolAuthApi.rejectToolAuthorizations,
    rejectPendingUserQuestions: userQuestionApi.rejectPendingUserQuestions,
  });

  // --- 7. Rollback ---
  const rollbackApi = useRollback(ctx);

  // --- Compute active session ---
  // When the user explicitly requested a new chat (clicked "New chat" while
  // a session was still streaming), do NOT fall back to the pending session.
  // This keeps the empty greeting visible while the background AI loop
  // continues running and eventually migrates to a real conversation id.
  const activeKey =
    newChatRequested || activeConversationId
      ? activeConversationId
      : PENDING_SESSION_KEY;
  const activeSession = activeKey ? sessions[activeKey] : undefined;

  // --- Approve/reject tool authorization wrappers ---
  const approveToolAuthorization = useCallback(
    (toolCall: ConversationContextValue["pendingToolAuthorizations"][number]) =>
      toolAuthApi.settleToolAuthorization(toolCall, {
        status: "approved",
        sensitiveCommandConfirmed:
          (toolCall.sensitiveCommandMatches?.length ?? 0) > 0,
      }),
    [toolAuthApi]
  );

  const rejectToolAuthorization = useCallback(
    (
      toolCall: ConversationContextValue["pendingToolAuthorizations"][number],
      reason: string,
      userProvidedReason?: boolean
    ) =>
      toolAuthApi.settleToolAuthorization(toolCall, {
        status: "rejected",
        reason: reason.trim() || "User declined tool execution",
        ...(userProvidedReason ? { userProvidedReason: true } : {}),
      }),
    [toolAuthApi]
  );

  // --- Pause / Resume ---
  // handlePause marks the active session as paused. The agent loop checks
  // the pause controller at the start of each iteration and blocks on a
  // promise until handleResume is called or the loop is cancelled.
  const handlePause = useCallback((): void => {
    const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
    const ref = ctx.sessionsRefData.current.get(key);
    if (!ref?.isSending) {
      return;
    }
    let controller = ctx.pauseControllerRef.current.get(key);
    if (!controller) {
      controller = { paused: false, resolve: null };
      ctx.pauseControllerRef.current.set(key, controller);
    }
    if (controller.paused) {
      return;
    }
    controller.paused = true;
    ctx.updateSessionField(key, "isPaused", true);
  }, [ctx]);

  const handleResume = useCallback((): void => {
    const key = ctx.activeConversationIdRef.current ?? PENDING_SESSION_KEY;
    const controller = ctx.pauseControllerRef.current.get(key);
    if (!controller || !controller.paused) {
      return;
    }
    controller.paused = false;
    ctx.updateSessionField(key, "isPaused", false);
    const resolve = controller.resolve;
    controller.resolve = null;
    if (resolve) {
      resolve();
    }
  }, [ctx]);

  // 重命名会话后同步更新内存 session 的 summary，使 TopBar 标题即时刷新。
  // 会话尚未加载过（session 不存在）时 updateSessionField 安全地不执行任何操作。
  const updateConversationSummary = useCallback(
    (conversationId: string, summary: string): void => {
      ctx.updateSessionField(conversationId, "summary", summary);
    },
    [ctx]
  );

  return {
    messages: activeSession?.messages ?? [],
    summary: activeSession?.summary ?? "",
    conversationVersion,
    conversationListVersion,
    upsertedConversation,
    subAgentSessionEvents,
    fileChangeStats,
    recordFileChange,
    sessions,
    activeConversationId,
    conversationDirectoryId: activeSession?.directoryId,
    tokenUsage: activeSession?.tokenUsage ?? null,
    streamTokenCount: activeSession?.streamTokenCount ?? 0,
    streamElapsedMs: activeSession?.streamElapsedMs ?? 0,
    streamTtftMs: activeSession?.streamTtftMs ?? 0,
    streamStartedAt: activeSession?.streamStartedAt ?? 0,
    forkedFromConversationId: activeSession?.forkedFromConversationId,
    forkMessageCount: activeSession?.forkMessageCount,
    streamingConversationIds,
    completedConversationIds,
    isLoadingOlderMessages: activeSession?.isLoadingOlderMessages ?? false,
    hasMoreMessages: activeSession?.hasMoreMessages ?? false,
    isInitialHistoryLoaded: activeSession?.isInitialHistoryLoaded ?? false,
    isLoadingInitialHistory,
    loadOlderMessages: conversationManagementApi.loadOlderMessages,
    handleSendMessage: agentLoopApi.handleSendMessage,
    pendingMessages: activePendingMessages,
    withdrawPendingMessage: conversationManagementApi.withdrawPendingMessage,
    sendPendingMessageNow: conversationManagementApi.sendPendingMessageNow,
    compactConversation: compactionApi.compactConversation,
    compactionPreview,
    compactionError,
    isCompacting,
    compactingConversationId,
    handleSelectConversation:
      conversationManagementApi.handleSelectConversation,
    handleNewChat: conversationManagementApi.handleNewChat,
    refreshConversations: conversationManagementApi.refreshConversations,
    updateConversationSummary,
    isStreaming: activeSession?.isStreaming ?? false,
    isAborting: activeSession?.isAborting ?? false,
    isPaused: activeSession?.isPaused ?? false,
    handleAbort: conversationManagementApi.handleAbort,
    handlePause,
    handleResume,
    abortConversation: conversationManagementApi.abortConversation,
    handleForkConversation: conversationManagementApi.handleForkConversation,
    draftToRestore,
    autoSendToken,
    clearDraftToRestore: () => {
      rollbackApi.clearDraftToRestore();
      setAutoSendToken(0);
    },
    buildFromContent: (content: string) => {
      conversationManagementApi.handleNewChat();
      setDraftToRestore(content);
      setAutoSendToken(Date.now());
    },
    handleRollback: rollbackApi.handleRollback,
    rollbackPreview,
    confirmRollback: rollbackApi.confirmRollback,
    cancelRollback: rollbackApi.cancelRollback,
    yoloMode,
    isUpdatingYoloMode,
    setYoloMode: toolAuthApi.setYoloMode,
    refreshYoloMode: toolAuthApi.refreshYoloMode,
    planMode,
    isUpdatingPlanMode,
    setPlanMode: toolAuthApi.setPlanMode,
    refreshPlanMode: toolAuthApi.refreshPlanMode,
    goalMode,
    isUpdatingGoalMode,
    setGoalMode: toolAuthApi.setGoalMode,
    refreshGoalMode: toolAuthApi.refreshGoalMode,
    goalModeTokenBudget,
    setGoalModeTokenBudget: toolAuthApi.setGoalModeTokenBudget,
    refreshGoalModeTokenBudget: toolAuthApi.refreshGoalModeTokenBudget,
    pendingToolAuthorizations,
    approveToolAuthorization,
    approveToolAuthorizationAlways: toolAuthApi.approveToolAuthorizationAlways,
    rejectToolAuthorization,
    answerUserQuestion: userQuestionApi.answerUserQuestion,
    cancelUserQuestion: userQuestionApi.cancelUserQuestion,
  };
};
