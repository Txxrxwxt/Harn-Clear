const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

export function normalizeReceiptText(value) {
  return String(value ?? '')
    .replace(/[๐-๙]/g, (digit) => String(THAI_DIGITS.indexOf(digit)))
    .replace(/[\u00a0\u202f]/g, ' ');
}

function amountToSatang(value) {
  const normalized = value.includes(',') && !value.includes('.')
    ? value.replace(',', '.')
    : value.replace(/,/g, '');
  const amount = Number(normalized);
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : null;
}

export function parseReceiptText(value) {
  const text = normalizeReceiptText(value);
  const number = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:[.,]\d{2})?`;
  const candidates = new Set();
  const patterns = [
    new RegExp(String.raw`(?:ยอดเงิน|จำนวนเงิน|amount|total|฿|THB)\s*[:：]?\s*(${number})`, 'gi'),
    new RegExp(String.raw`(${number})\s*(?:บาท|THB|฿)`, 'gi'),
    new RegExp(String.raw`(?<![\d/])((?:\d{1,3}(?:,\d{3})+|\d+)[.,]\d{2})(?![\d/])`, 'g'),
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const amount = amountToSatang(match[1]);
      if (amount !== null) candidates.add(amount);
    }
  }

  const dateMatch = text.match(/(?:วันที่\s*)?(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  const timeMatch = text.match(/(?:เวลา\s*)?(\d{1,2}):(\d{2})(?::\d{2})?/);
  const sourceMatch = text.match(/(?:ผู้โอน|จากบัญชี|ชื่อบัญชีต้นทาง|โอนจาก)\s*[:：]?\s*([^\n\r]{2,80})/i);
  const targetMatch = text.match(/(?:ผู้รับ|ไปยังบัญชี|ชื่อบัญชีปลายทาง|โอนไปยัง)\s*[:：]?\s*([^\n\r]{2,80})/i);
  let date = dateMatch ? `${dateMatch[1]}/${dateMatch[2]}/${dateMatch[3]}` : '';
  if (timeMatch) date = `${date ? `${date} ` : ''}${timeMatch[1]}:${timeMatch[2]}`;

  return {
    amountSatang: candidates.size === 1 ? [...candidates][0] : null,
    ambiguousAmount: candidates.size > 1,
    date,
    sourceName: sourceMatch?.[1]?.trim() ?? '',
    targetName: targetMatch?.[1]?.trim() ?? '',
  };
}

export function findUniqueTransferMatch(amountSatang, transfers, existingMatches, payerId = '') {
  if (!Number.isInteger(amountSatang) || amountSatang <= 0) return null;
  const occupied = new Set(existingMatches.map((match) => match.transferKey));
  const candidates = transfers.filter(
    (transfer) =>
      transfer.amount === amountSatang &&
      (!payerId || transfer.from === payerId) &&
      !occupied.has(transfer.key),
  );
  return candidates.length === 1 ? candidates[0] : null;
}

export function validateReceiptMatch({ amountSatang, transfer, fingerprint, existingMatches }) {
  if (!fingerprint) return { ok: false, reason: 'อ่านข้อมูลรูปภาพไม่สำเร็จ' };
  if (existingMatches.some((match) => match.fingerprint === fingerprint)) {
    return { ok: false, reason: 'สลิปภาพนี้เคยถูกใช้แล้ว' };
  }
  if (existingMatches.some((match) => match.transferKey === transfer.key)) {
    return { ok: false, reason: 'รายการโอนนี้จับคู่สลิปแล้ว' };
  }
  if (!Number.isInteger(amountSatang) || amountSatang <= 0) {
    return { ok: false, reason: 'ยังอ่านยอดเงินไม่ได้ กรุณากรอกยอดจากสลิป' };
  }
  if (amountSatang !== transfer.amount) {
    return { ok: false, reason: 'ยอดในสลิปไม่ตรงกับยอดที่ต้องโอน' };
  }
  return { ok: true, reason: '' };
}