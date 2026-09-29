require('dotenv').config();
const path = require('path');
const express = require('express');
const { SUPPLY_ITEMS, SUPPLY_ITEMS_BY_CODE } = require('./supply-items');
const { createDemoStore } = require('./demo-store');

const app = express();
const PORT = process.env.PORT || 3000;

const GEONIC_BASE_URL = process.env.GEONIC_BASE_URL || 'https://geonicdb.geolonia.com/ngsi-ld/v1';
const GEONIC_API_KEY = process.env.GEONIC_API_KEY;
const GEONIC_SERVICE = process.env.GEONIC_SERVICE;

// GeonicDB の接続情報が無ければ、メモリ上のサンプルデータで動く「デモモード」にする
const DEMO_MODE = !GEONIC_API_KEY || !GEONIC_SERVICE;
const demoStore = DEMO_MODE ? createDemoStore() : null;

// localhost や GitHub Pages などではデモキー "YOUR-API-KEY" がそのまま使える。
// 独自ドメインで公開する場合のみ app.geolonia.com でキーを発行して .env に設定する。
const GEOLONIA_DEMO_KEY = 'YOUR-API-KEY';
const GEOLONIA_API_KEY =
  !process.env.GEOLONIA_API_KEY || process.env.GEOLONIA_API_KEY === 'YOUR-GEOLONIA-API-KEY'
    ? GEOLONIA_DEMO_KEY
    : process.env.GEOLONIA_API_KEY;

const CORE_CONTEXT = 'https://uri.etsi.org/ngsi-ld/v1/ngsi-ld-core-context.jsonld';
const MUNICIPALITY = '目黒区';

// 避難所の開設状況と被害報告は、誰が入力したかを残す
const OPERATOR_ROLES = ['参集指定職員', '都市整備部職員', '災対本部職員'];

// 避難所自体の被害状況
const BUILDING_DAMAGE = ['none', 'minor', 'severe'];
const SHELTER_UTILITY_STATUS = ['available', 'unavailable', 'unknown'];

// 避難所の開設状況。空きあり／混雑／満員は「開設中」として扱い、閉鎖のみ非開設扱いにする。
const SHELTER_STATUSES = ['available', 'crowded', 'full', 'closed'];
const OPEN_SHELTER_STATUSES = ['available', 'crowded', 'full'];
const isOpenShelterStatus = (status) => OPEN_SHELTER_STATUSES.includes(status);

if (DEMO_MODE) {
  console.warn(
    '[info] GEONIC_API_KEY / GEONIC_SERVICE が .env に設定されていないため、デモモード（メモリ上のサンプルデータ）で起動します。',
  );
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function geonicHeaders(contentType) {
  const headers = {
    'X-Api-Key': GEONIC_API_KEY,
    'NGSILD-Tenant': GEONIC_SERVICE,
    Accept: 'application/json',
  };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

async function geonic(pathname, { method = 'GET', body, contentType, query } = {}) {
  if (DEMO_MODE) return demoGeonic(pathname, { method, body, query });

  const url = new URL(`${GEONIC_BASE_URL}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }

  const res = await fetch(url, {
    method,
    headers: geonicHeaders(contentType),
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`GeonicDB ${method} ${pathname} -> ${res.status}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }

  // 201 Created / 204 No Content は本文が空で返るため、本文の有無で判定する
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// デモモード（GeonicDB キー未設定）のとき、geonic() の呼び出し先をメモリ上のストアに差し替える
function demoGeonic(pathname, { method, body, query }) {
  const attrsMatch = pathname.match(/^\/entities\/([^/]+)\/attrs$/);
  const idMatch = pathname.match(/^\/entities\/([^/]+)$/);

  if (pathname === '/entities' && method === 'GET') return demoStore.query(query || {});
  if (pathname === '/entities' && method === 'POST') {
    demoStore.create(body);
    return null;
  }
  if (attrsMatch && method === 'PATCH') {
    demoStore.patchAttrs(decodeURIComponent(attrsMatch[1]), body);
    return null;
  }
  if (idMatch && method === 'GET') return demoStore.get(decodeURIComponent(idMatch[1]));
  if (idMatch && method === 'DELETE') {
    demoStore.remove(decodeURIComponent(idMatch[1]));
    return null;
  }

  const err = new Error(`デモモード: 未対応の操作です (${method} ${pathname})`);
  err.status = 500;
  throw err;
}

// NGSI-LD の simplified 表現をそのまま GeoJSON に変換する
function toFeatureCollection(entities) {
  const features = entities
    .filter((e) => e.location && e.location.type === 'Point')
    .map((e) => {
      const { location, id, type, ...properties } = e;
      return {
        type: 'Feature',
        geometry: location,
        properties: { id, entityType: type, ...properties },
      };
    });

  return { type: 'FeatureCollection', features };
}

// key-value のオブジェクトを NGSI-LD の Property / GeoProperty 表現に包む
function toNgsiLd(id, type, attributes) {
  const entity = { '@context': CORE_CONTEXT, id, type };

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    entity[key] =
      value && typeof value === 'object' && value.type === 'Point'
        ? { type: 'GeoProperty', value }
        : { type: 'Property', value };
  }

  return entity;
}

function toNgsiLdAttrs(attributes) {
  const attrs = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;
    attrs[key] =
      value && typeof value === 'object' && value.type === 'Point'
        ? { type: 'GeoProperty', value }
        : { type: 'Property', value };
  }
  return attrs;
}

function handleError(res) {
  return (err) => {
    console.error(err.message, err.detail || '');
    res.status(err.status || 502).json({ error: err.message, detail: err.detail });
  };
}

app.get('/api/config', (_req, res) => {
  res.json({
    geoloniaApiKey: GEOLONIA_API_KEY,
    municipality: MUNICIPALITY,
    operatorRoles: OPERATOR_ROLES,
    demoMode: DEMO_MODE,
  });
});

function invalidOperator(value) {
  return value !== undefined && !OPERATOR_ROLES.includes(value);
}

// --- 区民向けの公開情報 ---

// 区民向けページには公表してよい項目だけを返す。
// 備考や入力者は庁内の運用メモなので含めない。
app.get('/api/public/shelters', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'Shelter', limit: 1000, options: 'keyValues' },
    });

    const shelters = entities.map((shelter) => ({
      id: shelter.id,
      name: shelter.name,
      address: shelter.address,
      status: shelter.status || 'closed',
      evacueeCount: Number(shelter.evacueeCount) || 0,
      hazardTypes: shelter.hazardTypes || [],
      updatedAt: shelter.updatedAt,
      location: shelter.location,
    }));

    res.json({
      municipality: MUNICIPALITY,
      generatedAt: new Date().toISOString(),
      openCount: shelters.filter((s) => isOpenShelterStatus(s.status)).length,
      totalCount: shelters.length,
      evacueeTotal: shelters.reduce((sum, s) => sum + (s.status === 'closed' ? 0 : s.evacueeCount), 0),
      shelters,
    });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 発災情報（災害ごとに画面を仕切り直す） ---
