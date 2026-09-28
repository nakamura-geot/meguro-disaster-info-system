const STATUS_LABEL = { available: '空きあり', crowded: '混雑', full: '満員', closed: '未開設' };
const REFRESH_INTERVAL = 30000;

const state = { data: null, filter: 'open', map: null };

async function main() {
  setupFilter();

  const config = await fetch('/api/config').then((r) => r.json());
  await loadGeoloniaScript(config.geoloniaApiKey);

  state.map = new geolonia.Map({
    container: 'map',
    style: 'geolonia/gsi',
    center: [139.6982, 35.6339],
    zoom: 12,
    interactive: true,
  });

  state.map.on('load', () => {
    state.map.addSource('shelters', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });

    state.map.addLayer({
      id: 'shelters-circle',
      type: 'circle',
      source: 'shelters',
      paint: {
        'circle-radius': 9,
        'circle-color': [
          'match',
          ['get', 'status'],
          'available', '#047857',
          'crowded', '#d97706',
          'full', '#b45309',
          '#6b7280',
        ],
        'circle-stroke-width': 2.5,
        'circle-stroke-color': '#ffffff',
      },
    });

    render();
  });

  await load();
  setInterval(load, REFRESH_INTERVAL);
}

async function load() {
  state.data = await fetch('/api/public/shelters').then((r) => r.json());
  render();
}

function render() {
  if (!state.data) return;

  renderBanner();
  renderList();
  renderMap();

  document.getElementById('updated').textContent = `最終更新 ${formatTime(state.data.generatedAt)}（30秒ごとに自動更新）`;
}

function renderBanner() {
  const el = document.getElementById('status-banner');
  const { openCount, evacueeTotal, totalCount } = state.data;

  if (openCount === 0) {
    el.className = 'closed';
    el.innerHTML = `現在、避難所は開設されていません
      <span class="sub">開設された場合はこのページに掲載されます（区内の地域避難所 ${totalCount} か所）</span>`;
    return;
  }

  el.className = 'open';
  el.innerHTML = `現在 ${openCount} か所の避難所を開設しています
    <span class="sub">避難者 ${evacueeTotal.toLocaleString('ja-JP')} 人（区内の地域避難所 ${totalCount} か所）</span>`;
}

function renderList() {
  const el = document.getElementById('shelter-list');
  const shelters = visibleShelters();

  if (shelters.length === 0) {
    el.innerHTML = '<li class="empty">開設中の避難所はありません</li>';
    return;
  }

  el.innerHTML = shelters
    .map(
      (shelter) => `<li class="${shelter.status}">
        <div class="shelter-head">
          <span class="shelter-name">${escapeHtml(shelter.name)}</span>
          <span class="shelter-status ${shelter.status}">${STATUS_LABEL[shelter.status]}</span>
        </div>
        <p class="shelter-address">${escapeHtml(shelter.address || '')}</p>
        ${
          shelter.status === 'closed'
            ? ''
            : `<p class="shelter-meta">避難者 ${shelter.evacueeCount.toLocaleString('ja-JP')} 人${
                shelter.status === 'full'
                  ? '／満員のため他の避難所へ向かってください'
                  : shelter.status === 'crowded'
                    ? '／混雑しています'
                    : ''
              }</p>`
        }
        ${shelter.hazardTypes.length ? `<p class="shelter-hazards">対応する災害: ${escapeHtml(shelter.hazardTypes.join('、'))}</p>` : ''}
        <a class="shelter-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${shelter.name} ${shelter.address || ''}`)}" target="_blank" rel="noopener">地図アプリで経路を見る</a>
      </li>`,
    )
    .join('');
}

function renderMap() {
  const source = state.map?.getSource('shelters');
  if (!source) return;

  const features = visibleShelters()
    .filter((shelter) => shelter.location)
    .map((shelter) => ({
      type: 'Feature',
      geometry: shelter.location,
      properties: { name: shelter.name, status: shelter.status },
    }));

  source.setData({ type: 'FeatureCollection', features });
  document.getElementById('map').hidden = features.length === 0;

  if (features.length > 0) {
    state.map.fitBounds(bounds(features), { padding: 40, maxZoom: 15, duration: 0 });
  }
}

function visibleShelters() {
  const shelters = state.data.shelters;
  const open = shelters.filter((shelter) => shelter.status !== 'closed');

  if (state.filter === 'all') {
    // 開設中を先に、その後は名称順
    return [...open, ...shelters.filter((s) => s.status === 'closed').sort((a, b) => a.name.localeCompare(b.name, 'ja'))];
  }

  return open.sort((a, b) => b.evacueeCount - a.evacueeCount);
}

function setupFilter() {
  document.querySelectorAll('#filter button').forEach((button) => {
    button.addEventListener('click', () => {
      state.filter = button.dataset.filter;
      document.querySelectorAll('#filter button').forEach((b) => b.classList.toggle('active', b === button));
      render();
    });
  });
}

function bounds(features) {
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

function formatTime(iso) {
  return new Date(iso).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
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

main();
