# OS-Agent-js 0.6.0 测试报告

## 测试目标

本轮测试验证以下能力：

1. 多 Agent 委派、AgentPool 生命周期和分层 Ready Queue 调度。
2. 模型请求并发准入是否严格遵守配置上限。
3. 完整上下文与摘要上下文双通道是否彼此独立并可恢复。
4. 模型是否能返回符合运行时协议的结构化多 Agent 响应。
5. 子 Agent 结果是否能通过 `async_work_update` 回传并唤醒父 Agent。

## 测试环境

- 操作系统：macOS
- Node.js：v26.0.0
- TypeScript：5.9
- 测试框架：Vitest 3.2
- 真实模型：`gemini-3.5-flash-lite`
- 项目版本：`0.6.0`

## 自动化验证

执行命令：

```bash
npm run check
npm test
npm run build
npm run demo
npm run demo:hierarchy
npm run benchmark:multi-agent
```

结果：

```text
TypeScript 类型检查：通过
单元测试：6 个测试文件、43 个测试全部通过
生产构建：通过
基础三态演示：通过
三层 Agent 委派演示：通过
16-Agent 调度基准：通过
```

## 双通道上下文验证

测试文件：

```text
test/context-window-manager.test.ts
```

场景：

1. 创建多轮原始上下文。
2. 为已完成轮次记录独立 `TurnSummary`。
3. 人为设置较小的上下文窗口，触发混合上下文选择。
4. 检查模型请求上下文。
5. 生成并恢复任务快照。

验证结果：

- `TaskControlBlock.context` 始终保存完整原始历史。
- `TaskControlBlock.contextSummaries` 独立保存摘要及其原始索引区间。
- 模型请求接收“早期摘要 + 最近原文”的混合上下文。
- 混合上下文不会覆盖或删除完整历史。
- 快照恢复后，完整历史与摘要历史均保持一致。

## 确定性多 Agent 性能基准

基准文件：

```text
bench/multi-agent-runtime.ts
```

任务树：

```text
1 个 root
  -> 3 个 middle
      -> 每个 middle 创建 4 个 leaf

总 Agent 数：16
总模型请求数：20
请求深度分布：root/middle/leaf = 2/6/12
Fake Provider 单次固定延迟：20ms
```

基准结果：

| 最大模型并发 | 总耗时 | 吞吐量 | 峰值模型请求 | 峰值存活 Agent | 峰值 Ready Queue | 平均 Ready 等待 | P95 Ready 等待 |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | 427.7ms | 37.4 tasks/s | 1 | 12 | 9 | 83.7ms | 192.0ms |
| 2 | 254.3ms | 62.9 tasks/s | 2 | 12 | 8 | 33.0ms | 85.0ms |
| 4 | 170.9ms | 93.6 tasks/s | 4 | 16 | 9 | 14.8ms | 42.0ms |
| 8 | 128.5ms | 124.5 tasks/s | 8 | 16 | 5 | 4.3ms | 21.0ms |

不变量检查：

- 20 次模型请求全部执行，没有任务丢失或重复执行。
- 模型请求峰值从未超过配置的最大并发数。
- 所有任务最终进入 `TERMINATED`。
- 任务结束后 AgentPool 存活数量归零。
- root 最终得到预期结果 `650`。
- root 恰好收到 3 个 middle 结果。
- 每个 middle 恰好收到 4 个 leaf 结果。
- 20 个模型轮次均生成独立摘要记录。

## 真实 Gemini 多 Agent 冒烟测试

示例文件：

```text
examples/gemini-multi-agent.ts
```

执行方式：

```bash
GEMINI_API_KEY="<仅通过当前进程环境变量传入>" \
  npm run demo:gemini:multi-agent
```

任务流程：

```text
root
  -> gemini-leaf-2：返回 2²
  -> gemini-leaf-3：返回 3²
root 收到两个结果后汇总
```

真实结果：

```text
gemini-leaf-2 -> "4"
gemini-leaf-3 -> "9"
gemini-root   -> "4+9=13"
```

Gemini 返回的结构化动作：

```text
root 第 1 轮：spawn_subagents
leaf-2：final
leaf-3：final
root 第 2 轮：final
```

真实调度指标：

```text
Ready Queue 峰值：2
AgentPool 存活峰值：3
模型请求并发峰值：2
结束后 Ready Queue：0
结束后存活 Agent：0
结束后活动模型请求：0
```

真实 Token 用量：

| Agent | 轮次 | 输入 Token | 输出 Token |
| --- | ---: | ---: | ---: |
| root | 委派 | 334 | 160 |
| leaf-2 | 完成 | 216 | 38 |
| leaf-3 | 完成 | 216 | 41 |
| root | 汇总 | 504 | 78 |
| 合计 | 4 | 1270 | 317 |

上下文结果：

- root 完整上下文类型为 `user -> async_work_update`。
- `async_work_update.results` 恰好包含两个已完成子任务。
- `pending` 为空。
- `allFinished` 为 `true`。
- root 保存两条轮次摘要，两个 leaf 各保存一条轮次摘要。

## 安全检查

执行了以下检查：

- 扫描常见 Gemini、GitHub、OpenAI 和 AWS 凭据格式。
- 扫描 `src` 是否出现禁止的 `any`。
- 执行 `git diff --check`。
- 确认真实 API Key 仅通过进程环境变量传入。

结果：

```text
仓库文件中未发现真实 API Key 或常见凭据模式。
src 中未使用 any。
diff 格式检查通过。
```

## 已知边界

- 性能基准使用固定延迟 Fake Provider，衡量的是本地调度器行为，不代表公网模型延迟。
- RSS 差值会受 Node.js GC 和进程预热影响，不作为稳定性能承诺。
- Gemini 当前尚未映射原生 Function Calling 和单轮 `async_work` 混合响应。
- 任务和 AgentPool 状态仍为单进程内存实现，尚未验证跨进程恢复。
