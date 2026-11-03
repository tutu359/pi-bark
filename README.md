# pi-bark

将 Pi 的运行状态和回答发送到 iPhone 上的 Bark。
支持完成、失败和等待输入通知，也可以手动发送最近一次回答，并通过 AES-256-GCM 加密推送内容。

## 环境要求

- macOS
- Node.js >= 22.19.0
- Pi >= 1.3.0 且 < 2.0.0
- iPhone 已安装 Bark 并允许通知

## 安装与加载

在项目目录安装依赖，然后加载插件：

```bash
npm ci
pi -e ./extensions/bark.ts
```

需要长期加载时，用 `pi install` 指向本项目的绝对路径，再重新启动 Pi。
同一插件只加载一次，避免重复命令和通知。

## 配置 Bark

从 Bark App 的测试地址中取出设备 Key。例如地址为
`https://api.day.app/your-device-key/Test`，设备 Key 就是 `your-device-key`。
在 Pi 中运行：

```text
/set-bark your-device-key
```

使用自建服务时，补上服务地址：

```text
/set-bark your-device-key https://bark.example.com
```

不要把完整测试地址或 `/Test` 当作设备 Key。设备 Key 能授权向手机推送，应妥善保管。

配置默认保存在 `~/.pi/agent/config/pi-bark/config.json`。
设置了 `PI_CODING_AGENT_DIR` 时，使用该目录下的 `config/pi-bark/config.json`。
配置修改在下一次命令或状态事件时生效。

## 使用

| 命令 | 作用 |
| --- | --- |
| `/copyb` | 复制最近一条助手回答并发送到 Bark |
| `/bark on` | 为当前工作目录开启自动通知 |
| `/bark off` | 为当前工作目录关闭自动通知 |
| `/bark inherit` | 让当前目录继承默认通知设置 |
| `/bark default on` | 默认开启自动通知 |
| `/bark default off` | 默认关闭自动通知 |
| `/set-bark <key> [server-url]` | 保存设备 Key 和服务地址 |

自动通知默认开启，只包含状态和会话名，不包含问题、回答或错误正文。
运行最终结束、最终失败或出现阻塞式输入框时发送通知；用户取消运行时不发送结束通知。
“完成”表示 Pi 已停止自动运行，不表示测试或业务目标一定成功。

目录开关按绝对工作路径精确匹配，会保存到配置文件；关闭自动通知不影响 `/copyb`。
当前通过事件和用户命令发送通知，没有模型可调用的通知工具。

`/copyb` 保留回答中的 Markdown、代码块和换行，但不截断长内容。
超出 Bark 或 Apple 推送负载限制时可能失败；请求超时为 15 秒，推送失败不撤销剪贴板复制。
发送成功不等于手机已经收到，没有持久化重试队列。

## 推送加密

生成并保存加密密钥：

```bash
npm run key
```

在 Bark App 的推送加密设置中选择 `AES256`、`GCM` 和 `noPadding`，填入生成的密钥。
如果 App 要求填写 IV，可以填入任意 12 个 ASCII 字符；实际推送使用每次生成的新 IV。
然后运行 `/copyb`，确认手机能显示正确正文。

更换或关闭加密：

```bash
npm run key -- --force
npm run key -- --disable
```

这些命令会写入 Pi 配置；更换或关闭后，应同步更新手机 Bark 的设置。
加密覆盖通知内容，不隐藏设备 Key，因此服务地址仍应使用 HTTPS。
不要把密钥命令的输出贴到公开日志中。

## 开发

```bash
npm run typecheck
npm test
npm run pack:check
```

`npm test` 会先构建配置和密钥脚本，再运行通知与配置存储测试。
测试使用临时目录并模拟网络和剪贴板，不会向真实设备发送通知。

| 文件 | 职责 |
| --- | --- |
| `extensions/bark.ts` | Pi 事件、用户命令和 HTTP 推送 |
| `src/config.ts` | Bark 配置校验与更新 |
| `src/config-store.ts` | 配置文件读取、校验、锁和原子写入 |
| `src/encryption.ts` | 内容加密与密钥生成 |
| `scripts/generate-encryption-key.ts` | 密钥管理命令 |
| `test/` | 通知与配置存储测试 |

## 许可证

[MIT](LICENSE)