//
// Incident は「現在進行中の災害」を表すエンティティ。isActive:true のものが常に1件だけ存在する。
// 「新しい災害を開始する」= 今のアクティブな Incident を閉じて新しい Incident を作り、
// 避難所・ライフラインなど「現在の状態」を表すエンティティを初期状態に戻すこと。
// 被害報告・物資要求・割当・全体共有・情報発信は、作成時点のアクティブな Incident の id を
// incidentId 属性として持たせることで、災害ごとに記録を分離する（過去分は削除せず残す）。

async function findActiveIncident() {
  const results = await geonic('/entities', {
    query: { type: 'Incident', q: 'isActive==true', limit: 1, options: 'keyValues' },
  });
  return results[0] || null;
}

// incidentId で絞り込む q 式を組み立てる。extra を渡すと AND 条件として連結する。
function scopedQuery(incidentId, extra) {
  const clause = `incidentId=="${incidentId}"`;
  return extra ? `${clause};${extra}` : clause;
}

// 画面は URL の ?incidentId= で「どの災害を開いているタブか」を指定できる（別タブ＝別の災害）。
// 指定が無ければ、今アクティブな災害を対象にする。
// source は 'query'（GET 用）か 'body'（POST 用）を渡す。
async function resolveIncident(req, source) {
  const requestedId = source === 'body' ? req.body.incidentId : req.query.incidentId;
  if (requestedId) {
    return geonic(`/entities/${encodeURIComponent(requestedId)}`, { query: { options: 'keyValues' } }).catch(() => null);
  }
  return findActiveIncident();
}

function incidentNotFoundError(req, source) {
  const requestedId = source === 'body' ? req.body.incidentId : req.query.incidentId;
  return requestedId
    ? { status: 404, error: '指定した災害が見つかりません' }
    : { status: 409, error: '進行中の災害がありません。先に「新しい災害を開始する」を行ってください。' };
}

app.get('/api/incident', async (_req, res) => {
  try {
    res.json({ incident: await findActiveIncident() });
  } catch (err) {
    handleError(res)(err);
  }
});

app.get('/api/incidents', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'Incident', limit: 1000, options: 'keyValues' },
    });
    entities.sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt));
    res.json({ incidents: entities });
  } catch (err) {
    handleError(res)(err);
  }
});

