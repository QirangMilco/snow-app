import type { ImportResourceInput } from "../../shared/importResources";
import type {
  ImportDatabaseTransactionInput,
  McpServerConfigInput,
  NativeBridge,
  PluginInput,
  SystemPromptItemInput,
} from "../native/types";
import type { DirectoryCommit } from "./directoryCommit";

type StagedDirectory = {
  transaction: DirectoryCommit;
  replaceExisting: boolean;
  afterCommit?: () => Promise<void>;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Coordinates reversible filesystem changes with one atomic native database
 * commit. Directory backups remain available until the database transaction
 * has committed successfully.
 */
export class ImportExecutionPlan {
  private readonly database: ImportDatabaseTransactionInput = {
    mcpServers: [],
    projectMcpServers: [],
    systemPrompts: [],
    plugins: [],
    importResources: [],
  };
  private readonly directories: StagedDirectory[] = [];
  private finalized = false;

  addMcpServer(input: McpServerConfigInput): void {
    this.database.mcpServers.push(input);
  }

  addProjectMcpServer(projectId: string, input: McpServerConfigInput): void {
    this.database.projectMcpServers.push({ projectId, input });
  }

  addSystemPrompt(input: SystemPromptItemInput): void {
    this.database.systemPrompts.push(input);
  }

  addPlugin(input: PluginInput): void {
    this.database.plugins.push(input);
  }

  addImportResources(inputs: ImportResourceInput[]): void {
    this.database.importResources.push(...inputs);
  }

  addDirectory(
    transaction: DirectoryCommit,
    replaceExisting: boolean,
    afterCommit?: () => Promise<void>
  ): void {
    this.directories.push({ transaction, replaceExisting, afterCommit });
  }

  async commit(native: NativeBridge): Promise<void> {
    if (this.finalized) {
      throw new Error("Import execution plan has already been finalized");
    }
    const committed: DirectoryCommit[] = [];
    try {
      for (const directory of this.directories) {
        directory.transaction.commit({ replaceExisting: directory.replaceExisting });
        committed.push(directory.transaction);
        await directory.afterCommit?.();
      }
      if (this.hasDatabaseMutations()) {
        await native.commitImportTransaction(this.database);
      }
      this.finalized = true;
    } catch (error) {
      const rollbackErrors: string[] = [];
      for (const transaction of committed.reverse()) {
        try {
          transaction.rollback();
        } catch (rollbackError) {
          rollbackErrors.push(errorMessage(rollbackError));
        }
      }
      this.finalized = true;
      const rollbackDetail = rollbackErrors.length > 0
        ? ` Directory rollback was incomplete: ${rollbackErrors.join("; ")}`
        : "";
      throw new Error(`${errorMessage(error)}.${rollbackDetail}`);
    } finally {
      this.cleanup();
    }
  }

  discard(): void {
    if (this.finalized) return;
    this.finalized = true;
    this.cleanup();
  }

  private hasDatabaseMutations(): boolean {
    return this.database.mcpServers.length > 0 ||
      this.database.projectMcpServers.length > 0 ||
      this.database.systemPrompts.length > 0 ||
      this.database.plugins.length > 0 ||
      this.database.importResources.length > 0;
  }

  private cleanup(): void {
    for (const directory of this.directories) {
      directory.transaction.cleanup();
    }
  }
}
