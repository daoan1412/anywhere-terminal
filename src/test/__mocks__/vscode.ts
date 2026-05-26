// src/test/__mocks__/vscode.ts — Manual mock for the `vscode` module
// Used by Vitest via resolve.alias in vitest.config.mts
// Stubs only the subset of VS Code API used by our source code.

// ─── Disposable ─────────────────────────────────────────────────────

export const Disposable = {
  from(...disposables: ReadonlyArray<{ dispose: () => void }>) {
    return {
      dispose: () => {
        for (const d of disposables) {
          try {
            d.dispose();
          } catch {
            // mirror VS Code: swallow per-disposable errors so subsequent dispose still runs
          }
        }
      },
    };
  },
};

// ─── Uri ────────────────────────────────────────────────────────────

// Minimal RFC 3986-ish URI parser stub. Only the fields our code reads
// (scheme, authority, path, query, fragment, fsPath) are populated.
// `strict=true` throws if the input has no scheme — mirroring the contract
// of `vscode.Uri.parse(raw, true)` in the real extension host.
function parseUri(raw: string, strict?: boolean) {
  const schemeMatch = raw.match(/^([a-zA-Z][a-zA-Z0-9+.-]*):/);
  if (!schemeMatch) {
    if (strict) {
      throw new Error(`URI: no scheme in "${raw}"`);
    }
    return { scheme: "", authority: "", path: raw, query: "", fragment: "", fsPath: raw };
  }
  const scheme = schemeMatch[1].toLowerCase();
  let rest = raw.slice(schemeMatch[0].length);
  let authority = "";
  if (rest.startsWith("//")) {
    rest = rest.slice(2);
    const slashIdx = rest.indexOf("/");
    if (slashIdx >= 0) {
      authority = rest.slice(0, slashIdx);
      rest = rest.slice(slashIdx);
    } else {
      authority = rest;
      rest = "";
    }
  }
  let fragment = "";
  const hashIdx = rest.indexOf("#");
  if (hashIdx >= 0) {
    fragment = rest.slice(hashIdx + 1);
    rest = rest.slice(0, hashIdx);
  }
  let query = "";
  const qIdx = rest.indexOf("?");
  if (qIdx >= 0) {
    query = rest.slice(qIdx + 1);
    rest = rest.slice(0, qIdx);
  }
  const pathPart = rest;
  let fsPath = pathPart;
  if (scheme === "file") {
    try {
      fsPath = decodeURIComponent(pathPart);
    } catch {
      fsPath = pathPart;
    }
    // Strip the leading `/` from `/c:/foo` on Windows-style file URIs.
    if (/^\/[a-zA-Z]:/.test(fsPath)) {
      fsPath = fsPath.slice(1).replace(/\//g, "\\");
    }
  }
  return { scheme, authority, path: pathPart, query, fragment, fsPath };
}

export const Uri = {
  joinPath: (base: { fsPath: string }, ...pathSegments: string[]) => ({
    fsPath: [base.fsPath, ...pathSegments].join("/"),
  }),
  file: (path: string) => ({ fsPath: path }),
  parse: parseUri,
};

// ─── CancellationToken / Source ─────────────────────────────────────

export class CancellationTokenSource {
  // Internal state — held outside the token object so dispose() doesn't
  // wipe the cancelled flag from any reference the caller still holds.
  private _state = { cancelled: false, listeners: [] as Array<() => void> };
  token: {
    isCancellationRequested: boolean;
    onCancellationRequested: (listener: () => void) => { dispose: () => void };
  };
  constructor() {
    const state = this._state;
    this.token = {
      get isCancellationRequested() {
        return state.cancelled;
      },
      onCancellationRequested: (listener: () => void) => {
        if (state.cancelled) {
          // Real VSCode fires immediately if already cancelled.
          try {
            listener();
          } catch {
            // Best-effort.
          }
          return { dispose: () => {} };
        }
        state.listeners.push(listener);
        return {
          dispose: () => {
            const idx = state.listeners.indexOf(listener);
            if (idx >= 0) {
              state.listeners.splice(idx, 1);
            }
          },
        };
      },
    };
  }
  cancel(): void {
    if (this._state.cancelled) {
      return;
    }
    this._state.cancelled = true;
    const listeners = [...this._state.listeners];
    this._state.listeners.length = 0;
    for (const l of listeners) {
      try {
        l();
      } catch {
        // Best-effort.
      }
    }
  }
  dispose(): void {
    // Real VS Code keeps the cancellation flag readable after dispose;
    // the source just stops accepting new listeners. Mirror that here.
    this._state.listeners.length = 0;
  }
}

// ─── RelativePattern ────────────────────────────────────────────────

export class RelativePattern {
  base: string;
  baseUri: { fsPath: string };
  pattern: string;
  constructor(base: string | { fsPath: string } | { uri: { fsPath: string } }, pattern: string) {
    if (typeof base === "string") {
      this.base = base;
      this.baseUri = { fsPath: base };
    } else if ("fsPath" in base) {
      this.base = base.fsPath;
      this.baseUri = base;
    } else {
      this.base = base.uri.fsPath;
      this.baseUri = base.uri;
    }
    this.pattern = pattern;
  }
}

// ─── FileType ───────────────────────────────────────────────────────

export const FileType = {
  Unknown: 0,
  File: 1,
  Directory: 2,
  SymbolicLink: 64,
} as const;

// ─── Range ──────────────────────────────────────────────────────────

export class Range {
  start: { line: number; character: number };
  end: { line: number; character: number };
  constructor(startLine: number, startChar: number, endLine: number, endChar: number) {
    this.start = { line: startLine, character: startChar };
    this.end = { line: endLine, character: endChar };
  }
}

// ─── env ────────────────────────────────────────────────────────────

export const env = {
  appRoot: "/mock/vscode/app",
};

// ─── workspace ──────────────────────────────────────────────────────

/** Mock configuration store — maps section.key to value. */
let _mockConfigValues: Record<string, unknown> = {};

/** Default findFiles impl returns no matches. Override via __setFindFiles for per-test behavior. */
let _findFilesImpl: (
  include: string | RelativePattern,
  exclude?: string,
  maxResults?: number,
  token?: unknown,
) => Promise<Array<{ fsPath: string }>> = async () => [];

/** Mock configuration change handlers. */
const _configChangeHandlers: Array<(e: { affectsConfiguration: (section: string) => boolean }) => void> = [];

/** Creates a mock configuration object for a given section. */
function createMockConfiguration(section: string) {
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const fullKey = section ? `${section}.${key}` : key;
      const value = _mockConfigValues[fullKey];
      return (value !== undefined ? value : defaultValue) as T | undefined;
    },
    has: (key: string): boolean => {
      const fullKey = section ? `${section}.${key}` : key;
      return fullKey in _mockConfigValues;
    },
    update: () => Promise.resolve(),
    inspect: () => undefined,
  };
}

