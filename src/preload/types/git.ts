export type GitFileStatus = {
  path: string;
  oldPath: string | null;
  indexStatus: string;
  workdirStatus: string;
  status: string;
};

export type GitStatusResult = {
  isRepo: boolean;
  currentBranch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
  stagedCount: number;
  unstagedCount: number;
  untrackedCount: number;
};

export type GitBranch = {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  remoteName: string | null;
};

export type GitDiffResult = {
  content: string;
  isBinary: boolean;
};

export type GitStageResult = {
  success: boolean;
  message: string;
};

export type GitCommitResult = {
  success: boolean;
  message: string;
  hash: string | null;
};

export type GitPushPullResult = {
  success: boolean;
  message: string;
};

export type GitCheckoutResult = {
  success: boolean;
  message: string;
};

export type GitLogEntry = {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: string;
  message: string;
  refs: string;
  parents: string[];
  /** 本次提交新增的行数（来自 git log --shortstat）。 */
  additions: number;
  /** 本次提交删除的行数（来自 git log --shortstat）。 */
  deletions: number;
};
export type GitCommitFile = {
  path: string;
  status: string;
};

export type GitRepoInfo = {
  path: string;
  name: string;
  currentBranch: string;
};
