# 架构

[English](architecture.md) | 中文

## 产品边界

```
DeepSeek Harness
        ↓
capability surfaces and domain state
        ↓
internal dshline presentation adapters
        ↓
bounded TuiSlots / Screen rows
        ↓
native terminal
```

**Harness 拥有能力；dshline 只负责终端呈现。**生命周期、状态、持久化、提供方选择、权威与策略属于 Harness。dshline 读取最狭窄的权威接口，把结构化事实变成终端行，并且不复刻运行时、提供方连接或领域状态机。

渲染器包位于那条边界之下。它了解显示宽度、控制转义、按键、边框盒与 `Screen`；它绝不能了解 Harness、agent、任务、提供方或 Todo 这样的领域。

## 原生滚动缓冲区（scrollback）就是终端模型

`Screen.commit()` 把完成后的会话记录行写入用户真实终端的滚动缓冲区。这些行绝不虚拟化、不作为内存屏幕保留，也绝不重写。`Screen` 只重绘底部有界的活动区域：流式行、输入行、状态或临时浮层。每一次终端写入都经过它，因此活动区域保持最后。

这是刻意的产品架构，而不是临时的实现选择。dshline 不会用拥有历史终端输出的协调器替换 `Screen`，也不会采用备用屏幕/全屏会话记录模型。React + Ink 可以支持不同的终端取舍；dshline 为它已完成会话记录保留正常的终端滚动、选择与复制。

未来的视图代码可能变得更声明式，但它的最终输出仍必须是供 `TuiSlots` 与 `Screen` 使用的有界终端行。浮层可以在打开时改变活动区域；它不能重写已提交的滚动缓冲区。

## 支持 Harness 能力

支持一个 Harness 插件并不意味着把每个插件或提供方复制进 dshline。上游服务图把其中一些接口称为 seam、另一些称为核心服务；对呈现而言，重要的区别是是否存在 dshline 可以消费的标准权威约定。

### 1. 通用能力接口

优先使用标准 Harness 接口，而不是某个具体包或提供方：

| 需求 | 权威 | 呈现后果 |
| --- | --- | --- |
| 后台工作 | `ctx.jobs` | 观察通用任务快照与变更。 |
| 委派工作 | `ctx.subagents` | 观察提供方无关的生命周期与发现。 |
| 编排工作 | `ctx.workflowEngine` + 持久 `tool-workflow/*` 记录 | 观察运行身份、阶段与成员；不持有运行句柄。 |
| 模型 | `ctx.llm` | 读取已注册提供方/模型元数据，以及配置可激活路由的可配置提供方目录。 |
| 用户配置 | `ctx.settings` | 读取脱敏的命名空间描述符；对读取时的修订号执行写入路径操作。 |
| 密钥 | `ctx.credentials` | 询问引用或记录是否已配置且可写；绝不持有值。 |
| 获取凭据 | `ctx.authorization` | 渲染 seam 的中立通知与提示词汇；不拥有登录协议。 |
| 人类命令 | `ctx.commands` | 发现并执行已注册的命令约定。 |
| 工具 | `ctx.tools` | 渲染工具拥有的呈现意图，而不是工具名的特例。 |
| 人类应答 | `ctx.userQuestions` | 注册一个终端应答者；认领本前端能够呈现的请求，绝不假设该请求只发给了本前端。 |
| 会话 | `ctx.sessionQuery` | 查询 Harness 偏好活动的会话语料库；不构建另一个数据库。其全文方法是抽象的，因此把内容搜索视为可选。 |
| 附件 | `ctx.attachments` | 使用持久、授权的附件引用；不保存路径或 base64。 |
| 日志派生的状态 | `ctx.sessionProjections` | 消费已注册的领域快照与变更。 |
| 上下文占用 | `ctx.sessionProjections`（`contextPressure`、`contextBreakdown`、`tokenUsage`） | 读取 O(1) 折叠；绝不自行计数 token 或分词。 |
| 逐条目的上下文组成 | `ctx.tokenMeter` | 只在检视器需要时索取逐节点测量；其自身约定称之为 O(surface)。 |
| 缩减上下文 | `ctx.commands`（`/compact`） | 派发已注册的命令；观察 `compaction/*` 事件。绝不调用 `ctx.compaction`。 |
| agent 组合 | `ctx.agentPresets` | 读取名册、某个预设的组合，以及某个会话实际运行的预设；只通过这个 seam 加入或切换一个 agent，绝不用私有注册表。 |
| Host 组合 | `ctx.dshHomePath`、`ctx.baseUrl`、`dsh plugin` | 通过 Harness 自己的 home-path 服务读取配置文件名册，从 Loader 的 base URL 读取已启动的配置文件；变更只转发给 `dsh plugin`，绝不写入配置文件清单。 |
| 技能 | `ctx.skills` | 用 `snapshot({ cwd, scope: agent })` 观察按作用域解析出的有效目录；提供并检视已解析的摘要。绝不发现、加载或注入技能正文——开头带 `/name` 的一行按原样发送，它的含义由 `dsh-tool-skill` 拥有。 |
| 提供方健康 | `ctx.subagents` | 在呈现指名某个提供方可用的行之前，先向注册表询问哪些提供方存在；绝不从某一行被启用推断可用性。 |

新的 subagent 提供方应通过 `ctx.subagents` 出现；后台生产者通过 `ctx.jobs`；LLM 适配器通过 `ctx.llm`；命令或工具通过其标准注册表。真实 Codex 验收已经证明，发布 `ctx.subagents` / `ctx.jobs` 的提供方由通用 Work 显示，而不是由 Codex 专用的 dshline 代码。[Provider 验收](provider-acceptance.md)记录了该证据及其配置边界。如果所需事实在接口上缺失，改进上游约定，而不是解析文本或私下连接提供方。

