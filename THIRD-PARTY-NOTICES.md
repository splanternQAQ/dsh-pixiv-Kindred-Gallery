# 第三方组件与许可声明

本项目采用 **MIT License**（见 [LICENSE](LICENSE)）。v1.7.0 及以前的版本同样按 MIT 发布，许可证不做追溯变更。

以下第三方组件/依赖的版权与许可归原作者所有；本项目只使用其公开接口，或在明确标注的情况下内嵌代码。

## gifenc 1.0.3

- 用途：浏览器端把动图帧编码成 GIF（内嵌于 `client.js`）。
- 来源：https://github.com/mattdesl/gifenc
- 许可：MIT

```text
The MIT License (MIT)
Copyright (c) 2017 Matt DesLauriers

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

## playwright-core

- 用途：账号密码登录时驱动本机浏览器；作为依赖安装，不内嵌源码。
- 来源：https://github.com/microsoft/playwright
- 许可：Apache License 2.0

## React

- 用途：插件前端由 DSH 宿主提供 React 运行时，本项目不打包 React 源码。
- 来源：https://github.com/facebook/react
- 许可：MIT

## 仅作思路参考、未复制代码的项目

以下项目只在算法、交互或工程取舍上提供参考，本项目未复制其源代码：

implicit、LightFM、TagRec、RecBole、PixivBatchDownloader、PixivPreviewer、
Ghost-Downloader-3、aria2、pixiv/zip_player、dsh-bili-scroll、dafayu-pixiv-duty、
TanStack Virtual、react-window、masonic、sharp、modern-web-guidance、
MiniSearch、Fuse.js、compromise、LangChain.js、LlamaIndex.TS。

## 代码审计结论

- 对 `PixivBatchDownloader`（GPL-3.0，唯一一个 JS/TS 的 GPL 项目）做了源码归一化 token 比对：去注释、去字符串后，**20 个 token 以上的连续重合为 0**。
- `TagRec`（AGPL-3.0）、`Ghost-Downloader-3`（GPL-3.0）、`aria2`（GPL-2.0 系）是 Python/C++ 项目，本仓库没有对应源码、移植文件或二进制调用。
- 全仓库 GPL/AGPL 字样只出现在致谢墙和 `lib/rank.mjs` 的参考注释里。
- 唯一内嵌的第三方代码是 gifenc（MIT），已在上方保留完整许可文本。
- `PixivPreviewer` 未声明许可证；在获得明确授权前不要复制其代码。

## 如果未来要复制 GPL/AGPL 代码

MIT 与 GPL 不是“随便混”的关系：

- 复制 GPL-3.0 代码后，分发包含它的整体通常需要按 GPL-3.0 提供完整对应源码，不能只按 MIT 分发。
- GPL-2.0-only 与 GPL-3.0 不兼容；aria2 需先确认是否为 “or later”。
- AGPL-3.0（TagRec）会进一步要求网络使用时的源码提供义务，通常会把整体拉到 AGPL。
- 最稳妥的做法不是“复制后补声明”，而是**不复制**：只借鉴思路，自己重写实现。

本项目目前没有复制上述强 copyleft 项目的代码。
