---
topic: osc7-implementation
created-by: research for passive OSC 7 cwd tracking in a node-pty-hosted xterm.js terminal
date: 2026-05-21
libraries: [node-pty, xterm.js, vscode]
used-by: []
---

# Research: osc7-implementation

## Answers
- **Wire formats**: the stable form is `ESC ] 7 ; file://host/path ST`, where `ST` is either BEL (`\x07`) or `ESC \`. Real-world examples: Apple Terminal-style zsh hook emits `\e]7;%s\a` with a `file://...` URL; VTE/gnome-terminal emits `\033]7;file://%s%s\033\\`; iTerm2 docs define `OSC 7 [Ps] ST` as a `file://example.com/usr/bin` URI; VS Code parses `OSC 7 ; scheme://cwd ST` and also a proprietary `OSC 633 ; P ; Cwd=<value> ; <nonce> ST` path.
- **Encoding**: path components are percent-encoded. Apple’s hook encodes byte-by-byte; VTE uses `__vte_urlencode`; spaces become `%20`, unicode should be percent-encoded, not stored raw.
- **Parser invariants**: treat OSC as an untrusted stream, not line-delimited text. Keep a pending buffer across `onData` calls; only parse when both start and terminator are present. Bound buffer growth and ignore unknown/invalid URIs.
- **OSC 633**: yes, support it as an optional bonus. Pro: VS Code shell integration emits it and includes a nonce/trust signal. Con: it is proprietary and should not replace OSC 7. Recommendation: parse OSC 7 first; accept 633 when present, but keep cwd updates best-effort and untrusted.
- **Zero-config landscape**: fresh macOS Terminal/zsh is effectively yes because Apple ships `/etc/zshrc_Apple_Terminal` and zsh is the default shell on Catalina+. Ubuntu/Arch bash is no by default in non-login shells because VTE’s `/etc/profile.d/vte.sh` is often only sourced for login shells. Fish is yes: fish emits OSC 7 automatically in interactive sessions.
- **Reverse-DOS**: a malicious program can spoof cwd updates, but the impact is limited to misleading UI/state. Do not open files from OSC 7 without workspace validation; sanitize and normalize the path before storing, and keep later file-open confirmation as the real defense.

## Recommended Approach
- Implement a tiny state machine in Node that recognizes `\x1b]7;`, buffers across chunks, and accepts either `\x07` or `\x1b\\`.
- Parse only `file:` URIs, decode percent-encoding safely, reject control chars, and store a normalized string.
- Support OSC 633 opportunistically, but never depend on it for correctness.

## Minimal parser sketch
```ts
let pending = '';
export function onData(chunk: string, updateCwd: (cwd: string) => void) {
  pending += chunk;
  for (;;) {
    const s = pending.indexOf('\x1b]7;');
    if (s < 0) { pending = pending.slice(-8); return; }
    const rest = pending.slice(s + 4);
    const bel = rest.indexOf('\x07');
    const st = rest.indexOf('\x1b\\');
    const e = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (e < 0) { pending = pending.slice(s); return; }
    const raw = rest.slice(0, e);
    pending = rest.slice(e + (e === st ? 2 : 1));
    if (!raw.startsWith('file:')) continue;
    try {
      const u = new URL(raw);
      const cwd = decodeURIComponent(u.pathname);
      if (!/[\x00-\x1f\x7f]/.test(cwd)) updateCwd(cwd);
    } catch {}
  }
}
```

## Confidence
- **High** for VS Code/VTE/fish behavior; **medium** for Apple’s exact shipped hook text because the public docs mirror the behavior but don’t always print the exact file contents.

## Sources
- https://github.com/microsoft/vscode/blob/main/src/vs/platform/terminal/common/xterm/shellIntegrationAddon.ts
- https://github.com/GNOME/vte/blob/master/src/vte.sh.in
- https://iterm2.com/documentation-escape-codes.html
- https://github.com/valpackett/zshuery/blob/master/zshuery.sh
- https://deepwiki.com/fish-shell/fish-shell/5.6-prompt-system
- https://support.apple.com/guide/terminal/change-the-default-shell-trml113/mac
- https://gnunn1.github.io/tilix-web/manual/vteconfig/
- https://github.com/gnachman/iterm2/-/issues/4266
