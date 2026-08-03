import { Minimize2 } from "lucide-react";
import type { ChatCommand } from "./types";

export const createCompactCommand = (
  onCompactConversation: (
    model?: string,
    apiProfile?: string
  ) => void | Promise<void>,
  model: string | undefined,
  apiProfile: string | undefined,
  description: string,
  disabled: boolean
): ChatCommand => ({
  id: "compact",
  label: "compact",
  description,
  icon: Minimize2,
  disabled,
  execute: () => {
    void onCompactConversation(model, apiProfile);
  },
});