// 進行中の災害の名前・発災時刻だけを直す（仕切り直しではない軽い修正用）
app.put('/api/incident', async (req, res) => {
  const { name, occurredAt, declaredBy } = req.body;

  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    res.status(400).json({ error: `発災時刻の形式が不正です: ${occurredAt}` });
    return;
  }
  if (invalidOperator(declaredBy)) {
    res.status(400).json({ error: `入力者が不正です: ${declaredBy}` });
    return;
  }

  try {
    const active = await findActiveIncident();
    if (!active) {
      res.status(404).json({ error: '進行中の災害がありません。先に「新しい災害を開始する」を行ってください。' });
      return;
    }

    await geonic(`/entities/${encodeURIComponent(active.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({
        name: name || active.name,
        occurredAt: new Date(occurredAt).toISOString(),
        declaredBy: declaredBy || active.declaredBy,
        updatedAt: new Date().toISOString(),
      }),
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// 避難所・丁目ライフライン・一時滞在施設を初期状態に戻す。
// 備蓄倉庫の在庫は物理的なモノなので、災害の仕切り直しでは変えない。
async function resetOperationalState() {
  const now = new Date().toISOString();

  const [shelters, lifelines, stays] = await Promise.all([
    geonic('/entities', { query: { type: 'Shelter', limit: 1000, options: 'keyValues' } }),
    geonic('/entities', { query: { type: 'LifelineStatus', limit: 1000, options: 'keyValues' } }),
    geonic('/entities', { query: { type: 'TemporaryStayFacility', limit: 1000, options: 'keyValues' } }),
  ]);

  const patch = (id, attrs) =>
    geonic(`/entities/${encodeURIComponent(id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs(attrs),
    });

  const runInBatches = async (items, fn, batchSize = 10) => {
    for (let i = 0; i < items.length; i += batchSize) {
      await Promise.all(items.slice(i, i + batchSize).map(fn));
    }
  };

  await runInBatches(shelters, (s) =>
    patch(s.id, {
      status: 'closed',
      evacueeCount: 0,
      buildingDamage: 'none',
      electricity: 'unknown',
      water: 'unknown',
      toilet: 'unknown',
      internet: 'unknown',
      note: '',
      damageNote: '',
      updatedBy: '',
      updatedAt: now,
    }),
  );

  await runInBatches(lifelines, (l) =>
    patch(l.id, { electricity: 'available', gas: 'available', water: 'available', sewer: 'available', note: '', updatedAt: now }),
  );

  await runInBatches(stays, (s) => patch(s.id, { status: 'closed', note: '', updatedAt: now }));
}

// 「新しい災害を開始する」= 今の画面を仕切り直す本体
app.post('/api/incidents', async (req, res) => {
  const { name, occurredAt, declaredBy } = req.body;

  if (!name || !String(name).trim()) {
    res.status(400).json({ error: '災害名が必要です' });
    return;
  }
  if (!occurredAt || Number.isNaN(Date.parse(occurredAt))) {
    res.status(400).json({ error: `発災時刻の形式が不正です: ${occurredAt}` });
    return;
  }
  if (invalidOperator(declaredBy)) {
    res.status(400).json({ error: `入力者が不正です: ${declaredBy}` });
    return;
  }

  const now = new Date().toISOString();
  const id = `urn:ngsi-ld:Incident:meguro-${Date.now()}`;

  try {
    const previous = await findActiveIncident();
    if (previous) {
      await geonic(`/entities/${encodeURIComponent(previous.id)}/attrs`, {
        method: 'PATCH',
        contentType: 'application/json',
        body: toNgsiLdAttrs({ isActive: false, closedAt: now, closedBy: declaredBy }),
      });
    }

    await geonic('/entities', {
      method: 'POST',
      contentType: 'application/ld+json',
      body: toNgsiLd(id, 'Incident', {
        name: String(name).trim(),
        occurredAt: new Date(occurredAt).toISOString(),
        declaredBy: declaredBy || OPERATOR_ROLES[2],
        municipality: MUNICIPALITY,
        isActive: true,
        updatedAt: now,
      }),
    });

    await resetOperationalState();

    res.status(201).json({ ok: true, id, previousClosed: previous ? previous.id : null });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 避難所 ---

app.get('/api/shelters', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'Shelter', limit: 1000, options: 'keyValues' },
    });
    res.json(toFeatureCollection(entities));
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/shelters/:id', async (req, res) => {
  const { status, evacueeCount, note, updatedBy, buildingDamage, electricity, water, toilet, internet, damageNote } = req.body;

  if (invalidOperator(updatedBy)) {
    res.status(400).json({ error: `入力者が不正です: ${updatedBy}` });
    return;
  }
  if (status !== undefined && !SHELTER_STATUSES.includes(status)) {
    res.status(400).json({ error: `開設状況の値が不正です: ${status}` });
    return;
  }
  if (buildingDamage !== undefined && !BUILDING_DAMAGE.includes(buildingDamage)) {
    res.status(400).json({ error: `建物被害の値が不正です: ${buildingDamage}` });
    return;
  }
  for (const [key, value] of Object.entries({ electricity, water, toilet, internet })) {
    if (value !== undefined && !SHELTER_UTILITY_STATUS.includes(value)) {
      res.status(400).json({ error: `${key} の値が不正です: ${value}` });
      return;
    }
  }

  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({
        status,
        evacueeCount,
        note,
        updatedBy,
        buildingDamage,
        electricity,
        water,
        toilet,
        internet,
        damageNote,
        updatedAt: new Date().toISOString(),
      }),
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 被害報告 ---

app.get('/api/damage-reports', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    if (!incident) {
      res.json({ type: 'FeatureCollection', features: [] });
      return;
    }
    const entities = await geonic('/entities', {
      query: { type: 'DamageReport', limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) },
    });
    res.json(toFeatureCollection(entities));
  } catch (err) {
    handleError(res)(err);
  }
});

