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
// 開設状況。空きあり／混雑／満員はどれも「開設中」として扱い、閉鎖だけが非開設。
const SHELTER_STATUS = { available: '空きあり', crowded: '混雑', full: '満員', closed: '閉鎖' };
const OPEN_SHELTER_STATUSES = ['available', 'crowded', 'full'];
const isShelterOpen = (status) => OPEN_SHELTER_STATUSES.includes(status);

const SHELTER_TYPES = { designated: '指定避難所', wide: '広域避難場所', welfare: '福祉避難所' };

const BUILDING_DAMAGE = { none: '被害なし', minor: '一部損壊（使用可）', severe: '大規模損壊（使用不可）' };

const SHELTER_UTILITY = { available: '使用可', unavailable: '使用不可', unknown: '未確認' };

const COLORS = {
  reported: '#dc2626',
  responding: '#f59e0b',
  resolved: '#16a34a',
  shelterOpen: '#2563eb',
  shelterCrowded: '#f59e0b',
  shelterFull: '#7c3aed',
  shelterClosed: '#9ca3af',
  warehouse: '#0f766e',
  warehouseEmpty: '#94a3b8',
  temporaryStay: '#c2410c',
  radio: '#0284c7',
};

// 避難所の開設状況に応じた色を1か所にまとめる（地図の丸・凡例・一覧のバッジで共通して使う）
function shelterStatusColor(status) {
  if (status === 'full') return COLORS.shelterFull;
  if (status === 'crowded') return COLORS.shelterCrowded;
  if (status === 'available') return COLORS.shelterOpen;
  return COLORS.shelterClosed;
}

const STAY_STATUS = { open: '開放中', closed: '未開放' };

const MEGURO_CENTER = [139.6982, 35.6339];

// geolonia/gsi は 2026-09-24 時点で存在しない source-layer を参照しており、タイルが描画されない。
// 復旧したら 'geolonia/gsi' に戻す。
const MAP_STYLE = 'geolonia/basic';

const REQUEST_STATUS = { requested: '要求中', arranged: '手配済', delivered: '配送完了' };

const REQUEST_COLORS = { requested: '#dc2626', arranged: '#f59e0b', delivered: '#16a34a' };

const TIMELINE_KINDS = { notice: '全体共有', damage: '被害報告', shelter: '避難所', supply: '物資', broadcast: '情報発信' };

const UTILITIES = { electricity: '電気', gas: 'ガス', water: '水道', sewer: '下水道' };

const LIFELINE_STATUS = { available: '使用可', partial: '一部使用可', unavailable: '使用不可', unknown: '不明' };

const LIFELINE_COLORS = {
  available: '#16a34a',
  partial: '#f59e0b',
  unavailable: '#dc2626',
  unknown: '#9ca3af',
};

const state = {
  map: null,
  mode: 'hq',
  popup: null,
  shelters: null,
  reports: null,
  supplyItems: [],
  supplyRequests: [],
  timeline: [],
  timelineKinds: new Set(Object.keys(TIMELINE_KINDS)),
  lifelines: null,
  activeUtility: null,
  warehouses: null,
  stays: null,
  allocations: [],
  selectedRequestId: null,
  selectedShelterId: null,
  selectedWarehouseId: null,
  operatorRoles: [],
  incident: null,
  // URL の ?incidentId= で指定された、この画面（タブ）が対象にする災害。
  // 未指定なら null のままで、その場合は常にアクティブな災害を対象にする。
  viewIncidentId: new URLSearchParams(location.search).get('incidentId') || null,
  // /api/summary が実際に解決した災害（過去分なら isActive:false で返る）
  viewedIncident: null,
  broadcastChannels: {},
  broadcasts: [],
  radioSpeakers: null,
  radioVisible: false,
};

async function main() {
  startClock();
  setupModeSwitch();

  const [config, supplyItems, noticeCategories, broadcastChannels] = await Promise.all([
    fetch('/api/config').then((r) => r.json()),
    fetch('/api/supply-items').then((r) => r.json()),
    fetch('/api/notice-categories').then((r) => r.json()),
    fetch('/api/broadcast-channels').then((r) => r.json()),
  ]);

  state.supplyItems = supplyItems.items;
  state.operatorRoles = config.operatorRoles;
  setupWhiteboard(noticeCategories.categories);
  setupBroadcast(broadcastChannels.channels);
  await loadGeoloniaScript(config.geoloniaApiKey);

  state.map = new geolonia.Map({
    container: 'map',
    style: MAP_STYLE,
    center: MEGURO_CENTER,
    zoom: 13,
  });

  state.map.on('error', (e) => console.error('地図の読み込みエラー', e.error || e));

  state.popup = new geolonia.Popup({ offset: 12, closeButton: false });

  // 地図スタイル側の不整合（存在しない source-layer の参照など）があると load が発火しないことがある。
  // スタイルが使える状態になったら起動できるよう、styledata からも起動して二重実行を防ぐ。
  let started = false;
  const start = () => {
    if (started || !state.map.getStyle()) return;
    started = true;

    initLayers().catch((err) => {
      console.error('地図の初期化に失敗しました', err);
      document.getElementById('summary').innerHTML =
        `<p class="empty">地図の初期化に失敗しました。${escapeHtml(err.message)}</p>`;
    });
  };

  state.map.on('load', start);
  state.map.on('styledata', start);
  if (state.map.isStyleLoaded()) start();
}

async function initLayers() {
    await addBoundary();
    addLifelineLayers();
    addRadioLayers();
    setupLifelineButtons();

    state.map.addSource('shelters', { type: 'geojson', data: emptyFc() });
    state.map.addSource('reports', { type: 'geojson', data: emptyFc() });
    state.map.addSource('warehouses', { type: 'geojson', data: emptyFc() });
    state.map.addSource('stays', { type: 'geojson', data: emptyFc() });

    // 備蓄倉庫・一時滞在施設は四角で描き、丸の避難所・被害報告と見分けられるようにする
    state.map.addLayer({
      id: 'warehouses-symbol',
      type: 'circle',
      source: 'warehouses',
      paint: {
        'circle-radius': 10,
        // totalStock は setData 前に markEmptyWarehouses で付与する（在庫0＝品目が空 or 全品目0）
        'circle-color': ['case', ['==', ['get', 'totalStock'], 0], COLORS.warehouseEmpty, COLORS.warehouse],
        'circle-opacity': ['case', ['==', ['get', 'totalStock'], 0], 0.55, 1],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });

    state.map.addLayer({
      id: 'stays-symbol',
      type: 'circle',
      source: 'stays',
      paint: {
        'circle-radius': 11,
        'circle-color': COLORS.temporaryStay,
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
      },
    });


    state.map.addLayer({
      id: 'shelters-circle',
      type: 'circle',
      source: 'shelters',
      paint: {
        'circle-radius': 11,
        'circle-color': [
          'match',
          ['get', 'status'],
          'available', COLORS.shelterOpen,
          'crowded', COLORS.shelterCrowded,
          'full', COLORS.shelterFull,
          'closed', COLORS.shelterClosed,
          COLORS.shelterClosed,
        ],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
      },
    });

    // 未対応の被害報告だけ、本体の丸の下に広がって消えるリングを重ねて点滅させる。
    // 対応中・対応完了になったら（＝ reported でなくなったら）自動で静止する。
    state.map.addLayer({
      id: 'reports-pulse',
      type: 'circle',
      source: 'reports',
      filter: ['==', ['get', 'status'], 'reported'],
      paint: {
        'circle-radius': 10,
        'circle-color': COLORS.reported,
        'circle-opacity': 0.6,
        'circle-stroke-width': 0,
      },
    });

    state.map.addLayer({
      id: 'reports-circle',
      type: 'circle',
      source: 'reports',
      paint: {
        'circle-radius': ['match', ['get', 'severity'], 'severe', 13, 'moderate', 11, 10],
        'circle-color': [
          'match',
          ['get', 'status'],
          'reported', COLORS.reported,
          'responding', COLORS.responding,
          'resolved', COLORS.resolved,
          COLORS.reported,
        ],
        'circle-stroke-width': 2,
        'circle-stroke-color': '#ffffff',
        'circle-opacity': ['match', ['get', 'status'], 'resolved', 0.55, 1],
      },
    });

    startReportsPulse();

    // 丸だけでは種別が分からないので、1文字のラベルを重ねる。
    // 全ての円レイヤーを追加したあとに重ねないと、円の下に隠れてしまう。
    addPinLabel('shelters', '避');
    addPinLabel('reports', '害');
    addPinLabel('warehouses', '備');
    addPinLabel('stays', '滞');
    addPinLabel('radio-speakers', '無');
    state.map.setLayoutProperty('radio-speakers-label', 'visibility', 'none');

    setupHover('radio-speakers-circle', radioPopupHtml);
    setupHover('shelters-circle', shelterPopupHtml);
    setupHover('reports-circle', reportPopupHtml);
    setupHover('warehouses-symbol', warehousePopupHtml);
    setupHover('stays-symbol', stayPopupHtml);
    setupMapClick();

    await refresh();
}

// --- 区界の表示 ---

// 出典: Geolonia japanese-admins（国土数値情報 行政区域データ由来）。
// 災害時に外部ホストへ依存しないよう public/data に取り込んである。
async function addBoundary() {
  const boundary = await fetch('/data/meguro-boundary.geojson').then((r) => r.json());
  const rings = outerRings(boundary);

  state.map.addSource('boundary', { type: 'geojson', data: boundary });
  state.map.addSource('boundary-mask', { type: 'geojson', data: maskOutside(rings) });

  // 区外を淡く覆い、区域を際立たせる
  state.map.addLayer({
    id: 'boundary-mask',
    type: 'fill',
    source: 'boundary-mask',
    paint: { 'fill-color': '#11213a', 'fill-opacity': 0.18 },
  });

  state.map.addLayer({
    id: 'boundary-line',
    type: 'line',
    source: 'boundary',
    paint: { 'line-color': '#11213a', 'line-width': 2.5, 'line-opacity': 0.9 },
  });

  state.map.fitBounds(ringBounds(rings), { padding: 24, duration: 0 });
}

function outerRings(geojson) {
  const rings = [];
  for (const feature of geojson.features) {
    const { type, coordinates } = feature.geometry;
    if (type === 'Polygon') rings.push(coordinates[0]);
    else if (type === 'MultiPolygon') coordinates.forEach((polygon) => rings.push(polygon[0]));
  }
  return rings;
}

// 世界全体のポリゴンに区域を穴として開け、区外だけを塗る
function maskOutside(rings) {
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return {
    type: 'FeatureCollection',
    features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ...rings] } }],
  };
}