技能是最后这条规则当前活生生的例子。`ctx.skills` 回答一个 agent 能看到哪些技能、其中哪些是 `userInvocable`，但真正解释人类 `/name` 手势的消费者是一个独立的包（`dsh-tool-skill`），而没有任何接口说明某个组合是否挂载了它。因此一个手工搭建的组合可以发布一个用户可调用的技能，而任何 `/name` 行都到达不了它。dshline 不推断这种就绪性——不解析预设 YAML，不检视 Cordis 的监听器注册，也不把一个名为 `skill` 的模型工具当作人类手势边界存在的证据；这些读的都是实现而非约定。它遵循 `userInvocable`，这与 Harness 自己的 Web 客户端遵循的约定相同（`session-controller` 的技能目录 Remote 仅按 `isUserInvocable` 过滤），并且这一缺口是向用户记录下来，而不是靠猜。一个权威的就绪性 seam 属于上游工作。

### 2. 已知的投影领域

领域插件可以通过 `ctx.sessionProjections` 发布结构化、日志派生的状态。dshline 可以为 `todos` 或 `goal` 这样的已知键提供原生呈现适配器，但领域与 Harness 仍然是状态权威。TUI 不得解析工具输出、折叠会话日志的第二份副本，或创建竞争性的持久化格式。

投影模式是：

```
domain plugin
        ↓ registers a projection unit
Harness projection registry drives, caches, and notifies
        ↓ snapshot + change feed
dshline presentation adapter
```

对于权威投影状态，读取 `ctx.sessionProjections.snapshot(session)`，并用 `ctx.sessionProjections.onChanged(...)` 订阅。注册表在已提交事件上驱动已注册的纯单元，给 `snapshot()` 一个同步一致的切面，并且只在单元变化时发出变更。dshline 内部的、会话作用域的观察器为确切的 `Session` 订阅一次，在该同步驱动落定后在一个微任务中合并失效，并把所有值留在注册表中供适配器通过 `snapshot()` 读取。它不是第二个投影存储。投影键的存在是进程级的，而不是每会话的能力信号：任何组合注册的键都可能出现在每个会话快照中。请解释投影值（例如 Todo 列表或 `null`），而不是把 `todos` 的存在当作这个确切 agent 启用了 Todo 的证据。这是内部架构模式，**不是**稳定的公共 `ProjectionAdapter` 接口。

`todos` 是第二个证明。`@deepseek-ai/dsh-tool-todo` 提供面向模型的 `todo_write` 工具、持久的整列表 `todo/write` 事件，以及可选的 `todos` 投影。dshline 通过一个有界的 `/todos` 浮层与一个可选的 `todo completed/total` 状态段呈现其当前快照；它不拥有任何 Todo 变更、生命周期、折叠或持久化。Todo 项只有 `content` 以及 `pending`、`in_progress` 或 `completed` 状态；每次写入替换完整列表。投影在写入前是 `null`，包含最新列表，并在下一次 `turn/start` 时清空。预期路径是：

```
@deepseek-ai/dsh-tool-todo
        ↓ todo/write and todos projection
ctx.sessionProjections
        ↓
dshline Todo presentation
```

它不得检查 `todo_write` 调用或渲染后的卡片来推断状态。

权限选择遵循同一条边界：可选的 `permissions` 投影提供部署定义的可选值与当前状态；
裸终端 `/permission` 只呈现这个选择，而选中的值运行已注册的 Harness
`/permission <preset>` 命令。dshline 从不折叠权限事件或直接调用预设服务；没有该
投影时，裸命令原样回退。

上下文智能是第四个，也是把便宜权威与昂贵权威区分开来的那一个。
`@deepseek-ai/dsh-token-meter` 发布三个投影单元——`contextPressure`（提供方最新的
提示词采样、同一采样加上此后 surface 变动的带符号启发式重定价，以及最新记录的路线
容量）、`contextBreakdown`（启发式的 system/tools/messages 组成）与 `tokenUsage`
（提供方分桶的累计值）——全部是 O(1) 折叠。状态行与 `/context` 的头条数字读的就是
它们。

同一服务还暴露 `measure(session)`，它给当前 surface 的每个节点定价并返回一份深拷贝；
其自身文档因此说明该测量是 O(surface)。那是逐条目的 X 光，规则是只有打开着的检视器
才可以索取它。dshline 把一次缓存的测量以节点价格所依赖的全部输入、且仅以这些输入为
键：Harness 自己的 surface 修订号（节点数加上 `replaceGeneration`），以及生效的定价
路线——后者读自 `session.requestHeader()`，因为 header 的 provider 与 model 正是选中
计量所依据的适配器图片定价的东西。因此一个在流式回复期间一直开着的检视器只测量一次，
而落地的压缩（compaction）或路线变更会在下一次绘制时被采纳；而每来一个 chunk 都会
变动的日志长度，特意不进入这个键。只有**成功**的测量会被缓存：计量器缺失或拒绝时会
重试，因为计量器可以在检视器首次读取之后才被挂载，而针对畸形日志抛出的错误也可能被
之后的追加修复。以上任何一项都不存在定时器。

两套词汇绝不混用。预测（projected）占用与启发式的组成并排呈现，且绝不相互相除；逐
条目价格作为估算呈现，因为节点计量是按路线定价或启发式的，而不是提供方的分词器。为了
让一个面板加得起来而把其中一套缩放成另一套，就是 dshline 在臆造记账——这也是逐条目
份额被标注为**消息上下文**份额的原因：`surfaceTokens` 定价的是对话，而 envelope 由
另一个权威定价。

