# 更新记录

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