export const workspace: {
  workspaceFolders: Array<{ uri: { fsPath: string } }> | undefined;
  getConfiguration: (section?: string) => ReturnType<typeof createMockConfiguration>;
  onDidChangeConfiguration: (handler: (e: { affectsConfiguration: (section: string) => boolean }) => void) => {
    dispose: () => void;
  };
  onDidChangeWorkspaceFolders: (handler: () => void) => { dispose: () => void };
  fs: { stat: (uri: { fsPath: string }) => Promise<{ type: number; ctime: number; mtime: number; size: number }> };
  findFiles: (
    include: string | RelativePattern,
    exclude?: string,
    maxResults?: number,
    token?: unknown,
  ) => Promise<Array<{ fsPath: string }>>;
} = {
  workspaceFolders: undefined,
  getConfiguration: (section = "") => createMockConfiguration(section),
  onDidChangeWorkspaceFolders: (_handler) => {
    // Inert subscription — tests can drive root changes by setting `workspace.workspaceFolders`
    // directly and calling the provider's relevant code path.
    return { dispose: () => {} };
  },
  onDidChangeConfiguration: (handler) => {
    _configChangeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = _configChangeHandlers.indexOf(handler);
        if (idx !== -1) {
          _configChangeHandlers.splice(idx, 1);
        }
      },
    };
  },
  fs: {
    stat: async (_uri) => ({ type: 1, ctime: 0, mtime: 0, size: 0 }),
  },
  findFiles: (include, exclude, maxResults, token) => _findFilesImpl(include, exclude, maxResults, token),
};

// ─── extensions ─────────────────────────────────────────────────────

let _mockExtension: { packageJSON?: { version?: string } } | undefined;

export const extensions = {
  getExtension: (_id: string) => _mockExtension,
};

// ─── window ─────────────────────────────────────────────────────────

