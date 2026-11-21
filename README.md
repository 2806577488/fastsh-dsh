# fastsh

一个给 DSH 用的 Windows 命令执行工具。它直接启动 `cmd.exe`，不再为每条命令拉起
PowerShell 引擎，因此启动开销从约 1.5 秒降到约 0.15 秒（本机实测），同时用
UTF-8 → 系统 ANSI（GBK）的回退解码解决中文乱码，子进程沿用 DSH 进程的令牌，
权限与 PowerShell 完全一致。

## 为什么

| | Windows PowerShell 5.1 | fastsh |
|---|---|---|
| 冷启动（实测中位数） | ~1540 ms | ~153 ms |
| 中文输出 | 依赖控制台代码页，管道下常是 GBK 字节 | 严格 UTF-8 校验，失败回退 GBK |
| 重定向写文件 | `>` / `Out-File` 会转成 UTF-16LE 等 | 原样字节，不转码 |
| 权限 | 当前用户令牌 | 当前用户令牌（同一个 spawn 进程） |
| 语法 | PowerShell | cmd.exe（可切 `shell: "powershell"`） |

进程创建本身就是本机的 ~150 ms 地板（连 `where.exe` 都要 ~188 ms），所以
fastsh 已贴着地板；剩下的差距全部来自 PowerShell 引擎的初始化。

## 工具参数

| 参数 | 说明 |
|---|---|
| `command` | 必填，cmd 命令行 |
| `description` | 必填，5–10 个词的界面标题 |
| `workdir` | 工作目录，默认会话工作区 |
| `timeoutMs` | 默认 120000，限制 1000–600000；超时杀整棵进程树 |
| `maxOutputChars` | 每路输出默认保留 200000 字符，超出保留头尾并落盘完整文本 |
| `logFile` | 完整原始输出落盘路径（UTF-8，stdout+stderr），不受 job 环形缓冲裁剪 |
| `run_in_background` | 作为 DSH job 启动，立即返回 job id；用 `job_output` 读、`job_kill` 停 |
| `outputLimitBytes` | 仅后台任务：job 保留多少字节输出（限制 16 KiB–16 MiB） |
| `conclude_turn` | 仅后台任务，默认 `true`：启动后立刻结束本轮，不等进程 |
| `shell` | `auto`（默认，自动识别）/ `cmd` / `powershell` |
| `encoding` | `auto`（默认）/ `utf8` / `gbk` / `utf16le` |

## 编码策略

1. 有 BOM 时按 BOM 解码（UTF-16LE / UTF-16BE / UTF-8 BOM 会被剥离）。
2. 用 `TextDecoder('utf-8', { fatal: true })` 严格解码；所有字节合法即按 UTF-8。
3. 不合法则回退系统 ANSI 代码页（本机 `gbk`），覆盖老式 Win32 工具的 GBK 输出。
4. 两路输出各自判断，互不影响。

**文件不会被这个工具改写。** `>` / `>>` 由 cmd 自己处理，写的是程序输出的原始
字节；fastsh 只解码"回显给模型看的那份文本"。需要 UTF-8 落盘时，用 DSH 的
`write` 工具，或让程序自己输出 UTF-8。

## 权限

子进程由 DSH 宿主进程直接 `spawn`，继承同一个用户令牌、完整性级别和环境变量，
不经过任何降权层。也就是说：在 PowerShell 里能做的事，fastsh 里同样能做；
需要管理员的操作，取决于 DSH 本身是否以管理员身份启动。

## 使用建议

- 日常命令（`dir`、`type`、`copy`、`git`、`node`、`python`、管道与重定向）用 fastsh。
- PowerShell cmdlet（`Get-ChildItem`、`$env:NAME`、.NET 类型）继续用 `pwsh`，
  或者传 `shell: "powershell"`（它会用 `-EncodedCommand` 避免引号转义问题，
  并强制 UTF-8 输出，但启动仍要 ~2 秒）。
