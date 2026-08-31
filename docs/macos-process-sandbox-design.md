# macOS Agent 进程沙箱接入方案

状态：设计提案，未实现、未完成真实进程隔离验证。调研日期：2026-08-31。

## 目标与边界

默认情况下，Agent 启动的程序及其所有后代进程只能修改其获准的 Workspace
范围内的文件。工作区外写入必须先获得用户对具体资源和操作的明确许可。
目录副本可用于保护原始数据，但不构成隔离机制，本方案不要求先复制 Workspace。

“只能修改”包括文件创建、覆盖、截断、删除、重命名、链接和相关元数据操作，不能
只拦截 writeFile。范围由可信控制平面和 CapabilityManager 决定，不由模型生成。
本方案仅处理 macOS；其他平台保持不注册进程工具，不降级成宿主裸执行。

默认写入范围是上限，不是自动赋予所有 Agent 整个 Workspace 的权限：子 Agent
只有某个子目录权限时，启动的程序也只能在相同或更小的范围内写入。

安全假设：宿主内核、沙箱实现和可信控制平面未被攻破。隔离不保证项目内的代码
一定正确，也不防止程序破坏已经获准修改的文件。恶意代码可能来自项目脚本和依赖，
因此命令名白名单只控制工具入口，不能代替 OS 隔离。

## macOS 后端选择

建议先验证一个范围有限的 `MacOSProcessSandbox`，使用 macOS Seatbelt 的
`/usr/bin/sandbox-exec` 启动受限进程，以进程级策略强制限制文件操作。
直接传可执行文件和参数数组，不经过宿主 shell，不加载用户 shell 启动配置。
这是一个需要兼容性验证的实验性后端，不能标注为 Apple 长期支持的接口。

Apple 的本机 SDK 手册明确将 sandbox-exec 标为 DEPRECATED，并推荐应用采用
App Sandbox。App Sandbox 是正式的应用隔离途径，但其应用容器、签名、权限继承
和动态文件授权模型，并不等价于给任意开发命令配置一套严格的每任务目录规则。
不能仅给 Electron 开启 App Sandbox，就宣称任意任务已按本方案隔离。

Anthropic Sandbox Runtime 可作为实现参考：其 macOS 后端也使用 sandbox-exec，
并提供文件和网络策略。但当前公开代码中的 macOS 包装流程仍使用 shell 命令字符串，
即使调用 wrapWithSandboxArgv 也不是直接传递目标程序的 argv；其默认读取策略
也不是只读 Workspace。因此不直接把其默认配置接入现有 test.run，也不在此提案
中安装依赖。后续复用需锁定版本，审查实际策略、参数传递和环境继承。

上线门槛是通过后文的真实 macOS 负面测试，而不是检测到 sandbox-exec 文件存在。
若所需限制无法表达、测试失败或系统版本不支持，后端报告 unavailable 并拒绝启动。
不能自动改用裸 spawn、宽松策略或关闭沙箱。

## 默认执行策略

| 资源 | 默认策略 |
| --- | --- |
| 当前任务获准的 Workspace 子树 | 按授权允许读取及具体写操作 |
| Workspace 内其他目录 | 不超出当前 Agent 的授权 |
| Node、系统动态库和必要工具链 | 明确列出的只读、执行权限 |
| 任务临时文件、HOME、依赖缓存 | 指向获准 Workspace 子树内的专用目录 |
| 宿主主目录、密钥、浏览器数据、应用数据 | 默认不开放内容读取或写入 |
| Workspace 内的凭据和控制配置 | 设置保护项；不能因位于 Workspace 就自动放开 |
| 网络、宿主本地服务、Unix socket、Apple Events | 默认拒绝；必要系统 IPC 逐项验证 |
| 控制平面的策略、运行记录和模型凭据 | 不向受限程序开放写入或凭据读取 |

不因为 npm 想写 ~/.npm 或工具想写系统临时目录，就隐式放开工作区外写入。
优先重定向 HOME、TMPDIR 和缓存路径；无法重定向时返回明确兼容性错误。
标准输入输出使用受控管道。若运行需要 /dev/null 等设备，应单独限定设备操作，
不能把这种例外扩展成普通宿主文件写权限。

读取和联网独立管理：满足“只能写 Workspace”并不意味着防止数据窃取。本方案
同时采用有限的读取权限和默认断网，模型 API 请求继续由可信主进程负责。
不能把整个 process.env 传进去；只构造必要环境变量，剔除凭据、代理、注入选项
和宿主代理 socket。模型不能指定沙箱 profile、环境变量白名单或可写路径。

