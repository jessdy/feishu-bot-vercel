# 飞书消息机器人（Vercel 部署）

在 Vercel 上运行的飞书事件订阅 Webhook，用于接收并回复群聊/私聊消息。

## 功能

- 接收飞书「接收消息」事件（`im.message.receive_v1`）
- 通过 URL 校验完成飞书请求地址配置
- 收到文本消息后自动回复：「你说了：xxx」

## 部署到 Vercel

### 1. 推送代码到 Git

确保项目在 GitHub / GitLab / Bitbucket 中。

### 2. 在 Vercel 创建项目

1. 打开 [vercel.com](https://vercel.com)，用 Git 账号登录
2. 点击 **Add New** → **Project**，导入本仓库
3. 根目录保持默认，Framework 可选 **Other**，直接 **Deploy**

### 3. 配置环境变量

在 Vercel 项目 **Settings** → **Environment Variables** 中添加：

| 变量名       | 说明           |
| ------------ | -------------- |
| `APP_ID`     | 飞书应用 App ID |
| `APP_SECRET` | 飞书应用 App Secret |

保存后可在 **Deployments** 中 **Redeploy** 一次使变量生效。

### 4. 在飞书开放平台配置机器人

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 进入你的应用 → **事件订阅**
3. **请求地址** 填写：`https://你的项目.vercel.app/api/feishu`
4. 点击「保存」后，飞书会向该地址发校验请求，通过即可
5. 在 **权限管理** 中为应用开通：
   - `im:message`（接收与发送消息）
   - `im:message.group_at_msg`（若需要 @ 机器人）
6. 在 **事件订阅** 中订阅 **接收消息**（`im.message.receive_v1`）
7. 发布版本并启用机器人，在对应群聊/会话中即可使用

## 本地开发

```bash
# 安装依赖
pnpm install

# 使用 Vercel CLI 本地调试（需先 pnpm add -D vercel）
pnpm exec vercel dev
```

在项目根目录创建 `.env`，内容参考 `.env.example`：

```
APP_ID=你的飞书应用 App ID
APP_SECRET=你的飞书应用 App Secret
```

本地请求地址为：`http://localhost:3000/api/feishu`（飞书无法直接访问本地，可用内网穿透工具配合测试）。

## 项目结构

```
.
├── api/
│   └── feishu.js    # 飞书 Webhook 入口（Vercel Serverless）
├── .env.example
├── package.json
├── vercel.json      # Vercel 构建与路由
└── README.md
```

## 自定义回复逻辑

在 `api/feishu.js` 中修改「处理消息」部分即可，例如按关键词、按发送者、调用其他 API 等。注意：

- 必须在 **3 秒内** 返回 HTTP 200，否则飞书会重试
- 耗时逻辑建议先 `res.status(200).json({ ok: true })`，再异步处理并调用飞书发消息接口

## 参考

- [飞书开放平台 - 事件订阅](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [Vercel Serverless Functions](https://vercel.com/docs/functions)
