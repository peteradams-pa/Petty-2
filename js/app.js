// app.js — Main SPA controller for the Petty Cash PWA

import {
  db, getSettings, setSetting, initDefaultSettings, generateVoucherId,
  addTransaction, updateTransaction, deleteTransaction, getAllTransactions,
  computeBalances, addCustodyLogEntry, getCustodyLog, saveDenominationCount,
  getLatestDenominationCount, exportFullBackup, restoreFullBackup, voucherIdExists,
  findRecentPayeePayouts, logAudit, repairMissingDates
} from './db.js';
import { exportTransactionsToExcel, exportFilteredTransactions, parseWorkbookFile, importMappedTransactions, printVoucher } from './excel.js';
import { renderCategoryBreakdown, renderDailyVelocity, renderPaymentChannelDistribution, destroyAllCharts } from './charts.js';
import { encryptBlob, decryptBlob, deriveKeyFromPin, hasCryptoKey, clearCryptoKey } from './crypto-helper.js';

// ---------------- Global state ----------------
const state = {
  settings: null,
  transactions: [],
  currentView: 'dashboard',
  editingId: null,
  parsedImport: null,
  ledgerFilters: { search: '', type: '', category: '', status: '' }
};

const app = document.getElementById('app');
const toastHost = document.getElementById('toast-host');

// ---------------- Accent color themes ----------------
const ACCENT_THEMES = {
  'google-blue': { label: 'Google Blue', swatch: '#1a73e8', 50: '#e8f0fe', 300: '#8ab4f8', 400: '#669df6', 600: '#1a73e8', 700: '#1967d2', soft: 'rgba(66,133,244,0.12)' },
  'indigo': { label: 'Indigo', swatch: '#4f46e5', 50: '#eef2ff', 300: '#a5b4fc', 400: '#818cf8', 600: '#4f46e5', 700: '#4338ca', soft: 'rgba(99,102,241,0.12)' },
  'emerald': { label: 'Emerald', swatch: '#059669', 50: '#ecfdf5', 300: '#6ee7b7', 400: '#34d399', 600: '#059669', 700: '#047857', soft: 'rgba(16,185,129,0.12)' },
  'amber': { label: 'Amber', swatch: '#d97706', 50: '#fffbeb', 300: '#fcd34d', 400: '#fbbf24', 600: '#d97706', 700: '#b45309', soft: 'rgba(245,158,11,0.14)' },
  'rose': { label: 'Rose', swatch: '#e11d48', 50: '#fff1f2', 300: '#fda4af', 400: '#fb7185', 600: '#e11d48', 700: '#be123c', soft: 'rgba(244,63,94,0.12)' },
  'violet': { label: 'Violet', swatch: '#7c3aed', 50: '#f5f3ff', 300: '#c4b5fd', 400: '#a78bfa', 600: '#7c3aed', 700: '#6d28d9', soft: 'rgba(139,92,246,0.12)' },
  'teal': { label: 'Teal', swatch: '#0d9488', 50: '#f0fdfa', 300: '#5eead4', 400: '#2dd4bf', 600: '#0d9488', 700: '#0f766e', soft: 'rgba(20,184,166,0.12)' },
  'slate': { label: 'Slate', swatch: '#334155', 50: '#f8fafc', 300: '#94a3b8', 400: '#64748b', 600: '#334155', 700: '#1e293b', soft: 'rgba(71,85,105,0.14)' }
};

function applyAccentColor(themeId) {
  const theme = ACCENT_THEMES[themeId] || ACCENT_THEMES['google-blue'];
  const root = document.documentElement.style;
  root.setProperty('--accent-50', theme[50]);
  root.setProperty('--accent-300', theme[300]);
  root.setProperty('--accent-400', theme[400]);
  root.setProperty('--accent-600', theme[600]);
  root.setProperty('--accent-700', theme[700]);
  root.setProperty('--accent-soft-dark', theme.soft);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme[600]);
}

// ---------------- Boot ----------------
async function boot() {
  await initDefaultSettings();
  const repaired = await repairMissingDates();
  state.settings = await getSettings();
  applyDarkMode(state.settings.darkMode);
  applyAccentColor(state.settings.accentColor);
  state.transactions = await getAllTransactions();

  if (state.settings.pinLock) {
    renderLockScreen();
  } else {
    renderShell();
    navigate('dashboard');
  }
  if (repaired > 0) {
    setTimeout(() => showToast(`Recovered ${repaired} transaction${repaired > 1 ? 's' : ''} that were missing from the Ledger.`), 600);
  }

  registerServiceWorker();
  window.addEventListener('keydown', handleShortcuts);
}

// ---------------- Lock screen (autonomous: PIN lock) ----------------
function renderLockScreen() {
  app.innerHTML = `
    <div class="min-h-screen flex items-center justify-center px-4">
      <div class="w-full max-w-sm card p-8 text-center view-fade">
        <div class="w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-white text-2xl mb-5 shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">🔒</div>
        <h1 class="text-xl font-bold text-slate-800 dark:text-slate-100 mb-1 font-display">Welcome back</h1>
        <p class="text-sm text-slate-500 dark:text-slate-400 mb-6">Enter your PIN to open the ledger.</p>
        <input id="pin-input" type="password" inputmode="numeric" maxlength="8"
          class="w-full text-center text-2xl tracking-[0.5em] input-field py-3 mb-4" placeholder="••••" />
        <p id="pin-error" class="text-sm text-red-500 h-5 mb-2"></p>
        <button id="pin-submit" class="tap w-full text-white rounded-2xl py-3 font-semibold transition shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Unlock</button>
      </div>
    </div>`;
  const input = document.getElementById('pin-input');
  input.focus();
  const tryUnlock = async () => {
    if (input.value === state.settings.pinLock) {
      await deriveKeyFromPin(input.value);
      renderShell();
      navigate('dashboard');
    } else {
      document.getElementById('pin-error').textContent = 'Incorrect PIN. Try again.';
      input.value = '';
    }
  };
  document.getElementById('pin-submit').addEventListener('click', tryUnlock);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryUnlock(); });
}

// ---------------- Shell (nav + layout) ----------------
const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: '📊' },
  { id: 'ledger', label: 'Ledger', icon: '📒' },
  { id: 'reconcile', label: 'Reconcile', icon: '🧮' },
  { id: 'reports', label: 'Reports', icon: '📤' },
  { id: 'settings', label: 'Settings', icon: '⚙️' }
];

