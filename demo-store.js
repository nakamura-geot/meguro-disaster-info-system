// デモモード用のインメモリ・データストア。
//
// GeonicDB の API キー（GEONIC_API_KEY / GEONIC_SERVICE）が .env に設定されていない場合、
// server.js はここで作った疑似 NGSI-LD ストアを使って動く。外部には一切通信しない。
// サーバーを再起動するとデータはリセットされる。
//
// 座標が無いオープンデータ（備蓄倉庫・一時滞在施設・防災行政無線）は、
// 実際の位置ではなく目黒区内に収まる仮の座標をふっている。あくまで画面操作を試すためのもの。

const fs = require('fs');
const path = require('path');
const { SUPPLY_ITEMS_BY_CODE } = require('./supply-items');

const DEMO_SOURCE_NOTE = 'デモ用サンプルデータ（座標・名称は仮のものです）';

function readData(name) {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', name), 'utf8'));
}

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

// NGSI-LD の Property/GeoProperty ラッパーを外して素の値に戻す
function unwrap(value) {
  return value && typeof value === 'object' && 'type' in value && 'value' in value ? value.value : value;
}

function unwrapEntity(entity) {
  const { '@context': _context, id, type, ...rest } = entity;
  const simplified = { id, type };
  for (const [key, value] of Object.entries(rest)) simplified[key] = unwrap(value);
  return simplified;
}

// NGSI-LD の簡易クエリ言語のうち、このアプリが使う `key==value` / `a==b;c==d` だけ対応
function matchesQ(entity, q) {
  if (!q) return true;
  return q.split(';').every((clause) => {
    const m = clause.match(/^([\w-]+)==(.*)$/);
    if (!m) return true;
    const [, key, rawVal] = m;
    let val = rawVal;
    if (val === 'true') val = true;
    else if (val === 'false') val = false;
    else if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    return entity[key] === val;
  });
}

function ringsOf(geometry) {
  return geometry.type === 'Polygon' ? [geometry.coordinates[0]] : geometry.coordinates.map((polygon) => polygon[0]);
}

function centroid(geometry) {
  let x = 0;
  let y = 0;
  let n = 0;
  for (const ring of ringsOf(geometry)) {
    for (const [lon, lat] of ring) {
      x += lon;
      y += lat;
      n += 1;
    }
  }
  return [Number((x / n).toFixed(6)), Number((y / n).toFixed(6))];
}

// 座標を持たないオープンデータ用に、目黒区内に収まる決定的な仮座標を作る
const MEGURO_BBOX = { minLon: 139.6616, maxLon: 139.7177, minLat: 35.6006, maxLat: 35.6642 };
function seededPoint(seed) {
  let h1 = 0;
  let h2 = 0;
  for (let i = 0; i < seed.length; i += 1) {
    h1 = (h1 * 31 + seed.charCodeAt(i)) >>> 0;
    h2 = (h2 * 131 + seed.charCodeAt(i)) >>> 0;
  }
  const lon = MEGURO_BBOX.minLon + ((h1 % 10000) / 10000) * (MEGURO_BBOX.maxLon - MEGURO_BBOX.minLon);
  const lat = MEGURO_BBOX.minLat + ((h2 % 10000) / 10000) * (MEGURO_BBOX.maxLat - MEGURO_BBOX.minLat);
  return { type: 'Point', coordinates: [Number(lon.toFixed(6)), Number(lat.toFixed(6))] };
}

function slug(prefix, index) {
  return `urn:ngsi-ld:${prefix}:demo-${String(index + 1).padStart(3, '0')}`;
}

// 標準倉庫（14.4㎡）あたりの公表値を、各倉庫の面積比で按分する（本番の投入スクリプトと同じ考え方）
function buildInventory(baseline, area) {
  const ratio = area / 14.4;
  return baseline.items.map(({ item, quantity }) => {
    const master = SUPPLY_ITEMS_BY_CODE.get(item);
    return { item: master.code, name: master.name, unit: master.unit, quantity: Math.round(quantity * ratio) };
  });
}

const SHELTER_HAZARD_PATTERNS = [
  ['地震'],
  ['地震', '大規模な火事'],
  ['地震', '洪水'],
  ['地震', '崖崩れ・土石流・地滑り'],
];

// 訓練シナリオ的な演出用に、一部の丁目だけライフラインを使用不可／一部使用可にする
const LIFELINE_DEMO_SCENARIO = {
  青葉台一丁目: { electricity: 'unavailable', gas: 'unavailable', water: 'partial' },
  青葉台二丁目: { electricity: 'unavailable', gas: 'unavailable', water: 'partial' },
  東山一丁目: { electricity: 'unavailable', gas: 'partial', water: 'unavailable', sewer: 'unavailable' },
  東山二丁目: { electricity: 'partial', water: 'unavailable' },
  上目黒一丁目: { electricity: 'partial', gas: 'unavailable' },
  中目黒一丁目: { electricity: 'partial' },
  下目黒一丁目: { water: 'unavailable', sewer: 'unavailable' },
  三田一丁目: { electricity: 'unavailable', water: 'partial' },
};

