import { describe, expect, it } from 'vitest';
import { findUniqueTransferMatch, parseReceiptText, validateReceiptMatch } from './receipt-tools.js';

describe('receipt helper rules', () => {
  it('reads a unique baht amount written with Thai digits', () => {
    expect(parseReceiptText('ยอดเงิน ๒๕๐.๐๐ บาท').amountSatang).toBe(25000);
  });

  it('requires the slip amount to equal the transfer amount exactly', () => {
    const transfer = { key: 'payer|receiver|25000', amount: 25000 };
    expect(
      validateReceiptMatch({
        amountSatang: 24999,
        transfer,
        fingerprint: 'image-a',
        existingMatches: [],
      }),
    ).toEqual({ ok: false, reason: 'ยอดในสลิปไม่ตรงกับยอดที่ต้องโอน' });
  });

  it('does not let one image confirm two transfers', () => {
    const transfer = { key: 'payer|receiver|25000', amount: 25000 };
    expect(
      validateReceiptMatch({
        amountSatang: 25000,
        transfer,
        fingerprint: 'image-a',
        existingMatches: [{ fingerprint: 'image-a', transferKey: 'other|person|25000' }],
      }).reason,
    ).toBe('สลิปภาพนี้เคยถูกใช้แล้ว');
  });

  it('does not allow multiple slips to match the same transfer', () => {
    const transfer = { key: 'payer|receiver|25000', amount: 25000 };
    expect(
      validateReceiptMatch({
        amountSatang: 25000,
        transfer,
        fingerprint: 'image-b',
        existingMatches: [{ fingerprint: 'image-a', transferKey: transfer.key }],
      }),
    ).toEqual({ ok: false, reason: 'รายการโอนนี้จับคู่สลิปแล้ว' });
  });

  it('does not auto-select when multiple people owe the same amount', () => {
    expect(
      findUniqueTransferMatch(
        25000,
        [
          { key: 'a|x|25000', from: 'a', amount: 25000 },
          { key: 'b|y|25000', from: 'b', amount: 25000 },
        ],
        [],
      ),
    ).toBeNull();
  });

  it('auto-selects only a unique matching transfer from the selected payer', () => {
    expect(
      findUniqueTransferMatch(
        25000,
        [
          { key: 'a|x|25000', from: 'a', amount: 25000 },
          { key: 'a|y|25000', from: 'a', amount: 25000 },
          { key: 'b|z|25000', from: 'b', amount: 25000 },
        ],
        [],
        'b',
      ),
    ).toEqual({ key: 'b|z|25000', from: 'b', amount: 25000 });
  });

  it('keeps a payer’s equal-amount transfers for manual review', () => {
    expect(
      findUniqueTransferMatch(
        25000,
        [
          { key: 'payer|receiver-a|25000', from: 'payer', amount: 25000 },
          { key: 'payer|receiver-b|25000', from: 'payer', amount: 25000 },
        ],
        [],
        'payer',
      ),
    ).toBeNull();
  });

  it('parses comma decimal amounts without changing their satang value', () => {
    expect(parseReceiptText('ยอดเงิน 250,50 บาท').amountSatang).toBe(25050);
  });
});