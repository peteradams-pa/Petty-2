// db.js — IndexedDB schema (Dexie) and data-access helpers for the Petty Cash PWA

export const db = new Dexie('PettyCashDB');

db.version(1).stores({
  // ++id = autoincrement primary key. Other listed fields are indexed for fast queries.
  transactions: '++id, voucherId, date, type, category, payee, paymentMethod, status, createdAt',
  settings: 'key',
  custodyLog: '++id, date',
  auditTrail: '++id, timestamp, entity, action',
  denominationCounts: '++id, date'
});

// ---------- Defaults ----------
const DEFAULT_SETTINGS = {
  currency: 'KES',
  orgName: 'Petty Cash Fund',
  custodianName: '',
  floatMinThreshold: 2000,
  spendCapAmount: 5000,
  spendCapMode: 'soft', // 'soft' | 'hard'
  frequencyWindowMinutes: 60,
  frequencyThresholdCount: 3,
  darkMode: false,
  accentColor: 'google-blue',
  pinLock: '',
  encryptionEnabled: false,
  categories: [
    { name: 'Office Supplies', subcategories: ['Stationery', 'Printing', 'Cleaning'] },
    { name: 'Transport', subcategories: ['Fuel', 'Fare', 'Parking'] },
    { name: 'Meals & Hospitality', subcategories: ['Client Meetings', 'Staff Meals'] },
    { name: 'Utilities', subcategories: ['Airtime', 'Data', 'Electricity Tokens'] },
    { name: 'Maintenance', subcategories: ['Repairs', 'Equipment'] },
    { name: 'Staff Welfare', subcategories: ['Advance', 'Medical', 'Other'] },
    { name: 'Miscellaneous', subcategories: ['Other'] }
  ],
  glAccountMap: {
    'Office Supplies': '5010',
    'Transport': '5020',
    'Meals & Hospitality': '5030',
    'Utilities': '5040',
    'Maintenance': '5050',
    'Staff Welfare': '5060',
    'Miscellaneous': '5090'
  }
};

// ---------- Settings ----------
export async function getSettings() {
  const rows = await db.settings.toArray();
  const merged = { ...DEFAULT_SETTINGS };
  for (const row of rows) merged[row.key] = row.value;
  return merged;
}

export async function setSetting(key, value) {
  await db.settings.put({ key, value });
  await logAudit('settings', 'update', { key });
}

export async function initDefaultSettings() {
  const existing = await db.settings.toArray();
  if (existing.length === 0) {
    const entries = Object.entries(DEFAULT_SETTINGS).map(([key, value]) => ({ key, value }));
    await db.settings.bulkPut(entries);
  }
}

// ---------- Audit Trail (autonomous addition) ----------
export async function logAudit(entity, action, details = {}) {
  await db.auditTrail.add({
    timestamp: new Date().toISOString(),
    entity,
    action,
    details: JSON.stringify(details)
  });
}

// ---------- Voucher ID generation ----------
export async function generateVoucherId(type) {
  const now = new Date();
  const yyyymm = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prefix = `PC-${yyyymm}-`;
  const monthTx = await db.transactions
    .where('voucherId')
    .startsWith(prefix)
    .toArray();
  // Use the highest existing sequence number + 1, not the row count — counting
  // rows breaks (produces a duplicate voucher ID) as soon as any transaction
  // in the month has been deleted.
  let maxSeq = 0;
  for (const t of monthTx) {
    const seq = parseInt(String(t.voucherId).slice(prefix.length), 10);
    if (!isNaN(seq) && seq > maxSeq) maxSeq = seq;
  }
  return `${prefix}${String(maxSeq + 1).padStart(4, '0')}`;
}

// ---------- Transactions ----------
export async function addTransaction(tx) {
  tx.createdAt = new Date().toISOString();
  const id = await db.transactions.add(tx);
  await logAudit('transaction', 'create', { voucherId: tx.voucherId, amount: tx.amount });
  return id;
}

export async function updateTransaction(id, changes) {
  await db.transactions.update(id, changes);
  await logAudit('transaction', 'update', { id, changes: Object.keys(changes) });
}

export async function deleteTransaction(id) {
  const tx = await db.transactions.get(id);
  await db.transactions.delete(id);
  await logAudit('transaction', 'delete', { voucherId: tx?.voucherId });
}

export async function getAllTransactions() {
  return db.transactions.orderBy('date').reverse().toArray();
}

