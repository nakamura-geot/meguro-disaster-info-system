// 備蓄倉庫（StockpileWarehouse）と一時滞在施設（TemporaryStayFacility）を GeonicDB に投入する。
// どちらも元データに緯度経度がないため、住所から国土地理院のジオコーディングAPIで座標を求める。
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { SUPPLY_ITEMS_BY_CODE } = require('../supply-items');

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld';
const GSI_GEOCODER = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

function headers(contentType) {
  return {
    'X-Api-Key': process.env.GEONIC_API_KEY,
    'NGSILD-Tenant': process.env.GEONIC_SERVICE,
    ...(contentType ? { 'Content-Type': contentType } : {}),
  };
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

async function geocode(address) {
  const res = await fetch(`${GSI_GEOCODER}?q=${encodeURIComponent(address)}`);
  if (!res.ok) throw new Error(`ジオコーディング失敗 (${res.status}): ${address}`);

  const results = await res.json();
  if (!results.length) throw new Error(`住所が見つかりません: ${address}`);

  const [longitude, latitude] = results[0].geometry.coordinates;
  return { type: 'Point', coordinates: [longitude, latitude] };
}

async function upsert(entities) {
  const res = await fetch(`${GEONIC_BASE_URL}/entityOperations/upsert`, {
    method: 'POST',
    headers: headers('application/ld+json'),
    body: JSON.stringify(entities),
  });
  if (!res.ok) throw new Error(`upsert failed: ${res.status} ${await res.text()}`);
}

function readData(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', name), 'utf8'));
}

function slug(index) {
  return String(index + 1).padStart(3, '0');
}

// 在庫は標準倉庫（14.4㎡）あたりの箱数を、各倉庫の面積比で按分して初期値とする
function buildInventory(baseline, area) {
  const ratio = area / 14.4;

  return baseline.items.map(({ item, quantity }) => {
    const master = SUPPLY_ITEMS_BY_CODE.get(item);
    if (!master) throw new Error(`品目マスタに無いコードです: ${item}`);

    return {
      item: master.code,
      name: master.name,
      unit: master.unit,
      quantity: Math.round(quantity * ratio),
    };
  });
}

async function seedWarehouses() {
  const data = readData('meguro-stockpile.json');
  const entities = [];

  for (const [index, warehouse] of data.warehouses.entries()) {
    const fullAddress = `東京都目黒区${warehouse.address}`;
    const location = await geocode(fullAddress);

    entities.push({
      '@context': CORE_CONTEXT,
      id: `urn:ngsi-ld:StockpileWarehouse:meguro-${slug(index)}`,
      type: 'StockpileWarehouse',
      ...wrap({
        name: warehouse.name,
        district: warehouse.district,
        address: fullAddress,
        area: warehouse.area,
        builtYear: warehouse.builtYear,
        remarks: warehouse.remarks,
        municipality: '目黒区',
        stock: data.standardStock,
        inventory: buildInventory(data.inventoryBaseline, warehouse.area),
        inventoryNote: data.inventoryBaseline.note,
        source: data.source,
        coordinateSource: '国土地理院ジオコーディングAPI（住所から推定）',
        location,
      }),
    });
  }

  for (let i = 0; i < entities.length; i += 5) {
    await upsert(entities.slice(i, i + 5));
  }

  console.log(`備蓄倉庫: ${entities.length} 件`);
}

async function seedTemporaryStay() {
  const data = readData('meguro-temporary-stay.json');
  const entities = [];

  for (const [index, facility] of data.facilities.entries()) {
    const fullAddress = `東京都目黒区${facility.address}`;
    const location = await geocode(fullAddress);

    entities.push({
      '@context': CORE_CONTEXT,
      id: `urn:ngsi-ld:TemporaryStayFacility:meguro-${slug(index)}`,
      type: 'TemporaryStayFacility',
      ...wrap({
        name: facility.name,
        address: fullAddress,
        operator: facility.operator,
        municipality: '目黒区',
        status: 'closed',
        source: data.source,
        disclosureNote: data.note,
        coordinateSource: '国土地理院ジオコーディングAPI（住所から推定）',
        location,
      }),
    });
  }

  await upsert(entities);
  console.log(`一時滞在施設: ${entities.length} 件`);
}

async function main() {
  await seedWarehouses();
  await seedTemporaryStay();
  console.log('完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
