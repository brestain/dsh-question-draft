# DSH 提问草稿保全 · dsh-question-draft

解决 DSH 提问卡片（`ask_user_question`）**超时或被关闭后，已经答好的内容全部丢失**的问题。

卡片还在屏幕上时，扩展每 500ms 把「已选选项 + 手写文字」按对话存进本机；卡片因超时 / 被取消而消失时，自动把未提交的作答整理成一段文本回填到聊天输入框，你确认后回车发出即可。

- 无需构建，纯 JS 内容脚本（Manifest V3）
- 不联网、不收集、不外传任何数据
- 站点范围仅限本机 DSH 与你自建的 DSH 域名

> **English** — A build-free Chrome (Manifest V3) content script that keeps continuously saving your in-progress answers to DSH question cards into `chrome.storage.local`, and restores them into the chat composer once the card times out or is dismissed. No network requests, no telemetry.

## 效果

**1. 作答中：选项与手写文字都被实时记录**

![作答中的提问卡片](docs/1.jpg)

**2. 卡片即将超时：即使暂未提交，草稿也已落盘**

![第二题，等待卡片超时](docs/2.jpg)

**3. 卡片消失后：作答被整理成「问题 + 我的回答」回填输入框**

![超时后自动回填到输入框](docs/3.jpg)

## 功能

| 场景 | 行为 |
| --- | --- |
| 卡片在屏幕上 | 每 500ms（防抖）保存一次草稿，按标签页隔离，键名前缀 `qd:` |
| 卡片超时 / 被顶掉消失 | 宽限 2 秒进入恢复流程，把未提交的题与答案写进输入框 |
| 点「下一题 / 上一题」 | 只翻页，**不清草稿**，并把已答题并入草稿 |
| 点「提交 / 跳过本题」 | 清除本对话草稿 |
| 填入的内容被发送（输入框清空） | 清除本对话草稿 |
| 输入框里已有你自己打的字 | 不覆盖，只在右下角浮一条提示，可点击插入 |
| 草稿超过 24 小时 | 启动时自动清理 |

写入输入框采用「一次只试一种手段、写完校验、没进去才试下一种」（粘贴事件 → execCommand → 直接赋值），避免重复插入，也避免插入失败后残留「已插入」标记。

## 安装

从 [Releases](https://github.com/brestain/dsh-question-draft/releases/latest) 下载 `dsh-question-draft-1.0.0.zip`：

1. 解压到一个**固定目录**（Chrome 记住的是文件夹路径，之后不要删除或移动）
2. 打开 `chrome://extensions`，右上角打开「开发者模式」
3. 点「加载已解压的扩展程序」，选择解压出来的文件夹
4. 刷新 DSH 页面（内容脚本只在页面加载时注入）

开发调试也可以直接克隆本仓库，加载仓库根目录。

## 使用

1. 照常在提问卡片里勾选选项 / 输入文字
2. 卡片超时或被关掉后，输入框会自动出现：

```text
1. （问题原文）？
我的回答：选项 A2

2. （问题原文）？
我的回答：第二题的回答，巴拉巴拉
```

3. 检查无误后回车发出，草稿自动清除；若输入框里已有你自己的内容，右下角的小条点一下才会插入

## 排错

在 DSH 页面打开 DevTools Console，过滤 `dsh-question-draft`，正常只会看到几条关键日志（启动 / 卡片消失 / 恢复 / 写入 / 失败）。

逐题落盘与心跳诊断日志默认关闭；需要排查时把 `qd-draft.js` 顶部的 `const DEBUG = false` 改成 `true`，再到 `chrome://extensions` 点一次「重新加载」。

## 权限与隐私

- `storage`：只用于在本机保存草稿（`chrome.storage.local`）
- 站点权限：`127.0.0.1`、`localhost`、`dsh.finalrat.icu`
- 不发起任何网络请求，不含远程代码、统计与广告；详见 [PRIVACY.md](PRIVACY.md)

## 目录结构

```text
manifest.json   扩展清单（Manifest V3）
qd-draft.js     全部逻辑，内容脚本
icons/          图标
docs/           效果截图
PRIVACY.md      隐私说明
LICENSE         MIT
```

## 版本

- **v1.0.0**（2026-09-25）首个正式版：草稿实时落盘、超时自动回填、翻页与提交识别、去重写入、24 小时过期清理

## 许可

[MIT](LICENSE)
