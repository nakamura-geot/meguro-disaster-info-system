const LAYERS = [
  { type: 'Aed', label: 'AED', color: '#e63946', fields: ['address', 'municipality'] },
  { type: 'Bridge', label: '橋梁', color: '#f4a261', fields: ['routeName', 'address', 'healthGrade', 'builtYear'] },
  { type: 'Cafe', label: 'カフェ', color: '#8d5524', fields: ['address', 'rating'] },
  { type: 'RailwayStation', label: '鉄道駅', color: '#457b9d', fields: ['operator'] },
];

const FIELD_LABELS = {
  address: '住所',
  municipality: '市区町村',
  routeName: '路線名',
  healthGrade: '健全度',
  builtYear: '建設年',
  rating: '評価',
  operator: '事業者',
};

async function main() {
  const status = document.getElementById('status');
  const layersEl = document.getElementById('layers');

  const config = await fetch('/api/config').then((r) => r.json());
  await loadGeoloniaScript(config.geoloniaApiKey);

  const map = new geolonia.Map({
    container: 'map',
    style: 'geolonia/gsi',
    center: [139.7671, 35.6812],
    zoom: 10,
  });

  map.on('load', async () => {
    status.textContent = 'データ取得中...';
    const results = await Promise.allSettled(LAYERS.map((layer) => loadLayer(map, layer)));

    const allFeatures = [];
    results.forEach((result, i) => {
      const ok = result.status === 'fulfilled';
      const features = ok ? result.value : [];
      allFeatures.push(...features);
      layersEl.appendChild(buildLayerToggle(map, LAYERS[i], features.length, ok));
    });

    const bounds = featureBounds(allFeatures);
    if (bounds) {
      map.fitBounds(bounds, { padding: 80, maxZoom: 14 });
    }

    status.textContent = '読み込み完了';
  });
}

async function loadLayer(map, layer) {
  const res = await fetch(`/api/entities?type=${encodeURIComponent(layer.type)}`);
  if (!res.ok) throw new Error(`${layer.type} の取得に失敗しました`);
  const geojson = await res.json();

  map.addSource(layer.type, { type: 'geojson', data: geojson });

  map.addLayer({
    id: `${layer.type}-circle`,
    type: 'circle',
    source: layer.type,
    paint: {
      'circle-radius': 6,
      'circle-color': layer.color,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#ffffff',
    },
  });

  const popup = new geolonia.Popup({ offset: 12, closeButton: false });

  map.on('mouseenter', `${layer.type}-circle`, (e) => {
    map.getCanvas().style.cursor = 'pointer';
    popup.setLngLat(e.features[0].geometry.coordinates).setHTML(buildPopupHtml(layer, e.features[0].properties)).addTo(map);
  });

  map.on('mouseleave', `${layer.type}-circle`, () => {
    map.getCanvas().style.cursor = '';
    popup.remove();
  });

  return geojson.features;
}

function featureBounds(features) {
  if (features.length === 0) return null;

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;

  for (const feature of features) {
    const [lng, lat] = feature.geometry.coordinates;
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  return [[west, south], [east, north]];
}

function buildPopupHtml(layer, props) {
  const rows = layer.fields
    .filter((key) => props[key] !== undefined && props[key] !== null && props[key] !== '')
    .map((key) => `<dt>${FIELD_LABELS[key] || key}</dt><dd>${escapeHtml(String(props[key]))}</dd>`)
    .join('');

  return `<div class="geonicdb-popup"><h3>${escapeHtml(props.name || props.id)}</h3><dl>${rows}</dl></div>`;
}

function buildLayerToggle(map, layer, count, ok) {
  const label = document.createElement('label');

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = ok;
  checkbox.disabled = !ok;
  checkbox.addEventListener('change', () => {
    map.setLayoutProperty(`${layer.type}-circle`, 'visibility', checkbox.checked ? 'visible' : 'none');
  });

  const dot = document.createElement('span');
  dot.className = 'dot';
  dot.style.background = layer.color;

  const text = document.createElement('span');
  text.textContent = layer.label;

  const countEl = document.createElement('span');
  countEl.className = 'count';
  countEl.textContent = ok ? count : 'エラー';

  label.append(checkbox, dot, text, countEl);
  return label;
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
  return str.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

main();