export async function getTransactionsInRange(startISO, endISO) {
  return db.transactions
    .filter(t => t.date >= startISO && t.date <= endISO)
    .toArray();
}

// ---------- Balance calculations ----------
export async function computeBalances() {
  const txs = await db.transactions.toArray();
  let cash = 0, mobileMoney = 0, bank = 0;
  for (const t of txs) {
    // Every logged transaction represents cash that has actually moved —
    // status only tracks documentation follow-up (receipt pending, IOU
    // overdue) and must never exclude a transaction from the float total,
    // or the reconciliation balance silently drifts from reality.
    const signedAmount = t.type === 'Inflow' ? (t.amount - (t.fees || 0)) : -(t.amount + (t.fees || 0));
    if (t.paymentMethod === 'Physical Cash') cash += signedAmount;
    else if (t.paymentMethod === 'Mobile Money / M-Pesa') mobileMoney += signedAmount;
    else if (t.paymentMethod === 'Bank Transfer') bank += signedAmount;
  }
  return { cash, mobileMoney, bank, total: cash + mobileMoney + bank };
}

// ---------- Custody Log ----------
export async function addCustodyLogEntry(entry) {
  entry.date = entry.date || new Date().toISOString();
  const id = await db.custodyLog.add(entry);
  await logAudit('custody', 'handover', { from: entry.fromCustodian, to: entry.toCustodian });
  return id;
}

export async function getCustodyLog() {
  return db.custodyLog.orderBy('date').reverse().toArray();
}

// ---------- Denomination counts ----------
export async function saveDenominationCount(record) {
  record.date = record.date || new Date().toISOString();
  const id = await db.denominationCounts.add(record);
  await logAudit('reconciliation', 'count', { total: record.total, variance: record.variance });
  return id;
}

export async function getLatestDenominationCount() {
  return db.denominationCounts.orderBy('date').last();
}

// ---------- Full backup / restore ----------
export async function exportFullBackup() {
  const [transactions, settings, custodyLog, auditTrail, denominationCounts] = await Promise.all([
    db.transactions.toArray(),
    db.settings.toArray(),
    db.custodyLog.toArray(),
    db.auditTrail.toArray(),
    db.denominationCounts.toArray()
  ]);
  return {
    meta: { app: 'Petty Cash PWA', version: 1, exportedAt: new Date().toISOString() },
    transactions, settings, custodyLog, auditTrail, denominationCounts
  };
}

export async function restoreFullBackup(payload) {
  await db.transaction('rw', db.transactions, db.settings, db.custodyLog, db.auditTrail, db.denominationCounts, async () => {
    await db.transactions.clear();
    await db.settings.clear();
    await db.custodyLog.clear();
    await db.auditTrail.clear();
    await db.denominationCounts.clear();
    if (payload.transactions) await db.transactions.bulkAdd(payload.transactions);
    if (payload.settings) await db.settings.bulkAdd(payload.settings);
    if (payload.custodyLog) await db.custodyLog.bulkAdd(payload.custodyLog);
    if (payload.auditTrail) await db.auditTrail.bulkAdd(payload.auditTrail);
    if (payload.denominationCounts) await db.denominationCounts.bulkAdd(payload.denominationCounts);
  });
  await logAudit('database', 'restore', { source: 'backup-file' });
}

// ---------- Data repair ----------
// Backfills the `date` field on any transaction that's missing it. This
// matters because Dexie's indexes silently exclude a record from
// orderBy('date') queries when the indexed field is undefined — so any
// transaction saved before the transaction form had a Date field (an
// earlier bug) is otherwise invisible in the Ledger and Dashboard forever,
// even though it's still sitting in the database and counted in balances.
export async function repairMissingDates() {
  const all = await db.transactions.toArray();
  const broken = all.filter(t => !t.date);
  if (broken.length === 0) return 0;
  await db.transactions.bulkPut(
    broken.map(t => ({ ...t, date: t.createdAt || new Date().toISOString() }))
  );
  await logAudit('database', 'repair-missing-dates', { count: broken.length });
  return broken.length;
}

// ---------- Duplicate / frequency checks ----------
export async function voucherIdExists(voucherId) {
  const match = await db.transactions.where('voucherId').equals(voucherId).first();
  return !!match;
}

export async function findRecentPayeePayouts(payee, windowMinutes) {
  const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();
  return db.transactions
    .where('payee').equals(payee)
    .and(t => t.createdAt >= cutoff)
    .toArray();
}
