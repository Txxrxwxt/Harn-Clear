import { findUniqueTransferMatch, parseReceiptText, validateReceiptMatch } from './receipt-tools.js';
import { generatePromptPayPayload } from './promptpay.js';
(() => {
  'use strict';
  const STORAGE_KEY = 'harn-clear-v1';
  const screen = document.querySelector('#screen');
  const toastElement = document.querySelector('#toast');
  const dialog = document.querySelector('#confirm-dialog');
  const dialogTitle = document.querySelector('#dialog-title');
  const dialogDescription = document.querySelector('#dialog-description');
  const dialogConfirm = document.querySelector('#dialog-confirm');
  let confirmAction = null;
  let activeTab = 'friends';
  let resultView = 'from';
  let transfers = null;
  let optimal = true;
  let loading = false;
  let receiptMode = 'target';
  let receiptTargetKey = '';
  let receiptPayerId = '';
  let receiptSelectedFiles = [];
  let receiptDrafts = [];
  let receiptProcessing = false;
  let receiptWorker = null;
  const backButton = '<button class="button button-light" data-action="back">← ย้อนกลับ</button>';

  const uid = () => Math.random().toString(36).slice(2, 10);
  const defaultPeople = (count = 13) => Array.from({ length: count }, (_, i) => ({ id: uid(), name: `เพื่อน ${i + 1}`, promptpay: '' }));
  const initialState = () => ({ people: defaultPeople(), items: [], mode: 'items', direct: {}, receiptMatches: [] });
  const demoState = () => {
    const people = defaultPeople(), ids = people.map(person => person.id);
    const item = (name, price, payerIndex, participantIds) => ({ id: uid(), name, price, payerId: ids[payerIndex] || null, participantIds });
    return {
      people, mode: 'items', direct: {}, receiptMatches: [], items: [
        item('ส้มตำ', '360', 0, [...ids]), item('ไก่ย่าง', '480', 2, [...ids]),
        item('ข้าวเหนียว', '130', 0, ids.slice(0, 10)), item('น้ำแข็ง', '60', 6, [...ids]),
        item('จาน', '90', 6, [...ids]), item('แก้ว', '75', 11, ids.slice(3, 13))
      ]
    };
  };
  const cleanState = value => {
    const fallback = initialState();
    if (!value || !Array.isArray(value.people) || !Array.isArray(value.items)) return fallback;
    return {
      people: value.people.map(p => ({ id: String(p.id || uid()), name: String(p.name ?? ''), promptpay: String(p.promptpay ?? '') })),
      items: value.items.map(i => ({ id: String(i.id || uid()), name: String(i.name ?? ''), price: String(i.price ?? ''), payerId: i.payerId || null, participantIds: Array.isArray(i.participantIds) ? i.participantIds : [] })),
      mode: value.mode === 'direct' ? 'direct' : 'items', direct: value.direct && typeof value.direct === 'object' ? value.direct : {},
      receiptMatches: Array.isArray(value.receiptMatches) ? value.receiptMatches.filter(match => match && typeof match.fingerprint === 'string' && typeof match.transferKey === 'string').map(match => ({ fingerprint: match.fingerprint, transferKey: match.transferKey, amountSatang: Number.isInteger(match.amountSatang) ? match.amountSatang : 0, matchedAt: String(match.matchedAt || '') })) : []
    };
  };
  let state = (() => { try { const saved = localStorage.getItem(STORAGE_KEY); return saved ? cleanState(JSON.parse(saved)) : initialState(); } catch { return initialState(); } })();

  const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
  const toSatang = value => { const number = Number(String(value).replace(/,/g, '').trim()); return Number.isFinite(number) ? Math.round(number * 100) : 0; };
  const formatBaht = satang => (satang / 100).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const save = () => localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  const personName = id => state.people.find(person => person.id === id)?.name || '-';
  const duplicateNames = () => {
    const counts = new Map(); state.people.forEach(person => { const key = person.name.trim(); counts.set(key, (counts.get(key) || 0) + 1); });
    return [...counts].filter(([, count]) => count > 1).map(([name]) => name);
  };
  const validateItems = () => state.items.map(item => {
    if (!item.payerId) return { id: item.id, message: 'ยังไม่ได้เลือกคนที่จ่ายไปก่อน' };
    if (!item.participantIds.length) return { id: item.id, message: 'ยังไม่ได้เลือกว่าใครกินรายการนี้' };
    if (toSatang(item.price) <= 0) return { id: item.id, message: 'ราคาต้องมากกว่า 0' };
    return null;
  }).filter(Boolean);
  const netFromItems = () => {
    const net = Object.fromEntries(state.people.map(person => [person.id, 0]));
    state.items.forEach(item => {
      const price = toSatang(item.price), participants = item.participantIds.filter(id => id in net);
      if (price <= 0 || !participants.length) return;
      if (item.payerId && item.payerId in net) net[item.payerId] += price;
      const share = Math.floor(price / participants.length), remainder = price - share * participants.length;
      participants.forEach((id, index) => { net[id] -= share + (index < remainder ? 1 : 0); });
    }); return net;
  };
  const currentNet = () => state.mode === 'items' ? netFromItems() : Object.fromEntries(state.people.map(p => [p.id, toSatang(state.direct[p.id] || '0')]));
  const sumNet = net => Object.values(net).reduce((sum, value) => sum + value, 0);
  const blockReason = () => {
    if (state.people.length < 2) return 'ต้องมีเพื่อนอย่างน้อย 2 คน';
    if (duplicateNames().length) return 'มีชื่อซ้ำกัน กรุณาแก้ไขชื่อในแท็บรายชื่อเพื่อนก่อน';
    if (state.mode === 'items') {
      if (!state.items.length) return 'ยังไม่มีรายการอาหาร';
      if (validateItems().length) return 'มีรายการที่ยังกรอกไม่ครบ กรุณาแก้ไขในแท็บกรอกข้อมูล';
    } else if (sumNet(currentNet()) !== 0) return 'ผลรวมยอดสุทธิยังไม่เท่ากับ 0 กรุณาแก้ไขในแท็บกรอกข้อมูล';
    return null;
  };
  const resetResult = () => {
    transfers = null; optimal = true; state.receiptMatches = []; receiptSelectedFiles = []; receiptDrafts = []; receiptProcessing = false;
    if (receiptWorker) { receiptWorker.terminate(); receiptWorker = null; }
  };
  const commit = (rerender = true) => { resetResult(); save(); if (rerender) render(); };
  const toast = text => { toastElement.textContent = text; toastElement.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => toastElement.classList.remove('show'), 2200); };
  const askConfirm = (title, description, label, action) => { dialogTitle.textContent = title; dialogDescription.textContent = description; dialogConfirm.textContent = label; confirmAction = action; dialog.showModal(); };
  dialog.addEventListener('close', () => { if (dialog.returnValue === 'confirm' && confirmAction) confirmAction(); confirmAction = null; });

  function setTab(tab) { activeTab = tab; document.querySelectorAll('.step-tab').forEach(button => button.classList.toggle('active', button.dataset.tab === tab)); render(); window.scrollTo({ top: 0, behavior: 'smooth' }); }
  document.querySelectorAll('.step-tab').forEach(button => button.addEventListener('click', () => setTab(button.dataset.tab)));
  document.querySelector('#demo-button').addEventListener('click', () => { state = demoState(); save(); resetResult(); setTab('input'); toast('โหลดข้อมูลตัวอย่างแล้ว'); });
  document.querySelector('#reset-button').addEventListener('click', () => askConfirm('เริ่มใหม่ทั้งหมด?', 'รายชื่อและรายการทั้งหมดจะถูกลบ และกลับไปเป็นเพื่อน 13 คนตามค่าเริ่มต้น', 'ล้างข้อมูล', () => { state = initialState(); save(); resetResult(); setTab('friends'); toast('ล้างข้อมูลเรียบร้อย'); }));

  function friendsHtml() {
    const duplicates = duplicateNames();
    return `<div class="stack"><div class="card"><h2>รายชื่อเพื่อน (${state.people.length} คน)</h2><p class="help">แตะที่ชื่อเพื่อแก้ไขได้เลย แล้วกด “ถัดไป” เมื่อกรอกครบ</p>
      ${duplicates.length ? `<p class="notice notice-danger">มีชื่อซ้ำ: ${escapeHtml(duplicates.join(', ') || '(ชื่อว่าง)')} — กรุณาแก้ไขให้ไม่ซ้ำกัน</p>` : ''}
      <div class="form-list">${state.people.map((person, index) => `<div class="row friend-row"><span class="index">${index + 1}</span><div class="friend-inputs"><input class="input" data-action="rename" data-id="${person.id}" value="${escapeHtml(person.name)}" aria-label="ชื่อเพื่อน ${index + 1}"><input class="input input-pp" inputmode="numeric" data-action="promptpay" data-id="${person.id}" value="${escapeHtml(person.promptpay || '')}" placeholder="พร้อมเพย์ (ไม่บังคับ)"></div><button class="button-icon" data-action="remove-person" data-id="${person.id}" aria-label="ลบ ${escapeHtml(person.name)}">×</button></div>`).join('')}</div>
      <div class="footer-row"><button class="button button-secondary" data-action="add-person">＋ เพิ่มเพื่อน</button><button class="button" data-action="next-input">ถัดไป →</button></div>
    </div></div>`;
  }
  function itemCard(item, index, issues) {
    const issue = issues.find(entry => entry.id === item.id)?.message;
    return `<article class="card"><div class="item-head"><span class="item-number">${index + 1}</span><input class="input" data-action="item-name" data-id="${item.id}" value="${escapeHtml(item.name)}" placeholder="ชื่อรายการ เช่น ส้มตำ"><button class="button-icon" data-action="remove-item" data-id="${item.id}" aria-label="ลบรายการ">×</button></div>
      <div class="field-grid"><div class="field"><label>ราคา (บาท)</label><input class="input" inputmode="decimal" data-action="item-price" data-id="${item.id}" value="${escapeHtml(item.price)}" placeholder="0.00"></div><div class="field"><label>คนที่จ่ายไปก่อน</label><select class="select" data-action="item-payer" data-id="${item.id}"><option value="">เลือกคนจ่าย</option>${state.people.map(person => `<option value="${person.id}" ${person.id === item.payerId ? 'selected' : ''}>${escapeHtml(person.name)}</option>`).join('')}</select></div></div>
      <div class="participant-head"><span>ใครกินรายการนี้ (${item.participantIds.length} คน)</span><div class="row"><button class="button button-small button-secondary" data-action="select-all" data-id="${item.id}">เลือกทุกคน</button><button class="button button-small button-ghost" data-action="clear-all" data-id="${item.id}">ล้างทั้งหมด</button></div></div>
      <div class="participant-grid">${state.people.map(person => { const checked = item.participantIds.includes(person.id); return `<label class="check-person ${checked ? 'checked' : ''}"><input type="checkbox" data-action="participant" data-item="${item.id}" data-person="${person.id}" ${checked ? 'checked' : ''}><span>${escapeHtml(person.name)}</span></label>`; }).join('')}</div>
      <p class="notice notice-danger" data-item-issue="${escapeHtml(item.id)}" ${issue ? '' : 'hidden'}>${issue ? `⚠ ${escapeHtml(issue)}` : ''}</p></article>`;
  }
  function netSummary(net) { return `<div class="card"><h3>สรุปยอดสุทธิ (อัปเดตทันที)</h3><div class="net-list">${state.people.map(person => { const value = net[person.id] || 0; return `<div class="net-row"><span>${escapeHtml(person.name)}</span><span class="amount ${value > 0 ? 'positive' : value < 0 ? 'negative' : ''}" data-net-person="${escapeHtml(person.id)}">${value > 0 ? '+' : ''}${formatBaht(value)}</span></div>`; }).join('')}</div><p class="help">บวก = ต้องได้รับเงินคืน, ลบ = ต้องจ่ายเพิ่ม</p></div>`; }
  function refreshInputSummaries() {
    const net = currentNet();
    screen.querySelectorAll('[data-net-person]').forEach(element => {
      const value = net[element.dataset.netPerson] || 0;
      element.textContent = `${value > 0 ? '+' : ''}${formatBaht(value)}`;
      element.classList.toggle('positive', value > 0);
      element.classList.toggle('negative', value < 0);
    });
    const notice = screen.querySelector('#direct-sum-notice');
    if (notice) {
      const sum = sumNet(net);
      notice.classList.toggle('notice-success', sum === 0);
      notice.classList.toggle('notice-danger', sum !== 0);
      notice.textContent = sum === 0 ? 'ผลรวมเท่ากับ 0 พร้อมคำนวณได้เลย' : `⚠ ผลรวมยังไม่เท่ากับ 0 (ต่างอยู่ ${sum > 0 ? '+' : ''}${formatBaht(sum)} บาท) กรุณาแก้ไขก่อนคำนวณ`;
    }
  }
  function refreshItemIssue(id) {
    const notice = [...screen.querySelectorAll('[data-item-issue]')].find(element => element.dataset.itemIssue === id);
    if (!notice) return;
    const issue = validateItems().find(entry => entry.id === id)?.message;
    notice.hidden = !issue;
    notice.textContent = issue ? `⚠ ${issue}` : '';
  }
  function inputHtml() {
    const net = currentNet(), issues = validateItems();
    const mode = `<div class="mode-switch"><button data-action="mode" data-mode="items" class="${state.mode === 'items' ? 'active' : ''}">แยกตามรายการ</button><button data-action="mode" data-mode="direct" class="${state.mode === 'direct' ? 'active' : ''}">กรอกยอดสุทธิเอง</button></div>`;
    if (state.mode === 'direct') {
      const sum = sumNet(net);
      return `<div class="stack">${mode}<div class="card"><h2>กรอกยอดสุทธิของแต่ละคน</h2><p class="help">บวก = ต้องได้รับเงินคืน, ลบ = ต้องจ่ายเพิ่ม (ผลรวมต้องเท่ากับ 0)</p><div class="form-list">${state.people.map(person => `<div class="row"><span style="min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(person.name)}</span><input class="input input-money" style="width:144px" inputmode="decimal" data-action="direct" data-id="${person.id}" value="${escapeHtml(state.direct[person.id] || '')}" placeholder="0.00"></div>`).join('')}</div></div>
        <div id="direct-sum-notice" class="notice ${sum === 0 ? 'notice-success' : 'notice-danger'}">${sum === 0 ? 'ผลรวมเท่ากับ 0 พร้อมคำนวณได้เลย' : `⚠ ผลรวมยังไม่เท่ากับ 0 (ต่างอยู่ ${sum > 0 ? '+' : ''}${formatBaht(sum)} บาท) กรุณาแก้ไขก่อนคำนวณ`}</div><div class="footer-row">${backButton}<button class="button" data-action="next-result">ถัดไป →</button></div></div>`;
    }
    return `<div class="stack">${mode}${state.items.length ? state.items.map((item, index) => itemCard(item, index, issues)).join('') : '<p class="card empty help">ยังไม่มีรายการ กด “เพิ่มรายการ” เพื่อเริ่มกรอก แล้วกด “ถัดไป” เพื่อดูผลลัพธ์</p>'}<div class="footer-row cols-3">${backButton}<button class="button button-secondary" data-action="add-item">＋ เพิ่มรายการ</button><button class="button" data-action="next-result">ถัดไป →</button></div>${netSummary(net)}</div>`;
  }
  function groupedTransfers() {
    if (!transfers) return [];
    const key = resultView === 'from' ? 'from' : 'to', groups = new Map();
    transfers.forEach(t => { const list = groups.get(t[key]) || []; list.push(t); groups.set(t[key], list); });
    return state.people.filter(person => groups.has(person.id)).map(person => ({ person, list: groups.get(person.id) }));
  }
  function settledPeople(net) { return state.people.filter(person => (net[person.id] || 0) === 0 || !(transfers || []).some(t => t.from === person.id || t.to === person.id)); }
  const transferKey = transfer => `${transfer.from}|${transfer.to}|${transfer.amount}`;
  const availableTransfers = () => (transfers || []).filter(transfer => !state.receiptMatches.some(match => match.transferKey === transferKey(transfer)));
  const receiptEligibleTransfers = () => availableTransfers().filter(transfer => receiptMode !== 'payer' || !receiptPayerId || transfer.from === receiptPayerId);
  const transferLabel = transfer => `${personName(transfer.from)} → ${personName(transfer.to)} (${formatBaht(transfer.amount)} บาท)`;
  function receiptTransferOptions(selectedKey = '') {
    const candidates = receiptEligibleTransfers();
    const selected = selectedKey ? transferForKey(selectedKey) : null;
    if (selected && !candidates.some(transfer => transferKey(transfer) === selectedKey)) candidates.push(selected);
    return `<option value="">เลือกคู่โอน</option>${candidates.map(transfer => { const key = transferKey(transfer); return `<option value="${escapeHtml(key)}" ${key === selectedKey ? 'selected' : ''}>${escapeHtml(transferLabel(transfer))}</option>`; }).join('')}`;
  }
  function receiptPanelHtml() {
    if (!transfers?.length) return '';
    const options = receiptEligibleTransfers();
    const draftHtml = receiptDrafts.map((draft, index) => {
      const statusClass = draft.status === 'matched' ? 'notice-success' : draft.status === 'mismatch' ? 'notice-danger' : 'notice';
      const statusText = draft.status === 'matched' ? 'จับคู่ได้ — ไม่ใช่การยืนยันเงินเข้าจากธนาคาร' : draft.status === 'duplicate' ? 'สลิปภาพนี้เคยถูกใช้แล้ว' : draft.status === 'mismatch' ? 'ยอดไม่ตรงกับรายการที่เลือก' : 'ต้องตรวจสอบก่อนจับคู่';
      const readAmount = draft.parsed.amountSatang;
      return `<article class="receipt-draft"><div class="receipt-draft-head"><strong>สลิป ${index + 1}</strong><span class="receipt-filename">${escapeHtml(draft.fileName)}</span></div><p class="${statusClass} receipt-status">${escapeHtml(draft.message || statusText)}</p><div class="field-grid"><div class="field"><label for="receipt-amount-${index}">ยอดที่อ่านได้ (บาท)</label><input class="input" id="receipt-amount-${index}" inputmode="decimal" data-action="receipt-amount" data-index="${index}" value="${readAmount === null ? '' : (readAmount / 100).toFixed(2)}" placeholder="กรอกยอดจากสลิป"></div><div class="field"><label for="receipt-transfer-${index}">คู่โอนที่ต้องการจับคู่</label><select class="select" id="receipt-transfer-${index}" data-action="receipt-transfer" data-index="${index}" ${draft.status === 'matched' ? 'disabled' : ''}>${receiptTransferOptions(draft.transferKey)}</select></div></div>${draft.parsed.date ? `<p class="receipt-read">วันเวลา: ${escapeHtml(draft.parsed.date)}</p>` : ''}${draft.parsed.sourceName ? `<p class="receipt-read">ชื่อผู้โอนที่อ่านได้: ${escapeHtml(draft.parsed.sourceName)}</p>` : ''}${draft.parsed.targetName ? `<p class="receipt-read">ชื่อผู้รับที่อ่านได้: ${escapeHtml(draft.parsed.targetName)}</p>` : ''}${draft.status === 'matched' ? '' : `<button class="button button-secondary receipt-confirm" data-action="receipt-confirm" data-index="${index}" ${!options.length ? 'disabled' : ''}>จับคู่สลิปนี้</button>`}</article>`;
    }).join('');
    return `<section class="receipt-panel" aria-labelledby="receipt-title"><div class="receipt-heading"><div><h2 id="receipt-title">ตรวจสลิปและจับคู่รายการโอน</h2><p class="help">อ่านภาพในอุปกรณ์นี้ ไม่ส่งภาพหรือข้อความที่อ่านได้ออกไป และผลจับคู่ไม่ยืนยันว่าเงินเข้าบัญชีแล้ว</p></div></div><div class="receipt-controls"><div class="receipt-mode" role="group" aria-label="วิธีเลือกคู่โอน"><button class="${receiptMode === 'target' ? 'active' : ''}" data-action="receipt-mode" data-mode="target">เลือกคู่โอน</button><button class="${receiptMode === 'payer' ? 'active' : ''}" data-action="receipt-mode" data-mode="payer">ฉันคือใคร</button></div>${receiptMode === 'target' ? `<div class="field"><label for="receipt-target">รายการโอน</label><select class="select" id="receipt-target" data-action="receipt-target"><option value="">เลือกผู้โอน → ผู้รับ</option>${options.map(transfer => { const key = transferKey(transfer); return `<option value="${escapeHtml(key)}" ${key === receiptTargetKey ? 'selected' : ''}>${escapeHtml(transferLabel(transfer))}</option>`; }).join('')}</select></div>` : `<div class="field"><label for="receipt-payer">ฉันเป็นผู้โอน</label><select class="select" id="receipt-payer" data-action="receipt-payer"><option value="">เลือกชื่อผู้โอน</option>${state.people.map(person => `<option value="${escapeHtml(person.id)}" ${person.id === receiptPayerId ? 'selected' : ''}>${escapeHtml(person.name)}</option>`).join('')}</select></div>`}<label class="receipt-file"><span>เลือกรูปสลิป</span><input type="file" accept="image/*" multiple data-action="receipt-files"><small>${receiptSelectedFiles.length ? `เลือก ${receiptSelectedFiles.length} รูป` : 'เลือกได้หลายรูปพร้อมกัน'}</small></label><button class="button button-wide" data-action="receipt-scan" ${receiptProcessing || !receiptSelectedFiles.length ? 'disabled' : ''}>${receiptProcessing ? '<span class="spinner"></span> กำลังอ่านสลิป...' : 'อ่านและจับคู่สลิป'}</button></div>${receiptDrafts.length ? `<div class="receipt-drafts"><h3>ผลตรวจ ${receiptDrafts.length} รายการ</h3>${draftHtml}</div>` : ''}<div class="receipt-matches"><h3>จับคู่แล้ว ${state.receiptMatches.length} / ${transfers.length} รายการ</h3>${state.receiptMatches.length ? `<ul>${state.receiptMatches.map(match => { const transfer = transfers.find(item => transferKey(item) === match.transferKey); return transfer ? `<li><span>${escapeHtml(transferLabel(transfer))}</span><button class="button-icon receipt-remove" data-action="receipt-remove" data-key="${escapeHtml(match.transferKey)}" aria-label="นำการจับคู่ ${escapeHtml(transferLabel(transfer))} ออก">×</button></li>` : '' }).join('')}</ul>` : '<p class="help">ยังไม่มีสลิปที่จับคู่</p>'}</div></section>`;
  }
  function resultHtml() {
    const reason = blockReason(), net = currentNet();
    let result = '';
    if (transfers && !loading) {
      if (!transfers.length) result = '<div id="result-card" class="card empty"><h2>ไม่มีใครต้องโอนเงิน 🎉</h2></div>';
      else result = `<div id="result-card" class="card"><div class="result-banner"><p>สรุปผล</p><strong>โอนทั้งหมด ${transfers.length} ครั้ง</strong></div><div class="result-tabs"><button data-action="result-view" data-view="from" class="${resultView === 'from' ? 'active' : ''}">ตามผู้โอน</button><button data-action="result-view" data-view="to" class="${resultView === 'to' ? 'active' : ''}">ตามผู้รับ</button></div><div class="transfer-groups">${groupedTransfers().map(group => `<div class="transfer-group"><h3>${escapeHtml(group.person.name)}</h3>${group.list.map(t => {
        const receiver = state.people.find(p => p.id === t.to);
        const qrBtn = receiver?.promptpay?.trim()
          ? `<button class="button button-small button-secondary" data-action="show-qr" data-to="${t.to}" data-amount="${t.amount}">QR</button>`
          : '';
        return `<div class="transfer-row"><span class="transfer-names">${escapeHtml(personName(t.from))} → ${escapeHtml(personName(t.to))}</span><div class="row"><span class="amount">${formatBaht(t.amount)} บาท</span>${qrBtn}</div></div>`;
      }).join('')}</div>`).join('')}</div>${settledPeople(net).length ? `<p class="settled">เคลียร์แล้ว ไม่ต้องโอน: ${escapeHtml(settledPeople(net).map(p => p.name).join(', '))}</p>` : ''}</div>${!optimal ? '<p class="help" style="text-align:center">ผลลัพธ์อาจไม่ใช่จำนวนโอนน้อยที่สุด</p>' : ''}`;
    }
    const hasResult = Boolean(transfers) && !loading;
    return `<div class="stack"><button class="button button-accent button-wide" data-action="calculate" ${reason || loading ? 'disabled' : ''}>${loading ? '<span class="spinner"></span> กำลังคำนวณ...' : '▣ คำนวณการโอน'}</button>${reason ? `<p class="notice notice-danger">${escapeHtml(reason)}</p>` : ''}${result}${hasResult && transfers.length ? receiptPanelHtml() : ''}<div class="footer-row cols-3">${backButton}<button class="button button-secondary" data-action="copy" ${hasResult ? '' : 'disabled'}>▣ คัดลอกสรุป</button><button class="button button-secondary" data-action="image" ${hasResult ? '' : 'disabled'}>⇩ บันทึกเป็นรูป</button></div></div>`;
  }
  const TAB_ORDER = ['friends', 'input', 'result'];
  function render() { if (!screen) return; screen.innerHTML = (activeTab === 'friends' ? friendsHtml() : activeTab === 'input' ? inputHtml() : resultHtml()); }
  function updateItem(id, patch) { state.items = state.items.map(item => item.id === id ? { ...item, ...patch } : item); commit(); }

  async function fingerprintFile(file) {
    if (!globalThis.crypto?.subtle) throw new Error('อุปกรณ์นี้ไม่รองรับการตรวจสลิปอย่างปลอดภัย');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  async function loadTesseract() {
    if (globalThis.Tesseract?.createWorker) return globalThis.Tesseract;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/tesseract.min.js'; script.onload = resolve; script.onerror = () => reject(new Error('โหลดระบบอ่านภาพไม่สำเร็จ')); document.head.append(script);
    });
    if (!globalThis.Tesseract?.createWorker) throw new Error('โหลดระบบอ่านภาพไม่สำเร็จ');
    return globalThis.Tesseract;
  }
  function transferForKey(key) { return (transfers || []).find(transfer => transferKey(transfer) === key) || null; }
  function selectedTransferFor(draft) {
    if (draft.transferKey) { const selected = transferForKey(draft.transferKey); return selected ? { ...selected, key: transferKey(selected) } : null; }
    if (receiptMode === 'target') { const selected = transferForKey(receiptTargetKey); return selected ? { ...selected, key: transferKey(selected) } : null; }
    const eligible = (transfers || []).map(transfer => ({ ...transfer, key: transferKey(transfer) }));
    return findUniqueTransferMatch(draft.parsed.amountSatang, eligible, state.receiptMatches, receiptPayerId);
  }
  function evaluateReceiptDraft(draft, fingerprint) {
    const amount = draft.parsed.amountSatang, transfer = selectedTransferFor(draft);
    if (!amount) return { ...draft, fingerprint, status: 'review', message: draft.parsed.ambiguousAmount ? 'พบยอดหลายค่า กรุณาตรวจและกรอกยอดที่ถูกต้อง' : 'อ่านยอดไม่ชัด กรุณากรอกยอดจากสลิป' };
    if (!transfer) return { ...draft, fingerprint, status: 'review', message: 'ยังระบุคู่โอนไม่ได้ กรุณาเลือกคู่โอนก่อนจับคู่' };
    const validation = validateReceiptMatch({ amountSatang: amount, transfer, fingerprint, existingMatches: state.receiptMatches });
    return { ...draft, fingerprint, transferKey: transferKey(transfer), status: validation.ok ? 'matched' : validation.reason.includes('ยอด') ? 'mismatch' : 'duplicate', message: validation.ok ? 'จับคู่ได้ — ไม่ใช่การยืนยันเงินเข้าจากธนาคาร' : validation.reason };
  }
  function storeReceiptMatch(draft) {
    const selected = selectedTransferFor(draft), transfer = selected ? { ...selected, key: transferKey(selected) } : null, fingerprint = draft.fingerprint;
    if (!transfer) { draft.status = 'review'; draft.message = 'กรุณาเลือกคู่โอนให้ชัดเจนก่อนจับคู่'; render(); return; }
    const validation = validateReceiptMatch({ amountSatang: draft.parsed.amountSatang, transfer, fingerprint, existingMatches: state.receiptMatches });
    if (!validation.ok) { draft.status = validation.reason.includes('ยอด') ? 'mismatch' : 'duplicate'; draft.message = validation.reason; render(); return; }
    state.receiptMatches.push({ fingerprint, transferKey: transferKey(transfer), amountSatang: draft.parsed.amountSatang, matchedAt: new Date().toISOString() });
    draft.transferKey = transferKey(transfer); draft.status = 'matched'; draft.message = 'จับคู่ได้ — ไม่ใช่การยืนยันเงินเข้าจากธนาคาร';
    save(); render(); toast('จับคู่สลิปกับรายการโอนแล้ว');
  }
  async function scanReceipts() {
    if (!receiptSelectedFiles.length || receiptProcessing) return;
    if (receiptMode === 'target' && !receiptTargetKey) { toast('กรุณาเลือกคู่โอนก่อนอ่านสลิป'); return; }
    if (receiptMode === 'payer' && !receiptPayerId) { toast('กรุณาเลือกชื่อผู้โอนก่อนอ่านสลิป'); return; }
    const files = [...receiptSelectedFiles]; receiptProcessing = true; receiptDrafts = []; render();
    try {
      const tesseract = await loadTesseract();
      receiptWorker = await tesseract.createWorker('tha+eng', 1, { workerPath: 'https://cdn.jsdelivr.net/npm/tesseract.js@6.0.1/dist/worker.min.js', corePath: 'https://cdn.jsdelivr.net/npm/tesseract.js-core@6.0.0', langPath: 'https://tessdata.projectnaptha.com/4.0.0' });
      for (const file of files) {
        const draft = { fileName: file.name, parsed: { amountSatang: null, ambiguousAmount: false, date: '', sourceName: '', targetName: '' }, fingerprint: '', status: 'review', message: 'กำลังอ่านภาพ' };
        receiptDrafts.push(draft); render();
        try {
          const imageUrl = URL.createObjectURL(file);
          let imageResult, fingerprint;
          try { [imageResult, fingerprint] = await Promise.all([receiptWorker.recognize(imageUrl), fingerprintFile(file)]); }
          finally { URL.revokeObjectURL(imageUrl); }
          draft.parsed = parseReceiptText(imageResult.data.text);
          Object.assign(draft, evaluateReceiptDraft(draft, fingerprint));
          if (draft.status === 'matched') {
            const validTransfer = transferForKey(draft.transferKey);
            const result = validTransfer ? validateReceiptMatch({ amountSatang: draft.parsed.amountSatang, transfer: validTransfer, fingerprint: draft.fingerprint, existingMatches: state.receiptMatches }) : { ok: false };
            if (result.ok) state.receiptMatches.push({ fingerprint: draft.fingerprint, transferKey: draft.transferKey, amountSatang: draft.parsed.amountSatang, matchedAt: new Date().toISOString() });
            else { draft.status = 'duplicate'; draft.message = 'สลิปภาพนี้เคยถูกใช้แล้ว'; }
          }
        } catch (error) {
          draft.status = 'review'; draft.message = error instanceof Error ? error.message : 'อ่านภาพนี้ไม่สำเร็จ กรุณาลองอีกครั้ง';
        }
        save(); render();
      }
      if (state.receiptMatches.length) toast('อ่านสลิปเสร็จแล้ว ตรวจผลจับคู่ด้านล่าง');
    } catch {
      toast('เริ่มอ่านสลิปไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่');
    } finally {
      if (receiptWorker) { await receiptWorker.terminate(); receiptWorker = null; }
      receiptProcessing = false; receiptSelectedFiles = []; render();
    }
  }

  screen.addEventListener('input', event => {
    const action = event.target.dataset.action, id = event.target.dataset.id;
    if (action === 'rename') { const person = state.people.find(p => p.id === id); if (person) person.name = event.target.value; resetResult(); save(); }
    if (action === 'promptpay') { const person = state.people.find(p => p.id === id); if (person) person.promptpay = event.target.value; save(); }
    if (action === 'item-name') { const item = state.items.find(i => i.id === id); if (item) item.name = event.target.value; resetResult(); save(); }
    if (action === 'item-price') { const item = state.items.find(i => i.id === id); if (item) item.price = event.target.value; resetResult(); save(); refreshInputSummaries(); }
    if (action === 'direct') { state.direct[id] = event.target.value; resetResult(); save(); refreshInputSummaries(); }
    if (action === 'receipt-amount') { const draft = receiptDrafts[Number(event.target.dataset.index)]; if (draft) { draft.parsed.amountSatang = toSatang(event.target.value); draft.status = 'review'; draft.message = 'กรุณาตรวจยอดและกดจับคู่'; } }
  });
  screen.addEventListener('change', event => {
    const action = event.target.dataset.action;
    if (action === 'item-price') refreshItemIssue(event.target.dataset.id);
    if (action === 'receipt-files') { receiptSelectedFiles = [...(event.target.files || [])].filter(file => file.type.startsWith('image/')); render(); }
    if (action === 'receipt-target') receiptTargetKey = event.target.value;
    if (action === 'receipt-payer') receiptPayerId = event.target.value;
    if (action === 'receipt-transfer') { const draft = receiptDrafts[Number(event.target.dataset.index)]; if (draft) draft.transferKey = event.target.value; }
    if (action === 'item-payer') updateItem(event.target.dataset.id, { payerId: event.target.value || null });
    if (action === 'participant') { const item = state.items.find(i => i.id === event.target.dataset.item); if (!item) return; item.participantIds = event.target.checked ? [...new Set([...item.participantIds, event.target.dataset.person])] : item.participantIds.filter(id => id !== event.target.dataset.person); commit(); }
  });
  screen.addEventListener('click', event => {
    const button = event.target.closest('[data-action]'); if (!button) return;
    const { action, id } = button.dataset;
    if (action === 'add-person') { state.people.push({ id: uid(), name: `เพื่อน ${state.people.length + 1}`, promptpay: '' }); commit(); }
    if (action === 'remove-person') { const person = state.people.find(p => p.id === id); if (!person) return; const remove = () => { state.people = state.people.filter(p => p.id !== id); state.items = state.items.map(item => ({ ...item, payerId: item.payerId === id ? null : item.payerId, participantIds: item.participantIds.filter(pid => pid !== id) })); commit(); }; const used = state.items.some(item => item.payerId === id || item.participantIds.includes(id)); used ? askConfirm(`ลบ “${person.name}” ใช่ไหม?`, 'ชื่อนี้ถูกใช้อยู่ในรายการอาหาร ถ้าลบจะถูกเอาออกจากทุกรายการด้วย', 'ลบเลย', remove) : remove(); }
    if (action === 'back') { const i = TAB_ORDER.indexOf(activeTab); if (i > 0) setTab(TAB_ORDER[i - 1]); }
    if (action === 'next-input') setTab('input'); if (action === 'next-result') setTab('result');
    if (action === 'mode') { state.mode = button.dataset.mode; commit(); }
    if (action === 'add-item') { state.items.push({ id: uid(), name: '', price: '', payerId: state.people[0]?.id || null, participantIds: state.people.map(p => p.id) }); commit(); }
    if (action === 'remove-item') { state.items = state.items.filter(item => item.id !== id); commit(); }
    if (action === 'select-all') updateItem(id, { participantIds: state.people.map(p => p.id) });
    if (action === 'clear-all') updateItem(id, { participantIds: [] });
    if (action === 'result-view') { resultView = button.dataset.view; render(); }
    if (action === 'calculate') calculate(); if (action === 'copy') copySummary(); if (action === 'image') saveImage();if (action==='show-qr') showQr(button.dataset.to, Number(button.dataset.amount));
    if (action === 'receipt-mode') { receiptMode = button.dataset.mode; render(); }
    if (action === 'receipt-scan') scanReceipts();
    if (action === 'receipt-confirm') { const draft = receiptDrafts[Number(button.dataset.index)]; if (draft) storeReceiptMatch(draft); }
    if (action === 'receipt-remove') { state.receiptMatches = state.receiptMatches.filter(match => match.transferKey !== button.dataset.key); save(); render(); toast('นำการจับคู่ออกแล้ว'); }
  });

  function calculate() {
    if (blockReason()) return; loading = true; transfers = null; render();
    const balances = Object.entries(currentNet()).map(([id, amount]) => ({ id, amount }));
    let worker; try { worker = new Worker('./settle-worker.js'); } catch { toast('ไม่สามารถเริ่มการคำนวณได้'); loading = false; render(); return; }
    const finish = result => { worker.terminate(); transfers = result.transfers; optimal = result.optimal; loading = false; render(); };
    worker.onmessage = event => finish(event.data); worker.onerror = () => { worker.terminate(); loading = false; render(); toast('คำนวณไม่สำเร็จ ลองใหม่อีกครั้ง'); }; worker.postMessage(balances);
  }
  function summaryText() {
    if (!transfers?.length) return 'หารเคลียร์: ไม่มีใครต้องโอนเงิน 🎉';
    const lines = [`หารเคลียร์ — โอนทั้งหมด ${transfers.length} ครั้ง`, '', ...transfers.map(t => `${personName(t.from)} → ${personName(t.to)} : ${formatBaht(t.amount)} บาท`)];
    const settled = settledPeople(currentNet()); if (settled.length) lines.push('', `เคลียร์แล้ว ไม่ต้องโอน: ${settled.map(p => p.name).join(', ')}`); return lines.join('\n');
  }
  async function copySummary() { try { await navigator.clipboard.writeText(summaryText()); toast('คัดลอกสรุปแล้ว วางในไลน์ได้เลย'); } catch { toast('คัดลอกไม่สำเร็จ ลองใหม่อีกครั้ง'); } }
  function saveImage() {
    const lines = summaryText().split('\n'), width = 1080, lineHeight = 56, padding = 80, height = Math.max(420, padding * 2 + lines.length * lineHeight);
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height); ctx.fillStyle = '#168b9b'; ctx.fillRect(0, 0, width, 150); ctx.fillStyle = '#ffffff'; ctx.font = '700 52px sans-serif'; ctx.fillText('หารเคลียร์', padding, 95); ctx.fillStyle = '#203d45'; ctx.font = '34px sans-serif'; lines.forEach((line, index) => ctx.fillText(line, padding, 220 + index * lineHeight)); const link = document.createElement('a'); link.download = 'harn-clear.png'; link.href = canvas.toDataURL('image/png'); link.click();
  }
  async function showQr(toId, amountSatang) {
    const receiver = state.people.find(p => p.id === toId);
    if (!receiver?.promptpay) return;
    try {
      const payload = generatePromptPayPayload(receiver.promptpay, amountSatang / 100);
      const qrDialog = document.querySelector('#qr-dialog');
      document.querySelector('#qr-title').textContent = `โอนให้ ${receiver.name}`;
      document.querySelector('#qr-amount').textContent = `${formatBaht(amountSatang)} บาท`;
      await window.QRCode.toCanvas(document.querySelector('#qr-canvas'), payload, { width: 240, margin: 2 });
      qrDialog.showModal();
    } catch (err) {
      toast(err.message || 'สร้าง QR Code ไม่สำเร็จ');
    }
  }
  render();
})();
