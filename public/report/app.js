const CATEGORIES = {
  building: '建物被害',
  road: '道路被害',
  lifeline: 'ライフライン',
  fire: '火災',
  human: '人的被害',
  other: 'その他',
};

const SEVERITIES = { minor: '軽微', moderate: '中程度', severe: '重大' };
const REPORT_STATUS = { reported: '未対応', responding: '対応中', resolved: '対応完了' };
const SHELTER_STATUS = { available: '空きあり', crowded: '混雑', full: '満員', closed: '閉鎖' };
const REQUEST_STATUS = { requested: '要求中', arranged: '手配済', delivered: '配送完了' };
const BUILDING_DAMAGE = { none: '被害なし', minor: '一部損壊', severe: '大規模損壊' };
const UTILITY = { available: '可', unavailable: '不可', unknown: '未確認' };
const UTILITIES = { electricity: '電気', gas: 'ガス', water: '水道', sewer: '下水道' };
const LIFELINE_STATUS = { partial: '一部使用可', unavailable: '使用不可', unknown: '不明' };

let selectedIncidentId = '';

async function main() {
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('reload').onclick = load;

  await loadIncidentPicker();
  await load();
}

// 過去に終了した災害も含めて選べるようにする。空欄＝現在進行中の災害。
async function loadIncidentPicker() {
  const select = document.getElementById('incident-picker');
  const { incidents } = await fetch('/api/incidents').then((r) => r.json());

  if (incidents.length === 0) {
    document.getElementById('incident-picker-field').hidden = true;
    return;
  }

  select.innerHTML = incidents
    .map(
      (incident) =>
        `<option value="${escapeHtml(incident.id)}">${incident.isActive ? '● ' : ''}${escapeHtml(incident.name)}（${formatDateTime(incident.occurredAt)}）${incident.isActive ? '' : ' [終了]'}</option>`,
    )
    .join('');

  const active = incidents.find((i) => i.isActive);
  selectedIncidentId = active ? active.id : incidents[0].id;
  select.value = selectedIncidentId;

  select.onchange = () => {
    selectedIncidentId = select.value;
    load();
  };
}

async function load() {
  const url = selectedIncidentId ? `/api/report?incidentId=${encodeURIComponent(selectedIncidentId)}` : '/api/report';
  const data = await fetch(url).then((r) => r.json());
  document.getElementById('report').innerHTML = renderReport(data);
  document.getElementById('toolbar-note').textContent = `${formatDateTime(data.generatedAt)} 時点の情報`;
}

function renderReport(data) {
  return `
    ${renderHeader(data)}
    ${data.incident && !data.incident.isActive ? '<p class="past-incident-note">過去の災害の記録です。避難所・ライフラインの状況欄は当時のものではなく、現在の状態を表示しています。</p>' : ''}
    ${renderDamage(data.damage)}
    ${renderShelters(data.shelters)}
    ${renderLifelines(data.lifelineIssues)}
    ${renderSupplies(data.supplies)}
    ${renderNotices(data.notices)}
    <footer class="report-footer">
      避難所の位置・名称は目黒区オープンデータ「地域避難所」（CC BY 4.0）、丁目境界は総務省統計局「令和2年国勢調査 小地域境界データ」を利用。
      備蓄倉庫の位置は目黒区地域防災計画 資料編に基づき、座標は住所からの推定値。備蓄数量は標準倉庫の公表値からの推計値。
    </footer>
  `;
}

function renderHeader(data) {
  const incident = data.incident;
  const elapsed = incident?.occurredAt
    ? `発災後 ${formatElapsed(Math.floor((new Date(data.generatedAt) - new Date(incident.occurredAt)) / 60000))}`
    : '発災時刻 未設定';

  return `<div class="report-header">
    <h1>${escapeHtml(data.municipality)} 災害対策本部会議 報告資料</h1>
    <div class="meta">
      <span>${escapeHtml(incident?.name || '災害名 未設定')}</span>
      <span class="elapsed">${elapsed}</span>
      <span>発災 ${incident?.occurredAt ? formatDateTime(incident.occurredAt) : '—'}</span>
      <span>作成 ${formatDateTime(data.generatedAt)}</span>
    </div>
  </div>`;
}

