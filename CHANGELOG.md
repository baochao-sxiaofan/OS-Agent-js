# 更新日志

本项目使用语义化版本号。

## 3.0.0 - 2026-10-23

### 本次大版本的变化

- 主线交付新长期 Agent Runtime 和 OS Agent Next 3.0.0 桌面。Agent 由用户创建，
  身份、权限和会话长期保留，工作完成后休眠，收到新消息后继续。
- 将调度、上下文、控制块、轮次、模型请求、工具执行与宿主界面划为独立模块。
  L1/L2/L3 表示同一个 Agent 的内部任务层级；模型不能创建或控制其他 Agent。
- 新桌面提供联系人、私聊、群聊、只读 Agent 视角、消息聚合、点名、历史查询和长备注；
  桌面与 HTTP 服务通过同一 Runtime 公共接口工作。
- 新原生工具协议、会话持久化和工作批次预算改变了新链路的数据及执行契约，
  因此按主版本升级；不把旧 TCB/Graph 身份自动迁移为长期 Agent。
- 根包与新桌面版本统一为3.0.0。旧桌面继续保留2.2.1版本、入口和独立数据目录；
  Windows CI 分别检查和打包两套桌面，新增 Next 安装器。
- 完整功能、兼容边界及验证记录见 [3.0.0 发布说明](docs/release-3.0.0.md)。
- 发布前六组及跨组审查修复了恢复写屏障、对账背压、预算绕过、循环恢复、
  总结准入计数与收件确认、MCP错误/重连、Docker清理和桌面原文读取等问题。
  新增模块依赖检查并接入CI；Server/MCP不再依赖Runtime内部schema。
- 发布回归59个文件416项通过；核心及新旧桌面类型检查、核心构建、新桌面打包通过。
  正常沙箱3.0.0窗口验证创建、聊天、历史搜索与原文读取；真实Docker/Linux仍保留待验收。

下面记录本次大版本包含的各阶段改动与验证；历史阶段的测试数量按当时结果保留。

### DeepSeek HTTP400 与协作运行测试

- 修复 `context_step_completed` 嵌套总结结构的根相对 `$ref` 错位，
  防止 DeepSeek 在执行模型推理前拒绝整个工具列表。
- 升级时归档并重建未完成的旧请求，已完成原生回复继续按原幂等回执恢复。
- 将 DeepSeek 工具定义、工具历史及上下文超限错误映射为安全的可操作提示，
  限制错误正文读取容量，避免回显供应商原文；HTTP402明确提示账户额度不足。
- 新增独立 `test:novel:soak` 真实协作入口，只检查十章文件及多轮读写交接，
  不评判文学质量；保存请求、工具回执、消息和运行统计，停止时保留现场。
- 两份原400请求修复后均返回200。首次真实测试因服务端402停止；
  充值后从空库一次派发完成176次请求、37条Agent消息、十章及清单交付，用时723秒。
  十章最终读取哈希与确认时序一致，双方自然休眠，未人工推进。
- 第二轮全部HTTP200，一次错误函数返回和14次准入等待自动恢复。
  额外的逐章独立修改流程覆盖8/10，第08、10章提前补写后直接确认；
  严格核验脚本保留未通过结果，不把交付完成等同于全部测试步骤覆盖。
- 全仓53文件365项通过；类型检查、构建和macOS安装包启动验证通过。

### 原生工具协议与长任务恢复

- 普通动作、分层总结和会话摘要统一使用原生函数调用；提示词与网络请求契约一致，
  不再接受新回复在正文中提交动作 JSON。仅恢复旧版已落盘回复时保留兼容转换。
- 请求按当前会话、工作批次、上下文层级与版本、模型连接续接有限的原生工具历史，
  保留调用 ID 和私有思考状态；只有已提交上下文且拥有真实结果的完整调用组参与续接。
- 修复 DeepSeek `invalid_response` 未进入协议纠正的问题，保留脱敏原因并有界重试；
  归档旧请求和回复后重建请求，不反复解析同一失败结果。
- 默认128次模型请求上限改为每个工作批次的额度，跨重试和重启保留；
  耗尽后显式继续可追加一份额度。长期请求数、Tokens 与费用统计不清零。
- 按当前活动步骤生成并校验来源枚举，避免 L3 误用 L2 历史来源；
  读取已授权聊天原文后，将实际消息来源登记到当前步骤。
- 同层压缩收紧已完成任务的结果预览，完整内容继续封存可查；
  总结额度预留固定结构与来源还原空间，可纠正的超限进入有限重试。
- 全仓52个测试文件、358项通过，覆盖原生协议、旧现场恢复、续接隔离、
  超过128次长期请求后的新批次、显式继续及压缩容量。

### DeepSeek 与型号选择

- 新增 DeepSeek 独立 requester：文本、原生工具调用、思考续接、用量、取消、
  超时和脱敏错误；稳定映射含点号的工具名称，并还原给 Runtime。
- 模型连接支持 DeepSeek/MiniMax 切换和型号下拉选择；DeepSeek 输入 Key 后自动
  读取官方 `/models`，支持刷新、空态与错误提示，切换时丢弃过期响应。
- MiniMax 使用明确标注的官方预置列表，不声称已验证凭据或套餐可用性。
- 两家凭据和型号分别保存，旧单连接配置兼容读取；发现型号不修改保存配置，
  不执行推理，不从另一供应商借用 Key。保留既有 Agent、历史和容量配置。
- 新增27项离线验证，覆盖协议、凭据隔离与迁移、文件读写、总结和恢复；
  全仓49个测试文件、348项通过。
