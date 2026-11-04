# pi-bark

把 Pi 的运行事件和业务消息推送到 iPhone 上的 Bark。

两条通道：**事件推送**（跑完、失败、等你确认）默认静默，需要某个会话自己去开；**主动推送工具** `bark_push` 一直可用，由模型自己决定推什么。

## 环境要求

- macOS
- Node.js >= 22.19.0
- Pi >= 1.3.0 且 < 2.0.0
- iPhone 已安装 Bark 并允许通知

## 安装与加载

```bash
pnpm install
pi -e ./extensions/bark.ts
```

需要长期加载时，用 `pi install` 指向本项目的绝对路径，再重新启动 Pi。同一插件只加载一次，避免重复命令和通知。

## 配置设备 Key

从 Bark App 的测试地址里取出设备 Key：地址 `https://api.day.app/your-device-key/Test` 里的 `your-device-key` 就是它。

```text
/set-bark your-device-key
```

自建服务时补上地址：

```text
/set-bark your-device-key https://bark.example.com
```

不要把完整测试地址或 `/Test` 当作设备 Key。设备 Key 能授权向手机推送，应妥善保管。

## 配置文件

只有一个文件：`~/.pi/agent/config/pi-bark/config.json`（设置 `PI_CODING_AGENT_DIR` 时改用它下面的路径）。目录 `0700`、文件 `0600`、加锁 + 原子写入。

```json
{
	"bark": {
		"serverUrl": "https://api.day.app",
		"deviceKey": "your-device-key",
		"encryption": null
	}
}
```

`bark` 三个字段都是必需的：`serverUrl` 决定 Device Key 发给谁，`encryption` 为 `null` 表示明文推送。任何一个缺失或非法，整个插件都会停用并提示修复，而不是悄悄回落到不安全的值。

**事件订阅不在这里。** 它存在会话文件里，见下。

## 事件推送

**默认全静默。** 新会话不会推送任何事件，直到你在该会话里打开。

```text
/bark
```

弹出一个勾选面板。**空格切换并立即保存，Esc 退出**，没有确认行：

```
Bark · Deploy API · ~/work/deploy
空格 切换并保存 · ↑↓ 移动 · Esc 退出

> [x] finished        跑完
  [ ] failed          出错
  [ ] needsInput      等你确认
  [ ] compactFailed   压缩失败
  [ ] waitingTooLong  停住 10 分钟

已开启 1 项
```

| 事件             | 触发时机                                                                        |
| ---------------- | ------------------------------------------------------------------------------- |
| `needsInput`     | 扩展弹出阻塞式对话框（`ui.select` / `confirm` / `input` / `editor` / `custom`） |
| `finished`       | 一轮自动运行真正停下，且没有错误                                                |
| `failed`         | 一轮停止时 `stopReason` 是错误，或运行中压缩失败                                |
| `compactFailed`  | 上下文压缩失败（即使运行还在继续）                                              |
| `waitingTooLong` | 停下后静默 10 分钟仍无人输入，且期间没有新动作                                  |

订阅状态写进**当前会话**，所以：

- 同一个目录里的多个会话互不影响，各开各的
- `--continue` / 恢复会话后订阅仍在，不用重新打开
- 切换分支时按当前分支读取
- 用户按 Esc 取消运行时不推送结束通知

推送内容固定、不含回答正文：

```
group: Deploy API
title: Deploy API · Pi finished
body: /Users/tutu/work/deploy
```

`group` 用会话名，把同一会话的推送堆在一起，可在通知中心整组静音；没有命名时用 `Pi · <会话 id 前 6 位>`。

## 主动推送工具

`bark_push` 始终注册、始终可用，没有开关。模型用它汇报业务结论，字段基本对应 Bark 的推送参数（`device_key`、`device_keys`、`ciphertext`、`iv` 除外 —— 前两个是凭据，后两个由插件生成）。

常用字段：`title` `subtitle` `body` `markdown` `group` `icon` `image` `badge` `level` `volume` `call` `sound` `copy` `url` `action` `isArchive` `ttl` `id` `delete`。

规则：

- `body` 与 `markdown` 至少给一个，两者都给时 `markdown` 生效
- 单条正文上限 2000 字符，超了直接报错让模型缩短
- `delete` 必须搭配 `id`
- `call` / `isArchive` / `delete` 用布尔值，插件转成 Bark 要的 `"1"` / `"0"`
- `title` 与 `group` 缺省时用会话名
- 同一轮里完全相同的推送只发一次，避免死循环刷屏

推送失败会把原因作为工具结果返回给模型，不会抛崩一次调用。

## 隐私与边界

- 事件推送只含事件名、会话名和工作目录，不含问题、回答或错误正文。
- `bark_push` 的正文由模型生成，会经过 Bark 服务器。除非自建服务，默认走 `api.day.app`（第三方）。被读取到的内容因此有外传的可能，提示注入无法靠本插件挡住。
- 没有持久化重试队列：请求超时 15 秒，失败就结束。
- 发送成功不等于手机已收到。

## 推送加密

```bash
pnpm key
```

在 Bark App 的推送加密设置中选择 `AES256`、`GCM`、`noPadding`，填入生成的密钥。App 要求填 IV 时，填任意 12 个 ASCII 字符即可；实际推送每次使用新 IV。

更换或关闭：

```bash
pnpm key --force
pnpm key --disable
```

加密覆盖推送内容，不隐藏设备 Key，服务地址仍应使用 HTTPS。不要把密钥输出贴到公开日志。

## 从 0.8 升级

配置结构变了：原来的 `statusNotifications`（`defaultEnabled`、`cwdOverrides`）被移除，事件订阅改为按会话存储。旧文件里的 `statusNotifications` 会被当作未知键提示一次并忽略，之后所有事件静默 —— 这与新默认一致，但需要你在需要的会话里重新 `/bark` 打开。

## 开发

```bash
pnpm check        # biome：格式、lint、import 排序
pnpm typecheck
pnpm test
pnpm pack:check
```

`pnpm test` 先构建配置和密钥脚本，再运行通知、工具与配置存储测试。测试使用临时目录并模拟网络、剪贴板和选择器，不会向真实设备发送通知。

| 文件                                 | 职责                             |
| ------------------------------------ | -------------------------------- |
| `extensions/bark.ts`                 | Pi 事件、命令、推送编排          |
| `src/config.ts`                      | `bark` 配置块的校验与修复写入    |
| `src/config-store.ts`                | 配置文件读取、校验、锁和原子写入 |
| `src/session.ts`                     | 事件名单与会话级订阅读写         |
| `src/menu.ts`                        | `/bark` 勾选面板                 |
| `src/push.ts`                        | 推送请求与事件正文               |
| `src/push-tool.ts`                   | `bark_push` 工具定义             |
| `src/encryption.ts`                  | 内容加密与密钥生成               |
| `scripts/generate-encryption-key.ts` | 密钥管理命令                     |
| `test/`                              | 通知、工具与配置存储测试         |

依赖用 pnpm 管理，锁文件是 `pnpm-lock.yaml`。`pnpm-workspace.yaml` 里的 `allowBuilds` 只放行两个传递依赖的构建脚本（`protobufjs`、`@google/genai`），它们本身都是空操作，但 pnpm 默认要求显式批准。

## 许可证

[MIT](LICENSE)