来源判定遵循同一条规则。`contextPressure.projectedTokens` 作为一个预测值呈现，而不是
一个偶尔变得精确的提供方数字：与 `pressureTokens` 相等并不能证明 surface 没有动过，
因为多处变动可以互相抵消为零。压缩摘要只依据压缩自身的持久 checkpoint source 来认定
——即 `{ kind: 'plugin', plugin: 'compact' }` 标记加上该事务的 `compactionId`，以结构
方式读取，而不是通过 `isCompactCheckpointSource`，那是一个位于可选包中的值——其他任何
替换都报告为 `replaced`，因为 surface 约定允许任何生产方进行替换，也并未说明一次替换
就是一次缩减。

`tokenUsage` 的范围是 agent（智能体）自己的模型请求。压缩的摘要生成器把它的用量报告在
`compaction/summary` 上，而该投影不折叠它（上游自己的投影测试就追加了该事件，并断言
各分桶保持不动）。dshline 如实报告这一范围，而不是为它增加记账。

压缩（compaction）遵循观察/控制的分离。dshline 读取持久的 `compaction/start`、
`compaction/summary`、`compaction/end` 与 `compaction/prune` 事件来呈现变化了什么——
包括完全没有命令生命周期的自动压缩——并通过 `sourceEventSeq` 把命令结果与它点名的
事件关联起来，且仅在该事件确实被本前端投影过时才采纳。缩减本身仍属于已注册的
`/compact` 命令，它拥有校验、agent（智能体）空闲锁、取消、持久生命周期与持久化检查点。
`compactRegion` 存在于该服务上，并被特意不暴露：人类命令不接受参数，而一个范围选择
界面会是上游尚未定义的控制约定。

Goal 是另一个已知投影领域，有一个重要的额外权威：其持久的 `goal` 投影代表日志派生的目标状态，而 `ctx.goals` 拥有实时、进程局部的续跑激活。因此，声称恢复的会话将继续的目标视图必须使用目标服务来获取该实时事实；单独的投影无法提供它。Plan 仍由其文档化的 Harness 权威治理。

### 3. 新颖的第三方能力

第三方插件可以引入 dshline 没有原生适配器的领域。这是将来提供小型 TUI 贡献 API 的原因，而不是为每个插件承诺定制 UI 的理由。首先我们需要几个内部适配器来确立权威、生命周期与布局规则。

`TuiSlots`、`TuiSlotView`、`TuiSlotName` 与 `TuiOverlay` 是 1.0 之前实验性的词汇。它们不是稳定的 SDK，还没有承诺任何公共 API 包。持久扩展行还需要全局布局预算；在那之前，能力 UI 属于有界浮层。

**composer 与浮层共享视觉根，而不是所有权。** composer 与每一个临时浮层都通过同一个共享边框绘制——左边是 `dshline`，右边是工作区或视图身份，导航帮助在下边框内部——因此浏览器读起来像 composer 展开，而不是脱离的模态框。这种共享只是呈现层面的：浮层挂载期间仍然替换整个活动区域并接管每一次按键，composer 的缓冲区与光标不在它下面，关闭时 composer 原样恢复。共享 chrome 是一个纯辅助函数，无状态、除它所渲染的内容外无输入、没有自己的生命周期、也不持有对 Harness 的视图；输入与状态所有权不与它共享。

## Work：第一个通用适配器

Harness Work 是遵循这一模型的第一个适配器。它通过 `/work` 与一个可选状态摘要，在独立分区中呈现 `ctx.jobs`、`ctx.subagents` 与 Harness 工作流（workflow）运行。它用 `list()` 读取任务快照并观察 `onJobsChanged()`；它不消费面向模型的 `read()` 游标。它观察 subagent 生命周期边沿，并且只从 Harness 发布的 `listChildren()` 事实中丰富。没有权威关联 id，它不合并两个权威，也不发明提供方未暴露的标签或活动运行。

三个权威，一个投影层：

```
ctx.jobs                        → Jobs
ctx.subagents                   → Subagents
tool-workflow/* + workflow/*    → Workflows
```

工作流需要第二条所有权规则，这正是它们成为独立适配器、而不是在任务/subagent 投影内部再加分支的原因。任务读取按调用方作答，subagent 生命周期边沿按委派父级限定作用域，但原始 `workflow/*` 事件携带的是 `{ id, meta }`——一个运行的身份，而从不携带请求它的那个 Session。仅仅订阅那条事件流，会把另一个窗口的编排显示进这一个窗口。

因此所有权来自持久这一侧。`dsh-tool-workflow` 只把 `tool-workflow/run-start` / `agent-start` / `agent-end` / `run-end` 追加进顶层运行的父 Session，别处都不写；在 subagent 内部启动的嵌套运行不记录任何东西。`run-start` 到达了所附会话自己日志的运行可证明属于本窗口，而存活的 `workflow/*` 事件只对那些记录已经证明过的运行被接受——作为丰富信息（描述、当前阶段、最新日志行、终态停止原因），绝不作为第二份成员存储。六个 `workflow/*` 事件中只订阅四个：`workflow/start` 在 `workflowEngine.start()` 内部同步发出，因此每次都会被所有权闸门丢弃；而 `workflow/agent-end` 只会为那些其 `agent-start` 已经携带过相同 meta 的调用发出。重建只依据实时事件流：一个已死进程留下的 `run-start` 并不能证明现在有脚本正在执行，而持久的工作流历史属于 transcript（文本记录）。

