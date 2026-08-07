import { ScanSearch } from "lucide-react";
import type { ChatCommand } from "./types";

export const createReviewCommand = (
  onOpenPanel: () => void,
  description: string,
  disabled: boolean
): ChatCommand => ({
  id: "review",
  label: "review",
  description,
  icon: ScanSearch,
  disabled,
  execute: onOpenPanel,
});