- 真实接口验证发现思考模式拒绝 required/指定函数：普通工作映射 auto 并校验
  必须返回合法工具；指定函数步骤使用非思考模式原生强制工具，保持提交契约。
  Flash 已完成真实读写、读回核对与休眠，Flash/Pro 均完成总结提交和来源校验。

### macOS 桌面安装

- 修复新桌面正常沙箱模式启动白屏：预加载脚本改为 CommonJS `.cjs` 产物，
  主进程使用对应入口，保持 Chromium 沙箱、上下文隔离和关闭 Node integration。
- 补充直接安装 `.app`、本地演示、真实模型连接与工作区权限的使用说明。
- macOS arm64 实际安装包验证欢迎页、模型设置及创建表单，桌面相关12项回归通过。

### 真实小说协作联调

- 增加手动 `test:novel:live` 入口，每次使用原始角色提示词创建作者小白与只读编辑
  小黑，分别签发文件权限，派发前十章逐章写作、审稿与修订任务。
- 独立数据库保留运行现场，输出目录保留任务书、真实群聊审稿记录与章节正文；
  提供状态、字数、哈希、错误分类和可信宿主对账入口，支持原现场恢复。
- 普通单测不调用付费 API，未知写入与编辑验收均不自动推定。
- 真实联调发现长来源哈希复制错误导致总结重试；总结轮改用本次封存的短编号
  与枚举，提交时严格还原来源，保留旧请求恢复并拒绝未知或越权引用。
- 宿主固定绑定总结所属封存；普通轮历史读取使用短引用，长文件预览提供完整分页
  游标，已投递聊天消息可作为事实来源，未投递或其他 Agent 的资料仍拒绝。
- 修复 `workspace.search` 在单文件路径下报 `ENOTDIR`，支持文件与目录检索并保留
  工作区与符号链接边界。
- 文件覆盖工具确认目标不存在时，返回 `file_not_found` 并提示使用创建工具，
  无副作用的前置失败不再要求对账；取消和执行异常仍保留未知结果。
  失败写入的完整参数保存为可分页原文，避免压缩后丢失已经生成的内容。
- MiniMax请求连接支持可选 `thinking`，真实小说联调可通过
  `MINIMAX_THINKING` 切换M3思考模式；省略时保留供应商默认行为。
- 已授权的聊天来源误用产物读取工具时，返回有限协议纠正，不误判为越权暂停。
  普通协议重试耗尽后，显式继续会保留错误记录并重新请求，避免重放旧错误响应。
- 长期Runtime角色可用 `allowPlanning:false` 禁止安装和重建计划，支持直接文件与
  消息工作，并能收尾已有任务链；小说联调两角色启用此约束。
- 根层完成的旧计划不再提示立即收尾；新来信及约定的阶段放行按当前批次继续处理，
  子层完成计划仍须收尾。新增同会话旧计划完成后继续交付文件的回归。
- 小说联调单独保存两人的真实私聊审稿记录，保持用户会话隔离；作者普通工作轮
  可单独配置思考模式，便于比较直接生成与完整思考的效果。
- 文件创建、覆盖与补丁的 `bytesWritten` 改为真实UTF-8字节数，另外返回字符数
  和汉字数；读取返回独立篇幅统计，避免中文与表情使回执单位混淆。
- 补丁未匹配或匹配不唯一时明确返回写入前失败，保存原调用供模型纠正；
  不再误暂停为未知副作用，执行异常及崩溃恢复仍要求显式对账。
- 工具结果增加可配置的完整投递字符额度，小说联调完整投递几千字章节，
  减少将读取成功误当成已读全文；较长结果保留原文分页与来源校验。
- 增加宿主可选消息护栏；联调编辑发言前核对实际读稿哈希、分页与终审重读时间，
  拒绝未读或过期稿件的验收，模型纠正后仍自行审稿和发言。
- 消息护栏提供实际点名列表；联调协作群在发送前要求点名对方，避免审稿发出后
  无人被唤醒。验收检查另核对每章实际汉字数不少于2000。
- 联调审新稿前核对权威校对口径的当前版本与近期读取，减少错误摘要向后续章节
  传播；多个控制调用的纠错提示明确指出本轮只保留一个调用。
- MiniMax 普通HTTP429缺少重试期限时至少退避30秒；携带业务码2056的额度耗尽
  直接暂停，不当成可恢复限流重试，界面明确提示补充额度。

### 可调容量与总结恢复

- 默认完整请求容量提高至500K，单次输出提高至32768，扩大三层上下文预算；
  同时提高每分钟和累计 Token 额度。
- 桌面模型设置增加500K/1M预设，以及输出、各层压缩阈值和资源额度的独立编辑。
  服务器配置新增 `tokenSettings`，SDK 提供读取与可信宿主修改接口。
- 修改会持久保存并更新已有 Agent 的会话上下文；冻结历史另行封存，原文、任务、
  授权和累计计量保留。无法容纳已有现场的容量降低会被拒绝。
- 总结失败提示区分输出截断与 JSON 语法错误，重试耗尽显示最近原因。
  用户显式继续可重新开启有限总结尝试并归档旧回复，避免旧截断响应阻塞恢复。
- 自动化验证大请求、配置与场景重启恢复、失败总结继续；独立 Electron 演示验证
  预设、自定义输出与保存。未调用真实付费模型 API。

### 跨会话记忆

- 同一个 Agent 可在独立预算内读取其他近期会话摘要、未压缩增量及自己的个人备注，
  保持当前会话的 L1/L2/L3、邮箱与自动发言预算隔离。
- 增加阈值触发的增量压缩；固定消息范围、覆盖序号、摘要版本、来源原文校验、
  失败冷却和用途持久化支持崩溃后安全重放，不删除原始消息。
