# OS-Agent-js 项目指南

## 项目目标

OS-Agent-js 是一个使用 TypeScript 开发、借鉴操作系统设计思想的 Agent
Harness 与运行时。项目的核心目标，是把多个由 LLM 驱动的任务视为可被全局调度、
可持久化的工作负载，而不是把每次 Agent 运行都实现成彼此隔离的 `while` 循环。

项目的核心技术假设如下：

- LLM Provider 是远程计算资源。
- `AgentTask` 是可以被调度的工作负载。
- 全局调度器负责控制模型请求何时可以发出。
- Agent 任务使用三种本项目定义的运行状态：
  - `READY`：任务已经具备调用模型的条件，但正在等待网络恢复、速率限制配额、
    Token 配额、并发配额或预算。
  - `RUNNING`：模型服务商正在处理该任务。
  - `BLOCKED`：任务正在等待本地工具、子 Agent、人工审批、资源锁或其他外部结果。
- 工具执行被视为系统调用。
- 能力令牌、审批策略和沙盒共同约束普通操作与高权限操作之间的边界。
- 上下文窗口、Token 预算、持久化产物和上下文压缩都属于受管理资源。

## 初始范围

在添加产品层能力之前，先完成并验证运行时内核。

第一阶段应当包含：

1. 强类型的 `TaskControlBlock`。
2. 显式且经过校验的任务状态转换。
3. 全局就绪队列和调度器。
4. 感知 RPM、TPM、并发数和预算的请求准入控制。
5. 通过强类型事件实现阻塞和唤醒。
6. 与模型服务商无关的模型接口，以及行为确定的 Fake Provider。
7. 只追加的任务事件记录和可恢复状态。
8. 基于能力约束的工具注册和执行机制。
9. 针对调度逻辑和状态机不变量的单元测试。

## 第一阶段非目标

以下系统在第一阶段不从零实现：

- Embedding 模型。
- 向量数据库。
- PDF 或通用文档解析器。
- 通用 RAG 数据摄取系统。
- 新的 Chunk 切分算法。
- Web UI 或 IDE 插件。
- 完整的分布式工作流平台。

后续通过小型 Adapter 接口接入 RAG、Chunk、向量存储以及模型服务商提供的上下文压缩。
优先复用 LlamaIndex.TS、LangChain.js 中职责单一的检索组件，或模型服务商托管的
File Search 等成熟方案。

## 架构规则

- 内核必须与具体模型服务商解耦。
- 调度、模型调用、工具执行、持久化、检索和可观测性必须保持职责分离。
- 所有状态转换必须显式完成，禁止任意模块直接修改任务状态。
- Task ID 只能由内核生成并维护，不得进入模型可见输入，也不得允许模型在子任务
  创建请求中指定；测试需要确定性 ID 时必须注入内核 ID 生成器。
- 运行状态和事件使用可辨识联合类型，并通过穷尽式 `switch` 处理。
- 禁止使用 `any`。公共领域类型应尽量避免 `unknown`；外部不可信数据必须在边界处
  完成校验和类型收窄。
- 工具输出、模型服务商响应、恢复后的持久化状态和外部事件都按不可信输入处理。
- 所有带副作用的操作必须支持幂等键。
- 高权限工具必须由能力和审批策略强制保护，不能只依靠 Prompt 约束。
- Tool 可见性与执行授权必须分离；Tool 只声明所需能力，所有 Grant 签发、
  资源范围校验、委派衰减和审批路由统一由 `CapabilityManager` 裁决。
- Agent 只能申请 Capability，不能选择由父 Agent 还是用户审批。敏感能力必须绕过
  父 Agent 直接进入人工审批，人工签发的默认授权应限制为单次内核操作。
- Capability 请求必须先受 Root Authority Ceiling 约束。普通授权从最近持权祖先开始
  沿父子关系逐级下发，任何中间 Agent 都不能被跳过。