function createDemoStore() {
  const entities = new Map();
  const now = new Date().toISOString();
  const put = (entity) => entities.set(entity.id, entity);

  const chome = readData('meguro-chome.geojson');

  // --- ライフライン（丁目境界。実データの境界ポリゴンをそのまま使う） ---
  chome.features.forEach((feature) => {
    const { KEY_CODE, S_NAME, JINKO, SETAI } = feature.properties;
    const scenario = LIFELINE_DEMO_SCENARIO[S_NAME] || {};
    put({
      id: `urn:ngsi-ld:LifelineStatus:demo-${KEY_CODE}`,
      type: 'LifelineStatus',
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
      source: DEMO_SOURCE_NOTE,
      area: feature.geometry,
    });
  });

  // --- 避難所（丁目の中心座標にサンプルを配置。実在の施設名・座標ではない） ---
  let shelterIndex = 0;
  chome.features.forEach((feature, index) => {
    if (index % 7 !== 0) return;
    const [lon, lat] = centroid(feature.geometry);
    put({
      id: slug('Shelter', shelterIndex),
      type: 'Shelter',
      name: `${feature.properties.S_NAME} 地域避難所`,
      address: `目黒区${feature.properties.S_NAME}`,
      shelterType: 'designated',
      hazardTypes: SHELTER_HAZARD_PATTERNS[shelterIndex % SHELTER_HAZARD_PATTERNS.length],
      municipality: '目黒区',
      status: 'closed',
      evacueeCount: 0,
      buildingDamage: 'none',
      electricity: 'unknown',
      water: 'unknown',
      toilet: 'unknown',
      internet: 'unknown',
      capacity: 250 + (shelterIndex % 5) * 50,
      source: DEMO_SOURCE_NOTE,
      location: { type: 'Point', coordinates: [lon, lat] },
    });
    shelterIndex += 1;
  });

  // --- 備蓄倉庫（実データの倉庫一覧・在庫按分ロジックを使用。座標のみ仮） ---
  const stockpile = readData('meguro-stockpile.json');
  stockpile.warehouses.forEach((warehouse, index) => {
    put({
      id: slug('StockpileWarehouse', index),
      type: 'StockpileWarehouse',
      name: warehouse.name,
      district: warehouse.district,
      address: `目黒区${warehouse.address}`,
      area: warehouse.area,
      builtYear: warehouse.builtYear,
      remarks: warehouse.remarks,
      municipality: '目黒区',
      stock: stockpile.standardStock,
      inventory: buildInventory(stockpile.inventoryBaseline, warehouse.area),
      inventoryNote: stockpile.inventoryBaseline.note,
      source: stockpile.source,
      coordinateSource: DEMO_SOURCE_NOTE,
      location: seededPoint(`warehouse-${warehouse.name}-${warehouse.address}`),
    });
  });

  // --- 一時滞在施設 ---
  const tempStay = readData('meguro-temporary-stay.json');
  tempStay.facilities.forEach((facility, index) => {
    put({
      id: slug('TemporaryStayFacility', index),
      type: 'TemporaryStayFacility',
      name: facility.name,
      address: `目黒区${facility.address}`,
      operator: facility.operator,
      municipality: '目黒区',
      status: 'closed',
      source: tempStay.source,
      disclosureNote: tempStay.note,
      coordinateSource: DEMO_SOURCE_NOTE,
      location: seededPoint(`stay-${facility.name}-${facility.address}`),
    });
  });

  // --- 防災行政無線（屋外拡声機） ---
  const radioSpeakers = readData('meguro-radio-speakers.json');
  radioSpeakers.speakers.forEach((speaker, index) => {
    put({
      id: slug('RadioSpeaker', index),
      type: 'RadioSpeaker',
      name: speaker.name,
      address: `目黒区${speaker.address}`,
      audibleRadius: radioSpeakers.audibleRadius,
      source: radioSpeakers.source,
      coordinateSource: DEMO_SOURCE_NOTE,
      location: seededPoint(`speaker-${speaker.no}-${speaker.address}`),
    });
  });

  return {
    query({ type, q, limit } = {}) {
      let list = [...entities.values()];
      if (type) list = list.filter((e) => e.type === type);
      if (q) list = list.filter((e) => matchesQ(e, q));
      if (limit) list = list.slice(0, Number(limit));
      return clone(list);
    },

    get(id) {
      const entity = entities.get(id);
      if (!entity) {
        const err = new Error(`デモモード: エンティティが見つかりません (${id})`);
        err.status = 404;
        throw err;
      }
      return clone(entity);
    },

    create(ngsiLdEntity) {
      put(unwrapEntity(ngsiLdEntity));
    },

    patchAttrs(id, ngsiLdAttrs) {
      const entity = entities.get(id);
      if (!entity) {
        const err = new Error(`デモモード: エンティティが見つかりません (${id})`);
        err.status = 404;
        throw err;
      }
      for (const [key, value] of Object.entries(ngsiLdAttrs)) entity[key] = unwrap(value);
    },

    remove(id) {
      entities.delete(id);
    },
  };
}

module.exports = { createDemoStore };