/** Creates a mock WebviewPanel for testing. */
function createMockWebviewPanel(
  _viewType: string,
  title: string,
  _showOptions: unknown,
  options?: { enableScripts?: boolean; retainContextWhenHidden?: boolean; localResourceRoots?: unknown[] },
) {
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const disposeHandlers: Array<() => void> = [];
  const viewStateHandlers: Array<(e: { webviewPanel: { visible: boolean } }) => void> = [];

  const panel = {
    title,
    visible: true,
    webview: {
      html: "",
      options: options ?? {},
      cspSource: "https://mock.csp.source",
      asWebviewUri: (uri: { fsPath: string }) => uri.fsPath,
      onDidReceiveMessage: (handler: (msg: unknown) => void) => {
        messageHandlers.push(handler);
        return { dispose: () => {} };
      },
      postMessage: (_msg: unknown) => Promise.resolve(true),
    },
    onDidDispose: (handler: () => void) => {
      disposeHandlers.push(handler);
      return { dispose: () => {} };
    },
    onDidChangeViewState: (handler: (e: { webviewPanel: { visible: boolean } }) => void) => {
      viewStateHandlers.push(handler);
      return { dispose: () => {} };
    },
    dispose: () => {
      for (const handler of disposeHandlers) {
        handler();
      }
    },
    // Test helpers
    __messageHandlers: messageHandlers,
    __disposeHandlers: disposeHandlers,
    __viewStateHandlers: viewStateHandlers,
  };
  return panel;
}

let _showQuickPickImpl: (items: readonly unknown[], options?: unknown) => Promise<unknown> = async () => undefined;

// ─── ColorThemeKind / theme bridge ──────────────────────────────────

export const ColorThemeKind = {
  Light: 1,
  Dark: 2,
  HighContrast: 3,
  HighContrastLight: 4,
} as const;

const _themeChangeHandlers: Array<(theme: { kind: number }) => void> = [];
let _activeColorTheme: { kind: number } = { kind: ColorThemeKind.Dark };

export const window = {
  showInformationMessage: () => {},
  showErrorMessage: (_msg?: string) => Promise.resolve(undefined),
  showWarningMessage: (_msg?: string, ..._rest: unknown[]) => Promise.resolve(undefined),
  showTextDocument: (_uri?: unknown, _opts?: unknown) => Promise.resolve({}),
  showQuickPick: (items: readonly unknown[], options?: unknown) => _showQuickPickImpl(items, options),
  createWebviewPanel: createMockWebviewPanel,
  registerWebviewViewProvider: (_viewType: string, _provider: unknown, _options?: unknown) => ({
    dispose: () => {},
  }),
  registerWebviewPanelSerializer: (_viewType: string, _serializer: unknown) => ({
    dispose: () => {},
  }),
  get activeColorTheme(): { kind: number } {
    return _activeColorTheme;
  },
  onDidChangeActiveColorTheme(handler: (theme: { kind: number }) => void) {
    _themeChangeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = _themeChangeHandlers.indexOf(handler);
        if (idx >= 0) {
          _themeChangeHandlers.splice(idx, 1);
        }
      },
    };
  },
  // tabGroups attached below — see Tab inputs + tabGroups section
  tabGroups: undefined as unknown as {
    activeTabGroup: { activeTab: { input?: unknown } | undefined };
    onDidChangeTabs: (h: (e: unknown) => void) => { dispose: () => void };
    onDidChangeTabGroups: (h: (e: unknown) => void) => { dispose: () => void };
  },
};

/** Test helper: change the active color theme and fire all subscribers. */
export function __setActiveColorTheme(kind: number): void {
  _activeColorTheme = { kind };
  for (const handler of [..._themeChangeHandlers]) {
    handler(_activeColorTheme);
  }
}

/** Test helper: how many onDidChangeActiveColorTheme listeners are currently attached. */
export function __getThemeListenerCount(): number {
  return _themeChangeHandlers.length;
}

// ─── ViewColumn ─────────────────────────────────────────────────────

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
};

// ─── Tab inputs + tabGroups ─────────────────────────────────────────

// Constructor-shaped stubs so production code can use `instanceof` checks
// (e.g. `tab.input instanceof vscode.TabInputText`).
export class TabInputText {
  constructor(public readonly uri: { scheme: string; fsPath: string }) {}
}
export class TabInputCustom {
  constructor(
    public readonly uri: { scheme: string; fsPath: string },
    public readonly viewType: string = "",
  ) {}
}
export class TabInputNotebook {
  constructor(
    public readonly uri: { scheme: string; fsPath: string },
    public readonly notebookType: string = "",
  ) {}
}
export class TabInputTextDiff {
  constructor(
    public readonly original: { scheme: string; fsPath: string },
    public readonly modified: { scheme: string; fsPath: string },
  ) {}
}
export class TabInputNotebookDiff {
  constructor(
    public readonly original: { scheme: string; fsPath: string },
    public readonly modified: { scheme: string; fsPath: string },
    public readonly notebookType: string = "",
  ) {}
}
export class TabInputTerminal {}
export class TabInputWebview {
  constructor(public readonly viewType: string = "") {}
}

type Tab = { input?: unknown; label?: string; isActive?: boolean };
type TabChangeEvent = { changed: readonly Tab[]; closed: readonly Tab[]; opened: readonly Tab[] };
type TabGroupChangeEvent = { changed: readonly unknown[]; closed: readonly unknown[]; opened: readonly unknown[] };

