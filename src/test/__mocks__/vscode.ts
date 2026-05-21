// src/test/__mocks__/vscode.ts — Manual mock for the `vscode` module
// Used by Vitest via resolve.alias in vitest.config.mts
// Stubs only the subset of VS Code API used by our source code.

// ─── Uri ────────────────────────────────────────────────────────────

export const Uri = {
  joinPath: (base: { fsPath: string }, ...pathSegments: string[]) => ({
    fsPath: [base.fsPath, ...pathSegments].join("/"),
  }),
  file: (path: string) => ({ fsPath: path }),
};

// ─── CancellationToken / Source ─────────────────────────────────────

export class CancellationTokenSource {
  // Internal state — held outside the token object so dispose() doesn't
  // wipe the cancelled flag from any reference the caller still holds.
  private _state = { cancelled: false };
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
      onCancellationRequested: (_listener: () => void) => ({ dispose: () => {} }),
    };
  }
  cancel(): void {
    this._state.cancelled = true;
  }
  dispose(): void {
    // Real VS Code keeps the cancellation flag readable after dispose;
    // the source just stops accepting new listeners. Mirror that here.
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
};

// ─── ViewColumn ─────────────────────────────────────────────────────

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
};

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
}