- 每个新 Conversation 都应提示用户选择 Workspace，但允许暂时不挂载；未挂载时
  Root 不获得文件系统 Capability。宿主路径只由控制平面保存，Agent 和 Capability
  使用 `workspace://current/` 语义挂载点。
- Workspace 只能在 Conversation 没有活动任务时更换，禁止在执行过程中重映射同一
  语义挂载点。
- 每轮 Root Agent 从 Conversation Authority Ceiling 重新签发 Workspace 子树内的
  文件与目录权限；后续轮次只继承 root 来源的 ceiling，不继承一次性人工 Grant。
- 子 Agent 等待 Capability 属于 Work Table 的非终态进展，必须通过现有
  Completion Mailbox 和批处理 timer 投递，禁止增加独立唤醒通道。
- Character 是内核级角色策略包，必须同时约束工具可见性、能力上限、可申请能力和
  可创建子角色；角色只能引用已注册定义，不能凭空创建或提升角色权限。
- `coordinator` 属于 root-only Character，不能出现在任何子 Agent 上；其他内置
  Character 可以递归创建非 coordinator 子角色。
- `coordinator` 持有最高角色上限，并可在小型任务中自行完成设计、开发和验证；
  `code_auditor` 保持源码只读，但可以通过受限沙箱执行测试和后续 UI 验证。
- AI Graph 模式下每个 Agent 都从 OS 保留的 `plan` 控制节点开始；只有 plan 可以
  安装或替换局部工作图，普通节点只能完成当前工作或请求重新规划。
- Graph 中的 `NodeKind` 只描述当前职责和输出契约，不是权限主体。Tool 可见性和
  Capability 始终以 Agent 为最小单位，不能因进入某个节点而扩大权限。
- Graph 依赖解锁、节点状态转换和 Character 节点发送由 OS 确定性管理；模型负责
  生成目标、依赖、assignee 与验收条件，不得直接写入运行状态。
- Graph 是 TCB Work Table 的一部分，必须随任务快照和事件历史持久化。子 Agent
  拥有自己的局部 Graph，不得获得父 Graph 的内部身份信息。
- 子 Agent 的 character 必须在父角色的可创建名单内，且请求能力必须落在该角色能力
  上限内，再叠加委派衰减与 workspace 边界。工具可见性只影响可见性，执行仍由
  CapabilityManager 二次校验。
- 工作区文件工具必须通过 ToolRuntime 把 `workspace://current/` 解析为宿主路径，
  拒绝 `..` 越界，并用 `realpath` 复查符号链接目标仍在挂载目录内。
- 受控进程执行（如 `test.run`）必须锁定工作区 cwd、使用命令白名单并以参数数组
  直接执行，禁止经过 shell 或拼接命令；任意 shell 属于敏感能力，不在默认工具集内。
- Agent 与子 Agent 的上下文遵循最小权限原则：每个任务只能获得其角色所需的
  上下文和工具。
- 父 Agent 只能转授自己持有、允许转授且资源范围不扩大的 Capability。
- 子 Agent 创建必须同时受到全局存活数量、每棵任务树累计创建数量和最大委派深度
  三类独立限制。
- 当前 Agent 不满足任一创建条件时，Provider Schema 必须隐藏子 Agent action，并将
  Graph assignee 收窄为 `self`，避免用一次失败模型轮次探测确定性的内核限制。
- 多跳 Capability 请求经过的每个中间 Character 都必须允许持有该能力，禁止借后代
  Agent 绕过父角色的 capability ceiling。
- 深度调度必须使用加权轮转和老化机制，禁止使用会让浅层任务永久饿死的绝对深度
  优先级。
- 大型输出应保存到 Artifact Store，并通过 ID 引用，避免反复复制进模型上下文。
- Artifact 必须是不可变版本记录；Agent 只持有 `artifact://` 语义引用，不能修改
  旧版本或自行伪造工件身份。
