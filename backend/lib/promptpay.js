// PromptPay QR payload generator — implements the Thai PromptPay EMVCo QR spec.
// This produces a real, scannable PromptPay QR string; any Thai banking app can pay it
// directly into the merchant's bank account. No payment gateway/API key required.
// (There is no automatic payment-confirmation webhook this way — see routes/orders.js
// for the slip-upload + admin-confirms flow that pairs with this.)

function crc16xmodem(str) {
  let crc = 0x0000;
  for (let i = 0; i < str.length; i++) {
    crc ^= (str.charCodeAt(i) << 8);
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc;
}

function f(id, value) {
  const size = String(value.length).padStart(2, '0');
  return `${id}${size}${value}`;
}

function serialize(data) {
  const dataToCrc = data + '6304';
  const crc = crc16xmodem(dataToCrc).toString(16).toUpperCase().padStart(4, '0');
  return dataToCrc + crc;
}

// target: merchant's PromptPay ID — a Thai mobile number (e.g. "0812345678")
// or a 13-digit national ID / juristic tax ID.
function sanitizeTarget(id) {
  let target = String(id || '').replace(/[^0-9]/g, '');
  let targetType = null;
  if (/^0[0-9]{9}$/.test(target)) {
    targetType = 'msisdn';
    target = '0066' + target.substring(1);
  } else if (/^[0-9]{13}$/.test(target)) {
    targetType = 'nid';
  }
  return { targetType, target };
}

function isValidPromptPayId(id) {
  return sanitizeTarget(id).targetType !== null;
}

// amount: optional number (baht). Omit for a QR the customer can pay any amount into.
function generatePromptPayPayload(promptPayId, amount) {
  const { targetType, target } = sanitizeTarget(promptPayId);
  if (!targetType) throw new Error('เลขพร้อมเพย์ไม่ถูกต้อง (ต้องเป็นเบอร์โทร 10 หลัก หรือเลขบัตรประชาชน/นิติบุคคล 13 หลัก)');

  const targetTag = targetType === 'msisdn' ? f('01', target) : f('02', target);
  const amt = amount ? Number(amount) : null;

  const data = [
    f('00', '01'),
    f('01', amt ? '12' : '11'),
    f('29', [f('00', 'A000000677010111'), targetTag].join('')),
    f('53', '764'),
    amt ? f('54', amt.toFixed(2)) : '',
    f('58', 'TH'),
  ].join('');

  return serialize(data);
}

module.exports = { generatePromptPayPayload, isValidPromptPayId };
