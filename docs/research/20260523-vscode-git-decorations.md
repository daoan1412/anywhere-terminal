# VSCode Git Decorations — Reference for `anywhere-terminal`

Research date: 2026-05-23. Source tree: `/Users/huybuidac/Projects/ai-oss/vscode` (read-only).

## Summary

VSCode renders git status badges in the Explorer through a 3-layer pipeline:

1. **Git extension** runs `git status`, builds `Resource` objects with `(letter, color, tooltip, propagate)`, fires `Repository.onDidRunGitStatus`.
2. **`vscode.window.registerFileDecorationProvider`** (extension API) → marshalled through `extHostDecorations.ts` → `MainThreadDecorations` → the workbench `IDecorationsService`.
3. **`DecorationsService`** stores per-URI decoration data in a `TernarySearchTree<URI, ...>` and emits one event with `affectsResource(uri)`. The Explorer's `ResourceLabel` listens, calls `getDecoration(uri, includeChildren=true)` on render, and parent rows pick up child decorations via `bubble` flag + ternary-tree's `findSuperstr` (this is the "dirty parent" propagation).

**For our external extension**, we don't need ANY of layers 2/3 — we can talk directly to the git extension's exported API (`vscode.extensions.getExtension('vscode.git').exports.getAPI(1)`), read `Repository.state.workingTreeChanges` + `indexChanges` + `mergeChanges` + `untrackedChanges`, listen to `state.onDidChange`, and roll our own decoration model inside the webview.

The decoration *semantics* (status → letter → theme color) live in `extensions/git/src/repository.ts:54-149` as static methods on `Resource`. We can copy them ~verbatim into our webview renderer.

---

## 1. Decoration model — what fields exist

### Workbench-internal API (the surface decoration providers conform to)

`src/vs/workbench/services/decorations/common/decorations.ts:16-23`

```ts
export interface IDecorationData {
  readonly weight?: number;          // sort key when multiple providers stack
  readonly color?: ColorIdentifier;  // theme color ID, e.g. 'gitDecoration.modifiedResourceForeground'
  readonly letter?: string | ThemeIcon;  // 1-char badge OR a codicon
  readonly tooltip?: string;
  readonly strikethrough?: boolean;  // used for "deleted"
  readonly bubble?: boolean;         // PROPAGATE TO ANCESTORS — this is the parent-dot mechanism
}
```

### Extension-facing API (what the git extension actually returns)

`src/vs/workbench/api/common/extHostTypes.ts:2573-2605`

```ts
export class FileDecoration {
  badge?: string | vscode.ThemeIcon;  // (extension API renames "letter" → "badge")
  tooltip?: string;
  color?: vscode.ThemeColor;
  propagate?: boolean;                // (extension API renames "bubble" → "propagate")
  // constructor(badge?, tooltip?, color?)
}
```

`badge` is validated to be at most one grapheme (`FileDecoration.validate` at lines 2575-2593) — so it can be a single letter like `'M'` or a 2-char surrogate pair, **not** a multi-char string.

The extension→workbench bridge wires `propagate → bubble` at `src/vs/workbench/api/browser/mainThreadDecorations.ts:99-106`:

```ts
const [bubble, tooltip, letter, themeColor] = data;
return {
  weight: 10,
  bubble: bubble ?? false,
  color: themeColor?.id,
  tooltip,
  letter,
};
```

---

## 2. Git status source — where statuses come from, what events fire

The single `Repository` instance per repo (`extensions/git/src/repository.ts:701`) holds 4 resource groups and re-derives them from `git status` whenever the working tree, the index, or the `.git` directory changes.

### The status event

`extensions/git/src/repository.ts:710-711`

```ts
private _onDidChangeStatus = new EventEmitter<void>();
readonly onDidRunGitStatus: Event<void> = this._onDidChangeStatus.event;
```

Fired exactly once per `_updateModelState()` run, after the 4 resource groups are rewritten — `repository.ts:2788-2796`:

```ts
const [resourceGroups, refs] = await Promise.all([
  this.getStatus(cancellationToken),
  this.getRefs({}, cancellationToken),
]);
this._refs = refs;
this._updateResourceGroupsState(resourceGroups);
this._onDidChangeStatus.fire();
```

### What triggers `_updateModelState`

`extensions/git/src/repository.ts:1021` wires up an `anyEvent(...)` of working-tree FS watchers + dotGit watcher + config changes:

```ts
)(() => this.updateModelState(), this, this.disposables);
```

