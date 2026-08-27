# 使用

[English](usage.md) | 中文

## 开始一个会话

| | |
| --- | --- |
| `dshline` | 在当前文件夹启动 |
| `dshline -C ~/code/api` | 在另一个文件夹启动 |
| `dshline "run the tests"` | 启动时发送第一条消息 |
| `dshline --resume` | 浏览、搜索并重新打开过去的会话 |
| `dshline --resume <id>` | 重新打开你知道 id 的会话 |
| `dshline --help` | 本界面新增的所有命令行选项 |
| `dshline --setup` | 首次运行前创建 `dshline` 配置文件，只需一次 |

`dshline` 是 Harness 自带启动器的一层轻量封装：它找到 `dsh`、加上 `--profile dshline`，并把会话固定在你运行它的文件夹。其余一切透传，因此 `dshline <anything>` 与 `dsh --profile dshline <anything>` 行为一致。用你喜欢的那个即可。

`-C`（或 `--cwd`）设置*会话*工作的文件夹。它不改变命令本身从哪里运行。

用 `--resume` 重新打开会话会保留该会话创建时的文件夹，因为那个文件夹记录在会话文件中。因此恢复时 `-C` 被忽略，而不是把旧对话悄悄移到新文件夹。

`dshline` 已经打开你当前所在的文件夹，所以这个不需要别名。

如果你的 Harness 是源码检出而不是全局安装，请指定检出一次：

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

