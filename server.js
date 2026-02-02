/**
 * 飞书消息机器人 - HTTP 服务入口（PM2 运行）
 * 请求地址: http://host:PORT/api/feishu
 */

const express = require('express');
const feishuHandler = require('./api/feishu');

const app = express();
// 飞书校验/回调：仅对 POST 按 JSON 解析，再交给 handler
app.post(
  '/api/feishu',
  express.json({ type: () => true }),
  feishuHandler
);

// 健康检查
app.get('/health', (_, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feishu bot listening on http://0.0.0.0:${PORT}, APP_ID: ${process.env.APP_ID}`);
});