这条所有权规则也换来了 Work 所做的唯一那一条关联。`WorkflowAgentInfo` 在 subagent seam 上发布每个成员的 `childId`，因此一个工作流成员与一个 subagent 生命周期期可证明是同一个子级；成员把该子级呈现在它的工作流之下，而不是在扁平的 Subagents 分区里重复一遍，而从成员导航过去到达的是同一套 subagent 呈现。没有其他任何一对记录被联接，并且已结束的成员会释放该联接。

动画规则出自同一套纪律。弧线转子意味着 dshline 持有正在计算的证据——一个 Harness 报告为 `running` 的存活进程内子级 Agent。处于 `running` 的任务是一条注册表记录而不是一次观察，而没有发布进程内子级的提供方并不通过通用 seam 暴露中间活动，因此两者都保持静态。工作流只在它自己的某个成员在动时才动，因为引擎在两次 `agent()` 调用之间不发布属于自己的执行信号。`ctx.workflowEngine` 暴露 `start()`，别无其他可供 UI 触及的东西，所以 Work 观察工作流运行，不对它们提供任何控制。

人工验证的 Codex 提供方是这些通用约定的验收证明，而不是直接的 dshline 集成。通过 `@deepseek-ai/dsh-subagent-claude-code`、`ctx.subagents` 与 `ctx.jobs` 的 Claude Code 是合乎逻辑的下一个目标，但尚未人工验证。两者以及未来提供方的必需路径记录在 [Provider 验收](provider-acceptance.md)。

## Sessions：一个语料库，两个生命周期

Sessions 是第三个适配器，它只读取一个权威。`ctx.sessionQuery` 已经发布一个偏好活动的逻辑语料库，把 `ctx.sessions` 与任何已挂载的持久化合并，因此浏览器列出 `listSessions()` 记录、用一次批量的 `readTitleSnapshots()` 观察折叠它们的标题，并从 `listEvents()` 取选中行的事件数。没有会话目录扫描、没有标题缓存、没有第二个索引；前端索引会在任一侧第一次变化时与语料库不一致。

引擎的两个全文方法是它**唯一**的抽象接口，因此内容搜索是可选能力，而不是保证。后端未实现任何内容搜索的部署报告 `SESSION_QUERY_SEARCH_DISABLED`，浏览器在说明内容搜索已关闭的同时继续过滤它已有的行。过滤不是私有索引：它匹配一行已经显示的文本。

Sessions 还迫使了一个前端此前不需要的生命周期拆分：

```
window        terminal, key routing, model route, reader preferences
   ↓ attaches
attachment    one Agent, its log projection, its capability adapters, its views
```

当一次启动在进程生命周期内恰好驱动一个会话时，插件 fiber 与会话是同一个生命周期，`ctx.effect` 是适合拥有一切的地方。原位重新打开会话打破了这个同一性：槽位注册、日志监听器、旋转指示器以及 Work 与投影适配器都描述同一个会话，因此它们属于一个在其 agent 句柄之前拆除的 `SessionScope`。按键路由向另一个方向移动，上移到窗口，这也是为什么 `ctrl-d` 现在从启动浏览器退出，而那个浏览器不拥有自己的键盘。

重新打开只使用受支持的生命周期，别无其他：拥有的 `AgentHandle.dispose()` 使当前 agent 退役——句柄是本前端的能力，因为本前端创建了该 agent——而 `ctx.agents.resume` 打开下一个。会话记录追加进已有内容下的原生滚动缓冲区；没有任何已提交内容被重写。被拒绝的恢复既不终止进程，也不替换会话：到那时前一个 agent 已退役，因此窗口提交 Harness 的原因，并通过同一个浏览器再次询问。关掉它正是读者刻意选择新会话的方式。

## Connect：配置是四个 seam，而不是一个

Provider 配置是前端最容易滋生自己意见的地方——一个提供方列表、一个 OAuth 实现、一个它写入密钥的文件。Harness 已经拥有这一切，分为四个回答四个不同问题的独立接口：

| 问题 | 权威 |
| --- | --- |
| 哪些提供方路由根本可以配置？ | `ctx.llm.listConfigurableProviders()` |
| 现在注册了哪些？ | `ctx.llm.listProviders()` |
| 一个如何配置、在什么修订号下？ | `ctx.settings.describe()` / `mutate()` |
| 它命名的密钥是否存在且可写？ | `ctx.credentials.describe()` / `set()` |
| 需要询问时，凭据如何*获取*？ | `ctx.authorization` |

`/connect` 是这些的联结，别无其他。随之而来三个后果，每一个都是一个快捷方式被拒绝的原因：

**没有提供方注册表。**一条路由进入浏览器，是因为某个已挂载适配器声明它可配置——裸挂载的 `llm-pi-ai` 会在任何路由存在之前，为其整个已安装目录这样做。dshline 不发布提供方名称列表，因此添加提供方的适配器无需此处代码变更即可呈现。

**没有字段名知识。**存储 API 密钥需要知道哪个配置文件属性携带凭据*引用*，而两个随附适配器都把它叫做 `apiKeyEnv`。dshline 不这样：它从 `describe()` 读取命名空间的序列化 schema，取 schemastery 角色为 `credential-ref` 的属性。角色是约定；名字是巧合。

**没有登录协议。**`ctx.authorization` 渲染为一个通知形态与三个提示形态——`text`、`secret`、`select`——刻意比任何提供方自己的词汇都小。一个能渲染一个流程的接口能渲染所有流程，因此 OAuth、设备码与在提供方库提示中键入的密钥都以同一种交互到达这里。终端专属的决策只是每一半*放哪里*：通知提交到原生滚动缓冲区，因为登录 URL 与设备码是一个人最需要选择和复制的两样东西，而提示是有界浮层，因为它要接收键盘。

