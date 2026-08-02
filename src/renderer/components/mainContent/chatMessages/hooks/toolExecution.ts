import {
  directoryIdToPath,
  formatMcpToolResultForModel,
  getErrorMessage,
  isUserQuestionCancellationResult,
  updateFirstMatchingToolCall,
  validateToolCall,
} from "../utils/conversationHelpers";
import {
  PLAN_APPROVAL_TOOL_NAME,
  isStructuredPlanApproval,
} from "./agentLoopHelpers";
import { appendHookExecutionToMessage, runHook } from "./hookOutcome";
import { extractFileChangeFromTool } from "./fileChangeTracking";
import { PENDING_SESSION_KEY } from "../utils/conversationTypes";
import type {
  ConversationContextValue,
  HookExecutionRecord,
  ToolAuthorizationDecision,
  ToolCallInfo,
} from "../utils/conversationTypes";

export type ToolExecutionResult = {
  structuredToolResults: { name: string; callId: string; result: string }[];
  hookAborted: boolean;
  hookAbortMessage: string;
  userQuestionCancelled: boolean;
  pendingHookWarnings: string[];
};

export type ToolExecutorDeps = {
  ctx: ConversationContextValue;
  effectiveKey: string;
  currentAssistantMessageId: string;
  sessionDirId: string | undefined;
  directoryPath: string | undefined;
  responseId: string | undefined;
  isRunCancelled: (key: string) => boolean;
  awaitHookDecision: (
    key: string,
    messageId: string,
    record: HookExecutionRecord
  ) => Promise<boolean>;
  executeSubAgentActivation: (
    argsJson: string,
    parentConversationId: string,
    dirId: string,
    toolCallInteractionId?: string
  ) => Promise<string>;
  planApprovedSessionKeysRef: { current: Set<string> };
  planModeRef: { current: boolean };
};

