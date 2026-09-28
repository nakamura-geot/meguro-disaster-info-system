// 防災訓練シナリオのデモデータを投入する（避難所の開設状況 + 被害報告）。
// 実災害の記録と混同しないよう、被害報告には isDemo / scenario を付与する。
// 削除は scripts/clear-demo.js。
require('dotenv').config();
const { SUPPLY_ITEMS_BY_CODE } = require('../supply-items');

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld';
const SCENARIO = '防災訓練シナリオ（首都直下地震想定）';

// 開設する避難所（CSV の NO と対応）と、その避難者数・物資要求
// 避難所の開設状況は参集指定職員が入力し、本部が集約する運用を想定
// status は 空きあり(available) / 混雑(crowded) / 満員(full) / 閉鎖(closed)
const SHELTER_STATES = [
  { no: 2, status: 'available', evacueeCount: 128, damage: { buildingDamage: 'none', electricity: 'available', water: 'available', toilet: 'available', internet: 'available' }, supplies: [{ item: 'blanket', quantity: 10 }, { item: 'water', quantity: 9 }] },
  { no: 5, status: 'crowded', evacueeCount: 86, damage: { buildingDamage: 'minor', electricity: 'available', water: 'available', toilet: 'available', internet: 'unknown', damageNote: '外壁の一部にひび割れ。使用は可能' } },
  { no: 9, status: 'crowded', evacueeCount: 214, damage: { buildingDamage: 'none', electricity: 'available', water: 'unavailable', toilet: 'unavailable', internet: 'available', damageNote: '断水によりトイレ使用不可。仮設トイレを設置' }, supplies: [{ item: 'babyFormula', quantity: 2 }, { item: 'diaperBaby', quantity: 3 }] },
  { no: 12, status: 'full', evacueeCount: 305, note: '収容限界。近隣避難所への誘導を実施中', updatedBy: '災対本部職員', damage: { buildingDamage: 'minor', electricity: 'available', water: 'available', toilet: 'available', internet: 'unavailable', damageNote: '体育館の窓ガラスが破損、西側を立入禁止' }, supplies: [{ item: 'blanket', quantity: 20 }, { item: 'water', quantity: 21 }, { item: 'portableToiletBag', quantity: 12 }] },
  { no: 17, status: 'available', evacueeCount: 42, damage: { buildingDamage: 'none', electricity: 'unavailable', water: 'available', toilet: 'available', internet: 'unavailable', damageNote: '停電中。発電機で対応' } },
  { no: 23, status: 'available', evacueeCount: 61, damage: { buildingDamage: 'none', electricity: 'available', water: 'available', toilet: 'available', internet: 'available' }, supplies: [{ item: 'food', quantity: 3 }] },
  { no: 28, status: 'available', evacueeCount: 18, damage: { buildingDamage: 'none', electricity: 'available', water: 'available', toilet: 'available', internet: 'unknown' } },
  { no: 34, status: 'available', evacueeCount: 9, note: '開設準備完了、受入開始', damage: { buildingDamage: 'none', electricity: 'available', water: 'available', toilet: 'unknown', internet: 'unknown' } },
];

// 被害報告。座標は基準となる避難所からの相対位置で決め、目黒区内に収まるようにする
const DAMAGE_REPORTS = [
  { baseNo: 4, offset: [0.0012, -0.0008], category: 'road', severity: 'severe', status: 'responding', description: '山手通りで路面が陥没、片側通行止め', reporter: '都市整備部職員' },
  { baseNo: 7, offset: [-0.0009, 0.0011], category: 'building', severity: 'severe', status: 'reported', description: '木造2階建てが半壊。居住者2名は避難済み', reporter: '参集指定職員' },
  { baseNo: 11, offset: [0.0014, 0.0006], category: 'fire', severity: 'severe', status: 'responding', description: '住宅火災、消防隊が放水中。周辺住民を避難誘導', reporter: '災対本部職員' },
  { baseNo: 15, offset: [-0.0011, -0.0013], category: 'lifeline', severity: 'moderate', status: 'reported', description: '水道管破裂により道路が冠水', reporter: '都市整備部職員' },
  { baseNo: 19, offset: [0.0008, 0.0014], category: 'human', severity: 'moderate', status: 'responding', description: '転倒による負傷者1名、救急搬送中', reporter: '参集指定職員' },
  { baseNo: 25, offset: [-0.0013, 0.0007], category: 'road', severity: 'minor', status: 'resolved', description: '街路樹の倒木。撤去完了し通行再開', reporter: '都市整備部職員' },
  { baseNo: 31, offset: [0.001, -0.0012], category: 'lifeline', severity: 'moderate', status: 'resolved', description: '一部区域で停電。送電復旧済み', reporter: '災対本部職員' },
  { baseNo: 37, offset: [-0.0007, -0.0009], category: 'other', severity: 'minor', status: 'reported', description: '公園のフェンスが倒壊。立入制限中', reporter: '参集指定職員' },
];

function headers(contentType) {
  return {
    'X-Api-Key': process.env.GEONIC_API_KEY,
    'NGSILD-Tenant': process.env.GEONIC_SERVICE,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
}

function shelterId(no) {
  return `urn:ngsi-ld:Shelter:meguro-${String(no).padStart(3, '0')}`;
}

function wrap(attributes) {
  const attrs = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === '') continue;
    attrs[key] =
      value && typeof value === 'object' && value.type === 'Point'
        ? { type: 'GeoProperty', value }
        : { type: 'Property', value };
  }
  return attrs;
}

