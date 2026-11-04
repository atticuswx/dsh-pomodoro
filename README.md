# 番茄时钟 · Pomodoro Timer

一个装在 DSH Web 界面里的番茄工作法倒计时。主界面是**常驻悬浮窗**：不依赖会话，
在设置页、空会话、任何面板上都一直可见。

> **English** — A Pomodoro timer for the DeepSeek Harness Web GUI. A draggable
> floating window stays visible without an open session, with an optional pill
> under the composer. One shared focus/break countdown with cycle dots, skip and
> reset, a chime plus a notification when a phase ends, and phase lengths you can
> change in the ⚙ panel. Everything is browser-local (`localStorage`), no server,
> no network calls.
>
> ```bash
> dsh plugin --profile web add github:atticuswx/dsh-pomodoro
> ```
>
> Reload the page and the pill appears in the bottom-right corner. Requires a DSH
> build with the Web client bundle support. MIT licensed.

## 长什么样

收起时是右下角一颗小胶囊，显示剩余时间：

```
╭─────────╮
│ ◔ 24:12 │
╰─────────╯
```

胶囊本身就能：**单击展开**、**双击开始/暂停**、**直接拖动移动**。

点一下展开为可拖动的悬浮卡片（⌄ 收回胶囊）：

```
┌──────────────────────────┐
│ ⠿ 番茄时钟             ⌄ │   ← 按住标题栏拖动，⌄ 收起
│          ◔ 24:12         │   ← 进度环，专注红 / 休息绿；双击这里也可开始/暂停
│        专注  ● ● ○ ○     │
│ [ 开始 ]  ⏭  ↺  ⚙        │
└──────────────────────────┘
```

- **进度环 + 时间**：环随进度收拢；专注是番茄红，休息是绿色。
- **阶段**：专注 / 短休息 / 长休息；旁边圆点是本轮已完成的专注数（默认 4 轮后长休息）。
- **开始 / 暂停**：主按钮。
- **⏭ 跳过**：立即进入下一阶段（正在跑就继续跑，暂停中就停着）。
- **↺ 重置**：把当前阶段退回起点。
- **⚙ 设置**：展开偏好面板——专注/短休息/长休息分钟数、长休息前轮数、
  「自动开始下一阶段」「阶段结束时提示音」「结束提醒动效」「同时显示文字提示卡」
  「显示悬浮窗」「输入框下方也显示一条」，以及「试播动效」「重置本阶段」「恢复默认」。

位置、展开/收起状态都会记住（`localStorage` 的 `dsh:pomodoro:window:v1`），
并且每次尺寸变化都会把窗口夹回视口内，拖出屏幕也不会丢。

**贴边吸附**：拖着窗口靠近窗口边缘（左右上下 40px 内）松手，会自动吸到边上并留 12px 边距；
放在中间则停在原地。吸附与收起/展开切换都带一点过渡动画（`prefers-reduced-motion` 下关闭）。

**输入框下方那条计时条默认关闭**：悬浮窗已经常驻，没必要重复两处。
想要两处都有（或只留计时条），在 ⚙ 里切换；两个开关至少保留一个，不会把计时器藏没。

阶段自然结束时：播放两声轻提示音（升调进入休息、降调回到专注），并在首次点击开始后
申请一次浏览器通知权限，之后每次切换都会发一条通知。

## 结束提醒：动效

工作环境静音时声音用不上，所以阶段结束默认还会播放一套画面动效。可在 ⚙ 里选「关 / 涟漪 / 边缘光 / 组合」，
默认组合，并可叠加文字提示卡：

- **边缘光**：整个界面四周泛起两层很淡的同色光（专注红 `#f25a5a` / 休息绿 `#22c55e`），顶部有一条细线扫过；
- **涟漪**：胶囊（或展开的卡片）里荡开三圈同色波纹，时间翻到下一阶段；
- **提示卡**：胶囊上方浮出一条「专注结束 / 短休息 5:00」，4 秒后淡出。

动效只在阶段**自然结束**时播放（跳过、重置不播），约 1.6–2.2 秒，不抢焦点、不改变窗口位置；
系统开启「减少动态效果」时退化为静态提示卡；标签页在后台时，动效会等你切回前台再补播一次；
设置面板里的「试播动效」可以立刻看一遍，不用等计时结束。

设计预览：[`preview/phase-end-effects.html`](preview/phase-end-effects.html)（四个方案可逐个重播）。

## 状态放在哪

倒计时只依赖一个 `endsAt` 时间戳，所以：

- 刷新页面、关掉标签页再回来，都会接着同一阶段继续；
- 后台标签页被节流也不会算错时间，回到前台立刻校准；
- 如果离开期间刚好有一阶段结束，回来时只结算这一阶段，停在新阶段的起点，不会连环跳。

设置与计时状态存在 `localStorage` 的 `dsh:pomodoro:v1` 键里，不同标签页各自独立计时。

## 安装

从 GitHub 安装（推荐）：

```bash
dsh plugin --profile web add github:atticuswx/dsh-pomodoro
```

装完刷新页面，右下角就会出现那颗胶囊。想锁定版本，可以在地址后面加 tag：

```bash
dsh plugin --profile web add github:atticuswx/dsh-pomodoro#v0.3.1
```

也可以从本地目录安装（改代码即时生效，适合自己改着玩）：

```bash
git clone https://github.com/atticuswx/dsh-pomodoro.git ~/dsh-plugins/dsh-pomodoro
dsh plugin --profile web add ~/dsh-plugins/dsh-pomodoro
```

或者在 DSH 里用 Plugin Manager 指向目录的绝对路径：

```text
plugin_manager { action: "install_bundle", target: "/Users/<你>/dsh-plugins/dsh-pomodoro" }
```

包内没有构建步骤：`client.js` 就是浏览器直接加载的模块。安装后 bundle 会写进 profile 的
`package.json` 与 `cordis.patch.yml`，重启后仍在；Client 半立刻注册到 `shell.overlay`
（常驻悬浮窗）和 `conversation.composer.dock`（可选计时条）。改动 `client.js` 后若界面
没更新，刷新一次页面即可。

> 包名 `dsh-pomodoro`，与仓库同名。插件在 profile 里显示为 `pomodoro` 这一行。

## 实现要点

| 文件 | 作用 |
| --- | --- |
| `package.json` | bundle 清单：`dsh.bundle.patch` + `dsh.client`（web，immediately） |
| `cordis.patch.yml` | 插入 `pomodoro` 行；Host 半为空 |
| `index.js` | Host 半：`apply() {}`，计时全在浏览器 |
| `client.js` | 计时引擎 + 悬浮窗 + 计时条 + 设置面板 + 通知/提示音 + 结束动效 |
| `locale/*.json` | 插件清单里的标题/描述（中英） |
| `icon.svg` | 番茄 + 时钟指针，原创图形 |

- 只从 loader 的模块表取 `react`，不引用任何 Harness Client 包；
- 颜色全部走 `--dsw-alias-*` 主题令牌，浅色/深色主题自动跟随；
- 悬浮层本身是 click-through 的，只有窗口自己的盒子接收指针事件；
- 文案走 Client locale 服务的 `pomodoro` 命名空间（en/zh），切换语言时插槽会自动重渲染；
- 样式以组件内 `<style>` 渲染，卸载即移除；区间、监听、音频上下文都在 `ctx.effect` 里释放。
