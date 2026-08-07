export type ImportCandidateType =
  | "mcp"
  | "skill"
  | "prompt"
  | "command"
  | "agent"
  | "plugin";

export type ImportProvider = "codex" | "claude-code" | "opencode" | "snow";

export type ImportScope = "global" | "project";

export type ImportCandidateStatus =
  | "new"
  | "already-effective"
  | "update-available"
  | "conflict"
  | "unsupported"
  | "managed"
  | "repair";

export type ImportOwnership = {
  owner: "external" | "snow" | "shared";
  management: "reference" | "snapshot" | "user-adopted";
};

/**
 * Where an import source lives: the local machine, a WSL distribution on this
 * Windows host, or a remote host reached over SSH.
 */
export type ImportEnvironmentKind = "local" | "wsl" | "ssh";

export type ImportCandidateOrigin = {
  provider: ImportProvider;
  scope: ImportScope;
  originPath: string;
  projectId?: string;
  environmentId?: string;
  environmentLabel?: string;
};

export type ImportCandidate = {
  candidateId: string;
  type: ImportCandidateType;
  provider: ImportProvider;
  scope: ImportScope;
  projectId?: string;
  originPath: string;
  logicalId: string;
  contentHash: string;
  status: ImportCandidateStatus;
  ownership: ImportOwnership;
  sources: ImportCandidateOrigin[];
  unsupportedReason?: string;
  environmentId?: string;
  environmentLabel?: string;
};

export type ImportCandidateResultStatus =
  | "discovered"
  | "deduplicated"
  | "already-effective"
  | "conflict"
  | "unsupported";

export type ImportCandidateResult = {
  candidateId: string;
  status: ImportCandidateResultStatus;
  copyRequired: false;
  sourceCount: number;
  reason?: string;
};

export type ImportConfigPath = {
  label: string;
  path: string;
  found: boolean;
};

/**
 * One scanned environment of a provider: the local machine, a WSL
 * distribution, or an SSH remote host. `home` is the provider home directory
 * in environment-native form (e.g. `/home/user/.codex` for WSL/SSH).
 */
export type ImportSourceEnvironment = {
  environmentId: string;
  label: string;
  kind: ImportEnvironmentKind;
  home: string;
  found: boolean;
  configPaths: ImportConfigPath[];
  instructionPaths: ImportConfigPath[];
  projectConfigCount: number;
};

export type ImportSource = {
  provider: ImportProvider;
  sourceHome: string;
  sourceFound: boolean;
  configPaths: ImportConfigPath[];
  instructionPaths: ImportConfigPath[];
  projectConfigCount: number;
  warnings: string[];
  /** Per-environment details, local entry first when present. */
  environments: ImportSourceEnvironment[];
};

export type ImportDiscovery = {
  sources: ImportSource[];
  candidates: ImportCandidate[];
  results: ImportCandidateResult[];
  warnings: string[];
};

export type ReadonlyImportResult = ImportDiscovery & {
  applied: false;
};

export type ImportSelection = {
  candidateIds: string[];
  /** Directory ID of the currently active project, when the user is importing
   *  from the project-scoped view. Omitted for the global settings view. */
  activeDirectoryId?: string;
};

export type ImportCommitItemStatus =
  | "imported"
  | "unchanged"
  | "already-effective"
  | "unsupported"
  | "skipped";

export type ImportCommitItemResult = {
  candidateId: string;
  type: ImportCandidateType;
  logicalId: string;
  status: ImportCommitItemStatus;
  message?: string;
};

export type ImportCommitSummary = {
  selected: number;
  imported: number;
  unchanged: number;
  alreadyEffective: number;
  unsupported: number;
  skipped: number;
};

export type ImportCommitResult = {
  applied: true;
  itemResults: ImportCommitItemResult[];
  summary: ImportCommitSummary;
  warnings: string[];
};
