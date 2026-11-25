# 更新记录

## v1.10.0

- 新增可选的持久 PowerShell 宿主：`FASTSH_REUSE_ENGINE=1` 时保留一个常驻
  `powershell.exe`，每条命令在全新作用域执行（`& { … }`）、每条命令前设置工作目录、
  结束后还原环境变量。本机实测第二次回退从 ~2 s 降到 **7 ms**（首次仍付宿主启动 ~2 s）。
  - `exit N` 会结束宿主：用宿主退出码 + 已写盘的输出报告结果，下次调用自动起新宿主。
  - 超时杀掉宿主并返回 `timedOut`，下一条命令重新拉起。
  - 不隔离模块/类型与进程级设置（如 `[Console]` 编码），这是它快的原因；默认关闭，
    一次性进程语义不变。usage log 新增 `engine: "powershell-reused"`。
- 测试：新增 `test/reuse.test.mjs`（13 项：作用域、环境、cwd、退出码、超时、恢复、
  开关关闭时的回退行为），7 套 301 项全绿。

## v1.9.8

- 新增使用记录（usage log）：每次执行追加一行 JSON 到
  `%LOCALAPPDATA%\dsh-fastsh\usage.jsonl`（5 MB 轮换），记录 `engine` / `path` /
  耗时 / 退出码 / 输出规模 / 命令文本（≤2 KB）/ `agentId` / `callId` / `description`。
  覆盖前台、后台 job、分离进程，以及被拒绝的调用（空命令、被拦下的 `pwsh`）。
  `FASTSH_USAGE_LOG=off` 关闭，`FASTSH_USAGE_LOG=<路径>` 改位置；写日志失败被吞掉，
  不影响命令本身。
- 原生子集现在回报拒绝原因：`runNativePowerShell` 把原因写进 `context.unsupported`
  （`<`、`@{}`、未知 cmdlet、注册表非标量键…），worker 回传给宿主，于是降级原因
  能落进 `fallbackReason`——这份数据直接说明原生子集下一步该补什么。
- 测试：新增 `test/usage.test.mjs`；6 套 288 项全绿。测试套件内 `FASTSH_USAGE_LOG=off`，
  跑测试不会污染真实日志。

## v1.9.7

- 修长脚本直接崩：`powershell.exe` 的命令行超过约 4 KB 就 fail-fast（exit `0xc0000409`、
  **无 stderr、无输出**），而 `-EncodedCommand` 是 UTF-16 脚本的 4/3，约 1.5 KB 的脚本就会撞上。
  现在 encoded 超过 3000 字符改走临时 `.ps1`（UTF-8+BOM）+ `-File`，实测 50 KB 脚本正常；
  临时文件在子进程结束时删除（后台 job 在 settle 时删）。
- 修多行 cmd 的语义：以前把换行替换成 ` & `，`if (...)` 块直接报「此时不应有 &。」，
  `set X=one` + `echo %X%` 输出字面量 `%X%`（`%VAR%` 在整行解析时就展开了）。
  现在多行命令落临时 `.bat`（`@echo off`，含非 ASCII 时加 `chcp 65001`）再 `cmd /c`，
  行语义、块、退出码都对；单行命令仍是直传。
- 剥掉 PowerShell 5.1 的 CLIXML 外壳：stderr 被重定向时错误记录会被包成
  `#< CLIXML … _x000D__x000A_`，一条 200 字节的错误回来 750 字节 XML。前台结果与 job 流
  都还原成普通文本。
- 原生路径不再为空结果生成临时脚本文件（`execute` 先分流 native 结果）。
- 测试：exec 87 → 92（多行 cmd 3 项、长脚本 1 项、CLIXML 1 项）；5 套 270 项全绿。

## v1.9.6

- 修「快而错」的一类静默错：非文件系统盘符的路径（`HKLM:`、`HKCU:`、`Cert:`、`Env:`、`WSMan:`）
  以前会被拼到 cwd 后面，`Test-Path 'HKLM:\…'` 1 ms 内返回 `False`、`Get-Item`/`Get-ChildItem`
  报 `ENOENT 'C:\cwd\HKLM:\…'`——脚本据此判断“键不存在”会做错事。现在统一回退真引擎。
- 注册表 PSDrive 只读原生支持（`reg.exe` 支撑，约 20 ms）：`Test-Path`（含 `-PathType`）、
  `Get-ItemProperty`（`-Name` 或整键标量值，`REG_SZ/EXPAND_SZ/DWORD/QWORD`）、
  `Get-ChildItem -Name`（列子键）。返回 RegistryKey 对象、通配符、`REG_BINARY`/`REG_MULTI_SZ`
  等无法逐字段复刻的形态一律回退。