function ringBounds(rings) {
  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;

  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      west = Math.min(west, lng);
      east = Math.max(east, lng);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }

  return [[west, south], [east, north]];
}

// --- 情報発信（デモ） ---

function setupBroadcast(channels) {
  state.broadcastChannels = channels;
  document.getElementById('broadcast-button').onclick = openBroadcastDialog;
}

function openBroadcastDialog() {
  const options = Object.entries(state.broadcastChannels)
    .map(
      ([code, label]) => `<div class="picker-row channel-row">
        <input type="checkbox" id="ch-${code}" name="channel-${code}" />
        <label for="ch-${code}">${escapeHtml(label)}</label>
      </div>`,
    )
    .join('');

  const form = showDialog(
    `<h3>区民への情報発信</h3>
     <div class="field-group">
       <span class="field-label">発信媒体（複数選択できます）</span>
       <div class="picker">${options}</div>
       <p class="source-note">デモのため実際には配信されません。発信した記録だけが残ります。</p>
     </div>
     <label>発信内容<textarea name="body" rows="4" placeholder="例: 目黒区に大雨警報が発表されました。碑文谷公園ほか7か所の避難所を開設しています。"></textarea></label>
     <label>配信タイミング
       <select name="timing">
         <option value="now">すぐに発信する</option>
         <option value="scheduled">日時を指定して予約する</option>
       </select>
     </label>
     <label id="schedule-field" hidden>配信日時<input type="datetime-local" name="scheduledAt" value="${localDateTimeValue(new Date(Date.now() + 30 * 60 * 1000))}" /></label>
     <label>発信者${operatorSelect('sentBy', '災対本部職員')}</label>`,
    '発信する',
    async (data) => {
      const channels = Object.keys(state.broadcastChannels).filter((code) => data[`channel-${code}`]);

      await postJson('/api/broadcasts', withIncidentBody({
        channels,
        body: data.body,
        sentBy: data.sentBy,
        scheduledAt: data.timing === 'scheduled' ? new Date(data.scheduledAt).toISOString() : undefined,
      }));

      // 防災行政無線を選んだら、音達範囲を地図で確認できるようにする
      if (channels.includes('radio')) setRadioVisible(true);
    },
  );

  const scheduleField = form.querySelector('#schedule-field');
  const submitLabel = form.querySelector('[type="submit"]');

  form.elements.timing.addEventListener('change', () => {
    const scheduled = form.elements.timing.value === 'scheduled';
    scheduleField.hidden = !scheduled;
    submitLabel.textContent = scheduled ? '予約する' : '発信する';
  });

  const submitButton = form.querySelector('[type="submit"]');
  const syncSubmit = () => {
    const hasChannel = !!form.querySelector('.picker input[type="checkbox"]:checked');
    submitButton.disabled = !hasChannel || !form.elements.body.value.trim();
  };

  form.addEventListener('change', syncSubmit);
  form.addEventListener('input', syncSubmit);
  syncSubmit();
}

function renderBroadcastLog() {
  const el = document.getElementById('broadcast-log');

  // 予約分を先に出す。これから流れるものを見落とさないため。
  const scheduled = state.broadcasts
    .filter((b) => b.status === 'scheduled')
    .sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));

  const sent = state.broadcasts
    .filter((b) => b.status !== 'scheduled')
    .sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))
    .slice(0, 3);

  if (scheduled.length === 0 && sent.length === 0) {
    el.innerHTML = '<p class="request-empty">まだ発信していません</p>';
    return;
  }

  el.innerHTML = [...scheduled, ...sent]
    .map(
      (broadcast) => `<div class="broadcast-entry${broadcast.status === 'scheduled' ? ' scheduled' : ''}">
        <div class="broadcast-meta">
          ${broadcast.status === 'scheduled' ? '<span class="badge-schedule">予約</span>' : ''}
          ${formatTime(broadcast.sentAt)}　${escapeHtml((broadcast.channelNames || []).join('・'))}
          ${
            broadcast.status === 'scheduled'
              ? `<button type="button" class="link" data-cancel-broadcast="${escapeAttr(broadcast.id)}">取消</button>`
              : ''
          }
        </div>
        <div>${escapeHtml(broadcast.body)}</div>
      </div>`,
    )
    .join('');

  el.querySelectorAll('[data-cancel-broadcast]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        const res = await fetch(`/api/broadcasts/${encodeURIComponent(button.dataset.cancelBroadcast)}`, { method: 'DELETE' });
        if (!res.ok) throw new Error((await res.json()).error);
        await refresh();
      } catch (err) {
        button.disabled = false;
        alert(`取り消せませんでした: ${err.message}`);
      }
    };
  });
}

// --- 防災行政無線の音達範囲 ---

function addRadioLayers() {
  state.map.addSource('radio-speakers', { type: 'geojson', data: emptyFc() });
  state.map.addSource('radio-coverage', { type: 'geojson', data: emptyFc() });

  state.map.addLayer({
    id: 'radio-coverage-fill',
    type: 'fill',
    source: 'radio-coverage',
    layout: { visibility: 'none' },
    paint: { 'fill-color': '#0ea5e9', 'fill-opacity': 0.14 },
  });

  state.map.addLayer({
    id: 'radio-coverage-line',
    type: 'line',
    source: 'radio-coverage',
    layout: { visibility: 'none' },
    paint: { 'line-color': '#0284c7', 'line-width': 1, 'line-opacity': 0.6 },
  });

  state.map.addLayer({
    id: 'radio-speakers-circle',
    type: 'circle',
    source: 'radio-speakers',
    layout: { visibility: 'none' },
    paint: {
      'circle-radius': 9,
      'circle-color': COLORS.radio,
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff',
    },
  });
}

function setRadioVisible(visible) {
  state.radioVisible = visible;

  for (const id of ['radio-coverage-fill', 'radio-coverage-line', 'radio-speakers-circle', 'radio-speakers-label']) {
    if (state.map.getLayer(id)) {
      state.map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none');
    }
  }

  const input = document.querySelector('#layers input[data-layer*="radio-speakers-circle"]');
  if (input) input.checked = visible;
}

// 音達範囲は円。MapLibre の circle-radius はピクセル指定なので、メートルの円をポリゴンで作る。
function coveragePolygons(speakers) {
  const features = speakers.features.map((feature) => ({
    type: 'Feature',
    properties: { name: feature.properties.name, radius: feature.properties.audibleRadius },
    geometry: {
      type: 'Polygon',
      coordinates: [circleRing(feature.geometry.coordinates, Number(feature.properties.audibleRadius) || 300)],
    },
  }));

  return { type: 'FeatureCollection', features };
}

function circleRing([lng, lat], meters, steps = 48) {
  const latRadius = meters / 111320;
  const lngRadius = meters / (111320 * Math.cos((lat * Math.PI) / 180));
  const ring = [];

  for (let i = 0; i <= steps; i += 1) {
    const angle = (i / steps) * Math.PI * 2;
    ring.push([lng + lngRadius * Math.cos(angle), lat + latRadius * Math.sin(angle)]);
  }

  return ring;
}

function radioPopupHtml(props) {
  return `<div class="map-popup">
    <h3>${escapeHtml(props.name)}</h3>
    <dl>
      ${row('所在地', props.address)}
      ${row('音達範囲', `半径 ${props.audibleRadius} m（仮）`)}
    </dl>
    <p class="hint">${escapeHtml(props.audibleRadiusNote || '')}</p>
  </div>`;
}

// --- ライフラインの丁目別表示 ---

// 4種のライフラインそれぞれに塗りと境界線のレイヤーを用意し、既定は全て非表示。
// ボタンを押した1種類だけを表示する。
function addLifelineLayers() {
  state.map.addSource('lifelines', { type: 'geojson', data: emptyFc() });

  for (const utility of Object.keys(UTILITIES)) {
    state.map.addLayer({
      id: `lifeline-${utility}`,
      type: 'fill',
      source: 'lifelines',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'match',
          ['get', utility],
          'available', LIFELINE_COLORS.available,
          'partial', LIFELINE_COLORS.partial,
          'unavailable', LIFELINE_COLORS.unavailable,
          LIFELINE_COLORS.unknown,
        ],
        'fill-opacity': 0.45,
      },
    });

    state.map.addLayer({
      id: `lifeline-${utility}-outline`,
      type: 'line',
      source: 'lifelines',
      layout: { visibility: 'none' },
      paint: { 'line-color': '#ffffff', 'line-width': 1 },
    });
  }
}

function setupLifelineButtons() {
  const el = document.getElementById('lifeline-buttons');

  el.innerHTML = Object.entries(UTILITIES)
    .map(([utility, label]) => `<button type="button" class="utility" data-utility="${utility}">${label}</button>`)
    .join('');

  el.querySelectorAll('button[data-utility]').forEach((button) => {
    button.addEventListener('click', () => selectUtility(button.dataset.utility));
  });
}

function selectUtility(utility) {
  // 同じボタンをもう一度押したら非表示に戻す
  state.activeUtility = state.activeUtility === utility ? null : utility;

  for (const key of Object.keys(UTILITIES)) {
    const visibility = key === state.activeUtility ? 'visible' : 'none';
    state.map.setLayoutProperty(`lifeline-${key}`, 'visibility', visibility);
    state.map.setLayoutProperty(`lifeline-${key}-outline`, 'visibility', visibility);
  }

  document.querySelectorAll('#lifeline-buttons button').forEach((button) => {
    button.classList.toggle('active', button.dataset.utility === state.activeUtility);
  });

  renderLifelineLegend();
}

