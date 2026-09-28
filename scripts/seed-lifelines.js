// 丁目ごとのライフライン使用可否（LifelineStatus）を GeonicDB に投入する。
// 丁目ポリゴンは e-Stat の国勢調査小地域境界データを GeoJSON 化したもの（data/meguro-chome.geojson）。
// 出典: 総務省統計局「令和2年国勢調査 小地域（町丁・字等別）境界データ」を加工して作成
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld';
const SOURCE = '総務省統計局「令和2年国勢調査 小地域（町丁・字等別）境界データ」を加工';

// 訓練シナリオ。ここに無い丁目は全て使用可（available）とする。
// unavailable=使用不可 / partial=一部使用可
const SCENARIO = {
  青葉台一丁目: { electricity: 'unavailable', gas: 'unavailable', water: 'partial' },
  青葉台二丁目: { electricity: 'unavailable', gas: 'unavailable', water: 'partial' },
  青葉台三丁目: { electricity: 'partial', gas: 'unavailable' },
  青葉台四丁目: { electricity: 'partial', gas: 'unavailable' },
  東山一丁目: { electricity: 'unavailable', gas: 'partial', water: 'unavailable', sewer: 'unavailable' },
  東山二丁目: { electricity: 'partial', water: 'unavailable', sewer: 'unavailable' },
  東山三丁目: { water: 'partial', sewer: 'partial' },
  上目黒一丁目: { electricity: 'partial', gas: 'unavailable' },
  上目黒二丁目: { gas: 'unavailable' },
  上目黒三丁目: { gas: 'unavailable', water: 'partial' },
  中目黒一丁目: { electricity: 'partial' },
  中目黒二丁目: { electricity: 'partial', gas: 'partial' },
  中目黒三丁目: { gas: 'partial' },
  下目黒一丁目: { water: 'unavailable', sewer: 'unavailable' },
  下目黒二丁目: { water: 'partial', sewer: 'unavailable' },
  下目黒三丁目: { sewer: 'partial' },
  三田一丁目: { electricity: 'unavailable', water: 'partial' },
  三田二丁目: { electricity: 'partial' },
  目黒本町一丁目: { gas: 'partial', sewer: 'partial' },
  目黒本町二丁目: { gas: 'partial' },
  洗足一丁目: { water: 'partial' },
  碑文谷二丁目: { electricity: 'partial', sewer: 'partial' },
  自由が丘一丁目: { gas: 'partial' },
};

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
      value && typeof value === 'object' && (value.type === 'Polygon' || value.type === 'Point')
        ? { type: 'GeoProperty', value }
        : { type: 'Property', value };
  }
  return attrs;
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
  const geojson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'meguro-chome.geojson'), 'utf8'));
  const now = new Date().toISOString();

  const entities = geojson.features.map((feature) => {
    const { KEY_CODE, S_NAME, JINKO, SETAI } = feature.properties;
    const scenario = SCENARIO[S_NAME] || {};

    return {
      '@context': CORE_CONTEXT,
      id: `urn:ngsi-ld:LifelineStatus:meguro-${KEY_CODE}`,
      type: 'LifelineStatus',
      ...wrap({
        keyCode: KEY_CODE,
        chomeName: S_NAME,
        municipality: '目黒区',
        population: JINKO,
        households: SETAI,
        electricity: scenario.electricity || 'available',
        gas: scenario.gas || 'available',
        water: scenario.water || 'available',
        sewer: scenario.sewer || 'available',
        updatedAt: now,
        source: SOURCE,
        area: feature.geometry,
      }),
    };
  });

  console.log(`投入対象: ${entities.length} 丁目`);

  for (let i = 0; i < entities.length; i += 5) {
    const chunk = entities.slice(i, i + 5);
    await upsert(chunk);
    console.log(`  ${i + chunk.length} / ${entities.length}`);
  }

  console.log('完了');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