- 长任务用 `run_in_background: true`：它成为 DSH 原生 job，`job_list` 能看到，
  `job_output` 可以流式读，`job_kill` 能停，会话结束时随所属 Agent 一起回收。

## 后台任务（jobs 集成）

`run_in_background: true` 走 `ctx.jobs.start()`，规格是：

- `kind: 'bash'`（jobs 的 `JobKind` 目前只有这一个值，即便内容是 cmd）；
- `owner` 是调用它的 Agent 会话，job 的可见性由会话 id 围栏；
- `toolCall` 关联本次工具调用，UI 能把两者对上；
- `run(job)` 返回同步 hooks：`cancel(reason)` 杀进程树，`done` 在子进程 close
  后以 `completed / failed / killed` 结束。

输出用 `job.append(text, { channel })` 推入环形缓冲。为了支持**实时**输出，
`src/exec.js` 里有一个增量解码器 `createStreamDecoder`：纯 ASCII 直接放行，
遇到非 ASCII 时先挂起，等到一行结束（或 8 KiB）再判定——合法 UTF-8 就按 UTF-8，
否则按 GBK；判定后改用 `TextDecoder` 的 streaming 模式，所以跨块的多字节字符
不会被切坏。

如果 profile 里没有 `jobs` 服务，或者没有为这个 owner 挂上 controller，
`jobs.start` 会拒绝；此时自动回退到分离进程 + UTF-8 日志文件，返回 `pid` 和
日志路径，功能不丢。

### outputLimitBytes

jobs 服务有两条上限：运行期 `retainBytes`（默认 256 KiB）和结算后
`settledRetainBytes`（默认 16 KiB）。不传 `outputLimitBytes` 时按这两条走，
所以**任务跑完后 `job_output` 通常只剩最后 16 KiB**。

传了 `outputLimitBytes` 后，这个任务按该值保留，**结算后也保留**。实测：
5000 行输出（约 45 KB）、上限 32768，结算后读到的窗口正好从 `L215` 到
`L5000`，约 32 KB —— 没有被裁回 16 KiB。也就是说，想让长任务的日志在完成后
还能读到更多，就把这个值调大。

它只对 `run_in_background` 生效；前台命令仍然用 `maxOutputChars` + 完整落盘
文件那套。

### logFile

`logFile` 把一个路径交给 fastsh，子进程的**原始字节**会边跑边写进这个文件
（stdout 与 stderr 按真实顺序合并，UTF-8 无 BOM），同时照常回显和进 job 环形缓冲。

这让长构建不再依赖 `Tee-Object`：job 环形缓冲运行期只保留 256 KiB、结算后裁到
16 KiB，而 `logFile` 保留完整记录。前台、后台、分离回退三种模式都支持。

用 `Tee-Object` 也可以，但原生只管**原生管道**的输入；`flutter ... | Tee-Object`
这种“外部程序 → 原生 cmdlet”的管道仍然回退 PowerShell——所以长任务优先用
`logFile`。

### conclude_turn

后台任务默认在启动后**立刻结束本轮**（调用 `exec.concludeTurn()`），这样模型不会
再多跑一个回合去「等」进程。任务结算时 DSH 会把通知发回会话，届时再读输出。

传 `conclude_turn: false` 可以在同一轮里继续做别的事（比如先起一个服务，再跑
测试）。

前台命令没有这个开关：工具调用本身是同步的，模型必须拿到结果才能继续，这是
工具协议的固有行为，不是 DSH 的额外等待。

## 强制替换 pwsh

目标是「只能用 fastsh」，不是「建议用 fastsh」。做了四层，其中前两层的真实效果
是实测出来的：

1. **插件 scope 的 restrict**：`ctx.tools.restrict({ deny: ['pwsh'] })`。
   实测：对插件加载前就已存在的 Agent **不生效**，`pwsh` 仍留在工具表里。
