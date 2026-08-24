# 安装

[English](install.md) | 中文

> **如果你是一个 AI agent：**本页就是完整流程。请按顺序执行，然后用最后一节确认它是否成功。
> ```
> curl -s https://raw.githubusercontent.com/riesbri/dshline/main/docs/install.md
> ```

## 环境要求

- **Node.js** `^22.19 || >=24`。
- **可用的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 安装**，且已配置模型。如果 `dsh web` 能启动并回答提示，你就准备好了。
- **真实终端。**本界面在输入和输出两端都需要终端。如果任一端被重定向，它会报错退出，而不是空屏等待。脚本化运行请改用 `--profile headless`。

## 快速上手

```sh
npm install -g @deepseek-ai/dsh @dshline/dshline   # the harness, and this interface
dshline --setup                                    # once, to create the profile
dshline                                             # from any folder, on any machine
```

本页其余部分解释每个步骤，以及某一步不适用于你时该怎么办。

## 1. 确保你有一个 `dsh` 命令

本插件由 harness 自己的命令行程序启动，所以你需要一种运行它的方式。两种选择都可以。

全局安装 harness：

```sh
npm install -g @deepseek-ai/dsh
```

或者，如果你在 harness 源码检出中工作，可以使用它的工作区脚本——`pnpm dsh` 与 `dsh` 行为一致：

```sh
cd ~/path/to/deepseek-harness
pnpm dsh --version
```

本页其余部分写作 `dsh`。如果你用第二种方式，请改写作 `pnpm dsh`，并在 harness 文件夹内运行它。

## 2. 把插件安装进一个配置文件

```sh
dsh plugin --profile dshline add @dshline/dshline
dsh --profile dshline
```

**配置文件（profile）**是一组有名字的插件，存储在 `$DSH_HOME/profiles/<name>`（默认 `~/.dsh`）。第一条命令会在不存在时创建 `dshline` 配置文件、把本插件安装进去，并把它加入配置文件的插件列表。你的配置文件现在是 harness 的标准插件集再加上本界面。

### 从源码检出安装

要运行尚未发布的变更：

```sh
git clone https://github.com/riesbri/dshline && cd dshline
pnpm install && pnpm build
dsh plugin --profile dshline add ./packages/dshline
```

相对路径按命令运行所在的文件夹解析。使用 `pnpm dsh` 时，该文件夹是 harness 检出，而不是本仓库，所以请给出绝对路径：

```sh
pnpm dsh plugin --profile dshline add ~/path/to/dshline/packages/dshline
pnpm dsh --profile dshline
```

不支持直接从 Git URL 安装。`dsh plugin add github:riesbri/dshline` 会安装仓库根目录，而它是包含两个包的工作区，并不是插件本身。请使用 npm 包名，或指向 `packages/dshline` 的路径。

## 3. 获得一个单词的命令

全局安装本包会在你的 PATH 上放置一个 `dshline` 命令：

```sh
npm install -g @dshline/dshline
dshline --setup     # the same as: dsh plugin --profile dshline add @dshline/dshline
dshline             # the same as: dsh --profile dshline --cwd "$PWD"
```

它是 harness 启动器的一个小型包装，仅此而已：它找到 `dsh`、除非你指定了其他配置文件否则加上 `--profile dshline`、将会话固定在你运行它的文件夹，然后透传其余一切。因此 `dshline --resume`、`dshline "run the tests"` 与 `dshline --help` 都会到达真正的启动器。

它需要找到两样东西：

- **启动器**，按你已经做决定的顺序在四个位置查找：`$DSH_BIN`，然后是 `$DSH_HARNESS`，然后是 PATH 上的 `dsh`，然后是与它自己相邻的 `@deepseek-ai/dsh` 包——这就是为什么一条命令同时全局安装两者就足够了。

  对于**源码检出**，把 `DSH_HARNESS` 设为检出本身：

  ```sh
  export DSH_HARNESS=~/path/to/deepseek-harness
  ```

  检出没有可供 `DSH_BIN` 指向的 `dsh` 可执行文件：它的启动器是一个通过加载器运行的 TypeScript 入口，写在检出自身的 `package.json` 中，作为 `dsh` 脚本。`dshline` 会读取该脚本并从检出中运行它，因此即使 harness 移动了自己的文件，它也能继续工作。`DSH_BIN` 用于真正的可执行文件——全局安装，或把 harness 作为依赖安装所产生的 `node_modules/.bin/dsh`。

