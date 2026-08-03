import { useCallback, useEffect, useRef, useState } from "react";

import type {
  CodebaseEmbedProgress,
  ResumableCodebaseSession,
} from "../../preload/types/settings";

export type EmbedState = "idle" | "running" | "paused" | "completed" | "error";

const createSessionId = (): string =>
  `embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type UseCodebaseEmbeddingParams = {
  projectId: string | undefined;
  onEmbeddingDone?: () => void;
};

type UseCodebaseEmbeddingResult = {
  embedState: EmbedState;
  embedProgress: CodebaseEmbedProgress | null;
  /** Error message of the last failed embedding (from progress or IPC reject). */
  embedError: string | null;
  resumableSession: ResumableCodebaseSession | null;
  isResuming: boolean;
  startEmbedding: () => Promise<void>;
  pauseEmbedding: () => Promise<void>;
  resumeEmbedding: () => Promise<void>;
  cancelEmbedding: () => Promise<void>;
  resumeSession: () => Promise<void>;
  discardSession: () => Promise<void>;
  loadResumableSession: () => Promise<void>;
};

/**
 * Manages all codebase embedding state for a single project, with strict
 * project isolation.
 *
 * Architecture:
 * - Progress events are received via a **broadcast subscription**
 *   (`onCodebaseEmbedProgress`), filtered by `projectId`. This means when
 *   the user switches back to a project whose embedding is still running
 *   in the background, the hook picks up the live progress stream again.
 * - When the project changes, `isCodebaseEmbeddingActive` is queried to
 *   detect if a background embedding is still running. If so, `embedState`
 *   is set to "running" so the UI shows the correct state immediately.
 * - A generation counter guards against stale async results.
 */
export const useCodebaseEmbedding = ({
  projectId,
  onEmbeddingDone,
}: UseCodebaseEmbeddingParams): UseCodebaseEmbeddingResult => {
  const [embedState, setEmbedState] = useState<EmbedState>("idle");
  const [embedProgress, setEmbedProgress] =
    useState<CodebaseEmbedProgress | null>(null);
  const [embedError, setEmbedError] = useState<string | null>(null);
  const [resumableSession, setResumableSession] =
    useState<ResumableCodebaseSession | null>(null);
  const [isResuming, setIsResuming] = useState(false);

  const sessionIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const onDoneRef = useRef(onEmbeddingDone);
  useEffect(() => {
    onDoneRef.current = onEmbeddingDone;
  }, [onEmbeddingDone]);

  // ── Broadcast subscription: receive ALL embed progress events ────────
  // This is registered once and lives for the entire hook lifetime.
  // Events are filtered by projectId so only the current project's
  // progress is applied. When the user switches back to a project whose
  // background embedding is still running, this subscription automatically
  // picks up the live progress stream.
  useEffect(() => {
    const dispose = window.snow.onCodebaseEmbedProgress(
      (progress, changedProjectId, sessionId) => {
        // Strict project isolation: only accept events for the current project.
        if (changedProjectId !== projectId) {
          return;
        }

        // Track the session id so pause/resume/cancel can target it.
        if (!sessionIdRef.current) {
          sessionIdRef.current = sessionId;
        }

        setEmbedProgress(progress);

        switch (progress.phase) {
          case "done":
            setEmbedState("completed");
            onDoneRef.current?.();
            break;
          case "error":
            setEmbedState("error");
            setEmbedError(progress.error || null);
            break;
          case "cancelled":
            setEmbedState("idle");
            setEmbedProgress(null);
            setEmbedError(null);
            sessionIdRef.current = null;
            break;
          case "paused":
            setEmbedState("paused");
            break;
          default:
            // Non-terminal phases (scanning/chunking/embedding/storing)
            // ensure we're in "running" state. This handles the case where
            // the user switched away and back — the state was reset to
            // "idle" but the background embedding is still going.
            setEmbedState("running");
            break;
        }
      }
    );

    return () => {
      dispose();
    };
  }, [projectId]);

  // ── Project switch: reset + check for active background embedding ────
  useEffect(() => {
    generationRef.current += 1;
    sessionIdRef.current = null;
    setEmbedState("idle");
    setEmbedProgress(null);
    setEmbedError(null);
    setResumableSession(null);
    setIsResuming(false);

    if (!projectId) {
      return;
    }

    const generation = generationRef.current;

    // Check if a background embedding is still running for this project.
    // If so, set the state to "running" so the UI shows it immediately.
    // The broadcast subscription will deliver live progress updates.
    void window.snow
      .isCodebaseEmbeddingActive(projectId)
      .then((active) => {
        if (generationRef.current === generation && active) {
          setEmbedState("running");
        }
      })
      .catch(() => {
        // Silent — treat as not active
      });
  }, [projectId]);

  const loadResumableSession = useCallback(async (): Promise<void> => {
    if (!projectId) {
      setResumableSession(null);
      return;
    }
    try {
      const sessions = await window.snow.getResumableCodebaseSessions(
        projectId
      );
      setResumableSession(sessions.length > 0 ? sessions[0] : null);
    } catch {
      setResumableSession(null);
    }
  }, [projectId]);

  const startEmbedding = useCallback(async (): Promise<void> => {
    if (!projectId || embedState === "running") {
      return;
    }

    const sessionId = createSessionId();
    sessionIdRef.current = sessionId;
    setEmbedState("running");
    setEmbedProgress(null);
    setEmbedError(null);

    try {
      await window.snow.startCodebaseEmbedding(projectId, sessionId);
      // The broadcast subscription handles progress + terminal states.
      // Refresh stats after the promise resolves.
      onDoneRef.current?.();
    } catch (error) {
      setEmbedState("error");
      setEmbedError(error instanceof Error ? error.message : String(error));
    }
  }, [projectId, embedState]);

  const pauseEmbedding = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    try {
      await window.snow.pauseCodebaseEmbedding(sessionId);
      // The broadcast subscription will send a "paused" progress event.
    } catch {
      // Silent
    }
  }, []);

  const resumeEmbedding = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    try {
      await window.snow.resumeCodebaseEmbedding(sessionId);
      setEmbedState("running");
    } catch {
      // Silent
    }
  }, []);

  const cancelEmbedding = useCallback(async (): Promise<void> => {
    const sessionId = sessionIdRef.current;
    if (!sessionId) {
      return;
    }
    try {
      await window.snow.cancelCodebaseEmbedding(sessionId);
      // The broadcast subscription will send a "cancelled" event, but
      // we also reset locally for immediate feedback.
      sessionIdRef.current = null;
      setEmbedState("idle");
      setEmbedProgress(null);
      setEmbedError(null);
    } catch {
      // Silent
    }
  }, []);

  const resumeSession = useCallback(async (): Promise<void> => {
    const session = resumableSession;
    if (!session || !projectId) {
      return;
    }

    setIsResuming(true);

    try {
      sessionIdRef.current = session.sessionId;
      setEmbedState("running");
      setEmbedError(null);
      setResumableSession(null);

      await window.snow.startCodebaseEmbedding(
        projectId,
        session.sessionId
      );
      onDoneRef.current?.();
    } catch (error) {
      setEmbedState("error");
      setEmbedError(error instanceof Error ? error.message : String(error));
    } finally {
      setIsResuming(false);
    }
  }, [resumableSession, projectId]);

  const discardSession = useCallback(async (): Promise<void> => {
    const session = resumableSession;
    if (!session) {
      return;
    }
    try {
      await window.snow.discardResumableCodebaseSession(session.sessionId);
      setResumableSession(null);
    } catch {
      // Silent
    }
  }, [resumableSession]);

  return {
    embedState,
    embedProgress,
    embedError,
    resumableSession,
    isResuming,
    startEmbedding,
    pauseEmbedding,
    resumeEmbedding,
    cancelEmbedding,
    resumeSession,
    discardSession,
    loadResumableSession,
  };
};