Workspace 的控制配置、工具链和 Electron 运行代码不能与可执行恶意任务共享
可写信任边界。开发 OS-Agent 自身时，要防止任务修改的代码被宿主热加载执行。
Workspace 不能选成 / 或把可信控制数据包含进去；不满足边界时应拒绝启用。

## 与现有代码的衔接

```text
Agent 请求 test.run
  -> Tool 输入和 Character 可见性校验
  -> CapabilityManager 校验执行能力及资源范围
  -> 可信策略构造器生成本次执行的不可变授权快照
  -> macOS 后端解析宿主路径并生成 Seatbelt 策略
  -> sandbox-exec 直接启动目标程序
  -> 受限程序及后代进程
  -> 结构化结果进入现有 Work Table / Completion Mailbox
```

### 1. 扩展进程契约，而不是只增加一个 spawn 实现

现有 `src/tools/builtin/test-run-tool.ts` 中的请求只有 command、args、cwd、signal、
idempotencyKey、timeoutMs；`ToolExecutionContext` 只携带 Workspace 根路径，
不足以区分不同 Agent 的授权目录。

建议将独立进程契约放入 `src/tools/process-sandbox.ts`，保留旧导出以减少迁移影响。
请求增加由宿主构造的策略引用/快照：工作区身份、可读范围、各项可写范围、明确
拒绝范围、网络策略、策略版本和执行标识。结果使用可辨识联合类型，区分完成、
启动失败、取消、超时、确认的沙箱拒绝及恢复状态不明。

宿主路径仅在控制平面与后端内部使用，不能扩散到模型请求中。新增策略不是模型的
工具输入；它由调度器授权结果和挂载映射产生。

### 2. 修正进程能力与文件能力的组合

当前 test.run 总是要求整个 `workspace://current/` 子树的 test.run 能力，而执行
后端完全看不到文件 Grant。不能把拥有 test.run 理解为拥有整个 Workspace 写权限。

本次执行范围需要同时满足：Conversation 挂载边界、Character 上限、当前有效
Grant、明确批准的外部例外。读取、创建、写入、删除等操作分别映射；没有权限时
不能使用一个宽泛 file-write* 规则补齐。无法可靠映射的组合应拒绝执行。
需要支持子目录运行范围，并在调用前校验，不能事后把 cwd 当授权凭据。

一次性 Grant 由既有机制绑定具体调用并消费。本次程序及其后代共享这一次授权；
“单次执行授权”不是只允许一个系统调用，也不允许其他任务借用该权限。

### 3. 由桌面端完成后端探测和注入

建议新增 `desktop/main/sandbox/`，包含 macOS 启动器、策略生成和运行管理。
`desktop/main/index.ts` 在 darwin 上探测后端，并通过现有 RuntimeServiceOptions
的 processSandbox 入口注入。只有探测通过时才注册 test.run，并让新 Root 的
ceiling 包含它。恢复已有 Conversation 时也要重新校验可用性，不能沿用过期状态。

首批仍只开放 test.run 的既有命令集合，直接使用受控的绝对可执行路径与参数数组。
npm 项目脚本内部可以启动 shell，但那必须发生在已建立的沙箱内，后代不能脱离
限制。不增加任意宿主 shell 工具。

### 4. 接好生命周期和审计

每次执行记录 workspace 身份、策略摘要、授权引用、命令参数摘要、运行标识和结果。
限制输出大小，界面按不可信文本渲染。模型可见结果使用语义路径并避免泄漏宿主信息。

取消和超时需要处理全部后代，包括后台及自行脱离进程组的进程；仅 kill 一个 PID
或进程组不能先验宣称满足要求。即使后代仍存活也必须继续受沙箱限制，而完整清理
要作为独立验收项。需要可信 supervisor 或其他经过验证的进程生命周期机制。

幂等键用于识别同一次执行，不代表任意 npm 命令可安全重跑。宿主重启后先对账，
能够重新接管则接管；无法确定是否执行过的命令标记为状态不明，不自动重放副作用。

系统拒绝访问是安全边界，日志只用于解释和告警。不能依赖解析 stderr 判断所有
越界，更不能把“没有收到违规日志”解释为没有越界尝试。确认违规时可终止任务，
但不承诺日志能使每一次拒绝都同步触发终止和弹窗。

## 工作区外授权

第一阶段：任何未授权的工作区外写入都拒绝，不提供“关闭沙箱后重试”。这满足默认
不越界的要求，但尚不提供外部写入例外。

