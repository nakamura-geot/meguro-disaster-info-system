// 投入した目黒区のデータを片付ける。
//   node scripts/clear-demo.js            被害報告を全削除し、避難所を未開設(closed)に戻す
//   node scripts/clear-demo.js --shelters 避難所マスタ(meguro-*)も削除する
require('dotenv').config();

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const MEGURO_PREFIX = 'meguro';

function headers(contentType) {
  return {
    'X-Api-Key': process.env.GEONIC_API_KEY,
    'NGSILD-Tenant': process.env.GEONIC_SERVICE,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

async function listIds(type) {
  const res = await fetch(`${GEONIC_BASE_URL}/entities?type=${type}&limit=1000&options=keyValues`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`${type} の取得に失敗: ${res.status}`);
  const entities = await res.json();
  return entities.map((e) => e.id).filter((id) => id.includes(`:${MEGURO_PREFIX}`));
}

async function remove(ids) {
  for (const id of ids) {
    const res = await fetch(`${GEONIC_BASE_URL}/entities/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: headers(),
    });
    if (!res.ok) console.warn(`  削除失敗 ${id}: ${res.status}`);
  }
}

async function main() {
  const reportIds = await listIds('DamageReport');
  await remove(reportIds);
  console.log(`被害報告を削除: ${reportIds.length} 件`);

  const supplyIds = await listIds('SupplyRequest');
  await remove(supplyIds);
  console.log(`物資要求を削除: ${supplyIds.length} 件`);

  const shelterIds = await listIds('Shelter');

  if (process.argv.includes('--shelters')) {
    await remove(shelterIds);
    console.log(`避難所を削除: ${shelterIds.length} 件`);
    return;
  }

  for (const id of shelterIds) {
    const res = await fetch(`${GEONIC_BASE_URL}/entities/${encodeURIComponent(id)}/attrs`, {
      method: 'PATCH',
      headers: headers('application/json'),
      body: JSON.stringify({
        status: { type: 'Property', value: 'closed' },
        evacueeCount: { type: 'Property', value: 0 },
      }),
    });
    if (!res.ok) console.warn(`  リセット失敗 ${id}: ${res.status}`);
  }
  console.log(`避難所を未開設に戻しました: ${shelterIds.length} 件`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
