const express = require('express');
const { Client } = require('@larksuiteoapi/node-sdk');

const app = express();
app.use(express.json()); // 解析 JSON 请求体

// 飞书应用凭证（从环境变量读取）
const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 初始化飞书客户端
const larkClient = new Client({
  appId: APP_ID,
  appSecret: APP_SECRET,
  disableTokenCache: true, // Vercel 无服务器环境不需要缓存
});

// 处理飞书 Webhook 请求
app.post('/', async (req, res) => {
  const event = req.body;

  // 验证请求（飞书会发送一个 challenge 用于验证）
  if (event.challenge) {
    return res.json({ challenge: event.challenge });
  }

  // 处理消息事件
  if (event.header && event.header.event_type === 'im.message.receive_v1') {
    const message = event.event.message;
    const chatId = message.chat_id;
    const content = JSON.parse(message.content);

    // 简单回复
    const reply = {
      msg_type: 'text',
      content: { text: `你说了：${content.text}` },
    };

    // 调用飞书 API 发送回复
    await larkClient.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: { receive_id: chatId, ...reply },
    });

    return res.status(200).send('消息已处理');
  }

  // 其他事件返回成功
  res.status(200).send('事件已接收');
});

module.exports = app;