浏览器拥有它启动之物的生命周期。授权尝试可以带着没有挂载提示的浏览器回调等待，因此关闭 `/connect` 会中止该尝试的信号——seam 把它结算为 `cancelled`，任何已挂载的提示随之落下，而尚未观察到其信号的流程之后的任何通知或提示都会被丢弃，而不是画在不相关的会话记录上。

由于两个接口写入同一个命名空间与同一个引用，终端中做出的变更在官方 Web Models 页可见，反之亦然。两者都没有自己的存储可以与之不一致。对尚未命名引用的路由的 `<ROUTE>_API_KEY` 派生，正是为此共享的。

`/connect` 刻意**不**做的一件事是联结它的两个分区。可配置提供方条目由 `settingsNs` 加一个路由键寻址；授权流程由一个作用域为其所属插件注册名的 `CredentialKey` 寻址。这些对今日随附的适配器恰好重合，但 Harness 不发布它们必须重合的约定，因此合并这两行会是前端发明关联——与 Work 把任务与 subagent 分开时相同的拒绝。两者都被列出，各自使用 Harness 给它的身份。

seam 接口本身在 `connect/harness.ts` 中结构化写出，而不是依赖整个服务，原因与 `SessionQueryReads` 给出的一样——点名一个视图调用比依赖整个服务更易读。该文件里的每一个导入仍然只是类型导入，所以 Connect 在运行时不携带任何 Harness 代码；`connectSeams` 中的三处赋值在每次构建时把每个窄视图与真实服务做校验，因为每个服务包都用自己的类型扩展了 `Context`。

### Connect 2.0：一条路由可以是声明，而不只是查找

`listConfigurableProviders()` 说明哪些路由是适配器已经知道如何激活的。它对一条尚不存在的路由——一个私有网关、一台自托管服务器、一个本地 OpenAI 兼容端点——什么也不说，因为 `LlmConfigurableProvider` 里没有任何字段标记「这个命名空间接受一个它从未见过的键」。这在当前 Harness 上是真实存在的空缺：没有通用 seam 能让配置界面询问「我可以在这里声明一条全新的路由吗」，官方 Web Models 页填补这个空缺的方式与本前端相同——具体地知道 `llm-pi-ai` 的设置配置文件能够描述整条提供方路由。

一个把命名空间的路由形状化为 `dict` 的 schema——即「一个元素节点描述每一个键，无论是否见过」这一形状——只证明了该处结构上接受任意键。它不能证明写入这样一个键就声明了一条新的 LLM 路由：未来某个适配器完全可能发布 `providers: dict<ProviderConfig>`，却仍然只识别一组固定的键，而 schema 形状本身对此不会给出任何相反的说明。`/connect` 不允许这个推断跨入通用代码。`connect/model.ts` 把 `ConnectNewRouteTarget` 保持为一个纯粹的数据形状——一个命名空间、一个父路径、一个修订号——并且不断言哪些命名空间可以安全地产出这样一个目标；它绝不在那里仅凭 schema 形状推导出来。

这一判定只做一次，在 `connect/pi-ai.ts` 内部完成，它是唯一被允许知道 `llm-pi-ai` 具体是一个其设置配置文件能够描述整条提供方路由的领域的模块。`piAiDeclarationTarget()` 先把目录过滤到 `llm-pi-ai` 自己的条目，再检查它们是否就其 dict 所在位置达成一致、该处的 schema 是否真的把它形状化为一个 `dict`、精选的 `baseURL` 字段是否仍然可达，以及是否仍能推导出一个协议选项——这与 `protocolChoices()` 所做的是同一个 schema 形状检查，因为一个此模块无法为其提供协议的命名空间，同样也是一个它无法安全地向其声明路由的命名空间。任何一项检查失败都意味着 schema 已经偏离了这个呈现模块所知道的读法，而 `+ 添加自定义提供方` 只在每一项检查都通过时才被提供——绝不提供一行注定会在向导中途失败的选项，这与 Connect 其余普通动作已经遵循的「不提供已知会失败的选项」规则相同。如果 Harness 之后发布了自己的声明 seam，`piAiDeclarationTarget()` 就是该被替换的函数，而不是 `connect/model.ts`。

知道一个地址存在，不等于知道该往那里写什么。一个精选编辑器需要「基础 URL」「协议」「模型目录」这类没有任何通用 seam 会发布的字段名，因此呈现它们本身就意味着了解某一个命名空间的形状。这份知识与上面的声明检查一起被隔离在 `connect/pi-ai.ts` 中，而且它：

- 把它精选的四个字段（`displayName`、`baseURL`、`api`、`models`）命名为普通字符串，并从命名空间自身的序列化 schema（字符串常量的 `z.union`）读取协议*选项*，而不是一个 dshline 常量，因此 `dsh-llm-pi-ai` 之后新增的协议无需在此变更；
- 通过其他每个 Connect 动作已经使用的同一套 `ctx.settings.mutate()` 路径操作写入——每个变更字段一个 `set`/`unset`，绝不整体替换，因此 `compat`、请求头、重试策略以及本次未渲染的其他一切在编辑后原样保留；
- 在运行时从不导入 `@deepseek-ai/dsh-llm-pi-ai`，不注册任何提供方，不解析任何模型输出，也不发起任何网络请求。这些事情仍然全部由 Harness 完成。