- 所有副作用 Tool 必须按其实际 Capability 资源范围获取内核排他锁；工具不能自行
  决定锁范围，多个资源必须一次性原子获取，禁止持有部分锁等待其他锁。
- Web 工具只能访问经过宿主校验的公共 HTTPS 目标，必须逐跳检查重定向、阻断私有
  网络并限制响应大小；网页内容和 MCP 内容一律视为不可信数据。
- `screen.capture` 属于 human-only、不可转授能力；模型请求截图必须进入人工审批，
  人工批准只签发绑定当前操作的单次 Grant。
- Git Tool 只能通过 ProcessSandbox 以 argv 执行；默认只允许状态、diff、历史、
  本地建分支和本地提交，不提供 push、merge、rebase 或任意 shell。
- 轻量 RAG 使用独立 KnowledgeStore Adapter；索引结果只提供事实候选和来源 URI，
  不得覆盖 Capability、Character、仓库规则或用户指令。
- 完整上下文与压缩上下文必须分通道持久化；压缩记录只能引用其覆盖的原始区间，
  不能直接销毁原始历史。
- 所有任务进入 Ready Queue 前必须完成上下文窗口预检。二次语义压缩必须通过独立
  Adapter 接入，并和普通模型请求共享准入与预算约束。
- 长时工具和子 Agent 必须以可序列化 Work Record 保存，禁止把 JavaScript `Promise`
  当作持久化任务状态。结果投递必须带 generation 和已投递标记，避免恢复后重复注入。
- 异步结果采用按父任务按需创建的一次性批处理 timer；部分结果批量投递，全部工作进入
  终态时立即走快速路径，不得受批处理窗口限制。
- 优先使用职责单一的小模块，不提前构建缺乏实际需求的抽象。

## 可靠性规则

- 每个进入队列或阻塞状态的任务，都必须存在明确的唤醒路径或终止路径。
- 重试必须有上限，并区分可重试错误与永久错误。
- 调度器必须在请求发出前考虑模型服务商的速率限制；服务端返回 `429` 后再重试
  只能作为兜底机制，不能作为主要限流策略。
- 取消信号和超时信号必须贯穿模型调用与工具调用。
- 状态持久化必须保证足够的原子性，避免任务恢复后重复执行副作用。
- 资源锁必须具备所有者、超时和释放语义。
- 事件历史必须能够解释任务为什么发生状态转换。

## 开发工作流

- 规划或修改项目前，先阅读本文件。
- 新增抽象前，先检查现有代码和测试。
- 每次修改保持范围清晰，并说明兼容性取舍。
- 根据风险补充测试，重点覆盖调度、并发、持久化、取消和状态转换。
- 禁止向内核添加 RAG 或 UI 依赖。
- 禁止提交凭据、API Key、Token、私人文档、生成的密钥或公司内部数据。
- 禁止把公司专有代码或公司内部实现细节复制到这个个人仓库。
- 源码默认使用 ASCII；只有内容确实需要时才使用非 ASCII 字符。

## Git 仓库信息

- 本地路径：
  `/Users/bytedance/Desktop/mystudyspace/OwnStudy/agent/OS-Agent-js`
- GitHub 仓库：
  `https://github.com/baochao-sxiaofan/OS-Agent-js`
- 创建项目时的可见性：Private。
- 默认分支：`main`。
- 远程名称：`origin`。
- 当前仓库专用提交身份：
  - 用户名：`baochao-sxiaofan`
  - 邮箱：`baochao-sxiaofan@users.noreply.github.com`
- 当前仓库专用身份必须与本机全局的字节跳动 Git 身份保持隔离。

## Git 规则

- 使用 Conventional Commits，例如：
  - `feat(kernel): add task state machine`
  - `fix(scheduler): prevent duplicate queue admission`
  - `test(kernel): cover blocked task wake-up`
  - `docs: clarify runtime state semantics`
