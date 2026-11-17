# Agent 维护指南：发布与隐私检查

> 来源：`AGENTS.md`（main `baa4823acfe6a6ddeadae9bc3459dd723bf4d31e`）原文，按维护场景重新编排。命令和文件路径仅在本文及对应专题查阅，root 入口只保留硬约束和触发链接；行号为源文件原始行号，原文语义与命令保持可追踪。

## 原文 132–162 行

## GitHub Distribution And Local Packages
GitHub is the only public release and version source. The root `package.json` must keep `private: true`; do not run `npm publish`, add Registry publishing configuration, publish compatibility mirrors, or add legacy command aliases back to `bin`.

The package name `werelay` is retained only as the local tarball and installed CLI identifier. npm remains a build tool:
1. Inspect the real diff and identify user-visible and breaking changes.
2. Update `package.json`, `package-lock.json`, `bun.lock`, README, and the current release note when the product version changes.
3. Run `npm run quality`.
4. Run `npm pack --dry-run --json` and inspect the tarball contents and size.
5. Run `npm run smoke:global -- --purge-global --clean-cache`; use `--full` for the full release path.
6. Install and deploy the reviewed `npm pack` tarball; never substitute a Registry download.
7. Verify the GitHub remote SHA and the installed package version.

Do not describe npm Registry as an installation, update, or release channel for WeRelay. Third-party Agent installation commands that legitimately use npm are unaffected.

## Multi-Agent Git And Release Ownership
WeRelay may be edited by multiple Agents at the same time. Every ordinary development Agent must work in its own branch and worktree, preserve existing dirty state, stage only explicitly owned files, and finish with scoped validation, explicit local commits, and verified integration into the latest local `main`. The requirement owner resolves conflicts and reruns affected checks before safely fast-forwarding local `main`; concurrent landings must be serialized and must never overwrite another worktree or discard main advances. Development Agents must not push, create tags, bump the public version, run `npm publish`, deploy shared environments, or perform any GitHub write operation.

Before modifying any file, every Agent must first check the repository up to the latest state and record the baseline SHA; repeat that check whenever the task, branch, or worktree changes. This repository has no GitHub remote configured — GitHub writes happen only on the dedicated publishing server — so "latest state" means the newest local branches, worktrees, and commits, not `git fetch`. If the baseline branch has moved, rebase or reopen the worktree onto the new baseline before editing rather than continuing from a stale one. See `docs/开发协作/多Agent协作规范.md` for the exact commands.

Development and release are the only two roles. A development Agent validates, commits, lands the requirement into local `main` and registers both full SHAs as landed but not deployed; it never deploys automatically. Only an explicit user request starts a batch deployment or GitHub publication, serialized by one release Agent.

The release Agent locks a committed local `main` SHA in an isolated release worktree and runs release gates. It does not collect requirement branches, cherry-pick unlanded work, or recover missing development commits during release. Unlanded and dirty work is recorded and preserved for its owner, excluded without blocking the release. Release-only metadata commits must also be safely landed into local `main` before packaging; if main advances, integrate the latest main and rerun affected gates before refreezing. Never package an uncommitted shared tree. Use one plain `1.x.x` version for source, tarball, local installation, Relay and GitHub. Increment only the last number for every new artifact; do not create new preview/rc versions or overwrite an allocated version with different content. Deployment and GitHub publication remain separately authorized operations, not separate version lines. Historical prerelease support stays read-only for compatibility.

GitHub writes, fetch, public commits, candidate-branch CI, fast-forward main, tags and remote verification run only on the publishing server. No Mac push fallback. Real Agent/ClawBot acceptance belongs to the user; report pending honestly without inventing a separate wait before an explicitly authorized publication.

Chinese release notes are the user-facing source of truth. Write them in plain, non-technical Chinese: describe what users can now do, what visible problem was fixed, whether any action is required, and what limitations remain. Keep class names, fields, file paths, commit SHAs, test commands, and implementation details in the technical report or commit body, not in the public change record. Follow `docs/开发协作/多Agent协作规范.md`, `docs/发布/体验部署与正式发布.md`, `docs/发布/对外发布操作手册.md`, and `docs/发布/版本记录/中文版本说明模板.md`.