const _tabChangeHandlers: Array<(e: TabChangeEvent) => void> = [];
const _tabGroupChangeHandlers: Array<(e: TabGroupChangeEvent) => void> = [];

const _activeTabGroup: { activeTab: Tab | undefined } = { activeTab: undefined };

const tabGroups = {
  activeTabGroup: _activeTabGroup,
  onDidChangeTabs(handler: (e: TabChangeEvent) => void) {
    _tabChangeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = _tabChangeHandlers.indexOf(handler);
        if (idx >= 0) {
          _tabChangeHandlers.splice(idx, 1);
        }
      },
    };
  },
  onDidChangeTabGroups(handler: (e: TabGroupChangeEvent) => void) {
    _tabGroupChangeHandlers.push(handler);
    return {
      dispose: () => {
        const idx = _tabGroupChangeHandlers.indexOf(handler);
        if (idx >= 0) {
          _tabGroupChangeHandlers.splice(idx, 1);
        }
      },
    };
  },
};

// Wire onto the previously-declared window object so production code that
// reads `vscode.window.tabGroups` finds it.
(window as unknown as { tabGroups: typeof tabGroups }).tabGroups = tabGroups;

/**
 * Test helper: set the currently-active tab AND fire an onDidChangeTabs event.
 * Mirrors what VS Code does when the user switches tabs.
 */
export function __setActiveTab(tab: Tab | undefined): void {
  _activeTabGroup.activeTab = tab;
  const event: TabChangeEvent = { changed: tab ? [tab] : [], closed: [], opened: [] };
  for (const handler of [..._tabChangeHandlers]) {
    handler(event);
  }
}

/** Test helper: fire an onDidChangeTabGroups event (e.g. when a group becomes active). */
export function __fireTabGroupChange(): void {
  const event: TabGroupChangeEvent = { changed: [], closed: [], opened: [] };
  for (const handler of [..._tabGroupChangeHandlers]) {
    handler(event);
  }
}

/** Test helper: how many tab-change listeners are currently attached (both kinds combined). */
export function __getTabChangeListenerCount(): number {
  return _tabChangeHandlers.length + _tabGroupChangeHandlers.length;
}

// ─── commands ───────────────────────────────────────────────────────

export const commands = {
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({
    dispose: () => {},
  }),
  executeCommand: (_command: string, ..._args: unknown[]) => Promise.resolve(),
};

// ─── Test Helpers (for configuring mock state) ──────────────────────

/** Set mock workspace folders for testing. */
export function __setWorkspaceFolders(folders: Array<{ uri: { fsPath: string } }> | undefined): void {
  workspace.workspaceFolders = folders;
}

/** Set mock extension for testing. */
export function __setExtension(ext: { packageJSON?: { version?: string } } | undefined): void {
  _mockExtension = ext;
}

/** Set mock appRoot for testing. */
export function __setAppRoot(appRoot: string): void {
  env.appRoot = appRoot;
}

/** Set mock configuration values for testing. Keys should be fully qualified (e.g., "anywhereTerminal.fontSize"). */
export function __setConfigValues(values: Record<string, unknown>): void {
  _mockConfigValues = { ...values };
}

/** Fire a mock configuration change event. */
export function __fireConfigChange(affectedSections: string[]): void {
  const event = {
    affectsConfiguration: (section: string) =>
      affectedSections.some((s) => s === section || s.startsWith(`${section}.`)),
  };
  for (const handler of _configChangeHandlers) {
    handler(event);
  }
}

/** Set mock workspace.findFiles for testing. */
export function __setFindFiles(
  fn: (
    include: string | RelativePattern,
    exclude?: string,
    maxResults?: number,
    token?: unknown,
  ) => Promise<Array<{ fsPath: string }>>,
): void {
  _findFilesImpl = fn;
}

/** Set mock window.showQuickPick for testing. */
export function __setShowQuickPick(fn: (items: readonly unknown[], options?: unknown) => Promise<unknown>): void {
  _showQuickPickImpl = fn;
}

/** Reset all mock state to defaults. */
export function __resetAll(): void {
  env.appRoot = "/mock/vscode/app";
  workspace.workspaceFolders = undefined;
  _mockExtension = undefined;
  _mockConfigValues = {};
  _configChangeHandlers.length = 0;
  _findFilesImpl = async () => [];
  _showQuickPickImpl = async () => undefined;
  _themeChangeHandlers.length = 0;
  _activeColorTheme = { kind: ColorThemeKind.Dark };
  _tabChangeHandlers.length = 0;
  _tabGroupChangeHandlers.length = 0;
  _activeTabGroup.activeTab = undefined;
}
