# 更新记录

## v1.9.1

- 新增 PATH 覆盖提醒：`set "PATH=..."` / `setx PATH` / `$env:PATH = "..."` 未带上
  `%PATH%` / `$env:PATH` 时，结果最前面提示"整体覆盖"；追加写法不提示。
- 提示词补充命令构造规则：按字节大小或哈希验证产物（不要用 `dir` 名称匹配）、
  不要整体覆盖 PATH、多设备工具传 `-s`、等待优先用目标自身的 sleep
  （`adb shell sleep 1`，实测比启动 PowerShell 省约 1.6 s）。
- 测试：exec 用例 67 → 74（PATH 提醒 7 项）。

## v1.9.0

- 路径参数现在和 `valueOf` 一样展开 `$HOME` / `$env:X` / `$PWD`；仍无法精确展开的
  `$` 引用（如 `"$HOME\Documents"`）回退真实 PowerShell，不再把 `$HOME` 当目录名。
- `$HOME` 拿不到值时显式回退（此前静默成空串，路径可能落到当前目录）。
- `Remove-Item` 增加静态路径护栏：盘符/共享根、系统与用户根、DSH 目录、cwd 及其祖先
  直接拒绝（子目录照常可删）；`-WhatIf` 只预览、`-Confirm` 拒绝；缺 `-Path` 或空路径
  不再把 cwd 当目标。
- 删除目标必须静态可解析：含变量插值、通配符、空/未定义变量的删除直接拒绝而**不回退**
  真实引擎（回退等于绕开护栏）；精确引用照常展开并过关。`File.Delete` 与
  `Directory.Delete`（改为原生实现）走同一解析与护栏。
- 结果 `warnings` 增加删除类提醒：递归/强制删除时提示，走原有 warnings 管道。
- watch 在 `mtime` + 字节数未变时复用命令前哈希，不再整读第二遍（保住 mtime 的写入
  会判为未变化，属纯性能取舍）。
- 单对象管道送入 `Select-Object` / `Where-Object` / `ForEach-Object` / `Sort-Object` /
  `Measure-Object` 不再报 `values.map is not a function`。
- 面向模型/ token 收紧：拒绝信息统一 `fastsh:` 前缀、一句"原因 + 下一步"；工具 schema
  与系统提示去重压缩，每轮固定开销约 2380 → 1360 tokens。
- 原生化一批"要拼语句"的能力（少写输入、不落回真引擎）：`Get-FileHash`（SHA256/SHA1/MD5，
  可接管道）、`ConvertFrom-Json`、`Resolve-Path`、`Select-Object -Unique`、
  `Format-Table/List/Wide` 与 `Out-String` 透传、`-ErrorAction SilentlyContinue/Ignore`
  （`-EA` 别名；真实错误可抑制，护栏拒绝不可抑制）。

## v1.8.8

- `conclude_turn` 默认改为 `false`：后台任务启动后回合继续，模型必须先说明在跑什么、完成后再汇报；只有显式 `conclude_turn: true` 才立即结束回合。旧的默认值会让回合以"只有一个 job id"结束，表现为不回应。

## v1.8.7

- 提示词修正后台任务用法：30 秒是上限不是默认，短命令留在前台；起后台任务前先给用户一句说明，避免回合以"只有一个 job id"结束（表现为不回应）；收到完成通知后在同一回合汇报，而不是再起一个 job。

## v1.8.6

- 测试可在克隆目录直接运行：不再依赖工作区路径（`fastsh/...`），一律相对包根，夹具放 `test/tmp-*`。`git clone && npm test` 现在能过。

## v1.8.5

- 仓库补齐 `test/perf.test.mjs` 与 `test/lurk.cjs`：此前只存在于本地，clone 下来跑不了完整测试与性能守卫。
- 同版本发布交付包 `fastsh-1.8.5-kit.zip`（插件源码 + 仓库快照 + 离线安装包 + 文档），附在 GitHub Release 里。

## v1.8.4

- 提示词明确内容搜索走内置 `grep`（ripgrep），不要用 `Select-String` 或 `Get-ChildItem -Recurse | Select-String`（慢路径）；`Select-String` 只用于过滤命令自身的输出。

## v1.8.3

- 修正等待写法：不再推荐 `ping`（会弹控制台窗口）；`timeout /t` 在 fastsh 下必定失败（stdin 被重定向）。改用 `powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds N"`，并优先用后台任务代替前台睡眠。

## v1.8.2

- 系统提示加入命令构造规则：用 `&&` 而不是 `&`；等待用 `ping`/`timeout`；不要前台 sleep 轮询；判断文件是否变化用秒级 mtime/哈希而不是 `ls -l`；不要用 `powershell -Command` 包一层 cmd。

## v1.8.1

- 后台任务卡片恢复显示具体命令：`label` 使用命令本身，不再被工具描述覆盖。
- 后台任务在进程退出 1.5 秒内 settle，不会被仍持有管道的孙进程拖住。

## v1.8.0

- 递归搜索跟随 junction / 符号链接目录，并用 realpath 环检测避免死循环。
- 过滤正则只编译一次；递归时跳过逐层排序；`-Name` 不再对每个条目 `statSync`。
- `Get-ChildItem ... | Select-Object -First N` 命中即停。
- 系统提示补充"找文件"的推荐用法。

## v1.7.0

- `Get-ChildItem -Name` 走快路径：System32（约 5000 项）1099 ms → 46 ms。
- `Select-String` 改为 1 MB 分块流式读取：10 MB / 20 万匹配 113 ms → 45 ms。
- `Get-Content -Tail/-TotalCount` 只读所需窗口，不再整文件加载。

## v1.6.0

- 原生引擎移入 worker 线程：4.2 秒递归列目录不再冻结宿主，事件循环最大阻塞 374 ms → 18.7 ms。
- 原生调用超时（`min(timeoutMs, 60s)`）直接 terminate worker，灾难性正则返回 `timedOut` 而不是卡死。
- 修复后台任务忽略 `logFile` 的问题。

## v1.5.1

- 工具描述补全原生子集清单，并注明后台任务总是启动真实进程、长日志优先用 `logFile`。

## v1.5.0

- 新增 `logFile` 参数：完整原始输出落盘，不受 job 环形缓冲限制。
- 原生子集补充 `Tee-Object`、`Out-File` 等常用命令。

## v1.4.2

- `run_in_background` 成为长命令的强制要求：超过约 30 秒必须后台执行，不允许用 `timeoutMs` 硬扛。
- README / PUBLISHING 改为安装与收录说明。

## v1.4.1

- 首个公开版本：cmd.exe 加 Node 原生 PowerShell 子集，输出按 UTF-8 / GBK 自适应解码，替换 `pwsh` 工具，后台任务接入 DSH jobs。
