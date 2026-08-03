import { FileClock } from "lucide-react";
import type { ChatCommand } from "./types";

export const createFileChangesCommand = (
  onOpenPanel: () => void,
  description: string,
  disabled: boolean
): ChatCommand => ({
  id: "changes",
  label: "changes",
  description,
  icon: FileClock,
  disabled,
  execute: onOpenPanel,
});
