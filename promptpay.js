function formatField(id, value) {
  const len = String(value.length).padStart(2, '0');
  return `${id}${len}${value}`;
}

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) : (crc << 1);
      crc &= 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function generatePromptPayPayload(target, amountBaht) {
  const digits = String(target || '').replace(/\D/g, '');
  let targetField = '';

  if (digits.length === 10 && digits.startsWith('0')) {
    // เบอร์มือถือ 10 หลัก -> แปลงเป็น 0066xxxxxxxxx
    targetField = formatField('01', `0066${digits.slice(1)}`);
  } else if (digits.length === 13) {
    // เลขบัตรประชาชน 13 หลัก
    targetField = formatField('02', digits);
  } else {
    throw new Error('กรุณากรอกเบอร์มือถือ 10 หลัก หรือเลขบัตรประชาชน 13 หลัก');
  }

  const merchantInfo = formatField('00', 'A000000677010111') + targetField;
  const amountStr = Number(amountBaht).toFixed(2);

  const payload =
    formatField('00', '01') +
    formatField('01', '12') + // 12 = QR แบบล็อกยอดเงิน
    formatField('29', merchantInfo) +
    formatField('58', 'TH') +
    formatField('53', '764') + // 764 = เงินบาท (THB)
    formatField('54', amountStr) +
    '6304';

  return payload + crc16(payload);
}