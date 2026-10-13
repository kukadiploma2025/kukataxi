import { config } from './config.js';

const msgs = {
  ru: (code) => `KUKA TAXI: ваш код ${code}. Никому его не сообщайте. Действует 5 минут.`,
  kk: (code) => `KUKA TAXI: сіздің кодыңыз ${code}. Оны ешкімге айтпаңыз. 5 минут жарамды.`,
};

async function post(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`provider ${res.status}`);
  return res;
}

const chatId = (phone) => phone.replace('+', '') + '@c.us';

// Отправка кода подтверждения в WhatsApp через выбранного провайдера.
export async function sendOtp(phone, code, lang = 'ru') {
  const p = config.otp.provider;
  if (p === 'console') {
    if (!config.isTest) console.log(`[OTP console] ${phone} -> ${code}`);
    return;
  }
  if (p === 'greenapi') {
    const { url, id, token } = config.greenapi;
    await post(`${url}/waInstance${id}/sendMessage/${token}`, { chatId: chatId(phone), message: (msgs[lang] || msgs.ru)(code) });
    return;
  }
  if (p === 'meta') {
    const m = config.meta;
    await post(
      `https://graph.facebook.com/${m.version}/${m.phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        to: phone.replace('+', ''),
        type: 'template',
        template: {
          name: m.template,
          language: { code: m.templateLang },
          components: [
            { type: 'body', parameters: [{ type: 'text', text: code }] },
            { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
          ],
        },
      },
      { Authorization: `Bearer ${m.token}` },
    );
    return;
  }
  throw new Error('unknown OTP provider');
}

// Обычное текстовое сообщение (уведомления). Meta без шаблона разрешает писать только в 24-часовом окне,
// поэтому для неё уведомления не отправляются.
export async function sendText(phone, text) {
  try {
    const p = config.otp.provider;
    if (p === 'console') { if (!config.isTest) console.log(`[WA console] ${phone}: ${text}`); return; }
    if (p === 'greenapi') {
      const { url, id, token } = config.greenapi;
      await post(`${url}/waInstance${id}/sendMessage/${token}`, { chatId: chatId(phone), message: text });
    }
  } catch { /* уведомления не критичны */ }
}
