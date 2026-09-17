// excel.js — Bidirectional Excel (.xlsx/.csv) import & export using SheetJS

import { db, addTransaction, voucherIdExists, generateVoucherId, logAudit } from './db.js';

const EXPORT_COLUMNS = [
  'voucherId', 'date', 'type', 'paymentMethod', 'category', 'subcategory',
  'amount', 'fees', 'payee', 'glCode', 'description', 'status', 'approvedBy', 'handledBy'
];

const COLUMN_LABELS = {
  voucherId: 'Voucher ID', date: 'Date', type: 'Type', paymentMethod: 'Payment Method',
  category: 'Category', subcategory: 'Subcategory', amount: 'Amount', fees: 'Fees',
  payee: 'Payee / Recipient', glCode: 'GL Account Code', description: 'Description',
  status: 'Status', approvedBy: 'Approved By', handledBy: 'Handled By'
};

function getAccentHexForExcel() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-600').trim() || '#1a73e8';
  return v.replace('#', '').toUpperCase();
}

/**
 * Export an array of transactions to a styled .xlsx workbook with
 * auto-filter, frozen header, and a totals row.
 */
export function exportTransactionsToExcel(transactions, filenamePrefix = 'petty-cash-ledger') {
  const header = EXPORT_COLUMNS.map(c => COLUMN_LABELS[c]);
  const rows = transactions.map(t => EXPORT_COLUMNS.map(c => t[c] ?? ''));

  let totalInflow = 0, totalOutflow = 0;
  for (const t of transactions) {
    if (t.type === 'Inflow') totalInflow += Number(t.amount) || 0;
    else totalOutflow += Number(t.amount) || 0;
  }
  const totalsRow = new Array(EXPORT_COLUMNS.length).fill('');
  totalsRow[0] = 'TOTALS';
  totalsRow[EXPORT_COLUMNS.indexOf('amount')] = totalOutflow > 0 || totalInflow > 0
    ? `Inflows: ${totalInflow.toFixed(2)}  |  Outflows: ${totalOutflow.toFixed(2)}`
    : '';

  const aoa = [header, ...rows, [], totalsRow];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Column widths
  ws['!cols'] = EXPORT_COLUMNS.map(c => ({ wch: c === 'description' ? 32 : 16 }));

  // Auto-filter over the header + data rows
  const lastDataRow = rows.length; // 0-indexed header is row 0
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: lastDataRow, c: EXPORT_COLUMNS.length - 1 } }) };

  // Freeze header row
  ws['!freeze'] = { xSplit: 0, ySplit: 1 };
  ws['!pane'] = { ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };

  // Bold header cells (style hints — full styling requires xlsx-style/pro; SheetJS community
  // applies cell comments/format via 'z' and 's' where supported by the reading application)
  for (let c = 0; c < header.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: 0, c });
    if (ws[cellRef]) {
      ws[cellRef].s = {
        font: { bold: true, color: { rgb: 'FFFFFF' } },
        fill: { fgColor: { rgb: getAccentHexForExcel() } }
      };
    }
  }
  // Bold totals row
  const totalsRowIndex = aoa.length - 1;
  for (let c = 0; c < header.length; c++) {
    const cellRef = XLSX.utils.encode_cell({ r: totalsRowIndex, c });
    if (ws[cellRef]) ws[cellRef].s = { font: { bold: true } };
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Ledger');

  const stamp = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `${filenamePrefix}-${stamp}.xlsx`, { cellStyles: true });
}

/**
 * Export with an arbitrary filter applied first (date range, category, payee, method).
 */
export function exportFilteredTransactions(transactions, filters) {
  let filtered = [...transactions];
  if (filters.startDate) filtered = filtered.filter(t => t.date >= filters.startDate);
  if (filters.endDate) filtered = filtered.filter(t => t.date <= filters.endDate);
  if (filters.category) filtered = filtered.filter(t => t.category === filters.category);
  if (filters.payee) filtered = filtered.filter(t => (t.payee || '').toLowerCase().includes(filters.payee.toLowerCase()));
  if (filters.paymentMethod) filtered = filtered.filter(t => t.paymentMethod === filters.paymentMethod);
  exportTransactionsToExcel(filtered, 'petty-cash-filtered');
  return filtered.length;
}

/**
 * Parse an uploaded Excel/CSV File into an array of plain row objects
 * keyed by the raw column header text (for the user to map).
 */
export function parseWorkbookFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: 'array', cellDates: true });
        const sheetName = wb.SheetNames[0];
        const sheet = wb.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: '', raw: false });
        if (json.length === 0) return resolve({ headers: [], rows: [] });
        const headers = Object.keys(json[0]);
        resolve({ headers, rows: json });
      } catch (err) {
        reject(err);
      }
    };
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Given parsed rows and a column mapping { targetField: sourceHeader },
 * validate and import transactions. Skips duplicates by Voucher ID.
 * Returns a report of { imported, skippedDuplicates, errors: [{row, reason}] }.
 */
