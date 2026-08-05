import type { ImportCandidateType, ImportProvider, ImportScope } from "./importDiscovery";

export type ImportResourceManagement = "reference" | "snapshot" | "user-adopted";

export type ImportResourceSource = {
  sourceId: string;
  provider: ImportProvider;
  scope: ImportScope;
  originPath: string;
  projectId?: string;
  importedHash: string;
  currentHash: string;
  lastScannedAt: string;
};

export type ImportResourceRecord = {
  resourceId: string;
  resourceType: ImportCandidateType;
  scope: ImportScope;
  projectId?: string;
  targetId: string;
  targetPath: string;
  management: ImportResourceManagement;
  sourceCount: number;
  sources: ImportResourceSource[];
  updatedAt: string;
};

export type ImportResourceInput = Omit<
  ImportResourceRecord,
  "sourceCount" | "updatedAt" | "sources"
> & {
  sources: Array<
    Omit<ImportResourceSource, "sourceId" | "importedHash" | "currentHash" | "lastScannedAt">
    & { contentHash: string }
  >;
};

export type ImportResourceReleaseDisposition = "delete" | "adopt";

export type ImportResourceReleaseInput = {
  resourceId: string;
  sourceId: string;
  disposition: ImportResourceReleaseDisposition;
};

export type ImportResourceRelease = {
  resource: ImportResourceRecord;
  cleanupTarget: boolean;
  remainingSourceCount: number;
};