function renderShell() {
  app.innerHTML = `
    <div class="min-h-screen flex transition-colors">
      <!-- Desktop sidebar -->
      <aside class="hidden md:flex md:flex-col w-64 shrink-0 bg-white/70 dark:bg-slate-800/50 backdrop-blur-xl border-r border-slate-200/70 dark:border-slate-700/70 p-5">
        <div class="flex items-center gap-3 mb-8 px-1">
          <div class="w-11 h-11 rounded-2xl flex items-center justify-center text-white font-bold text-lg shadow-md" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">₵</div>
          <div class="min-w-0">
            <div class="font-semibold text-slate-800 dark:text-slate-100 leading-tight truncate font-display" id="org-name-label">${escapeHtml(state.settings.orgName)}</div>
            <div class="text-xs text-slate-400">Petty Cash Manager</div>
          </div>
        </div>
        <nav class="flex-1 space-y-1" id="sidebar-nav"></nav>
        <button id="dark-toggle-desktop" class="tap mt-4 flex items-center gap-2 text-sm text-slate-500 dark:text-slate-300 hover:text-[var(--accent-600)] rounded-xl px-3 py-2.5 transition hover:bg-[var(--accent-50)] dark:hover:bg-white/5">
          <span id="dark-toggle-icon">${state.settings.darkMode ? '☀️' : '🌙'}</span> Toggle theme
        </button>
      </aside>

      <div class="flex-1 flex flex-col min-w-0">
        <!-- Top bar -->
        <header class="sticky top-0 z-20 bg-white/80 dark:bg-slate-900/70 backdrop-blur-xl border-b border-slate-200/70 dark:border-slate-700/70 px-4 md:px-8 py-3.5 flex items-center justify-between">
          <h1 id="view-title" class="text-lg md:text-xl font-bold text-slate-800 dark:text-slate-100 font-display">Dashboard</h1>
          <div class="flex items-center gap-2">
            <span id="float-pill" class="hidden sm:inline-flex items-center text-xs font-semibold px-3.5 py-1.5 rounded-full bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)] text-[var(--accent-700)] dark:text-[var(--accent-300)]"></span>
            <button id="dark-toggle-mobile" class="tap md:hidden w-9 h-9 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-300 bg-slate-100 dark:bg-slate-800">🌙</button>
          </div>
        </header>

        <main id="view-container" class="flex-1 overflow-y-auto px-4 md:px-8 py-6 pb-28 md:pb-6"></main>
      </div>

      <!-- Bottom nav (mobile) -->
      <nav class="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white/90 dark:bg-slate-800/90 backdrop-blur-xl border-t border-slate-200/70 dark:border-slate-700/70 flex justify-around py-2 shadow-[0_-4px_16px_rgba(15,23,42,0.06)]" id="bottom-nav"></nav>

      <!-- FAB -->
      <button id="fab-add" title="New transaction (N)"
        class="tap fixed z-40 bottom-20 md:bottom-8 right-5 md:right-8 w-14 h-14 rounded-2xl text-white text-2xl font-light flex items-center justify-center transition hover:scale-105"
        style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700)); box-shadow: 0 10px 25px -6px var(--accent-600);">+</button>
    </div>
    <div id="modal-root"></div>
  `;

  renderNav('sidebar-nav', true);
  renderNav('bottom-nav', false);
  updateFloatPill();

  document.getElementById('fab-add').addEventListener('click', () => openTransactionModal());
  document.getElementById('dark-toggle-desktop').addEventListener('click', toggleDarkMode);
  document.getElementById('dark-toggle-mobile').addEventListener('click', toggleDarkMode);
}

function renderNav(containerId, isSidebar) {
  const container = document.getElementById(containerId);
  container.innerHTML = NAV_ITEMS.map(item => {
    const active = state.currentView === item.id;
    if (isSidebar) {
      return `
        <button data-view="${item.id}" class="nav-btn tap w-full flex items-center gap-3 px-3 py-2.5 rounded-2xl text-sm font-medium transition ${
          active
            ? 'bg-[var(--accent-600)] text-white shadow-md'
            : 'text-slate-500 dark:text-slate-300 hover:bg-[var(--accent-50)] dark:hover:bg-white/5'
        }">
          <span class="text-base">${item.icon}</span>
          <span>${item.label}</span>
        </button>`;
    }
    return `
      <button data-view="${item.id}" class="nav-btn tap flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-2xl text-[11px] font-medium transition ${
        active ? 'text-[var(--accent-600)]' : 'text-slate-400 dark:text-slate-400'
      }">
        <span class="w-9 h-7 rounded-full flex items-center justify-center text-lg transition ${active ? 'bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)]' : ''}">${item.icon}</span>
        <span>${item.label}</span>
      </button>`;
  }).join('');
  container.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigate(btn.dataset.view));
  });
}

async function updateFloatPill() {
  const balances = await computeBalances();
  const pill = document.getElementById('float-pill');
  if (!pill) return;
  const low = balances.total < state.settings.floatMinThreshold;
  pill.textContent = `Float: ${state.settings.currency} ${balances.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}${low ? ' ⚠ Low' : ''}`;
  pill.className = `hidden sm:inline-flex items-center text-xs font-medium px-3 py-1.5 rounded-full ${low ? 'bg-red-50 dark:bg-red-500/10 text-red-600 dark:text-red-300' : 'bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)] text-[var(--accent-700)] dark:text-[var(--accent-300)]'}`;
}

// ---------------- Router ----------------
async function navigate(view) {
  state.currentView = view;
  renderNav('sidebar-nav', true);
  renderNav('bottom-nav', false);
  document.getElementById('view-title').textContent = NAV_ITEMS.find(n => n.id === view)?.label || '';
  state.transactions = await getAllTransactions();
  updateFloatPill();

  const container = document.getElementById('view-container');
  destroyAllCharts();

  switch (view) {
    case 'dashboard': return renderDashboard(container);
    case 'ledger': return renderLedger(container);
    case 'reconcile': return renderReconcile(container);
    case 'reports': return renderReports(container);
    case 'settings': return renderSettings(container);
  }
}

// ================= DASHBOARD =================
async function renderDashboard(container) {
  const balances = await computeBalances();
  const now = new Date();
  const monthPrefix = now.toISOString().slice(0, 7);
  const monthTx = state.transactions.filter(t => t.date.startsWith(monthPrefix));
  const monthSpend = monthTx.filter(t => t.type !== 'Inflow').reduce((s, t) => s + Number(t.amount), 0);
  const pendingReceipts = state.transactions.filter(t => t.status === 'Pending Receipt').length;
  const latestCount = await getLatestDenominationCount();
  const variance = latestCount ? (latestCount.total - balances.cash) : null;

  const overdueIOUs = state.transactions.filter(t => t.type === 'Advance IOU' && t.status === 'Overdue IOU');

  container.innerHTML = `
    <div class="view-fade">
    <div class="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
      ${kpiCard('Current Balance', fmt(balances.total), '💰', balances.total < state.settings.floatMinThreshold ? 'warn' : 'ok')}
      ${kpiCard('Monthly Spend', fmt(monthSpend), '📉', 'neutral')}
      ${kpiCard('Pending Receipts', pendingReceipts, '🧾', pendingReceipts > 0 ? 'warn' : 'ok')}
      ${kpiCard('Net Variance', variance === null ? '—' : fmt(variance), '⚖️', variance && Math.abs(variance) > 0.5 ? 'warn' : 'ok')}
    </div>

    ${overdueIOUs.length > 0 ? `
    <div class="mb-6 rounded-3xl bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 p-4 flex items-start gap-3">
      <span class="icon-badge bg-amber-100 dark:bg-amber-500/20 text-base">⏰</span>
      <div class="text-sm text-amber-800 dark:text-amber-200 pt-1.5">
        <strong>${overdueIOUs.length} overdue IOU${overdueIOUs.length > 1 ? 's' : ''}</strong> need follow-up: ${overdueIOUs.slice(0, 3).map(t => escapeHtml(t.payee || t.voucherId)).join(', ')}${overdueIOUs.length > 3 ? '…' : ''}
      </div>
    </div>` : ''}

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      <div class="lg:col-span-2 card p-5">
        ${sectionHeader('📈', 'Daily Spend Velocity (30 days)')}
        <div class="h-56"><canvas id="chart-velocity"></canvas></div>
      </div>
      <div class="card p-5">
        ${sectionHeader('🥧', 'Category Breakdown')}
        <div class="h-56"><canvas id="chart-category"></canvas></div>
      </div>
    </div>

    <div class="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
      <div class="card p-5">
        ${sectionHeader('💳', 'Payment Channel Distribution')}
        <div class="h-48"><canvas id="chart-channel"></canvas></div>
      </div>
      <div class="lg:col-span-2 card p-5">
        ${sectionHeader('🕒', 'Recent Transactions')}
        <div class="divide-y divide-slate-100 dark:divide-slate-700">
          ${state.transactions.slice(0, 6).map(t => recentRow(t)).join('') || emptyState('No transactions yet.', '🧾')}
        </div>
      </div>
    </div>
    </div>
  `;

  renderDailyVelocity('chart-velocity', state.transactions);
  renderCategoryBreakdown('chart-category', state.transactions);
  renderPaymentChannelDistribution('chart-channel', state.transactions);
}