`updateModelState` (around 2742-2745) cancels any in-flight refresh and starts a new one, calling `_updateModelState` which runs `git status --porcelain` and partitions output into:
- `indexGroup` (staged)
- `workingTreeGroup` (unstaged tracked changes)
- `untrackedGroup` (new files)
- `mergeGroup` (conflicts)

### Public API surface (`api1.ts`)

`extensions/git/src/api/api1.ts:42-60` exposes the four groups as `Change[]` and the status event as `onDidChange`:

```ts
export class ApiRepositoryState implements RepositoryState {
  constructor(repository: BaseRepository) {
    this.#repository = repository;
    this.onDidChange = this.#repository.onDidRunGitStatus;  // <-- the event
  }

  get mergeChanges()        { return this.#repository.mergeGroup.resourceStates.map(r => new ApiChange(r)); }
  get indexChanges()        { return this.#repository.indexGroup.resourceStates.map(r => new ApiChange(r)); }
  get workingTreeChanges()  { return this.#repository.workingTreeGroup.resourceStates.map(r => new ApiChange(r)); }
  get untrackedChanges()    { return this.#repository.untrackedGroup.resourceStates.map(r => new ApiChange(r)); }
}
```

`ApiChange` (`api1.ts:30-36`) is the small public shape: `{ uri, originalUri, renameUri, status: Status }`.

The full public type definition is `extensions/git/src/api/git.d.ts:131-145` (`RepositoryState`) and `:111-122` (`Change`).

---

## 3. How the Explorer tree consumes decorations

### Registration (one-time, per Explorer view)

`src/vs/workbench/contrib/files/browser/views/explorerView.ts:811-814`

```ts
if (!this.decorationsProvider) {
  this.decorationsProvider = new ExplorerDecorationsProvider(this.explorerService, this.contextService);
  this._register(this.decorationService.registerDecorationsProvider(this.decorationsProvider));
}
```

The provider itself (`explorerDecorationsProvider.ts:47-81`) only owns Explorer-intrinsic things (symlink arrow `⤷`, root-error `!`). Git decorations come from a *separate* provider registered by the git extension via the public `window.registerFileDecorationProvider` API (`decorationProvider.ts:115-119`).

### Change → re-render path

The tree doesn't poll. Each `ResourceLabel` widget subscribes once to `IDecorationsService.onDidChangeDecorations`, then on every event asks `affectsResource(myUri)` and re-renders only if true.

`src/vs/workbench/browser/labels.ts:183-195`:

```ts
this._register(this.decorationsService.onDidChangeDecorations(e => {
  let notifyDidChangeDecorations = false;
  this.widgets.forEach(widget => {
    if (widget.notifyFileDecorationsChanges(e)) {
      notifyDidChangeDecorations = true;
    }
  });
  if (notifyDidChangeDecorations) {
    this._onDidChangeDecorations.fire();
  }
}));
```

`src/vs/workbench/browser/labels.ts:366-381` — per-row filter:

```ts
notifyFileDecorationsChanges(e: IResourceDecorationChangeEvent): boolean {
  if (!this.options) return false;
  const resource = toResource(this.label);
  if (!resource) return false;
  if (this.options.fileDecorations && e.affectsResource(resource)) {
    return this.render({ updateIcon: false, updateDecoration: true });
  }
  return false;
}
```

### `affectsResource` is *subtree-aware*

`src/vs/workbench/services/decorations/browser/decorationsService.ts:219-230`:

```ts
class FileDecorationChangeEvent implements IResourceDecorationChangeEvent {
  private readonly _data = TernarySearchTree.forUris<true>(_uri => true);
  constructor(all: URI | URI[]) { this._data.fill(true, asArray(all)); }
  affectsResource(uri: URI): boolean {
    return this._data.hasElementOrSubtree(uri);  // <-- changed child URI matches its parent's check
  }
}
```

So when `/repo/src/foo.ts` changes, the row for `/repo/src/` also re-renders.

### Render-time decoration fetch

`src/vs/workbench/browser/labels.ts:687-709` is where each row pulls its decoration:

```ts
if (this.options?.fileDecorations && resource) {
  if (options.updateDecoration) {
    this.decoration.value = this.decorationsService.getDecoration(resource, this.options.fileKind !== FileKind.FILE);
    //                                                                     ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    //                                                                     includeChildren = true for folders, false for files
  }
  ...
}
```

That `includeChildren` second argument is the critical part — see next section.

---

## 4. Parent folder propagation — how a dirty file colors its parents

