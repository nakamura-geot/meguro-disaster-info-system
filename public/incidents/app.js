async function main() {
  const { incidents } = await fetch('/api/incidents').then((r) => r.json());
  const el = document.getElementById('incident-list');

  if (incidents.length === 0) {
    el.innerHTML = '<li class="empty">まだ災害が登録されていません。メイン画面から「新しい災害を開始する」を行ってください。</li>';
    return;
  }

  el.innerHTML = incidents
    .map((incident) => {
      const href = `/?incidentId=${encodeURIComponent(incident.id)}`;
      return `<li>
        <a href="${href}" target="_blank" rel="noopener">
          <div class="incident-row-head">
            <span class="incident-name">${escapeHtml(incident.name)}</span>
            <span class="incident-badge ${incident.isActive ? 'active' : 'closed'}">${incident.isActive ? '進行中' : '終了'}</span>
          </div>
          <p class="incident-meta">
            発災 ${formatDateTime(incident.occurredAt)}　宣言者: ${escapeHtml(incident.declaredBy || '')}
            ${incident.closedAt ? `　終了 ${formatDateTime(incident.closedAt)}` : ''}
          </p>
        </a>
      </li>`;
    })
    .join('');
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main();