function kpiCard(label, value, icon, tone) {
  const toneStyles = {
    ok: { text: 'text-emerald-600 dark:text-emerald-400', badge: 'bg-emerald-50 dark:bg-emerald-500/10' },
    warn: { text: 'text-red-600 dark:text-red-400', badge: 'bg-red-50 dark:bg-red-500/10' },
    neutral: { text: 'text-slate-700 dark:text-slate-200', badge: 'bg-slate-100 dark:bg-white/5' }
  };
  const style = toneStyles[tone];
  return `
    <div class="card card-interactive p-4 md:p-5">
      <div class="flex items-center justify-between mb-3">
        <span class="icon-badge ${style.badge}">${icon}</span>
        ${tone === 'warn' ? '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>' : ''}
      </div>
      <div class="text-xs font-medium text-slate-400 mb-1">${label}</div>
      <div class="text-lg md:text-2xl font-bold font-display ${style.text}">${typeof value === 'number' ? value : value}</div>
    </div>`;
}

function recentRow(t) {
  const typeIcon = t.type === 'Inflow' ? '↓' : t.type === 'Advance IOU' ? '↗' : '↑';
  const typeColor = t.type === 'Inflow' ? 'bg-emerald-50 dark:bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-slate-100 dark:bg-white/5 text-slate-500 dark:text-slate-300';
  return `
    <div class="flex items-center gap-3 py-3 text-sm">
      <span class="icon-badge w-9 h-9 text-sm ${typeColor}">${typeIcon}</span>
      <div class="min-w-0 flex-1">
        <div class="font-medium text-slate-700 dark:text-slate-200 truncate">${escapeHtml(t.payee || t.category)}</div>
        <div class="text-xs text-slate-400">${t.voucherId} · ${new Date(t.date).toLocaleDateString()}</div>
      </div>
      <div class="font-semibold ${t.type === 'Inflow' ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-200'}">${t.type === 'Inflow' ? '+' : '-'}${fmt(t.amount)}</div>
    </div>`;
}

function sectionHeader(icon, title) {
  return `<h3 class="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-4 flex items-center gap-2"><span>${icon}</span>${title}</h3>`;
}