Two cooperating pieces:

### (a) The decoration must opt in to propagation

`extensions/git/src/repository.ts:306-310`:

```ts
get resourceDecoration(): FileDecoration {
  const res = new FileDecoration(this.letter, this.tooltip, this.color);
  res.propagate = this.type !== Status.DELETED && this.type !== Status.INDEX_DELETED;
  return res;
}
```

So every non-deleted change sets `propagate = true`. Deletions don't propagate (you don't see a "D" on parent folders for a deleted file — only on the file row itself, which exists transiently).

### (b) The service walks the subtree on lookup

`src/vs/workbench/services/decorations/browser/decorationsService.ts:326-367` (`getDecoration`):

```ts
getDecoration(uri: URI, includeChildren: boolean): IDecoration | undefined {
  const all: IDecorationData[] = [];
  let containsChildren: boolean = false;
  const map = this._ensureEntry(uri);

  for (const provider of this._provider) {
    let data = map.get(provider);
    if (data === undefined) data = this._fetchData(map, uri, provider);
    if (data && !(data instanceof DecorationDataRequest)) all.push(data);
  }

  if (includeChildren) {
    // (resolved) children
    const iter = this._data.findSuperstr(uri);     // <-- ternary tree subtree iteration
    if (iter) {
      for (const tuple of iter) {
        for (const data of tuple[1].values()) {
          if (data && !(data instanceof DecorationDataRequest)) {
            if (data.bubble) {                       // <-- the propagate flag, renamed
              all.push(data);
              containsChildren = true;
            }
          }
        }
      }
    }
  }

  return all.length === 0 ? undefined : this._decorationStyles.asDecoration(all, containsChildren);
}
```

When called for a folder URI with `includeChildren=true`, it walks every cached child URI (via `TernarySearchTree.findSuperstr`), collects any decoration whose `bubble` is true, then renders a special "bubble badge" (a dot codicon ``, see `decorationsService.ts:117-120`) tinted with the child's color.

The merge into a single visual is at `DecorationStyles.asDecoration` (`decorationsService.ts:173-216`) — when `onlyChildren=true` (the folder has *only* inherited decorations), the badge becomes the small bubble dot instead of a letter. If the folder *itself* is also dirty, the letter+color win and the badge displays normally.

### What we need in our own implementation

Concretely, dirty-parent propagation = "for every changed file, walk upward to each ancestor directory inside the workspace root and mark it as containing-dirty-child". A simple `Map<dirPath, Set<status>>` rebuilt from scratch on each `onDidChange` is plenty — we don't need a ternary tree at our scale.

---

## 5. Status → letter / color cheat sheet