- 本项目禁止修改本机全局 Git 身份或全局凭据配置。
- 除非用户明确要求，否则不要执行 commit 或 push。
- 提交前必须检查 `git diff`、运行相关检查，并确认暂存区中没有凭据或无关文件。
- 除非用户明确要求并批准，否则禁止改写已发布的 Git 历史或强制推送。
- 生成文件和本地凭据必须通过 `.gitignore` 排除。

## 当前状态

当前稳定版本为 `2.2.1`；`feat/enterpise_preview` 还实现：

1. 任务状态、事件和合法状态转换规则。
2. 可序列化的 `TaskControlBlock` 快照和只追加事件历史。
3. Fake Model Provider 和与服务商无关的模型接口。
4. 全局 Agent 池、委派深度和每棵任务树累计创建限制。
5. 采用 `Q3:Q2:Q1 = 4:2:1` 权重的三级深度感知 Ready Queue。
6. 等待老化和父任务唤醒加速。
7. 子任务创建、阻塞、结构化结果回传和父任务唤醒。
8. 子任务 `needs_parent_action` 回传协议。
9. 感知 RPM、TPM、并发额度和任务预算的请求准入控制。
10. Capability 驱动的工具权限校验与子任务权限衰减。
11. 只读工具并行、有副作用工具串行的执行策略。
12. `READY -> RUNNING -> BLOCKED -> READY -> TERMINATED` 演示。
13. 状态机、Agent 池、分层调度、配额、预算和权限测试。
14. 所有 Ready Queue 入口统一执行上下文窗口预检。
15. 正常模型响应搭载结构化轮次摘要，不增加常规模型请求次数。
16. 完整上下文与摘要上下文双通道快照和恢复。
17. 早期摘要与近期原文混合上下文构造。
18. 可替换的二次 `ContextCompactor` Adapter，并受 RPM、TPM、并发和预算控制。
19. 压缩失败、压缩后仍超限和子任务预检失败的确定性终止/回传路径。
20. 限流任务基于 `retryAt` 的自动唤醒（`run()`）与单任务完成 Promise（`waitForTermination()`）。
21. 工具与子 Agent 同轮混合创建的 `async_work` 协议。
22. 持久化 Work Table、Completion Mailbox、generation 和结果去重标记。
23. 默认 30 秒的按父任务一次性批处理 timer，以及全部完成立即唤醒快速路径。
24. `async_work_update` 部分结果、pending 工作和 `wait_for_async_work` 继续等待协议。
25. 父模型运行期间的结果合并、父任务级异步状态串行化和 timer 恢复补偿。
26. 父任务终止时中止本地工具并递归取消存活子任务。
27. 首个真实模型适配器 `GeminiModelProvider`，支持 HTTPS 请求、结构化 final
    响应、轮次摘要、Token 用量、取消信号和严格边界校验。
28. Gemini 结构化子 Agent 委派、异步等待和父任务协助响应。
29. Ready Queue、AgentPool 和 Provider 并发峰值观测指标。
30. 16-Agent Map-Reduce 调度基准和真实 Gemini 三任务多 Agent 冒烟验证。
31. 双通道上下文独立验证：完整历史与摘要分别持久化，模型只接收预算内混合上下文。
32. SQLite 任务快照与事件持久化，单次跃迁通过事务原子写入快照和增量事件。
33. 桌面启动批量恢复任务树：失效 RUNNING 请求重新入队、BLOCKED 异步投递与
    timer 重建、终态子任务对账、运行中本地工具按原幂等键重启。
34. 模型侧完全移除 Task ID；子任务身份、血缘和碰撞重试由内核管理。
35. 资源范围化 Capability Grant、Root Authority Ceiling、父级衰减委派和
    敏感权限人工审批路由。
36. Capability 请求作为 `waiting_for_capability` 非终态进展进入 Work Table，
    复用 Completion Mailbox 和批处理 timer。