创建向导本身的失败关闭方式与它的声明检查一致：如果它在向导实际打开的那一刻推导出的协议选项为空——即那一行被展示与向导真正开始之间发生了 schema 漂移——它会立即拒绝，而不是写入一个 Harness 会在几步之后以一个信息量更少的错误拒绝的、被猜测出来的 `api: ''`。而且这个向导从不在中途持久化：每一个字段，包括模型目录，都先被收集进一份内存中的草稿，只有在最终审阅——展示回 Provider ID 与其余每一个字段，API 密钥永远只显示「已配置」或「未设置」——上明确选择「创建提供方」，才会触发第一次写入。特别是离开模型子菜单而未采纳任何内容不会改变任何东西：一条继承其目录的路由会保持继承状态，直到一次真正的采纳发生，绝不会仅仅因为子菜单被打开又关闭，就变成一个被存储的 `models: []`。

`connect/model-editor.ts` 与 `connect/route-editor.ts` 建在其上：前者是模型列表草稿的纯逻辑（采纳一个被发现的候选项而不覆盖手工修正过的容量，把继承的目录与显式的空目录区分开），后者把其他每个 Connect 动作已经使用的同一套 `promptSelect` / `promptText` 浮层编排成两个小型菜单循环——编辑一条已声明的现有路由，与声明一条新路由——而不是一个定制的表单浮层。

模型发现是建议性的，并且这一点由构造保证：`ctx.llm.discoverModels()` 接受一份草稿（对已有路由是 `provider`，好让所有者适配器自行解析它自己存储的凭据，本前端永远不会把它读回来；对尚不存在的路由则是一次性的、手动键入的密钥）并回答候选项。一个 id 已在草稿中的候选项会被原样保留——一份端点列表至多携带一个 id、一个名字与两个容量，永远不会比一行已被人工修正过的记录知道得更多——而且在读者明确保存之前，任何取来的内容都不会被写入。

结果正是验收测试所围绕的那个形状：

```
custom endpoint
    ↓
Harness settings  (ctx.settings.mutate through connect/pi-ai.ts's path ops)
    ↓
llm-pi-ai         (resolves the declared profile into a live provider)
    ↓
ctx.llm provider route
    ↓
dshline /model
```

而绝不是：

```
custom endpoint
    ↓
dshline client
```

dshline 不发起任何提供方 HTTP 请求，除了在一次显式的创建之后交给 `ctx.credentials.set()` 的那个一次性值之外不持有任何密钥，也不保留第二个状态存储：一条被创建的路由可以通过与每一条目录路由完全相同的 seam 来寻址、编辑与移除。

## 预设：组合属于 Harness，不属于 dshline

agent 预设是 Harness 自己对"这个 agent 能做什么"的回答——一个由工具、提示词分节与委派后端
构成的具名组合，通过 `ctx.agentPresets` 解析，并在其生命周期唯一受支持的那个点
`setup(agentCtx)` 上加入某个 agent。`/plugins` 是这个 seam 的终端呈现：它列出名册，展示运行中
agent 的预设实际组合的那些行，并通过与官方 Web 界面所做变更相同的权威执行变更。它不保留插件
注册表、能力列表，也没有自己的提供方专用分支——正是本文档中每一个适配器都遵循的同一条规则，
只是从"它能与哪些提供方对话"换成了"这个 agent 有哪些工具"。

**系统预设属于 Harness，在这里保持只读。**随部署一同提供的预设带有 `system` 信任等级；
`/plugins` 绝不编辑那个文件。定制其中之一走的是 Harness 自己支持的路径——把它复制为一个新的、
本地编写的预设（`ctx.agentPresets.copy()`），然后编辑副本——在内置预设的行上按空格，正是终端
提议去做这件事，而绝不是绕过它的捷径。用户编写的副本除了它自己的组合文件之外，没有更窄的
Harness 变更 API，因此在那里切换一行是只触及该字段、其余部分原封不动的最小编辑；结果是否可用，
仍由 Harness 自己对该预设的健康检查决定，而不是私自重新读取它。

**会话组合是生命周期事实，不是本前端保存的设置。**新会话按名册当前的默认值组合。已恢复的会话
按它自己日志所记录的内容组合——它被创建时所用的预设，或它还空白时做出的后续切换——而绝不是
*今天*碰巧是什么默认值；已产生会话的工具集是历史，把它当作活动设置会让它在一段已经发生过的
对话脚下漂移。`/plugins` 自己的选择器强制执行运行中会话已有的同一条边界：只有会话还空白时才能
实时切换预设，而在切换当前会话不属于 Harness 允许范围的地方，明确提供切换*下一个*会话默认值的
选项。那条边界在被执行的那一刻重新读取，而不是沿用决定某次按键时的读数：这里的一个动作要跨越
自己的若干 await——两次由人回答的提示、一次文件写入、一次 Harness 重新解析——而跨越它们开始的
一轮必须改变答案。

在无法精确定位那段历史的地方，缺口被点名，而不是被含糊带过。在 dshline 采纳预设之前产生的会话
根本没有记录预设，因而按随附的 `standard` 恢复——这个预设的含义正是每个这样的会话当初实际
运行的那套扁平工具集。未提供可用 `standard` 的部署没有诚实的等价物，因此恢复回退到该部署自己的
默认值，并把这次替代报告进 transcript（文本记录）。直接拒绝恢复等于为了保护一份组合记录而扣下
它所属的会话记录，这是错误的取舍：读者能看见一条提醒，却看不见一个打不开的会话。