// ================= LEDGER =================
function renderLedger(container) {
  const f = state.ledgerFilters;
  container.innerHTML = `
    <div class="view-fade">
    <div class="card p-4 mb-4 flex flex-wrap gap-2 items-center">
      <input id="filter-search" placeholder="Search payee, voucher, description…" value="${escapeHtml(f.search)}"
        class="flex-1 min-w-[180px] input-field px-3 py-2 text-sm" />
      <select id="filter-type" class="input-field px-3 py-2 text-sm">
        <option value="">All Types</option>
        ${['Inflow', 'Outflow', 'Advance IOU'].map(v => `<option ${f.type === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
      <select id="filter-category" class="input-field px-3 py-2 text-sm">
        <option value="">All Categories</option>
        ${state.settings.categories.map(c => `<option ${f.category === c.name ? 'selected' : ''}>${c.name}</option>`).join('')}
      </select>
      <select id="filter-status" class="input-field px-3 py-2 text-sm">
        <option value="">All Statuses</option>
        ${['Completed', 'Pending Receipt', 'Overdue IOU'].map(v => `<option ${f.status === v ? 'selected' : ''}>${v}</option>`).join('')}
      </select>
    </div>

    <!-- Mobile: card list -->
    <div id="ledger-cards" class="md:hidden space-y-3"></div>

    <!-- Desktop: table -->
    <div class="hidden md:block card overflow-hidden">
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead class="bg-slate-50 dark:bg-slate-900/40 text-slate-500 dark:text-slate-400 text-xs uppercase">
            <tr>
              <th class="text-left px-4 py-3">Voucher</th>
              <th class="text-left px-4 py-3">Date</th>
              <th class="text-left px-4 py-3">Type</th>
              <th class="text-left px-4 py-3">Payee</th>
              <th class="text-left px-4 py-3">Category</th>
              <th class="text-right px-4 py-3">Amount</th>
              <th class="text-left px-4 py-3">Status</th>
              <th class="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody id="ledger-rows" class="divide-y divide-slate-100 dark:divide-slate-700"></tbody>
        </table>
      </div>
    </div>
    </div>
  `;

  ['filter-search', 'filter-type', 'filter-category', 'filter-status'].forEach(id => {
    document.getElementById(id).addEventListener('input', applyLedgerFilters);
    document.getElementById(id).addEventListener('change', applyLedgerFilters);
  });
  applyLedgerFilters();
}

function attachLedgerRowActions(root) {
  root.querySelectorAll('button[data-action]').forEach(btn => {
    const id = Number(btn.dataset.id);
    btn.addEventListener('click', async () => {
      const tx = state.transactions.find(t => t.id === id);
      if (btn.dataset.action === 'edit') openTransactionModal(tx);
      if (btn.dataset.action === 'print') printVoucher(tx, state.settings);
      if (btn.dataset.action === 'delete') {
        if (confirm(`Delete voucher ${tx.voucherId}? This cannot be undone.`)) {
          await deleteTransaction(id);
          state.transactions = await getAllTransactions();
          applyLedgerFilters();
          updateFloatPill();
          showToast('Transaction deleted.');
        }
      }
    });
  });
}

function applyLedgerFilters() {
  state.ledgerFilters.search = document.getElementById('filter-search')?.value || '';
  state.ledgerFilters.type = document.getElementById('filter-type')?.value || '';
  state.ledgerFilters.category = document.getElementById('filter-category')?.value || '';
  state.ledgerFilters.status = document.getElementById('filter-status')?.value || '';
  const f = state.ledgerFilters;

  let rows = [...state.transactions];
  if (f.search) {
    const q = f.search.toLowerCase();
    rows = rows.filter(t => (t.payee || '').toLowerCase().includes(q) || (t.voucherId || '').toLowerCase().includes(q) || (t.description || '').toLowerCase().includes(q));
  }
  if (f.type) rows = rows.filter(t => t.type === f.type);
  if (f.category) rows = rows.filter(t => t.category === f.category);
  if (f.status) rows = rows.filter(t => t.status === f.status);

  // Desktop table
  const tbody = document.getElementById('ledger-rows');
  tbody.innerHTML = rows.map(t => `
    <tr class="hover:bg-slate-50 dark:hover:bg-white/5 transition-colors">
      <td class="px-4 py-3 font-mono text-xs text-slate-500">${t.voucherId}</td>
      <td class="px-4 py-3 whitespace-nowrap">${new Date(t.date).toLocaleDateString()}</td>
      <td class="px-4 py-3">${typeBadge(t.type)}</td>
      <td class="px-4 py-3 max-w-[160px] truncate">${escapeHtml(t.payee || '—')}</td>
      <td class="px-4 py-3">${escapeHtml(t.category)}</td>
      <td class="px-4 py-3 text-right font-medium ${t.type === 'Inflow' ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-200'}">${t.type === 'Inflow' ? '+' : '-'}${fmt(t.amount)}</td>
      <td class="px-4 py-3">${statusBadge(t.status)}</td>
      <td class="px-4 py-3 text-right whitespace-nowrap">
        <button data-action="print" data-id="${t.id}" class="tap text-slate-400 hover:text-[var(--accent-600)] px-1" title="Print voucher">🖨️</button>
        <button data-action="edit" data-id="${t.id}" class="tap text-slate-400 hover:text-[var(--accent-600)] px-1" title="Edit">✏️</button>
        <button data-action="delete" data-id="${t.id}" class="tap text-slate-400 hover:text-red-600 px-1" title="Delete">🗑️</button>
      </td>
    </tr>
  `).join('') || `<tr><td colspan="8">${emptyState('No matching transactions.', '🔍')}</td></tr>`;
  attachLedgerRowActions(tbody);

  // Mobile card list
  const cardHost = document.getElementById('ledger-cards');
  cardHost.innerHTML = rows.map(t => `
    <div class="card p-4">
      <div class="flex items-start justify-between gap-3 mb-2">
        <div class="min-w-0">
          <div class="font-semibold text-slate-800 dark:text-slate-100 truncate">${escapeHtml(t.payee || t.category)}</div>
          <div class="text-xs text-slate-400 font-mono mt-0.5">${t.voucherId}</div>
        </div>
        <div class="text-right shrink-0">
          <div class="font-bold ${t.type === 'Inflow' ? 'text-emerald-600' : 'text-slate-700 dark:text-slate-200'}">${t.type === 'Inflow' ? '+' : '-'}${fmt(t.amount)}</div>
          <div class="text-xs text-slate-400 mt-0.5">${new Date(t.date).toLocaleDateString()}</div>
        </div>
      </div>
      <div class="flex items-center justify-between gap-2 pt-2 border-t border-slate-100 dark:border-slate-700">
        <div class="flex items-center gap-1.5">${typeBadge(t.type)}${statusBadge(t.status)}</div>
        <div class="flex items-center gap-1">
          <button data-action="print" data-id="${t.id}" class="tap w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10" title="Print voucher">🖨️</button>
          <button data-action="edit" data-id="${t.id}" class="tap w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10" title="Edit">✏️</button>
          <button data-action="delete" data-id="${t.id}" class="tap w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10" title="Delete">🗑️</button>
        </div>
      </div>
    </div>
  `).join('') || `<div class="card">${emptyState('No matching transactions.', '🔍')}</div>`;
  attachLedgerRowActions(cardHost);
}

function typeBadge(type) {
  const map = { 'Inflow': 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300', 'Outflow': 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300', 'Advance IOU': 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300' };
  return `<span class="text-xs px-2 py-1 rounded-full font-medium ${map[type]}">${type}</span>`;
}
function statusBadge(status) {
  const map = { 'Completed': 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300', 'Pending Receipt': 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300', 'Overdue IOU': 'bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300' };
  return `<span class="text-xs px-2 py-1 rounded-full font-medium ${map[status] || 'bg-slate-100 text-slate-600'}">${status}</span>`;
}

// ================= NEW / EDIT TRANSACTION MODAL =================
async function openTransactionModal(existing = null) {
  state.editingId = existing?.id || null;
  const categories = state.settings.categories;
  const subcatOptions = (catName) => (categories.find(c => c.name === catName)?.subcategories || []).map(s => `<option ${existing?.subcategory === s ? 'selected' : ''}>${s}</option>`).join('');

  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-900/50 backdrop-blur-sm" id="modal-backdrop">
      <div class="modal-pop bg-white dark:bg-slate-800 w-full md:max-w-lg md:rounded-4xl rounded-t-4xl shadow-2xl max-h-[92vh] overflow-y-auto" id="modal-panel">
        <div class="sticky top-0 bg-white/95 dark:bg-slate-800/95 backdrop-blur px-6 pt-6 pb-4 flex items-center gap-3 border-b border-slate-100 dark:border-slate-700 z-10">
          <span class="icon-badge bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)] text-[var(--accent-600)]">${existing ? '✏️' : '➕'}</span>
          <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 font-display flex-1">${existing ? 'Edit Transaction' : 'New Transaction'}</h2>
          <button id="modal-close" class="tap w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 dark:hover:bg-white/10 text-lg leading-none">✕</button>
        </div>
        <form id="tx-form" class="px-6 py-5 space-y-4">
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">Date &amp; Time</span>
            <input required type="datetime-local" name="date" value="${toLocalDatetimeInputValue(existing?.date)}" class="mt-1 w-full input-field px-3 py-2" />
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Type</span>
              <select name="type" id="tx-type" class="mt-1 w-full input-field px-3 py-2">
                ${['Outflow', 'Inflow', 'Advance IOU'].map(v => `<option ${existing?.type === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Payment Method</span>
              <select name="paymentMethod" class="mt-1 w-full input-field px-3 py-2">
                ${['Physical Cash', 'Mobile Money / M-Pesa', 'Bank Transfer'].map(v => `<option ${existing?.paymentMethod === v ? 'selected' : ''}>${v}</option>`).join('')}
              </select>
            </label>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Amount (${state.settings.currency})</span>
              <input required type="number" step="0.01" min="0" name="amount" value="${existing?.amount ?? ''}" class="mt-1 w-full input-field px-3 py-2" />
            </label>
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Fees</span>
              <input type="number" step="0.01" min="0" name="fees" value="${existing?.fees ?? 0}" class="mt-1 w-full input-field px-3 py-2" />
            </label>
          </div>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Category</span>
              <select name="category" id="tx-category" class="mt-1 w-full input-field px-3 py-2">
                ${categories.map(c => `<option ${existing?.category === c.name ? 'selected' : ''}>${c.name}</option>`).join('')}
              </select>
            </label>
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Subcategory</span>
              <select name="subcategory" id="tx-subcategory" class="mt-1 w-full input-field px-3 py-2">
                ${subcatOptions(existing?.category || categories[0].name)}
              </select>
            </label>
          </div>
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">Payee / Recipient</span>
            <input name="payee" value="${escapeHtml(existing?.payee || '')}" class="mt-1 w-full input-field px-3 py-2" />
          </label>
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">GL Account Code</span>
            <input name="glCode" value="${escapeHtml(existing?.glCode || state.settings.glAccountMap[categories[0].name] || '')}" id="tx-glcode" class="mt-1 w-full input-field px-3 py-2" />
          </label>
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">Description / Purpose</span>
            <textarea name="description" rows="2" class="mt-1 w-full input-field px-3 py-2">${escapeHtml(existing?.description || '')}</textarea>
          </label>
          <div class="grid grid-cols-2 gap-3">
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Handled By</span>
              <input name="handledBy" value="${escapeHtml(existing?.handledBy || state.settings.custodianName || '')}" class="mt-1 w-full input-field px-3 py-2" />
            </label>
            <label class="text-sm">
              <span class="text-slate-500 dark:text-slate-400">Approved By</span>
              <input name="approvedBy" value="${escapeHtml(existing?.approvedBy || '')}" class="mt-1 w-full input-field px-3 py-2" />
            </label>
          </div>
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">Status</span>
            <select name="status" class="mt-1 w-full input-field px-3 py-2">
              ${['Completed', 'Pending Receipt', 'Overdue IOU'].map(v => `<option ${existing?.status === v ? 'selected' : ''}>${v}</option>`).join('')}
            </select>
          </label>
          <label class="text-sm block">
            <span class="text-slate-500 dark:text-slate-400">Receipt Image</span>
            <label for="tx-receipt" class="tap mt-1 flex items-center justify-center gap-2 w-full input-field px-3 py-3 text-sm text-slate-500 dark:text-slate-400 cursor-pointer border-dashed">
              <span>📷</span> Tap to attach a photo
            </label>
            <input type="file" accept="image/*" id="tx-receipt" class="hidden" />
            <div id="receipt-preview" class="mt-2"></div>
          </label>
          <p id="tx-alert" class="text-sm text-amber-600 dark:text-amber-400"></p>
          <div class="flex gap-3 pt-2 pb-2">
            <button type="button" id="modal-cancel" class="tap flex-1 rounded-2xl border border-slate-200 dark:border-slate-700 py-2.5 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5">Cancel</button>
            <button type="submit" class="tap flex-1 rounded-2xl text-white py-2.5 text-sm font-semibold shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">${existing ? 'Save Changes' : 'Log Transaction'}</button>
          </div>
        </form>
      </div>
    </div>
  `;

  let receiptDataUrl = null;
  if (existing?.receiptImage) {
    receiptDataUrl = await decryptBlob(existing.receiptImage);
    if (receiptDataUrl) {
      document.getElementById('receipt-preview').innerHTML = `<img src="${receiptDataUrl}" class="h-20 rounded-xl border border-slate-200 dark:border-slate-700" />`;
    } else if (existing.receiptImage.__encrypted) {
      document.getElementById('receipt-preview').innerHTML = `<span class="text-xs text-amber-600">🔒 Encrypted receipt — unlock with the app PIN to view.</span>`;
    }
  }

  document.getElementById('tx-category').addEventListener('change', (e) => {
    document.getElementById('tx-subcategory').innerHTML = subcatOptions(e.target.value);
    document.getElementById('tx-glcode').value = state.settings.glAccountMap[e.target.value] || '';
  });

  document.getElementById('tx-receipt').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      // Compress via canvas before storing (autonomous: receipt image compression)
      receiptDataUrl = await compressImage(ev.target.result, 1024, 0.72);
      document.getElementById('receipt-preview').innerHTML = `<img src="${receiptDataUrl}" class="h-20 rounded-xl border border-slate-200 dark:border-slate-700" />`;
    };
    reader.readAsDataURL(file);
  });

  const closeModal = () => { modalRoot.innerHTML = ''; };
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') closeModal(); });

  // Live spend-cap alert
  const amountInput = document.querySelector('#tx-form input[name="amount"]');
  amountInput.addEventListener('input', () => {
    const alertEl = document.getElementById('tx-alert');
    const val = parseFloat(amountInput.value) || 0;
    if (val > state.settings.spendCapAmount) {
      alertEl.textContent = `⚠ Exceeds configured spend cap of ${fmt(state.settings.spendCapAmount)} (${state.settings.spendCapMode} limit).`;
    } else {
      alertEl.textContent = '';
    }
  });

  document.getElementById('tx-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    // The datetime-local input gives "YYYY-MM-DDTHH:mm" in local time with
    // no timezone; JS Date parses that as local time, so this round-trips
    // correctly into a real ISO timestamp for storage/sorting.
    payload.date = new Date(payload.date).toISOString();
    payload.amount = parseFloat(payload.amount) || 0;
    payload.fees = parseFloat(payload.fees) || 0;
    payload.receiptImage = (state.settings.encryptionEnabled && hasCryptoKey() && receiptDataUrl)
      ? await encryptBlob(receiptDataUrl)
      : receiptDataUrl;

    // Hard spend cap enforcement
    if (payload.amount > state.settings.spendCapAmount && state.settings.spendCapMode === 'hard') {
      document.getElementById('tx-alert').textContent = `🚫 Blocked: amount exceeds the hard spend cap of ${fmt(state.settings.spendCapAmount)}. Adjust the amount or ask an approver to raise the cap in Settings.`;
      return;
    }

    // Frequency / split-transaction alert (non-blocking, informational)
    if (payload.payee) {
      const recent = await findRecentPayeePayouts(payload.payee, state.settings.frequencyWindowMinutes);
      if (recent.length + 1 >= state.settings.frequencyThresholdCount && !existing) {
        const proceed = confirm(`${payload.payee} has received ${recent.length} payout(s) in the last ${state.settings.frequencyWindowMinutes} minutes. Log this one anyway?`);
        if (!proceed) return;
      }
    }

    if (existing) {
      await updateTransaction(existing.id, payload);
      showToast('Transaction updated.');
    } else {
      payload.voucherId = await generateVoucherId(payload.type);
      await addTransaction(payload);
      showToast(`Voucher ${payload.voucherId} logged.`);
    }
    closeModal();
    state.transactions = await getAllTransactions();
    updateFloatPill();
    if (state.currentView === 'ledger') applyLedgerFilters();
    if (state.currentView === 'dashboard') navigate('dashboard');
  });
}

function compressImage(dataUrl, maxDim, quality) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ================= RECONCILE =================
const DENOMINATIONS = [1000, 500, 200, 100, 50, 40, 20, 10, 5, 1];

async function renderReconcile(container) {
  const balances = await computeBalances();
  const latest = await getLatestDenominationCount();
  const custody = await getCustodyLog();

  container.innerHTML = `
    <div class="view-fade">
    <div class="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
      <div class="card p-5">
        ${sectionHeader('🏦', 'System Balances by Channel')}
        <div class="space-y-3 text-sm">
          <div class="flex justify-between items-center card-flat px-3 py-2.5"><span class="text-slate-500 dark:text-slate-400">💵 Physical Cash</span><span class="font-semibold">${fmt(balances.cash)}</span></div>
          <div class="flex justify-between items-center card-flat px-3 py-2.5"><span class="text-slate-500 dark:text-slate-400">📱 Mobile Money / M-Pesa</span><span class="font-semibold">${fmt(balances.mobileMoney)}</span></div>
          <div class="flex justify-between items-center card-flat px-3 py-2.5"><span class="text-slate-500 dark:text-slate-400">🏛️ Bank Transfer</span><span class="font-semibold">${fmt(balances.bank)}</span></div>
          <div class="border-t border-slate-100 dark:border-slate-700 pt-3 flex justify-between text-base">
            <span class="font-semibold text-slate-700 dark:text-slate-200">Total Float</span><span class="font-bold text-[var(--accent-600)]">${fmt(balances.total)}</span>
          </div>
        </div>
      </div>

      <div class="card p-5">
        ${sectionHeader('🧮', 'Currency Denomination Counter')}
        <div class="grid grid-cols-2 gap-2" id="denom-grid">
          ${DENOMINATIONS.map(d => `
            <label class="flex items-center justify-between text-xs card-flat px-3 py-2">
              <span class="text-slate-500 dark:text-slate-400">${state.settings.currency} ${d} ×</span>
              <input type="number" min="0" data-denom="${d}" value="0" class="denom-input w-16 text-right input-field px-1 py-0.5" />
            </label>`).join('')}
        </div>
        <div class="mt-4 flex justify-between items-center text-sm">
          <span class="text-slate-500 dark:text-slate-400">Counted Total</span>
          <span id="counted-total" class="font-semibold">${state.settings.currency} 0.00</span>
        </div>
        <div class="flex justify-between items-center text-sm mt-1">
          <span class="text-slate-500 dark:text-slate-400">Variance vs. System Cash</span>
          <span id="counted-variance" class="font-semibold">—</span>
        </div>
        <button id="save-count" class="tap mt-4 w-full rounded-2xl text-white py-2.5 text-sm font-semibold shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Save Reconciliation</button>
        ${latest ? `<p class="text-xs text-slate-400 mt-2">Last saved: ${new Date(latest.date).toLocaleString()} · variance ${fmt(latest.variance)}</p>` : ''}
      </div>
    </div>

    <div class="card p-5">
      <div class="flex items-center justify-between mb-4">
        ${sectionHeader('🤝', 'Custody Handover Log').replace('mb-4', 'mb-0')}
        <button id="new-handover" class="tap text-xs bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)] text-[var(--accent-600)] dark:text-[var(--accent-300)] rounded-full px-3.5 py-2 font-semibold">+ Record Handover</button>
      </div>
      <div class="space-y-2 text-sm" id="custody-list">
        ${custody.map(c => `
          <div class="flex items-center justify-between border-b border-slate-100 dark:border-slate-700 pb-3 pt-1">
            <div>
              <div class="font-medium text-slate-700 dark:text-slate-200">${escapeHtml(c.fromCustodian)} → ${escapeHtml(c.toCustodian)}</div>
              <div class="text-xs text-slate-400">${new Date(c.date).toLocaleString()} ${c.notes ? '· ' + escapeHtml(c.notes) : ''}</div>
            </div>
            <div class="font-semibold">${fmt(c.balance)}</div>
          </div>`).join('') || emptyState('No handovers recorded yet.', '🤝')}
      </div>
    </div>
    </div>
  `;

  const recompute = () => {
    let total = 0;
    document.querySelectorAll('.denom-input').forEach(inp => {
      total += Number(inp.dataset.denom) * (parseInt(inp.value) || 0);
    });
    document.getElementById('counted-total').textContent = `${state.settings.currency} ${total.toFixed(2)}`;
    const variance = total - balances.cash;
    const varianceEl = document.getElementById('counted-variance');
    varianceEl.textContent = fmt(variance);
    varianceEl.className = `font-semibold ${Math.abs(variance) > 0.5 ? 'text-red-500' : 'text-emerald-600'}`;
    return { total, variance };
  };
  document.querySelectorAll('.denom-input').forEach(inp => inp.addEventListener('input', recompute));
  recompute();

  document.getElementById('save-count').addEventListener('click', async () => {
    const { total, variance } = recompute();
    const breakdown = {};
    document.querySelectorAll('.denom-input').forEach(inp => { breakdown[inp.dataset.denom] = parseInt(inp.value) || 0; });
    await saveDenominationCount({ breakdown, total, variance, systemCash: balances.cash });
    showToast('Reconciliation saved.');
    navigate('reconcile');
  });

  document.getElementById('new-handover').addEventListener('click', () => openHandoverModal());
}

function openHandoverModal() {
  const modalRoot = document.getElementById('modal-root');
  modalRoot.innerHTML = `
    <div class="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-slate-900/50 backdrop-blur-sm" id="modal-backdrop">
      <div class="modal-pop bg-white dark:bg-slate-800 w-full md:max-w-md md:rounded-4xl rounded-t-4xl shadow-2xl p-6">
        <div class="flex items-center gap-3 mb-5">
          <span class="icon-badge bg-[var(--accent-50)] dark:bg-[var(--accent-soft-dark)] text-[var(--accent-600)]">🤝</span>
          <h2 class="text-base font-bold text-slate-800 dark:text-slate-100 font-display">Record Custody Handover</h2>
        </div>
        <form id="handover-form" class="space-y-3">
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">From Custodian</span>
            <input required name="fromCustodian" value="${escapeHtml(state.settings.custodianName || '')}" class="mt-1 w-full input-field px-3 py-2" /></label>
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">To Custodian</span>
            <input required name="toCustodian" class="mt-1 w-full input-field px-3 py-2" /></label>
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Balance Handed Over</span>
            <input required type="number" step="0.01" name="balance" class="mt-1 w-full input-field px-3 py-2" /></label>
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Notes</span>
            <input name="notes" class="mt-1 w-full input-field px-3 py-2" /></label>
          <div class="flex gap-3 pt-2">
            <button type="button" id="modal-cancel" class="tap flex-1 rounded-2xl border border-slate-200 dark:border-slate-700 py-2.5 text-sm font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-white/5">Cancel</button>
            <button type="submit" class="tap flex-1 rounded-2xl text-white py-2.5 text-sm font-semibold shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Record</button>
          </div>
        </form>
      </div>
    </div>`;
  const close = () => { modalRoot.innerHTML = ''; };
  document.getElementById('modal-cancel').addEventListener('click', close);
  document.getElementById('modal-backdrop').addEventListener('click', (e) => { if (e.target.id === 'modal-backdrop') close(); });
  document.getElementById('handover-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    payload.balance = parseFloat(payload.balance) || 0;
    await addCustodyLogEntry(payload);
    await setSetting('custodianName', payload.toCustodian);
    state.settings.custodianName = payload.toCustodian;
    close();
    showToast('Handover recorded.');
    navigate('reconcile');
  });
}

// ================= REPORTS (import/export/backup) =================
function renderReports(container) {
  container.innerHTML = `
    <div class="view-fade grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card p-5">
        ${sectionHeader('📤', 'Export')}
        <div class="space-y-3">
          <button id="export-all" class="tap w-full text-left rounded-2xl border border-slate-200 dark:border-slate-700 px-4 py-3.5 text-sm hover:bg-slate-50 dark:hover:bg-white/5 flex items-center gap-3">
            <span class="icon-badge bg-emerald-50 dark:bg-emerald-500/10 text-base">📥</span>
            <span>Export full ledger to Excel (.xlsx)</span>
          </button>
          <div class="card-flat p-4">
            <p class="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-3">Filtered Export</p>
            <div class="grid grid-cols-2 gap-2 mb-2">
              <input type="date" id="fx-start" class="input-field px-2 py-1.5 text-xs" />
              <input type="date" id="fx-end" class="input-field px-2 py-1.5 text-xs" />
            </div>
            <select id="fx-category" class="w-full mb-2 input-field px-2 py-1.5 text-xs">
              <option value="">Any category</option>
              ${state.settings.categories.map(c => `<option>${c.name}</option>`).join('')}
            </select>
            <input id="fx-payee" placeholder="Payee contains…" class="w-full mb-2 input-field px-2 py-1.5 text-xs" />
            <select id="fx-method" class="w-full mb-3 input-field px-2 py-1.5 text-xs">
              <option value="">Any payment method</option>
              ${['Physical Cash', 'Mobile Money / M-Pesa', 'Bank Transfer'].map(v => `<option>${v}</option>`).join('')}
            </select>
            <button id="export-filtered" class="tap w-full rounded-xl text-white py-2.5 text-xs font-semibold" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Export Filtered Set</button>
          </div>
          <button id="export-backup" class="tap w-full text-left rounded-2xl border border-slate-200 dark:border-slate-700 px-4 py-3.5 text-sm hover:bg-slate-50 dark:hover:bg-white/5 flex items-center gap-3">
            <span class="icon-badge bg-slate-100 dark:bg-white/5 text-base">🗄️</span>
            <span>Full database backup (.json)</span>
          </button>
        </div>
      </div>

      <div class="card p-5">
        ${sectionHeader('📄', 'Import')}
        <label class="tap block rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 px-4 py-8 text-center text-sm text-slate-500 dark:text-slate-400 cursor-pointer hover:border-[var(--accent-400)] hover:bg-[var(--accent-50)]/40 dark:hover:bg-[var(--accent-soft-dark)] transition">
          <input type="file" id="import-file" accept=".xlsx,.xls,.csv" class="hidden" />
          <div class="text-2xl mb-2">📄</div>
          Click to choose an Excel or CSV file to import
        </label>
        <div id="import-mapping"></div>

        <div class="mt-6 pt-4 border-t border-slate-100 dark:border-slate-700">
          <p class="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-2">Restore Full Backup</p>
          <label class="tap block rounded-2xl border-2 border-dashed border-slate-200 dark:border-slate-700 px-4 py-5 text-center text-sm text-slate-500 dark:text-slate-400 cursor-pointer hover:border-[var(--accent-400)] transition">
            <input type="file" id="restore-file" accept=".json" class="hidden" />
            🗄️ Click to choose a .json backup to restore
          </label>
          <p class="text-xs text-red-500 mt-2">Restoring replaces all current data. This cannot be undone.</p>
        </div>
      </div>
    </div>
  `;

  document.getElementById('export-all').addEventListener('click', () => {
    exportTransactionsToExcel(state.transactions);
    showToast('Ledger exported.');
  });

  document.getElementById('export-filtered').addEventListener('click', () => {
    const filters = {
      startDate: document.getElementById('fx-start').value ? new Date(document.getElementById('fx-start').value).toISOString() : '',
      endDate: document.getElementById('fx-end').value ? new Date(document.getElementById('fx-end').value + 'T23:59:59').toISOString() : '',
      category: document.getElementById('fx-category').value,
      payee: document.getElementById('fx-payee').value,
      paymentMethod: document.getElementById('fx-method').value
    };
    const count = exportFilteredTransactions(state.transactions, filters);
    showToast(`Exported ${count} matching transaction(s).`);
  });

  document.getElementById('export-backup').addEventListener('click', async () => {
    const backup = await exportFullBackup();
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `petty-cash-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Backup downloaded.');
  });

  document.getElementById('restore-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('This will replace ALL current data with the contents of this backup. Continue?')) return;
    const text = await file.text();
    try {
      const payload = JSON.parse(text);
      await restoreFullBackup(payload);
      showToast('Backup restored. Reloading…');
      setTimeout(() => window.location.reload(), 1200);
    } catch (err) {
      showToast('Restore failed: invalid backup file.', true);
    }
  });

  document.getElementById('import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const parsed = await parseWorkbookFile(file);
      state.parsedImport = parsed;
      renderImportMapping(parsed);
    } catch (err) {
      showToast('Could not read that file.', true);
    }
  });
}