- 增加按作者和对象隔离的长备注、简介、标签、待跟进与来源，支持期望版本和幂等写入。
  用户和 Agent 不能互相覆盖备注，也不能通过输入伪造作者。
- 增加 SQLite 中文关键词检索、原文片段与游标分页；消息序列化容量参与片段预算。
  所有读取均校验会话成员身份，后续可独立接入语义检索。
- Runtime、HTTP 与桌面增加记忆接口；桌面可编辑“我的长备注”、只读查看 Agent 备注、
  查看摘要覆盖范围及引用原文、搜索当前或全部可访问会话，不改变只读和未读语义。
- 自动化覆盖暗号跨会话、隔离、预算、增量压缩和失败恢复；离线 Electron 验证长备注保存、
  来源分页、搜索翻页和摘要展示，未调用真实模型 API。

### 会话与自主发言

- 用户私聊、Agent 私聊和群聊独立存储；同一 Agent 按会话切换持久上下文并顺序运行。
- 新增 `message_send` 与 `context_finish_turn`：只有显式发件产生聊天消息，
  允许合并答复或静默结束；普通业务的分层总结继续保留。
- 持久邮箱支持短窗口聚合、最大等待、点名优先、固定批次和按处理上界确认。
  发件幂等、断电恢复及跨会话共享的自动发言预算由宿主强制控制。
- 桌面增加“我的对话”“Agent 视角”、只读历史归档、创建群聊、点名和群参与策略。
  未读与草稿按会话区分，状态显示实际处理进度，不承诺必然回复。
- HTTP 增加会话、消息、邮箱与只读管理查看接口；校验成员、用户、工作区及回复引用。
- 原混合消息不推测迁移；旧输出仅保留内部记录，旧协作动作恢复到独立 Agent 私聊。

### 新链路桌面

- 新增独立 `desktop-next` Electron 应用：左侧联系人列表、左上角创建 Agent、
  搜索、消息历史、未读提示、聊天输入、角色与工作区权限、详情及暂停/继续/停止。
- 主进程通过新 Runtime 公共 API 执行；渲染进程仅使用受校验的窄 IPC。
  与旧桌面的入口、应用标识、数据目录完全分开，核心仍可用于服务器。
- Runtime 增加 `startMode: on_message`、不可重映射的工作区登记和持久化消息查询；
  默认立即启动的行为保持兼容。消息查询同时通过 HTTP 暴露并校验归属。
- L1 完成计划后可显式发送结果或静默结束；内部 L2/L3 交付不进入聊天记录。
- 新桌面提供离线演示和 MiniMax 模型设置；凭据在系统安全存储可用时加密，
  否则只在会话中保留。未知副作用与审批可在对话内处理。
- 增加新桌面的类型检查、构建、本地应用打包入口和联系人重启恢复集成验证。
- 修复真实模型总结省略空列表时连续失败的问题：只在模型输入边界补空集合，
  保留必填结果、来源引用、显式类型及核心存储的严格校验，错误指出具体字段。
- MiniMax HTTP 529 未提供 Retry-After 时默认等待 30 秒再重试，避免数秒内耗尽重试。
  Runtime 提供中文恢复提示和结构化 API 错误码，不持久化供应商原始错误正文。
- 增加真实 M3 普通轮、独立总结与暂停恢复验证，以及省略字段和越权来源的回归测试。

### 下一代 Agent 运行时边界

- 新增独立 `model-requester` 公共模块，统一模型消息、工具调用、厂商续接状态、
  Token 用量和错误协议；当前实现 MiniMax 请求适配，其他厂商保留显式占位。
- 新增三级递归 `agent-context` 数据协议，区分长期职责、工作阶段和执行步骤，
  并定义任务引用、重规划、总结、记忆和预算边界。
- 新增 `agent-control-block`，定义长期 Agent 身份、角色、资源权限、Skills、
  Context 和模型配置引用，并提供受校验的四态转换接口。
- 新增独立 `agent-scheduler`，使用在途操作 Map 和已完成结果 Map 收集实际异步操作；
  支持全部完成立即投递、部分结果定时投递、不可变批次、超时和事件唤醒。
- 实现模块化 Context Manager，包含任务规划、版本引用、同层压缩、子层总结回传、
  有界收件箱和只追加历史；内存与 SQLite 存储原子提交检查点、归档和轮次回执。
- 新增 `agent-round` 编排层，普通轮报告完成后由下一张调度凭据请求总结；
  总结失败保留现场、有界重试，期间到达的消息延迟处理，scheduler 无需识别轮次类型。
- ACB 可绑定上下文只读端口，快照从 Context Manager 读取最新权威数据。
- 新增五个模块的包导出、示例和边界测试，包括独立总结轮及重启恢复演示验证。
- 新增服务器 `agent-runtime` 与认证 HTTP API，接入正式模型动作、文件工具权限、
  单次审批、长期 Agent 间的持久消息、用量准入和中断退避/暂停。
- 新链路统一为用户创建的长期 Agent，移除模型 spawn、Agent 父子字段、
  深度/任务树限制、自动子结果回传和递归取消。L1/L2/L3 仅是单个 Agent 内部上下文。
- 所有新 Runtime Grant 不可转授，独立用户授权；协作仅在同一用户和工作区内
  显式寻址已有 Agent。取消、暂停和完成只影响对应 Agent。
