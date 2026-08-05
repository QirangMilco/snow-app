# 12-Git Panel & Code Browsing

This guide covers three code-related areas: the **Git panel** (repository
management & diff viewing), the **right-panel file reader** (multi-tab file
browsing with Markdown preview), and the **codebase panel** (semantic search
and the 3D similarity sphere).

## 1. Git Panel

### 1.1 Opening & Repository Selection

- Open the **Git tab** in the right panel; repositories in the workspace are
  auto-discovered;
- **Repository selector**: switch the active repo; right-click to copy the
  repo path, reveal in file manager, or open a terminal there;
- `ssh://` **remote repositories** are supported (see
  [11-terminal-and-ssh](11-terminal-and-ssh.md)).

### 1.2 Changes & Diffs

| Area | Notes |
| --- | --- |
| Change list | Working/staged file changes with add/modify/delete status |
| Diff view | Click a file to open a **diff preview** (side-by-side lines, colored additions/deletions) |
| File actions | Right-click: open in terminal, reveal in file manager, open in the file reader |

### 1.3 Commit & Sync

- Enter a commit message and commit;
- Pull / push / refresh;
- Remote repos auto-refresh via polling (see the SSH guide).

> **AI collaboration**: after the AI modifies files, use `/file-changes` in
> chat to review this round's changes; the same changes show up in the Git
> panel. You can also ask the AI to run git commands in the terminal/workspace.

## 2. Right-Panel File Reader

The right panel is a **multi-tab** file reader:

| File type | Support |
| --- | --- |
| Text/code | Syntax highlighting, line numbers, in-file search (auto-jump + highlight) |
| Markdown (`.md`) | **Render preview** (headings/tables/code/math/diagrams) + source toggle; wide tables scroll horizontally; relative links open files in new tabs |
| Images | Preview (zoomable); SVG has image/code dual view |
| Office documents | PDF / Word / Excel / CSV text extraction |
| Binary | "Binary file" placeholder |

Open via: sidebar file clicks, file links in chat, Git diff files, `@`
mentions, etc. Right-click a tab to create a terminal/browser or close it;
right-click a file for "Open in terminal" / "Reveal in file manager".

### Markdown Preview Tips

- **Wide tables**: scroll horizontally instead of being clipped;
- **Math**: `$...$` inline, `$$...$$` block (KaTeX);
- **Diagrams**: ``` ```mermaid ``` ``` blocks render as interactive diagrams
  (code/diagram toggle, save as image);
- **View switching**: toolbar "Render preview / Source" toggle; editing
  switches back to source automatically.

## 3. Codebase Panel & Semantic Search

### 3.1 Enabling

Enable codebase indexing in **Settings → Codebase**
(`app-control-openSettings page=codebase-settings`) and configure an embedding
model; the first index may take a few minutes. Once enabled:

- `/codebase` in the chat input opens the project codebase panel;
- the AI gains the `codebase-search` tool (see
  [7-codebase-index-and-diagnostics](7-codebase-index-and-diagnostics.md)).

### 3.2 3D Similarity Sphere

The codebase panel includes a **3D sphere view**: each file is a node whose
distance reflects embedding similarity. Drag to rotate, zoom to inspect file
clusters and relationships (layout is computed on a Rust background thread,
so the UI stays responsive).

### 3.3 Natural-Language File Search

Type `@?<query>` in the chat input to start a **natural-language file
search**: the AI combines grep/filesystem tools to locate relevant files,
showing progress and results in real time.

### 3.4 Codebase Panel (next to the input)

- **Scan preview**: shows file count/size before indexing to avoid indexing
  huge directories by accident;
- **Index stats**: file count, embedding progress; start/rebuild index as
  needed;
- **Embedding progress**: live progress; semantic search works as soon as it
  completes.

## 4. Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| Git panel shows no repos | Confirm `.git` exists under the workspace; remote repos need an SSH connection first |
| Semantic search unavailable | Codebase index not enabled or not finished; check the embedding model config |
| 3D sphere lags | Layout already runs off-thread; for huge repos narrow the index with `fileGlob` |
| Preview vs source mismatch | Markdown preview goes through the renderer; the source view is authoritative |

## 5. References

- Codebase configuration: [7-codebase-index-and-diagnostics](7-codebase-index-and-diagnostics.md)
- Storage locations (index, Git state): [3-reference/4-data-storage-locations](../3-reference/4-data-storage-locations.md)