- **配置文件。**`dshline --setup` 会创建它。在此之前运行 `dshline`，它会明确告诉你，而不是晦涩地失败。要从检出而不是 registry 安装，请把路径交给 `--setup`：`dshline --setup ./packages/dshline`。

`dshline` 只占用这一个命令名。npm 上不带作用域的 `dshline` 包是另一个不同的界面，因此本包刻意不安装会遮蔽它的 `dshline` 命令。

## 4. 确认成功

```sh
dshline --dump-config      # look for a "# == dshline" section
dshline --help             # the flags this interface adds
dshline                    # a banner, an input line, and a "ready" status line
```

在会话内输入 `/` 列出你的配置文件提供的命令，然后按 `ctrl-d` 退出。

如果某个键盘快捷键没有反应，请在本仓库检出的目录下运行 `node tools/keyprobe.mjs`。它会显示你的终端发送了什么、本项目如何解读它，这正是缺陷报告需要的内容。

## 故障排查

<a id="command-dsh-not-found"></a>

### `Command "dsh" not found`

```
$ pnpm dsh --profile dshline
[ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL] Command "dsh" not found
```

`pnpm dsh` 是 **harness** 仓库的脚本，因此只有当你从 harness 检出内部运行时它才存在。在别处运行它——包括本仓库的克隆——pnpm 会报告没有该命令。有三种修复方式：

```sh
# 1. Install both globally and use the one-word command from anywhere.
npm install -g @deepseek-ai/dsh @dshline/dshline
dshline --setup
dshline

# 2. Keep your source checkout, and name it.
export DSH_HARNESS=~/path/to/deepseek-harness
dshline

# 3. Run it from the harness folder, pointing the session elsewhere with -C.
cd ~/path/to/deepseek-harness
pnpm dsh --profile dshline -C ~/code/my-project
```

<a id="dsh_bin-points-at--which-does-not-exist"></a>

### `$DSH_BIN points at … which does not exist`

```
$ export DSH_BIN=~/path/to/deepseek-harness/node_modules/.bin/dsh
$ dshline
dshline: $DSH_BIN points at …/node_modules/.bin/dsh, which does not exist.
```

harness **源码检出不包含该文件**，也没有任何东西会构建它：那里的启动器是检出 `package.json` 中的一个脚本，这就是为什么 `pnpm dsh` 在检出内部有效、而指向二进制的路径无效。请指定检出本身：

```sh
export DSH_HARNESS=~/path/to/deepseek-harness
```

`DSH_BIN` 只用于真正的可执行文件，比如 `npm install -g @deepseek-ai/dsh` 放到你 PATH 上的那个。

### 立即退出并提示需要终端

这是前端在缺少真实终端时拒绝启动，发生在它的输入或输出被重定向时。请直接运行启动器，而不是通过不透传终端的包装脚本；脚本化运行请使用 `--profile headless`。

### 键盘快捷键没有反应

在本仓库检出的目录下运行 `node tools/keyprobe.mjs` 并按下该按键。它会打印你的终端发送的字节以及本项目解码出的按键；结果为空是一个值得报告的缺陷。

## 卸载

这会同时移除包和配置文件对它的引用：

```sh
dsh plugin --profile dshline remove @dshline/dshline
```

你的配置文件、它的设置以及 harness 保存的会话都会保留。如果要连配置文件一起删除，删除 `$DSH_HOME/profiles/dshline`。

## 如果你安装的是正在编辑的检出

插件是被链接的，该链接解析到编译后的 `lib/` 目录——而不是 `src/`。因此每次修改源码后：

```sh
pnpm build     # in the dshline checkout
```

然后重新启动界面。如果跳过这一步，你测试的是之前的版本。请参阅 [`AGENTS.md`](../AGENTS.md#one-trap-build-before-you-test-by-hand)。