function renderImportMapping(parsed) {
  const targetFields = [
    { key: 'date', label: 'Date', required: true }, { key: 'amount', label: 'Amount', required: true },
    { key: 'type', label: 'Type' }, { key: 'category', label: 'Category' }, { key: 'subcategory', label: 'Subcategory' },
    { key: 'payee', label: 'Payee' }, { key: 'description', label: 'Description' },
    { key: 'paymentMethod', label: 'Payment Method' }, { key: 'voucherId', label: 'Voucher ID (for de-dup)' },
    { key: 'fees', label: 'Fees' }, { key: 'glCode', label: 'GL Account Code' }
  ];
  const options = ['<option value="">— skip —</option>', ...parsed.headers.map(h => `<option>${escapeHtml(h)}</option>`)].join('');

  const el = document.getElementById('import-mapping');
  el.innerHTML = `
    <div class="mt-4 card-flat p-4">
      <p class="text-sm font-semibold text-slate-600 dark:text-slate-300 mb-3">${parsed.rows.length} row(s) found. Map columns:</p>
      <div class="grid grid-cols-2 gap-2 mb-4">
        ${targetFields.map(f => `
          <label class="text-xs">
            <span class="text-slate-500 dark:text-slate-400">${f.label}${f.required ? ' *' : ''}</span>
            <select data-field="${f.key}" class="mapping-select mt-0.5 w-full input-field px-2 py-1.5">${options}</select>
          </label>`).join('')}
      </div>
      <button id="run-import" class="tap w-full rounded-xl text-white py-2.5 text-sm font-semibold" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Import Transactions</button>
      <div id="import-report" class="text-xs mt-3 text-slate-500 dark:text-slate-400"></div>
    </div>
  `;

  // auto-guess mapping by header name similarity
  el.querySelectorAll('.mapping-select').forEach(sel => {
    const field = sel.dataset.field;
    const guess = parsed.headers.find(h => h.toLowerCase().replace(/[^a-z]/g, '').includes(field.toLowerCase()));
    if (guess) sel.value = guess;
  });

  document.getElementById('run-import').addEventListener('click', async () => {
    const mapping = {};
    el.querySelectorAll('.mapping-select').forEach(sel => { if (sel.value) mapping[sel.dataset.field] = sel.value; });
    if (!mapping.date || !mapping.amount) {
      document.getElementById('import-report').textContent = 'Date and Amount mappings are required.';
      return;
    }
    const report = await importMappedTransactions(state.parsedImport.rows, mapping, state.settings);
    document.getElementById('import-report').innerHTML = `
      ✅ Imported: ${report.imported} &nbsp; ⏭️ Duplicates skipped: ${report.skippedDuplicates} &nbsp; ⚠️ Errors: ${report.errors.length}
      ${report.errors.length ? '<div class="mt-1 text-red-500">' + report.errors.slice(0, 5).map(e => `Row ${e.row}: ${escapeHtml(e.reason)}`).join('<br>') + '</div>' : ''}
    `;
    state.transactions = await getAllTransactions();
    updateFloatPill();
    showToast(`Imported ${report.imported} transaction(s).`);
  });
}