app.post('/api/damage-reports', async (req, res) => {
  const { category, severity, description, locationNote, reporter, longitude, latitude } = req.body;

  if (typeof longitude !== 'number' || typeof latitude !== 'number') {
    res.status(400).json({ error: '座標が必要です' });
    return;
  }
  if (!category) {
    res.status(400).json({ error: '被害種別が必要です' });
    return;
  }
  if (invalidOperator(reporter)) {
    res.status(400).json({ error: `入力者が不正です: ${reporter}` });
    return;
  }

  const id = `urn:ngsi-ld:DamageReport:meguro-${Date.now()}`;

  try {
    const incident = await resolveIncident(req, 'body');
    if (!incident) {
      const { status, error } = incidentNotFoundError(req, 'body');
      res.status(status).json({ error });
      return;
    }

    await geonic('/entities', {
      method: 'POST',
      contentType: 'application/ld+json',
      body: toNgsiLd(id, 'DamageReport', {
        category,
        severity: severity || 'minor',
        status: 'reported',
        description: description || '',
        locationNote: locationNote || '',
        reporter: reporter || OPERATOR_ROLES[0],
        municipality: MUNICIPALITY,
        incidentId: incident.id,
        incidentName: incident.name,
        reportedAt: new Date().toISOString(),
        location: { type: 'Point', coordinates: [longitude, latitude] },
      }),
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/damage-reports/:id', async (req, res) => {
  const { status, severity, description, locationNote, progressNote, updatedBy } = req.body;

  if (invalidOperator(updatedBy)) {
    res.status(400).json({ error: `入力者が不正です: ${updatedBy}` });
    return;
  }

  const now = new Date().toISOString();

  try {
    const attrs = { status, severity, description, locationNote, updatedBy, updatedAt: now };

    // 追記は上書きせず履歴として積む。現場の経過が消えると本部が判断を誤るため。
    if (progressNote && String(progressNote).trim()) {
      const current = await geonic(`/entities/${encodeURIComponent(req.params.id)}`, {
        query: { options: 'keyValues' },
      });

      attrs.updates = [
        ...(current.updates || []),
        {
          at: now,
          by: updatedBy || OPERATOR_ROLES[0],
          note: String(progressNote).trim(),
          status: status || current.status,
        },
      ];
    }

    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs(attrs),
    });

    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 救援物資の要求 ---

app.get('/api/supply-items', (_req, res) => {
  res.json({ items: SUPPLY_ITEMS });
});

app.get('/api/supply-requests', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    if (!incident) {
      res.json({ requests: [] });
      return;
    }
    const entities = await geonic('/entities', {
      query: { type: 'SupplyRequest', limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) },
    });
    res.json({ requests: entities });
  } catch (err) {
    handleError(res)(err);
  }
});

app.post('/api/supply-requests', async (req, res) => {
  const { shelterId, requester, items } = req.body;

  if (!shelterId || !Array.isArray(items) || items.length === 0) {
    res.status(400).json({ error: '避難所と品目が必要です' });
    return;
  }

  const requests = [];
  for (const { item, quantity } of items) {
    const master = SUPPLY_ITEMS_BY_CODE.get(item);
    if (!master) {
      res.status(400).json({ error: `不明な品目です: ${item}` });
      return;
    }
    if (!Number.isFinite(Number(quantity)) || Number(quantity) <= 0) {
      res.status(400).json({ error: `${master.name} の数量が不正です` });
      return;
    }
    requests.push({ master, quantity: Number(quantity) });
  }

  try {
    const incident = await resolveIncident(req, 'body');
    if (!incident) {
      const { status, error } = incidentNotFoundError(req, 'body');
      res.status(status).json({ error });
      return;
    }

    const shelter = await geonic(`/entities/${encodeURIComponent(shelterId)}`, {
      query: { options: 'keyValues' },
    });

    const requestedAt = new Date().toISOString();
    const created = [];

    for (const [index, { master, quantity }] of requests.entries()) {
      const id = `urn:ngsi-ld:SupplyRequest:meguro-${Date.now()}-${index}`;
      await geonic('/entities', {
        method: 'POST',
        contentType: 'application/ld+json',
        body: toNgsiLd(id, 'SupplyRequest', {
          shelterId,
          shelterName: shelter.name,
          item: master.code,
          itemName: master.name,
          unit: master.unit,
          category: master.category,
          quantity,
          status: 'requested',
          requester: requester || '避難所運営班',
          municipality: MUNICIPALITY,
          incidentId: incident.id,
          incidentName: incident.name,
          requestedAt,
          location: shelter.location,
        }),
      });
      created.push(id);
    }

    res.status(201).json({ ok: true, created });
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/supply-requests/:id', async (req, res) => {
  const { status, quantity } = req.body;
  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({
        status,
        quantity: quantity === undefined ? undefined : Number(quantity),
        updatedAt: new Date().toISOString(),
      }),
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 備蓄倉庫・一時滞在施設（マスタ情報） ---

app.get('/api/warehouses', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'StockpileWarehouse', limit: 1000, options: 'keyValues' },
    });
    res.json(toFeatureCollection(entities));
  } catch (err) {
    handleError(res)(err);
  }
});

app.get('/api/temporary-stays', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'TemporaryStayFacility', limit: 1000, options: 'keyValues' },
    });
    res.json(toFeatureCollection(entities));
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/temporary-stays/:id', async (req, res) => {
  const { status, note } = req.body;
  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({ status, note, updatedAt: new Date().toISOString() }),
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 物資の割当（備蓄倉庫 → 避難所） ---

const ALLOCATION_STATUSES = ['allocated', 'shipped', 'delivered'];

