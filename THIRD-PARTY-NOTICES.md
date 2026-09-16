# Third-party notices

## Design reference (attribution)

The interface contract, the on-disk file layout and the interaction model of this
plugin were designed with reference to the **published behaviour** of an
MIT-licensed DSH plugin marketplace:

- npm package `dshmarket` · <https://github.com/dsh-market/dsh-market>
- Copyright (c) 2026 fkysly and dsh-market contributors
- Licensed under the MIT License (reproduced below)

No source file from that project is copied into this repository. Its internal
identifier systems — table, object, function, endpoint, entry, rule and module
names — are **not** reproduced here; that is enforced on every release by
`scripts/check-desensitization.mjs`, which runs on every release and in CI. Any
name this project shares with another product (route paths, state file names,
format identifiers) is this project's own naming choice, not a copied one.

This notice is kept at the repository root and is **not** part of the published
npm package (`package.json` `files` does not list it), so the guidance here is
available to maintainers without publishing a third party's name to users.

## MIT License (of the referenced project)

```
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

## This project

`dsh-plugin-galaxy` itself is MIT licensed; see `LICENSE`.
