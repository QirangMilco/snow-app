export interface UpdateStatus {
  available: boolean;
  version: string | null;
  downloading: boolean;
  progress: number;
  downloaded: boolean;
  error: string | null;
}
