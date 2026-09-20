# MiniMax 多模态接入与验证

核对和实测日期：2026-09-09。本次沿用项目已有的 Character、Capability 和本地工具机制，
直接修复内置 skills/tools，没有引入外部技能包或新的 Agent 框架。

## 能力与入口

| 能力 | 实现 | 本次验证 |
| --- | --- | --- |
| M3 文本、原生工具调用 | `MiniMaxModelProvider`，`/chat/completions` | 真实 Graph 创建文件并读取验证通过 |
| 图片输入 | PNG/JPEG/WebP 附件、`media.read`、图片 `artifact.read` | 真实 M3 识别固定色块和生成图片通过 |
| 视频输入 | MP4/MOV/AVI/MKV 附件、`media.read`；M3 `video_url` | 官方示例 MP4 理解通过 |
| 图片输出 | `image.generate` → `image-01` → 本地 Artifact | 真实生成 JPEG、对话显示通过 |
| 视频输出 | `video.generate` → `MiniMax-Hailuo-2.3` → 查询任务 → 文件地址 | 模拟提交/恢复通过；真实请求返回额度错误 `2056` |

M3 负责理解媒体及选择工具。生成图片、视频分别使用独立 API，不把聊天回复当成生成文件。
视频生成是否成功取决于当前账号的对应权益及剩余额度；本次 `2056` 返回明确指出 Token
Plan 用量已达上限，不能据此推断整个 Coding/Token Plan 永远不支持视频。

桌面端选择 MiniMax 并配置 `MiniMax-M3`，完成协议验证后，在对话的 `+` 菜单中添加媒体。
可以输入“描述这个视频”或“生成一张白底红色方块图片”。工作区中的图片应通过
`media.read` 读取。生成结果自动显示在对话中，同时保留 `artifact://` 引用。

图片每张最多 10 MB；每轮最多 4 个附件，解码后合计最多 36 MB，以控制 Base64 扩展后的
请求大小。视频的编码必须能被供应商解码，优先用常规 MP4；扩展名合法并不保证编码可用。
M3 适配器将 MOV Base64 的 MIME 转成官方要求的 `video/mov`，默认每秒采样 1 帧。
M3 的默认模型上下文容量为 1M；桌面每轮仍默认 64K，可在菜单调整。

Gemini 使用原生 `inlineData` 接收视频，并限制内联请求总量为 20 MB；本次未用 Gemini
密钥验证。Anthropic 和通用 OpenAI-compatible 适配器保留图片输入，对视频提前报告
不支持，避免静默忽略附件。MiniMax M2 系列也会提前拒绝图片/视频输入。

当前生成工具提供文生图和文生视频；图生视频、视频编辑、音频生成及 Files API 大文件上传
还没有接入。图片字节存入本地工件；生成视频保存服务商的文件 ID、任务 ID 和下载地址，
地址可能过期，当前不提供离线视频归档或自动刷新下载地址。

## 修复的主要原因

1. **M3 多轮工具协议不完整**：旧实现只把历史转换成自定义文本 JSON，遗漏原生
   assistant 消息和推理字段。现在完整保存 `reasoning_details`、工具 ID 和参数，并
   回传匹配的 tool 结果。异步工具仍在执行时明确回传“已接受”，不伪装成已完成。
2. **异步媒体丢失**：现有工具通过 Completion Mailbox 完成，图片提取却只看直接
   `tool_result`。现在同时处理 `async_work_update`，图片/视频从文本 JSON 分离。
3. **大附件崩溃**：重复分组的 Base64 正则在真实视频上触发 V8 栈溢出，改成无回溯的
   字符扫描与独立填充检查，并增加 2 MB 附件回归用例。
4. **错误反复消耗调用**：鉴权、参数和套餐额度错误立即终止；可重试错误最多连续
   尝试 3 次，指数退避并尊重 `Retry-After`。成功响应会重置连续失败计数。
5. **生成和补丁重复执行**：SQLite 操作账本保存提交意图、远端任务和结果。视频有任务
   ID 时继续查询；提交结果不明时拒绝自动重新生成。文件写入和补丁保存修改前后摘要，
   识别“已写文件、未记完成”的恢复状态，不会把 `value=1` 重复改成 `value=100`。
6. **工具和界面边界错误**：规范化后的根目录禁止删除，递归删除取得子树锁；沙箱必须
   同时通过允许/禁止写入探测；修复上下文选项禁用条件和附件按钮样式冲突。

媒体工具依然经过角色、Capability 和资源锁校验。读取媒体使用 `file.read`；生成工具
分别需要 `media.image.generate`/`media.video.generate` 及 `artifact.write`。
直接嵌入内核时，宿主需注入 `MediaGenerationPort`、ArtifactStore 和 OperationStore。
需要跨进程恢复时使用 SQLite OperationStore；默认内存账本只覆盖当前进程。

## 复现与结果

常规本地检查不调用外网：

```bash
npm run check
npm run desktop:check
npm test
npm run build
npm run desktop:build
```

本次结果为 238 个测试通过、4 个 macOS 进程沙箱测试跳过；当前受限运行环境无法启动
Seatbelt 后端，因此没有把这些隔离测试标记为通过。TypeScript 检查和两个生产构建通过。
本地组件预览使用实际生成图片和官方公开视频，验证了图片展示、视频播放和附件菜单。

真实 API 验证单独启用。用受保护的终端输入或本机凭据管理器将 `MINIMAX_API_KEY`
注入当前进程环境，不把密钥写进命令参数、源码或 `.env`。示例仅打印脱敏结果，报告与
测试文件写入系统临时目录：

```bash
# 已通过本机凭据管理器/隐藏输入设置 MINIMAX_API_KEY
npm run demo:minimax

# 可选：会消耗图片/视频生成额度
npm run demo:minimax -- --media-only --generate

# 独立验证你有权发送给 MiniMax 的本地测试视频
MINIMAX_VIDEO_FIXTURE=/absolute/path/test.mp4 npm run demo:minimax -- --video-input-only
```

默认脚本验证 M3 结构化响应、真实文件工具闭环和图片输入。`--generate` 才执行生成，
视频额度不足时记录失败，不反复提交。真实工具闭环本次用了 5 次模型调用，落盘内容
与读取内容均为 `hello-m3`。官方示例视频被正确描述为猫从跳板跳入泳池。

## 官方依据

- [MiniMax OpenAI 兼容接口与媒体格式](https://platform.minimaxi.com/docs/api-reference/text-chat-openai)
- [M3 Function Calling 与完整消息回传](https://platform.minimaxi.com/docs/guides/text-m3-function-call)
- [图片生成接口](https://platform.minimaxi.com/docs/api-reference/image-generation-t2i)
- [视频生成接口](https://platform.minimaxi.com/docs/api-reference/video-generation-t2v)
- [Token Plan](https://platform.minimaxi.com/docs/token-plan/intro)
- [MiniMax 错误码](https://platform.minimaxi.com/docs/api-reference/errorcode)
- [Gemini 视频理解](https://ai.google.dev/gemini-api/docs/video-understanding)