- RuntimeAgent 快照版本更新为 2；旧父子快照拒绝恢复并保留原数据，由用户创建新身份。
- scheduler 增加持久快照、稳定操作键、暂停/恢复及取消；RUNNING 崩溃恢复保留批次。
- 独立总结支持严格 `submit_summary` 输出函数，业务工具仍不可用；来源与预算继续校验。
- 增加 MCP stdio/HTTP Client、Docker ProcessSandbox、部署配置及服务器真实 API 冒烟。
- 新链路继续与旧桌面并存，服务器为单机单进程 SQLite，不提供分布式执行。
- 副作用结果未知立即暂停；对账结果独立保存和投递，审批过期禁止执行，
  停机不启动排队写操作，并能结束忽略取消信号的适配器等待。
- 恢复校验角色、身份与用户授权来源；独立 SQLite 锁防止多进程同时占用数据库。
  协议纠偏保留被拒绝的请求和回复历史；存储失败使 readyz 返回 503。
- 增加真实 SIGKILL 恢复、资源预算、协作通信隔离和服务故障集成验证，
  提供 Linux systemd 部署示例；Docker/Linux 环境实际验收保留待完成。

### 兼容性

- 新模块不接入旧 `TaskScheduler`、`TaskControlBlock` 和旧桌面 Runtime。
- 现有运行链路保持不变；后续版本将按模型请求、上下文、ACB 和调度顺序逐步替换旧组件。

## 2.2.1 - 2026-08-28

- 修复了部分问题。

## 2.2.0 - 2026-08-28

### AI Graph

- 新增 `ai_graph` 协作模式。每个 Root 和子 Agent 从 OS 保留的 plan 控制节点开始，
  由模型提交局部 DAG，OS 负责结构校验、持久化、依赖解锁和节点调度。
- 新增 `inspect`、`research`、`design`、`implement`、`integrate`、`verify`、
  `review` NodeKind，以及 `set_graph`、`complete_node`、`request_replan`
  结构化响应。
- Character assignee 节点由 OS 转换成子 Agent；子 Agent 独立规划自己的局部 Graph，
  并通过现有 Work Table 和 Completion Mailbox 回传结果。
- Graph 节点状态与 Agent 的 `READY/RUNNING/BLOCKED/TERMINATED` 状态正交。节点
  等待 Tool、Capability 或子 Agent 时可以进入 `blocked`，恢复后继续原节点。
- Tool 可见性和 Capability 继续以 Agent 为最小单位，不随 NodeKind 改变。
- Work Graph 进入 TCB 快照和事件历史；换版前的节点结果进入上下文，模型侧不暴露
  子任务内部 ID。
- 桌面 Inspector 展示 Graph revision、当前模式和节点状态。
- 桌面 Root 模型调用上限调整为高位熔断值 `4096`，AI Graph 子 Agent 使用 `1024`；
  桌面默认不再设置每轮输出 token 上限、输入上下文预算、token/min 上限或费用上限。
- 新增 Graph DAG 校验、快照恢复、self 节点工具阻塞、递归子 Agent Graph、阶段越权
  拒绝和内部 Task ID 脱敏测试。

### 修复

- 修复 `ai_graph` 模式下子 Agent 向父 Agent 申请 capability 时，父 Agent 不会
  运行模型处理该申请的问题。此前父 Agent 在 Graph `waiting` 阶段会把已投递的
  capability blocker 误判为“仍在等待子任务”而再次静默阻塞，导致子 Agent 永远拿
  不到授权。现在只要 blocker 已投递到父 Agent 上下文，OS 就会让父 Agent 运行
  模型作出授权决定，随后子 Agent 恢复 `RUNNING` 并继续执行，直到真正返回终态。

## 2.0.0 - 2026-08-27

### Character 角色

- 新增内核级 Character 层：`CharacterDefinition`、`CharacterRegistry`、根
  `coordinator` 和可创建的 `developer`、`code_auditor`、`researcher`。Character 同时约束工具
  可见性、能力上限、可申请能力和可创建子角色，角色只能引用已注册定义。
- 模型请求按 Agent 的 character 过滤可见工具；执行仍由 CapabilityManager 二次
  校验，工具可见性不再等同于可执行。
- 当前 Character 指令、可申请能力和父 Agent 可创建的角色目录会进入真实 Provider
  请求；模型同时获得去除 Grant ID/来源链后的当前可执行 Capability 视图。
- `spawn_subagents` 的子项新增 `character` 字段。内核校验子角色已注册、在父角色
  可创建名单内、请求能力落在角色能力上限内，越界时返回结构化 `capability_escalation`
  拒绝，不会创建子 Agent。
- `TaskControlBlock`、快照与子任务创建请求携带 `characterId`；省略时保持无角色
  约束的旧行为。

### 内置工作区 Skills

- 新增首批 bootstrap workspace 工具：`file.read`、`file.write`、`file.create`、`file.delete`、
  `file.apply_patch`、`directory.list/create/delete` 和 `workspace.search`，
  可通过 `registerBuiltinTools` 一次注册。
- 新增 `WorkspaceResolver`：把 `workspace://current/` 别名解析为宿主路径，拒绝
  `..` 越界，并用 `realpath` 复查符号链接目标仍在挂载目录内。
- `test.run` 改为 `createTestRunTool(ProcessSandbox)` 工厂；只有宿主注入真正的
  OS-level 沙箱时才注册，禁止降级为裸 host spawn。
- `ToolExecutionContext` 新增 `workspaceRoot`；调度器新增 `workspaceRootResolver`
  选项，把当前任务的挂载目录透传给工具，未挂载时相关工具拒绝执行。
- 桌面 RuntimeService 注册内置 Skills，并按 Conversation 的 workspace 映射向
  调度器提供挂载根目录。
- 新增通用 `McpToolAdapter`，允许复用现成 MCP 工具，同时由本地可信 binding
  声明 Capability，MCP Server 不参与授权决策。