// ================= SETTINGS =================
function renderSettings(container) {
  const s = state.settings;
  container.innerHTML = `
    <div class="view-fade grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div class="card p-5 space-y-4">
        ${sectionHeader('🏢', 'General')}
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Organization Name</span>
          <input id="s-orgName" value="${escapeHtml(s.orgName)}" class="mt-1 w-full input-field px-3 py-2" /></label>
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Custodian Name</span>
          <input id="s-custodianName" value="${escapeHtml(s.custodianName)}" class="mt-1 w-full input-field px-3 py-2" /></label>
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Currency Code</span>
          <input id="s-currency" value="${escapeHtml(s.currency)}" class="mt-1 w-full input-field px-3 py-2" /></label>
      </div>

      <div class="card p-5 space-y-4">
        ${sectionHeader('🎨', 'Appearance')}
        <div>
          <span class="text-sm text-slate-500 dark:text-slate-400 block mb-2">Theme</span>
          <div class="flex gap-2 card-flat p-1" id="theme-mode-toggle">
            <button type="button" data-mode="light" class="theme-mode-btn segmented-btn flex-1 rounded-xl py-2.5 text-sm font-semibold">☀️ Light</button>
            <button type="button" data-mode="dark" class="theme-mode-btn segmented-btn flex-1 rounded-xl py-2.5 text-sm font-semibold">🌙 Dark</button>
          </div>
        </div>
        <div>
          <span class="text-sm text-slate-500 dark:text-slate-400 block mb-2">Accent Color</span>
          <div class="flex flex-wrap gap-3" id="accent-swatch-row">
            ${Object.entries(ACCENT_THEMES).map(([id, t]) => `
              <button type="button" data-accent="${id}" title="${t.label}"
                class="accent-swatch tap relative w-10 h-10 rounded-full ring-2 ring-offset-2 dark:ring-offset-slate-800 transition ${s.accentColor === id ? 'ring-slate-800 dark:ring-white' : 'ring-transparent'}"
                style="background:${t.swatch}">${s.accentColor === id ? '<span class="absolute inset-0 flex items-center justify-center text-white text-sm">✓</span>' : ''}</button>
            `).join('')}
          </div>
        </div>
        <input type="hidden" id="s-darkMode" value="${s.darkMode ? '1' : '0'}" />
        <input type="hidden" id="s-accentColor" value="${escapeHtml(s.accentColor)}" />
      </div>

      <div class="card p-5 space-y-4">
        ${sectionHeader('🚦', 'Controls & Policy')}
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Float Reorder Point (minimum threshold)</span>
          <input type="number" id="s-floatMin" value="${s.floatMinThreshold}" class="mt-1 w-full input-field px-3 py-2" /></label>
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Single Voucher Spend Cap</span>
          <input type="number" id="s-spendCap" value="${s.spendCapAmount}" class="mt-1 w-full input-field px-3 py-2" /></label>
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Spend Cap Mode</span>
          <select id="s-spendCapMode" class="mt-1 w-full input-field px-3 py-2">
            <option value="soft" ${s.spendCapMode === 'soft' ? 'selected' : ''}>Soft alert (warn only)</option>
            <option value="hard" ${s.spendCapMode === 'hard' ? 'selected' : ''}>Hard limit (block entry)</option>
          </select></label>
        <div class="grid grid-cols-2 gap-3">
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Frequency Window (min)</span>
            <input type="number" id="s-freqWindow" value="${s.frequencyWindowMinutes}" class="mt-1 w-full input-field px-3 py-2" /></label>
          <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">Flag after N payouts</span>
            <input type="number" id="s-freqCount" value="${s.frequencyThresholdCount}" class="mt-1 w-full input-field px-3 py-2" /></label>
        </div>
      </div>

      <div class="card p-5 space-y-4">
        ${sectionHeader('🔐', 'Security')}
        <label class="text-sm block"><span class="text-slate-500 dark:text-slate-400">App PIN Lock (leave blank to disable)</span>
          <input id="s-pinLock" type="password" maxlength="8" placeholder="e.g. 4821" value="${escapeHtml(s.pinLock || '')}" class="mt-1 w-full input-field px-3 py-2" /></label>
        <label class="flex items-center justify-between text-sm gap-3"><span class="text-slate-500 dark:text-slate-400">Encrypt receipt images at rest (AES-GCM, key derived from PIN)</span>
          <input type="checkbox" id="s-encryption" ${s.encryptionEnabled ? 'checked' : ''} class="w-5 h-5 accent-[var(--accent-600)] shrink-0" /></label>
        <p class="text-xs text-slate-400">A PIN is required to enable encryption. Losing the PIN means stored receipt images cannot be recovered.</p>
      </div>

      <div class="card p-5 space-y-2 lg:col-span-2">
        ${sectionHeader('🏷️', 'Categories & GL Codes')}
        <div id="category-list" class="space-y-3 max-h-80 overflow-y-auto pr-1">
          ${s.categories.map((c, i) => `
            <div class="card-flat p-3 space-y-2">
              <div class="flex items-center gap-2 text-sm">
                <input class="cat-name flex-1 input-field px-2 py-1.5" data-idx="${i}" placeholder="Category name" value="${escapeHtml(c.name)}" />
                <input class="cat-gl w-24 input-field px-2 py-1.5" data-idx="${i}" placeholder="GL code" value="${escapeHtml(s.glAccountMap[c.name] || '')}" />
                <button type="button" class="cat-remove tap w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/10" data-idx="${i}" title="Remove category">🗑️</button>
              </div>
              <input class="cat-subs w-full input-field px-2 py-1.5 text-xs" data-idx="${i}" placeholder="Subcategories, comma separated" value="${escapeHtml((c.subcategories || []).join(', '))}" />
            </div>`).join('') || emptyState('No categories yet — add one below.', '🏷️')}
        </div>
        <button type="button" id="cat-add" class="tap text-xs text-[var(--accent-600)] font-semibold mt-2 px-2 py-1">+ Add category</button>
      </div>
    </div>

    <div class="mt-4 flex justify-end">
      <button id="save-settings" class="tap rounded-2xl text-white px-6 py-2.5 text-sm font-semibold shadow-lg" style="background: linear-gradient(135deg, var(--accent-600), var(--accent-700));">Save Settings</button>
    </div>
    <p class="text-xs text-slate-400 mt-4">Petty Cash PWA · Offline-first · All data stays on this device.</p>
  `;

  // Appearance: theme mode toggle + accent color swatches (live preview)
  function highlightModeButtons(mode) {
    container.querySelectorAll('.theme-mode-btn').forEach(btn => {
      const active = btn.dataset.mode === mode;
      btn.className = `theme-mode-btn segmented-btn flex-1 rounded-xl py-2.5 text-sm font-semibold ${
        active
          ? 'bg-white dark:bg-slate-700 text-[var(--accent-600)] shadow-sm'
          : 'text-slate-500 dark:text-slate-400'
      }`;
    });
  }
  highlightModeButtons(s.darkMode ? 'dark' : 'light');
  container.querySelectorAll('.theme-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      document.getElementById('s-darkMode').value = mode === 'dark' ? '1' : '0';
      applyDarkMode(mode === 'dark');
      highlightModeButtons(mode);
    });
  });

  function paintSwatchSelection(selectedId) {
    container.querySelectorAll('.accent-swatch').forEach(b => {
      const isSel = b.dataset.accent === selectedId;
      b.classList.toggle('ring-slate-800', isSel);
      b.classList.toggle('dark:ring-white', isSel);
      b.classList.toggle('ring-transparent', !isSel);
      b.innerHTML = isSel ? '<span class="absolute inset-0 flex items-center justify-center text-white text-sm">✓</span>' : '';
    });
  }
  container.querySelectorAll('.accent-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('s-accentColor').value = btn.dataset.accent;
      applyAccentColor(btn.dataset.accent);
      paintSwatchSelection(btn.dataset.accent);
    });
  });

  document.getElementById('cat-add').addEventListener('click', () => {
    let n = s.categories.length + 1;
    while (s.categories.some(c => c.name === `New Category ${n}`)) n++;
    s.categories.push({ name: `New Category ${n}`, subcategories: [] });
    renderSettings(container);
  });
  container.querySelectorAll('.cat-remove').forEach(btn => btn.addEventListener('click', () => {
    s.categories.splice(Number(btn.dataset.idx), 1);
    renderSettings(container);
  }));

  document.getElementById('save-settings').addEventListener('click', async () => {
    const newCategories = [];
    const glMap = {};
    container.querySelectorAll('.cat-name').forEach((inp, i) => {
      const name = inp.value.trim() || `Category ${i + 1}`;
      const subsInput = container.querySelector(`.cat-subs[data-idx="${inp.dataset.idx}"]`);
      const subcategories = (subsInput?.value || '').split(',').map(x => x.trim()).filter(Boolean);
      newCategories.push({ name, subcategories });
      const glInput = container.querySelector(`.cat-gl[data-idx="${inp.dataset.idx}"]`);
      glMap[name] = glInput?.value || '';
    });

    const pin = document.getElementById('s-pinLock').value.trim();
    const encryptionRequested = document.getElementById('s-encryption').checked;
    if (encryptionRequested && !pin) {
      showToast('Set a PIN before enabling encryption.', true);
      return;
    }

    const updates = {
      orgName: document.getElementById('s-orgName').value,
      custodianName: document.getElementById('s-custodianName').value,
      currency: document.getElementById('s-currency').value || 'KES',
      darkMode: document.getElementById('s-darkMode').value === '1',
      accentColor: document.getElementById('s-accentColor').value,
      floatMinThreshold: parseFloat(document.getElementById('s-floatMin').value) || 0,
      spendCapAmount: parseFloat(document.getElementById('s-spendCap').value) || 0,
      spendCapMode: document.getElementById('s-spendCapMode').value,
      frequencyWindowMinutes: parseInt(document.getElementById('s-freqWindow').value) || 60,
      frequencyThresholdCount: parseInt(document.getElementById('s-freqCount').value) || 3,
      pinLock: pin,
      encryptionEnabled: encryptionRequested,
      categories: newCategories,
      glAccountMap: glMap
    };
    for (const [key, value] of Object.entries(updates)) {
      await setSetting(key, value);
    }
    state.settings = await getSettings();
    applyDarkMode(state.settings.darkMode);
    applyAccentColor(state.settings.accentColor);
    if (pin) await deriveKeyFromPin(pin);
    showToast('Settings saved.');
    renderShell();
    navigate('settings');
  });
}

