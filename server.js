/**
 * 飞书消息机器人 - HTTP 服务入口（PM2 运行）
 * 请求地址: http://host:PORT/api/feishu
 */

require('dotenv').config();

const express = require('express');
const feishuHandler = require('./api/feishu');

const app = express();

// 飞书回调：仅对 POST /api/feishu 解析 JSON，解析失败时返回 JSON 错误（避免飞书收到 HTML）
app.post(
  '/api/feishu',
  (req, res, next) => {
    express.json()(req, res, (err) => {
      if (err) {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(400).end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      next();
    });
  },
  feishuHandler
);

// 健康检查
app.get('/health', (_, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(200).end(JSON.stringify({ ok: true }));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Feishu bot listening on http://0.0.0.0:${PORT}`);
});
