# Agent 轮次编排

公共入口：`os-agent-js/agent-round`。它连接 agent-context、agent-scheduler 和
model-requester 的公共接口。scheduler 无需识别普通轮或总结轮，也没有新增总结队列
或异步操作类型。

宿主创建 `createAgentRoundRunner(options)`，取得准入额度后领取
`scheduler.takeNextRun()`，再调用 `runner.execute(run, signal)`。
每次 execute 只处理一张运行凭据，每张凭据最多通过受控 request 端口请求模型一次。
execute 不自行领取下一轮、不自动循环重试。

执行顺序：

1. 检查有效运行凭据及已提交回执。
2. 解析批次中的事件、操作结果，按容量持久写入 Context 收件箱。
3. 根据 Context 阶段构建普通轮或总结轮。
4. 调用同一个 ModelRequester，传播取消信号，检查完整请求容量。
5. 提交上下文结果；全部输入接收后确认批次，否则保留原批次归还凭据。

普通轮通过宿主 `work` 适配器提供业务协议。它收到去除内部身份的 `view`、
受控 `request`、`run` 和稳定的 `idempotencyKey`，返回 `decision` 与可选语义记录。
`run` 只供可信执行模块登记异步操作，不得放进模型消息。
工具副作用必须从批次键派生稳定幂等键，不能用每次重试都会变化的 runId。
普通业务适配器的请求策略和工具执行授权由宿主负责。

总结轮不调用 work，而是把封存场景转换为只可提交总结的请求。
只接受原生 `submit_summary` 输出函数，其参数必须符合严格的 ContextSummary 结构；
该函数只承载结构化输出，不能触发业务工具或外部副作用。
模型省略可空集合时，输入边界将 observations、decisions、artifactRefs、unresolved、
nextResponsibilities、lessonCandidates 补为 []。outcome 与 sourceRefs 仍为必填，
显式 null、错误类型、未知字段及越界来源仍会拒绝；核心持久结构不放宽。
格式错误会标明字段路径，供有限次数的模型纠正使用。
模型总结轮使用宿主为本次封存生成的 `s0`、`s1` 等短来源编号。输出 schema 固定，
允许的来源在当轮输入中提供，提交前由宿主校验并精确还原为真实来源 URI。
未知编号或拼错 URI 被拒绝；已有完整 URI 的持久请求仍只接受本次授权来源。
宿主固定绑定总结所属的封存来源，避免模型遗漏确定的元数据导致重复重试；
不会代填工作结果、事实或事实来源。核心存储仍严格验证封存归属和全部引用。
私有 continuation 不写入 Context。失败时保留待总结状态并归还原调度批次；
下一张凭据仍执行总结，不重做已提交的普通业务轮。
总结次数在取得准入后、发送前持久化，达到策略上限后不再发送新请求。
若准入在请求器内部，宿主必须注入 `dispatchRequest(input, signal, beforeSend)`：
准入成功后、实际网络发送前同步调用一次 beforeSend，钩子抛错不得发送。
准入拒绝和持久回复缓存命中不调用钩子，最后一次已发送回复仍可重放提交。
未注入时保持直接 ModelRequester 的用法，宿主需在外部先取得准入。
总结请求与缓存使用 `summary:<pendingSummary.id>` 独立键，不能复用输入批次键；
失败修复请求时也须使用同一键。普通业务副作用仍使用固定批次键。
宿主需对 execute 抛错采用有界退避、停止或人工处理策略，不能无限立即重试。

总结期间的输入按可用容量进入持久收件箱，不改变已封存的总结来源。
`commitSummaryPhase` 只保存总结阶段回执；未全部入箱时归还完整原批次，
不调用 inputsReceived，也不生成批次完成回执。后续排空 inbox 并幂等接收余项，
全部接收后才确认来源并调用 `acknowledgeRound`，不能确认或丢弃未入箱输入。
总结阶段已提交但批次未确认时，恢复先补接输入，再完成调度确认，
不重发该总结或重做业务。同一保留批次可按容量推进多次独立压缩。

Context 判断是否还要推进，scheduler 判断是否还有未交付结果、事件或在途操作。
二者都没有工作时才能休眠；在途操作存在时不能声明目标完成。
`wait` 必须有可观测的在途操作提供唤醒路径。
对超时、取消或旧计划的迟到结果，resolver 必须保留操作发起时的 ContextCursor，
交由 Context 进行版本隔离。

当前实现共用 scheduler 的并发额度与请求器端口，agent-runtime 在发送前接入
RPM/TPM/费用准入；未连接旧 TCB AdmissionController 或桌面 Runtime。
每个 Agent 只创建一个 runner，保持单写者；多 Agent 各自创建 runner，共享 scheduler。
该模块不提供长期工具的持久执行器或服务商私有推理重放管理。

可运行示例：[agent-context-rounds.ts](../../examples/agent-context-rounds.ts)，
命令 `npm run demo:agent-context`。示例走真实 MiniMax 编解码器，HTTP 返回由本地函数
模拟，不需要真实 Key，也不会发送网络请求。
