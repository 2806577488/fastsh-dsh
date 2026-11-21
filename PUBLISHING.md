# 发布到 GitHub 并进入 DSH 插件市场

这个目录就是仓库根目录，内容可直接上传。

## 1. 建仓库

GitHub 网页 → New repository → 名字 `dsh-fastsh` → **Public** → 不要勾 README（会和这里的冲突）。

## 2. 上传内容

仓库页 → **Add file → Upload files**，把本目录**里面的内容**（不是这个目录本身）拖进去：
`index.js`、`src/`、`locale/`、`cordis.patch.yml`、`icon.svg`、`package.json`、`README.md`、`LICENSE`、`.gitignore`、`PUBLISHING.md`。
Commit。

## 3. 拿到安装地址

仓库页右上角 **Code → Local → HTTPS** 得到 `https://github.com/<你>/dsh-fastsh.git`。
市场条目会把它固定到某个 commit，所以建议先打一个 tag：

```
https://github.com/<你>/dsh-fastsh/releases/new?tag=v1.3.0
```

安装地址形如：

```
git+https://github.com/<你>/dsh-fastsh.git#v1.3.0
```

## 4. 自测安装

在另一个 profile 里试装（不要装到当前 profile）：

```
dsh plugin --profile test add "git+https://github.com/<你>/dsh-fastsh.git#v1.3.0"
```

装好后新开一个会话，确认 `fastsh` 工具出现、并且 `pwsh` 被禁用。

> 注意：`git+` 源要求用户机器上安装了 git。没有 git 的用户装不了，这是 GitHub-only 方案的固有代价。

## 5. 提交收录（PR）

目标仓库：`awesome-dsh-plugin/awesome-dsh-plugin`，文件是 `README.md`，分类选 **Tools & Capabilities**。

在分类下加一行（只加一行，描述保持一句话事实陈述）：

```markdown
- [<你>/dsh-fastsh](https://github.com/<你>/dsh-fastsh) - Windows shell tool for DSH that runs commands through cmd.exe and a native Node implementation of common PowerShell (Get-ChildItem, Get-Content, Select-String, Get-Process, Get-Date, pipelines, redirection) in milliseconds, falling back to Windows PowerShell only outside that subset; replaces the pwsh tool and writes BOM-free UTF-8. Windows only.
```

他们的评审标准（原文）：能 `dsh plugin add` 安装、行为与一句话描述一致、分类正确、有人在维护。提交前会逐条回源核对，描述里写的数字会被清点——所以上面这句尽量别夸张。

## 6. 生效时间

市场索引由 GitHub Actions 每天 03:17 UTC 重建。PR 合并后，最迟次日能在 **插件 → 发现** 里搜到；jsDelivr 边缘缓存最长 12 小时。

## 以后更新

改代码 → 提升 `package.json` 的 `version` → 打新 tag → 索引重建后市场会显示新版本。版本号必须是合法的 semver，且 commit 要能装。

## 可选：补 repository 字段

知道仓库地址后，在 `package.json` 里补上：

```json
"repository": { "type": "git", "url": "https://github.com/<你>/dsh-fastsh.git" }
```
