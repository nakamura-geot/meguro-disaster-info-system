// 防災行政無線の屋外拡声機（65か所）を GeonicDB に投入する。
// 出典は目黒区の公表一覧。座標は住所から国土地理院のジオコーディングAPIで求める。
require('dotenv').config();
const fs = require('fs');
const path = require('path');

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
  if (!results.length) return null;

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

async function main() {
  const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'meguro-radio-speakers.json'), 'utf8'));
  const entities = [];
  const failed = [];

  for (const speaker of data.speakers) {
    const fullAddress = `東京都目黒区${speaker.address}`;
    const location = await geocode(fullAddress);

    if (!location) {
      failed.push(speaker.name);
      continue;
    }

    entities.push({
      '@context': CORE_CONTEXT,
      id: `urn:ngsi-ld:RadioSpeaker:meguro-${String(speaker.no).padStart(3, '0')}`,
      type: 'RadioSpeaker',
      ...wrap({
        name: speaker.name,
        address: fullAddress,
        municipality: '目黒区',
        audibleRadius: data.audibleRadius,
        audibleRadiusNote: '実測値ではなく一般的な到達距離を仮置きした値',
        source: data.source,
        coordinateSource: '国土地理院ジオコーディングAPI（住所から推定）',
        location,
      }),
    });
  }

  for (let i = 0; i < entities.length; i += 10) {
    await upsert(entities.slice(i, i + 10));
    console.log(`  ${Math.min(i + 10, entities.length)} / ${entities.length}`);
  }

  console.log(`防災行政無線: ${entities.length} か所`);
  if (failed.length) console.warn(`座標が取れなかった箇所: ${failed.join('、')}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
