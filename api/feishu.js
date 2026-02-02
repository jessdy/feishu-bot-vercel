/**
 * 飞书消息机器人 Webhook 处理逻辑
 * 由 server.js 挂载到 POST /api/feishu（PM2 运行）
 *
 * 飞书文档：请求地址校验需在 1 秒内返回 HTTP 200，响应体为 JSON 且包含 challenge 字段。
 * 未配置 Encrypt Key 时请求体为 {"type":"url_verification","challenge":"xxx"} 或 {"challenge":"xxx"}。
 * 配置了 Encrypt Key 时请求体为 {"encrypt":"..."}，需先解密再取 challenge（当前未实现解密）。
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

/** 仅用 JSON 字符串写响应，避免 res.json() 导致 BOM/多余内容，满足飞书「合法 JSON」校验 */
function replyJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body, 'utf8'));
  res.status(statusCode).end(body);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    replyJson(res, 405, { error: 'Method Not Allowed' });
    return;
  }

  let body = req.body;
  if (!body || typeof body !== 'object') {
    try {
      body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : {};
    } catch {
      body = {};
    }
  }

  // 1. URL 校验（飞书文档：type=url_verification 或 顶层含 challenge）
  const isUrlVerification =
    body.type === 'url_verification' ||
    (body.challenge != null && body.challenge !== '') ||
    (body.CHALLENGE != null && body.CHALLENGE !== '');
  const challenge = body.challenge ?? body.CHALLENGE ?? '';

  if (isUrlVerification && challenge !== '') {
    replyJson(res, 200, { challenge: String(challenge) });
    return;
  }

  if (!larkClient) {
    console.error('APP_ID or APP_SECRET not configured');
    replyJson(res, 500, { error: 'Server configuration error' });
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

  // 其他事件或处理完毕，均返回 200（飞书要求 3 秒内 200），且必须为合法 JSON
  replyJson(res, 200, {});
};
