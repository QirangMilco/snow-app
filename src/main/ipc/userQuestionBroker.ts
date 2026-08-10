import type { WebContents } from "electron";
import { randomUUID } from "node:crypto";
import type {
  UserQuestionCommand,
  UserQuestionRequest,
  UserQuestionResponse,
} from "../native/types";
import { safeSend } from "../utils/safeSend";
import { reportPetWaiting } from "../pets/petWindow";

const USER_QUESTION_CHANNEL = "user-question:request";
const USER_QUESTION_RESPONSE_CHANNEL = "user-question:response";

const pendingQuestions = new Map<
  string,
  {
    rendererId: number;
    resolve: (resultJson: string) => void;
    reject: (error: Error) => void;
  }
>();
const watchedRendererIds = new Set<number>();

const failPendingQuestionsForRenderer = (rendererId: number): void => {
  for (const [questionId, pending] of pendingQuestions) {
    if (pending.rendererId !== rendererId) {
      continue;
    }

    pending.reject(new Error("User question renderer was destroyed"));
    pendingQuestions.delete(questionId);
    reportPetWaiting(false);
  }
};

const watchRenderer = (renderer: WebContents): void => {
  if (watchedRendererIds.has(renderer.id)) {
    return;
  }

  const rendererId = renderer.id;
  watchedRendererIds.add(rendererId);
  renderer.once("destroyed", () => {
    watchedRendererIds.delete(rendererId);
    failPendingQuestionsForRenderer(rendererId);
  });
};

export const dispatchUserQuestion = async (
  source: WebContents,
  command: UserQuestionCommand,
  interactionId: string
): Promise<string> => {
  if (source.isDestroyed()) {
    throw new Error("User question renderer is not available");
  }

  watchRenderer(source);
  const questionId = `${source.id}:${randomUUID()}`;
  const request: UserQuestionRequest = {
    questionId,
    interactionId,
    question: command.question,
    options: command.options,
  };

  return new Promise<string>((resolve, reject) => {
    pendingQuestions.set(questionId, {
      rendererId: source.id,
      resolve,
      reject,
    });
    reportPetWaiting(true);

    try {
      safeSend(source, USER_QUESTION_CHANNEL, request);
    } catch (error) {
      pendingQuestions.delete(questionId);
      reportPetWaiting(false);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
};

export const resolveUserQuestion = (
  source: WebContents,
  response: UserQuestionResponse
): void => {
  if (!response.questionId.startsWith(`${source.id}:`)) {
    return;
  }

  const pending = pendingQuestions.get(response.questionId);
  if (!pending || pending.rendererId !== source.id) {
    return;
  }

  pendingQuestions.delete(response.questionId);
  reportPetWaiting(false);
  if (response.error) {
    pending.reject(new Error(response.error));
    return;
  }
  if (typeof response.resultJson !== "string") {
    pending.reject(new Error("User question response is missing result JSON"));
    return;
  }

  pending.resolve(response.resultJson);
};

export { USER_QUESTION_CHANNEL, USER_QUESTION_RESPONSE_CHANNEL };
