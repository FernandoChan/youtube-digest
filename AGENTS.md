# AGENTS.md

本项目是 Will 个人维护的 YouTube Digest Chrome 扩展 Fork（`origin` = `FernandoChan/youtube-digest`，`upstream` = `zarazhangrui/youtube-digest`）。

## 核心纪律
1. **主目录保护**：主目录（`main`）直接由 Chrome「加载已解压的扩展程序」加载用于日常使用；任何功能开发或重构必须在 Orca 中新开独立 Worktree，验证通过合并回 `main` 后再在 Chrome 中刷新扩展。
2. **交付前必跑验证**：
   - `node --test tests/*.test.js`（必须全绿）
   - `bash scripts/check-release.sh`（验证 Manifest 引用、安全白名单与零密钥泄漏）
3. **隐私与安全**：严禁提交任何真实 API Key（Supadata / Gemini / TokenRouter）、个人绝对路径或私有数据。
4. **同步上游**：需要同步原作者更新时，使用 `git fetch upstream` 并在独立分支解决冲突后再合并。