function renderLifelineLegend() {
  const el = document.getElementById('lifeline-legend');

  if (!state.activeUtility) {
    el.hidden = true;
    return;
  }

  const counts = {};
  for (const feature of state.lifelines?.features || []) {
    const status = feature.properties[state.activeUtility] || 'unknown';
    counts[status] = (counts[status] || 0) + 1;
  }

  el.hidden = false;
  el.innerHTML = `
    <p class="legend-title">${UTILITIES[state.activeUtility]}の使用可否</p>
    ${Object.entries(LIFELINE_STATUS)
      .filter(([status]) => counts[status])
      .map(
        ([status, label]) => `<div class="legend-row">
          <span class="swatch" style="background:${LIFELINE_COLORS[status]}"></span>
          <span>${label}</span><span class="legend-count">${counts[status]} 丁目</span>
        </div>`,
      )
      .join('')}
    <p class="legend-hint">${state.mode === 'hq' ? '丁目をクリックすると使用可否を更新できます' : '丁目をクリックすると詳細を確認できます（閲覧のみ）'}</p>
  `;
}

// ライフラインの入力は災害対策本部の画面だけに許す。参集指定職員・現場職員では参照のみ。
function openLifelineDialog(props) {
  if (state.mode !== 'hq' || isPastView()) {
    showDialog(
      `<h3>${escapeHtml(props.chomeName)}</h3>
       <dl>
         ${row('人口', props.population)}
         ${row('世帯数', props.households)}
         ${row('更新', props.updatedAt ? formatTime(props.updatedAt) : null)}
       </dl>
       <dl>
         ${Object.entries(UTILITIES)
           .map(([utility, label]) => row(label, LIFELINE_STATUS[props[utility] || 'unknown']))
           .join('')}
         ${row('備考', props.note)}
       </dl>
       <p class="source-note">${isPastView() ? '閲覧のみです。ライフラインは現在の状態を表示しており、この画面からは更新できません。' : '閲覧のみです。更新は災害対策本部の画面から行います。'}</p>`,
      '閉じる',
      async () => {},
    );
    return;
  }

  showDialog(
    `<h3>${escapeHtml(props.chomeName)}</h3>
     <dl>
       ${row('人口', props.population)}
       ${row('世帯数', props.households)}
       ${row('更新', props.updatedAt ? formatTime(props.updatedAt) : null)}
     </dl>
     ${Object.entries(UTILITIES)
       .map(([utility, label]) => `<label>${label}${select(utility, LIFELINE_STATUS, props[utility] || 'unknown')}</label>`)
       .join('')}
     <label>備考<input name="note" value="${escapeAttr(props.note || '')}" /></label>`,
    '更新する',
    async (data) => {
      await patchJson(`/api/lifelines/${encodeURIComponent(props.id)}`, data);
    },
  );
}

// --- データ取得と描画 ---

async function refresh() {
  try {
    await loadAll();
  } catch (err) {
    // 黙って古い画面を出し続けると誤った判断につながるので、取得失敗は明示する
    console.error('データの取得に失敗しました', err);
    document.getElementById('summary').innerHTML =
      `<p class="empty">データの取得に失敗しました。${escapeHtml(err.message)}</p>`;
  }
}

// --- 災害タブの切り替え（別タブ＝別の災害） ---