app.get('/api/allocations', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    if (!incident) {
      res.json({ allocations: [] });
      return;
    }
    const entities = await geonic('/entities', {
      query: { type: 'SupplyAllocation', limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) },
    });
    res.json({ allocations: entities });
  } catch (err) {
    handleError(res)(err);
  }
});

// 割当と同時に倉庫在庫を減らす。在庫が足りなければ何も変更せずに 409 を返す。
app.post('/api/allocations', async (req, res) => {
  const { warehouseId, shelterId, requestId, item, quantity, operator } = req.body;
  const amount = Number(quantity);

  if (!warehouseId || !shelterId || !item) {
    res.status(400).json({ error: '倉庫・避難所・品目が必要です' });
    return;
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    res.status(400).json({ error: '数量は1以上の整数で指定してください' });
    return;
  }

  const master = SUPPLY_ITEMS_BY_CODE.get(item);
  if (!master) {
    res.status(400).json({ error: `不明な品目です: ${item}` });
    return;
  }

  try {
    const incident = await resolveIncident(req, 'body');
    if (!incident) {
      const { status: httpStatus, error } = incidentNotFoundError(req, 'body');
      res.status(httpStatus).json({ error });
      return;
    }

    const [warehouse, shelter] = await Promise.all([
      geonic(`/entities/${encodeURIComponent(warehouseId)}`, { query: { options: 'keyValues' } }),
      geonic(`/entities/${encodeURIComponent(shelterId)}`, { query: { options: 'keyValues' } }),
    ]);

    const inventory = warehouse.inventory || [];
    const line = inventory.find((entry) => entry.item === item);

    if (!line || line.quantity < amount) {
      res.status(409).json({
        error: `${warehouse.name} の在庫が不足しています（在庫 ${line ? line.quantity : 0} ${master.unit}、要求 ${amount} ${master.unit}）`,
      });
      return;
    }

    const updatedInventory = inventory.map((entry) =>
      entry.item === item ? { ...entry, quantity: entry.quantity - amount } : entry,
    );

    await geonic(`/entities/${encodeURIComponent(warehouseId)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({ inventory: updatedInventory, updatedAt: new Date().toISOString() }),
    });

    const id = `urn:ngsi-ld:SupplyAllocation:meguro-${Date.now()}`;

    await geonic('/entities', {
      method: 'POST',
      contentType: 'application/ld+json',
      body: toNgsiLd(id, 'SupplyAllocation', {
        warehouseId,
        warehouseName: warehouse.name,
        shelterId,
        shelterName: shelter.name,
        requestId,
        item: master.code,
        itemName: master.name,
        unit: master.unit,
        quantity: amount,
        status: 'allocated',
        operator: operator || '災害対策本部',
        municipality: MUNICIPALITY,
        incidentId: incident.id,
        incidentName: incident.name,
        allocatedAt: new Date().toISOString(),
        location: shelter.location,
      }),
    });

    // 元の要求を手配済みに進める
    if (requestId) {
      await geonic(`/entities/${encodeURIComponent(requestId)}/attrs`, {
        method: 'PATCH',
        contentType: 'application/json',
        body: toNgsiLdAttrs({ status: 'arranged', updatedAt: new Date().toISOString() }),
      });
    }

    res.status(201).json({ ok: true, id });
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/allocations/:id', async (req, res) => {
  const { status } = req.body;

  if (!ALLOCATION_STATUSES.includes(status)) {
    res.status(400).json({ error: `不明な状態です: ${status}` });
    return;
  }

  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({ status, updatedAt: new Date().toISOString() }),
    });

    // 配送完了なら元の要求も配送完了にする
    if (status === 'delivered') {
      const allocation = await geonic(`/entities/${encodeURIComponent(req.params.id)}`, {
        query: { options: 'keyValues' },
      });

      if (allocation.requestId) {
        await geonic(`/entities/${encodeURIComponent(allocation.requestId)}/attrs`, {
          method: 'PATCH',
          contentType: 'application/json',
          body: toNgsiLdAttrs({ status: 'delivered', updatedAt: new Date().toISOString() }),
        });
      }
    }

    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// 在庫の手動補正（補充・棚卸し）
app.patch('/api/warehouses/:id/inventory', async (req, res) => {
  const { item, quantity } = req.body;
  const amount = Number(quantity);

  if (!SUPPLY_ITEMS_BY_CODE.has(item)) {
    res.status(400).json({ error: `不明な品目です: ${item}` });
    return;
  }
  if (!Number.isInteger(amount) || amount < 0) {
    res.status(400).json({ error: '数量は0以上の整数で指定してください' });
    return;
  }

  try {
    const warehouse = await geonic(`/entities/${encodeURIComponent(req.params.id)}`, {
      query: { options: 'keyValues' },
    });

    const inventory = (warehouse.inventory || []).map((entry) =>
      entry.item === item ? { ...entry, quantity: amount } : entry,
    );

    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({ inventory, updatedAt: new Date().toISOString() }),
    });

    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 情報発信 ---

// 実際の配信は行わず、どの媒体でいつ何を流したかを記録するデモ実装
const BROADCAST_CHANNELS = {
  line: 'LINE',
  x: 'X',
  yahoo: 'Yahoo!防災速報',
  emergencyMail: '緊急速報メール',
  app: '防災アプリ',
  radio: '防災行政無線',
};

app.get('/api/broadcast-channels', (_req, res) => {
  res.json({ channels: BROADCAST_CHANNELS });
});

app.get('/api/radio-speakers', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'RadioSpeaker', limit: 1000, options: 'keyValues' },
    });
    res.json(toFeatureCollection(entities));
  } catch (err) {
    handleError(res)(err);
  }
});

// 予約分はバッチ処理で状態を書き換えず、配信時刻と現在時刻の比較で判定する。
// サーバーが止まっていた時間があっても表示がずれない。
function withBroadcastStatus(broadcast) {
  return { ...broadcast, status: new Date(broadcast.sentAt) > new Date() ? 'scheduled' : 'sent' };
}

app.get('/api/broadcasts', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    if (!incident) {
      res.json({ broadcasts: [] });
      return;
    }
    const entities = await geonic('/entities', {
      query: { type: 'Broadcast', limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) },
    });
    res.json({ broadcasts: entities.map(withBroadcastStatus) });
  } catch (err) {
    handleError(res)(err);
  }
});

// 予約の取り消し。すでに配信時刻を過ぎたものは取り消せない。
app.delete('/api/broadcasts/:id', async (req, res) => {
  try {
    const broadcast = await geonic(`/entities/${encodeURIComponent(req.params.id)}`, {
      query: { options: 'keyValues' },
    });

    if (new Date(broadcast.sentAt) <= new Date()) {
      res.status(409).json({ error: '配信済みのため取り消せません' });
      return;
    }

    await geonic(`/entities/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

app.post('/api/broadcasts', async (req, res) => {
  const { channels, body, sentBy, scheduledAt } = req.body;

  if (!Array.isArray(channels) || channels.length === 0) {
    res.status(400).json({ error: '発信媒体を1つ以上選んでください' });
    return;
  }
  for (const channel of channels) {
    if (!BROADCAST_CHANNELS[channel]) {
      res.status(400).json({ error: `不明な発信媒体です: ${channel}` });
      return;
    }
  }
  if (!body || !String(body).trim()) {
    res.status(400).json({ error: '発信内容が必要です' });
    return;
  }
  if (invalidOperator(sentBy)) {
    res.status(400).json({ error: `入力者が不正です: ${sentBy}` });
    return;
  }
  if (scheduledAt !== undefined && Number.isNaN(Date.parse(scheduledAt))) {
    res.status(400).json({ error: `配信日時の形式が不正です: ${scheduledAt}` });
    return;
  }

  const now = new Date();
  const deliverAt = scheduledAt ? new Date(scheduledAt) : now;

  // 過去を指定すると即時配信扱いになってしまうので弾く
  if (scheduledAt && deliverAt <= now) {
    res.status(400).json({ error: '配信日時は現在より後の時刻を指定してください' });
    return;
  }
  const id = `urn:ngsi-ld:Broadcast:meguro-${Date.now()}`;

  try {
    const incident = await resolveIncident(req, 'body');
    if (!incident) {
      const { status, error } = incidentNotFoundError(req, 'body');
      res.status(status).json({ error });
      return;
    }

    await geonic('/entities', {
      method: 'POST',
      contentType: 'application/ld+json',
      body: toNgsiLd(id, 'Broadcast', {
        channels,
        channelNames: channels.map((channel) => BROADCAST_CHANNELS[channel]),
        body: String(body).trim(),
        sentBy: sentBy || OPERATOR_ROLES[2],
        municipality: MUNICIPALITY,
        incidentId: incident.id,
        incidentName: incident.name,
        sentAt: deliverAt.toISOString(),
        registeredAt: now.toISOString(),
        isDemo: true,
      }),
    });

    res.status(201).json({ ok: true, id, scheduled: deliverAt > now });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- ライフライン（丁目ごとの使用可否） ---

const LIFELINE_UTILITIES = ['electricity', 'gas', 'water', 'sewer'];
const LIFELINE_STATUSES = ['available', 'partial', 'unavailable', 'unknown'];

app.get('/api/lifelines', async (_req, res) => {
  try {
    const entities = await geonic('/entities', {
      query: { type: 'LifelineStatus', limit: 1000, options: 'keyValues' },
    });

    // 丁目ポリゴンは area 属性に入っているので、それを geometry にした GeoJSON を返す
    const features = entities
      .filter((e) => e.area)
      .map((e) => {
        const { area, id, type, ...properties } = e;
        return { type: 'Feature', id: e.keyCode, geometry: area, properties: { id, ...properties } };
      });

    res.json({ type: 'FeatureCollection', features });
  } catch (err) {
    handleError(res)(err);
  }
});

app.patch('/api/lifelines/:id', async (req, res) => {
  const updates = {};

  for (const utility of LIFELINE_UTILITIES) {
    const value = req.body[utility];
    if (value === undefined) continue;
    if (!LIFELINE_STATUSES.includes(value)) {
      res.status(400).json({ error: `${utility} の値が不正です: ${value}` });
      return;
    }
    updates[utility] = value;
  }

  if (Object.keys(updates).length === 0) {
    res.status(400).json({ error: '更新する項目がありません' });
    return;
  }

  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}/attrs`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: toNgsiLdAttrs({ ...updates, note: req.body.note, updatedAt: new Date().toISOString() }),
    });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- ホワイトボードへの直接入力（全体共有事項） ---

// 本部設置・気象情報など、被害報告や避難所に紐づかない全体共有事項
const NOTICE_CATEGORIES = {
  hq: '本部設置・体制',
  weather: '気象情報',
  evacuation: '避難情報',
  request: '応援要請',
  lifeline: 'ライフライン',
  other: 'その他',
};

app.get('/api/notice-categories', (_req, res) => {
  res.json({ categories: NOTICE_CATEGORIES });
});

app.post('/api/notices', async (req, res) => {
  const { category, body, author, postedAt } = req.body;

  if (!body || !String(body).trim()) {
    res.status(400).json({ error: '内容が必要です' });
    return;
  }
  if (!NOTICE_CATEGORIES[category]) {
    res.status(400).json({ error: `不明な区分です: ${category}` });
    return;
  }
  if (postedAt !== undefined && Number.isNaN(Date.parse(postedAt))) {
    res.status(400).json({ error: `時刻の形式が不正です: ${postedAt}` });
    return;
  }

  const id = `urn:ngsi-ld:Notice:meguro-${Date.now()}`;

  try {
    const incident = await resolveIncident(req, 'body');
    if (!incident) {
      const { status, error } = incidentNotFoundError(req, 'body');
      res.status(status).json({ error });
      return;
    }

    await geonic('/entities', {
      method: 'POST',
      contentType: 'application/ld+json',
      body: toNgsiLd(id, 'Notice', {
        category,
        categoryName: NOTICE_CATEGORIES[category],
        body: String(body).trim(),
        author: author || '災害対策本部',
        municipality: MUNICIPALITY,
        incidentId: incident.id,
        incidentName: incident.name,
        // 後から記録することがあるので、時刻は入力値を優先する
        postedAt: postedAt ? new Date(postedAt).toISOString() : new Date().toISOString(),
        recordedAt: new Date().toISOString(),
      }),
    });
    res.status(201).json({ ok: true, id });
  } catch (err) {
    handleError(res)(err);
  }
});

app.delete('/api/notices/:id', async (req, res) => {
  try {
    await geonic(`/entities/${encodeURIComponent(req.params.id)}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 時系列（ホワイトボード代替） ---

app.get('/api/timeline', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    const scoped = (type) =>
      incident
        ? geonic('/entities', { query: { type, limit: 1000, options: 'keyValues,sysAttrs', q: scopedQuery(incident.id) } })
        : Promise.resolve([]);

    const [reports, shelters, supplies, notices, allocations, broadcasts] = await Promise.all([
      scoped('DamageReport'),
      geonic('/entities', { query: { type: 'Shelter', limit: 1000, options: 'keyValues,sysAttrs' } }),
      scoped('SupplyRequest'),
      scoped('Notice'),
      scoped('SupplyAllocation'),
      scoped('Broadcast'),
    ]);

    const events = [
      ...broadcasts.map((b) => {
        const scheduled = new Date(b.sentAt) > new Date();
        return {
          at: b.sentAt || b.createdAt,
          kind: 'broadcast',
          id: b.id,
          title: `${scheduled ? '【予約】' : ''}情報発信（${(b.channelNames || []).join('・')}）`,
          body: b.body,
          author: b.sentBy,
        };
      }),
      ...allocations.map((a) => ({
        at: a.updatedAt || a.allocatedAt || a.createdAt,
        kind: 'supply',
        id: a.id,
        title: `${a.warehouseName} → ${a.shelterName}`,
        body: `${a.itemName} ${a.quantity} ${a.unit}`,
        status: a.status,
      })),
      ...notices.map((n) => ({
        at: n.postedAt || n.createdAt,
        kind: 'notice',
        id: n.id,
        title: n.categoryName,
        body: n.body,
        author: n.author,
      })),
      ...supplies.map((s) => ({
        at: s.updatedAt || s.requestedAt || s.modifiedAt || s.createdAt,
        kind: 'supply',
        id: s.id,
        title: `${s.shelterName} 物資要求`,
        body: `${s.itemName} ${s.quantity} ${s.unit}`,
        status: s.status,
      })),
      ...reports.map((r) => ({
        at: r.updatedAt || r.reportedAt || r.modifiedAt || r.createdAt,
        kind: 'damage',
        id: r.id,
        title: `${r.category} / ${r.severity}`,
        body: r.description || '',
        status: r.status,
        author: r.updatedBy || r.reporter,
      })),
      ...shelters
        .filter((s) => s.status && s.status !== 'closed')
        .map((s) => ({
          at: s.updatedAt || s.modifiedAt || s.createdAt,
          kind: 'shelter',
          id: s.id,
          title: `${s.name}（${s.status}）`,
          body: s.evacueeCount != null ? `避難者 ${s.evacueeCount} 人` : '',
          status: s.status,
          author: s.updatedBy,
        })),
    ]
      .filter((e) => e.at)
      .sort((a, b) => new Date(b.at) - new Date(a.at))
      .slice(0, 100);

    res.json({ events });
  } catch (err) {
    handleError(res)(err);
  }
});

// --- 帳票（消防庁4号様式の集計相当） ---

app.get('/api/summary', async (req, res) => {
  try {
    const incident = await resolveIncident(req, 'query');
    const scoped = (type) =>
      incident ? geonic('/entities', { query: { type, limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) } }) : Promise.resolve([]);

    const [reports, shelters, supplies] = await Promise.all([
      scoped('DamageReport'),
      geonic('/entities', { query: { type: 'Shelter', limit: 1000, options: 'keyValues' } }),
      scoped('SupplyRequest'),
    ]);

    const byCategory = {};
    const byStatus = {};
    for (const r of reports) {
      byCategory[r.category] = (byCategory[r.category] || 0) + 1;
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    }

    const openShelters = shelters.filter((s) => isOpenShelterStatus(s.status));

    res.json({
      generatedAt: new Date().toISOString(),
      municipality: MUNICIPALITY,
      incident,
      damageTotal: reports.length,
      byCategory,
      byStatus,
      shelterTotal: shelters.length,
      shelterOpen: openShelters.length,
      evacueeTotal: openShelters.reduce((sum, s) => sum + (Number(s.evacueeCount) || 0), 0),
      supplyTotal: supplies.length,
      supplyPending: supplies.filter((s) => s.status === 'requested').length,
    });
  } catch (err) {
    handleError(res)(err);
  }
});

// 災対本部会議で読み上げる内容を1回のリクエストでまとめて返す。
// ?incidentId= を指定すると、過去に終了した災害の記録を参照できる（避難所・ライフラインは常に「今」の状態）。
app.get('/api/report', async (req, res) => {
  try {
    const incident = req.query.incidentId
      ? await geonic(`/entities/${encodeURIComponent(req.query.incidentId)}`, { query: { options: 'keyValues' } }).catch(() => null)
      : await findActiveIncident();

    const scoped = (type) =>
      incident
        ? geonic('/entities', { query: { type, limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) } })
        : Promise.resolve([]);

    const [reports, shelters, supplies, notices, allocations, lifelines] = await Promise.all([
      scoped('DamageReport'),
      geonic('/entities', { query: { type: 'Shelter', limit: 1000, options: 'keyValues' } }),
      scoped('SupplyRequest'),
      scoped('Notice'),
      scoped('SupplyAllocation'),
      geonic('/entities', { query: { type: 'LifelineStatus', limit: 1000, options: 'keyValues', attrs: 'chomeName,electricity,gas,water,sewer' } }),
    ]);

    const openShelters = shelters.filter((s) => isOpenShelterStatus(s.status));

    const byCategory = {};
    const byStatus = {};
    for (const report of reports) {
      byCategory[report.category] = (byCategory[report.category] || 0) + 1;
      byStatus[report.status] = (byStatus[report.status] || 0) + 1;
    }

    // ライフラインは丁目単位なので、使用可以外の丁目だけを拾う
    const lifelineIssues = {};
    for (const utility of LIFELINE_UTILITIES) {
      lifelineIssues[utility] = lifelines
        .filter((entry) => entry[utility] && entry[utility] !== 'available')
        .map((entry) => ({ chomeName: entry.chomeName, status: entry[utility] }));
    }

    res.json({
      generatedAt: new Date().toISOString(),
      municipality: MUNICIPALITY,
      incident,
      damage: { total: reports.length, byCategory, byStatus, reports },
      shelters: {
        total: shelters.length,
        open: openShelters.length,
        evacueeTotal: openShelters.reduce((sum, s) => sum + (Number(s.evacueeCount) || 0), 0),
        damaged: shelters.filter((s) => s.buildingDamage && s.buildingDamage !== 'none').length,
        list: openShelters,
      },
      supplies: {
        total: supplies.length,
        pending: supplies.filter((s) => s.status === 'requested').length,
        requests: supplies,
        allocations,
      },
      lifelineIssues,
      notices,
    });
  } catch (err) {
    handleError(res)(err);
  }
});

app.get('/api/summary.csv', async (req, res) => {
  try {
    const incident = req.query.incidentId
      ? await geonic(`/entities/${encodeURIComponent(req.query.incidentId)}`, { query: { options: 'keyValues' } }).catch(() => null)
      : await findActiveIncident();

    const reports = incident
      ? await geonic('/entities', {
          query: { type: 'DamageReport', limit: 1000, options: 'keyValues', q: scopedQuery(incident.id) },
        })
      : [];

    const header = ['id', '種別', '程度', '対応状況', '内容', '報告者', '報告時刻', '経度', '緯度'];
    const rows = reports.map((r) => [
      r.id,
      r.category,
      r.severity,
      r.status,
      r.description,
      r.reporter,
      r.reportedAt,
      r.location?.coordinates?.[0],
      r.location?.coordinates?.[1],
    ]);

    const csv = [header, ...rows]
      .map((row) => row.map((cell) => `"${String(cell ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="damage-reports.csv"');
    res.send(`﻿${csv}`); // Excel が UTF-8 と判定できるよう BOM を付ける
  } catch (err) {
    handleError(res)(err);
  }
});

app.listen(PORT, () => {
  console.log(`目黒区 災害情報共有システム: http://localhost:${PORT}`);
});