2. **每个 Agent 自己的 scope**：`agent/created` 时对 `agent.ctx` 再 restrict
   一次，并对当前存活的 Agent 逐个补一次。这一层管的是**之后**新建的 Agent
   （含子代理）。
3. **全局 guard**：`ctx.tools.guard()`。**实测全局生效**——任何模型调用 `pwsh`
   都会立刻收到
   「The pwsh tool is disabled in this profile. Run the command with fastsh
   instead; for PowerShell syntax pass shell: "powershell".」
   执行被拒绝，不会真的起 PowerShell。
4. **system prompt 的 MUST 规则**：每次组装 prompt 都会带上，所有模型都看得到。

所以最终效果是：**`pwsh` 看得见、调不动**。模型最多少试一次就会被迫改走
fastsh；新建的会话/子代理连看都看不到。

### 为什么不直接停用 pwsh-sandbox

试过：`set_plugin include:pwsh-sandbox enabled:false` 确实能让 `pwsh` 从工具表
消失，但会连带报

```
permission (@deepseek-ai/dsh-permission-presets): pending (waiting for service: shell)
```

也就是权限体系依赖这一行提供的 `shell` 服务，停掉它会让 profile 处于未就绪状态。
为了藏一个工具冒这个风险不划算，已恢复启用。

想彻底移除 `pwsh`，正确做法是换一个不依赖它的 shell 服务实现，而不是关掉这一行。

想恢复 `pwsh` 的使用：停用 fastsh 插件即可，四层限制随插件卸载一起撤销。

## 原生 PowerShell 子集

能直接用 Node 实现的 PowerShell 能力，不再启动 PowerShell 引擎。判定为 PowerShell
语法后先试原生，不行才回退 `powershell.exe`。

**原生实现**（毫秒级）：

| 类别 | 支持 |
|---|---|
| 文件 | `Get-ChildItem`（`-Name/-File/-Directory/-Recurse/-Filter`）、`Get-Item`、`Get-Content`（`-Raw/-TotalCount/-Tail`）、`Set-Content`、`Add-Content`、`New-Item`、`Remove-Item`、`Copy-Item`、`Move-Item`、`Test-Path`、`Join-Path`、`Split-Path`、`Get-Location` |
| 管道 | `Select-Object`（`-First/-Last/-Skip/-Property/-ExpandProperty`）、`Where-Object`（属性比较）、`ForEach-Object`（属性取值）、`Sort-Object`、`Measure-Object` |
| 进程与时间 | `Get-Process`（`-Name/-Id`，走 tasklist，约 0.3 s）、`Get-Date`（`-Format` 支持 .NET 格式串） |
| 文本与序列化 | `Select-String`（`-Path/-Pattern/-SimpleMatch/-CaseSensitive/-NotMatch`，输出 `路径:行号:内容`）、`Out-File`（`-Encoding/-Append`）、`Tee-Object`（`-FilePath/-Append`，透传）、`ConvertTo-Json`（`-Compress`） |
| .NET 静态调用 | `[System.IO.File]::`（Exists/ReadAllText/ReadAllLines/WriteAllText/AppendAllText/Delete/Copy/Move）、`[System.IO.Directory]::`、`[System.IO.Path]::`、`[Environment]::`、`[math]::`、`[Guid]::NewGuid`、`[DateTime]::Now/UtcNow/Today/Parse` |
| 变量 | 赋值 `$x = ...`、引用 `$x`、属性链 `$x.Name`、`$env:NAME`、`$PWD`、`$HOME`、`$null`、`$true/$false`、`$_` |
| 控制流 | `if / elseif / else`、`foreach ($x in ...)`、`try / catch / finally`、`;` 与换行语句分隔、`$(...)` 子表达式、反引号续行 |
| 语法 | 重定向 `>`/`>>`/`2>`/`2>>`、调用运算符 `& exe args`（直接起进程，不套 shell） |
| 参数 | `Get-ChildItem -Depth N`（BFS，目录优先再按名称，与 PowerShell 一致）、`Test-Path -PathType Leaf|Container` |
| 链接与环境 | `New-Item -ItemType Junction -Target`（`fs.symlinkSync`，删除时只解链不穿透）、`[Environment]::SetEnvironmentVariable(name, value, 'Process'|'User'|'Machine')` 与对应 `Get`（User/Machine 走注册表） |

