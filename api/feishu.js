/**
 * 飞书消息机器人 Webhook 处理逻辑
 * 由 server.js 挂载到 POST /api/feishu（PM2 运行）
 *
 * 飞书文档：请求地址校验需在 1 秒内返回 HTTP 200，响应体为 JSON 且包含 challenge 字段。
 * 未配置 Encrypt Key 时请求体为 {"type":"url_verification","challenge":"xxx"} 或 {"challenge":"xxx"}。
 * 配置了 Encrypt Key 时请求体为 {"encrypt":"..."}，需先解密再取 challenge（当前未实现解密）。
 */

const { Client, withTenantKey } = require('@larksuiteoapi/node-sdk');

const APP_ID = process.env.APP_ID;
const APP_SECRET = process.env.APP_SECRET;

// 不自建应用发消息需 token；disableTokenCache: true 时 SDK 不会附加 token，导致 99991661
const larkClient =
  APP_ID && APP_SECRET
    ? new Client({
        appId: APP_ID,
        appSecret: APP_SECRET,
      })
    : null;

/**
 * 根据用户发送的文本内容决定回复内容（可在此扩展更多指令）
 * @param {string} rawText - 用户消息原文
 * @returns {{ text: string }} - 用于 text 消息的 content
 */
function getReplyByContent(rawText) {
  const text = (rawText || '').trim();
  const lower = text.toLowerCase();

  if (lower === '帮助' || lower === 'help') {
    return {
      text: '可用指令：\n• 帮助 / help - 显示本说明\n• ping - 测活\n• 其他内容 - 原样回显',
    };
  }
  if (lower === 'ping') {
    return { text: 'pong' };
  }
  if (text) {
    return { text: `你说了：${text}` };
  }
  return { text: '（空）' };
}

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
      const chatType = message.chat_type || '';
      const chatId = message.chat_id;
      // 单聊(p2p) 时发消息需用 open_id；群聊用 chat_id（见飞书文档 230034 / 发送消息）
      const sender = event.sender || {};
      let senderId = sender.sender_id || sender.open_id || message.sender_id;
      // 飞书事件里 sender_id 可能是对象 { open_id, union_id, user_id }，receive_id 必须是字符串
      if (senderId && typeof senderId === 'object' && senderId.open_id) {
        senderId = senderId.open_id;
      }

      const content = message.content ? JSON.parse(message.content) : {};
      const userText = content.text || '';
      const replyContent = getReplyByContent(userText);
      const reply = {
        msg_type: 'text',
        content: replyContent,
      };

      const isP2p = String(chatType).toLowerCase() === 'p2p';
      const receiveIdType = isP2p ? 'open_id' : 'chat_id';
      const receiveId = isP2p ? senderId : chatId;

      if (!receiveId) {
        console.error('Process message: missing receive_id (open_id or chat_id)');
      } else {
        const tenantKey = header.tenant_key;
        const requestOptions = tenantKey ? withTenantKey(tenantKey) : undefined;
        await larkClient.im.message.create(
          {
            params: { receive_id_type: receiveIdType },
            data: { receive_id: receiveId, ...reply },
          },
          requestOptions
        );
      }
    } catch (err) {
      console.error('Process message error:', err);
      if (err.response?.data) console.error('Feishu API response:', err.response.data);
      // 仍返回 200，避免飞书重复推送
    }
  }

  // 其他事件或处理完毕，均返回 200（飞书要求 3 秒内 200），且必须为合法 JSON
  replyJson(res, 200, {});
};
