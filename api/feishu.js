/**
 * 飞书消息机器人 Webhook 处理逻辑
 * 由 server.js 挂载到 POST /api/feishu（PM2 运行）
 */

const { Client } = require('@larksuiteoapi/node-sdk');

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

const larkClient =
  APP_ID && APP_SECRET
    ? new Client({
        appId: APP_ID,
        appSecret: APP_SECRET,
        disableTokenCache: true,
      })
    : null;

module.exports = async (req, res) => {
  // 仅接受 POST（飞书事件订阅与 URL 校验均为 POST）
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }

  const body = req.body || {};

  // 1. URL 校验：飞书配置请求地址时会发带 challenge 的 POST
  if (body.challenge) {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  if (!larkClient) {
    console.error('APP_ID or APP_SECRET not configured');
    res.status(500).json({ error: 'Server configuration error' });
    return;
  }

  // 2. 事件回调：im.message.receive_v1
  const header = body.header || {};
  const event = body.event || {};

  if (header.event_type === 'im.message.receive_v1') {
    try {
      const message = event.message || {};
      const chatId = message.chat_id;
      const content = message.content ? JSON.parse(message.content) : {};

      const reply = {
        msg_type: 'text',
        content: { text: `你说了：${content.text || '(空)'}` },
      };

      await larkClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, ...reply },
      });
    } catch (err) {
      console.error('Process message error:', err);
      // 仍返回 200，避免飞书重复推送
    }
  }

  // 其他事件或处理完毕，均返回 200（飞书要求 3 秒内 200）
  res.status(200).json({ ok: true });
};