- 统一响应 Schema 补齐 `tool_calls`、`async_work`、tool call 参数和 child
  `character`，真实 Provider 不再只能返回 final/委派类动作。

### 验证

- 新增 Character 注册表、工作区路径防逃逸、内置工具、MCP Adapter、调度器角色
  约束和 HTTP Provider 工具闭环测试。
- 真实目标模型 API 冒烟尚未执行；当前验证覆盖 mock HTTP Provider、Fake Provider、
  类型检查与生产构建。
- 18 个测试文件、117 个测试通过。

### Conversation Workspace

- 新建 Conversation 时提示用户选择 Workspace 目录，并提供暂时跳过选项；未挂载
  时 Root 不获得文件系统 Capability，仍可执行不涉及文件 I/O 的任务。
- 控制平面保存 canonical 宿主路径，Agent 和 Capability 只使用
  `workspace://current/` 语义挂载点；空闲时可从侧栏入口更换 Workspace。
- 每轮 Root Agent 自动获得 Workspace 子树内文件与目录的读、写、创建和删除
  Authority Ceiling，并可向子 Agent 转授更窄的目录范围。
- 同一 Conversation 的后续 Root 会重新签发上一轮 root 来源的 Authority Ceiling；
  一次性人工 Grant 不跨轮继承。
- Conversation、Workspace 映射和多轮 Root 归属写入与任务快照相同的 SQLite
  事实源，应用重启后不再把每轮 Root 拆成独立 Conversation。

## 1.3.0 - 2026-08-27

### Capability 与资源授权

- 新增 `CapabilityManager`，作为 Capability 校验、Grant 签发、父级委派和
  人工审批路由的唯一内核裁决入口。
- Capability 从字符串升级为可持久化的结构化 Grant，包含 URI 风格资源范围、
  来源链、可转授标记、执行模式、有效期和可选使用次数。
- 资源范围支持 `all`、`exact` 和 `subtree`，URI 在比较前统一规范化，防止通过
  `..` 路径或相似前缀扩大访问范围。
- 根 Agent 的权限形成整棵任务树的 Authority Ceiling。根权限不覆盖请求能力或
  资源范围时，子 Agent 的申请会被内核直接拒绝。
- 普通 Capability 从最近持权祖先开始，沿直接父子关系逐级授权。每一级 Agent
  只能决定是否向自己的直接子 Agent 转授，最终 Grant 仍由 Manager 校验并签发。
- `git.push`、转账、生产部署和外部文件系统写入默认属于人工审批能力；请求在
  Root Ceiling 允许后绕过父 Agent，直接进入人工审批。
- 人工签发的敏感 Grant 默认只能执行一次，并绑定内核操作 ID；同一操作可在崩溃
  恢复后使用原幂等键继续执行，其他操作不能复用该 Grant。

### Work Table 与模型协议

- 子 Agent 等待 Capability 时保持存活并进入
  `BLOCKED(capability_request)`；敏感请求进入 `BLOCKED(human_approval)`。
- Capability blocker 作为 `waiting_for_capability` 非终态进展写入父任务的
  Work Table，通过既有 Completion Mailbox 和 30 秒批处理 timer 投递，不增加
  独立消息队列或立即唤醒路径。
- 多个子 Agent 的 Capability 请求可以在同一 `async_work_update.pending` 中批量
  投递；父 Agent 一轮未处理完的 blocker 会重新进入下一批窗口。
- 新增 `request_capabilities` 和 `resolve_capability_request` 结构化动作。
  Agent 只能声明所需能力和资源，不能指定审批路由，也不能自行构造 Grant。
- 父 Agent 不能在存在 Capability blocker 时返回 `wait_for_async_work`，避免已经
  投递的非终态进展失去后续唤醒路径。
- Gemini、Anthropic 和 OpenAI-compatible Provider 共用统一的结构化响应 Schema
  和解析器，消除厂商协议漂移。

### Tool 与身份边界

- Tool 可见性与执行权限解耦。全局 Tool 不再因当前 Capability 被隐藏，后续由
  Character 层叠加角色专属可见性。
- Tool 可通过 `requiredCapabilities(input)` 按实际参数声明资源权限；旧的
  `requiredCapability` 全局简写继续兼容。
- Tool 调用在登记前和实际执行前均经过 CapabilityManager 校验；工具不存在、输入
  非法或权限不足会作为结构化拒绝返回，不会进入执行器。
- 子任务 ID 完全由内核生成，模型只提交目标和能力请求；Provider 发送上下文时清除
  子任务内部 ID。
- 新增可注入任务 ID 生成器，保留测试和演示的确定性，同时防止模型控制身份。

### 持久化与验证

- Capability Grant、审批请求、逐级委派路径、Work Table blocker 和相关审计事件
  全部进入任务快照；旧字符串 Capability 快照可继续恢复。
- 新增父级授权、Root Ceiling、敏感权限人工路由、三级逐跳授权、并发请求批处理、
  资源范围、防路径逃逸、单次 Grant 和审批快照测试。
- 11 个测试文件、76 个测试全部通过。
- 内核与桌面端 TypeScript 类型检查、核心构建、桌面生产构建和 Git diff 检查通过。

### 当前边界

- 人工审批目前提供 `pendingHumanCapabilityApprovals()` 和
  `resolveHumanCapabilityRequest()` 内核 API，桌面审批界面尚未接入。
- Character 定义、Character 专属 Tool 可见性以及 MCP/Skill Adapter 将在后续版本
  接入。

## 1.2.1 - 2026-08-25

### 修复

- 桌面端启动时自动枚举 SQLite 中的任务快照，并通过调度器批量恢复完整任务树；
  不再出现任务已落盘但重启后无人接管的情况。