- 修 `Get-Process` 的静默错：`Select-Object -ExpandProperty Path/Modules`、`$p.Path` 以前会返回
  空且 exit 0（`tasklist` 没有这些属性）；现在读这些属性直接回退真引擎，集合属性做成员枚举
  （`$procs.Name` 与 PowerShell 一致）。顺带修 `Get-Process explorer` 位置参数不过滤的问题。
- `Select-Object` 的位置参数按 `-Property` 处理（`Select-Object Name,Id` 现在真的只选这两列），
  `-ExpandProperty` 遇到对象上不存在的属性回退（真 PowerShell 在这个位置本来就报错）。
- 测试：ps 110 → 124、exec 83 → 87；5 套 265 项全绿。

## v1.9.5

- 修 `auto` 把 PowerShell 脚本判给 cmd：`2>&1` / `*>&1` 是流重定向（cmd 与 PowerShell 5.1
  都合法），此前被当成 cmd 的 `&` 连接符，整段带 `2>&1` 的多行脚本被送进 cmd.exe
  （表现为「此时不应有 …」或「'foreach' 不是内部或外部命令」）。现在判定前先抹掉重定向。
- cmd 的 `>nul` / `2>nul` / `>>nul` 在选定 PowerShell 后改写为 `$null`：此前原样进真引擎，
  `Out-File` 报「要求 FileStream 打开一个不是文件的设备」。引号内的文本不动。
- 原生子集的 `> $null` / `2> $null` 改为真正丢弃：此前会往 cwd 写一个名为 `$null` 的空文件；
  `2>` 重定向也不再吞掉删除护栏的拒绝。
- 提示词新增：一条命令只用一种 shell——cmd 专属语法（`>nul`、`2>nul`、`%VAR%`、`&&`）与
  PowerShell 专属语法（cmdlet、`$env:`、`{ }`）混写时 `auto` 只能选一个后端，必有一半失败；
  需要两种时拆成两条并显式传 `shell`。上下文预算仍 ≤ 6500 字符。
- 测试：exec 76 → 83、ps 105 → 110、plugin 25 → 26。

## v1.9.4

- `New-Item -ItemType File` 不再截断已存在文件：无 `-Force` 报错，有 `-Force` 返回原文件
  （此前无条件 `writeFileSync('')`，会把已有内容清空）。
- `Get-Content` 支持 `-Encoding`（unicode/utf16le/utf8/ascii）并自动识别 BOM；`-Raw`、
  `-Tail`、`-TotalCount` 都走同一解码。此前 UTF-16 文件按 UTF-8 读，全是乱码。
- `Set-Content` / `Add-Content` / `Out-File` 的显式 `-Encoding` 生效：`Unicode` 写
  UTF-16LE + BOM，`ascii` 写 Latin-1；不传时仍是 UTF-8 无 BOM。
- `Copy-Item` / `Move-Item` 目标为已存在目录时把项放进目录内（`dest\源名`），
  不再把目录内容合并进目标；`Move-Item` 无 `-Force` 覆盖已存在目标时报错。
- `Get-FileHash` 改为 1 MiB 分块读取，大文件不再整份读进内存。
- 文档补充已知边界（逗号多路径、隐藏项、跨卷 Move）；测试 ps 96 → 105。

## v1.9.3

- 修混合编码日志的 `��` / 乱码：前台输出与 job 流式解码都改成**按行**判定编码。
  Gradle/Flutter（JVM 写 UTF-8 的 `√`）与原生子工具（GBK 中文）混写同一路输出时，
  以前整条流只提交一次编码，另一半就变成 `��`；现在每行各判各的。
- 行内混写两种编码仍不可区分（会显示其中一种），已在 README 写明。
- 结果/流编码标签新增 `mixed`（两种都出现过时）。
- 测试：exec 75 → 76（混合缓冲）、jobs 17 → 19（混合流 + 标签）。

## v1.9.2

- `Start-Sleep`（含 `sleep` 别名）原生实现：等待本身，不再启动 PowerShell
  （实测 `powershell Start-Sleep 1` 约 2.9 s，原生约 1 s；支持 `-Milliseconds` 与小数值
  `-Seconds`；超过 30 s 回退真实引擎，避免长时间占用串行 worker）。
- 提示词：等待优先用目标自身 sleep（`adb shell sleep 1`）或原生 `Start-Sleep`，
  只有 cmd 链式命令才需要 `powershell ... Start-Sleep`。
- 测试：ps 91 → 96（Start-Sleep 5 项）、exec 74 → 75（原生端到端 1 项）。

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
