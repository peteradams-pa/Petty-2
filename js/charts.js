// charts.js — Chart.js dashboard visuals for the Analytics view

let categoryChart = null;
let velocityChart = null;
let channelChart = null;

if (typeof Chart !== 'undefined') {
  Chart.defaults.font.family = "'Inter', -apple-system, sans-serif";
  Chart.defaults.font.size = 12;
  Chart.defaults.plugins.tooltip.backgroundColor = '#1e293b';
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 10;
  Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
}

function accentColor() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-600').trim();
  return v || '#4f46e5';
}
function categoryPalette() {
  return [accentColor(), '#6366f1', '#818cf8', '#a5b4fc', '#c7d2fe', '#312e81', '#8b5cf6', '#f59e0b'];
}
function hexToRgba(hex, alpha) {
  const clean = hex.replace('#', '');
  const bigint = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function isDark() {
  return document.documentElement.classList.contains('dark');
}

function gridColor() {
  return isDark() ? 'rgba(148,163,184,0.15)' : 'rgba(100,116,139,0.12)';
}
function tickColor() {
  return isDark() ? '#cbd5e1' : '#475569';
}

export function destroyAllCharts() {
  [categoryChart, velocityChart, channelChart].forEach(c => c && c.destroy());
  categoryChart = velocityChart = channelChart = null;
}

export function renderCategoryBreakdown(canvasId, transactions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const outflows = transactions.filter(t => t.type === 'Outflow' || t.type === 'Advance IOU');
  const byCategory = {};
  for (const t of outflows) {
    byCategory[t.category] = (byCategory[t.category] || 0) + Number(t.amount);
  }
  const labels = Object.keys(byCategory);
  const values = Object.values(byCategory);

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: categoryPalette(), borderWidth: 3, borderColor: isDark() ? '#1e293b' : '#ffffff', hoverOffset: 6 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '68%',
      plugins: {
        legend: { position: 'bottom', labels: { color: tickColor(), padding: 12, font: { size: 11 }, usePointStyle: true, pointStyle: 'circle' } }
      }
    }
  });
}

export function renderDailyVelocity(canvasId, transactions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const days = {};
  const now = new Date();
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    days[key] = 0;
  }
  for (const t of transactions) {
    if (t.type !== 'Outflow' && t.type !== 'Advance IOU') continue;
    const key = (t.date || '').slice(0, 10);
    if (key in days) days[key] += Number(t.amount);
  }
  const labels = Object.keys(days).map(d => d.slice(5));
  const values = Object.values(days);

  if (velocityChart) velocityChart.destroy();
  velocityChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Daily Spend',
        data: values,
        borderColor: accentColor(),
        backgroundColor: hexToRgba(accentColor(), 0.15),
        fill: true,
        tension: 0.35,
        borderWidth: 2.5,
        pointRadius: 0,
        pointHoverRadius: 5,
        pointHoverBackgroundColor: accentColor(),
        pointHoverBorderColor: isDark() ? '#1e293b' : '#ffffff',
        pointHoverBorderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { color: gridColor() }, ticks: { color: tickColor(), maxTicksLimit: 8, font: { size: 10 } } },
        y: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { size: 10 } } }
      }
    }
  });
}

export function renderPaymentChannelDistribution(canvasId, transactions) {
  const ctx = document.getElementById(canvasId);
  if (!ctx) return;
  const byMethod = { 'Physical Cash': 0, 'Mobile Money / M-Pesa': 0, 'Bank Transfer': 0 };
  for (const t of transactions) {
    if (t.type !== 'Outflow' && t.type !== 'Advance IOU') continue;
    if (byMethod[t.paymentMethod] !== undefined) byMethod[t.paymentMethod] += Number(t.amount);
  }

  if (channelChart) channelChart.destroy();
  channelChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(byMethod),
      datasets: [{ data: Object.values(byMethod), backgroundColor: [accentColor(), '#22c55e', '#f59e0b'], borderRadius: 10, maxBarThickness: 56 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { grid: { display: false }, ticks: { color: tickColor(), font: { size: 10 } } },
        y: { grid: { color: gridColor() }, ticks: { color: tickColor(), font: { size: 10 } } }
      }
    }
  });
}
