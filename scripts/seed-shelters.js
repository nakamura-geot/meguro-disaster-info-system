// 目黒区オープンデータ「地域避難所」を GeonicDB の Shelter エンティティとして投入する。
// 出典: 目黒区（BODIK CKAN）/ CC BY 4.0
// 再実行すると upsert されるため、避難所マスタの更新にも使える。
require('dotenv').config();

const CSV_URL =
  'https://data.bodik.jp/dataset/ca5cf1d5-ed5d-4445-96df-3d60f9ed0eac/resource/2eab6c3a-520d-4cc4-99f2-5ac306c86da0/download/131105_evacuation_space_r7.10.csv';

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld';
const SOURCE = '目黒区オープンデータ「地域避難所」(CC BY 4.0)';

const HAZARD_COLUMNS = {
  災害種別_洪水: '洪水',
  '災害種別_崖崩れ、土石流及び地滑り': '崖崩れ・土石流・地滑り',
  災害種別_高潮: '高潮',
  災害種別_地震: '地震',
  災害種別_津波: '津波',
  災害種別_大規模な火事: '大規模な火事',
  災害種別_内水氾濫: '内水氾濫',
  災害種別_火山現象: '火山現象',
};

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function toEntity(record) {
  const latitude = Number(record['緯度']);
  const longitude = Number(record['経度']);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  const hazardTypes = Object.entries(HAZARD_COLUMNS)
    .filter(([column]) => (record[column] || '').trim() !== '')
    .map(([, label]) => label);

  const attributes = {
    name: record['名称'],
    nameKana: record['名称_カナ'],
    address: record['住所'].replace(/\s+/g, ''),
    shelterType: 'designated',
    hazardTypes,
    municipality: '目黒区',
    status: 'closed',
    evacueeCount: 0,
    source: SOURCE,
    location: { type: 'Point', coordinates: [longitude, latitude] },
  };

  const elevation = Number(record['標高（ｍ）']);
  if (Number.isFinite(elevation)) attributes.elevation = elevation;

  const capacity = Number(record['想定収容人数']);
  if (Number.isFinite(capacity) && capacity > 0) attributes.capacity = capacity;

  if ((record['備考'] || '').trim()) attributes.remarks = record['備考'].trim();

  const entity = {
    '@context': CORE_CONTEXT,
    id: `urn:ngsi-ld:Shelter:meguro-${String(record['NO']).padStart(3, '0')}`,
    type: 'Shelter',
  };

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === '') continue;
    entity[key] =
      value && typeof value === 'object' && value.type === 'Point'
        ? { type: 'GeoProperty', value }
        : { type: 'Property', value };
  }

  return entity;
}

async function upsert(entities) {
  const res = await fetch(`${GEONIC_BASE_URL}/entityOperations/upsert`, {
    method: 'POST',
    headers: {
      'X-Api-Key': process.env.GEONIC_API_KEY,
      'NGSILD-Tenant': process.env.GEONIC_SERVICE,
      'Content-Type': 'application/ld+json',
    },
    body: JSON.stringify(entities),
  });

  if (!res.ok) throw new Error(`upsert failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const res = await fetch(CSV_URL);
  if (!res.ok) throw new Error(`CSV の取得に失敗: ${res.status}`);

  // 目黒区の公開 CSV は Shift_JIS
  const text = new TextDecoder('shift_jis').decode(await res.arrayBuffer());
  const [header, ...rows] = parseCsv(text);

  const entities = rows
    .filter((row) => row.length >= header.length && row[0].trim() !== '')
    .map((row) => toEntity(Object.fromEntries(header.map((key, i) => [key.trim(), row[i] ?? '']))))
    .filter(Boolean);

  console.log(`投入対象: ${entities.length} 件`);

  for (let i = 0; i < entities.length; i += 10) {
    const chunk = entities.slice(i, i + 10);
    await upsert(chunk);
    console.log(`  ${i + chunk.length} / ${entities.length}`);
  }

  console.log('完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
