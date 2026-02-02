/**
 * 飞书消息机器人 - HTTP 服务入口（PM2 运行）
 * 请求地址: http://host:PORT/api/feishu
 */

const express = require('express');
const feishuHandler = require('./api/feishu');

const app = express();
app.use(express.json());

app.post('/api/feishu', feishuHandler);

// 健康检查
app.get('/health', (_, res) => res.status(200).json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Feishu bot listening on http://0.0.0.0:${PORT}`);
});