// GET リクエストの URL に ?incidentId= を足す。未指定なら何もしない（サーバー側がアクティブな災害を使う）。
function withIncidentQuery(url) {
  if (!state.viewIncidentId) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}incidentId=${encodeURIComponent(state.viewIncidentId)}`;
}

// POST の本文に incidentId を足す。未指定なら undefined のままで、JSON.stringify 時に落ちる。
function withIncidentBody(body) {
  return state.viewIncidentId ? { ...body, incidentId: state.viewIncidentId } : body;
}

// 表示中の災害が「今アクティブな災害」以外＝過去の記録を見ている
function isPastView() {
  return !!state.viewedIncident && state.viewedIncident.isActive === false;
}

function renderIncidentBanner() {
  const el = document.getElementById('incident-banner');
  if (!el) return;

  if (!isPastView()) {
    el.hidden = true;
    return;
  }

  el.hidden = false;
  el.innerHTML = `
    過去の災害「${escapeHtml(state.viewedIncident.name)}」（発災 ${formatTime(state.viewedIncident.occurredAt)}）の画面です。
    被害報告・物資要求・全体共有・情報発信はこのまま記入・修正できます。
    避難所・ライフラインの状態は現在のものが表示され、この画面からは編集できません。
    <a href="/">現在進行中の災害の画面に戻る</a>
  `;
}

async function loadAll() {
  const [shelters, reports, timeline, summary, supplies, lifelines, warehouses, stays, allocations, incident, radioSpeakers, broadcasts] = await Promise.all([
    fetch('/api/shelters').then((r) => r.json()),
    fetch(withIncidentQuery('/api/damage-reports')).then((r) => r.json()),
    fetch(withIncidentQuery('/api/timeline')).then((r) => r.json()),
    fetch(withIncidentQuery('/api/summary')).then((r) => r.json()),
    fetch(withIncidentQuery('/api/supply-requests')).then((r) => r.json()),
    fetch('/api/lifelines').then((r) => r.json()),
    fetch('/api/warehouses').then((r) => r.json()),
    fetch('/api/temporary-stays').then((r) => r.json()),
    fetch(withIncidentQuery('/api/allocations')).then((r) => r.json()),
    fetch('/api/incident').then((r) => r.json()),
    fetch('/api/radio-speakers').then((r) => r.json()),
    fetch(withIncidentQuery('/api/broadcasts')).then((r) => r.json()),
  ]);

  state.shelters = shelters;
  state.reports = reports;
  state.supplyRequests = supplies.requests;
  state.lifelines = lifelines;
  state.warehouses = markEmptyWarehouses(warehouses);
  state.stays = stays;
  state.allocations = allocations.allocations;
  state.incident = incident.incident;
  // 表示中の災害（summary が実際に解決した災害）。URL 指定が無ければアクティブな災害と同じになる。
  state.viewedIncident = summary.incident || state.incident;
  state.radioSpeakers = radioSpeakers;
  state.broadcasts = broadcasts.broadcasts;
  renderElapsed();
  renderIncidentBanner();
  renderBroadcastLog();

  // 別タブで開いたときにブラウザのタブ一覧からどの災害か分かるようにする
  document.title = state.viewedIncident
    ? `${state.viewedIncident.name} - 目黒区 災害情報共有システム`
    : '目黒区 災害情報共有システム';

  state.map.getSource('radio-speakers').setData(radioSpeakers);
  state.map.getSource('radio-coverage').setData(coveragePolygons(radioSpeakers));

  state.map.getSource('shelters').setData(shelters);
  state.map.getSource('reports').setData(reports);
  state.map.getSource('lifelines').setData(lifelines);
  state.map.getSource('warehouses').setData(state.warehouses);
  state.map.getSource('stays').setData(stays);
  renderLifelineLegend();

  renderSummary(summary);
  renderCategoryTable(summary);
  renderLayers(shelters.features.length, reports.features.length);
  renderTimeline(timeline.events);

  if (state.mode === 'logistics') renderLogistics();
}

function renderSummary(summary) {
  const el = document.getElementById('summary');

  el.innerHTML = `
    ${metricButton('reports', '被害報告', summary.damageTotal)}
    ${metricButton('unhandled', '未対応', summary.byStatus?.reported || 0)}
    ${metricButton('shelters', '避難所 開設', `${summary.shelterOpen} / ${summary.shelterTotal}`)}
    ${metricButton('evacuees', '避難者数', summary.evacueeTotal)}
    ${metricButton('supplies', '物資要求 未手配', `${summary.supplyPending} / ${summary.supplyTotal}`, 'wide')}
  `;

  el.querySelectorAll('button.metric').forEach((button) => {
    button.addEventListener('click', () => openMetricList(button.dataset.metric));
  });
}

function metricButton(metric, label, value, extraClass = '') {
  return `<button type="button" class="metric ${extraClass}" data-metric="${metric}">
    <span class="label">${label}</span><span class="value">${value}</span>
  </button>`;
}

// --- 集計値から一覧を開く ---

function openMetricList(metric) {
  if (metric === 'supplies') {
    openSupplyListDialog(state.supplyRequests);
    return;
  }

  if (metric === 'shelters' || metric === 'evacuees') {
    const features = state.shelters.features
      .filter((f) => isShelterOpen(f.properties.status))
      .sort((a, b) => (Number(b.properties.evacueeCount) || 0) - (Number(a.properties.evacueeCount) || 0));

    if (metric === 'shelters') {
      showListDialog('開設中の避難所', features.map(shelterListItem));
      return;
    }

    const total = features.reduce((sum, f) => sum + (Number(f.properties.evacueeCount) || 0), 0);
    showListDialog(
      '避難者数の内訳',
      features.map((feature) => evacueeListItem(feature, total)),
      `合計 ${total} 人 ／ 行をクリックすると地図上の位置に移動し、詳細を開きます`,
    );
    return;
  }

  const features = state.reports.features
    .filter((f) => metric !== 'unhandled' || f.properties.status === 'reported')
    .sort((a, b) => new Date(b.properties.reportedAt) - new Date(a.properties.reportedAt));

  showListDialog(metric === 'unhandled' ? '未対応の被害報告' : '被害報告', features.map(reportListItem));
}

function reportListItem(feature) {
  const props = feature.properties;
  return {
    coordinates: feature.geometry.coordinates,
    primary: `${badge(COLORS[props.status] || COLORS.reported, REPORT_STATUS[props.status])}${escapeHtml(CATEGORIES[props.category] || props.category)}`,
    meta: `${SEVERITIES[props.severity] || ''}<br />${formatTime(props.reportedAt)}`,
    secondary: [props.locationNote, props.description || '（内容なし）', props.reporter].filter(Boolean).join('　/　'),
    onSelect: () => openReportStatusDialog(props),
  };
}

function shelterListItem(feature) {
  const props = feature.properties;
  const color = shelterStatusColor(props.status);
  const requests = shelterRequests(props.id);
  return {
    coordinates: feature.geometry.coordinates,
    primary: `${badge(color, SHELTER_STATUS[props.status])}${escapeHtml(props.name)}`,
    meta: `避難者 ${Number(props.evacueeCount) || 0} 人`,
    secondary: [
      props.updatedBy ? `入力: ${props.updatedBy}` : '',
      requests.length ? `物資要求: ${summarizeRequests(requests)}` : props.address || '',
    ]
      .filter(Boolean)
      .join('　/　'),
    onSelect: () => openShelterDialog(props),
  };
}

function shelterRequests(shelterId) {
  return state.supplyRequests
    .filter((r) => r.shelterId === shelterId)
    .sort((a, b) => new Date(b.requestedAt) - new Date(a.requestedAt));
}

function summarizeRequests(requests) {
  const head = requests
    .slice(0, 2)
    .map((r) => `${r.itemName} ${r.quantity}${r.unit}`)
    .join('、');
  return requests.length > 2 ? `${head} ほか${requests.length - 2}件` : head;
}

function openSupplyListDialog(requests) {
  const sorted = [...requests].sort((a, b) => {
    const order = { requested: 0, arranged: 1, delivered: 2 };
    return (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.requestedAt) - new Date(a.requestedAt);
  });

  const totals = new Map();
  for (const r of requests) {
    if (r.status === 'delivered') continue;
    const current = totals.get(r.itemName) || { quantity: 0, unit: r.unit };
    current.quantity += Number(r.quantity) || 0;
    totals.set(r.itemName, current);
  }

  const totalNote = totals.size
    ? `未配送の必要数： ${[...totals.entries()].map(([name, t]) => `${name} ${t.quantity}${t.unit}`).join(' ／ ')}`
    : '行をクリックすると手配状況を更新できます';

  showListDialog('救援物資の要求', sorted.map(supplyListItem), totalNote);
}

function supplyListItem(request) {
  return {
    coordinates: request.location?.coordinates,
    primary: `${badge(REQUEST_COLORS[request.status], REQUEST_STATUS[request.status])}${escapeHtml(request.itemName)}`,
    meta: `${request.quantity} ${request.unit}<br />${formatTime(request.requestedAt)}`,
    secondary: `${request.shelterName}　/　${request.requester || ''}`,
    onSelect: () => openSupplyStatusDialog(request),
  };
}

function openSupplyStatusDialog(request) {
  showDialog(
    `<h3>${escapeHtml(request.itemName)}の手配</h3>
     <dl>
       ${row('避難所', request.shelterName)}
       ${row('要求元', request.requester)}
       ${row('要求時刻', request.requestedAt ? formatTime(request.requestedAt) : null)}
     </dl>
     <label>手配状況${select('status', REQUEST_STATUS, request.status)}</label>
     <label>数量（${escapeHtml(request.unit)}）<input name="quantity" type="number" min="1" value="${Number(request.quantity) || 1}" /></label>`,
    '更新する',
    async (data) => {
      await patchJson(`/api/supply-requests/${encodeURIComponent(request.id)}`, data);
    },
  );
}

// --- 救援物資の要求（現場からの入力） ---

function openSupplyRequestDialog(shelterProps) {
  const groups = new Map();
  for (const item of state.supplyItems) {
    if (!groups.has(item.category)) groups.set(item.category, []);
    groups.get(item.category).push(item);
  }

  const picker = [...groups.entries()]
    .map(
      ([category, items]) => `<div class="picker-group">
        <h4>${escapeHtml(category)}</h4>
        ${items
          .map(
            (item) => `<div class="picker-row">
              <input type="checkbox" id="pick-${item.code}" name="item-${item.code}" />
              <label for="pick-${item.code}">${escapeHtml(item.name)}</label>
              <input type="number" name="qty-${item.code}" min="1" value="${item.defaultQuantity}" aria-label="${escapeAttr(item.name)}の数量" />
              <span class="unit">${escapeHtml(item.unit)}</span>
            </div>`,
          )
          .join('')}
      </div>`,
    )
    .join('');

  const form = showDialog(
    `<h3>救援物資の要求</h3>
     <dl>${row('避難所', shelterProps.name)}</dl>
     <div class="picker">${picker}</div>
     <label>要求元<input name="requester" value="避難所運営班" /></label>`,
    '要求する',
    async (data) => {
      const items = state.supplyItems
        .filter((item) => data[`item-${item.code}`])
        .map((item) => ({ item: item.code, quantity: Number(data[`qty-${item.code}`]) }));

      await postJson('/api/supply-requests', withIncidentBody({
        shelterId: shelterProps.id,
        requester: data.requester,
        items,
      }));
    },
  );

  // 1品目も選ばれていない状態では送信できないようにする
  const submitButton = form.querySelector('[type="submit"]');
  const syncSubmit = () => {
    submitButton.disabled = !form.querySelector('.picker input[type="checkbox"]:checked');
  };
  form.addEventListener('change', syncSubmit);
  syncSubmit();
}

function evacueeListItem(feature, total) {
  const props = feature.properties;
  const color = shelterStatusColor(props.status);
  const count = Number(props.evacueeCount) || 0;
  const share = total > 0 ? Math.round((count / total) * 1000) / 10 : 0;

  return {
    coordinates: feature.geometry.coordinates,
    primary: `${badge(color, SHELTER_STATUS[props.status])}${escapeHtml(props.name)}`,
    meta: `${count} 人<br />${share}%`,
    secondaryHtml: `<span class="bar"><span style="width:${share}%;background:${color}"></span></span>`,
    onSelect: () => openShelterDialog(props),
  };
}

function badge(color, text) {
  if (!text) return '';
  return `<span class="badge" style="background:${color}">${escapeHtml(text)}</span>`;
}

function showListDialog(title, items, footerNote = '行をクリックすると地図上の位置に移動し、詳細を開きます') {
  const dialog = document.getElementById('list-dialog');
  const body = document.getElementById('list-body');

  const rows = items.length
    ? items
        .map(
          (item, index) => `<li><button type="button" data-index="${index}">
            <span class="primary">${item.primary}</span>
            <span class="meta">${item.meta}</span>
            <span class="secondary">${item.secondaryHtml ?? escapeHtml(item.secondary)}</span>
          </button></li>`,
        )
        .join('')
    : '<li class="empty">該当する情報はありません</li>';

  body.innerHTML = `
    <div class="list-header">
      <h3>${title}（${items.length}件）</h3>
      <button type="button" class="close">閉じる</button>
    </div>
    <ol class="list">${rows}</ol>
    ${items.length ? `<div class="list-footer">${footerNote}</div>` : ''}
  `;

  body.querySelector('.close').onclick = () => dialog.close();

  body.querySelectorAll('.list button[data-index]').forEach((button) => {
    button.onclick = () => {
      const item = items[Number(button.dataset.index)];
      dialog.close();
      state.map.flyTo({ center: item.coordinates, zoom: 16 });
      item.onSelect();
    };
  });

  dialog.showModal();
}

function renderCategoryTable(summary) {
  const tbody = document.querySelector('#category-table tbody');
  const entries = Object.entries(CATEGORIES).map(([key, label]) => [label, summary.byCategory?.[key] || 0]);
  tbody.innerHTML = entries.map(([label, count]) => `<tr><td>${label}</td><td>${count}</td></tr>`).join('');
}

function renderLayers(shelterCount, reportCount) {
  const layersEl = document.getElementById('layers');
  const counts = {
    shelters: shelterCount,
    reports: reportCount,
    warehouses: state.warehouses?.features.length ?? 0,
    stays: state.stays?.features.length ?? 0,
    radio: state.radioSpeakers?.features.length ?? 0,
  };

  if (layersEl.dataset.built) {
    for (const [key, value] of Object.entries(counts)) {
      layersEl.querySelector(`[data-count="${key}"]`).textContent = value;
    }
    return;
  }

  layersEl.innerHTML = `
    <label>
      <input type="checkbox" checked data-layer="shelters-circle,shelters-label" />
      <span class="dot" style="background:${COLORS.shelterOpen}">避</span>
      <span>避難所</span><span class="count" data-count="shelters">${shelterCount}</span>
    </label>
    <label>
      <input type="checkbox" checked data-layer="reports-circle,reports-label,reports-pulse" />
      <span class="dot" style="background:${COLORS.reported}">害</span>
      <span>被害報告</span><span class="count" data-count="reports">${reportCount}</span>
    </label>
    <label>
      <input type="checkbox" checked data-layer="warehouses-symbol,warehouses-label" />
      <span class="dot" style="background:${COLORS.warehouse}">備</span>
      <span>備蓄倉庫</span><span class="count" data-count="warehouses">${counts.warehouses}</span>
    </label>
    <label>
      <input type="checkbox" checked data-layer="stays-symbol,stays-label" />
      <span class="dot" style="background:${COLORS.temporaryStay}">滞</span>
      <span>一時滞在施設</span><span class="count" data-count="stays">${counts.stays}</span>
    </label>
    <label>
      <input type="checkbox" data-layer="radio-speakers-circle,radio-speakers-label,radio-coverage-fill,radio-coverage-line" />
      <span class="dot" style="background:${COLORS.radio}">無</span>
      <span>防災行政無線</span><span class="count" data-count="radio">${counts.radio}</span>
    </label>
    <label>
      <input type="checkbox" checked data-layer="boundary-line,boundary-mask" />
      <span class="dot" style="background:#11213a"></span>
      <span>区界</span><span class="count"></span>
    </label>
  `;

  layersEl.querySelectorAll('input[data-layer]').forEach((input) => {
    input.addEventListener('change', () => {
      for (const layerId of input.dataset.layer.split(',')) {
        state.map.setLayoutProperty(layerId, 'visibility', input.checked ? 'visible' : 'none');
      }
    });
  });

  layersEl.dataset.built = 'true';
}

function renderTimeline(events) {
  state.timeline = events;
  renderTimelineFilter();
  renderTimelineEntries();
}

function renderTimelineFilter() {
  const el = document.getElementById('timeline-filter');
  const counts = {};
  for (const event of state.timeline) counts[event.kind] = (counts[event.kind] || 0) + 1;

  if (!el.dataset.built) {
    el.innerHTML = Object.entries(TIMELINE_KINDS)
      .map(
        ([kind, kindLabel]) => `<label class="chip">
          <input type="checkbox" data-kind="${kind}" checked />
          <span>${kindLabel}</span><span class="chip-count" data-chip-count="${kind}"></span>
        </label>`,
      )
      .join('');

    el.querySelectorAll('input[data-kind]').forEach((input) => {
      input.addEventListener('change', () => {
        if (input.checked) state.timelineKinds.add(input.dataset.kind);
        else state.timelineKinds.delete(input.dataset.kind);
        renderTimelineEntries();
      });
    });

    el.dataset.built = 'true';
  }

  for (const kind of Object.keys(TIMELINE_KINDS)) {
    el.querySelector(`[data-chip-count="${kind}"]`).textContent = counts[kind] || 0;
  }
}

function renderTimelineEntries() {
  const el = document.getElementById('timeline');
  const events = state.timeline.filter((event) => state.timelineKinds.has(event.kind));

  if (events.length === 0) {
    el.innerHTML = '<li class="empty">表示する記録がありません</li>';
    return;
  }

  el.innerHTML = events
    .map(
      (e) => `<li class="${e.kind}">
        <div class="time">${formatTime(e.at)}</div>
        <div class="title">${escapeHtml(translate(e.title))}</div>
        <div class="body">${escapeHtml(e.body)}${e.status ? `（${label(e.status)}）` : ''}</div>
        ${
          e.author
            ? `<div class="by">入力: ${escapeHtml(e.author)}${
                e.kind === 'notice' ? `<button type="button" class="link" data-delete-notice="${escapeAttr(e.id)}">削除</button>` : ''
              }</div>`
            : ''
        }
      </li>`,
    )
    .join('');

  el.querySelectorAll('[data-delete-notice]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      await fetch(`/api/notices/${encodeURIComponent(button.dataset.deleteNotice)}`, { method: 'DELETE' });
      await refresh();
    };
  });
}

// --- ホワイトボードへの入力 ---

function setupWhiteboard(categories) {
  const form = document.getElementById('notice-form');
  form.elements.category.innerHTML = Object.entries(categories)
    .map(([value, text]) => `<option value="${value}">${text}</option>`)
    .join('');

  const resetTime = () => {
    form.elements.postedAt.value = localDateTimeValue(new Date());
  };

  resetTime();
  form.querySelector('[data-action="now"]').onclick = resetTime;

  form.onsubmit = async (event) => {
    event.preventDefault();
    const body = form.elements.body.value.trim();
    if (!body) return;

    const entered = form.elements.postedAt.value;
    // 未入力なら現在時刻。入力値はローカル時刻なので、そのまま Date に渡して ISO へ変換する
    const postedAt = entered ? new Date(entered).toISOString() : new Date().toISOString();

    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      await postJson('/api/notices', withIncidentBody({ category: form.elements.category.value, body, postedAt }));
      form.elements.body.value = '';
      resetTime();
      await refresh();
    } catch (err) {
      alert(`登録に失敗しました: ${err.message}`);
    } finally {
      submitButton.disabled = false;
    }
  };
}

// datetime-local が受け取れる "YYYY-MM-DDTHH:mm" 形式（ローカル時刻）を作る
function localDateTimeValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// --- 地図の操作 ---

// 地図スタイルが読み込む日本語グリフ（Noto Sans CJK JP Bold）をそのまま使う
function addPinLabel(source, label) {
  state.map.addLayer({
    id: `${source}-label`,
    type: 'symbol',
    source,
    layout: {
      'text-field': label,
      'text-font': ['Noto Sans CJK JP Bold'],
      'text-size': 13,
      'text-allow-overlap': true,
      'text-ignore-placement': true,
    },
    paint: { 'text-color': '#ffffff' },
  });
}

// 未対応の被害報告を目立たせるため、円を外側に広げながら薄くするパルスを繰り返す。
// data には触れず paint プロパティだけを毎フレーム書き換える（データの再取得とは独立）。
function startReportsPulse() {
  const periodMs = 1500;
  const minRadius = 10;
  const maxRadius = 24;

  const tick = (timestamp) => {
    if (!state.map.getLayer('reports-pulse')) return; // ページ遷移などで地図が破棄された場合に停止する

    const phase = (timestamp % periodMs) / periodMs; // 0→1 を周期的に繰り返す
    const radius = minRadius + (maxRadius - minRadius) * phase;
    const opacity = 0.55 * (1 - phase);

    state.map.setPaintProperty('reports-pulse', 'circle-radius', radius);
    state.map.setPaintProperty('reports-pulse', 'circle-opacity', opacity);

    requestAnimationFrame(tick);
  };

  requestAnimationFrame(tick);
}

function setupHover(layerId, htmlBuilder) {
  state.map.on('mouseenter', layerId, (e) => {
    state.map.getCanvas().style.cursor = 'pointer';
    state.popup.setLngLat(e.features[0].geometry.coordinates).setHTML(htmlBuilder(e.features[0].properties)).addTo(state.map);
  });

  state.map.on('mouseleave', layerId, () => {
    state.map.getCanvas().style.cursor = state.mode === 'field' ? 'crosshair' : '';
    state.popup.remove();
  });
}

// モードごとに触れる対象を分ける。
// 参集指定職員は避難所だけ、現場職員は被害報告だけを入力できる。
const MODE_TARGETS = {
  hq: ['reports-circle', 'shelters-circle', 'stays-symbol', 'warehouses-symbol'],
  shelter: ['shelters-circle'],
  field: ['reports-circle'],
  logistics: [],
};

function setupMapClick() {
  state.map.on('click', (e) => {
    const layers = MODE_TARGETS[state.mode] || [];
    const hits = layers.length > 0 ? state.map.queryRenderedFeatures(e.point, { layers }) : [];

    if (hits.length > 0) {
      const feature = hits[0];
      const handlers = {
        'shelters-circle': openShelterDialog,
        'reports-circle': openReportStatusDialog,
        'warehouses-symbol': openWarehouseDialog,
        'stays-symbol': openStayDialog,
      };
      handlers[feature.layer.id](feature.properties);
      return;
    }

    // ライフライン表示中は、丁目クリックを使用可否の入力として扱う
    if (state.activeUtility) {
      const chome = state.map.queryRenderedFeatures(e.point, { layers: [`lifeline-${state.activeUtility}`] });
      if (chome.length > 0) {
        openLifelineDialog(chome[0].properties);
        return;
      }
    }

    // 災害対策本部はすべての権限を持つので、新規の被害報告もその場で登録できる
    if (state.mode === 'field' || state.mode === 'hq') openNewReportDialog(e.lngLat);
  });
}

function shelterPopupHtml(props) {
  return `<div class="map-popup">
    <h3>${escapeHtml(props.name || props.id)}</h3>
    <dl>
      ${row('種別', SHELTER_TYPES[props.shelterType] || props.shelterType)}
      ${row('住所', props.address)}
      ${row('開設状況', SHELTER_STATUS[props.status] || '未設定')}
      ${row('避難者数', props.evacueeCount)}
      ${row('収容人数', props.capacity)}
      ${row('建物被害', BUILDING_DAMAGE[props.buildingDamage])}
      ${row('電気 / 水道 / トイレ / ネット', props.electricity ? `${SHELTER_UTILITY[props.electricity]} / ${SHELTER_UTILITY[props.water]} / ${SHELTER_UTILITY[props.toilet]} / ${SHELTER_UTILITY[props.internet] || '未確認'}` : null)}
      ${row('被害の詳細', props.damageNote)}
      ${row('入力者', props.updatedBy)}
      ${row('更新時刻', props.updatedAt ? formatTime(props.updatedAt) : null)}
    </dl>
    <p class="hint">クリックで状況を更新</p>
  </div>`;
}

function reportPopupHtml(props) {
  return `<div class="map-popup">
    <h3>${escapeHtml(CATEGORIES[props.category] || props.category)}</h3>
    <dl>
      ${row('程度', SEVERITIES[props.severity])}
      ${row('対応状況', REPORT_STATUS[props.status])}
      ${row('場所', props.locationNote)}
      ${row('内容', props.description)}
      ${row('入力者', props.reporter)}
      ${row('報告時刻', props.reportedAt ? formatTime(props.reportedAt) : null)}
      ${row('最終更新者', props.updatedBy)}
      ${row('追記', parseUpdates(props.updates).length ? `${parseUpdates(props.updates).length} 件` : null)}
    </dl>
    <p class="hint">クリックで内容の更新・追記ができます</p>
  </div>`;
}

function warehousePopupHtml(props) {
  const empty = Number(props.totalStock) === 0;
  return `<div class="map-popup">
    <h3>${escapeHtml(props.name)}${empty ? badge(COLORS.warehouseEmpty, '在庫なし') : ''}</h3>
    <dl>
      ${row('地区', props.district)}
      ${row('所在地', props.address)}
      ${row('面積', props.area ? `${props.area} ㎡` : null)}
      ${row('設置年度', props.builtYear)}
    </dl>
    <p class="hint">クリックで備蓄品目を表示</p>
  </div>`;
}

function stayPopupHtml(props) {
  return `<div class="map-popup">
    <h3>${escapeHtml(props.name)}</h3>
    <dl>
      ${row('所在地', props.address)}
      ${row('管理', props.operator)}
      ${row('開放状況', STAY_STATUS[props.status] || '未設定')}
    </dl>
    <p class="hint">クリックで開放状況を更新</p>
  </div>`;
}

// --- 備蓄倉庫の品目一覧 ---

function openWarehouseDialog(props) {
  // GeoJSON の properties 経由だと入れ子のオブジェクトが文字列化されることがある
  const stock = typeof props.stock === 'string' ? JSON.parse(props.stock) : props.stock;

  const categories = (stock?.categories || [])
    .map(
      (category) => `<div class="stock-group">
        <h4>${escapeHtml(category.category)}</h4>
        <table class="stock-table">
          ${category.items
            .map(
              (item) => `<tr>
                <td>${escapeHtml(item.name)}${item.estimated ? '<span class="estimate-mark">推計</span>' : ''}</td>
                <td class="stock-qty">${item.quantity.toLocaleString('ja-JP')} ${escapeHtml(item.unit)}</td>
              </tr>
              ${item.boxSize || item.remarks || item.estimateNote ? `<tr class="stock-note"><td colspan="2">${escapeHtml([item.boxSize, item.remarks, item.estimateNote].filter(Boolean).join('／'))}</td></tr>` : ''}`,
            )
            .join('')}
        </table>
      </div>`,
    )
    .join('');

  showDialog(
    `<h3>${escapeHtml(props.name)}</h3>
     <dl>
       ${row('地区', props.district)}
       ${row('所在地', props.address)}
       ${row('面積', props.area ? `${props.area} ㎡` : null)}
       ${row('設置年度', props.builtYear)}
       ${row('備考', props.remarks)}
     </dl>
     <div class="field-group">
       <span class="field-label">備蓄品目（${escapeHtml(stock?.note || '')}）</span>
       <div class="stock">${categories}</div>
     </div>
     <p class="source-note">${escapeHtml(props.source || '')}</p>`,
    '閉じる',
    async () => {},
  );
}

function openStayDialog(props) {
  // 開放状況も避難所と同じく「今の状態」1つだけなので、過去の災害を見ている画面からは編集させない
  if (isPastView()) {
    showDialog(
      `<h3>${escapeHtml(props.name)}</h3>
       <dl>
         ${row('所在地', props.address)}
         ${row('管理', props.operator)}
         ${row('開放状況（現在）', STAY_STATUS[props.status] || '未設定')}
       </dl>
       <p class="source-note">開放状況は現在のものです。この画面からは更新できません。</p>`,
      '閉じる',
      async () => {},
    );
    return;
  }

  showDialog(
    `<h3>${escapeHtml(props.name)}</h3>
     <dl>
       ${row('所在地', props.address)}
       ${row('管理', props.operator)}
     </dl>
     <label>開放状況${select('status', STAY_STATUS, props.status || 'closed')}</label>
     <label>備考<input name="note" value="${escapeAttr(props.note || '')}" /></label>
     <p class="source-note">${escapeHtml(props.disclosureNote || '')}</p>`,
    '更新する',
    async (data) => {
      await patchJson(`/api/temporary-stays/${encodeURIComponent(props.id)}`, data);
    },
  );
}

// --- 入力ダイアログ ---

function openNewReportDialog(lngLat) {
  showDialog(
    `<h3>被害報告の登録</h3>
     <label>被害種別${select('category', CATEGORIES, 'building')}</label>
     <label>被害の程度${select('severity', SEVERITIES, 'minor')}</label>
     <label>場所の補足<input name="locationNote" placeholder="例: 目黒通りと山手通りの交差点付近、○○ビル前" /></label>
     <label>内容<textarea name="description" rows="5" placeholder="例: 区道が幅3m・深さ1mにわたり陥没。車両通行止め、歩行者は北側歩道へ迂回誘導中。付近に水道漏れの形跡あり"></textarea></label>
     <label>入力者${operatorSelect('reporter')}</label>
     <dl>${row('地点', `${lngLat.lng.toFixed(5)}, ${lngLat.lat.toFixed(5)}`)}</dl>`,
    '報告する',
    async (data) => {
      await postJson('/api/damage-reports', withIncidentBody({
        ...data,
        longitude: Number(lngLat.lng.toFixed(6)),
        latitude: Number(lngLat.lat.toFixed(6)),
      }));
    },
  );
}

function openReportStatusDialog(props) {
  const updates = parseUpdates(props.updates);

  const history = updates.length
    ? `<ol class="update-log">${updates
        .slice()
        .reverse()
        .map(
          (entry) => `<li>
            <div class="update-meta">${formatTime(entry.at)}　${escapeHtml(entry.by || '')}${
              entry.status ? `　${REPORT_STATUS[entry.status] || ''}` : ''
            }</div>
            <div>${escapeHtml(entry.note)}</div>
          </li>`,
        )
        .join('')}</ol>`
    : '<p class="request-empty">追記はまだありません</p>';

  showDialog(
    `<h3>${escapeHtml(CATEGORIES[props.category] || props.category)}の報告</h3>
     <dl>
       ${row('報告者', props.reporter)}
       ${row('報告時刻', props.reportedAt ? formatTime(props.reportedAt) : null)}
       ${row('最終更新', props.updatedBy ? `${props.updatedBy}（${formatTime(props.updatedAt)}）` : null)}
     </dl>
     <label>対応状況${select('status', REPORT_STATUS, props.status)}</label>
     <label>被害の程度${select('severity', SEVERITIES, props.severity)}</label>
     <label>場所の補足<input name="locationNote" value="${escapeAttr(props.locationNote || '')}" placeholder="例: 目黒通りと山手通りの交差点付近、○○ビル前" /></label>
     <label>内容（いつでも書き換えられます）<textarea name="description" rows="5">${escapeHtml(props.description || '')}</textarea></label>
     <label>追記（経過・新たに判明したこと）<textarea name="progressNote" rows="3" placeholder="例: 15:40 消防到着、周辺50mを規制。負傷者2名を搬送"></textarea></label>
     <label>入力者${operatorSelect('updatedBy', props.updatedBy)}</label>
     <div class="field-group">
       <span class="field-label">追記の履歴（${updates.length}件）</span>
       ${history}
     </div>`,
    '更新する',
    async (data) => {
      await patchJson(`/api/damage-reports/${encodeURIComponent(props.id)}`, data);
    },
  );
}

// GeoJSON の properties 経由だと入れ子の配列が文字列化されることがある
function parseUpdates(updates) {
  if (!updates) return [];
  return typeof updates === 'string' ? JSON.parse(updates) : updates;
}

function openShelterDialog(props) {
  const requests = shelterRequests(props.id);

  const requestList = requests.length
    ? `<ul class="request-summary">${requests
        .map(
          (r) => `<li>${badge(REQUEST_COLORS[r.status], REQUEST_STATUS[r.status])}${escapeHtml(r.itemName)}
            <strong>${r.quantity} ${escapeHtml(r.unit)}</strong></li>`,
        )
        .join('')}</ul>`
    : '<p class="request-empty">物資要求はありません</p>';

  const supplyBlock = `<div class="field-group">
    <span class="field-label">救援物資の要求</span>
    ${requestList}
    <button type="button" class="button" data-action="request-supply">救援物資を要求する</button>
  </div>`;

  // 避難所の開設状況・被害状況は災害ごとの記録ではなく「今の状態」1つだけなので、
  // 過去の災害を見ている画面からは編集できない（物資要求はその災害の記録として追加できる）。
  if (isPastView()) {
    const form = showDialog(
      `<h3>${escapeHtml(props.name || props.id)}</h3>
       <dl>
         ${row('種別', SHELTER_TYPES[props.shelterType] || props.shelterType)}
         ${row('住所', props.address)}
         ${row('収容人数', props.capacity)}
       </dl>
       <dl>
         ${row('開設状況（現在）', SHELTER_STATUS[props.status] || '未設定')}
         ${row('避難者数（現在）', props.evacueeCount)}
         ${row('建物被害（現在）', BUILDING_DAMAGE[props.buildingDamage])}
       </dl>
       <p class="source-note">避難所の状態は現在のものです。この過去の災害の当時の状態ではなく、この画面からは更新できません。</p>
       ${supplyBlock}`,
      '閉じる',
      async () => {},
    );

    form.querySelector('[data-action="request-supply"]').onclick = () => {
      document.getElementById('dialog').close();
      openSupplyRequestDialog(props);
    };
    return;
  }

  const form = showDialog(
    `<h3>${escapeHtml(props.name || props.id)}</h3>
     <dl>
       ${row('種別', SHELTER_TYPES[props.shelterType] || props.shelterType)}
       ${row('住所', props.address)}
       ${row('収容人数', props.capacity)}
       ${row('最終更新', props.updatedBy ? `${props.updatedBy}（${formatTime(props.updatedAt)}）` : null)}
     </dl>
     <label>開設状況${select('status', SHELTER_STATUS, props.status || 'closed')}</label>
     <label>避難者数<input name="evacueeCount" type="number" min="0" value="${props.evacueeCount ?? 0}" /></label>
     <label>入力者${operatorSelect('updatedBy', props.updatedBy)}</label>
     <label>備考<input name="note" value="${escapeAttr(props.note || '')}" /></label>
     <div class="field-group">
       <span class="field-label">避難所の被害状況</span>
       <label>建物被害${select('buildingDamage', BUILDING_DAMAGE, props.buildingDamage || 'none')}</label>
       <div class="utility-row">
         <label>電気${select('electricity', SHELTER_UTILITY, props.electricity || 'unknown')}</label>
         <label>水道${select('water', SHELTER_UTILITY, props.water || 'unknown')}</label>
         <label>トイレ${select('toilet', SHELTER_UTILITY, props.toilet || 'unknown')}</label>
         <label>インターネット${select('internet', SHELTER_UTILITY, props.internet || 'unknown')}</label>
       </div>
       <label>被害の詳細<input name="damageNote" value="${escapeAttr(props.damageNote || '')}" placeholder="例: 体育館の窓ガラスが破損、西側を立入禁止" /></label>
     </div>
     ${supplyBlock}`,
    '更新する',
    async (data) => {
      await patchJson(`/api/shelters/${encodeURIComponent(props.id)}`, {
        ...data,
        evacueeCount: Number(data.evacueeCount) || 0,
      });
    },
  );

  form.querySelector('[data-action="request-supply"]').onclick = () => {
    document.getElementById('dialog').close();
    openSupplyRequestDialog(props);
  };
}

function showDialog(innerHtml, submitLabel, onSubmit) {
  const dialog = document.getElementById('dialog');
  const form = document.getElementById('dialog-form');

  form.innerHTML = `${innerHtml}
    <div class="actions">
      <button type="button" class="button" data-action="cancel">キャンセル</button>
      <button type="submit" class="button primary">${submitLabel}</button>
    </div>`;

  form.querySelector('[data-action="cancel"]').onclick = () => dialog.close();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const submitButton = form.querySelector('[type="submit"]');
    submitButton.disabled = true;
    try {
      await onSubmit(data);
      dialog.close();
      await refresh();
    } catch (err) {
      submitButton.disabled = false;
      alert(`送信に失敗しました: ${err.message}`);
    }
  };

  dialog.showModal();
  return form;
}

// --- 物資管理（備蓄倉庫 → 避難所の割当） ---

const ALLOCATION_STATUS = { allocated: '割当済', shipped: '配送中', delivered: '配送完了' };

function renderLogistics() {
  renderShelterQueue();
  renderAllocationPanel();
  renderInventoryTotal();
  renderAllocationList();
  renderInventorySelect();
}

// 区内20倉庫の在庫を品目ごとに合計する。倉庫在庫が割当で減るので、総数も自動で減る。
function renderInventoryTotal() {
  const el = document.getElementById('inventory-total');
  const totals = new Map();

  for (const feature of state.warehouses.features) {
    for (const entry of parseInventory(feature.properties.inventory)) {
      const current = totals.get(entry.item) || { name: entry.name, unit: entry.unit, quantity: 0, warehouses: 0 };
      current.quantity += Number(entry.quantity) || 0;
      if (entry.quantity > 0) current.warehouses += 1;
      totals.set(entry.item, current);
    }
  }

  // 割当済みで未配送の数量は、在庫から出たあと避難所に届く途中のもの
  const inTransit = new Map();
  for (const allocation of state.allocations) {
    if (allocation.status === 'delivered') continue;
    inTransit.set(allocation.item, (inTransit.get(allocation.item) || 0) + (Number(allocation.quantity) || 0));
  }

  const delivered = new Map();
  for (const allocation of state.allocations) {
    if (allocation.status !== 'delivered') continue;
    delivered.set(allocation.item, (delivered.get(allocation.item) || 0) + (Number(allocation.quantity) || 0));
  }

  el.innerHTML = `<table class="logistics-table total">
    <thead><tr><th>品目</th><th>在庫</th><th>配送中</th><th>配送済</th></tr></thead>
    <tbody>${[...totals.entries()]
      .map(
        ([item, total]) => `<tr class="${total.quantity === 0 ? 'out-of-stock' : ''}">
          <td>
            <div>${escapeHtml(total.name)}</div>
            <div class="req-sub">${total.warehouses} 倉庫に在庫</div>
          </td>
          <td class="req-qty">${total.quantity.toLocaleString('ja-JP')} ${escapeHtml(total.unit)}</td>
          <td class="req-qty">${(inTransit.get(item) || 0).toLocaleString('ja-JP')}</td>
          <td class="req-qty">${(delivered.get(item) || 0).toLocaleString('ja-JP')}</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>
  <p class="logistics-hint">目黒区内の備蓄倉庫20棟の合計。割当を行うと出庫元の在庫が減り、この総数にも反映されます。</p>`;
}

// 避難所ごとに要求をまとめる。未手配が残っている避難所を上に出す。
function shelterGroups() {
  const groups = new Map();

  for (const request of state.supplyRequests) {
    if (!groups.has(request.shelterId)) {
      const feature = state.shelters.features.find((f) => f.properties.id === request.shelterId);
      groups.set(request.shelterId, {
        id: request.shelterId,
        name: request.shelterName,
        properties: feature?.properties,
        coordinates: feature?.geometry.coordinates,
        requests: [],
      });
    }
    groups.get(request.shelterId).requests.push(request);
  }

  return [...groups.values()]
    .map((group) => ({
      ...group,
      pending: group.requests.filter((r) => r.status === 'requested').length,
    }))
    .sort((a, b) => b.pending - a.pending || (Number(b.properties?.evacueeCount) || 0) - (Number(a.properties?.evacueeCount) || 0));
}

function renderShelterQueue() {
  const el = document.getElementById('shelter-queue');
  const groups = shelterGroups();

  if (groups.length === 0) {
    el.innerHTML = '<p class="logistics-empty">物資要求はありません</p>';
    return;
  }

  if (!groups.some((group) => group.id === state.selectedShelterId)) {
    state.selectedShelterId = groups[0].id;
  }

  el.innerHTML = `<table class="logistics-table">
    <tbody>${groups
      .map(
        (group) => `<tr data-shelter="${escapeAttr(group.id)}" class="${group.id === state.selectedShelterId ? 'selected' : ''}">
          <td>
            <div class="req-item">${escapeHtml(group.name)}</div>
            <div class="req-sub">避難者 ${Number(group.properties?.evacueeCount) || 0} 人 ／ 要求 ${group.requests.length} 件</div>
          </td>
          <td class="req-qty">${
            group.pending > 0
              ? badge(REQUEST_COLORS.requested, `未手配 ${group.pending}`)
              : badge(REQUEST_COLORS.delivered, '手配済')
          }</td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  el.querySelectorAll('tr[data-shelter]').forEach((tr) => {
    tr.onclick = () => {
      state.selectedShelterId = tr.dataset.shelter;
      renderShelterQueue();
      renderAllocationPanel();
    };
  });
}

function renderAllocationPanel() {
  const el = document.getElementById('allocation-panel');
  const group = shelterGroups().find((g) => g.id === state.selectedShelterId);

  if (!group) {
    el.innerHTML = '<p class="logistics-empty">左の一覧から避難所を選んでください</p>';
    return;
  }

  const rows = group.requests
    .slice()
    .sort((a, b) => {
      const order = { requested: 0, arranged: 1, delivered: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    })
    .map((request) => allocationRowHtml(request, group.coordinates))
    .join('');

  el.innerHTML = `
    <div class="alloc-target">
      <div class="alloc-item">
        ${escapeHtml(group.name)}
        ${badge(shelterStatusColor(group.properties?.status), SHELTER_STATUS[group.properties?.status])}
      </div>
      <dl>
        ${row('所在地', group.properties?.address)}
        ${row('避難者数', `${Number(group.properties?.evacueeCount) || 0} 人`)}
        ${row('物資要求', `${group.requests.length} 件（未手配 ${group.pending} 件）`)}
      </dl>
    </div>
    <table class="logistics-table alloc-sheet">
      <thead><tr><th>品目</th><th>要求数</th><th>出庫元の備蓄倉庫（避難所から近い順）</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;

  bindAllocationRows(el, group);
}

function allocationRowHtml(request, shelterCoords) {
  const candidates = warehouseCandidates(request.item, shelterCoords);
  const enough = candidates.filter((candidate) => candidate.stock >= request.quantity);
  const preferred = enough[0] || candidates[0];

  const control =
    request.status !== 'requested'
      ? `<span class="alloc-done">${badge(REQUEST_COLORS[request.status], REQUEST_STATUS[request.status])}${escapeHtml(allocationSourceLabel(request))}</span>`
      : candidates.length === 0
        ? '<span class="alloc-none">在庫のある倉庫がありません</span>'
        : `<div class="alloc-action">
            <select data-warehouse="${escapeAttr(request.id)}">
              ${candidates
                .map(
                  (candidate) => `<option value="${escapeAttr(candidate.id)}"${candidate.id === preferred.id ? ' selected' : ''}>
                    ${escapeHtml(candidate.name)}（${candidate.distance == null ? '-' : `${candidate.distance.toFixed(1)}km`}・在庫${candidate.stock}${escapeHtml(request.unit)}）
                  </option>`,
                )
                .join('')}
            </select>
            <input type="number" min="1" value="${Math.min(request.quantity, preferred.stock)}" data-qty="${escapeAttr(request.id)}" />
            <button type="button" class="button primary" data-allocate="${escapeAttr(request.id)}">割当</button>
          </div>`;

  return `<tr>
    <td><div class="req-item">${escapeHtml(request.itemName)}</div></td>
    <td class="req-qty">${request.quantity} ${escapeHtml(request.unit)}</td>
    <td>${control}</td>
  </tr>`;
}

function warehouseCandidates(item, shelterCoords) {
  return state.warehouses.features
    .map((feature) => {
      const line = parseInventory(feature.properties.inventory).find((entry) => entry.item === item);
      return {
        id: feature.properties.id,
        name: feature.properties.name,
        stock: line ? line.quantity : 0,
        distance: shelterCoords ? distanceInKm(shelterCoords, feature.geometry.coordinates) : null,
      };
    })
    .filter((candidate) => candidate.stock > 0)
    .sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0));
}

function allocationSourceLabel(request) {
  const allocation = state.allocations.find((a) => a.requestId === request.id);
  return allocation ? `${allocation.warehouseName} から ${allocation.quantity}${allocation.unit}` : '';
}

function bindAllocationRows(el, group) {
  el.querySelectorAll('[data-allocate]').forEach((button) => {
    button.onclick = async () => {
      const requestId = button.dataset.allocate;
      const request = group.requests.find((r) => r.id === requestId);

      button.disabled = true;
      try {
        await postJson('/api/allocations', withIncidentBody({
          warehouseId: el.querySelector(`[data-warehouse="${requestId}"]`).value,
          shelterId: group.id,
          requestId,
          item: request.item,
          quantity: Number(el.querySelector(`[data-qty="${requestId}"]`).value),
        }));
        await refresh();
      } catch (err) {
        button.disabled = false;
        alert(`割当に失敗しました: ${err.message}`);
      }
    };
  });
}

function renderAllocationList() {
  const el = document.getElementById('allocation-list');

  if (state.allocations.length === 0) {
    el.innerHTML = '<p class="logistics-empty">まだ割当がありません</p>';
    return;
  }

  const sorted = [...state.allocations].sort((a, b) => new Date(b.allocatedAt) - new Date(a.allocatedAt));

  el.innerHTML = `<table class="logistics-table">
    <tbody>${sorted
      .map(
        (allocation) => `<tr>
          <td>
            <div class="req-item">${escapeHtml(allocation.itemName)} ${allocation.quantity}${escapeHtml(allocation.unit)}</div>
            <div class="req-sub">${escapeHtml(allocation.warehouseName)} → ${escapeHtml(allocation.shelterName)}</div>
          </td>
          <td class="alloc-action">
            ${badge(allocation.status === 'delivered' ? COLORS.resolved : COLORS.responding, ALLOCATION_STATUS[allocation.status])}
            ${
              allocation.status === 'delivered'
                ? ''
                : `<button type="button" class="button" data-advance="${escapeAttr(allocation.id)}" data-next="${allocation.status === 'allocated' ? 'shipped' : 'delivered'}">
                    ${allocation.status === 'allocated' ? '配送開始' : '配送完了'}
                  </button>`
            }
          </td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>`;

  el.querySelectorAll('[data-advance]').forEach((button) => {
    button.onclick = async () => {
      button.disabled = true;
      try {
        await patchJson(`/api/allocations/${encodeURIComponent(button.dataset.advance)}`, { status: button.dataset.next });
        await refresh();
      } catch (err) {
        button.disabled = false;
        alert(`更新に失敗しました: ${err.message}`);
      }
    };
  });
}

function renderInventorySelect() {
  const select = document.getElementById('inventory-select');
  const warehouses = state.warehouses.features;

  if (select.options.length !== warehouses.length) {
    select.innerHTML = warehouses
      .map((f) => `<option value="${escapeAttr(f.properties.id)}">${escapeHtml(f.properties.name)}</option>`)
      .join('');
    select.onchange = renderInventoryTable;
  }

  if (state.selectedWarehouseId) select.value = state.selectedWarehouseId;
  renderInventoryTable();
}

function renderInventoryTable() {
  const select = document.getElementById('inventory-select');
  const el = document.getElementById('inventory-table');
  state.selectedWarehouseId = select.value;

  const warehouse = state.warehouses.features.find((f) => f.properties.id === select.value);
  if (!warehouse) {
    el.innerHTML = '';
    return;
  }

  const inventory = parseInventory(warehouse.properties.inventory);

  el.innerHTML = `<table class="logistics-table inventory">
    <tbody>${inventory
      .map(
        (entry) => `<tr class="${entry.quantity === 0 ? 'out-of-stock' : ''}">
          <td>${escapeHtml(entry.name)}</td>
          <td class="req-qty">
            <input type="number" min="0" value="${entry.quantity}" data-inventory="${escapeAttr(entry.item)}" />
            ${escapeHtml(entry.unit)}
          </td>
        </tr>`,
      )
      .join('')}</tbody>
  </table>
  <p class="logistics-hint">${escapeHtml(warehouse.properties.inventoryNote || '')}</p>`;

  el.querySelectorAll('[data-inventory]').forEach((input) => {
    input.onchange = async () => {
      try {
        await patchJson(`/api/warehouses/${encodeURIComponent(select.value)}/inventory`, {
          item: input.dataset.inventory,
          quantity: Number(input.value),
        });
        await refresh();
      } catch (err) {
        alert(`在庫の更新に失敗しました: ${err.message}`);
      }
    };
  });
}

// GeoJSON の properties 経由だと入れ子の配列が文字列化されることがある
function parseInventory(inventory) {
  if (!inventory) return [];
  return typeof inventory === 'string' ? JSON.parse(inventory) : inventory;
}

// 全品目の在庫が尽きた倉庫を、地図上で目立たないグレーにするため合計値を付与する
function markEmptyWarehouses(warehouses) {
  return {
    ...warehouses,
    features: warehouses.features.map((feature) => {
      const totalStock = parseInventory(feature.properties.inventory).reduce(
        (sum, entry) => sum + (Number(entry.quantity) || 0),
        0,
      );
      return { ...feature, properties: { ...feature.properties, totalStock } };
    }),
  };
}

// 2点間の概算距離（km）。割当先の倉庫を近い順に並べるためだけに使う
function distanceInKm([lng1, lat1], [lng2, lat2]) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const earthRadius = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * earthRadius * Math.asin(Math.sqrt(a));
}

// --- モード切替 ---

const MODE_HINTS = {
  hq: '避難所・被害報告をクリックして更新、地図上の何もない場所をクリックすると新規の被害報告を登録できます',
  shelter: '担当する避難所をクリックして、開設状況・被害状況・物資要求を入力してください',
  field: '地図上の被害地点をクリックして報告してください',
};

function setupModeSwitch() {
  document.querySelectorAll('#mode-switch button').forEach((button) => {
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;

      document.querySelectorAll('#mode-switch button').forEach((b) => b.classList.toggle('active', b === button));

      for (const mode of Object.keys(MODE_TARGETS)) {
        document.body.classList.toggle(`mode-${mode}`, state.mode === mode);
      }

      const hint = document.getElementById('mode-hint');
      hint.textContent = MODE_HINTS[state.mode] || '';
      hint.hidden = !MODE_HINTS[state.mode];

      document.getElementById('logistics').hidden = state.mode !== 'logistics';

      if (state.mode === 'logistics') renderLogistics();
      renderLifelineLegend();
    });
  });
}

function startClock() {
  const el = document.getElementById('clock');
  const tick = () => {
    el.textContent = new Date().toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    renderElapsed();
  };
  tick();
  setInterval(tick, 1000);

  document.getElementById('elapsed').onclick = openIncidentDialog;
}

// --- 発災後の経過時間 ---

function renderElapsed() {
  const el = document.getElementById('elapsed');

  if (!state.incident?.occurredAt) {
    el.textContent = '災害未開始（クリックして開始）';
    el.classList.remove('active');
    el.classList.add('needs-start');
    el.title = 'クリックすると新しい災害を開始します';
    return;
  }

  const minutes = Math.floor((Date.now() - new Date(state.incident.occurredAt)) / 60000);
  el.classList.remove('needs-start');
  el.classList.add('active');

  if (minutes < 0) {
    el.textContent = `発災 ${formatTime(state.incident.occurredAt)} 予定`;
  } else {
    el.textContent = `発災後 ${formatElapsed(minutes)}`;
  }
  el.title = `${state.incident.name}／発災 ${formatTime(state.incident.occurredAt)}（クリックで編集・新しい災害の開始）`;
}

function formatElapsed(minutes) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;

  if (days > 0) return `${days}日${hours}時間${mins}分`;
  if (hours > 0) return `${hours}時間${mins}分`;
  return `${mins}分`;
}

