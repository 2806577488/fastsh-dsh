# 发布与收录

仓库：<https://github.com/2806577488/fastsh-dsh>
当前版本：`v1.9.7`

## 安装

```
dsh plugin add git+https://github.com/2806577488/fastsh-dsh.git#v1.9.7
```

`git+` 源要求用户机器上装有 git；没有 git 的用户暂时装不了，等有 npm 包再解决。

## 更新流程

1. 改代码，提升 `package.json` 的 `version`
2. 提交并打 tag `vX.Y.Z`
3. 市场索引由 GitHub Actions 每天 03:17 UTC 重建；jsDelivr 边缘缓存最长 12 小时

## 市场收录

已向 `awesome-dsh-plugin/awesome-dsh-plugin` 提交 PR（#17567），分类 **Tools & Capabilities**，条目按 owner 字母序插入。

维护者会逐条回源核对描述，核对点就是这里写的：

- 普通命令走 cmd.exe；常见 PowerShell 在 Node 原生子集里执行（毫秒级）
- 子集之外才回退 Windows PowerShell
- 替换 `pwsh` 工具，输出写 UTF-8 无 BOM
- 删除护栏：受保护根目录、变量插值/通配符/空路径直接拒绝，不回退
- 原生糖：`Get-FileHash`、`ConvertFrom-Json`、`Resolve-Path`、`Select-Object -Unique`、
  `Format-Table` 透传、`-ErrorAction`（不抑制护栏拒绝）
- 安装需要 git

## 文件说明

| 文件 | 作用 |
|---|---|
| `index.js` | Host 插件：注册 `fastsh` 工具、禁用 `pwsh`、system prompt 规则 |
| `src/exec.js` | 进程执行、编码解码、超时杀树、jobs 集成 |
| `src/ps.js` | 原生 PowerShell 子集（含删除护栏与原生糖） |
| `cordis.patch.yml` | bundle 补丁，插入一行 `fastsh` |
| `test/` | 5 套回归，共 200+ 项 |