检出没有可指向的 `dsh` 可执行文件——它的启动器是一个脚本——因此这命名文件夹、让 `dshline` 从那里读取该脚本。见 [安装 → 故障排查](install.zh.md#dsh_bin-points-at--which-does-not-exist)。

没有全局 `dsh` 也没有那个变量时，`pnpm dsh` 仍然有效——但只在 Harness 文件夹内部，因为该脚本属于 Harness 仓库。见 [安装 → 故障排查](install.zh.md#command-dsh-not-found)。

## 按键

| | |
| --- | --- |
| `enter` | 发送 |
| `shift-enter`、`alt-enter` | 换行而不发送 |
| `tab` | 接受高亮的建议 |
| `ctrl-c` | 停止 agent；如果它没有运行则退出 |
| `ctrl-d` | 从任何地方退出——包括选择器、提问或审批提示 |
| `ctrl-l` | 清屏 |
| `ctrl-o` | 检视最近一条被截断的工具输出，任意细节级别；否则循环切换显示多少工具输出：compact、full、hidden |
| `↑` `↓` | 在你更早的消息之间移动；在跨行换行的长提示内，先在其内部上下移动，然后 `↑` 召回历史；建议列表打开时，改在列表内移动 |
| `enter` `esc` | 确认或关闭一个框或列表 |

编辑按键：`←` `→` 移动，`home` 与 `end`（或 `ctrl-a` 与 `ctrl-e`）到行的两端，`backspace` 与 `delete`，以及 `ctrl-u`、`ctrl-k`、`ctrl-w` 分别删除到行首、到行尾、按词删除。在跨行换行的提示中，`↑` 与 `↓` 也穿过折行上下移动，在短行之间保持你瞄准的列。

粘贴多行会全部插入，并作为一条消息发送。

### 输入历史

没有建议列表打开时，`↑` 一步步回到你本次会话发送过的行——提示与斜杠命令都一样——`↓` 再向前。打到一半的行会为你保留：往回看更早的消息，再向前越过最新一条，就会精确恢复你未完成的行。

连续相同的提交只记一次，因此连跑三次 `run tests` 不会让历史里堆三份副本。

重新打开会话会恢复保存的日志记录下的历史：每一条提示与每一条输入被记录的已解决斜杠命令。本界面自己处理的命令（`/model`、`/reasoning`、`/usage`、`/timing`、`/new`、`/sessions`、`/work`、`/todos`、`/exit`、`/quit`）与打错的命令在会话打开期间被记住，但不会写入会话日志，因此恢复后不会重现。

### 关于 shift-enter

默认情况下，终端为 `shift-enter` 发送的字节与 `enter` 完全相同，因此没有程序能区分它们。为让差异可见，本界面启动时会向你的终端请求一个额外的键盘特性：kitty 键盘协议的最低选项，名为*转义码消歧（disambiguate escape codes）*。支持它的终端（kitty、Ghostty、WezTerm、foot、较新的 iTerm2 与 Alacritty、Konsole）随后把修改过的 `enter` 报告为自己的序列。

那个请求有一个值得知道的副作用。在支持它的终端上，`esc`、`alt` 与 `ctrl` 组合也不再以旧形式到达：`ctrl-c` 变成序列 `CSI 99 ; 5 u`，而不是单字节 `0x03`。本项目两种形式都读，因此上表中每个快捷键两种方式都有效。细节见 [设计 → 键盘输入以两种格式读取](design.zh.md#keyboard-input-is-read-in-both-formats)。

在忽略该请求的终端上，`shift-enter` 仍然发送消息。这就是为什么状态行建议 `alt-enter` 代替：`alt-enter` 处处有效。界面退出时额外模式被关闭，因此下一个程序正常读取你的键盘。

如果某个按键没有反应，`node tools/keyprobe.mjs` 会显示你的终端发送了什么、本项目如何读取它。那个输出正是缺陷报告需要的。

## 命令

输入 `/` 看你的 agent 实际拥有的命令。它们来自两个地方。

**由本界面处理：**

| | |
| --- | --- |
| `/model` | 更改模型。接受一个名字（`/model deepseek-v4-pro`）或打开一个可输入的选择器 |
| `/reasoning` | 更改模型思考的强度。接受一个级别（`/reasoning max`）或打开选择器 |
| `/connect` | 配置并认证 Harness 可以对话的提供方。接受路由名（`/connect openai`）以按它过滤打开 |
| `/plugins` | 浏览、搜索并定制运行中 agent 的 Harness 预设组合 |
| `/profiles` | 浏览 Harness 配置文件及各自组合的 bundle；安装、更新或移除其中之一 |
| `/usage` | 选择状态行报告什么：`cost`、`tokens` 或 `off`。无参数时打开选择器 |
| `/timing` | `on` 或 `off` 控制常驻的实时轮次计时面板；裸命令翻转它 |
| `/theme` | 选择颜色配色。接受一个名字（`/theme ember`）或打开选择器 |
| `/work` | 打开活动 Harness 任务与 subagent 的有界实时视图 |
| `/new` | 在当前工作区开始一个全新会话；当前激活的 Harness 配置文件提供会话持久化时，上一个会话仍可重新打开 |
| `/sessions` | 不离开窗口浏览、搜索并重新打开过去的会话 |
| `/todos` | 打开当前 Harness Todo 列表的有界只读视图 |
| `/exit`、`/quit` | 退出，与 `ctrl-d` 相同 |

前三个每一个都一样工作：**给出值就更改，只打命令就询问。**你很少需要凭记忆做其中任何一个，因为命令名后一出现空格，建议列表就提供取值：

```
› /reasoning
    › /reasoning off      no thinking at all
      /reasoning high     the usual level
      /reasoning max      as hard as it goes
      /reasoning default  whatever the provider does when nothing is set
      tab complete · esc dismiss
```

在 `/rea` 上按 `tab` 会补全名字并把光标留在空格后，取值无需再按一键就出现在那里。当你想阅读描述时，选择器是后备，而不是唯一入口。

**来自 Harness**，因此列表取决于你的配置文件加载哪些插件。使用标准插件集时：

| | |
| --- | --- |
| `/compact` | 总结更早的对话历史以腾出上下文 |
| `/plan`、`/plan off` | 进入或离开计划模式 |
| `/goal` | 显示或设置长任务的目标 |
| `/permission` | 更改权限预设（见下文） |
| `/feedback` | 记录关于本次会话的备注 |

每条命令的结果都打印进会话记录：正常输出是一条 `·` 行，失败则是一条 `✗` 行。未匹配任何内容的命令名会被报告，而不是发送给模型：

```
✗ unknown command: /help · type / to see what there is
```

该检查使用 Harness 自己对命令行是什么的规则，因此名字必须要么结束该行、要么后跟一个空格。这意味着 `/etc/hosts is missing` 被当作普通消息原样到达模型，而 `/tmp is full` 被当作命令报告为未知。这个取舍是刻意的：打错的命令远比以文件夹名开头的消息常见。

> [!WARNING]
> **`/goal <objective>` 不只是记录一个目标。**它会启动 Harness 的目标驱动器，立即在最多 256 轮内、使用你文件夹中的工具，自行开始处理该目标。不带文本使用 `/goal` 只查看当前目标，`/goal pause` 或 `/goal clear` 停止一个。开始前没有任何警告——但一旦开始，状态行会在其运行的整个期间点名说明。
>
> **目标也可能在你不知情时启动。**Harness 给模型一个 `create_goal` 工具，并告诉它可以不要求你说出「goal」这个词、就从你要求的内容推断长期目标。状态行是你发现它的方式；`/goal` 完整显示它，`/goal pause` 停止它。见 [本会话接下来要做什么](#what-the-session-is-about-to-do)。

### Connect

`/model` 在已存在的模型中选择。`/connect` 是模型如何得以存在的途径。

它打开一个有界浮层，列出 Harness 说可以配置的内容，分两个分区：

```
╭─ dshline ────────────────────────────────────────────────────────────── Connect ─╮
│ ⌕                                                          9 rows               │
│                                                                                  │
│ Provider routes                                                                  │
│ ❯ ● OpenAI  openai                        active · 41 models · key from          │
│       llm-pi-ai · providers.openai · credential field apiKeyEnv                  │
│   · Anthropic  anthropic                                        dormant           │
│   ● DeepSeek  deepseek-official     active · DEEPSEEK_API_KEY unset              │
│                                                                                  │
│ Sign-ins                                                                         │
│   · ChatGPT (Codex)                                     not signed in             │
╰─ ↑↓ move · ctrl-r refresh · ↵ configure · esc close ──────────────────────────────╯
```

输入以过滤、`↵` 查看 Harness 允许你对选中行做什么、`esc` 清空查询、再按 `esc` 关闭。`/connect openai` 在该过滤上打开——命名路由表示你指哪一个，补全列表在空格后提供每个路由名，方式与 `/reasoning` 提供级别相同。它不会对其操作：对路由做什么仍然是在存密钥、激活与移除之间的选择。`ctrl-r` 再次询问 Harness，这是你在手动编辑 `settings.yaml` 或从另一个窗口的 Web 界面存入密钥之后想要的。

**Provider 路由**是每个已挂载适配器声明可配置的所有路由，无论它是否存活。裸挂载的 `llm-pi-ai` 以这种方式发布它整个已安装目录，因此 OpenAI、Anthropic、Google、OpenRouter 等在任何东西被配置前就被列出。`active` 表示适配器已注册该路由，`/model` 已经可以提供它的模型；`dormant` 表示还没有为它配置任何东西。

**登录（Sign-ins）**是 Harness 已注册的授权流程——那些*获取*凭据而不是从配置读取的登录。它们被单独列出、刻意不并入提供方行：Harness 不发布流程凭据记录与提供方路由之间的关联，因此本界面两者都显示，把连接留给你，而不是断言它无法验证的东西。

行前的点是刻意安静的。绿色表示已确认存在某个具名凭据，红色表示已确认缺失某个具名凭据，其余一切不加标记——通过提供方自身发现来认证的路由，或没有可询问的凭据存储的部署，并不算配置错误。

#### `↵` 提供什么

只有已挂载 seam 实际上会接受的，因此列表上没有会以拒绝应答的东西：

| | |
| --- | --- |
| 用 API 密钥连接 | 通过 Harness 的凭据存储保存密钥，并把引用记录到提供方的设置配置文件中 |
| 激活此路由 | 写入一个最小配置文件，让适配器注册该路由；目录路由继承其端点、协议与模型 |
| 遗忘已存储的 API 密钥 | 清除值；引用保留，因此路由继续命名它的密钥属于哪里 |
| 从你的设置中移除该路由 | 取消设置*你的*设置文档携带的配置文件，保留任何组合默认值 |
| 登录 | 通过 Harness 的授权 seam 运行所属插件自己的流程 |
| 遗忘此登录 | 删除本地凭据记录——见下方警告 |

打出的密钥永远不会进入 `settings.yaml`。它进入凭据存储，设置文档只记录*引用*——名为 `openai` 的路由是 `OPENAI_API_KEY`——这与 Web Models 页使用的约定相同，因此在这里存的密钥就是 Web 界面读到的那个。

路由一旦存活，`/model` 无需进一步步骤就能看到它的模型：Harness 在设置提交时重新注册路由，浏览器重新读取自身。

关闭浏览器会撤消它启动的登录，包括在屏幕上没有提问、等待浏览器回调的那个。被撤消尝试的任何东西之后都不会出现；会话记录说它被撤消，那就到此为止。

> [!WARNING]
> **「遗忘此登录」是本地的。**它删除本机上的已存储凭据记录。Harness 没有办法让提供方声明服务端撤销，因此签发方永远不会被告知，授权在到期或你向提供方撤销之前一直有效。

#### 它还没有做什么

声明适配器未附带任何内容的路由——私有网关、自托管服务器——仍然需要 `settings.yaml`，因为这样的路由必须先命名端点、协议与模型才能服务任何东西。见 [通过网关访问 DeepSeek](#reaching-deepseek-through-a-gateway)。编辑活动路由的模型列表、基础 URL 或超时也是设置工作；`/connect` v1 覆盖凭据与激活。

<a id="sessions"></a>

### Plugins

`/plugins` 在运行中 agent 的 Harness 预设上打开一个有界浮层——该 agent 实际加入的那个由工具、
提示词分节与委派后端构成的具名组合，而不是本界面自己保存的一份固定清单：

```
╭─ dshline ───────────────────────────────────────────────────────────── Plugins ─╮
│ Preset: Standard mode                              default: Standard mode       │
│                                                                                 │
│ ⌕ codex                                                            1 row        │
│                                                                                 │
│ ❯ ○   tool-subagent-codex               @deepseek-ai/dsh-tool-subagent          │
╰─ ↑↓ navigate · / search · space toggle · p presets · d default · esc close ─────╯
```

输入 `/` 可按行 id 或包名搜索一个庞大的组合；在选中行上按 `space` 打开或关闭它。
**内置预设绝不就地编辑。**Harness 把那些文件设为只读，因此在内置预设上切换某一行会先提议把它
复制为一个本地编写的预设——与官方 Web 界面自己的预设设置所用的"复制，然后编辑副本"是同一条
路径——并在同一步里把切换应用到新副本上。`p` 打开完整名册（该部署实际拥有的那些预设，而不是
固定的四个），用来切换到另一个预设或为新会话设定默认值；`d` 直接把当前显示的这个设为默认值。

**这里的预设切换遵循运行中会话已有的同一条规则。**会话的组合在它产生过一轮之后就是既成事实，
而不是本界面事后可以改写的设置：为一个已经开始的会话选择预设会被拒绝，并改为作为*下一个*会话
的默认值提供——绝不是静默的空操作，也绝不是绕过那道锁。你切换的某一行同样如此：文件无论如何
都会写入，但只有仍然空白*并且*正在运行该预设的会话才会实时接手这次变更。其他情况都被报告为
一次等待下一个会话的定制，因此变更绝不会看起来在一段它并未触及的对话上生效了。

重新打开一个会话时，它按自己日志所记录的预设组合，而不是按今天的默认值。dshline 采纳预设之前
的会话没有记录预设；那些会话按随附的 `standard` 恢复，这个预设的含义正是它们最初运行时的那套
工具集。如果你的部署未提供可用的 `standard`，这样的会话仍然会打开——用你自己的默认值——并且
transcript（文本记录）会说明它的工具可能与这段历史产生时所用的不同。

### Profiles

`/profiles` 打开 Harness 自己的配置文件名册——预设*之上*的那一层：

```
╭─ dshline ──────────────────────────────────────────────────────────── Profiles ─╮
│ Host: dshline                                                  3 profiles       │
│ /Users/you/.dsh/profiles                                                        │
│                                                                                 │
│ ⌕ / to search                                                     6 rows        │
│                                                                                 │
│ ❯ ● dshline                                                       current       │
│       Bundles                                                                   │
│   ✓   @deepseek-ai/dsh-base                       from the installation         │
│   ✓   @dshline/dshline                                             0.8.0        │
│   ○ web                                                                         │
╰─ ↑↓ navigate · a add · u update · U update all · n new · / search · esc close ──╯
```

**配置文件**是启动器启动的对象：`dsh --profile <name>` 读取 `$DSH_HOME/profiles/<name>`，
其 `package.json` 列出有序的 *bundle*，它们的补丁层组合成 Host。`●` 标记本会话正在运行的配置
文件。每个配置文件下面是它的 bundle 层，凡是 pnpm 的状态已经记录了安装版本的地方都一并给出；
`from the installation` 表示这是随 `dsh` 本身一同提供的内置 bundle，而不是该配置文件的依赖之一。

`a` 安装一个 bundle，`u` 更新选中的那个，`U` 更新每一个由依赖管理的 bundle，`r` 移除一个
（需要确认，因为它会让此后每个会话都少一项能力），`n` 创建一个配置文件。上述每一项都运行
Harness 自己的 `dsh plugin --profile <name> …`，那是一个薄薄的 pnpm 转发器，事后会协调 bundle
列表——本界面不添加任何自己的安装器、解析器或 lockfile 行为。`U` 明确点名各个 bundle，而不是
运行一个裸的 `pnpm update`，后者还会更新那些并非 bundle 层、这里也不显示的普通库。

启动器的查找方式与 `dshline` 自己相同的四种——`DSH_BIN`、`DSH_HARNESS` 源码检出、`PATH` 上的
`dsh`，然后是已安装的 `@deepseek-ai/dsh` 包——因此这些操作在本界面能工作的地方都能工作。四种
都找不到时，会指出确切命令，供你自己运行。如果失败输出重要，它的最后几行会被提交进 transcript
（文本记录），而不是随浮层一起丢失；可能在 URL 中携带 token 的 spec 会被从那份记录中略去，而
不是保留在里面。

**操作运行期间，边框会说明这一点。**一次 pnpm 安装要花上几分钟，因此运行中的操作在整个运行期间
显示为 `<profile>: <what>…` 旁边一个旋转的转子，而不是一条会过期的消息——并且它一结束该行就
消失，因为在已完成的工作上留一个转子说的是与事实相反的话。一旦对你正在运行的配置文件的变更落地，
`↻ restart required to pick up: <profile>` 会一直留在屏幕上，直到你关闭浏览器——而关闭它不会
停止任何东西：仍在运行的工作，以及仍然欠下的重启，都会在退出时写入 transcript（文本记录）。
其他按键全程可用；只有针对*同一个配置文件*的第二次操作会被拒绝，并且它会说出来，而不是什么都
不做。

**Bundle、层、依赖。**三个词对应三件不同的事，而它们的区别决定了一次安装到底做了什么：

| | |
| --- | --- |
| **依赖** | 配置文件 `package.json` 里的任何东西——已安装，仅此而已 |
| **bundle** | 一个其自身清单声明了 `dsh.bundle`、指向它导出的某个 `cordis.patch.yml` 的包。这是*包*的属性，由发布它的人决定 |
| **层** | 配置文件 `dsh.profile.bundles` 列表中的一项。启动器按顺序应用每个所列 bundle 的补丁，构建出 Host 组合 |

因此 bundle 是一个*拥有*可贡献补丁的包，而层是一个正在被*应用*的补丁。`dsh plugin` 让层列表与
已安装的内容保持同步：声明了 `dsh.bundle` 的依赖会被追加进去，不再声明它的依赖会被剔除。从不
声明的依赖被安装，并且什么也不组合——永远如此，而且这是对的。

这就是版本重要的原因。同一个包名可以在一个版本上是 bundle，在另一个版本上不是，因为那条声明是
在某个时点才加上的；旧副本是普通依赖，而更新它会让它成为一个层。

`/profiles` 把不是层的依赖列在 `Installed, composes nothing` 之下，每个旁边标注 `not a bundle`，
这样一个什么也没改变的包是可见的，而不是缺席的。标注了 `⚠ declares dsh.bundle` 的那个才是值得
处理的情况：已安装的副本*确实是*一个 bundle，而层列表还没跟上，任何一次 `dsh plugin` 运行都会
协调它——每当 pnpm 以非零状态退出时，那次协调就被跳过，这个状态正是这么来的。`r` 移除一个非层
依赖的方式，与它移除 bundle 的方式相同。

**添加一个 bundle 不是搜索。**这个输入框接受确切的包名（或 `pnpm add` 接受的任何 spec）并原样
转发，因此一个不完整或记错的名字会得到一次失败的安装，而不是一份候选列表。失败时，pnpm 给出的
原因就是标题——名字不存在时是 `ERR_PNPM_FETCH_404`，这台机器访问不到的仓库是
`ERR_PNPM_GIT_RESOLVE_FAILED` 以及 git 自己的 `fatal:` 那一行——同时输出的最后几行会被提交进
transcript（文本记录）。那些是 pnpm 的错误，也是 pnpm 的修法：比如一个在这里需要 SSH 的 git
依赖，要靠你机器上的 `git config url."git@github.com:".insteadOf`，而不是本界面能决定的事。

其中一种值得知道，因为它会阻塞一个配置文件上的*每一项*操作，直到你回答它，因此 `/profiles` 会
在你按下任何键之前就发出警告：这样的配置文件被标记为 `builds pending`，选中它会指出那些包，
以及回答它们的文件。`ERR_PNPM_IGNORED_BUILDS` 表示某个依赖想运行构建脚本，而 pnpm 不会在无人
值守的情况下运行它；pnpm 会为每一个在该配置文件的 `pnpm-workspace.yaml` 中写入一个占位：

```yaml
allowBuilds:
  '@google/genai': set this to true or false
  protobufjs: set this to true or false
```

把每一项设为 `true` 或 `false`，操作就会继续。`/profiles` 在看到这个错误时指出那个文件，但绝不
编辑它：允许一个构建脚本就是运行来自依赖的、安装期的任意代码，这是你的决定，不是一个终端浏览器
的决定。Harness 也不替你回答——它在创建配置文件时写下基础的 `pnpm-workspace.yaml`，此后再也
不碰它。请注意，`dsh plugin` 自己在这里可能*挂起*而不是失败，因为 pnpm 试图交互式地询问；
`/profiles` 不给它的子进程任何可供询问的终端，因此它改为报告这个错误。

**两件它刻意不做的事。**它不会移除或更新内置 bundle，因为 `dsh plugin` 也不会——那些来自安装
本身，把它们的行关掉属于配置文件自己的 `cordis.patch.yml`。它也不会切换配置文件。Host 在启动时
一次性组合它的插件，没有任何东西能重新链接一个运行中 Host 的 bundle 层，因此在另一个配置文件上
按 `enter` 会指出启动它的命令，而不是假装把它换进来。

**移除一个 bundle 不可能弄坏随附的配置文件。**只有这个配置文件*依赖的* bundle 才能被移除或更新
——随 `dsh` 本身一同提供的那些层会被拒绝，这也是 `web` 和 `headless` 里根本没有可移除内容的原因。
删除整个配置文件不提供：`dsh plugin` 转发 pnpm 参数，而 Harness 里没有任何东西会移除一个配置
文件，因此 `enter` 指出那个目录，把这件事留给你。

**重启边界是被明说的，而不是被暗示的。**安装、更新或移除一个 bundle，改变的是*下一个* Host
组合什么。在你正在运行的配置文件上，结果说 `restart required`；在任何其他配置文件上，它指出会
接手它的命令。这里没有任何东西声称改变了你所在的这个会话。

### Sessions

`/sessions` 打开一个有界浮层，列出 Harness 知道的会话，最新的在前。它与 `--resume` 在第一个 agent 存在前打开的浏览器相同，因此只有一个学习的地方、一套按键。

| | |
| --- | --- |
| type | 边输入边按标题、工作区或 id 过滤列表 |
| `tab` | 通过 Harness 自己的会话索引搜索会话*说过*的内容 |
| `↑` `↓` | 移动；列表两端都回绕 |
| `home` `end` | 跳到最新或最旧的行 |
| `↵` | 重新打开选中的会话 |
| `→` | 为选中行打开操作菜单：过滤、血统、本会话内查找、或重命名 |
| `ctrl-w` `ctrl-u` | 删除查询的最后一个词，或整个查询 |
| `esc` | 清空查询；查询为空时再按一次关闭 |
| `ctrl-d` | 退出，与别处一样 |

输入过滤你能看到的行。`tab` 是另一个问题：它把同样的词交给 `ctx.sessionQuery` 的全文接口，后者搜索每个会话日志的内容并显示匹配的摘录。编辑查询会掉回过滤，因为内容结果回答的是*编辑前*你打的词。会话查询后端未实现全文搜索的部署会说明这一点并继续过滤——那条路径受支持，而不是坏了。

选中行携带你需要的关于一个候选项的事实：它的工作区、日志有多少事件、上次活动时间、它的 fork 或委派父级，以及它的 id。右侧的短词说明一行为何不寻常——`open` 表示本窗口正在驱动的会话，`live` 表示已被另一个 agent 持有的会话，`delegated` 表示 subagent 自己的会话，`fork` 表示从另一个会话播种的会话。

重新打开使驱动当前会话的 agent 退役，并在同一个窗口与同一个终端中恢复你选的那个。你滚动缓冲区（scrollback）里已有的一切都留在那里：恢复的会话记录追加在它下面，与 `--resume` 在启动时绘制它的方式完全一致。

当重新打开意味着猜测时，它会拒绝，并说明适用的原因：

| | |
| --- | --- |
| 会话已在此打开 | 无事可做 |
| 会话在本进程中存活 | 恢复会与存活 id 冲突 |
| 没有持久化日志 | 重新打开经由 Harness 会话持久化加载 |
| 一轮正在进行 | 先结束或中断它（`ctrl-c`） |
| 有任务或 subagent 附着 | 使它们的所有者退役不是 Harness 定义的生命周期 |

操作菜单（`→`）在选中行上打开，伸进 `ctx.sessionQuery` 的更多能力：

| | |
| --- | --- |
| `Filters` | 在行有界之前收窄语料库：工作区（`all`/`current`）、来源（`all`/`own`/`delegated`）、年龄（`all`/`today`/`7 days`/`30 days`） |
| `Lineage` | 通过 `traceSession` 浏览选中会话已知的父级与子级；`↵` 把列表焦点还给该会话 |
| `Find in this session` | 通过 `searchEvents` 搜索*某一个*会话说过的内容，有自己的查询行（`tab` 执行搜索） |
| `Rename` | 通过 `ctx.sessionTitle` 重命名本窗口正在驱动的会话（`open` 行），仅在挂载了会话标题服务时提供 |

工作区与年龄变成精确的 Harness 子句（`cwd` 匹配、`created-at` 闭区间窗口），因此收窄发生在 Harness 内部。来源只在呈现层对 Harness 返回的权威头部应用，因为 Harness 不发布来源谓词；过滤生效时标题出现 `· filtered`，改变过滤会重新开始分页。

两个内容作用域（`tab` 语料库搜索与 `Find in this session`）都通过不透明的 Harness 游标分页。末尾的 `Load more…` 行追加下一页（`↵`）；当语料库在游标之下变动时出现 `Refresh (results changed)`，计数器说明有多少结果（`· more available` 或 `· end`）——绝不是一个页码，因为 Harness 不发布页码。

重命名会追加一个带显式 `user` 来源的 `session/title` 事件：它钉住会话的标题（自动生成停止），浏览器从日志重新读取它的标题观测。它从不重新打开会话——重命名只在已在本窗口打开的会话上提供，因为通用标题服务只操作活动会话对象，而重命名一个已关闭的持久会话需要先恢复它。

即使重新打开仍然失败——不可读的日志、不兼容的格式版本、没有持久化后端——窗口打印原因并重新打开浏览器，让你选别的。在那里按 `esc` 改为开始一个新会话。它从不结束进程，也从不悄悄替换你没要的会话。

### Work

`/work` 打开一个临时有界浮层。配置文件挂载了通用 Harness `ctx.jobs` 与 `ctx.subagents` 能力时，它读取它们；两者都没有的配置文件仍然启动，浮层说明 Work 不可用。它绝不切换屏幕或重写会话记录，因此关闭它回到同一个原生终端滚动缓冲区。

任务与 subagent 保持独立分区，因为 dshline 不猜测两条能力记录描述同一个操作。任务目前仅限检视/状态；取消仍通过 Harness `job_kill` 供模型使用。可续的 subagent 可能提供 `k stop`；一次性 subagent 没有。停止失败——包括授权失败——会短暂显示在浮层中，而不是被丢弃。

### Todos

`/todos` 打开当前 Todo 投影的临时只读视图。列表由 Harness 的 `dsh-tool-todo` 能力拥有、持久化并清空；终端只呈现它的当前快照。`✓` 是已完成，`●` 是进行中，`○` 是待定。关闭浮层让原生滚动缓冲区不变。没有会话投影或 Todo 投影的配置文件仍然可用，并说明哪种读数不可用。

### 主题

`/theme` 选择本窗口绘制所用的配色。指定名字即可切换，或不带参数运行以获得一个带说明的列表：

| | |
| --- | --- |
| `default` | dshline 一直发布的那套配色 |
| `high-contrast` | 完全避开 dim 与灰色的明亮十六色配色 |
| `ember` | 面向深色终端的暖色配色 |
| `tide` | 面向深色终端的冷色配色 |
| `paper` | 面向浅色终端，此时亮黑与 dim 不再是一回事 |

**主题只影响新的行。**完成的输出会被提交到你真实的终端滚动缓冲区并且永不重写，因此输入框上方的一切都保留它被打印时的颜色。正是这条规则让你能够正常滚动、选择与复制，主题无法豁免于它。应用一套配色会以一行用新配色绘制的确认作为回应；输入框、状态行以及其余仍在实时重绘的部分都会随之改变。

后三套以 24 位色编写。在无法显示它的终端上，每一套都回退到其作者选定的十六色形式，而不是某种近似，并且命令会说明你正在看的是哪一种回退，而不是让你困惑于它为何像你刚离开的那套配色。

`NO_COLOR` 完全禁用颜色，无论其取值为何，`TERM` 为 `dumb` 时同样如此。`FORCE_COLOR` 覆盖两者：`1` 表示十六色，`2` 表示 256 色，`3` 表示 24 位色。

你选择的主题保存在 Harness 自己的设置文档中，位于本前端注册的 `dshline` 命名空间下：

```yaml
# ~/.dsh/settings.yaml
dshline:
  theme: ember
```

分层由 Harness 负责，因此主题有两个来源，更具体的那个胜出：部署方在 `~/.dsh/cordis.patch.yml` 的 `dshline` 行中组合一个默认值，而你自己的 `settings.yaml` 覆盖它。`/theme` 只写入后者。

**它是实时生效的。**在会话运行期间手工编辑该小节会重绘窗口——你不需要重新打开任何东西。已提交的行保留它们被打印时的颜色，正如一切已提交的内容那样。

没有任何随包主题使用的名字会被设置模式拒绝而不是被存储，因此会话不会恢复到一套并不存在的配色上。没有挂载设置提供方的配置文件仍然以其组合出的配色运行；只是保存不可用，并且 `/theme` 会说明这一点。

主题就是以上五套。配色是针对一套内部的角色词汇编写的——一段文本**是什么**，而不是它应该是什么颜色——而该词汇尚未公开，因此无法添加你自己的配色。

### 工具输出

工具卡片显示工具产出的前几行，并带一个说明藏了多少的标记。**命令**是例外：它的卡片保留*最后*几行，把标记放在它们上方，因为你运行 `pnpm test` 想知道的失败与总结在底部，而不是顶部的横幅。

`ctrl-o` 打开被隐藏的行。在新近完成的工具卡片被截断时，它在那个卡片上打开一个检视器——相同的呈现、可滚动、预算远大于卡片本身——并在 `esc` 关闭，你的滚动缓冲区保持原样。这在 `compact` 或 `full` 下都有效。没有这样的卡片等待时，`ctrl-o` 改为循环切换每个*未来*卡片显示多少：`compact`、`full`、`hidden`。已打印的卡片绝不会重绘，这是保持正常终端选择与复制的代价。

在检视器内部，`←` 移到较旧的保留卡片，`→` 移到较新的卡片；`↑`/`↓` 滚动当前卡片，`home`/`end` 跳到其顶部或底部，`esc` 关闭。`ctrl-o` 在这里仍可用作移到较旧卡片的快捷键。标题会数出你所在的位置（`Tool output 2/6`），导航在两端停下，而不是绕回。最近十二张被截断的卡片就这样保持可达，因此你滚动越过的某个结果，不会被其后的工具调用夺走。每张卡片只提供一次：在最新的那张未看过的卡片之后，`ctrl-o` 回到细节循环，这正是让那个开关始终只差一次按键的原因。状态行在一轮进行中列出 `ctrl-o output`。

<a id="what-the-session-is-about-to-do"></a>

### 本会话接下来要做什么

有两样东西改变一轮会话*做*什么，而不是*说*什么，两者在会话记录中都不可见——设置它们的命令打印一行然后滚走，之后的一切看起来像普通会话。因此状态行携带它们：

| | |
| --- | --- |
| `plan` | 计划模式生效。agent 会提议而不是行动 |
| `goal armed · ship the release` | 已设置目标并将自行继续。尚未取任何一轮 |
| `goal 3/256 · ship the release` | 已取三轮，上限 256 |
| `goal idle · ship the release` | 已设置目标，但本次会话不会继续它。`/goal resume` 武装它 |
| `goal paused`、`goal blocked`、`goal complete` | 一个未在运行的目标，以及原因 |

目标会出现在那里，因为**目标不总是你设置的。**Harness 把 `create_goal` 发布为模型自己可以调用的工具，其自身描述说模型可以在没有被要求创建任何东西的情况下推断请求是长期的。因此会话可以获得自行继续的权威，而状态行就是它变得可见的地方。`/goal` 显示完整目标；`/goal pause` 停止它。

`256` 是部署对自动续跑轮数的上限，而不是目标——这就是为什么计数只在实际取了一轮之后才出现。`goal 0/256` 读起来像卡在零上的仪表；`goal armed` 真实地说出同一件事。

`idle` 是每个**重新打开**的会话对活动目标显示的内容。进程是否可以继续一个目标刻意不与目标一起保存，因此恢复对话不会重新启动你留下的运行——目标还在那里，而再次捡起它是你要求的事。

两种模式都不会在终端变窄时被放弃。它们只在模型名、总计、条形与上下文读数都消失之后才被丢弃，而运行中的目标是最后离开的——在按键提示之后。模式整块丢弃而非缩短：`goal 12/25` 不是比 `goal 12/256` 更小的真相，它是不同的一个。目标文本是唯一的例外，而且只因为它是散文：缩短的目标仍然是目标，因此它在关于目标的任何其他内容之前自行被放弃。

### 推理级别

`/reasoning` 列出你当前提供方实际接受的级别，而不是固定集合——DeepSeek 适配器是 `off`、`high`、`max`，而配置为关闭思考的部署只提供 `off`。还有一个 `default` 选择，它不是级别：它清除你的选择，让提供方在未设置任何东西时做它做的事。

变更从下一步生效，因此在一轮进行中按下不会把请求劈成两种设置，而且它会被记住——见下文。

状态行在模型名旁边命名级别，但只在它不同于你的设置默认值时——否则它每帧花几列在一个你没选择的事实上。

### 从长列表中选择

网关路由宣传网关服务的任何东西。OpenRouter 与 opencode 提供数百个模型，因此 `/model` 打开一个没有终端能一次显示的列表——而且你不该滚动浏览它。

选择器开窗到终端，一旦有多于一屏要选就长出一个查询框：

```
╭─ dshline ─────────────────────────────────────────────────────────────────────────────── Model ─╮
│ Select a model                                                                                  │
│ ⌕ sonnet                                                    6 of 412                            │
│ current: deepseek-official/deepseek-v4-flash                                                    │
│                                                                                                 │
│ ❯ openrouter/anthropic/claude-sonnet-4                                                          │
│   openrouter/anthropic/claude-sonnet-4-thinking                                                 │
│   opencode/claude-sonnet-4                                                                      │
╰─ ↑↓ move · type to filter · enter confirm · esc clear ──────────────────────────────────────────╯
```

每一行都按 `/model` 接受它的方式拼写——`provider/model`——因此你过滤的东西就是可以在命令后输入的，提供方自己的显示名位于选择下方，在不作为你必须匹配的文本的情况下消歧两个相似模型。`esc` 清空查询，再按 `esc` 关闭选择器，`home`/`end` 跳到任一端。

短列表不变：审批或 `/reasoning` 无可过滤，因此它不花一行放搜索框，打出的字符在那里也保持无意义。

### 你在这里选的，就是 Web 界面打开时用的

`/model` 与 `/reasoning` 都把选择写入 `~/.dsh/settings.yaml`，位于 Web Models 页读写的那同一个 `agent-default-model` 节。因此它们是同一个设置的两种视图：在终端切换模型，Web 界面就打开在它上；在那里切换，你的下一次终端会话就启动在它上。

这值得你在用 `/model` 为一个问题尝试什么之前知道，因为它不是会话作用域的试验——下一次会话从你留下它的地方开始。会话记录在发生时这样说：

```
· model set to deepseek-official / deepseek-v4-pro · also the default for new sessions
```

两者按那个顺序独立：运行中的会话先切换、绝不回滚，因此如果设置文件写不进去会告诉你，而即将运行的那一轮仍使用你要的模型。

整个选择一起存储——路由与推理级别——因为那一节只放一个选择。只保存级别而丢下模型，会让级别适用于下一次会话恰好打开的模型。

### 一轮进行中

```
◜ working 14m 26s · run_shell_command +2 calls · x-preview-f-free · ↑2.3M ↓21k · ▌░░░░░░░ 68k/1.0M · goal armed · todo 5/11 · ctrl-c interrupt
```

在已用时间旁边是这一轮等待的工具。长轮旁边没有名字时，无论命令在运行还是会话已停止响应，读起来都一样，因此名字是等待与担心之间的区别。它是终端变窄时第一个被放弃的东西。

`+2 calls` 表示还有两个工具在并行运行——Harness 调度可以安全并行运行的调用，因此几个可以同时未完成。名字是其中最新启动的一个。

时间是**这一轮**的，不是那个工具的。这里没有任何内容声称某个调用跑了多久，因为 Harness 不发布它。

在一轮运行期间提交的文本会被导向（steer）代理，并在它的下一个步骤边界被取用——长轮中这可能要等上一会儿，而在此之前没有任何东西确认它。所以状态行替你说出来：`1 queued` 统计你已发送、但代理尚未取用的提示数量，一旦取用该计数即消失。

### Token 与成本

状态行携带会话的运行总计：

```
● ready · deepseek-v4-flash · ↑8.8k ↓1.6k $0.018 · ▏░░░░░░░ 14k/1.0M
```

`↑` 是发送的每一个提示 token，无论是否缓存；`↓` 是生成的每一个 token，含思考。两者都来自提供方自己的核算，因此是你被计费的量而不是估算，重新打开会话会带回它的总计。

`/usage` 选择显示其中多少——`cost`（成本）、`tokens`（只要计数不要金额），或 `off`。

`$` 的含义取决于路由。在按量付费路由上它估算你花了多少；在 OpenCode Go 上——你按订阅付费——它是按订阅额度计数的、以美元计量的用量，而不是单独一张账单。

<a id="which-rates-it-uses"></a>

#### 它使用哪些费率

本界面针对其构建的路由——DeepSeek 自家的与 OpenCode 的（Zen 与 Go）——开箱即按已发布费率定价，每条消息按**它运行时**适用的费率计费，而不是按现在有效的费率。这很重要，因为标准价大约是折扣价的两倍：

| | | cache hit | cache miss | output |
| --- | --- | --- | --- | --- |
| `deepseek-v4-flash` | off-peak | $0.007 | $0.22 | $0.66 |
| | peak | $0.014 | $0.44 | $1.32 |
| `deepseek-v4-pro` | off-peak | $0.022 | $0.66 | $1.98 |
| | peak | $0.044 | $1.32 | $3.96 |

每百万 token 美元。高峰是 01:00–04:00 与 06:00–10:00 UTC；其余每小时都是非高峰，也就是一天的大部分时间。

三条路由按这种方式定价：`deepseek-official` 加上 `opencode` 与 `opencode-go`——分别对应 OpenCode Zen 与 OpenCode Go，即已安装目录携带的两条 OpenCode 路由——也就是本界面构建来运行所针对的路由。OpenCode 数字镜像 DeepSeek 自己的列表，包括高峰时间表，这是 OpenCode 对这些模型应用的核算。把它们当作你可以修正的起点；计费不同的路由是一条配置项。

费率会变，而本文件不会。价格与高峰窗口都可以在 `~/.dsh/cordis.patch.yml` 中覆盖，你写的条目**替换**该路由随附的条目而不是合并进它——修正一个价格不应让其余停留在发布构建时的值：

```yaml
- id: dshline
  config:
    pricing:
      # Keyed provider/model. The bare fields apply off-peak; `peak` is the
      # exception, because it is the narrower window.
      deepseek-official/deepseek-v4-flash:
        input: 0.22          # cache miss
        cachedInput: 0.007   # cache hit
        output: 0.66
        peak:
          input: 0.44
          cachedInput: 0.014
          output: 1.32
      # A model id on its own covers whatever route serves it, which is how you
      # price one model the same way everywhere.
      deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
    peakHoursUtc:
      - { from: '01:00', to: '04:00' }
      - { from: '06:00', to: '10:00' }
```

**除非你要求，否则没有任何东西仅按模型 id 定价。**同一个模型经网关由网关按其自身条款计费，因此随附费率钉在 `deepseek-official` 路由上。没有条目的路由上的模型被计数但不定价——你得到 token 而没有 `$`，这是诚实的读数——而缺失部分会话的总计被标记 `~`，以免被误认为完整账单。

<a id="reaching-deepseek-through-a-gateway"></a>

### 通过网关访问 DeepSeek

这里的重点是模型，而不是通往它们的路由，而通过 OpenAI 兼容网关到达它们是配置而不是代码变更——Harness 的 `llm-pi-ai` 适配器接受手动声明的路由。本界面无需为它添加任何东西：`/model` 列出路由宣传的任何内容，`/reasoning` 提供它声明的任何级别，用量计数器随之而行。

对于 [opencode](https://opencode.ai) 的 Go 端点，把你的密钥放入环境变量 `OPENCODE_API_KEY`，并把路由加入 `~/.dsh/settings.yaml`：

```yaml
llm-pi-ai:
  providers:
    opencode:
      displayName: opencode
      apiKeyEnv: OPENCODE_API_KEY
      api: openai-completions
      # The chat-completions path is appended by the protocol, so the route
      # stops at /v1.
      baseURL: https://opencode.ai/zen/go/v1
      # The endpoint speaks DeepSeek's thinking dialect but its URL does not say
      # so, so the format has to be named or /reasoning has nothing to send.
      compat:
        thinkingFormat: deepseek
      models:
        # Keys are the levels offered, values their wire spelling; `off` is the
        # one that may be left empty, meaning "supported, send nothing".
        - id: deepseek-v4-flash
          name: DeepSeek V4 Flash
          contextWindow: 1000000
          reasoningEfforts:
            off:
            high: high
            max: max
        - id: deepseek-v4-pro
          name: DeepSeek V4 Pro
          contextWindow: 1000000
          reasoningEfforts:
            off:
            high: high
            max: max
```

两个细节值得知道。`apiKeyEnv` 是一个*引用*，每次请求解析，因此密钥本身绝不进入文件。而它进入 `settings.yaml` 而不是 `cordis.patch.yml`——设置文档是适配器监听的层，因此路由随你保存出现与消失，无需重启。价格是反过来的：它们从 `cordis.patch.yml` 中的 `dshline` 行读取。本前端确实注册了一个设置节——`dshline`，用于保存主题——但价格属于组合期的部署事实，而不是会话内需要修改的东西，因此它们留在本行其余配置所在的地方。

两个模型与直接路由服务的 id 相同，这使两条路由都挂载后 `/model deepseek-v4-pro` 有歧义——裸 id 解析到先被发现的路由。当你指某一个时，说 `/model opencode/deepseek-v4-pro`——或 `opencode-go/deepseek-v4-pro`，如果那是网关注册的 id——选择器反正会给每行标上它的提供方。

成本在 OpenCode 路由上开箱按 DeepSeek 费率报告（见[上文](#which-rates-it-uses)）。如果某条路由计费不同，一条条目修正它，它替换随附数字而不是合并：

```yaml
- id: dshline
  config:
    pricing:
      opencode/deepseek-v4-pro:
        input: 0.66
        cachedInput: 0.022
        output: 1.98
```

任何*其他*网关在你另行指定前都不定价：只有本界面命名的路由带费率，因为经转售商到达的模型由转售商计费，而悄悄继承别人的价目表是值得排除的唯一失败。

### 一轮的时间去了哪里

`/timing` 在状态行上方打开一个常驻的实时分解：

```
  timing · turn 14 · 42.8s · live
  reasoning  ━━━━━━━━━━━━━━ 18.2s
  bash       ━━━━━━━━━━━━━─ 16.4s
  edit       ━━────────────  3.1s
  output     ━━────────────  2.1s
```

agent 工作时它留在那里，空闲时也留在那里。轮次时钟与进行中的工具调用实时推进；reasoning 与 output 随它们流式事件的到达而增长。一轮结束时，同一个面板保持它的最终测量——不会向滚动缓冲区（scrollback）添加任何东西——直到下一轮取代它。在你看着的时候出现的跨度，会在接下来的几次工作心跳里把它的条形缓入；它旁边的时长从第一帧起就是真实的测量值。工具密集的轮次被限制在一个小的固定高度，并以一行省略行结尾，该行计数被隐藏的内容并点名其中最长的调用（`… +3 more · max 6.2s`——是最长的，不是总和，因为这些跨度彼此重叠）；在窄终端上这个数字会被整个放弃，而不是被切成一个残缺的时长，这发生在"挤占 composer"规则整行拿走之前。

在短到装不下全部内容的终端上，面板比输入行先降级：先是它的跨度行，然后是它的标题，只有在只剩寥寥几行的终端上它才完全消失——绝不会为了让图表可见而把输入行挤出屏幕。composer 遵循同一条规则，先舍弃它边框上方的那一行空行，然后才动用面板已获承诺的行。

条形按**最长**行缩放，而不是按这一轮。它们是跨度，不是份额：一个步骤内的工具调用彼此同时运行，因此它们的长度加起来可以超过这一轮，而差异不是空闲时间。标题里的挂钟时间是这一轮；条形只把行与行互相比较。

它默认关闭，关闭期间它完全不贡献任何活动行。裸 `/timing` 翻转它——只有两个状态，列一份两项的清单反而是多余的一步——而 `/timing on` 或 `/timing off` 直接设置。在一轮进行中启用它，会显示已经在进行的测量。重新打开一个已保存的会话时以 `no turn measured yet` 开始：历史重放刻意省略了做出诚实分解所需的流式分块，因此面板不会用不完整的数据编造一个。

它以前叫 `/profile`，那是一个迟早要发生的命名冲突：Harness 的 **profile（配置文件）**是启动器启动的那个组合，而 `/profiles` 浏览的正是它们。这条命令是一只秒表，现在它这么说了。

<a id="permissions-and-the-sandbox"></a>

## 权限与沙箱

在把会话指向你在意的代码之前，请阅读本节。

在标准设置中，**agent 的普通工具调用在运行前不会显示给你审批。**它可以在你的工作文件夹内创建、编辑、删除文件，并在那里运行 shell 命令。

这是 Harness 标准插件集的属性，不是本界面做的决定。审批提示在这里实现，而且它确实会出现——但只在有东西明确要求审批时，标准插件集中只有一种情况：模型要求在沙箱外工作时。文件夹内的普通调用只是被允许。文件夹外的操作被直接拒绝，而不是变成一个提问。

如果你希望普通工具调用先询问，添加一个做那个决定的插件——`@deepseek-ai/dsh-hooks-claude-code`，或你自己的 `tools/pre-execute` 策略。哪些调用需要审批是关于你如何部署 Harness 的决定，因此本界面不替你决定。

`/permission` 显示并更改预设：

```
· current preset workspace-write (available: read-only, workspace-write, danger-full-access)
```

- `read-only` — agent 可以读取与搜索，但不能改动任何东西。你只问问题时用它。
- `workspace-write` — 默认。agent 可以更改你打开的文件夹内的文件。
- `danger-full-access` — 没有沙箱。这个名字名副其实。

## 会话

当前激活的配置文件提供 Harness 会话持久化时，对话可以在退出 dshline 后保留，并重新打开：

```sh
dsh --profile dshline --resume          # browse, search, and choose one
dsh --profile dshline --resume <id>     # reopen a session directly
```

重新打开的会话看起来与你看着发生的那场完全一样——推理、diff、工具输出等等——因为它已持久化的日志通过绘制实时会话的同一段代码重绘。没有会话持久化的配置文件仍然支持开始新的对话，只是对话结束后无法再次提供。

你不必在启动时决定。`/sessions` 从运行中的窗口内部打开同一个浏览器，并在原位重新打开会话；见 [命令 → Sessions](#sessions)。一次驱动一个会话，每个的会话记录都留在你自己终端的滚动缓冲区中。

## 如果它拒绝启动

本界面在输入与输出上都需要真实终端。如果它的输入或输出被重定向到文件或另一个程序，它会报错退出，而不是空屏永远等待：

```
dshline: needs a terminal on stdin and stdout; for a piped or scripted run use --profile headless
```

一些封装脚本也会导致这种情况，因为它们不把终端透传给它们启动的程序。这种情况下请直接运行 Harness 命令，或为脚本使用 `--profile headless`。