// ヘッダーの経過時間ボタン。進行中の災害が無ければ「開始」だけ、あれば「編集」と「仕切り直し」を出す。
function openIncidentDialog() {
  if (!state.incident) {
    openStartIncidentDialog();
    return;
  }

  const current = state.incident;

  const form = showDialog(
    `<h3>進行中の災害</h3>
     <dl>
       ${row('災害名', current.name)}
       ${row('発災時刻', formatTime(current.occurredAt))}
       ${row('入力者', current.declaredBy)}
     </dl>
     <label>災害名<input name="name" value="${escapeAttr(current.name || '')}" /></label>
     <label>発災時刻<input type="datetime-local" name="occurredAt" value="${localDateTimeValue(new Date(current.occurredAt))}" /></label>
     <label>入力者${operatorSelect('declaredBy', current.declaredBy)}</label>
     <div class="field-group">
       <button type="button" class="button" data-action="start-new">この災害を終了し、新しい災害として開始し直す</button>
       <a class="button" href="/report/" target="_blank" rel="noopener">災害の記録を見る（本部会議用レポート）</a>
     </div>`,
    '内容を更新する',
    async (data) => {
      await putJson('/api/incident', {
        name: data.name,
        occurredAt: new Date(data.occurredAt).toISOString(),
        declaredBy: data.declaredBy,
      });
    },
  );

  form.querySelector('[data-action="start-new"]').onclick = () => {
    document.getElementById('dialog').close();
    openStartIncidentDialog();
  };
}

