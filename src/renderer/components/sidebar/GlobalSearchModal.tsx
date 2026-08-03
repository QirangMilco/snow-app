import { Folder, Loader2, MessageSquareMore, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useI18n } from "../../i18n";
import type {
  ConversationSearchResult,
  WorkspaceDirectoryRecord,
} from "../../../preload";
import type { MainContentView } from "../mainContent/types";
import { Modal } from "../common/Modal";
import { formatTimeLabel, parseDbTimestamp } from "./mainSidebar/chatTimeGroup";
import { SETTINGS_ITEMS, type SettingsItem } from "./settingsItems";

const MAX_RESULTS_PER_GROUP = 6;
const SEARCH_DEBOUNCE_MS = 300;

type GlobalSearchResult =
  | { kind: "conversation"; conversation: ConversationSearchResult }
  | { kind: "directory"; directory: WorkspaceDirectoryRecord }
  | { kind: "setting"; setting: SettingsItem };

type GlobalSearchModalProps = {
  open: boolean;
  onClose: () => void;
  onSelectConversation: (conversation: ConversationSearchResult) => void;
  onSelectDirectory: (directory: WorkspaceDirectoryRecord) => void;
  onSelectSetting: (view: MainContentView) => void;
};

export function GlobalSearchModal({
  open,
  onClose,
  onSelectConversation,
  onSelectDirectory,
  onSelectSetting,
}: GlobalSearchModalProps): React.JSX.Element {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [directories, setDirectories] = useState<WorkspaceDirectoryRecord[]>(
    []
  );
  const [conversations, setConversations] = useState<ConversationSearchResult[]>(
    []
  );
  const [isLoadingConversations, setIsLoadingConversations] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);
  const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setConversations([]);
      setHasSearched(false);
      setActiveIndex(0);
      const id = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(id);
    }
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    void window.snow
      .listWorkspaceDirectories()
      .then((dirs) => {
        if (!cancelled) setDirectories(dirs);
      })
      .catch(() => {
        if (!cancelled) setDirectories([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    const trimmed = query.trim();

    if (!trimmed) {
      setConversations([]);
      setHasSearched(false);
      setIsLoadingConversations(false);
      return;
    }

    setIsLoadingConversations(true);
    const currentRequestId = ++requestIdRef.current;

    debounceRef.current = setTimeout(async () => {
      try {
        const items = await window.snow.searchChatConversations(trimmed);
        if (currentRequestId === requestIdRef.current) {
          setConversations(items);
          setHasSearched(true);
        }
      } catch {
        if (currentRequestId === requestIdRef.current) {
          setConversations([]);
          setHasSearched(true);
        }
      } finally {
        if (currentRequestId === requestIdRef.current) {
          setIsLoadingConversations(false);
        }
      }
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [query]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  const trimmedQuery = query.trim().toLowerCase();

  const matchedSettings = useMemo(() => {
    if (!trimmedQuery) return [];
    return SETTINGS_ITEMS.filter((item) => {
      const label = t(item.labelKey, {
        defaultValue: item.defaultLabel,
      }).toLowerCase();
      return label.includes(trimmedQuery) || item.id.includes(trimmedQuery);
    }).slice(0, MAX_RESULTS_PER_GROUP);
  }, [trimmedQuery, t]);

  const matchedDirectories = useMemo(() => {
    if (!trimmedQuery) return [];
    return directories
      .filter((d) => {
        return (
          d.name.toLowerCase().includes(trimmedQuery) ||
          d.path.toLowerCase().includes(trimmedQuery)
        );
      })
      .slice(0, MAX_RESULTS_PER_GROUP);
  }, [trimmedQuery, directories]);

  const flatResults: GlobalSearchResult[] = useMemo(() => {
    const results: GlobalSearchResult[] = [];
    for (const conversation of conversations) {
      results.push({ kind: "conversation", conversation });
    }
    for (const directory of matchedDirectories) {
      results.push({ kind: "directory", directory });
    }
    for (const setting of matchedSettings) {
      results.push({ kind: "setting", setting });
    }
    return results;
  }, [conversations, matchedDirectories, matchedSettings]);

  useEffect(() => {
    const el = itemRefs.current[activeIndex];
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleSelect = (result: GlobalSearchResult): void => {
    switch (result.kind) {
      case "conversation":
        onSelectConversation(result.conversation);
        break;
      case "directory":
        onSelectDirectory(result.directory);
        break;
      case "setting":
        onSelectSetting(result.setting.view);
        break;
    }
    onClose();
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (flatResults.length === 0) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % flatResults.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((prev) =>
        prev === 0 ? flatResults.length - 1 : prev - 1
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = flatResults[activeIndex];
      if (target) {
        handleSelect(target);
      }
    }
  };

  const now = new Date();
  const totalCount = flatResults.length;
  const showInitialLoading =
    isLoadingConversations && totalCount === 0 && !hasSearched;

  const renderConversationItem = (
    conversation: ConversationSearchResult,
    itemIndex: number
  ): React.JSX.Element => {
    const displayName =
      conversation.summary ||
      conversation.title ||
      t("sidebar.untitledChat", { defaultValue: "Untitled" });
    const parsedDate = parseDbTimestamp(conversation.updatedAt);
    const timeLabel = formatTimeLabel(parsedDate, now, t);

    return (
      <div
        key={`conv-${conversation.conversationId}`}
        ref={(el) => {
          itemRefs.current[itemIndex] = el;
        }}
        className={`search-result-item${itemIndex === activeIndex ? " active" : ""}`}
        onClick={() => handleSelect({ kind: "conversation", conversation })}
        onMouseEnter={() => setActiveIndex(itemIndex)}
        role="button"
        tabIndex={0}
      >
        <span className="search-result-icon">
          <MessageSquareMore size={14} />
        </span>
        <div className="search-result-content">
          <div className="search-result-title">{displayName}</div>
          {conversation.matchedContent && (
            <div className="search-result-preview">
              {conversation.matchedContent}
            </div>
          )}
        </div>
        <span className="search-result-time">{timeLabel}</span>
      </div>
    );
  };

  const renderDirectoryItem = (
    directory: WorkspaceDirectoryRecord,
    itemIndex: number
  ): React.JSX.Element => {
    return (
      <div
        key={`dir-${directory.directoryId}`}
        ref={(el) => {
          itemRefs.current[itemIndex] = el;
        }}
        className={`search-result-item${itemIndex === activeIndex ? " active" : ""}`}
        onClick={() => handleSelect({ kind: "directory", directory })}
        onMouseEnter={() => setActiveIndex(itemIndex)}
        role="button"
        tabIndex={0}
      >
        <span className="search-result-icon">
          <Folder size={14} />
        </span>
        <div className="search-result-content">
          <div className="search-result-title">{directory.name}</div>
          <div className="search-result-preview">{directory.path}</div>
        </div>
      </div>
    );
  };

  const renderSettingItem = (
    setting: SettingsItem,
    itemIndex: number
  ): React.JSX.Element => {
    const label = t(setting.labelKey, { defaultValue: setting.defaultLabel });
    const Icon = setting.icon;

    return (
      <div
        key={`setting-${setting.id}`}
        ref={(el) => {
          itemRefs.current[itemIndex] = el;
        }}
        className={`search-result-item${itemIndex === activeIndex ? " active" : ""}`}
        onClick={() => handleSelect({ kind: "setting", setting })}
        onMouseEnter={() => setActiveIndex(itemIndex)}
        role="button"
        tabIndex={0}
      >
        <span className="search-result-icon">
          <Icon size={14} />
        </span>
        <div className="search-result-content">
          <div className="search-result-title">{label}</div>
        </div>
      </div>
    );
  };

  const renderBody = (): React.ReactNode => {
    const trimmed = query.trim();

    if (!trimmed) {
      return (
        <div className="search-modal-hint">
          {t("search.hint", {
            defaultValue: "Search...",
          })}
        </div>
      );
    }

    if (showInitialLoading) {
      return (
        <div className="search-modal-loading">
          <Loader2 className="spin" size={18} />
          <span>{t("search.searching", { defaultValue: "Searching..." })}</span>
        </div>
      );
    }

    if (totalCount === 0 && hasSearched) {
      return (
        <div className="search-modal-empty">
          {t("search.noResults", { defaultValue: "No results found" })}
        </div>
      );
    }

    if (totalCount === 0) {
      return null;
    }

    let index = 0;

    return (
      <div className="search-modal-results" onKeyDown={handleKeyDown}>
        {conversations.length > 0 && (
          <div className="search-group">
            <div className="search-group-title">
              {t("search.groupConversations", {
                defaultValue: "Conversations",
              })}
            </div>
            {conversations.map((conversation) =>
              renderConversationItem(conversation, index++)
            )}
          </div>
        )}
        {matchedDirectories.length > 0 && (
          <div className="search-group">
            <div className="search-group-title">
              {t("search.groupProjects", { defaultValue: "Projects" })}
            </div>
            {matchedDirectories.map((directory) =>
              renderDirectoryItem(directory, index++)
            )}
          </div>
        )}
        {matchedSettings.length > 0 && (
          <div className="search-group">
            <div className="search-group-title">
              {t("search.groupSettings", { defaultValue: "Settings" })}
            </div>
            {matchedSettings.map((setting) =>
              renderSettingItem(setting, index++)
            )}
          </div>
        )}
        {isLoadingConversations && (
          <div className="search-group-loading">
            <Loader2 className="spin" size={14} />
            <span>
              {t("search.searchingConversations", {
                defaultValue: "Searching conversations...",
              })}
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal
      open={open}
      title={t("search.title", { defaultValue: "Search" })}
      closeLabel={t("search.close", { defaultValue: "Close search" })}
      onClose={onClose}
      size="large"
      className="search-modal"
    >
      <div className="search-modal-input-wrapper">
        <Search size={16} className="search-modal-input-icon" />
        <input
          ref={inputRef}
          className="search-modal-input"
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("search.placeholder", {
            defaultValue: "Search...",
          })}
          autoComplete="off"
          spellCheck={false}
        />
      </div>
      <div className="search-modal-body">{renderBody()}</div>
    </Modal>
  );
}
