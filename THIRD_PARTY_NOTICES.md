# Third-Party Notices

This product incorporates third-party material. See the `MANIFEST.json` in each vendored directory for per-file provenance.

---

## Microsoft Corporation — Visual Studio Code (`vs/base/browser/ui/list/` + transitive deps)

- **Source**: <https://github.com/microsoft/vscode>
- **Pinned commit**: `5aefa4caeb76874b77ba5b00075b4f4c37b59cf0`
- **Vendored at**: `src/vendor/vscode/`
- **Manifest**: `src/vendor/vscode/MANIFEST.json`
- **License**: MIT (text reproduced below — verbatim from upstream `LICENSE.txt`)

### Top-level vendored paths

- `src/vendor/vscode/base/browser/` — DOM helpers, event emitter, keyboard / mouse / touch events, drag-and-drop primitives, list widget UI (`ui/list/listWidget`, `listView`, `listPaging`, `list`, `rangeMap`, `rowCache`, `splice`, `media/list.css`, `media/scrollbars.css`)
- `src/vendor/vscode/base/common/` — disposables, async utilities, events, cancellation, errors, observable / observableInternal, arrays, URI, lifecycle (~75 files)
- `src/vendor/vscode/typings/` — vendored ambient declarations (`vscode-globals-product.d.ts`, `vscode-globals-ttp.d.ts`, `editContext.d.ts`)
- `src/vendor/vscode/nls.ts` — *our own* stub replacement for `vs/nls.ts` (no Microsoft copyright header)
- `src/vendor/vscode/typings/base-common-stub.d.ts`, `trusted-types-stub.d.ts` — *our own* stubs (no Microsoft copyright header)

### MIT License (verbatim from upstream `LICENSE.txt`)

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## Jesse Weed — Seti UI (file-icon font + theme mapping)

The file-tree panel renders file icons using the Seti UI icon font, vendored
via Microsoft's VS Code adaptation. The font and color/character mapping are
distributed as part of the `theme-seti` extension shipped with VS Code; the
underlying icon set was authored by Jesse Weed.

- **Upstream icon set**: <https://github.com/jesseweed/seti-ui> (MIT)
- **VS Code adaptation**: <https://github.com/microsoft/vscode/tree/release/1.96/extensions/theme-seti> (MIT)
- **Vendored at**: `src/vendor/seti/` (`seti.woff`, `vs-seti-icon-theme.json`)
- **License**: MIT (Jesse Weed — see below). VS Code's adaptation is dual-covered by Microsoft's MIT license reproduced above.

### Seti UI MIT License (reproduced verbatim from <https://github.com/jesseweed/seti-ui/blob/master/LICENSE.md>)

```
The MIT License (MIT)

Copyright (c) 2014 Jesse Weed

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS
FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER
IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN
CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```