- 持久化的 `RUNNING` 模型请求恢复为 `READY`，重新经过准入控制后发送；恢复时间
  统一使用调度器 Clock。
- 批量恢复采用两阶段流程：先重建全部 TCB 与 AgentPool 血缘，再恢复 READY 队列、
  异步结果投递和批处理 timer，消除数据库返回顺序对恢复行为的影响。
- 若子 Agent 已落盘终态、父 Agent 尚未来得及记录结果，恢复时自动对账父任务
  Work Table，避免父任务永久阻塞。
- 保存过完整 `tool_call` 上下文的运行中工具会使用原 callId/idempotencyKey 重启；
  缺少调用上下文的外部工作保留原状态，由对应恢复 Adapter 接管。
- AgentPool 恢复时重建每棵根任务树的累计创建数量，包括已终止子任务，防止重启后
  绕过 `maxSpawnedPerRoot`。
- 父任务已终止或缺失时，恢复中的存活子树会被取消，避免孤立 Agent 继续执行。

### 桌面端

- 启动时等待 Runtime 恢复初始化完成，并将持久化根任务重建为可见 Conversation。
- 应用退出时关闭 SQLite 连接。
- 当前未单独持久化 Conversation 元数据，因此每个恢复根任务暂时对应一个独立
  Conversation；同一根任务下的 Agent 拓扑保持完整。

### 验证

- 9 个测试文件、58 个测试全部通过。
- 新增 RUNNING 重发、终态子任务对账、工具幂等重连、AgentPool 累计额度恢复和
  桌面 Conversation 重建测试。
- 内核与桌面端 TypeScript 类型检查、桌面生产构建和 Git diff 检查通过。

## 1.2.0 - 2026-08-24

### 新增

- 新增 `SqliteTaskStore`：基于 Node 内置 `node:sqlite` 的本地持久化实现，
  实现现有 `TaskStore` 接口，内核与调度器零改动即可替换内存存储。
- 单一 SQLite 文件即唯一事实源；快照与事件以 JSON 文本存入 `body` 字段，
  并冗余 `root_task_id`、`status` 等索引列供崩溃恢复查询。
- 每次状态跃迁的「快照 upsert + 事件增量 append」在同一事务内原子落盘，
  事件按 `sequence` 去重，重复 persist 幂等。
- 采用 WAL 模式优化高频小事务写入，由 SQLite 负责刷盘 durability。

### 变更

- 桌面端 `ObservableTaskStore` 改为包装 `SqliteTaskStore`，在持久化之上叠加
  UI 变更通知；主进程将任务库落在 Electron `userData` 目录下的 `tasks.db`。
- `RuntimeService` 新增 `storeLocation` 选项；省略时使用内存库（开发/测试）。

### 说明

- 选用内置 `node:sqlite` 而非原生编译依赖（如 better-sqlite3），避免 Electron
  跨平台重建负担；该 API 在当前 Node 下仍标注为 experimental，但读写、事务与
  JSON 值行为已在内核与 Electron 内置 Node 上验证一致。

### 验证

- 内核与桌面端 TypeScript 类型检查通过。
- 8 个测试文件、51 个测试全部通过，新增 SqliteTaskStore 持久化、事件增量、
  幂等重写与恢复往返用例，并通过跨进程重开的落盘冒烟验证。

## 1.1.0 - 2026-08-24

### 变更

- 统一子 Agent 创建入口为 `TaskControlBlock.createAgent(request, origin)`：`depth`、
  `createdAt`、`rootTaskId`、`parentTaskId` 与初始状态全部由内核依据创建来源派生，
  调用方无法再伪造层级或血缘。
- 移除模型可控的任务 `priority`；同一深度的就绪任务改为纯 FIFO 调度，深度权重、
  等待老化与父任务唤醒加速保持不变。
- 模型请求的 `delegation` 只保留 `canSpawnSubagents`，不再暴露 `currentDepth`、
  `maxDepth` 和 `availableAgentSlots`，落实每层 Agent 对全局深度无感知。

### 并发与可靠性

- 重构子 Agent 创建流程为「同步准入临界区 + 异步发送」两段：AgentPool 扣减、
  Work Table 登记与预留提交在无 `await` 的同步段内原子完成，据此移除
  `spawn_in_progress` 锁及其拒绝原因。
- 子 Agent 发送（持久化并入队）失败时，自动把已占用的 live 槽位释放回 AgentPool，
  清理登记，并向父任务回传失败结果以唤醒其重新规划，避免父任务永久等待。
- 快照恢复时校验 `depth` 与父子关系的一致性，防止非法层级进入运行时。

### 验证

- 内核与桌面端 TypeScript 类型检查通过。
- 7 个测试文件、47 个测试全部通过，新增并发创建不超卖与发送失败回滚槽位的用例。

## 1.0.0 - 2026-08-22

首个可实际使用的桌面正式版本。

### 桌面应用

- 新增 Electron + React 桌面控制台，支持 macOS 本地开发预览和 Windows x64
  NSIS 安装包。
- 新增 Conversation 侧栏、对话流与 Agent 工程拓扑双视图。
- 新增多轮 Conversation；每轮保存独立根任务和完整 Agent 拓扑，可从对应回复跳转
  查看历史轮次工程图。
- 新增任务入口动态光球、节点状态检查器、运行指标和 AgentPool 剩余容量仪表。
- Agent 阻塞时保持尺寸并切换为灰色；恢复运行后变回黑色；完成后短暂变绿并收回
  父节点，根任务最终展开结果。
- 根任务完成后自动切换到对话流；对话流和工程视图均可发起下一轮任务。