## 仅 GitHub 发布边界
用户明确要求“发布，不要部署”时，不安装、不重启、不修改公网服务、不推进活动运行基线；公开版本必须有完整审查和门禁证据，用户体验状态单独如实记录。发布授权不自动包含部署。面向已安装用户的 ClawBot 更新检测包含已发布的正式及预发布 Release；提醒本身不安装，只有用户明确回复“更新”才下载对应 tag 源码、构建 tarball 并安装，不自动重启，不从草稿、裸 tag 或 main 分支安装。旧运行端必须先安装此能力才会生效；这不授予开发 Agent 部署或发布权限。

## Release Process
## 原文 163–187 行

- Development completion requires scoped self-tests, explicit commits, verified integration into latest local `main`, and registration of requirement and main SHAs. A commit alone is incomplete delivery. It does not automatically authorize deployment or wake the release Agent. Only an explicit user request starts a batch deployment, owned by one release Agent. Report landed-but-not-deployed work clearly; never claim deployment until the same candidate tarball is installed and verified. Documentation-only, test-description or CI-maintenance commits do not restart runtime services when packaged runtime behavior is unchanged.
- Deployment is not GitHub publication. Both use the same plain `1.x.x` version and immutable tarball; record source SHA and tarball SHA-256, retain a rollback artifact, and report actual installed and published states separately.
- If any source or packaged content changes during observation, create and validate a new commit, land it into local `main`, rerun the complete release gates, rebuild and redeploy a new candidate, and restart the observation baseline. Rolling back a service must not delete or rewrite Git history.
- Only an explicit user instruction to publish a GitHub version authorizes public writes. Review all completed commits, run full gates and disclose pending user experience. A combined publish-and-deploy request may complete both operations with one artifact; it does not require a separately numbered preview.
- Keep README focused on product relationships and the shortest successful setup; move command matrices and advanced configuration into `docs/`.
- Add one release note for the current public baseline instead of rewriting historical release notes to pretend they used the new name.
- For the public repository, export a privacy-checked snapshot and create a clean Git history; do not push this private development history directly.
- GitHub fetch, commit, push, tag, and remote verification for the maintained public repository must run on the configured publishing server. The developer Mac may validate and upload a privacy-reviewed snapshot to that server over SSH, but must never fall back to a direct GitHub push.
- The publishing server must push the public commit to a one-time candidate branch first, wait for Secret scan plus Linux, macOS, and Windows quality checks, then fast-forward the same SHA to protected `main`. The public release Agent must also verify the latest CI run triggered by the `main` push.
- Protected `main` must keep strict required checks for `Secret scan` and all three quality jobs, with force pushes and deletion disabled. Do not weaken this rule to bypass a failed release.
- The publishing server must use an isolated WeRelay directory, reject non-fast-forward updates, verify the final remote SHA, and avoid touching unrelated server projects.
- If the change only updates repository policy, CI, or release documentation and does not affect runtime files, validate, commit and land into local `main`, but do not bump the product version or redeploy the Relay unless the user explicitly requests that repository-only content be published.

<!-- range boundary: lines 132-162 end before next section -->

## Commit And PR Guidance
Use Conventional Commit prefixes such as `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `build:`, and `chore:`. Keep subjects imperative and behavior-focused, for example `fix: preserve daemon visible companion occupancy`.

PRs should describe:
- affected adapter(s) or runtime area;
- user-visible behavior change;
- migration or compatibility impact;
- commands run;
- relevant WeChat output or terminal snippets for approval, onboarding, daemon switching, or message formatting changes.

Before committing, inspect `git status --short --ignored`. Do not commit ignored local runtime state. If the user explicitly wants the double logs committed, force-add `log.md` and `git-log.md`.