这也是 dshline 自己的组合为采纳它而改变形态的原因。在预设之前，dshline 为整个进程一次性挂载
`dsh-base` 的完整工具集——对一个无从切换的前端来说是正确的，但对一个浏览组合的命令来说什么也
不是。`dsh-base` 过去无条件挂载的每一个按 agent 的行，现在都移到某个 agent 实际加入的预设之后，
与 Harness 自己的 Web bundle 出于完全相同的理由已经走过的"agent 平面移到 agent 预设之后"是同
一步；而没有按会话含义的进程级服务——各类注册表、沙箱与审批栈、token 计量器——原地不动。

## 配置文件提供；预设暴露

两个 Harness 层回答两个不同的问题，而混淆它们正是本前端要让人看见的那个错误。

```
profile   what the HOST can do    dsh.profile.bundles → patch layers → the composed tree
preset    what an AGENT may see   agent.cordis.yml rows → one agent's tools and prompt
```

配置文件由启动器选定，并在启动时应用一次。预设按会话选定，并且可以在会话还空白时重新组合。
因此 `/profiles` 和 `/plugins` 不是同一件事的两个视图：它们分处一条边界的两侧，而它们之间的
每一处差别都由此而来。

**某一行被启用只能证明后半句。**随附的 `standard` 预设在它自己的可选委派行旁边就是这么说的
——"在这个配置文件中安装对应的 Bundle 并重启 Host，然后复制这个预设，并从对应的工具行上移除
`disabled`。仅有 Host 可用性并不授予工具。"反过来的情况更容易不小心撞上：启用一个其 bundle
从未安装过的行，得到的是一个能挂载的预设、一个模型看得见的工具，以及一次首次使用就失败的委派。
`/plugins` 在能够*证明*的地方补上这个缺口——某一行指名的提供方是已挂载的 Host 注册表并不提供的，
它会被标注，而该行自身的状态保持诚实。在证明不了的地方，它什么也不声称：这项检查是一张能力模块
的数据表，因此它未覆盖的模块、它从不求值的 `!!js` 提供方，以及这个配置文件并不挂载的注册表，
都产生"没有判定"而不是一个猜测。

**重启是这条边界的一部分，而不是关于它的一句附注。**`/profiles` 通过 Harness 自己的包生命周期
`dsh plugin` 执行 bundle 变更，然后说明它影响了什么、没有影响什么：对运行中配置文件的变更报告
`restart required`，对其他配置文件的变更指出接手它的命令。切换配置文件根本不提供，因为没有
seam 能重新链接一个已组合 Host 的 bundle 层，而发明一个正是本文档所禁止的那种竞争性生命周期。

### 启动器唯一的生命周期决定

`bin/dshline.mjs` 是一层启动器封装，首次运行是它唯一触及生命周期的时刻。它询问一个问题，回答“是”时通过与普通启动完全相同的启动器执行一条 Harness 命令——`dsh plugin --profile dshline add @dshline/dshline`——然后继续执行最初要求的那次启动。它不写任何配置文件文件，从不调用 pnpm，也从不读取某个包的 `dsh.bundle` 声明：这些都属于 `dsh plugin`，它本来就会在首次使用时初始化配置文件，并按实际安装状态对账 `dsh.profile.bundles`。

边界就是一个文件。**未初始化**意味着配置文件没有 `package.json`——这正是 `dsh plugin` 自己采用的判据——其余一切都是**已存在**的配置文件。因此，安装被中断的、缺少依赖的、`node_modules` 为空的，或者根本启动失败的配置文件，仍然会照常启动，由 Harness 自己的加载器说明问题所在。在这里修复它，等于去猜一个 Harness 有权威结论的诊断，并把它藏在一次没人要求的软件包操作背后。显式的 `--profile`——包括 `--profile dshline`——会完全关闭这个行为：调用方在直接使用 Harness 的配置文件语义，封装层不再往里添加任何东西。

**dshline 不为 Harness 的配置文件变更做串行化，也不修复它们。**并发的软件包变更由 Harness 定义；dshline 只执行它获得许可的那次安装，并把 Harness 的成功或失败当作权威结论——安装失败就让这次调用失败，什么都不启动。因此两次重叠的首次运行各自委派一次，而不是其中一个去判定另一个的安装已经完成。那个判定在本地没有诚实的答案：`dsh plugin` 在安装*之前*就写入配置文件清单，所以该文件只能证明有一次安装开始了，永远无法证明某次已经完成，而要分辨这一点就得去读依赖、node_modules 或 bundle 状态——也就是上一段留给 Harness 的配置文件健康状况。在 `$DSH_HOME` 下加锁，正是本文档禁止的竞争性生命周期。

## 观察不是控制

可调用的 Harness 变更不自动是人类安全的 UI 操作。在暴露人类操作之前，验证所属接口是否明确提供该操作的生命周期语义、授权、调度语义以及模型感知或通知后果。

Sessions 是指向另一方向的案例。`AgentHandle` 交给创建该 agent 的调用者，其文档说明处置器是那个所有者持有的能力——因此使 agent 退役在这里是被授权的，而重新打开会话是前端可以采取的人类操作。Harness **不**定义的是，当其所属 agent 中途消失时，任务或委派 subagent 应该发生什么，因此窗口在任一者附着时拒绝重新打开，并拒绝在一轮进行中时重新打开，点名原因而不是猜测。重命名会话因镜像的原因被推迟：`ctx.sessionTitle` 建模明确的 `user` 权威，因此它会在浏览器拥有文本输入模式时暴露，而不是作为列出标题的副作用。