// 新しい災害を開始する＝今の避難所・ライフラインの状態を初期化して画面を仕切り直す。
// 被害報告・物資要求などの記録は削除せず、災害ごとに分けて残る（/report/ から過去分を参照できる）。
function openStartIncidentDialog() {
  const hasActive = !!state.incident;

  showDialog(
    `<h3>新しい災害を開始する</h3>
     ${hasActive ? `<p class="source-note">現在進行中の「${escapeHtml(state.incident.name)}」は終了扱いになります。過去の記録として災害ごとに残るので、あとから確認できます。</p>` : ''}
     <label>災害名<input name="name" value="${escapeAttr(hasActive ? '' : '首都直下地震')}" placeholder="例: 令和8年○月豪雨" /></label>
     <label>発災時刻<input type="datetime-local" name="occurredAt" value="${localDateTimeValue(new Date())}" /></label>
     <label>入力者${operatorSelect('declaredBy')}</label>
     <p class="source-note">開始すると、避難所の開設状況・被害状況・ライフラインの状態はすべて未設定に戻ります。備蓄倉庫の在庫は引き継がれます。</p>`,
    '開始する',
    async (data) => {
      await postJson('/api/incidents', {
        name: data.name,
        occurredAt: new Date(data.occurredAt).toISOString(),
        declaredBy: data.declaredBy,
      });
    },
  );
}