function renderDamage(damage) {
  const categories = Object.entries(CATEGORIES)
    .map(([key, label]) => `<span><strong>${damage.byCategory[key] || 0}</strong> ${label}</span>`)
    .join('');

  const rows = damage.reports
    .slice()
    .sort((a, b) => new Date(b.reportedAt) - new Date(a.reportedAt))
    .map(
      (report) => `<tr>
        <td class="num">${formatTime(report.reportedAt)}</td>
        <td>${escapeHtml(CATEGORIES[report.category] || report.category)}</td>
        <td>${escapeHtml(SEVERITIES[report.severity] || '')}</td>
        <td>${escapeHtml(REPORT_STATUS[report.status] || '')}</td>
        <td>
          ${report.locationNote ? `<div class="place">${escapeHtml(report.locationNote)}</div>` : ''}
          ${escapeHtml(report.description || '')}
          ${renderUpdates(report.updates)}
        </td>
        <td>${escapeHtml(report.reporter || '')}</td>
      </tr>`,
    )
    .join('');

  return `<section>
    <h2>1. 被害状況</h2>
    <div class="kpi">
      <dl><dt>被害報告 合計</dt><dd>${damage.total}</dd></dl>
      <dl><dt>未対応</dt><dd>${damage.byStatus.reported || 0}</dd></dl>
      <dl><dt>対応中</dt><dd>${damage.byStatus.responding || 0}</dd></dl>
      <dl><dt>対応完了</dt><dd>${damage.byStatus.resolved || 0}</dd></dl>
    </div>
    <p class="inline-counts">${categories}</p>
    ${
      rows
        ? `<table class="t-damage">
            <thead><tr><th>報告時刻</th><th>種別</th><th>程度</th><th>対応状況</th><th>内容</th><th>入力者</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : '<p class="empty">被害報告はありません。</p>'
    }
  </section>`;
}

// 追記は会議で経過を追えるよう、報告本文の下に時系列で並べる
function renderUpdates(updates) {
  if (!Array.isArray(updates) || updates.length === 0) return '';

  return `<ul class="update-list">${updates
    .map(
      (entry) => `<li><span class="time">${formatTime(entry.at)}</span>${escapeHtml(entry.by || '')}：${escapeHtml(entry.note)}</li>`,
    )
    .join('')}</ul>`;
}

function renderShelters(shelters) {
  const rows = shelters.list
    .slice()
    .sort((a, b) => (Number(b.evacueeCount) || 0) - (Number(a.evacueeCount) || 0))
    .map(
      (shelter) => `<tr>
        <td>${escapeHtml(shelter.name)}</td>
        <td>${escapeHtml(SHELTER_STATUS[shelter.status] || '')}</td>
        <td class="num">${(Number(shelter.evacueeCount) || 0).toLocaleString('ja-JP')}</td>
        <td>${escapeHtml(BUILDING_DAMAGE[shelter.buildingDamage] || '未確認')}</td>
        <td>${shelter.electricity ? `${UTILITY[shelter.electricity]}／${UTILITY[shelter.water]}／${UTILITY[shelter.toilet]}／${UTILITY[shelter.internet] || '未確認'}` : '未確認'}</td>
        <td>${escapeHtml(shelter.damageNote || shelter.note || '')}</td>
        <td>${escapeHtml(shelter.updatedBy || '')}</td>
      </tr>`,
    )
    .join('');

  return `<section>
    <h2>2. 避難所の状況</h2>
    <div class="kpi">
      <dl><dt>開設中</dt><dd>${shelters.open} / ${shelters.total}</dd></dl>
      <dl><dt>避難者数</dt><dd>${shelters.evacueeTotal.toLocaleString('ja-JP')}</dd></dl>
      <dl><dt>被害のある避難所</dt><dd>${shelters.damaged}</dd></dl>
      <dl><dt>未開設</dt><dd>${shelters.total - shelters.open}</dd></dl>
    </div>
    ${
      rows
        ? `<table class="t-shelter">
            <thead><tr><th>避難所</th><th>開設状況</th><th>避難者数</th><th>建物被害</th><th>電気／水道／トイレ／ネット</th><th>備考</th><th>入力者</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : '<p class="empty">開設中の避難所はありません。</p>'
    }
  </section>`;
}