export function createToolExecutor(
  deps: ToolExecutorDeps
): (
  toolCalls: ToolCallInfo[],
  authorizationDecisions: ToolAuthorizationDecision[]
) => Promise<ToolExecutionResult | null> {
  const {
    ctx,
    effectiveKey,
    currentAssistantMessageId,
    sessionDirId,
    directoryPath,
    responseId,
    isRunCancelled,
    awaitHookDecision,
    executeSubAgentActivation,
    planApprovedSessionKeysRef,
    planModeRef,
  } = deps;

  // 工具 cwd / checkpoint 目录跟随会话自己的目录,而非运行时全局
  // activeDirectory:切换项目后旧会话仍在自己的目录执行,checkpoint
  // 与 cwd 天然一致,不会被后端以目录不匹配拦截。
  const sessionDirPath = directoryIdToPath(sessionDirId) ?? directoryPath;

  return async (
    toolCalls: ToolCallInfo[],
    authorizationDecisions: ToolAuthorizationDecision[]
  ): Promise<ToolExecutionResult | null> => {
    const structuredToolResults: {
      name: string;
      callId: string;
      result: string;
    }[] = [];
    let userQuestionCancelled = false;
    let hookAborted = false;
    let hookAbortMessage = "";
    const pendingHookWarnings: string[] = [];

    // When the model requests multiple sub-agent activations in a single
    // tool batch they must run concurrently, not queued one after another.
    // Pre-start every approved sub-agent activation up front and store the
    // pending promises keyed by tool index; the main loop below simply awaits
    // the already-running promise when it reaches each sub-agent tool call.
    const preStartedSubAgents = new Map<number, Promise<string>>();
    if (effectiveKey !== PENDING_SESSION_KEY) {
      const subAgentIndices: number[] = [];
      for (let i = 0; i < toolCalls.length; i++) {
        if (
          toolCalls[i].name === "sub-agents-activate" &&
          authorizationDecisions[i].status !== "rejected" &&
          !validateToolCall(toolCalls[i])
        ) {
          subAgentIndices.push(i);
        }
      }

      if (subAgentIndices.length > 1) {
        for (const idx of subAgentIndices) {
          const parallelToolCall = toolCalls[idx];

          // Mark running immediately so each sub-agent card shows live
          // progress while the others are still working.
          ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
            currentMessages.map((currentMessage) => {
              if (currentMessage.id !== currentAssistantMessageId) {
                return currentMessage;
              }
              return {
                ...currentMessage,
                toolCalls: updateFirstMatchingToolCall(
                  currentMessage.toolCalls,
                  parallelToolCall,
                  "pending",
                  (currentToolCall) => ({
                    ...currentToolCall,
                    status: "running" as const,
                    startedAt: Date.now(),
                  })
                ),
              };
            })
          );

          // Fire without awaiting. beforeToolCall hooks are intentionally
          // skipped for parallel sub-agents — the activation runs its own
          // beforeSubAgentStart / onSubAgentComplete lifecycle hooks.
          //
          // The wrapper flips the tool call to "completed" the instant this
          // sub-agent settles, so a fast sub-agent stops showing a spinner in
          // its header even while the sequential loop below is still awaiting
          // an earlier, slower one.
          preStartedSubAgents.set(
            idx,
            (async () => {
              let parallelResult: string;
              try {
                parallelResult = await executeSubAgentActivation(
                  parallelToolCall.arguments,
                  effectiveKey,
                  sessionDirId ?? ctx.directoryId ?? "",
                  parallelToolCall.interactionId
                );
              } catch (err) {
                parallelResult = JSON.stringify({
                  error: getErrorMessage(err),
                });
              }

              ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                currentMessages.map((currentMessage) => {
                  if (currentMessage.id !== currentAssistantMessageId) {
                    return currentMessage;
                  }
                  return {
                    ...currentMessage,
                    toolCalls: updateFirstMatchingToolCall(
                      currentMessage.toolCalls,
                      parallelToolCall,
                      ["pending", "running"],
                      (currentToolCall) => ({
                        ...currentToolCall,
                        status: "completed" as const,
                        result: parallelResult,
                      })
                    ),
                  };
                })
              );

              return parallelResult;
            })()
          );
        }
      }
    }

    for (let toolIndex = 0; toolIndex < toolCalls.length; toolIndex++) {
      const toolCall = toolCalls[toolIndex];
      if (isRunCancelled(effectiveKey)) {
        return null;
      }

      if (userQuestionCancelled) {
        const skippedResult = JSON.stringify({
          cancelled: true,
          skipped: true,
          reason: "Skipped because the user cancelled the question",
        });
        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }

            return {
              ...currentMessage,
              toolCalls: updateFirstMatchingToolCall(
                currentMessage.toolCalls,
                toolCall,
                ["pending", "running"],
                (currentToolCall) => ({
                  ...currentToolCall,
                  status: "completed" as const,
                  result: skippedResult,
                })
              ),
            };
          })
        );
        structuredToolResults.push({
          name: toolCall.name,
          callId: toolCall.callId || "",
          result: skippedResult,
        });
        continue;
      }

      // A sub-agent that was pre-started for parallel execution. Its wrapper
      // already flipped the tool-call status to "completed" the moment it
      // settled (so the header does not keep spinning while the loop waits on
      // a slower sibling); here we only collect its result for the model. The
      // normal sequential path (hooks, validation, callMcpTool) is bypassed.
      if (preStartedSubAgents.has(toolIndex)) {
        const parallelResult = await preStartedSubAgents.get(toolIndex)!;

        structuredToolResults.push({
          name: toolCall.name,
          callId: toolCall.callId || "",
          result: formatMcpToolResultForModel(parallelResult),
        });

        if (isRunCancelled(effectiveKey)) {
          return null;
        }
        continue;
      }

      let result: string | undefined;
      const authorizationDecision = authorizationDecisions[toolIndex];

      if (authorizationDecision.status === "rejected") {
        const rejectionReason =
          authorizationDecision.reason || "User declined tool execution";
        result = JSON.stringify({
          success: false,
          error: "TOOL_EXECUTION_DENIED_BY_USER",
          message: `Tool execution rejected by user. Reason: ${rejectionReason}`,
          reason: rejectionReason,
          toolName: toolCall.name,
        });

        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }

            return {
              ...currentMessage,
              toolCalls: updateFirstMatchingToolCall(
                currentMessage.toolCalls,
                toolCall,
                ["pending", "running"],
                (currentToolCall) => ({
                  ...currentToolCall,
                  status: "error" as const,
                  result,
                })
              ),
            };
          })
        );
      } else {
        const validationError = validateToolCall(toolCall);
        const isValidationError = !!validationError;
        if (validationError) {
          result = validationError;
        } else {
          try {
            const checkpointIds =
              ctx.sessionsRefData.current.get(effectiveKey)?.checkpointIds ??
              [];

            // Force-override sessionId for todo-manage. Only add actions
            // receive responseId, because rollback tracking applies solely
            // to TODO items created by that action.
            let toolArgs = toolCall.arguments;
            if (
              toolCall.name === "todo-todo-manage" &&
              effectiveKey !== PENDING_SESSION_KEY
            ) {
              try {
                const parsedArgs = JSON.parse(toolArgs) as Record<
                  string,
                  unknown
                >;
                parsedArgs.sessionId = effectiveKey;
                if (parsedArgs.action === "add" && responseId) {
                  parsedArgs.responseId = responseId;
                }
                toolArgs = JSON.stringify(parsedArgs);
              } catch {
                // If args are not valid JSON, let the tool fail naturally.
              }
            }

            // Inject the current session id for bash-terminal-execute so child
            // processes receive SNOW_SESSION_ID / TRELLIS_CONTEXT_ID — the
            // Snow platform contract Trellis scripts rely on to track the
            // active task per session.
            if (toolCall.name === "bash-terminal-execute") {
              try {
                const parsedArgs = JSON.parse(toolArgs) as Record<
                  string,
                  unknown
                >;
                parsedArgs.sessionId = effectiveKey;
                toolArgs = JSON.stringify(parsedArgs);
              } catch {
                // If args are not valid JSON, let the tool fail naturally.
              }
            }

            let sensitiveAuthorizationToken: string | undefined;
            if (
              toolCall.name === "bash-terminal-execute" &&
              authorizationDecision.status === "approved" &&
              authorizationDecision.sensitiveCommandConfirmed === true
            ) {
              const parsedArgs = JSON.parse(toolArgs) as Record<
                string,
                unknown
              >;
              if (typeof parsedArgs.command !== "string") {
                throw new Error("Sensitive command argument is missing");
              }
              sensitiveAuthorizationToken =
                await window.snow.issueSensitiveCommandAuthorization(
                  parsedArgs.command
                );
            }

            const isInteractiveQuestionTool =
              toolCall.name === "user-interaction-askUserQuestion" ||
              toolCall.name === PLAN_APPROVAL_TOOL_NAME;
            if (isInteractiveQuestionTool) {
              ctx.userQuestionTargetRef.current.set(toolCall.interactionId, {
                sessionKey: effectiveKey,
                assistantMessageId: currentAssistantMessageId,
              });
            }

            try {
              // Execute beforeToolCall hooks (with matcher) before calling the tool.
              // This gate runs after authorization but before every actual tool call,
              // including YOLO auto-approved tools and sub-agent activation.
              // Unified exit-code semantics:
              //   0 = pass (stdout may auto-respond to interactive tools)
              //   1 = warn or decision gate
              //   2+ = abort (AI loop fully interrupted)
              try {
                const beforeHookContext = JSON.stringify({
                  toolName: toolCall.name,
                  args: JSON.parse(toolArgs),
                  cwd: sessionDirPath ?? "",
                });
                const beforeHookResult = await runHook(
                  "beforeToolCall",
                  sessionDirId ?? undefined,
                  beforeHookContext
                );
                if (beforeHookResult) {
                  const { outcome } = beforeHookResult;
                  if (outcome.kind === "needsDecision") {
                    const approved = await awaitHookDecision(
                      effectiveKey,
                      currentAssistantMessageId,
                      beforeHookResult.record
                    );
                    if (isRunCancelled(effectiveKey)) {
                      return null;
                    }
                    if (!approved) {
                      hookAborted = true;
                      hookAbortMessage = outcome.message;
                    }
                  } else {
                    ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                      appendHookExecutionToMessage(
                        currentMessages,
                        beforeHookResult.record,
                        currentAssistantMessageId
                      )
                    );
                  }

                  if (outcome.kind === "abort") {
                    hookAborted = true;
                    hookAbortMessage = outcome.message;
                  }

                  // Interactive tools (askUserQuestion / plan approval) can be
                  // auto-answered by the hook's stdout when the hook passes,
                  // bypassing the blocking user-interaction round-trip.
                  if (
                    outcome.kind === "pass" &&
                    outcome.output &&
                    isInteractiveQuestionTool
                  ) {
                    result = outcome.output;
                  }

                  if (outcome.kind === "warn") {
                    pendingHookWarnings.push(outcome.message);
                  }
                }
              } catch {
                // Hook execution failed — continue with tool call
              }

              if (hookAborted) {
                const decisionAbortResult = JSON.stringify({
                  success: false,
                  error: "HOOK_DECISION_REJECTED",
                  message: hookAbortMessage,
                });
                ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                  currentMessages.map((currentMessage) =>
                    currentMessage.id === currentAssistantMessageId
                      ? {
                          ...currentMessage,
                          toolCalls: updateFirstMatchingToolCall(
                            currentMessage.toolCalls,
                            toolCall,
                            ["pending", "running"],
                            (currentToolCall) => ({
                              ...currentToolCall,
                              status: "error" as const,
                              result: decisionAbortResult,
                            })
                          ),
                        }
                      : currentMessage
                  )
                );
                break;
              }

              ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                currentMessages.map((currentMessage) => {
                  if (currentMessage.id !== currentAssistantMessageId) {
                    return currentMessage;
                  }

                  return {
                    ...currentMessage,
                    toolCalls: updateFirstMatchingToolCall(
                      currentMessage.toolCalls,
                      toolCall,
                      "pending",
                      (currentToolCall) => ({
                        ...currentToolCall,
                        status: "running" as const,
                        startedAt: Date.now(),
                      })
                    ),
                  };
                })
              );

              if (
                toolCall.name === "sub-agents-activate" &&
                effectiveKey !== PENDING_SESSION_KEY
              ) {
                result = await executeSubAgentActivation(
                  toolArgs,
                  effectiveKey,
                  sessionDirId ?? ctx.directoryId ?? "",
                  toolCall.interactionId
                );
              } else if (result === undefined) {
                result = await window.snow.callMcpTool(
                  toolCall.name,
                  toolArgs,
                  sessionDirId,
                  checkpointIds,
                  checkpointIds.length > 0 ? sessionDirPath : undefined,
                  sensitiveAuthorizationToken,
                  (chunk) => {
                    if (!chunk.data) {
                      return;
                    }
                    if (
                      chunk.stream === "interactive_session" ||
                      chunk.stream === "tool_execution"
                    ) {
                      ctx.updateSessionMessages(
                        effectiveKey,
                        (currentMessages) =>
                          currentMessages.map((currentMessage) => {
                            if (
                              currentMessage.id !== currentAssistantMessageId
                            ) {
                              return currentMessage;
                            }

                            return {
                              ...currentMessage,
                              toolCalls: updateFirstMatchingToolCall(
                                currentMessage.toolCalls,
                                toolCall,
                                ["pending", "running"],
                                (currentToolCall) => ({
                                  ...currentToolCall,
                                  interactiveSessionId:
                                    chunk.stream === "interactive_session"
                                      ? chunk.data
                                      : currentToolCall.interactiveSessionId,
                                  toolExecutionId:
                                    chunk.stream === "tool_execution"
                                      ? chunk.data
                                      : currentToolCall.toolExecutionId,
                                })
                              ),
                            };
                          })
                      );
                      return;
                    }

                    ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                      currentMessages.map((currentMessage) => {
                        if (currentMessage.id !== currentAssistantMessageId) {
                          return currentMessage;
                        }

                        return {
                          ...currentMessage,
                          toolCalls: updateFirstMatchingToolCall(
                            currentMessage.toolCalls,
                            toolCall,
                            ["pending", "running"],
                            (currentToolCall) => ({
                              ...currentToolCall,
                              streamingStdout:
                                chunk.stream === "stdout"
                                  ? `${currentToolCall.streamingStdout ?? ""}${
                                      chunk.data
                                    }`
                                  : currentToolCall.streamingStdout,
                              streamingStderr:
                                chunk.stream === "stderr"
                                  ? `${currentToolCall.streamingStderr ?? ""}${
                                      chunk.data
                                    }`
                                  : currentToolCall.streamingStderr,
                            })
                          ),
                        };
                      })
                    );
                  },
                  toolCall.interactionId,
                  undefined,
                  planModeRef.current,
                  planApprovedSessionKeysRef.current.has(effectiveKey)
                );

                // Record successful file modifications (filesystem-create /
                // filesystem-replace_edit) into the conversation's file-change
                // stats. Done right after the tool returns — before
                // afterToolCall hooks may append context to the result — so
                // the success JSON is always parseable. The pending session
                // has no persisted conversation, so its changes are skipped;
                // they land in the real session once it is created.
                if (
                  effectiveKey !== PENDING_SESSION_KEY &&
                  result !== undefined
                ) {
                  const fileChange = extractFileChangeFromTool(
                    toolCall.name,
                    toolCall.arguments,
                    result
                  );
                  if (fileChange) {
                    ctx.recordFileChange(effectiveKey, {
                      ...fileChange,
                      agent: "main",
                      timestamp: Date.now(),
                    });
                  }
                }
              }

              // Execute afterToolCall hooks (with matcher) after the tool call completes.
              // Unified exit-code semantics:
              //   0 = pass (stdout context appended to the tool result)
              //   1 = warn or decision gate
              //   2+ = abort (AI loop fully interrupted)
              if (result !== undefined) {
                try {
                  const afterHookContext = JSON.stringify({
                    toolName: toolCall.name,
                    args: JSON.parse(toolArgs),
                    result: JSON.parse(result),
                    cwd: sessionDirPath ?? "",
                  });
                  const afterHookResult = await runHook(
                    "afterToolCall",
                    sessionDirId ?? undefined,
                    afterHookContext
                  );
                  if (!afterHookResult) {
                    throw new Error("HOOK_NOT_CONFIGURED");
                  }
                  const { outcome } = afterHookResult;

                  // needsDecision pauses the AI loop until the user acts.
                  // awaitHookDecision appends the record together with its
                  // runtime resolver; non-decision outcomes are appended
                  // directly below.
                  if (outcome.kind === "needsDecision") {
                    const approved = await awaitHookDecision(
                      effectiveKey,
                      currentAssistantMessageId,
                      afterHookResult.record
                    );
                    if (isRunCancelled(effectiveKey)) {
                      return null;
                    }
                    if (!approved) {
                      hookAborted = true;
                      hookAbortMessage = outcome.message;
                      break;
                    }
                  } else {
                    ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
                      appendHookExecutionToMessage(
                        currentMessages,
                        afterHookResult.record,
                        currentAssistantMessageId
                      )
                    );
                  }

                  if (outcome.kind === "abort") {
                    hookAborted = true;
                    hookAbortMessage = outcome.message;
                    break;
                  }

                  if (outcome.kind === "warn") {
                    pendingHookWarnings.push(outcome.message);
                  } else if (outcome.kind === "pass" && outcome.context) {
                    result = `${result}\n\n[Hook Context]\n${outcome.context}`;
                  }
                } catch {
                  // Hook execution failed — keep original result
                }
              }
            } finally {
              if (isInteractiveQuestionTool) {
                ctx.userQuestionTargetRef.current.delete(
                  toolCall.interactionId
                );
              }
            }
          } catch (err) {
            const errorMessage = getErrorMessage(err);
            // For streaming tools (e.g. terminal-execute) the process
            // may have produced partial output before failing/timing
            // out. Recover that output from the session state so the
            // AI receives it together with the error and can reason
            // about the situation instead of the loop stalling.
            if (toolCall.name === "bash-terminal-execute") {
              const sessionMessages =
                ctx.sessionsRef.current?.[effectiveKey]?.messages ?? [];
              const assistantMessage = sessionMessages.find(
                (m) => m.id === currentAssistantMessageId
              );
              const liveToolCall = assistantMessage?.toolCalls?.find(
                (tc) =>
                  tc.interactionId === toolCall.interactionId &&
                  tc.name === toolCall.name
              );
              const partialStdout = liveToolCall?.streamingStdout ?? "";
              const partialStderr = liveToolCall?.streamingStderr ?? "";
              const partialOutput = [partialStdout, partialStderr]
                .filter(Boolean)
                .join("\n");
              result = JSON.stringify({
                error: errorMessage,
                stdout: partialStdout,
                stderr: partialStderr,
                partialOutput:
                  partialOutput.length > 0 ? partialOutput : undefined,
              });
            } else {
              result = JSON.stringify({ error: errorMessage });
            }
          }
        }

        ctx.updateSessionMessages(effectiveKey, (currentMessages) =>
          currentMessages.map((currentMessage) => {
            if (currentMessage.id !== currentAssistantMessageId) {
              return currentMessage;
            }

            return {
              ...currentMessage,
              toolCalls: updateFirstMatchingToolCall(
                currentMessage.toolCalls,
                toolCall,
                ["pending", "running"],
                (currentToolCall) => ({
                  ...currentToolCall,
                  status: isValidationError
                    ? ("error" as const)
                    : ("completed" as const),
                  result,
                })
              ),
            };
          })
        );
      }

      if (
        toolCall.name === "user-interaction-askUserQuestion" &&
        isUserQuestionCancellationResult(result!)
      ) {
        userQuestionCancelled = true;
      }

      // Only the dedicated Plan Mode tool's structured approved=true result
      // can unlock Rust filesystem writes for this conversation's task.
      if (
        planModeRef.current &&
        !planApprovedSessionKeysRef.current.has(effectiveKey) &&
        isStructuredPlanApproval(toolCall.name, result!)
      ) {
        planApprovedSessionKeysRef.current.add(effectiveKey);
      }

      const modelToolResult = formatMcpToolResultForModel(result!);
      structuredToolResults.push({
        name: toolCall.name,
        callId: toolCall.callId || "",
        result: modelToolResult,
      });

      if (isRunCancelled(effectiveKey)) {
        return null;
      }
    }

    return {
      structuredToolResults,
      hookAborted,
      hookAbortMessage,
      userQuestionCancelled,
      pendingHookWarnings,
    };
  };
}