`ctx.jobs.kill()` 是当前的反例：成功取消把任务移到 `stopping` 并标记终端交付已报告，这是面向模型的控制语义。因此 Work 观察任务，但不提供人类取消。`ctx.subagents.interrupt(..., { kind: 'user', parentSessionId })` 是相反的案例：seam 明确建模人类停止活动可续 subagent 的权威。这条规则适用于每一个未来能力，而不仅仅是 Work。同样，Work 呈现生命周期与任务状态，而不是提供方推理、命令、工具活动、进度或 diff，除非 Harness 通过通用约定暴露这些事实；它绝不能刮取提供方输出。

## 上游兼容性

Harness 发展很快，因此与其已发布接口的兼容性是头等工程事项。本仓库已经通过构建上游 `master` 的声明并类型检查本项目来每日探测上游；它是早期预警，而不是允许假设未发布的行为稳定。

这一覆盖分为三条并存于 `.github/workflows/ci.yml` 的车道。**Minimum（下限）** 把每个 `dsh-*` devDependency 固定到一个确定的下限版本——peer 范围仍然承诺支持的最旧发布版本——并检查该依赖图仍能解析、构建与类型检查。**Released（已发布）** 按照 `tools/sync-harness.mjs` 与 `tools/check-peer-currency.mjs` 已经使用的方式解析当前已发布的产品线（注册表的 `next` dist-tag，cordis 自身的 `latest` 例外），把两个清单中的每个 Harness devDependency 固定到该版本，运行完整套件，并在真实配置文件中把打包的插件放在已发布启动器旁启动。**Edge（前沿）** 在独立检出中构建 `deepseek-ai/deepseek-harness@master`，并只在一次性 runner 内链接它，方式与 `tools/link-harness.mjs` 为手动开发链接本地检出完全相同。它可以保持不阻塞，且从不在 pull request 上运行，但它的失败应当促使明确的兼容性决策，而不是意外的发布损坏。

三条车道都会额外运行 `tools/capability-report.mjs`，它把一个 seam 的真实 Harness 约定——真实的 `SessionQueryEngine`、真实的 `SubagentRuntime`、真实的抽象 `JobRegistry` 子类、真实的 `UserQuestionService`、在真实 `Session` 之上的真实抽象 `WorkflowEngine` 子类，绝不是 dshline 臆造的假对象——转化为按能力命名的通过/失败结果。目前的覆盖是初始的，而非穷尽的：`sessionQuery`、`jobs`、`subagents`、`sessionProjections`、`workflows`、`userQuestions`、`tokenMeter`（真实 `SessionStore` 之上的真实 `TokenMeter`）、`compaction`（真实的 `CompactionEngine` 子类）与 `skills`（真实的按作用域分层的 `SkillRegistry`，以及把打出的 `/name` 一行变成注入的真实 `dsh-tool-skill` pre-step 边界），之所以选择它们，是因为每一个都已经有（或能够低成本获得）一个针对真实类而非手工伪造对象构建的测试。上游对其中一个的变更读起来是 `sessionQuery contract changed`，而不只是笼统的 `pnpm typecheck failed`；尚未进入这张表的 seam，仍以 `pnpm typecheck`/`pnpm test` 作为后备。`tools/capability-probes.mjs` 是一张指针表，不是约定的第二份拷贝：它只指出哪个既有或新建的测试已经在验证每个 seam，因此扩大这一覆盖意味着往那张表里加一行（或在 `packages/dshline/tests/capability/` 下新增一个小探针），而绝不是让这个模块自己学会该 seam 的形状。

`userQuestions` 是这套雷达第一次证明它能发现真实的破坏：Harness 的 `ctx.userQuestions` 注册方式在可安装产品线与 Edge 之间发生了变化，`packages/dshline/src/questions.ts` 目前用一个小的运行时判断——而不是包版本检测——把两者桥接起来。这一桥接按设计是临时的——删除条件见其模块注释——因为 dshline 支持的是当前可安装的 Harness 产品线加上当前的 Edge，而不是无限期的历史兼容。

Released 还会把当前已发布的产品线与最新的官方 `dsh-v*` GitHub Release 相比较（不只是一个标签——而是 DeepSeek 真正发布的 Release，预发布版本也算），因为 DeepSeek 会在产品线到达 npm 之前先发布 Release，所以这是唯一能看到这一差距的方式。比较本身在每次触发时都会运行；把该 release 检出并构建则只保留给每日计划任务与手动分发，并且和 Edge 一样保持不阻塞——一个尚未发布的 release 同样还不是任何消费方能够安装的东西。当该 release 与 Edge 正在 `master` 上探测的提交相同时——这是常见情形，因为一个 release 通常就是从 master 的最新提交切出的——它会直接借用 Edge 的结论，而不是在同一次运行里把同一棵 Harness 源码树构建两遍。

一个按构造不执行任何依赖代码的同级任务，会在 Released 产品线移动时打开一个自动化同步拉取请求，根据范围接受的内容，把标题写作例行升级或必需的 peer 兼容性决策。Released 回答的问题是"当前可安装的 Harness 发布版本是否属于 dshline 声称支持的集合"，它会在这个问题的两个方面上都阻塞 pull request 或对 `main` 的 push：运行时兼容性（安装、构建、类型检查、完整套件、能力探针、消费方启动）与 peer 约定。即便每一项运行时检查都是绿色，一个 peer 范围尚未接受的新发布预发布元组也会使该任务失败，报告为 "compatible in practice; peer compatibility decision required"（实践中兼容；需要 peer 兼容性决策）——包元数据是兼容性承诺的一部分，因此期望人类去检查，并刻意选择扩宽范围或维持现状，而不是让已发布的元数据悄悄偏离真实状态。参见 `tools/sync-harness.mjs` 的模块注释。