// 「災害ごとに画面を仕切り直す」機能の導入に伴う一回限りの移行スクリプト。
//
// これまで Incident は urn:ngsi-ld:Incident:meguro-current の固定1件だけで、
// 被害報告・物資要求・割当・全体共有・情報発信のどれにも incidentId が付いていなかった。
// このスクリプトは、その固定 Incident を「進行中の災害（isActive:true）」として正式化し、
// 既存の各エンティティに incidentId を後付けする。
//
// 一度実行すれば十分（すでに incidentId がある/すでに isActive がある場合はスキップする）。
require('dotenv').config();

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const LEGACY_INCIDENT_ID = 'urn:ngsi-ld:Incident:meguro-current';
const SCOPED_TYPES = ['DamageReport', 'SupplyRequest', 'SupplyAllocation', 'Notice', 'Broadcast'];

function headers(contentType) {
  return {
    'X-Api-Key': process.env.GEONIC_API_KEY,
    'NGSILD-Tenant': process.env.GEONIC_SERVICE,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function get(pathname) {
  const res = await fetch(`${GEONIC_BASE_URL}${pathname}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${pathname} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function patch(id, attrs) {
  const res = await fetch(`${GEONIC_BASE_URL}/entities/${encodeURIComponent(id)}/attrs`, {
    method: 'PATCH',
    headers: headers('application/json'),
    body: JSON.stringify(attrs),
  });
  if (!res.ok) throw new Error(`PATCH ${id} -> ${res.status} ${await res.text()}`);
}

async function runInBatches(items, fn, batchSize = 10) {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.all(items.slice(i, i + batchSize).map(fn));
  }
}

async function main() {
  let legacyIncident;
  try {
    legacyIncident = await get(`/entities/${encodeURIComponent(LEGACY_INCIDENT_ID)}?options=keyValues`);
  } catch (err) {
    console.log('既存の Incident が見つかりません。まず node scripts/seed-demo-situation.js を実行してください。');
    return;
  }

  if (!legacyIncident.isActive) {
    await patch(LEGACY_INCIDENT_ID, {
      isActive: { type: 'Property', value: true },
    });
    console.log(`${LEGACY_INCIDENT_ID} を isActive:true にしました`);
  } else {
    console.log(`${LEGACY_INCIDENT_ID} はすでに isActive:true です`);
  }

  const incidentAttr = {
    incidentId: { type: 'Property', value: LEGACY_INCIDENT_ID },
    incidentName: { type: 'Property', value: legacyIncident.name || '災害' },
  };

  for (const type of SCOPED_TYPES) {
    const entities = await get(`/entities?type=${type}&limit=1000&options=keyValues`);
    const targets = entities.filter((e) => !e.incidentId);

    if (targets.length === 0) {
      console.log(`${type}: 対象なし（${entities.length} 件はすでに incidentId 付き）`);
      continue;
    }

    await runInBatches(targets, (e) => patch(e.id, incidentAttr));
    console.log(`${type}: ${targets.length} 件に incidentId を付与`);
  }

  console.log('完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