Source: `extensions/git/src/repository.ts:54-149`. The git extension uses *theme color IDs* (resolved at render time by VSCode's theme service), not raw colors.

### Letters

| Status enum                | Letter | Notes                                                  |
|----------------------------|--------|--------------------------------------------------------|
| `INDEX_MODIFIED`           | `M`    |                                                        |
| `MODIFIED`                 | `M`    |                                                        |
| `INDEX_ADDED`              | `A`    |                                                        |
| `INTENT_TO_ADD`            | `A`    |                                                        |
| `INDEX_DELETED`            | `D`    | also strikethrough; does NOT propagate to parent       |
| `DELETED`                  | `D`    | also strikethrough; does NOT propagate to parent       |
| `INDEX_RENAMED`            | `R`    |                                                        |
| `INTENT_TO_RENAME`         | `R`    |                                                        |
| `TYPE_CHANGED`             | `T`    |                                                        |
| `UNTRACKED`                | `U`    |                                                        |
| `IGNORED`                  | `I`    |                                                        |
| `INDEX_COPIED`             | `C`    |                                                        |
| `BOTH_DELETED`             | `!`    | conflict                                               |
| `ADDED_BY_US`              | `!`    | conflict                                               |
| `DELETED_BY_THEM`          | `!`    | conflict                                               |
| `ADDED_BY_THEM`            | `!`    | conflict                                               |
| `DELETED_BY_US`            | `!`    | conflict                                               |
| `BOTH_ADDED`               | `!`    | conflict                                               |
| `BOTH_MODIFIED`            | `!`    | conflict                                               |
| Submodule (synthetic)      | `S`    | from `decorationProvider.ts:102-106`                   |

Submodule decoration uses badge `'S'` + tooltip `'Submodule'` + `gitDecoration.submoduleResourceForeground`.

### Theme color IDs

| Status                             | Theme color ID                                       |
|------------------------------------|------------------------------------------------------|
| `INDEX_MODIFIED`                   | `gitDecoration.stageModifiedResourceForeground`      |
| `MODIFIED`, `TYPE_CHANGED`         | `gitDecoration.modifiedResourceForeground`           |
| `INDEX_DELETED`                    | `gitDecoration.stageDeletedResourceForeground`       |
| `DELETED`                          | `gitDecoration.deletedResourceForeground`            |
| `INDEX_ADDED`, `INTENT_TO_ADD`     | `gitDecoration.addedResourceForeground`              |
| `INDEX_COPIED`, `INDEX_RENAMED`, `INTENT_TO_RENAME` | `gitDecoration.renamedResourceForeground` |
| `UNTRACKED`                        | `gitDecoration.untrackedResourceForeground`          |
| `IGNORED`                          | `gitDecoration.ignoredResourceForeground`            |
| All 7 conflict statuses            | `gitDecoration.conflictingResourceForeground`        |
| Submodule                          | `gitDecoration.submoduleResourceForeground`          |

### Default color values (from `extensions/git/package.json:4115-4215`)

| Theme color ID                                  | Dark      | Light     |
|-------------------------------------------------|-----------|-----------|
| `gitDecoration.addedResourceForeground`         | `#81b88b` | `#587c0c` |
| `gitDecoration.modifiedResourceForeground`      | `#E2C08D` | `#895503` |
| `gitDecoration.deletedResourceForeground`       | `#c74e39` | `#ad0707` |
| `gitDecoration.renamedResourceForeground`       | `#73C991` | `#007100` |
| `gitDecoration.untrackedResourceForeground`     | `#73C991` | `#007100` |
| `gitDecoration.ignoredResourceForeground`       | `#8C8C8C` | `#8E8E90` |
| `gitDecoration.stageModifiedResourceForeground` | `#E2C08D` | `#895503` |
| `gitDecoration.stageDeletedResourceForeground`  | `#c74e39` | `#ad0707` |
| `gitDecoration.conflictingResourceForeground`   | `#e4676b` | `#ad0707` |
| `gitDecoration.submoduleResourceForeground`     | `#8db9e2` | `#1258a7` |

Inside a webview these can be read live from CSS variables that VSCode injects: `var(--vscode-gitDecoration-modifiedResourceForeground)` etc. (the dot becomes a hyphen). We should resolve through those vars so we follow whatever theme the user has, and only fall back to the hex defaults if a var is missing.

### Strikethrough

`extensions/git/src/repository.ts:246-257` — applied to: `DELETED`, `BOTH_DELETED`, `DELETED_BY_THEM`, `DELETED_BY_US`, `INDEX_DELETED`.

### Resource priority (when one file has multiple statuses, e.g. staged + working-tree)

`extensions/git/src/repository.ts:284-304`:

| Priority | Statuses                                                                  |
|----------|---------------------------------------------------------------------------|
| 1 (low)  | default (everything else)                                                 |
| 2        | `INDEX_MODIFIED`, `MODIFIED`, `INDEX_COPIED`, `TYPE_CHANGED`              |
| 3        | `IGNORED`                                                                 |
| 4 (high) | all 7 conflict statuses                                                   |

We probably won't need this; just show working-tree status first, then index. The 4 groups are checked in order at `decorationProvider.ts:124-127` (index, untracked, workingTree, merge).

---

## 6. External-extension consumption — code patterns

### Get the API

`extensions/git/src/api/git.d.ts:439-455` defines the entry point:

```ts
export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;  // throws if disabled
}
```

Standard activation:

```ts
const gitExtension = vscode.extensions.getExtension<GitExtension>('vscode.git');
if (!gitExtension) return;
const ext = gitExtension.isActive ? gitExtension.exports : await gitExtension.activate();
const api = ext.getAPI(1);
```

`api` is typed as `API` (`git.d.ts:407-437`) and gives us:

- `api.state: 'uninitialized' | 'initialized'`
- `api.onDidChangeState: Event<APIState>` — wait for `'initialized'` before listing repos
- `api.repositories: Repository[]`
- `api.onDidOpenRepository: Event<Repository>` / `onDidCloseRepository`
- `api.getRepository(uri: Uri): Repository | null` — find which repo a file belongs to

### Per-repository

Each `Repository` (`git.d.ts:236-328`):

- `repo.rootUri: Uri`
- `repo.state: RepositoryState` (lines 131-145):
  - `state.workingTreeChanges: Change[]`
  - `state.indexChanges: Change[]`
  - `state.untrackedChanges: Change[]`
  - `state.mergeChanges: Change[]`
  - `state.onDidChange: Event<void>` — **THIS is the event to subscribe to**. Backed by `Repository.onDidRunGitStatus`, fired once per `git status` refresh.

Each `Change` (`git.d.ts:111-122`):

```ts
interface Change {
  readonly uri: Uri;          // current path (or rename target)
  readonly originalUri: Uri;  // pre-rename path
  readonly renameUri: Uri | undefined;
  readonly status: Status;    // the enum from git.d.ts:87-109
}
```

The `Status` enum (`git.d.ts:87-109`) is what we map to letter/color in section 5.

### Minimal integration recipe

A working skeleton for an external VS Code extension that wants to know "for any file in the current workspace, what's the git status" and react to changes:

```ts
import * as vscode from 'vscode';
import type { GitExtension, API, Repository, Change, Status } from './git.d';

export interface GitStatusSnapshot {
  // path → status (we keep the "highest-priority" status per path)
  files: Map<string, Status>;
  // path of any dir that contains a changed file (for parent propagation)
  dirtyDirs: Set<string>;
}

export class GitStatusTracker implements vscode.Disposable {
  private api: API | undefined;
  private repoDisposables = new Map<Repository, vscode.Disposable>();
  private disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  public snapshot: GitStatusSnapshot = { files: new Map(), dirtyDirs: new Set() };

  async activate(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    const gitExtension = ext.isActive ? ext.exports : await ext.activate();
    if (!gitExtension.enabled) {
      this.disposables.push(gitExtension.onDidChangeEnablement(enabled => {
        if (enabled) void this.activate();
      }));
      return;
    }
    this.api = gitExtension.getAPI(1);

    const init = () => {
      this.api!.repositories.forEach(r => this.attach(r));
      this.disposables.push(this.api!.onDidOpenRepository(r => this.attach(r)));
      this.disposables.push(this.api!.onDidCloseRepository(r => this.detach(r)));
    };
    if (this.api.state === 'initialized') init();
    else this.disposables.push(this.api.onDidChangeState(s => { if (s === 'initialized') init(); }));
  }

  private attach(repo: Repository): void {
    const handler = () => { this.rebuild(); this._onDidChange.fire(); };
    handler();
    this.repoDisposables.set(repo, repo.state.onDidChange(handler));
  }

  private detach(repo: Repository): void {
    this.repoDisposables.get(repo)?.dispose();
    this.repoDisposables.delete(repo);
    this.rebuild();
    this._onDidChange.fire();
  }

  private rebuild(): void {
    const files = new Map<string, Status>();
    const dirtyDirs = new Set<string>();
    if (!this.api) { this.snapshot = { files, dirtyDirs }; return; }

    for (const repo of this.api.repositories) {
      const groups: Change[][] = [
        repo.state.indexChanges,
        repo.state.mergeChanges,
        repo.state.workingTreeChanges,
        repo.state.untrackedChanges,
      ];
      for (const group of groups) {
        for (const c of group) {
          const fsPath = c.uri.fsPath;
          // last-write-wins; check order above mirrors the git extension's group order
          files.set(fsPath, c.status);
          // walk up ancestors until we exit the repo root
          let dir = vscode.Uri.joinPath(c.uri, '..').fsPath;
          const root = repo.rootUri.fsPath;
          while (dir.startsWith(root) && dir !== root) {
            dirtyDirs.add(dir);
            const parent = vscode.Uri.joinPath(vscode.Uri.file(dir), '..').fsPath;
            if (parent === dir) break;
            dir = parent;
          }
          if (dir === root) dirtyDirs.add(root);
        }
      }
    }
    this.snapshot = { files, dirtyDirs };
  }

  dispose(): void {
    this.repoDisposables.forEach(d => d.dispose());
    this.disposables.forEach(d => d.dispose());
    this._onDidChange.dispose();
  }
}
```

Then in the file-tree renderer (host side, before posting to webview):

```ts
function decorationFor(path: string, snap: GitStatusSnapshot): {
  letter: string | undefined;
  colorVar: string | undefined;     // CSS var name like '--vscode-gitDecoration-modifiedResourceForeground'
  strikethrough: boolean;
  propagated: boolean;
} {
  const status = snap.files.get(path);
  if (status !== undefined) {
    return {
      letter: STATUS_LETTER[status],
      colorVar: STATUS_COLOR_VAR[status],
      strikethrough: STATUS_STRIKETHROUGH.has(status),
      propagated: false,
    };
  }
  if (snap.dirtyDirs.has(path)) {
    return { letter: undefined, colorVar: '--vscode-gitDecoration-modifiedResourceForeground', strikethrough: false, propagated: true };
  }
  return { letter: undefined, colorVar: undefined, strikethrough: false, propagated: false };
}
```

Where the `STATUS_*` tables are the literal cheat-sheet from section 5.

### Notes / gotchas

- We MUST also list `'vscode.git'` in our extension manifest's `extensionDependencies` (or guard with `getExtension`), otherwise activation ordering can give us `undefined`.
- The `getAPI(1)` call **throws** if the git extension is disabled — wrap in try/catch or check `gitExtension.enabled` first.
- Events fire on the **extension host thread**. To get rapid updates into the webview without flooding postMessage, debounce by ~100ms — the git extension itself debounces git invocations but `onDidChange` can still fire 2-3 times in quick succession during stage/unstage flows.
- `state.untrackedChanges` is gated by the user's `git.untrackedChanges` setting (`mixed` = bundled into working-tree, `separate` = own group, `hidden` = empty). Read both `workingTreeChanges` and `untrackedChanges` to be safe.
- Path keys: the extension returns `vscode.Uri` — use `.fsPath` for comparison with our tree node paths (which are filesystem paths). Watch out for case sensitivity on macOS/Windows.
- For the "propagated" parent badge, VSCode uses a codicon bubble dot (``, see `decorationsService.ts:117-120`). The simplest equivalent in our webview is a small colored dot rendered via CSS — no codicon needed.

---

## Cited file index

| Concern                            | File                                                                                                | Lines     |
|------------------------------------|-----------------------------------------------------------------------------------------------------|-----------|
| Workbench decoration data shape    | `src/vs/workbench/services/decorations/common/decorations.ts`                                       | 16-52     |
| Decoration storage + subtree walk  | `src/vs/workbench/services/decorations/browser/decorationsService.ts`                               | 219-414   |
| Extension-side FileDecoration type | `src/vs/workbench/api/common/extHostTypes.ts`                                                       | 2573-2605 |
| Ext → main thread bridge           | `src/vs/workbench/api/common/extHostDecorations.ts`                                                 | 41-117    |
| Main thread receiver / bubble wire | `src/vs/workbench/api/browser/mainThreadDecorations.ts`                                             | 90-110    |
| Explorer registers its provider    | `src/vs/workbench/contrib/files/browser/views/explorerView.ts`                                      | 811-814   |
| Explorer's intrinsic decorations   | `src/vs/workbench/contrib/files/browser/views/explorerDecorationsProvider.ts`                       | 18-82     |
| Per-row tree consumer / debounce   | `src/vs/workbench/browser/labels.ts`                                                                | 183-195, 366-381, 687-709 |
| Git extension: provider wrapper    | `extensions/git/src/decorationProvider.ts`                                                          | 100-167   |
| Git extension: ignore provider     | `extensions/git/src/decorationProvider.ts`                                                          | 25-98     |
| Git extension: submodule badge     | `extensions/git/src/decorationProvider.ts`                                                          | 102-106   |
| Resource.letter (status → 'M' etc) | `extensions/git/src/repository.ts`                                                                  | 56-89     |
| Resource.color (status → theme id) | `extensions/git/src/repository.ts`                                                                  | 116-149   |
| Resource.strikeThrough             | `extensions/git/src/repository.ts`                                                                  | 246-257   |
| Resource.resourceDecoration        | `extensions/git/src/repository.ts`                                                                  | 306-310   |
| onDidRunGitStatus emitter          | `extensions/git/src/repository.ts`                                                                  | 710-711   |
| onDidRunGitStatus fire             | `extensions/git/src/repository.ts`                                                                  | 2788-2796 |
| Public Status enum                 | `extensions/git/src/api/git.d.ts`                                                                   | 87-109    |
| Public Change shape                | `extensions/git/src/api/git.d.ts`                                                                   | 111-122   |
| Public RepositoryState shape       | `extensions/git/src/api/git.d.ts`                                                                   | 131-145   |
| Public API / GitExtension          | `extensions/git/src/api/git.d.ts`                                                                   | 407-455   |
| api1 → ApiRepositoryState wiring   | `extensions/git/src/api/api1.ts`                                                                    | 38-61     |
| Default theme color hex values     | `extensions/git/package.json`                                                                       | 4115-4215 |