### 模型接入

- 新增统一结构化 Agent 响应解析器。
- 新增原生 `AnthropicModelProvider`。
- 新增 `OpenAiCompatibleModelProvider`，覆盖 OpenAI、Kimi、Grok、MiniMax、GLM、
  DeepSeek、Qwen、豆包和 Xiaomi MiMo 等兼容端点。
- 新增 11 家厂商配置入口。OpenAI、Claude、Gemini、Kimi、Grok、MiniMax、
  DeepSeek、Qwen 和 MiMo 支持账号级模型目录发现；GLM 和豆包提供手工模型 ID
  兜底。
- 模型设置采用“选择厂商 -> 填写凭据 -> 获取模型列表 -> 选择并验证”流程。
- 选中的模型必须通过一次低成本 OS-Agent 结构化协议请求后才会启用。
- 模型切换通过稳定 Provider 代理完成，运行中的 Agent 不允许切换模型。

### 安全与工程化

- API Key 只通过受控 IPC 进入 Electron 主进程，不进入 Renderer 快照、任务上下文、
  事件日志或 URL。
- 系统安全存储可用时使用 Electron `safeStorage` 加密保存；不可用时只保留在当前
  进程内存中。
- 新增 Provider Header 鉴权和结构化响应解析测试。
- 新增 Windows GitHub Actions，自动执行类型检查、测试并上传 NSIS 安装包。

### 验证

- TypeScript 内核与桌面端类型检查通过。
- 7 个测试文件、45 个测试全部通过。
- Electron 空态、运行态、阻塞/恢复、完成回收、双视图、多轮对话及历史拓扑跳转
  已完成实际渲染验证。
- Windows x64 NSIS 安装包可从 macOS 跨平台构建。

## 0.6.0 - 2026-08-21

### 新增

- Gemini 结构化响应新增 `spawn_subagents`、`wait_for_async_work` 和
  `needs_parent_action`，可驱动真实多 Agent 委派与等待流程。
- Gemini 请求现在携带 `delegation`、工具描述和双通道选择后的上下文。
- 新增 Gemini Provider 的委派权限校验、子任务字段校验和异步等待前置条件校验。
- 新增 Ready Queue 峰值、AgentPool 峰值和模型请求并发峰值观测指标。
- 新增 16-Agent、20 次模型请求的三层 Map-Reduce 确定性基准。
- 新增双通道上下文独立测试，验证完整历史、摘要记录、混合模型上下文和快照恢复。
- 新增真实 Gemini `root -> 2 leaf -> root` 多 Agent 冒烟示例。

### 验证

- 确定性基准在模型并发 1、2、4、8 下均完成 20 次请求，未超过 AgentPool 或
  Provider 并发限制。
- 真实 Gemini 测试成功创建两个 leaf Agent，并行返回 `4` 和 `9`，root 收到结构化
  `async_work_update` 后返回 `4+9=13`。
- 真实测试中 AgentPool 峰值为 3、模型请求并发峰值为 2，任务结束后两者均归零。

## 0.5.0 - 2026-08-21

### 新增

- 新增首个真实模型适配器 `GeminiModelProvider`，通过 Gemini
  `generateContent` REST API 发出 HTTPS 请求。
- 新增 Gemini 结构化输出约束，要求模型返回 `output` 和
  `turnSummary.request/outcome`，并转换为内核 `final` 响应。
- 新增 HTTP 状态、非 JSON 响应、候选结果缺失和结构化字段错误的边界校验。
- 新增 Gemini Token 用量解析、可配置价格估算、取消信号透传和可注入 `fetch`
  实现。
- 新增 `demo:gemini` 最小真实网络示例，仅从 `GEMINI_API_KEY` 环境变量读取凭据。
- 新增 Provider HTTP 单元测试和调度器集成测试。

### 当前边界

- 当前 Gemini Adapter 仅支持结构化 `final` 响应。
- Gemini 原生 Function Calling、工具调用、子 Agent 委派和上下文二次压缩适配器
  尚未接入。
- API Key 不进入源码、示例默认值、测试快照或 Git 仓库。

## 0.4.0 - 2026-08-21

### 新增

- 新增持久化 `AsyncWorkGeneration` Work Table，统一记录工具与子 Agent 的运行状态、
  完成结果、投递状态和批处理截止时间。
- 新增 `async_work` 模型响应，支持同一轮混合启动多个子 Agent 和多个长时工具。
- 新增 `wait_for_async_work` 模型响应，允许父 Agent 处理部分结果后继续等待后台工作。
- 新增 `async_work_update` 上下文，分离本批新增结果、仍在运行的工作和整批完成标记。
- 新增按父任务按需创建的一次性批处理 timer，默认窗口为 30 秒。
- 新增全部工作提前完成的快速路径，无需等待 timer 到期即可唤醒父任务。
- 新增异步工作注册、终态和批量投递事件。

### 变更

- 工具调用和子 Agent 结果统一进入 Completion Mailbox，不再使用整批
  `Promise.all()` barrier 等待。
- 只读工具仍并行执行，有副作用工具仍串行执行，但每项工作完成后会独立写入 Work
  Table。
- 父模型运行期间到达的结果会在当前轮次结束后合并投递，父任务级异步状态修改按顺序
  串行化。
- `TaskSnapshot` 现在包含异步 generation、未投递结果、`deliveredAt` 和
  `batchDueAt`。
- 父任务以任意终态结束时，会中止仍在运行的本地工具并递归取消存活子任务。

### 安全与可靠性