// --- ユーティリティ ---

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function patchJson(url, body) {
  const res = await fetch(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

async function putJson(url, body) {
  const res = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// 入力者は決まった職員区分から選ぶ
function operatorSelect(name, selected) {
  const options = Object.fromEntries(state.operatorRoles.map((role) => [role, role]));
  return select(name, options, selected || state.operatorRoles[0]);
}

function select(name, options, selected) {
  const opts = Object.entries(options)
    .map(([value, text]) => `<option value="${value}"${value === selected ? ' selected' : ''}>${text}</option>`)
    .join('');
  return `<select name="${name}">${opts}</select>`;
}

function row(label, value) {
  if (value === undefined || value === null || value === '') return '';
  return `<dt>${label}</dt><dd>${escapeHtml(String(value))}</dd>`;
}

function label(code) {
  return REPORT_STATUS[code] || SHELTER_STATUS[code] || code;
}

function translate(title) {
  return Object.entries({ ...CATEGORIES, ...SEVERITIES, ...SHELTER_STATUS }).reduce(
    (text, [code, text2]) => text.replace(new RegExp(`\\b${code}\\b`, 'g'), text2),
    title,
  );
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function emptyFc() {
  return { type: 'FeatureCollection', features: [] };
}

function loadGeoloniaScript(apiKey) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://cdn.geolonia.com/embed/v5/embed?geolonia-api-key=${encodeURIComponent(apiKey)}`;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

main();