37. 普通 Capability 从最近持权祖先开始沿父子关系逐级授权，中间 Agent 不可跳过。
38. Tool 可见性与执行授权分离，并支持按调用参数推导资源范围。
39. Gemini、Anthropic 和 OpenAI-compatible Provider 共用统一结构化响应协议。
40. Conversation 绑定并持久化 canonical Workspace；Agent 使用
    `workspace://current/` 语义挂载点。
41. 每轮 Root 自动获得 Workspace 子树文件系统 ceiling，后续轮次重新签发上一轮
    root ceiling，单次人工 Grant 不跨轮继承。
42. Conversation 元数据与任务快照保存在同一 SQLite 事实源，重启后保留多轮归属。
43. Character 内核层：定义、注册表、内置 `developer`/`code_auditor`/`researcher`
    /`tester` 四角色，以及基于角色的工具可见性、能力上限和可创建子角色校验。
44. 首批 bootstrap 工作区工具：文件读/写/删除、结构化 apply patch、目录
    列举/创建/删除和子串搜索，全部经 ToolRuntime 做 `workspace://current/`
    解析与符号链接越界防护。
45. `test.run` 采用 `ProcessSandbox` 注入契约；未配置 OS-level 沙箱时不注册，
    禁止退化为裸 `child_process.spawn`。macOS 后端（`desktop/main/sandbox`）以
    `sandbox-exec` argv 直启，写入限定工作区、默认断网、清洗环境变量，启动时经
    真实负向验证探测，失败即禁用而非降级。
46. 通用 `McpToolAdapter` 保留第三方 MCP 的 schema 与执行能力，同时由本地可信
    binding 声明 Capability，外部 MCP 不能自行决定授权。
47. AI Graph 协作模式：每个 Agent 从 plan 生成局部 DAG，OS 校验、持久化并自动
    调度依赖；Character 节点映射为拥有独立局部 Graph 的子 Agent。
48. `inspect`、`research`、`design`、`implement`、`integrate`、`verify` 和
    `review` 首批 NodeKind，以及 `set_graph`、`complete_node`、
    `request_replan` 结构化协议。
49. Graph 节点状态与 Agent 运行状态正交；任意 self 节点等待 Tool、Capability
    或外部结果时均可进入 `blocked`，恢复后继续原节点。
50. 不可变 SQLite Artifact Store、任务树/Graph 节点关联和桌面工件摘要。
51. Capability 资源范围驱动的原子排他锁，保护并发副作用工具。
52. SQLite FTS5 轻量知识索引、工作区分块和带 URI 的 RAG 检索。
53. 沙箱内本地 Git 状态、diff、历史、建分支和提交工具。
54. researcher 公共 Web 搜索/抓取，以及 HTTPS、SSRF、重定向和响应大小边界。
55. tester 沙箱验证、屏幕截图申请和测试 Artifact 输出边界。
56. Chat 每轮上下文上限、温度、可选推理深度和图片附件。
57. Gemini、Anthropic、OpenAI-compatible 多模态请求映射。
58. 桌面 human-only Capability 审批队列与单次批准。
59. 调度器 quiesce 和等待式 Runtime 关闭，保证 SQLite 关闭前操作已释放。

后续优先级：

1. 用官方 filesystem MCP 替换 bootstrap 文件工具，并接入 MCP stdio/HTTP Client。
2. 为 Windows/Linux 接入可按 Conversation 隔离的 OS-level 后端。
3. 接入浏览器自动化、应用窗口捕获和结构化 UI 可访问性树。
4. 增加外部进程和长时工作对应的恢复 Adapter。
5. 为 Gemini Provider 增加 Function Calling 与 `async_work` 混合响应映射。
6. 增加真实模型厂商的 `ContextCompactor` Adapter。
7. 为 KnowledgeStore 增加可选 Embedding、语义重排和增量文件监听。
8. 增加 Artifact 远端对象存储、保留策略和审计导出。