- timer 恢复支持剩余窗口重建，以及“截止时间已清除但尚未投递”崩溃间隙的立即补偿。
- 工作 ID 在创建子任务和提交 AgentPool 预留前校验唯一性，避免留下孤立子任务。
- timer 到期、工具完成和子 Agent 完成对同一父任务的修改经过任务级串行化，避免重复
  timer、重复投递和快照覆盖。
- 工具真正执行前再次检查任务终态，防止排队中的副作用工具在父任务结束后继续启动。
- 新增混合工作部分投递、全部完成快速路径、timer 恢复、到期投递恢复、模型运行中结果
  到达和父任务终止清理测试。

## 0.3.1 - 2026-08-21

### 修复

- 修复部分风险。

## 0.3.0 - 2026-08-20

### 新增

- 新增 `TURN_SUMMARY_PROTOCOL`，每次正常模型请求都要求模型在主结果之外搭载结构化
  `turnSummary.request` 和 `turnSummary.outcome`。
- 新增完整上下文与摘要上下文双通道存储。轮次摘要记录其对应的原始上下文索引区间，
  不覆盖或删除完整历史。
- 新增 `ContextWindowManager`，默认在模型上下文窗口达到 80% 时触发压缩，并以 60%
  作为压缩目标。
- 新增早期摘要与近期完整记录的混合上下文构造。运行时从最旧轮次开始逐段替换，
  达到目标后停止，避免不必要地损失近期细节。
- 新增可替换的 `ContextCompactor` 接口及 `FakeContextCompactor`。本地轮次摘要仍不足
  时，可把混合上下文交给模型厂商进行二次语义压缩。
- 新增轮次摘要与二次压缩事件，并将摘要记录纳入任务快照和恢复流程。
- 新增搭车摘要、混合上下文、二次压缩、压缩失败和子任务预检失败回传测试。

### 变更

- 所有进入 Ready Queue 的路径现在都必须先通过上下文窗口预检，包括任务提交、恢复、
  工具唤醒、模型重试、子任务创建、Spawn 拒绝恢复和父任务唤醒。
- `ModelProvider` 现在必须声明 `contextWindowTokens`，`ModelRequest` 新增
  `summaryProtocol`；Provider Adapter 负责映射为厂商 Prompt 和结构化输出能力。
- `FakeModelProvider` 支持按请求动态估算 Token，便于验证不同上下文组合。
- 二次压缩请求与普通模型请求共享 RPM、TPM、并发和预算准入控制，压缩费用计入任务
  总预算，但不消耗任务的正常模型轮次。
- 子任务创建顺序调整为“注册子任务 -> 父任务建立等待关系 -> 子任务上下文预检”，
  确保预检失败的子任务仍能把失败结果回传给父任务。

### 安全与可靠性

- 超过预警值且无法压缩的请求不会进入 Ready Queue，避免任务轮到发送时才突然失败。
- 二次压缩后仍超过目标值时会确定性终止，不会形成无限压缩循环。
- 二次压缩输入自身超过 Compactor 上下文窗口时会在调用前失败。
- 压缩等待状态纳入 `runUntilIdle()` 的 pending/stalled 统计，避免形成不可见悬挂任务。

## 0.2.0 - 2026-08-20

### 新增

- 新增全局 `AgentPool`，分别限制：
  - 同时存活的 Agent 数量；
  - 每棵任务树累计创建的子 Agent 数量；
  - 子 Agent 委派树的最大深度。
- 新增根任务、父任务和委派深度元数据，并将其纳入任务快照。
- 新增 `spawn_subagents` 模型响应和批量子任务创建流程。
- 新增 `needs_parent_action` 子任务结果，允许叶子 Agent 把无法独立完成的前置工作
  结构化返回给父任务。
- 新增子任务创建、结果回传和拒绝原因事件。
- 新增三级深度感知就绪队列，默认采用 `Q3:Q2:Q1 = 4:2:1` 加权轮转。
- 新增等待老化机制，长期等待的浅层任务会逐级提升有效调度层级。
- 新增父任务唤醒加速，父任务收到全部子任务结果后可获得一次最高层调度机会。
- 新增 Capability 衰减检查，子任务不能获取父任务没有的能力。
- 新增 Agent 池、分层队列和三层委派流程测试。

### 变更

- `maxModelAttempts` 现在作为任务模型调用总轮次上限实际生效，防止反复委派或
  重试形成无限循环。
- 模型请求现在携带当前深度、最大深度、剩余 Agent 槽位以及是否允许继续委派。
- 子任务创建改为先检查并预留所有槽位，再创建子任务，最后才阻塞父任务。
- 任务终止后会释放 Agent 池槽位，并把结构化结果写回父任务上下文。
- `ReadyQueue` 从单数组静态优先级升级为深度加权调度，同时保留同层任务优先级和
  FIFO 顺序。

### 安全与可靠性

- 最大深度到达后，即使仍有空闲 Agent 槽位，也会拒绝继续委派。
- Agent 池已满时，父任务保持可运行，不会进入等待不存在子任务的阻塞态。
- 每棵任务树的累计创建额度不会因为子任务结束而重置。
- 禁止重复使用任务 ID，避免覆盖任务快照、事件和父子关系。
- 同一父任务的并发创建请求通过父任务级锁串行化，避免重复分支和等待关系覆盖。
- 父任务取消时会向下取消当前存活的子任务。

## 0.1.0 - 2026-08-19

### 新增

- 初始三态任务模型：`READY`、`RUNNING`、`BLOCKED`。
- `TERMINATED` 终态和受控状态转换。
- `TaskControlBlock`、任务快照和只追加事件历史。
- 单队列优先级调度、RPM/TPM/并发/预算准入控制。
- Provider 抽象、Fake Model Provider 和 Capability 工具权限。
