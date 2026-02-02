# 飞书消息机器人（PM2 部署）

使用 PM2 运行的长驻 HTTP 服务，对接飞书事件订阅 Webhook，接收并回复群聊/私聊消息。

## 功能

- 接收飞书「接收消息」事件（`im.message.receive_v1`）
- 通过 URL 校验完成飞书请求地址配置
- 收到文本消息后自动回复：「你说了：xxx」

## 本地开发

```bash
# 安装依赖
pnpm install

# 直接启动（开发）
pnpm start
```

在项目根目录创建 `.env`（或使用系统环境变量），参考 `.env.example`：

```
APP_ID=你的飞书应用 App ID
APP_SECRET=你的飞书应用 App Secret
```

服务默认监听 `http://0.0.0.0:3000`，Webhook 地址为 `http://localhost:3000/api/feishu`。飞书无法直接访问本地，可用内网穿透（如 ngrok、frp）配合测试。

## 使用 PM2 运行

```bash
# 安装依赖（含 pm2）
pnpm install

# 开发环境启动
pnpm pm2:start

# 生产环境启动
pnpm pm2:start:prod

# 查看日志
pnpm pm2:logs

# 重启
pnpm pm2:restart

# 停止并删除进程
pnpm pm2:stop
pnpm pm2:delete
```

或直接使用 PM2 命令：

```bash
pm2 start ecosystem.config.cjs
pm2 start ecosystem.config.cjs --env production
pm2 logs feishu-bot
pm2 restart feishu-bot
```

环境变量可在 `ecosystem.config.cjs` 的 `env` / `env_production` 中配置，或通过系统环境 / `.env`（需配合 `pm2 install pm2-dotenv` 等）注入。

## 部署到服务器

1. 将代码拉到服务器（如 `git clone`）。
2. 安装 Node.js 18+ 和 pnpm。
3. 在项目根目录执行：
   ```bash
   pnpm install --prod
   ```
4. 配置环境变量（系统环境、`.env` 或 `ecosystem.config.cjs` 的 `env_production`）。
5. 启动：
   ```bash
   pm2 start ecosystem.config.cjs --env production
   pm2 save
   pm2 startup   # 按提示设置开机自启
   ```
6. 确保防火墙/安全组放行 `PORT`（默认 3000），或前置 Nginx 反代并配置 HTTPS。

## 飞书开放平台配置

1. 登录 [飞书开放平台](https://open.feishu.cn/app)
2. 进入你的应用 → **事件订阅**
3. **请求地址** 填写：`https://你的域名或IP:端口/api/feishu`（需公网可访问，建议 HTTPS）
4. 点击「保存」后，飞书会发校验请求，通过即可
5. **权限管理** 中开通：
   - `im:message`（接收与发送消息）
   - `im:message.group_at_msg`（若需要 @ 机器人）
6. **事件订阅** 中订阅 **接收消息**（`im.message.receive_v1`）
7. 发布版本并启用机器人

## 项目结构

```
.
├── api/
│   └── feishu.js           # 飞书 Webhook 处理逻辑
├── server.js               # HTTP 入口（Express + PM2）
├── ecosystem.config.cjs    # PM2 配置
├── .env.example
├── package.json
└── README.md
```

## 健康检查

- `GET /health` 返回 `{ "ok": true }`，可用于负载均衡或监控探活。

## 自定义回复逻辑

在 `api/feishu.js` 中修改「处理消息」部分即可。注意：

- 必须在 **3 秒内** 返回 HTTP 200，否则飞书会重试
- 耗时逻辑建议先 `res.status(200).json({ ok: true })`，再异步处理并调用飞书发消息接口

## 参考

- [飞书开放平台 - 事件订阅](https://open.feishu.cn/document/ukTMukTMukTM/uUTNz4SN1MjL1UzM)
- [PM2 文档](https://pm2.keymetrics.io/docs/usage/application-declaration/)