第二阶段：接入用户对具体外部资源的单次批准，批准后仍在沙箱中执行，只增加指定
范围，不能切到无约束宿主进程。审批展示命令、目录、权限、原因和有效范围。
运行中的失败操作不会原地暂停等待 UI；若需重试，应作为新的受控调用，并提示此前
可能已经发生的 Workspace 内副作用。

现有 CapabilityManager 已将 filesystem.external.* 设为 human-only、不可转授，
调度器也有审批查询和决议入口。但现有 Root Ceiling 仅包含 Workspace 资源，且
planRequest 明确禁止 Root 在 ceiling 外自行扩权。因此不能声称接上审批 UI 就完成。
还需要受信任的“用户选择外部资源 -> 控制平面建立受限授权上限 -> 单次审批”入口，
以及外部语义挂载映射；Agent 不能创建此上限，人工 Grant 不跨轮继承。

审批只在权限扩大时出现。已具备所需能力的 Workspace 内任务不逐条弹窗。

## 实施顺序与验收

1. 在合成临时 Workspace 和哨兵目录上实现 macOS 后端原型；不接真实凭据，不开启
   实际用户任务。确认目标 macOS 版本上正反向测试都通过。
2. 扩展授权快照、工具上下文和子目录执行范围，并完成桌面探测与注入。
3. 验证真实 Node/npm/TypeScript 测试和构建闭环，以及并发、取消、超时和重启。
4. 再接外部资源单次审批和用户告警；不把审批 UI 当作基础文件隔离的前提。

必须包含的真实进程测试：

| 场景 | 验收要求 |
| --- | --- |
| 授权目录内创建、覆盖、删除 | 按授予的操作成功 |
| 外部可写哨兵目录 | 无沙箱时可写；有沙箱时所有未授权写操作失败，哨兵不变 |
| 路径前缀相似、..、绝对路径、空格和特殊字符 | 不越界、不产生策略/命令注入 |
| 外指符号链接、悬空链接、运行期间替换、跨边界 rename/link | 不修改外部文件 |
| 预先存在的跨边界硬链接及可写文件描述符继承 | 不绕过；无法保证时拒绝该布局/执行 |
| 子进程、孙进程、后台进程及自行 setsid | 保持相同限制；取消后的残留被清理 |
| 子 Agent 仅获准 packages/a | 不能写 packages/b，不能因 test.run 获得整个工作区权限 |
| 两个 Conversation 并发 | 无路径、策略、环境、事件归属串用 |
| 私人文件、环境中的合成密钥、网络及宿主服务 | 默认无法读取凭据或建立未经授权的通信 |
| 全局 npm 缓存、系统临时目录写入 | 被阻止；获准 Workspace 内缓存正常工作 |
| 进程吞掉 EPERM 后返回 0 | 不把退出码 0 当成完整安全审计证明 |
| 过期/拒绝/错任务/已消费的外部批准 | 不产生外部权限，下一轮不继承 |
| 后端缺失、策略错误、不支持版本、嵌套沙箱拒绝 | 明确禁用，不裸跑 |

单次 realpath 检查和硬链接扫描都不能替代持续隔离；竞态与共享 inode 必须实测。
无法满足的情况要明确拒绝或缩小支持范围，不能用“创建了副本”掩盖失败。
测试通过提供的是支持矩阵内的证据，不是对任意恶意代码的绝对安全证明。

## 调研依据

- [Apple：App Sandbox](https://developer.apple.com/documentation/security/protecting-user-data-with-app-sandbox)
- [Apple：访问沙箱文件](https://developer.apple.com/documentation/security/accessing-files-from-the-macos-app-sandbox)
- [Apple 工程师：sandbox-exec 和第三方自定义策略的支持限制](https://developer.apple.com/forums/thread/661939)
- [Apple：诊断沙箱违规](https://developer.apple.com/documentation/security/discovering-and-diagnosing-app-sandbox-violations)
- [Anthropic Sandbox Runtime](https://github.com/anthropic-experimental/sandbox-runtime)
- [其 macOS 策略与启动实现](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/macos-sandbox-utils.ts)
- [其管理器及 argv 包装实现](https://github.com/anthropic-experimental/sandbox-runtime/blob/main/src/sandbox/sandbox-manager.ts)
- 本机 MacOSX15.5.sdk 的 sandbox-exec(1) 手册：标注 DEPRECATED，支持直接指定 command/arguments。

以上源码链接指向调研时的 main，不是锁定的依赖版本。落地前需固定所复用版本和
重新检查差异。本次仅完成文档与代码接口调研，没有安装后端或执行沙箱安全测试。
