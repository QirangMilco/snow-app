import { useCallback, useEffect } from "react";
import type {
  ConversationContextValue,
  ToolCallInfo,
  ToolAuthorizationDecision,
} from "../utils/conversationTypes";
import {
  appendHookExecutionToMessage,
  runHook,
} from "./hookOutcome";
import { directoryIdToPath } from "../utils/conversationHelpers";

/**
 * 工具授权逻辑：YOLO 模式、敏感命令检查、批量授权闸门等。
 * 同轮工具调用分别显示为对话内卡片，所有授权完成前不执行。
 */
export const useToolAuthorization = (ctx: ConversationContextValue) => {
  // 保持 ref 与 state 同步
  ctx.yoloModeRef.current = ctx.yoloMode;
  ctx.planModeRef.current = ctx.planMode;
  ctx.goalModeRef.current = ctx.goalMode;

  const approveAllPendingToolAuthorizations = useCallback((): void => {
    const pendingEntries = ctx.pendingToolAuthorizationRef.current;
    if (pendingEntries.size === 0) {
      return;
    }

    const approvedAuthorizationIds: string[] = [];
    pendingEntries.forEach((entry, authorizationId) => {
      if ((entry.toolCall.sensitiveCommandMatches?.length ?? 0) > 0) {
        return;
      }

      entry.resolve({ status: "approved" });
      approvedAuthorizationIds.push(authorizationId);
    });
    approvedAuthorizationIds.forEach((authorizationId) =>
      pendingEntries.delete(authorizationId)
    );
    ctx.setPendingToolAuthorizations((current) =>
      current.filter(
        (toolCall) =>
          !toolCall.authorizationId ||
          !approvedAuthorizationIds.includes(toolCall.authorizationId)
      )
    );
  }, [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]);

  const applyYoloMode = useCallback(
    (enabled: boolean): void => {
      ctx.yoloModeRef.current = enabled;
      ctx.setYoloModeState(enabled);
      if (enabled) {
        approveAllPendingToolAuthorizations();
      }
    },
    [ctx.yoloModeRef, ctx.setYoloModeState, approveAllPendingToolAuthorizations]
  );

  const refreshYoloMode = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getYoloMode();
      applyYoloMode(enabled);
      return enabled;
    } catch {
      applyYoloMode(false);
      return false;
    }
  }, [applyYoloMode]);

  const applyPlanMode = useCallback(
    (enabled: boolean): void => {
      ctx.planModeRef.current = enabled;
      ctx.setPlanModeState(enabled);
      if (!enabled) {
        // Plan Mode off = every approval is invalidated (user toggle, Goal
        // Mode mutual exclusion, or external sync). Switching conversations
        // restores the target session's mode without going through
        // applyPlanMode, so it never clears approvals here — an approved plan
        // survives navigating away and back.
        ctx.planApprovedSessionKeysRef.current.clear();
      }
    },
    [ctx.planModeRef, ctx.setPlanModeState, ctx.planApprovedSessionKeysRef]
  );

  const refreshPlanMode = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getPlanMode();
      applyPlanMode(enabled);
      return enabled;
    } catch {
      applyPlanMode(false);
      return false;
    }
  }, [applyPlanMode]);

  const applyGoalMode = useCallback(
    (enabled: boolean): void => {
      ctx.goalModeRef.current = enabled;
      ctx.setGoalModeState(enabled);
    },
    [ctx.goalModeRef, ctx.setGoalModeState]
  );

  const refreshGoalMode = useCallback(async (): Promise<boolean> => {
    try {
      const enabled = await window.snow.getGoalMode();
      applyGoalMode(enabled);
      return enabled;
    } catch {
      applyGoalMode(false);
      return false;
    }
  }, [applyGoalMode]);

  const applyGoalModeTokenBudget = useCallback(
    (budget: number): void => {
      ctx.setGoalModeTokenBudgetState(budget);
    },
    [ctx.setGoalModeTokenBudgetState]
  );

  const refreshGoalModeTokenBudget = useCallback(async (): Promise<void> => {
    try {
      const budget = await window.snow.getGoalModeTokenBudget();
      applyGoalModeTokenBudget(budget);
    } catch {
      applyGoalModeTokenBudget(2000000);
    }
  }, [applyGoalModeTokenBudget]);

  const setGoalModeTokenBudget = useCallback(
    async (budget: number): Promise<void> => {
      try {
        await window.snow.setGoalModeTokenBudget(budget);
        applyGoalModeTokenBudget(budget);
      } catch {
        // persist failure - keep current state
      }
    },
    [applyGoalModeTokenBudget]
  );

  // 初始化：读取磁盘 YOLO 设置和永久授权工具列表
  useEffect(() => {
    let disposed = false;

    void window.snow
      .getYoloMode()
      .then((enabled) => {
        if (!disposed) {
          applyYoloMode(enabled);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyYoloMode(false);
        }
      });

    void window.snow
      .getPlanMode()
      .then((enabled) => {
        if (!disposed) {
          applyPlanMode(enabled);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyPlanMode(false);
        }
      });

    void window.snow
      .getGoalMode()
      .then((enabled) => {
        if (!disposed) {
          applyGoalMode(enabled);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyGoalMode(false);
        }
      });

    void window.snow
      .getGoalModeTokenBudget()
      .then((budget) => {
        if (!disposed) {
          applyGoalModeTokenBudget(budget);
        }
      })
      .catch(() => {
        if (!disposed) {
          applyGoalModeTokenBudget(2000000);
        }
      });

    if (ctx.directoryId) {
      void window.snow
        .listToolApprovalProjectApprovedTools(ctx.directoryId)
        .then((toolNames) => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set(toolNames);
          }
        })
        .catch(() => {
          if (!disposed) {
            ctx.alwaysApprovedToolsRef.current = new Set();
          }
        });
    } else {
      ctx.alwaysApprovedToolsRef.current = new Set();
    }

    return () => {
      disposed = true;
    };
  }, [
    applyYoloMode,
    applyPlanMode,
    applyGoalMode,
    ctx.directoryId,
    ctx.alwaysApprovedToolsRef,
  ]);

  const setYoloMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingYoloMode) {
        return;
      }

      ctx.setIsUpdatingYoloMode(true);
      try {
        await window.snow.setYoloMode(enabled);
        applyYoloMode(enabled);
      } finally {
        ctx.setIsUpdatingYoloMode(false);
      }
    },
    [applyYoloMode, ctx.isUpdatingYoloMode, ctx.setIsUpdatingYoloMode]
  );

  const setPlanMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingPlanMode) {
        return;
      }

      ctx.setIsUpdatingPlanMode(true);
      try {
        await window.snow.setPlanMode(enabled);
        applyPlanMode(enabled);
        // Save to current session ref for per-conversation restore.
        const key = ctx.activeConversationIdRef.current ?? "pending";
        const ref = ctx.sessionsRefData.current.get(key);
        if (ref) {
          ref.planMode = enabled;
          if (enabled) ref.goalMode = false;
        }
        // Mutual exclusion: enabling Plan Mode disables Goal Mode
        if (enabled && ctx.goalModeRef.current) {
          await window.snow.setGoalMode(false);
          applyGoalMode(false);
        }
      } finally {
        ctx.setIsUpdatingPlanMode(false);
      }
    },
    [
      applyPlanMode,
      applyGoalMode,
      ctx.isUpdatingPlanMode,
      ctx.setIsUpdatingPlanMode,
      ctx.goalModeRef,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
    ]
  );

  const setGoalMode = useCallback(
    async (enabled: boolean): Promise<void> => {
      if (ctx.isUpdatingGoalMode) {
        return;
      }

      ctx.setIsUpdatingGoalMode(true);
      try {
        await window.snow.setGoalMode(enabled);
        applyGoalMode(enabled);
        // Save to current session ref for per-conversation restore.
        const key = ctx.activeConversationIdRef.current ?? "pending";
        const ref = ctx.sessionsRefData.current.get(key);
        if (ref) {
          ref.goalMode = enabled;
          if (enabled) ref.planMode = false;
        }
        // Mutual exclusion: enabling Goal Mode disables Plan Mode
        if (enabled && ctx.planModeRef.current) {
          await window.snow.setPlanMode(false);
          applyPlanMode(false);
        }
      } finally {
        ctx.setIsUpdatingGoalMode(false);
      }
    },
    [
      applyGoalMode,
      applyPlanMode,
      ctx.isUpdatingGoalMode,
      ctx.setIsUpdatingGoalMode,
      ctx.planModeRef,
      ctx.activeConversationIdRef,
      ctx.sessionsRefData,
    ]
  );

  const settleToolAuthorization = useCallback(
    (toolCall: ToolCallInfo, decision: ToolAuthorizationDecision): void => {
      const authorizationId = toolCall.authorizationId;
      if (!authorizationId) {
        return;
      }

      const pending =
        ctx.pendingToolAuthorizationRef.current.get(authorizationId);
      if (!pending) {
        return;
      }

      // Resolve only this tool's authorization. Rejecting one tool in a
      // parallel batch must not cascade-reject the remaining tools.
      ctx.pendingToolAuthorizationRef.current.delete(authorizationId);
      ctx.setPendingToolAuthorizations((current) =>
        current.filter((item) => item.authorizationId !== authorizationId)
      );
      pending.resolve(decision);
    },
    [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]
  );

  const rejectAllToolAuthorizations = useCallback((): void => {
    const pendingEntries = ctx.pendingToolAuthorizationRef.current;
    pendingEntries.forEach((entry) =>
      entry.resolve({
        status: "rejected",
        reason: "Tool execution interrupted",
      })
    );
    pendingEntries.clear();
    ctx.setPendingToolAuthorizations([]);
  }, [ctx.pendingToolAuthorizationRef, ctx.setPendingToolAuthorizations]);

  const requestToolAuthorization = useCallback(
    (
      toolCall: ToolCallInfo,
      index: number,
      conversationId: string,
      projectId?: string
    ): Promise<ToolAuthorizationDecision> => {
      if (toolCall.name === "user-interaction-askUserQuestion") {
        return Promise.resolve({ status: "approved" });
      }

      const shouldAutoApprove = () =>
        ctx.yoloModeRef.current ||
        ctx.alwaysApprovedToolsRef.current.has(toolCall.name);

      // Sensitive command check: even in YOLO mode, bash commands that match
      // the current project's merged rules must be confirmed.
      const checkSensitiveBash = async (): Promise<
        ToolAuthorizationDecision | "needs-dialog"
      > => {
        if (toolCall.name !== "bash-terminal-execute") {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        let command = "";
        let isInteractive = false;
        try {
          const parsed = JSON.parse(toolCall.arguments || "{}");
          if (typeof parsed?.command === "string") {
            command = parsed.command;
          }
          if (typeof parsed?.isInteractive === "boolean") {
            isInteractive = parsed.isInteractive;
          }
        } catch {
          // ignore parse error
        }

        // Interactive commands skip the sensitive-command gate entirely
        // because the user is expected to confirm every input in the
        // interactive terminal UI — a separate confirmation dialog would
        // be redundant.
        if (isInteractive) {
          return { status: "approved" };
        }

        if (!command) {
          return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
        }

        try {
          const matches = await window.snow.checkSensitiveCommandMatch(
            command,
            projectId
          );
          if (matches.length > 0) {
            // Sensitive command detected — force authorization dialog
            // even in YOLO mode.
            const authorizationId = `${
              toolCall.callId ?? toolCall.name
            }-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
            const pendingToolCall: ToolCallInfo = {
              ...toolCall,
              authorizationId,
              authorizationConversationId: conversationId,
              sensitiveCommandMatches: matches,
            };

            // 通知系统：敏感命令被拦截，需要用户确认
            ctx.notifySensitiveCommandIntercepted(toolCall.name);

            return new Promise<ToolAuthorizationDecision>((resolve) => {
              ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
                toolCall: pendingToolCall,
                resolve,
              });
              ctx.setPendingToolAuthorizations((current) => [
                ...current,
                pendingToolCall,
              ]);
            });
          }
        } catch {
          // If the check fails, fall through to normal authorization flow.
        }

        return shouldAutoApprove() ? { status: "approved" } : "needs-dialog";
      };

      return checkSensitiveBash().then((decision) => {
        if (decision !== "needs-dialog") {
          return decision;
        }

        // Normal authorization flow (non-YOLO, non-sensitive).
        const authorizationId = `${
          toolCall.callId ?? toolCall.name
        }-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const pendingToolCall = {
          ...toolCall,
          authorizationId,
          authorizationConversationId: conversationId,
        };

        return new Promise<ToolAuthorizationDecision>((resolve) => {
          ctx.pendingToolAuthorizationRef.current.set(authorizationId, {
            toolCall: pendingToolCall,
            resolve,
          });
          ctx.setPendingToolAuthorizations((current) => [
            ...current,
            pendingToolCall,
          ]);
        });
      });
    },
    [
      ctx.yoloModeRef,
      ctx.alwaysApprovedToolsRef,
      ctx.pendingToolAuthorizationRef,
      ctx.setPendingToolAuthorizations,
      ctx.notifySensitiveCommandIntercepted,
    ]
  );

  const requestToolAuthorizations = useCallback(
    async (
      toolCalls: ToolCallInfo[],
      conversationId: string,
      projectId?: string
    ): Promise<ToolAuthorizationDecision[]> => {
      // Read the persisted app setting once per tool batch so recent YOLO
      // changes take effect without querying SQLite for every tool.
      try {
        const enabled = await window.snow.getYoloMode();
        applyYoloMode(enabled);
      } catch {
        // Keep the last known in-memory state if the read fails.
      }

      // YOLO has no authorization dialog, so toolConfirmation does not run.
      // beforeToolCall remains the pre-execution policy gate in both modes.
      if (ctx.yoloModeRef.current) {
        return Promise.all(
          toolCalls.map((toolCall, index) =>
            requestToolAuthorization(toolCall, index, conversationId, projectId)
          )
        );
      }

      // Non-YOLO flow: execute toolConfirmation before showing authorization.
      const hookDecisions = await Promise.all(
        toolCalls.map(async (toolCall) => {
          try {
            const toolConfirmContext = JSON.stringify({
              toolName: toolCall.name,
              args: JSON.parse(toolCall.arguments || "{}"),
              cwd: directoryIdToPath(projectId) ?? ctx.directoryPath ?? "",
            });
            const confirmResult = await runHook(
              "toolConfirmation",
              projectId || undefined,
              toolConfirmContext
            );
            if (confirmResult) {
              ctx.updateSessionMessages(conversationId, (currentMessages) =>
                appendHookExecutionToMessage(
                  currentMessages,
                  confirmResult.record
                )
              );
              if (confirmResult.outcome.kind === "abort") {
                return {
                  status: "rejected" as const,
                  reason: confirmResult.outcome.message,
                };
              }
            }
          } catch {
            // Hook execution failed — continue with normal authorization
          }
          return null;
        })
      );

      return Promise.all(
        toolCalls.map((toolCall, index) => {
          const hookDecision = hookDecisions[index];
          if (hookDecision) {
            return Promise.resolve(hookDecision);
          }
          return requestToolAuthorization(
            toolCall,
            index,
            conversationId,
            projectId
          );
        })
      );
    },
    [applyYoloMode, requestToolAuthorization, ctx.directoryPath]
  );

  const approveToolAuthorizationAlways = useCallback(
    (toolCall: ToolCallInfo): void => {
      if (ctx.directoryId) {
        void window.snow
          .setToolApprovalProjectToolApproved(
            ctx.directoryId,
            toolCall.name,
            true
          )
          .then(() => {
            ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
          })
          .catch(() => {
            // The current execution can continue even if persistence fails.
          })
          .finally(() =>
            settleToolAuthorization(toolCall, { status: "approved" })
          );
      } else {
        // No project context: skip persistence and just approve this call.
        ctx.alwaysApprovedToolsRef.current.add(toolCall.name);
        settleToolAuthorization(toolCall, { status: "approved" });
      }
    },
    [ctx.directoryId, ctx.alwaysApprovedToolsRef, settleToolAuthorization]
  );

  // 卸载时清理所有待处理授权
  useEffect(
    () => () => rejectAllToolAuthorizations(),
    [rejectAllToolAuthorizations]
  );

  return {
    approveAllPendingToolAuthorizations,
    applyYoloMode,
    refreshYoloMode,
    setYoloMode,
    applyPlanMode,
    refreshPlanMode,
    setPlanMode,
    applyGoalMode,
    refreshGoalMode,
    setGoalMode,
    applyGoalModeTokenBudget,
    refreshGoalModeTokenBudget,
    setGoalModeTokenBudget,
    settleToolAuthorization,
    rejectAllToolAuthorizations,
    requestToolAuthorization,
    requestToolAuthorizations,
    approveToolAuthorizationAlways,
  };
};