**仍然回退真实 PowerShell** 的只剩：

- 未知 cmdlet（如 `Get-ADUser`）或未知 .NET 类型；
- `@{...}` 哈希表、`@(...)` 数组表达式；
- `<` —— 注意 **PowerShell 本身也不支持**它（实测报“`<` 运算符是为将来使用而保留的”），所以这不是缺口。

### 两处有意为之的编码差异

实测 PowerShell 5.1：

- `2>` 重定向写出的文件是 **UTF-16LE**（首字节 `FF FE`）；
- `Out-File -Encoding utf8` 写出的文件是 **UTF-8 + BOM**（`EF BB BF`）。

fastsh 原生路径一律写 **UTF-8 无 BOM**。这是这个工具存在的理由之一——不把 BOM 塞进下游工具。需要逐字节复刻 PowerShell 行为时，请用 `shell: "powershell"` 显式走真实引擎。

实测（同一台机器）：

| 命令 | 之前 | 现在 |
|---|---|---|
| `Get-Date -Format yyyy-MM-dd` | 1886 ms | **1 ms** |
| `Get-Process \| Select-Object -First 3` | 1886 ms | **326 ms**（tasklist 本身的开销） |
| `Get-ChildItem \| Select-Object -First 2 \| ForEach-Object { $_.Name }` | 1876 ms | **27 ms** |

## 自动识别 PowerShell 语法

cmd 跑不了 PowerShell cmdlet、`$env:`、`[System.]`、`::` 静态调用这些。为了不让
模型「写了 PowerShell 却没加 shell 参数」就失败，`shell` 默认是 `auto`：

- 命令里出现 PowerShell 批准动词的 `Verb-Noun`（`Get-`、`Set-`、`Select-`、
  `Where-`、`ForEach-`、`Write-` 等 80 多个），或 `$env:`、`$_`、`$null`、
  `$PSVersionTable`、`[System.`、`[string]`、`[math]::`、`@{` 这类标记，就走
  Windows PowerShell 5.1；
- 其余走 cmd.exe，保持 ~0.15s 的启动速度。

判定刻意保守：这些模式不会出现在合法的 cmd 命令里，所以宁可漏判（退回 cmd 的
原生错误），也不误判。

`shell: "cmd"` / `shell: "powershell"` 可以强制覆盖猜测。

## 已验证

在 `test/ps.test.mjs`（40 项）、`test/exec.test.mjs`（28 项）、
`test/plugin.test.mjs`（24 项）与 `test/jobs.test.mjs`（15 项）中覆盖并通过：
原生 PowerShell 子集（列目录、管道、Where/ForEach、.NET 静态调用、`$env:`、
Test-Path）与"不支持必须回退"的边界，中文 GBK 解码、退出码透传、stderr 分离、
cwd 生效、引号与 `&` 保真、PowerShell 模式、超时杀树、abort、后台日志、
BOM/GBK 解码、跨块多字节字符、jobs 的完成/失败/取消、`outputLimitBytes`、
`conclude_turn`、`pwsh` 的 restrict/guard、以及 PowerShell 语法自动识别。

## 已知边界

- `cmd.exe` 语法与 PowerShell 不同，不能混用。
- `job_list` 里 kind 显示为 `bash`，这是 DSH 目前唯一的 job 类型名，不代表用了 bash。
- 没有 jobs 服务时后台任务回退为分离进程，此时用 `pid` + `taskkill` 管理。
- 超时后如果进程树仍持有管道句柄，结果最多延迟 5 秒返回（兜底定时器）。
- 输出超过 16 MiB 时只保留尾部，并标记 `truncated`。