export async function importMappedTransactions(rows, mapping, settings) {
  const report = { imported: 0, skippedDuplicates: 0, errors: [] };

  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    try {
      const dateVal = raw[mapping.date];
      const amountVal = parseFloat(raw[mapping.amount]);
      if (!dateVal || isNaN(amountVal)) {
        report.errors.push({ row: i + 2, reason: 'Missing or invalid date/amount' });
        continue;
      }

      let voucherId = mapping.voucherId ? String(raw[mapping.voucherId] || '').trim() : '';
      if (!voucherId) {
        voucherId = await generateVoucherId('Outflow');
      } else if (await voucherIdExists(voucherId)) {
        report.skippedDuplicates++;
        continue;
      }

      const isoDate = new Date(dateVal).toISOString();
      const category = mapping.category ? String(raw[mapping.category] || 'Miscellaneous') : 'Miscellaneous';

      const tx = {
        voucherId,
        date: isoDate,
        type: mapping.type ? (String(raw[mapping.type] || 'Outflow')) : 'Outflow',
        paymentMethod: mapping.paymentMethod ? String(raw[mapping.paymentMethod] || 'Physical Cash') : 'Physical Cash',
        category,
        subcategory: mapping.subcategory ? String(raw[mapping.subcategory] || '') : '',
        amount: amountVal,
        fees: mapping.fees ? (parseFloat(raw[mapping.fees]) || 0) : 0,
        payee: mapping.payee ? String(raw[mapping.payee] || '') : '',
        glCode: mapping.glCode ? String(raw[mapping.glCode] || (settings.glAccountMap?.[category] || '')) : (settings.glAccountMap?.[category] || ''),
        description: mapping.description ? String(raw[mapping.description] || '') : '',
        status: 'Completed',
        approvedBy: '',
        handledBy: settings.custodianName || '',
        receiptImage: null,
        importedFromExcel: true
      };

      await addTransaction(tx);
      report.imported++;
    } catch (err) {
      report.errors.push({ row: i + 2, reason: err.message });
    }
  }

  await logAudit('import', 'excel', { imported: report.imported, skipped: report.skippedDuplicates, errors: report.errors.length });
  return report;
}

/**
 * Generate a printable HTML voucher for a single transaction and open it
 * in a new window ready for the browser's native Print-to-PDF.
 */
export function printVoucher(tx, settings) {
  const win = window.open('', '_blank', 'width=800,height=900');
  const accent = (getComputedStyle(document.documentElement).getPropertyValue('--accent-600') || '#1a73e8').trim() || '#1a73e8';
  const amountFmt = Number(tx.amount).toLocaleString(undefined, { minimumFractionDigits: 2 });
  const feesFmt = Number(tx.fees || 0).toLocaleString(undefined, { minimumFractionDigits: 2 });
  win.document.write(`
    <!DOCTYPE html><html><head><title>Voucher ${tx.voucherId}</title>
    <style>
      body { font-family: 'Segoe UI', Arial, sans-serif; padding: 40px; color: #1e293b; }
      .voucher { max-width: 640px; margin: 0 auto; border: 2px solid ${accent}; border-radius: 16px; padding: 32px; }
      h1 { color: ${accent}; font-size: 20px; margin: 0 0 4px; }
      .sub { color: #64748b; font-size: 13px; margin-bottom: 24px; }
      table { width: 100%; border-collapse: collapse; }
      td { padding: 8px 4px; border-bottom: 1px solid #e2e8f0; font-size: 14px; }
      td.label { color: #64748b; width: 40%; }
      .amount { font-size: 24px; font-weight: bold; color: ${accent}; margin-top: 20px; }
      .sign { display: flex; justify-content: space-between; margin-top: 60px; }
      .sign div { border-top: 1px solid #94a3b8; width: 40%; text-align: center; padding-top: 6px; font-size: 12px; color: #64748b; }
      @media print { body { padding: 0; } }
    </style></head><body>
    <div class="voucher">
      <h1>${settings.orgName || 'Petty Cash Fund'} — Payment Voucher</h1>
      <div class="sub">Voucher ${tx.voucherId}</div>
      <table>
        <tr><td class="label">Date</td><td>${new Date(tx.date).toLocaleString()}</td></tr>
        <tr><td class="label">Type</td><td>${tx.type}</td></tr>
        <tr><td class="label">Payment Method</td><td>${tx.paymentMethod}</td></tr>
        <tr><td class="label">Category</td><td>${tx.category}${tx.subcategory ? ' / ' + tx.subcategory : ''}</td></tr>
        <tr><td class="label">Payee / Recipient</td><td>${tx.payee || '—'}</td></tr>
        <tr><td class="label">GL Account Code</td><td>${tx.glCode || '—'}</td></tr>
        <tr><td class="label">Description</td><td>${tx.description || '—'}</td></tr>
        <tr><td class="label">Fees</td><td>${feesFmt}</td></tr>
        <tr><td class="label">Status</td><td>${tx.status}</td></tr>
        <tr><td class="label">Handled By</td><td>${tx.handledBy || '—'}</td></tr>
        <tr><td class="label">Approved By</td><td>${tx.approvedBy || '—'}</td></tr>
      </table>
      <div class="amount">Amount: ${settings.currency} ${amountFmt}</div>
      <div class="sign">
        <div>Handled By Signature</div>
        <div>Approved By Signature</div>
      </div>
    </div>
    <script>window.onload = () => window.print();</script>
    </body></html>
  `);
  win.document.close();
}