function renderLifelines(issues) {
  const sections = Object.entries(UTILITIES)
    .map(([utility, label]) => {
      const list = issues[utility] || [];
      if (list.length === 0) return `<h3>${label}</h3><p class="empty">区内全域で使用可。</p>`;

      const grouped = { unavailable: [], partial: [], unknown: [] };
      for (const entry of list) (grouped[entry.status] || grouped.unknown).push(entry.chomeName);

      const body = Object.entries(grouped)
        .filter(([, names]) => names.length > 0)
        .map(([status, names]) => `<tr><th>${LIFELINE_STATUS[status]}（${names.length}丁目）</th><td>${escapeHtml(names.join('、'))}</td></tr>`)
        .join('');

      return `<h3>${label}</h3><table><tbody>${body}</tbody></table>`;
    })
    .join('');

  return `<section>
    <h2>3. ライフラインの状況（丁目別）</h2>
    ${sections}
  </section>`;
}

function renderSupplies(supplies) {
  const requestRows = supplies.requests
    .slice()
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt))
    .map(
      (request) => `<tr>
        <td>${escapeHtml(request.shelterName)}</td>
        <td>${escapeHtml(request.itemName)}</td>
        <td class="num">${request.quantity} ${escapeHtml(request.unit)}</td>
        <td>${escapeHtml(REQUEST_STATUS[request.status] || '')}</td>
      </tr>`,
    )
    .join('');

  const allocationRows = supplies.allocations
    .slice()
    .sort((a, b) => new Date(b.allocatedAt) - new Date(a.allocatedAt))
    .map(
      (allocation) => `<tr>
        <td>${escapeHtml(allocation.warehouseName)}</td>
        <td>${escapeHtml(allocation.shelterName)}</td>
        <td>${escapeHtml(allocation.itemName)}</td>
        <td class="num">${allocation.quantity} ${escapeHtml(allocation.unit)}</td>
      </tr>`,
    )
    .join('');

  return `<section>
    <h2>4. 救援物資の状況</h2>
    <div class="kpi">
      <dl><dt>物資要求 合計</dt><dd>${supplies.total}</dd></dl>
      <dl><dt>未手配</dt><dd>${supplies.pending}</dd></dl>
      <dl><dt>割当済</dt><dd>${supplies.allocations.length}</dd></dl>
      <dl><dt>配送完了</dt><dd>${supplies.allocations.filter((a) => a.status === 'delivered').length}</dd></dl>
    </div>
    <h3>避難所からの要求</h3>
    ${
      requestRows
        ? `<table><thead><tr><th>避難所</th><th>品目</th><th>数量</th><th>状況</th></tr></thead><tbody>${requestRows}</tbody></table>`
        : '<p class="empty">物資要求はありません。</p>'
    }
    <h3>備蓄倉庫からの割当</h3>
    ${
      allocationRows
        ? `<table><thead><tr><th>出庫元</th><th>搬送先</th><th>品目</th><th>数量</th></tr></thead><tbody>${allocationRows}</tbody></table>`
        : '<p class="empty">割当はありません。</p>'
    }
  </section>`;
}

function renderNotices(notices) {
  const items = notices
    .slice()
    .sort((a, b) => new Date(b.postedAt) - new Date(a.postedAt))
    .map(
      (notice) => `<li>
        <span class="time">${formatTime(notice.postedAt)}</span>
        <span class="category">${escapeHtml(notice.categoryName || '')}</span>
        ${escapeHtml(notice.body || '')}
      </li>`,
    )
    .join('');

  return `<section>
    <h2>5. 全体共有事項（時系列）</h2>
    ${items ? `<ul class="note-list">${items}</ul>` : '<p class="empty">共有事項はありません。</p>'}
  </section>`;
}

function formatElapsed(minutes) {
  if (minutes < 0) return '発災前';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}日${hours}時間${mins}分`;
  if (hours > 0) return `${hours}時間${mins}分`;
  return `${mins}分`;
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main();
