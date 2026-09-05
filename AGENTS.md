# AGENTS.md

## Git 推送网络失败时改用 GitHub REST API（本机环境规则）

本机直连 `github.com:443` 经常被重置（Connection reset / 连接超时），但 `api.github.com` 通常可达；本机**未安装 gh CLI**。远端仓库为 `EKD5-dg/ai-puzzle-play`（Cloudflare Pages，push 后自动部署）。

当 `git push` 因网络失败时，**不要反复重试**，改走 REST API 推送：

1. 连通性探测：`curl https://api.github.com/zen`，不通则直接报告用户。
2. 取令牌：`git credential fill`（stdin 传 `protocol=https\nhost=github.com`）从 Windows 凭据管理器读取，令牌**不写入任何文件**。
3. 用临时 Node 脚本（Node 22 自带 global fetch）复刻本地提交，**逐层与本地 SHA 比对**：
   - 远端 ref：`GET /repos/{owner}/{repo}/git/ref/heads/main`，必须等于本地提交的 parent，否则非快进，中止；
   - 解析本地提交：`git cat-file commit <sha>` 取 tree / parent / author / committer（epoch+时区）/ message；epoch+偏移转 ISO8601 时**保留原始时区偏移**（如 `+08:00`），不能用 UTC；
   - blob：`POST /git/blobs`，content 用 base64（`encoding: "base64"`），返回 sha 必须 === `git rev-parse <commit>:<path>`；
   - tree：自底向上（最深层目录先建）`POST /git/trees` 带 `base_tree`（从父提交沿路径取旧树），替换变更条目后**逐级向上传播到根**（祖先目录即使无直接变更也要重建）；每层与 `git rev-parse <commit>:<dir>` 比对，根树用 `git rev-parse <commit>^{tree}`（注意 `<commit>:` 和 `<commit>:`.` 都取不到根树）；
   - commit：`POST /git/commits`，message / author / committer 与本地完全一致，**断言返回 sha === 本地提交 SHA**；
   - 更新引用：`PATCH /git/refs/heads/main`（`force: false`），GET 复核后 `git update-ref refs/remotes/origin/main <sha>` 对齐本地跟踪引用，并删除临时脚本。
4. **任一层 SHA 不一致立即中止，不得更新远端引用**（否则本地与远端分叉）。

其他要点：

- 提交信息、文档风格沿用仓库惯例：中文、一行式 `type(scope): 描述`（参考 `git log`）。
- `ls` / `grep` / `tail` 等 Unix 命令在本机 shell 不可用，用 `dir` / `findstr` 替代。