async function send(pathname, method, body, contentType) {
  const res = await fetch(`${GEONIC_BASE_URL}${pathname}`, {
    method,
    headers: headers(contentType),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${pathname} -> ${res.status} ${await res.text()}`);
}

// 存在しない属性の削除は 404 になるので、それは無視する
async function remove(pathname) {
  const res = await fetch(`${GEONIC_BASE_URL}${pathname}`, { method: 'DELETE', headers: headers() });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE ${pathname} -> ${res.status}`);
}

// 何度実行しても同じ結果になるよう、固定IDのエンティティは upsert で投入する
async function upsert(entity) {
  await send('/entityOperations/upsert', 'POST', [entity], 'application/ld+json');
}

// 経過時間表示の起点。デモ被害報告の最初の1件より前になるようにする。
// isActive:true にすることで「進行中の災害」として扱われ、以後の被害報告・物資要求等に
// この Incident の id が incidentId として自動的に付く（server.js 側の仕様）。
const INCIDENT_ID = 'urn:ngsi-ld:Incident:meguro-current';

async function seedIncident(occurredAt) {
  await upsert({
    '@context': CORE_CONTEXT,
    id: INCIDENT_ID,
    type: 'Incident',
    ...wrap({
      name: '首都直下地震（防災訓練）',
      occurredAt,
      declaredBy: '災対本部職員',
      municipality: '目黒区',
      isActive: true,
      updatedAt: new Date().toISOString(),
    }),
  });
  console.log(`発災時刻を設定: ${occurredAt}`);
}

async function main() {
  const res = await fetch(`${GEONIC_BASE_URL}/entities?type=Shelter&limit=1000&options=keyValues`, {
    headers: headers(),
  });
  if (!res.ok) throw new Error(`避難所の取得に失敗: ${res.status}`);

  const shelters = new Map((await res.json()).map((s) => [s.id, s]));
  const now = new Date().toISOString();

  let supplyCount = 0;

  for (const target of SHELTER_STATES) {
    const id = shelterId(target.no);
    const shelter = shelters.get(id);
    if (!shelter) {
      console.warn(`  skip ${id}（避難所マスタに存在しません）`);
      continue;
    }

    await send(
      `/entities/${encodeURIComponent(id)}/attrs`,
      'PATCH',
      wrap({
        status: target.status,
        evacueeCount: target.evacueeCount,
        note: target.note,
        updatedBy: target.updatedBy || '参集指定職員',
        updatedAt: now,
        ...(target.damage || {}),
      }),
      'application/json',
    );

    // 物資要求は SupplyRequest エンティティに移行したので、旧フリーテキスト属性は削除する
    await remove(`/entities/${encodeURIComponent(id)}/attrs/supplyRequest`);

    for (const [index, supply] of (target.supplies || []).entries()) {
      const master = SUPPLY_ITEMS_BY_CODE.get(supply.item);
      if (!master) {
        console.warn(`  skip 物資要求（不明な品目 ${supply.item}）`);
        continue;
      }

      await upsert(
        {
          '@context': CORE_CONTEXT,
          id: `urn:ngsi-ld:SupplyRequest:meguro-demo-${String(target.no).padStart(3, '0')}-${index + 1}`,
          type: 'SupplyRequest',
          ...wrap({
            shelterId: id,
            shelterName: shelter.name,
            item: master.code,
            itemName: master.name,
            unit: master.unit,
            category: master.category,
            quantity: supply.quantity,
            status: index === 0 ? 'requested' : 'arranged',
            requester: '避難所運営班',
            municipality: '目黒区',
            incidentId: INCIDENT_ID,
            incidentName: '首都直下地震（防災訓練）',
            requestedAt: now,
            isDemo: true,
            scenario: SCENARIO,
            location: shelter.location,
          }),
        },
        'application/ld+json',
      );
      supplyCount += 1;
    }
  }

  console.log(`避難所の開設状況を更新: ${SHELTER_STATES.length} 件`);
  console.log(`物資要求を作成: ${supplyCount} 件`);

  let created = 0;
  for (const [index, report] of DAMAGE_REPORTS.entries()) {
    const base = shelters.get(shelterId(report.baseNo));
    if (!base) {
      console.warn(`  skip 被害報告（基準避難所 ${report.baseNo} が見つかりません）`);
      continue;
    }

    const [lng, lat] = base.location.coordinates;
    // 報告時刻を発災からの経過時間としてずらし、時系列に並ぶようにする
    const reportedAt = new Date(Date.now() - (DAMAGE_REPORTS.length - index) * 11 * 60 * 1000).toISOString();

    await upsert({
      '@context': CORE_CONTEXT,
      id: `urn:ngsi-ld:DamageReport:meguro-demo-${String(index + 1).padStart(3, '0')}`,
      type: 'DamageReport',
      ...wrap({
        category: report.category,
        severity: report.severity,
        status: report.status,
        description: report.description,
        reporter: report.reporter,
        municipality: '目黒区',
        incidentId: INCIDENT_ID,
        incidentName: '首都直下地震（防災訓練）',
        reportedAt,
        updatedAt: reportedAt,
        isDemo: true,
        scenario: SCENARIO,
        location: { type: 'Point', coordinates: [Number((lng + report.offset[0]).toFixed(6)), Number((lat + report.offset[1]).toFixed(6))] },
      }),
    });
    created += 1;
  }

  console.log(`被害報告を作成: ${created} 件`);

  const firstReportAt = new Date(Date.now() - DAMAGE_REPORTS.length * 11 * 60 * 1000 - 10 * 60 * 1000);
  await seedIncident(firstReportAt.toISOString());

  console.log('完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