// ================= Utilities =================
function fmt(n) {
  const val = Number(n) || 0;
  return `${state.settings.currency} ${val.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// Converts an ISO timestamp (or nothing, for "now") into the local
// "YYYY-MM-DDTHH:mm" string a <input type="datetime-local"> expects.
function toLocalDatetimeInputValue(isoString) {
  const d = isoString ? new Date(isoString) : new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function emptyState(msg, icon = '📭') {
  return `<div class="text-center text-sm text-slate-400 py-10">
    <div class="w-14 h-14 mx-auto rounded-2xl bg-slate-100 dark:bg-white/5 flex items-center justify-center text-2xl mb-3">${icon}</div>
    ${msg}
  </div>`;
}

function applyDarkMode(on) {
  document.documentElement.classList.toggle('dark', !!on);
}
async function toggleDarkMode() {
  state.settings.darkMode = !state.settings.darkMode;
  applyDarkMode(state.settings.darkMode);
  await setSetting('darkMode', state.settings.darkMode);
  document.getElementById('dark-toggle-icon') && (document.getElementById('dark-toggle-icon').textContent = state.settings.darkMode ? '☀️' : '🌙');
  destroyAllCharts();
  navigate(state.currentView);
}

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `mb-2 px-4 py-3 rounded-2xl shadow-xl text-sm font-medium text-white flex items-center gap-2.5 animate-[fadein_0.2s_ease-out] ${isError ? 'bg-red-500' : ''}`;
  if (!isError) toast.style.background = 'linear-gradient(135deg, var(--accent-600), var(--accent-700))';
  toast.innerHTML = `<span>${isError ? '⚠️' : '✅'}</span><span>${escapeHtml(message)}</span>`;
  toastHost.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.3s'; setTimeout(() => toast.remove(), 300); }, 3200);
}

function handleShortcuts(e) {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
  if (document.getElementById('modal-root')?.innerHTML) {
    if (e.key === 'Escape') document.getElementById('modal-root').innerHTML = '';
    return;
  }
  if (e.key.toLowerCase() === 'n') openTransactionModal();
  if (e.key === '1') navigate('dashboard');
  if (e.key === '2') navigate('ledger');
  if (e.key === '3') navigate('reconcile');
  if (e.key === '4') navigate('reports');
  if (e.key === '5') navigate('settings');
}

// ================= PWA: Service Worker + update toast =================
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./sw.js');
      reg.addEventListener('updatefound', () => {
        const newWorker = reg.installing;
        newWorker.addEventListener('statechange', () => {
          if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
            showUpdateToast(reg);
          }
        });
      });
    } catch (err) {
      console.warn('Service worker registration failed:', err);
    }
  });
}

function showUpdateToast(reg) {
  const toast = document.createElement('div');
  toast.className = 'mb-2 px-4 py-3 rounded-2xl shadow-xl text-sm text-white flex items-center gap-3 font-medium';
  toast.style.background = 'linear-gradient(135deg, var(--accent-600), var(--accent-700))';
  toast.innerHTML = `<span>🔄 A new version is available.</span><button id="reload-app" class="tap underline font-semibold">Reload</button>`;
  toastHost.appendChild(toast);
  toast.querySelector('#reload-app').addEventListener('click', () => {
    if (reg.waiting) reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    window.location.reload();
  });
}

boot();
