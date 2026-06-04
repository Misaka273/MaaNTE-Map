<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet.markercluster'
import {
  initialMapData,
  MAP_HEIGHT,
  MAP_WIDTH,
  TILE_SIZE,
  mapPixelToMapLatLng,
  mapLatLngToWorld,
  worldToMapLatLng,
} from './data/locations'

const clone = (value) => JSON.parse(JSON.stringify(value))
const publicAssetUrl = (path) => path && !/^(?:[a-z]+:)?\/\//i.test(path) && !path.startsWith('data:') && !path.startsWith('blob:')
  ? `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`
  : path
const mapData = ref(clone(initialMapData))
const categories = computed(() => mapData.value.categories)
const visibleCategories = computed(() => categories.value.filter((category) => !category.isHidden))
const locations = computed(() => mapData.value.locations)
const routes = computed(() => mapData.value.routes)
const categoryLookup = computed(() => Object.fromEntries(categories.value.map((category) => [category.id, category])))
const locationLookup = computed(() => Object.fromEntries(locations.value.map((location) => [location.id, location])))
const bounds = L.latLngBounds([-MAP_HEIGHT, 0], [0, MAP_WIDTH])
const INITIAL_ZOOM = -3
const MIN_ZOOM = -3
const MARKER_FILTERS_STORAGE_KEY = 'nte-marker-filters'
const ROUTES_STORAGE_KEY = 'nte-routes'
const COMPLETED_STORAGE_KEY = 'nte-completed'
const isLocalEditor = import.meta.env.DEV
const DEFAULT_NAVIGATION_WEBSOCKET_URL = import.meta.env.VITE_MAANTE_NAVI_WEBSOCKET_URL || 'ws://127.0.0.1:8765'
const NAVIGATION_RECONNECT_DELAY = 2000
const NAVIGATION_CENTER_TOLERANCE_PX = 28
const NAVIGATION_CENTER_SMOOTHING = 0.18
const NAVIGATION_CENTER_MAX_STEP_PX = 48
const DEFAULT_COLLAPSED_CATEGORY_GROUPS = {
  探索度: false,
  传送点: false,
  怪物: true,
}

function readStoredIds(key) {
  try {
    return new Set(JSON.parse(localStorage.getItem(key) || '[]'))
  } catch {
    return new Set()
  }
}

function readStoredMarkerFilters() {
  try {
    return JSON.parse(localStorage.getItem(MARKER_FILTERS_STORAGE_KEY) || 'null')
  } catch {
    return null
  }
}

function readStoredMapView() {
  const storedFilters = readStoredMarkerFilters()
  const mapView = storedFilters?.mapView
  if (!mapView || typeof mapView !== 'object') return null

  const lat = Number(mapView.lat)
  const lng = Number(mapView.lng)
  const zoom = Number(mapView.zoom)

  if (![lat, lng, zoom].every(Number.isFinite)) return null
  return { lat, lng, zoom }
}

function parseNavigationWebSocketUrl(url) {
  try {
    const parsed = new URL(url)
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port || '8765',
    }
  } catch {
    return { host: '127.0.0.1', port: '8765' }
  }
}

function normalizeNavigationHost(value) {
  return String(value || '').trim() || parseNavigationWebSocketUrl(DEFAULT_NAVIGATION_WEBSOCKET_URL).host
}

function normalizeNavigationPort(value) {
  const port = Number(String(value || '').trim())
  return Number.isInteger(port) && port >= 1 && port <= 65535
    ? String(port)
    : parseNavigationWebSocketUrl(DEFAULT_NAVIGATION_WEBSOCKET_URL).port
}

function getInitialCategories() {
  return new Set(visibleCategories.value.map((category) => category.id))
}

function normalizeDistrictLabel(value) {
  const label = String(value || '').trim()
  if (!label) return ''
  if (label === '全地图') return '全地图'
  if (/�/.test(label) && label.endsWith('图')) return '全地图'
  if (/^[鍏ㄥ湴鍥?]+$/.test(label)) return '全地图'
  if (/^全.*图$/.test(label)) return '全地图'
  return label
}

const mapElement = ref(null)
const searchInput = ref(null)
const query = ref('')
const storedMarkerFilters = readStoredMarkerFilters()
const initialCategoryIds = new Set(visibleCategories.value.map((category) => category.id))
const initialTeleportCategoryIds = new Set(
  visibleCategories.value
    .filter((category) => category.group === '传送点')
    .map((category) => category.id),
)
const initialKeepTeleportEnabled = typeof storedMarkerFilters?.keepTeleportEnabled === 'boolean'
  ? storedMarkerFilters.keepTeleportEnabled
  : true
const initialMergeAdjacentLocationsEnabled = typeof storedMarkerFilters?.mergeAdjacentLocationsEnabled === 'boolean'
  ? storedMarkerFilters.mergeAdjacentLocationsEnabled
  : true
const initialActiveCategories = (() => {
  if (!Array.isArray(storedMarkerFilters?.activeCategories)) return initialCategoryIds
  const nextCategories = new Set(storedMarkerFilters.activeCategories.filter((id) => initialCategoryIds.has(id)))
  if (initialKeepTeleportEnabled) {
    initialTeleportCategoryIds.forEach((id) => nextCategories.add(id))
  }
  return nextCategories
})()
const initialActiveDistricts = new Set(
  Array.isArray(storedMarkerFilters?.activeDistricts)
    ? storedMarkerFilters.activeDistricts.map((district) => normalizeDistrictLabel(district)).filter(Boolean)
    : [],
)
const initialCollapsedCategoryGroups = {
  ...DEFAULT_COLLAPSED_CATEGORY_GROUPS,
  ...(storedMarkerFilters?.collapsedCategoryGroups || {}),
}
const activeCategories = ref(initialActiveCategories)
const activeDistricts = ref(initialActiveDistricts)
const keepTeleportEnabled = ref(initialKeepTeleportEnabled)
const mergeAdjacentLocationsEnabled = ref(initialMergeAdjacentLocationsEnabled)
const selectedLocation = ref(null)
const completedIds = ref(readStoredIds(COMPLETED_STORAGE_KEY))
const favoriteIds = ref(readStoredIds('nte-favorites'))
const pendingLocationChanges = ref({
  categories: [],
  upsertLocations: [],
  deletedLocationIds: [],
})
const sessionCreatedLocationIds = new Set()
const sessionCreatedCategoryIds = new Set()
const showIncompleteOnly = ref(storedMarkerFilters?.showIncompleteOnly === true)
const realtimeNavigationEnabled = ref(storedMarkerFilters?.realtimeNavigationEnabled === true)
const centerNavigationEnabled = ref(storedMarkerFilters?.centerNavigationEnabled === true)
const defaultNavigationEndpoint = parseNavigationWebSocketUrl(DEFAULT_NAVIGATION_WEBSOCKET_URL)
const navigationHost = ref(normalizeNavigationHost(storedMarkerFilters?.navigationHost || defaultNavigationEndpoint.host))
const navigationPort = ref(normalizeNavigationPort(storedMarkerFilters?.navigationPort || defaultNavigationEndpoint.port))
const coordinates = ref({ lat: 0, lng: 0 })
const sidebarCollapsed = ref(false)
const districtFilterOpen = ref(storedMarkerFilters?.districtFilterOpen === true)
const clearCompletedConfirming = ref(false)
const editorMode = ref(false)
const editorFormOpen = ref(false)
const editingLocationId = ref(null)
const previewImage = ref('')
const statusMessage = ref('')
const routePanelOpen = ref(false)
const activeRouteId = ref(null)
const isAddingSegment = ref(false)
const segmentPoints = ref([])
const routeImportInput = ref(null)
const completedImportInput = ref(null)
const locationChangesImportInput = ref(null)
const collapsedCategoryGroups = ref(initialCollapsedCategoryGroups)
const navigationConnection = ref('disconnected')
const navigationState = ref({
  position: null,
  angle: null,
  angleConfidence: 0,
})
const navigationConnectionStatus = computed(() =>
  realtimeNavigationEnabled.value ? navigationConnection.value : 'disabled',
)
const navigationConnectionLabel = computed(() => ({
  disabled: 'OFF',
  connected: 'CONNECTED',
  connecting: 'CONNECTING',
  disconnected: 'OFFLINE',
})[navigationConnectionStatus.value])
const navigationWebSocketUrl = computed(() => `ws://${normalizeNavigationHost(navigationHost.value)}:${normalizeNavigationPort(navigationPort.value)}`)

const emptyLocationForm = () => ({
  name: '',
  types: [],
  district: '',
  lat: 0,
  lng: 0,
  description: '',
  tagsText: '',
  customTypeId: '',
  customTypeText: '',
  customTypeGroup: '',
  customTypeNewGroup: '',
  pendingCustomTypes: [],
  images: [],
})
const locationForm = ref(emptyLocationForm())
const editorCategories = computed(() => [...categories.value, ...locationForm.value.pendingCustomTypes])
const editorCategoryGroups = computed(() => [...new Set(editorCategories.value.map((category) => category.group))])

let map
let markerLayer
let arrowLayer
let navigationMarker
let navigationSocket
let navigationReconnectTimer
let navigationClientStopped = false
let navigationDisplayAngle = null
let navigationFollowFrame = 0
let navigationFollowLatLng = null
let districtAutoFitReady = false
let mapViewPersistenceReady = false
let skipNextDistrictAutoFit = false
const markerLookup = new Map()

const activeRoute = computed(() => routes.value.find((route) => route.id === activeRouteId.value) || null)
const getVisibleTypes = (location) => location.types.filter((type) => !categoryLookup.value[type]?.isHidden)
const visibleLocationIds = computed(() => new Set(
  locations.value
    .filter((location) => getVisibleTypes(location).length)
    .map((location) => location.id),
))
const completedCount = computed(() => [...completedIds.value].filter((id) => visibleLocationIds.value.has(id)).length)
const progress = computed(() => Math.round((completedCount.value / Math.max(visibleLocationIds.value.size, 1)) * 100))
const pendingLocationChangeCount = computed(() => (
  pendingLocationChanges.value.upsertLocations.length + pendingLocationChanges.value.deletedLocationIds.length
))
const districtOptions = computed(() => {
  const districts = [...new Set(locations.value.map((location) => normalizeDistrictLabel(location.district)).filter(Boolean))]
  return districts.sort((left, right) => {
    if (left === '全地图') return -1
    if (right === '全地图') return 1
    return left.localeCompare(right, 'zh-CN')
  })
})
const hasActiveDistricts = computed(() => activeDistricts.value.size > 0)
const bulkCompleteCategoryIds = computed(() => (
  [...activeCategories.value].filter((id) => !teleportCategoryIds.value.includes(id))
))
const bulkCompleteLocations = computed(() => {
  if (!activeDistricts.value.size || !bulkCompleteCategoryIds.value.length) return []
  const selectedCategoryIds = new Set(bulkCompleteCategoryIds.value)
  return locations.value.filter((location) => (
    activeDistricts.value.has(normalizeDistrictLabel(location.district))
    && location.types.some((type) => selectedCategoryIds.has(type))
  ))
})
const bulkIncompleteCount = computed(() => (
  bulkCompleteLocations.value.filter((location) => !completedIds.value.has(location.id)).length
))

const filteredLocations = computed(() => {
  const keyword = query.value.trim().toLowerCase()
  return locations.value.filter((location) => {
    const categoryVisible = location.types.some((type) => activeCategories.value.has(type))
    const districtLabel = normalizeDistrictLabel(location.district)
    const districtVisible = !activeDistricts.value.size
      || activeDistricts.value.has(districtLabel)
      || (districtLabel === '全地图' && isTeleportLocation(location))
    const incompleteVisible = !showIncompleteOnly.value || !completedIds.value.has(location.id)
    const typeLabels = location.types.map((type) => categoryLookup.value[type]?.label || type)
    const text = `${location.name} ${districtLabel} ${location.tags.join(' ')} ${typeLabels.join(' ')}`.toLowerCase()
    return categoryVisible && districtVisible && incompleteVisible && (!keyword || text.includes(keyword))
  })
})

const visibleCounts = computed(() =>
  Object.fromEntries(visibleCategories.value.map((category) => [
    category.id,
    locations.value.filter((location) => location.types.includes(category.id)).length,
  ])),
)

const groupedCategories = computed(() => {
  const groups = []
  visibleCategories.value.forEach((category) => {
    let group = groups.find((item) => item.label === category.group)
    if (!group) {
      group = { label: category.group, categories: [] }
      groups.push(group)
    }
    group.categories.push(category)
  })
  return groups
})
const teleportCategoryIds = computed(() =>
  visibleCategories.value.filter((category) => category.group === '传送点').map((category) => category.id),
)
const collapsibleGroupLabels = new Set(['探索度', '传送点', '怪物'])

function restoreMarkerFilters() {
  const storedFilters = readStoredMarkerFilters()
  const validCategoryIds = new Set(visibleCategories.value.map((category) => category.id))

  keepTeleportEnabled.value = typeof storedFilters?.keepTeleportEnabled === 'boolean'
    ? storedFilters.keepTeleportEnabled
    : true
  mergeAdjacentLocationsEnabled.value = typeof storedFilters?.mergeAdjacentLocationsEnabled === 'boolean'
    ? storedFilters.mergeAdjacentLocationsEnabled
    : true
  showIncompleteOnly.value = storedFilters?.showIncompleteOnly === true
  realtimeNavigationEnabled.value = storedFilters?.realtimeNavigationEnabled === true
  centerNavigationEnabled.value = storedFilters?.centerNavigationEnabled === true
  navigationHost.value = normalizeNavigationHost(storedFilters?.navigationHost || defaultNavigationEndpoint.host)
  navigationPort.value = normalizeNavigationPort(storedFilters?.navigationPort || defaultNavigationEndpoint.port)

  if (Array.isArray(storedFilters?.activeCategories)) {
    const nextCategories = new Set(storedFilters.activeCategories.filter((id) => validCategoryIds.has(id)))
    if (keepTeleportEnabled.value) {
      teleportCategoryIds.value.forEach((id) => nextCategories.add(id))
    }
    activeCategories.value = nextCategories
  } else {
    activeCategories.value = getInitialCategories()
  }

  skipNextDistrictAutoFit = Array.isArray(storedFilters?.activeDistricts)
  activeDistricts.value = new Set(
    Array.isArray(storedFilters?.activeDistricts)
      ? storedFilters.activeDistricts.map((district) => normalizeDistrictLabel(district)).filter(Boolean)
      : [],
  )

  const storedCollapsedGroups = storedFilters?.collapsedCategoryGroups
  collapsedCategoryGroups.value = {
    ...DEFAULT_COLLAPSED_CATEGORY_GROUPS,
    ...(storedCollapsedGroups && typeof storedCollapsedGroups === 'object'
      ? Object.fromEntries(
          [...collapsibleGroupLabels].map((label) => [label, Boolean(storedCollapsedGroups[label])]),
        )
      : {}),
  }

  districtFilterOpen.value = storedFilters?.districtFilterOpen === true
}

function persistMarkerFilters() {
  const storedFilters = readStoredMarkerFilters()
  localStorage.setItem(MARKER_FILTERS_STORAGE_KEY, JSON.stringify({
    ...(storedFilters && typeof storedFilters === 'object' ? storedFilters : {}),
    activeCategories: [...activeCategories.value],
    activeDistricts: [...activeDistricts.value],
    keepTeleportEnabled: keepTeleportEnabled.value,
    mergeAdjacentLocationsEnabled: mergeAdjacentLocationsEnabled.value,
    showIncompleteOnly: showIncompleteOnly.value,
    realtimeNavigationEnabled: realtimeNavigationEnabled.value,
    centerNavigationEnabled: centerNavigationEnabled.value,
    navigationHost: normalizeNavigationHost(navigationHost.value),
    navigationPort: normalizeNavigationPort(navigationPort.value),
    districtFilterOpen: districtFilterOpen.value,
    collapsedCategoryGroups: Object.fromEntries(
      [...collapsibleGroupLabels].map((label) => [label, Boolean(collapsedCategoryGroups.value[label])]),
    ),
  }))
}

function persistMapView() {
  if (!map || !mapViewPersistenceReady) return
  if (navigationFollowFrame) return

  const center = map.getCenter()
  const storedFilters = readStoredMarkerFilters()

  localStorage.setItem(MARKER_FILTERS_STORAGE_KEY, JSON.stringify({
    ...(storedFilters && typeof storedFilters === 'object' ? storedFilters : {}),
    mapView: {
      lat: Number(center.lat.toFixed(6)),
      lng: Number(center.lng.toFixed(6)),
      zoom: map.getZoom(),
    },
  }))
}

function showStatus(message) {
  statusMessage.value = message
  window.setTimeout(() => {
    if (statusMessage.value === message) statusMessage.value = ''
  }, 2600)
}

function readStoredRoutes() {
  try {
    const storedRoutes = JSON.parse(localStorage.getItem(ROUTES_STORAGE_KEY) || 'null')
    return Array.isArray(storedRoutes) ? storedRoutes : null
  } catch {
    return null
  }
}

function persistRoutesLocally() {
  localStorage.setItem(ROUTES_STORAGE_KEY, JSON.stringify(routes.value))
}

function downloadJson(payload, filename) {
  const blobUrl = URL.createObjectURL(new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = blobUrl
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(blobUrl), 0)
}

async function loadLatestMapData() {
  if (!isLocalEditor) return
  try {
    const response = await fetch('/api/map-data')
    if (!response.ok) return
    mapData.value = await response.json()
  } catch {
    // Static deployments use the bundled snapshot.
  }
}

function exportLocationChanges(changes) {
  const payload = {
    version: 1,
    type: 'location-changes',
  }
  if (changes.categories?.length) payload.categories = changes.categories
  if (changes.upsertLocations?.length) payload.upsertLocations = changes.upsertLocations
  if (changes.deletedLocationIds?.length) payload.deletedLocationIds = changes.deletedLocationIds
  downloadJson(payload, `MaaNTE-location-changes-${new Date().toISOString().slice(0, 10)}.json`)
  showStatus('点位修改 JSON 已导出')
}

function queueLocationChanges(changes) {
  const pending = pendingLocationChanges.value
  changes.categories?.forEach((category) => {
    const index = pending.categories.findIndex((item) => item.id === category.id)
    if (index >= 0) pending.categories.splice(index, 1, clone(category))
    else pending.categories.push(clone(category))
  })
  changes.upsertLocations?.forEach((location) => {
    const index = pending.upsertLocations.findIndex((item) => item.id === location.id)
    if (index >= 0) pending.upsertLocations.splice(index, 1, clone(location))
    else pending.upsertLocations.push(clone(location))
    pending.deletedLocationIds = pending.deletedLocationIds.filter((id) => id !== location.id)
  })
  changes.deletedLocationIds?.forEach((id) => {
    pending.upsertLocations = pending.upsertLocations.filter((location) => location.id !== id)
    if (!pending.deletedLocationIds.includes(id)) pending.deletedLocationIds.push(id)
  })
}

function discardCreatedLocationChanges(locationId) {
  const pending = pendingLocationChanges.value
  pending.upsertLocations = pending.upsertLocations.filter((location) => location.id !== locationId)
  pending.deletedLocationIds = pending.deletedLocationIds.filter((id) => id !== locationId)

  const usedCategoryIds = new Set(locations.value.flatMap((location) => location.types))
  const unusedCreatedCategoryIds = new Set(
    [...sessionCreatedCategoryIds].filter((id) => !usedCategoryIds.has(id)),
  )
  if (!unusedCreatedCategoryIds.size) return

  pending.categories = pending.categories.filter((category) => !unusedCreatedCategoryIds.has(category.id))
  mapData.value.categories = categories.value.filter((category) => !unusedCreatedCategoryIds.has(category.id))
  unusedCreatedCategoryIds.forEach((id) => sessionCreatedCategoryIds.delete(id))
}

function exportPendingLocationChanges() {
  if (!pendingLocationChangeCount.value) return
  exportLocationChanges(pendingLocationChanges.value)
}

async function persistMapData({ staticChanges = null } = {}) {
  persistRoutesLocally()
  if (staticChanges) queueLocationChanges(staticChanges)
  if (!isLocalEditor) {
    if (staticChanges) exportLocationChanges(staticChanges)
    return
  }
  try {
    const response = await fetch('/api/map-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mapData.value),
    })
    if (!response.ok) throw new Error('保存失败')
    showStatus('本地数据已保存')
  } catch {
    showStatus('本地数据保存失败')
  }
}

function getPrimaryCategory(location) {
  const visibleTypes = getVisibleTypes(location)
  const activeType = visibleTypes.find((type) => activeCategories.value.has(type))
  return categoryLookup.value[activeType || visibleTypes[0]]
}

function categoryIconHtml(category) {
  return category?.iconUrl
    ? `<img src="${publicAssetUrl(category.iconUrl)}" alt="" />`
    : category?.icon || '·'
}

function markerHtml(location) {
  const category = getPrimaryCategory(location)
  const completed = completedIds.value.has(location.id)
  const selected = selectedLocation.value?.id === location.id
  const extraCount = Math.max(getVisibleTypes(location).length - 1, 0)
  return `
    <div class="map-marker ${completed ? 'map-marker--completed' : ''} ${selected ? 'map-marker--selected' : ''}"
      style="--marker-color:${category?.color || '#8adfd6'}">
      <span>${categoryIconHtml(category)}</span>
      ${extraCount ? `<b>+${extraCount}</b>` : ''}
    </div>
  `
}

function createIcon(location) {
  return L.divIcon({
    className: 'marker-shell',
    html: markerHtml(location),
    iconSize: [36, 44],
    iconAnchor: [18, 42],
  })
}

function createMarkerLayer() {
  return mergeAdjacentLocationsEnabled.value
    ? L.markerClusterGroup({
        chunkedLoading: true,
        maxClusterRadius: 52,
        disableClusteringAtZoom: 0,
        showCoverageOnHover: false,
      })
    : L.layerGroup()
}

function rebuildMarkerLayer() {
  if (!map) return
  markerLayer?.clearLayers()
  markerLayer?.remove()
  markerLayer = createMarkerLayer().addTo(map)
  renderMarkers()
}

function selectLocation(location, fly = true) {
  selectedLocation.value = location
  renderMarkers()
  if (fly && map) {
    map.flyTo(worldToMapLatLng(location), Math.max(map.getZoom(), -2), { duration: 0.45 })
  }
}

function addRouteMarker(locationId) {
  if (!isAddingSegment.value) return
  const location = locationLookup.value[locationId]
  if (!location || segmentPoints.value.at(-1)?.locationId === locationId) return
  segmentPoints.value = [...segmentPoints.value, {
    locationId,
    lat: location.lat,
    lng: location.lng,
  }]
  renderRouteArrows()
}

function addRouteCoordinate(point) {
  if (!isAddingSegment.value) return
  const previous = segmentPoints.value.at(-1)
  if (previous && previous.lat === point.lat && previous.lng === point.lng) return
  segmentPoints.value = [...segmentPoints.value, {
    lat: Number(point.lat.toFixed(6)),
    lng: Number(point.lng.toFixed(6)),
  }]
  renderRouteArrows()
}

function renderMarkers() {
  if (!markerLayer) return
  markerLayer.clearLayers()
  markerLookup.clear()
  filteredLocations.value.forEach((location) => {
    const marker = L.marker(worldToMapLatLng(location), {
      icon: createIcon(location),
      title: location.name,
      riseOnHover: true,
    }).on('click', () => {
      if (isAddingSegment.value) addRouteMarker(location.id)
      else selectLocation(location, false)
    })
    markerLayer.addLayer(marker)
    markerLookup.set(location.id, marker)
  })
}

function drawArrow(from, to, color, temporary = false) {
  const start = worldToMapLatLng(from)
  const end = worldToMapLatLng(to)
  L.polyline([start, end], {
    color,
    weight: 3,
    opacity: temporary ? 0.7 : 0.9,
    dashArray: temporary ? '7 6' : undefined,
  }).addTo(arrowLayer)
  const mid = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  const angle = -Math.atan2(end[0] - start[0], end[1] - start[1]) * 180 / Math.PI
  L.marker(mid, {
    interactive: false,
    icon: L.divIcon({
      className: 'route-arrow',
      html: `<i style="transform:rotate(${angle}deg);border-left-color:${color}"></i>`,
      iconSize: [10, 10],
      iconAnchor: [5, 5],
    }),
  }).addTo(arrowLayer)
}

function normalizeRoutePoint(point) {
  if (typeof point === 'string') {
    const location = locationLookup.value[point]
    return location ? { locationId: point, lat: location.lat, lng: location.lng } : null
  }
  if (!point || typeof point !== 'object') return null
  const location = point.locationId ? locationLookup.value[point.locationId] : null
  const lat = Number(location?.lat ?? point.lat)
  const lng = Number(location?.lng ?? point.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return {
    ...(point.locationId ? { locationId: String(point.locationId) } : {}),
    lat,
    lng,
  }
}

function getSegmentPoints(segment) {
  const points = Array.isArray(segment?.points) ? segment.points : segment?.markerIds
  return Array.isArray(points) ? points.map(normalizeRoutePoint).filter(Boolean) : []
}

function drawRoutePath(points, color, temporary = false) {
  points.forEach((point, index) => {
    L.circleMarker(worldToMapLatLng(point), {
      className: 'route-point',
      color,
      fillColor: color,
      fillOpacity: temporary ? 0.72 : 0.9,
      opacity: 1,
      radius: point.locationId ? 4 : 5,
      weight: 2,
    }).addTo(arrowLayer)
    if (index > 0) drawArrow(points[index - 1], point, color, temporary)
  })
}

function normalizeRoutes(importedRoutes) {
  return importedRoutes.filter((route) => route && typeof route === 'object').map((route, routeIndex) => ({
    id: String(route.id || `route-${Date.now()}-${routeIndex}`),
    name: String(route.name || `路线 ${routeIndex + 1}`),
    segments: Array.isArray(route.segments) ? route.segments.filter((segment) => segment && typeof segment === 'object').map((segment, segmentIndex) => ({
      id: String(segment.id || `segment-${Date.now()}-${routeIndex}-${segmentIndex}`),
      name: String(segment.name || `路段 ${segmentIndex + 1}`),
      points: getSegmentPoints(segment),
    })) : [],
  }))
}

function exportRoutes() {
  const payload = {
    version: 1,
    routes: normalizeRoutes(routes.value),
  }
  downloadJson(payload, `MaaNTE-routes-${new Date().toISOString().slice(0, 10)}.json`)
  showStatus('路线 JSON 已导出')
}

async function importRoutes(event) {
  const [file] = event.target.files || []
  event.target.value = ''
  if (!file) return
  try {
    const payload = JSON.parse(await file.text())
    const importedRoutes = Array.isArray(payload) ? payload : payload.routes
    if (!Array.isArray(importedRoutes)) throw new Error('invalid routes')
    mapData.value.routes = normalizeRoutes(importedRoutes)
    activeRouteId.value = routes.value[0]?.id || null
    cancelSegment()
    await persistMapData()
    renderRouteArrows()
    showStatus(`已导入 ${routes.value.length} 条路线`)
  } catch {
    showStatus('路线 JSON 格式无效')
  }
}

function renderRouteArrows() {
  if (!arrowLayer) return
  arrowLayer.clearLayers()
  if (isAddingSegment.value) {
    drawRoutePath(segmentPoints.value, '#ffd27d', true)
    return
  }
  const colors = ['#ffd27d', '#8adfd6', '#e8a6ff', '#ff8a70', '#87a9ff']
  activeRoute.value?.segments.forEach((segment, index) => drawRoutePath(getSegmentPoints(segment), colors[index % colors.length]))
}

function createNavigationIcon() {
  return L.divIcon({
    className: 'navigation-arrow-shell',
    html: `<div class="navigation-arrow"><img src="${publicAssetUrl('/images/map_webview_pointer.png')}" alt=""></div>`,
    iconSize: [30, 35],
    iconAnchor: [15, 18],
  })
}

function updateNavigationMarkerAngle(angle) {
  if (!Number.isFinite(angle)) return
  if (navigationDisplayAngle === null) {
    navigationDisplayAngle = angle
  } else {
    const delta = ((angle - navigationDisplayAngle + 540) % 360) - 180
    navigationDisplayAngle += delta
  }
  const image = navigationMarker?.getElement()?.querySelector('.navigation-arrow img')
  if (image) image.style.transform = `rotate(${navigationDisplayAngle}deg)`
}

function stopNavigationFollow(persist = true) {
  if (navigationFollowFrame) {
    window.cancelAnimationFrame(navigationFollowFrame)
    navigationFollowFrame = 0
  }
  navigationFollowLatLng = null
  if (persist) persistMapView()
}

function stepNavigationFollow() {
  if (!centerNavigationEnabled.value || !map || !navigationFollowLatLng) {
    stopNavigationFollow(false)
    return
  }

  const size = map.getSize()
  const centerPoint = L.point(size.x / 2, size.y / 2)
  const targetPoint = map.latLngToContainerPoint(navigationFollowLatLng)
  const delta = targetPoint.subtract(centerPoint)
  const distance = Math.sqrt(delta.x ** 2 + delta.y ** 2)

  if (distance <= NAVIGATION_CENTER_TOLERANCE_PX) {
    stopNavigationFollow()
    return
  }

  const stepDistance = Math.min(
    (distance - NAVIGATION_CENTER_TOLERANCE_PX) * NAVIGATION_CENTER_SMOOTHING,
    NAVIGATION_CENTER_MAX_STEP_PX,
  )
  map.panBy(delta.multiplyBy(stepDistance / distance), { animate: false })
  navigationFollowFrame = window.requestAnimationFrame(stepNavigationFollow)
}

function centerNavigationMarker(latlng) {
  if (!centerNavigationEnabled.value || !map || !latlng) return
  navigationFollowLatLng = latlng
  if (!navigationFollowFrame) {
    navigationFollowFrame = window.requestAnimationFrame(stepNavigationFollow)
  }
}

function renderNavigationArrow() {
  if (!map || !navigationState.value.position) {
    navigationMarker?.setOpacity(0)
    stopNavigationFollow()
    return
  }
  const latlng = mapPixelToMapLatLng(navigationState.value.position)
  if (!navigationMarker) {
    navigationMarker = L.marker(latlng, {
      icon: createNavigationIcon(),
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000000,
    }).addTo(map)
  }
  navigationMarker.setLatLng(latlng)
  navigationMarker.setOpacity(1)
  centerNavigationMarker(latlng)
  const arrow = navigationMarker.getElement()?.querySelector('.navigation-arrow')
  if (arrow) {
    arrow.classList.toggle('navigation-arrow--angle-missing', navigationState.value.angle === null)
  }
  updateNavigationMarkerAngle(navigationState.value.angle)
}

function clearNavigationState() {
  navigationState.value = {
    position: null,
    angle: null,
    angleConfidence: 0,
  }
  navigationDisplayAngle = null
  renderNavigationArrow()
}

function handleNavigationMessage(event) {
  try {
    const payload = JSON.parse(event.data)
    if (payload.type !== 'navi-state' || payload.version !== 1) return
    const pixelX = Number(payload.position?.pixelX)
    const pixelY = Number(payload.position?.pixelY)
    const sourceWidth = Number(payload.position?.sourceWidth)
    const sourceHeight = Number(payload.position?.sourceHeight)
    const angle = Number(payload.angle)
    navigationState.value = {
      position: Number.isFinite(pixelX) && Number.isFinite(pixelY)
        ? {
            pixelX,
            pixelY,
            sourceWidth: Number.isFinite(sourceWidth) && sourceWidth > 0 ? sourceWidth : MAP_WIDTH,
            sourceHeight: Number.isFinite(sourceHeight) && sourceHeight > 0 ? sourceHeight : MAP_HEIGHT,
          }
        : null,
      angle: payload.angle !== null && Number.isFinite(angle) ? angle : null,
      angleConfidence: Number(payload.angleConfidence) || 0,
    }
    renderNavigationArrow()
  } catch {
    // Ignore malformed messages and continue consuming the local stream.
  }
}

function scheduleNavigationReconnect() {
  if (navigationClientStopped || !realtimeNavigationEnabled.value || navigationReconnectTimer) return
  navigationReconnectTimer = window.setTimeout(() => {
    navigationReconnectTimer = null
    connectNavigationSocket()
  }, NAVIGATION_RECONNECT_DELAY)
}

function disconnectNavigationSocket() {
  if (navigationReconnectTimer) {
    window.clearTimeout(navigationReconnectTimer)
    navigationReconnectTimer = null
  }
  const socket = navigationSocket
  navigationSocket = null
  if (socket) {
    socket.removeEventListener('message', handleNavigationMessage)
    socket.close()
  }
  navigationConnection.value = 'disconnected'
  clearNavigationState()
}

function connectNavigationSocket() {
  if (navigationClientStopped || !realtimeNavigationEnabled.value || navigationSocket) return
  navigationConnection.value = 'connecting'
  const socket = new WebSocket(navigationWebSocketUrl.value)
  navigationSocket = socket
  socket.addEventListener('open', () => {
    if (navigationSocket === socket) navigationConnection.value = 'connected'
  })
  socket.addEventListener('message', handleNavigationMessage)
  socket.addEventListener('close', () => {
    if (navigationSocket !== socket) return
    navigationSocket = null
    navigationConnection.value = 'disconnected'
    scheduleNavigationReconnect()
  })
  socket.addEventListener('error', () => socket.close())
}

function applyNavigationEndpoint() {
  navigationHost.value = normalizeNavigationHost(navigationHost.value)
  navigationPort.value = normalizeNavigationPort(navigationPort.value)
  persistMarkerFilters()
  if (realtimeNavigationEnabled.value) {
    disconnectNavigationSocket()
    connectNavigationSocket()
  }
}

function focusSegment(segment) {
  if (!map) return
  const points = getSegmentPoints(segment).map(worldToMapLatLng)
  if (points.length) map.flyToBounds(L.latLngBounds(points), { padding: [80, 80], duration: 0.45 })
}

function fitLocationsBounds(targetLocations) {
  if (!map || !targetLocations.length) return
  if (targetLocations.length === 1) {
    map.flyTo(worldToMapLatLng(targetLocations[0]), -1, { duration: 0.45 })
    return
  }
  const points = targetLocations.map(worldToMapLatLng)
  map.flyToBounds(L.latLngBounds(points).pad(0.1), { duration: 0.45 })
}

function isTeleportLocation(location) {
  return location.types.some((type) => teleportCategoryIds.value.includes(type))
}

function toggleCategory(categoryId) {
  if (keepTeleportEnabled.value && teleportCategoryIds.value.includes(categoryId)) return
  const next = new Set(activeCategories.value)
  next.has(categoryId) ? next.delete(categoryId) : next.add(categoryId)
  activeCategories.value = next
}

function isGroupFullySelected(group) {
  return group.categories.every((category) => activeCategories.value.has(category.id))
}

function isGroupPartiallySelected(group) {
  const selectedCount = group.categories.filter((category) => activeCategories.value.has(category.id)).length
  return selectedCount > 0 && selectedCount < group.categories.length
}

function toggleCategoryGroupSelection(group) {
  const categoryIds = group.categories.map((category) => category.id)
  if (group.label === '传送点' && keepTeleportEnabled.value && isGroupFullySelected(group)) return

  const next = new Set(activeCategories.value)
  if (isGroupFullySelected(group)) {
    categoryIds.forEach((categoryId) => {
      if (!(keepTeleportEnabled.value && teleportCategoryIds.value.includes(categoryId))) {
        next.delete(categoryId)
      }
    })
  } else {
    categoryIds.forEach((categoryId) => next.add(categoryId))
  }
  activeCategories.value = next
}

function toggleDistrict(district) {
  const next = new Set(activeDistricts.value)
  next.has(district) ? next.delete(district) : next.add(district)
  activeDistricts.value = next
}

function clearDistricts() {
  activeDistricts.value = new Set()
}

function toggleCategoryGroup(groupLabel) {
  if (!collapsibleGroupLabels.has(groupLabel)) return
  collapsedCategoryGroups.value = {
    ...collapsedCategoryGroups.value,
    [groupLabel]: !collapsedCategoryGroups.value[groupLabel],
  }
}

function isCategoryGroupCollapsed(groupLabel) {
  return Boolean(collapsedCategoryGroups.value[groupLabel])
}

function selectAllCategories() {
  activeCategories.value = new Set(visibleCategories.value.map((category) => category.id))
}

function clearCategories() {
  activeCategories.value = new Set(keepTeleportEnabled.value ? teleportCategoryIds.value : [])
}

function toggleTeleportProtection() {
  keepTeleportEnabled.value = !keepTeleportEnabled.value
  if (!keepTeleportEnabled.value) return
  activeCategories.value = new Set([...activeCategories.value, ...teleportCategoryIds.value])
}

function toggleCompleted(locationId) {
  const next = new Set(completedIds.value)
  next.has(locationId) ? next.delete(locationId) : next.add(locationId)
  completedIds.value = next
  localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
}

function completeDistrictCategory() {
  if (!bulkIncompleteCount.value) return
  const newlyCompletedCount = bulkIncompleteCount.value
  const districtCopy = activeDistricts.value.size === 1
    ? `“${[...activeDistricts.value][0]}”区域内`
    : `${activeDistricts.value.size} 个已选区域内`
  const categoryCopy = bulkCompleteCategoryIds.value.length === 1
    ? `“${categoryLookup.value[bulkCompleteCategoryIds.value[0]]?.label || bulkCompleteCategoryIds.value[0]}”标签`
    : `${bulkCompleteCategoryIds.value.length} 个已选标签`
  if (!window.confirm(`将${districtCopy}命中${categoryCopy}的 ${newlyCompletedCount} 个点位标记为已完成？`)) return

  const next = new Set(completedIds.value)
  bulkCompleteLocations.value.forEach((location) => next.add(location.id))
  completedIds.value = next
  localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
  showStatus(`已完成 ${newlyCompletedCount} 个点位`)
}

function removeLocationReferencesFromRoutes(locationIds) {
  const deletedIds = new Set(locationIds)
  mapData.value.routes.forEach((route) => {
    route.segments.forEach((segment) => {
      segment.points = getSegmentPoints(segment).map((point) => (
        point.locationId && deletedIds.has(point.locationId)
          ? { lat: point.lat, lng: point.lng }
          : point
      ))
      delete segment.markerIds
    })
  })
}

function normalizeLocationChanges(payload) {
  if (!payload || payload.type !== 'location-changes') throw new Error('invalid location changes')
  const categories = Array.isArray(payload.categories)
    ? payload.categories.filter((category) => category && typeof category === 'object' && typeof category.id === 'string')
    : []
  const upsertLocations = Array.isArray(payload.upsertLocations)
    ? payload.upsertLocations.filter((location) => location && typeof location === 'object' && typeof location.id === 'string')
    : []
  const deletedLocationIds = Array.isArray(payload.deletedLocationIds)
    ? payload.deletedLocationIds.filter((id) => typeof id === 'string' && id)
    : []
  return { categories, upsertLocations, deletedLocationIds }
}

async function importLocationChanges(event) {
  const [file] = event.target.files || []
  event.target.value = ''
  if (!file) return
  try {
    const changes = normalizeLocationChanges(JSON.parse(await file.text()))
    changes.categories.forEach((category) => {
      const index = categories.value.findIndex((item) => item.id === category.id)
      if (index >= 0) mapData.value.categories.splice(index, 1, category)
      else mapData.value.categories.push(category)
    })
    changes.upsertLocations.forEach((location) => {
      const index = locations.value.findIndex((item) => item.id === location.id)
      if (index >= 0) mapData.value.locations.splice(index, 1, location)
      else mapData.value.locations.push(location)
    })
    if (changes.deletedLocationIds.length) {
      const deletedIds = new Set(changes.deletedLocationIds)
      mapData.value.locations = locations.value.filter((location) => !deletedIds.has(location.id))
      removeLocationReferencesFromRoutes(deletedIds)
      if (selectedLocation.value && deletedIds.has(selectedLocation.value.id)) selectedLocation.value = null
    }
    await persistMapData()
    renderMarkers()
    renderRouteArrows()
    showStatus(`已导入 ${changes.upsertLocations.length} 条点位修改，删除 ${changes.deletedLocationIds.length} 个点位`)
  } catch {
    showStatus('点位修改 JSON 格式无效')
  }
}

function exportCompleted() {
  downloadJson({
    version: 1,
    completedIds: [...completedIds.value],
  }, `MaaNTE-completed-${new Date().toISOString().slice(0, 10)}.json`)
  showStatus('完成记录 JSON 已导出')
}

async function importCompleted(event) {
  const [file] = event.target.files || []
  event.target.value = ''
  if (!file) return
  try {
    const payload = JSON.parse(await file.text())
    const importedIds = Array.isArray(payload) ? payload : payload.completedIds
    if (!Array.isArray(importedIds)) throw new Error('invalid completed ids')
    const next = new Set(importedIds.filter((id) => typeof id === 'string' && id))
    completedIds.value = next
    localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([...next]))
    clearCompletedConfirming.value = false
    showStatus(`已导入 ${next.size} 条完成记录`)
  } catch {
    showStatus('完成记录 JSON 格式无效')
  }
}

function toggleFavorite(locationId) {
  const next = new Set(favoriteIds.value)
  next.has(locationId) ? next.delete(locationId) : next.add(locationId)
  favoriteIds.value = next
  localStorage.setItem('nte-favorites', JSON.stringify([...next]))
}

function beginClearCompleted() {
  if (!completedIds.value.size) return
  clearCompletedConfirming.value = true
}

function cancelClearCompleted() {
  clearCompletedConfirming.value = false
}

function clearCompleted() {
  completedIds.value = new Set()
  localStorage.setItem(COMPLETED_STORAGE_KEY, JSON.stringify([]))
  clearCompletedConfirming.value = false
  showStatus('已清空完成记录')
}

function resetView() {
  map?.setView(bounds.getCenter(), INITIAL_ZOOM)
}

function restoreMapView() {
  if (!map) return false

  const storedMapView = readStoredMapView()
  if (!storedMapView) return false

  const center = L.latLng(storedMapView.lat, storedMapView.lng)
  if (!bounds.pad(0.18).contains(center)) return false

  const zoom = Math.min(Math.max(storedMapView.zoom, map.getMinZoom()), map.getMaxZoom())
  map.setView(center, zoom, { animate: false })
  return true
}

function copyCoordinates() {
  if (!selectedLocation.value) return
  navigator.clipboard?.writeText(`${selectedLocation.value.lat.toFixed(6)}, ${selectedLocation.value.lng.toFixed(6)}`)
  showStatus('坐标已复制')
}

function openCreateLocation(point) {
  editingLocationId.value = null
  locationForm.value = { ...emptyLocationForm(), ...point, types: visibleCategories.value.length ? [visibleCategories.value[0].id] : [] }
  editorFormOpen.value = true
}

function openEditLocation(location) {
  editingLocationId.value = location.id
  locationForm.value = {
    ...emptyLocationForm(),
    ...clone(location),
    tagsText: location.tags.join(', '),
    images: [...location.images],
  }
  editorFormOpen.value = true
}

function addCustomType() {
  const idPrefix = locationForm.value.customTypeId.trim()
  const label = locationForm.value.customTypeText.trim()
  const group = locationForm.value.customTypeNewGroup.trim() || locationForm.value.customTypeGroup
  if (!idPrefix || !label || !group) return
  let id = idPrefix
  let suffix = 2
  while (editorCategories.value.some((category) => category.id === id)) {
    id = `${idPrefix}-${suffix}`
    suffix += 1
  }
  const category = {
    id,
    group,
    label,
    icon: '·',
    color: '#87a9ff',
    isDefault: false,
  }
  locationForm.value.pendingCustomTypes.push(category)
  locationForm.value.types.push(category.id)
  locationForm.value.customTypeId = ''
  locationForm.value.customTypeText = ''
  locationForm.value.customTypeGroup = group
  locationForm.value.customTypeNewGroup = ''
}

async function saveLocation() {
  const form = locationForm.value
  if (!form.name.trim() || !form.types.length) {
    showStatus('请填写名称并选择至少一个类型')
    return
  }
  const addedCategories = clone(form.pendingCustomTypes)
  mapData.value.categories.push(...addedCategories)
  addedCategories.forEach((category) => sessionCreatedCategoryIds.add(category.id))
  const isNewLocation = !editingLocationId.value
  const saved = {
    id: editingLocationId.value || `local-${Date.now()}`,
    name: form.name.trim(),
    types: [...form.types],
    district: form.district.trim() || '全地图',
    lat: Number(form.lat),
    lng: Number(form.lng),
    description: form.description.trim(),
    tags: form.tagsText.split(',').map((tag) => tag.trim()).filter(Boolean),
    images: [...form.images],
  }
  const index = locations.value.findIndex((location) => location.id === saved.id)
  if (index >= 0) mapData.value.locations.splice(index, 1, saved)
  else mapData.value.locations.push(saved)
  if (isNewLocation) sessionCreatedLocationIds.add(saved.id)
  editorFormOpen.value = false
  selectedLocation.value = saved
  await persistMapData({
    staticChanges: {
      categories: addedCategories,
      upsertLocations: [saved],
    },
  })
  renderMarkers()
}

async function deleteLocation(location) {
  if (!window.confirm(`删除“${location.name}”？`)) return
  const wasCreatedThisSession = sessionCreatedLocationIds.has(location.id)
  mapData.value.locations = locations.value.filter((item) => item.id !== location.id)
  removeLocationReferencesFromRoutes([location.id])
  if (wasCreatedThisSession) {
    sessionCreatedLocationIds.delete(location.id)
    discardCreatedLocationChanges(location.id)
  }
  selectedLocation.value = null
  await persistMapData({
    staticChanges: wasCreatedThisSession ? null : { deletedLocationIds: [location.id] },
  })
  renderMarkers()
  renderRouteArrows()
  if (wasCreatedThisSession) showStatus('已删除新建点位，未保留修改记录')
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

async function uploadImages(event) {
  const files = [...event.target.files]
  for (const file of files) {
    try {
      const response = await fetch('/api/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl: await readFileAsDataUrl(file), name: file.name }),
      })
      const data = await response.json()
      if (!data.ok) throw new Error(data.error)
      locationForm.value.images.push(data.path)
    } catch {
      showStatus('图片上传失败，请使用本地开发服务器')
    }
  }
  event.target.value = ''
}

async function createRoute() {
  const name = window.prompt('路线名称')
  if (!name?.trim()) return
  const route = { id: `route-${Date.now()}`, name: name.trim(), segments: [] }
  mapData.value.routes.push(route)
  activeRouteId.value = route.id
  await persistMapData()
}

async function deleteRoute(route) {
  if (!window.confirm(`删除路线“${route.name}”？`)) return
  mapData.value.routes = routes.value.filter((item) => item.id !== route.id)
  activeRouteId.value = null
  await persistMapData()
  renderRouteArrows()
}

function startSegment() {
  if (!activeRoute.value) return
  isAddingSegment.value = true
  segmentPoints.value = []
  selectedLocation.value = null
}

function cancelSegment() {
  isAddingSegment.value = false
  segmentPoints.value = []
  renderRouteArrows()
}

async function finishSegment() {
  if (!activeRoute.value || segmentPoints.value.length < 2) return
  const name = window.prompt('路段名称')
  if (!name?.trim()) return
  activeRoute.value.segments.push({
    id: `segment-${Date.now()}`,
    name: name.trim(),
    points: [...segmentPoints.value],
  })
  isAddingSegment.value = false
  segmentPoints.value = []
  await persistMapData()
  renderRouteArrows()
}

async function deleteSegment(segment) {
  if (!activeRoute.value || !window.confirm(`删除路段“${segment.name}”？`)) return
  activeRoute.value.segments = activeRoute.value.segments.filter((item) => item.id !== segment.id)
  await persistMapData()
  renderRouteArrows()
}

function handleKeydown(event) {
  if (event.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
    event.preventDefault()
    searchInput.value?.focus()
  }
  if (event.key === 'Escape') {
    previewImage.value = ''
    editorFormOpen.value = false
    selectedLocation.value = null
    clearCompletedConfirming.value = false
    searchInput.value?.blur()
  }
}

watch([filteredLocations, completedIds, () => selectedLocation.value?.id], () => nextTick(renderMarkers), { deep: true })
watch(filteredLocations, (visibleLocations) => {
  if (selectedLocation.value && !visibleLocations.some((location) => location.id === selectedLocation.value.id)) {
    selectedLocation.value = null
  }
})
watch(activeDistricts, async () => {
  if (skipNextDistrictAutoFit) {
    skipNextDistrictAutoFit = false
    return
  }
  if (!districtAutoFitReady) return
  await nextTick()
  const focusLocations = filteredLocations.value.filter((location) => !isTeleportLocation(location))
  fitLocationsBounds(focusLocations.length ? focusLocations : filteredLocations.value)
}, { deep: true })
watch(activeDistricts, persistMarkerFilters, { deep: true })
watch(activeRouteId, () => nextTick(renderRouteArrows))
watch([() => [...activeCategories.value], keepTeleportEnabled, showIncompleteOnly], persistMarkerFilters)
watch(mergeAdjacentLocationsEnabled, () => {
  persistMarkerFilters()
  rebuildMarkerLayer()
})
watch(realtimeNavigationEnabled, () => {
  persistMarkerFilters()
  if (realtimeNavigationEnabled.value) connectNavigationSocket()
  else {
    centerNavigationEnabled.value = false
    disconnectNavigationSocket()
  }
})
watch(centerNavigationEnabled, () => {
  persistMarkerFilters()
  if (!centerNavigationEnabled.value) stopNavigationFollow()
  renderNavigationArrow()
})
watch(districtFilterOpen, persistMarkerFilters)
watch(collapsedCategoryGroups, persistMarkerFilters, { deep: true })

onMounted(async () => {
  await loadLatestMapData()
  const storedRoutes = readStoredRoutes()
  if (storedRoutes) mapData.value.routes = normalizeRoutes(storedRoutes)
  restoreMarkerFilters()
  map = L.map(mapElement.value, {
    crs: L.CRS.Simple,
    minZoom: MIN_ZOOM,
    maxZoom: 1,
    maxBounds: bounds.pad(0.18),
    zoomControl: false,
    attributionControl: false,
  })
  L.tileLayer(publicAssetUrl('/tiles/{z}/{x}/{y}.jpg'), {
    bounds,
    minZoom: MIN_ZOOM,
    maxNativeZoom: 0,
    maxZoom: 1,
    noWrap: true,
    tileSize: TILE_SIZE,
    keepBuffer: 3,
  }).addTo(map)
  L.control.zoom({ position: 'bottomright' }).addTo(map)
  markerLayer = createMarkerLayer().addTo(map)
  arrowLayer = L.layerGroup().addTo(map)
  map.on('mousemove', ({ latlng }) => { coordinates.value = mapLatLngToWorld(latlng) })
  map.on('click', ({ latlng }) => {
    selectedLocation.value = null
    if (isAddingSegment.value) addRouteCoordinate(mapLatLngToWorld(latlng))
    else if (editorMode.value) openCreateLocation(mapLatLngToWorld(latlng))
    renderMarkers()
  })
  map.on('moveend', persistMapView)
  if (!restoreMapView()) resetView()
  mapElement.value.dataset.minZoom = String(map.getMinZoom())
  mapElement.value.dataset.initialZoom = String(map.getZoom())
  renderMarkers()
  mapViewPersistenceReady = true
  persistMapView()
  districtAutoFitReady = true
  if (realtimeNavigationEnabled.value) connectNavigationSocket()
  window.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  navigationClientStopped = true
  if (navigationReconnectTimer) window.clearTimeout(navigationReconnectTimer)
  navigationSocket?.close()
  stopNavigationFollow(false)
  navigationMarker?.remove()
  window.removeEventListener('keydown', handleKeydown)
  map?.remove()
})
</script>

<template>
  <main class="app-shell">
    <div ref="mapElement" class="map-canvas" />

    <header class="topbar glass-panel">
      <div class="brand-block topbar-brand">
        <img class="brand-mark" :src="publicAssetUrl('/logo.png')" alt="MaaNTE" />
        <div>
          <p class="eyebrow">MaaNTE Map</p>
          <h1>MaaNTE在线地图工具</h1>
        </div>
      </div>
      <div class="topbar-search">
        <label class="search-box">
        <span class="search-icon">⌕</span>
        <input ref="searchInput" v-model="query" type="search" placeholder="搜索地点、区域或关键词..." />
        <kbd>/</kbd>
        </label>
      </div>
      <div class="toolbar topbar-tools">
        <button :class="{ 'toolbar-button--active': editorMode }" type="button" @click="editorMode = !editorMode">
          {{ editorMode ? '编辑已开启' : '编辑地图' }}
        </button>
        <button v-if="editorMode" type="button" @click="locationChangesImportInput?.click()">导入点位修改</button>
        <button v-if="editorMode" type="button" :disabled="!pendingLocationChangeCount" @click="exportPendingLocationChanges">
          导出点位修改<span v-if="pendingLocationChangeCount">（{{ pendingLocationChangeCount }}）</span>
        </button>
        <input ref="locationChangesImportInput" class="toolbar-file-input" type="file" accept="application/json,.json" @change="importLocationChanges" />
        <button :class="{ 'toolbar-button--active': routePanelOpen }" type="button" @click="routePanelOpen = !routePanelOpen">
          路线
        </button>
        <div class="progress-block">
          <div class="progress-copy"><span>探索进度</span><strong>{{ progress }}%</strong></div>
          <div class="progress-track"><i :style="{ width: `${progress}%` }" /></div>
          <div class="progress-footer">
            <small>{{ completedCount }} / {{ visibleLocationIds.size }} 已完成</small>
            <button v-if="!clearCompletedConfirming" type="button" class="text-button progress-clear-button" :disabled="!completedIds.size" @click="beginClearCompleted">清空</button>
          </div>
          <div class="progress-file-actions">
            <button type="button" @click="completedImportInput?.click()">导入</button>
            <button type="button" @click="exportCompleted">导出</button>
            <input ref="completedImportInput" type="file" accept="application/json,.json" @change="importCompleted" />
          </div>
          <div v-if="clearCompletedConfirming" class="progress-confirm-popover glass-panel">
            <span class="progress-confirm-copy">确认清空？</span>
            <div class="progress-confirm-actions">
              <button type="button" class="progress-action-button progress-action-button--danger" @click="clearCompleted">确认</button>
              <button type="button" class="progress-action-button" @click="cancelClearCompleted">取消</button>
            </div>
          </div>
        </div>
      </div>
    </header>

    <aside class="sidebar glass-panel" :class="{ 'sidebar--collapsed': sidebarCollapsed }">
      <button class="sidebar-toggle" type="button" @click="sidebarCollapsed = !sidebarCollapsed">
        {{ sidebarCollapsed ? '›' : '‹' }}
      </button>
      <div class="sidebar-content">
        <div class="sidebar-categories">
          <div class="sidebar-heading">
            <div><p class="eyebrow">MARKER CATEGORIES</p><h2>标记分类</h2></div>
            <div class="filter-actions">
              <button type="button" class="text-button" @click="selectAllCategories">全选</button>
              <button type="button" class="text-button" @click="clearCategories">清空</button>
            </div>
          </div>
          <div class="category-list">
            <template v-for="group in groupedCategories" :key="group.label">
              <div class="category-group-block" :class="{ 'category-group-block--collapsed': isCategoryGroupCollapsed(group.label) }">
                <button
                  v-if="collapsibleGroupLabels.has(group.label)"
                  class="category-group-toggle"
                  type="button"
                  @click="toggleCategoryGroup(group.label)"
                >
                  <span class="category-group-heading">
                    <span class="category-group-title">{{ group.label }}</span>
                  </span>
                  <span class="category-group-meta">
                    <button
                      class="category-select-all category-select-all--inline"
                      :class="{
                        'category-select-all--active': isGroupFullySelected(group),
                        'category-select-all--partial': isGroupPartiallySelected(group),
                      }"
                      type="button"
                      :aria-checked="isGroupFullySelected(group) ? 'true' : isGroupPartiallySelected(group) ? 'mixed' : 'false'"
                      role="checkbox"
                      @click.stop="toggleCategoryGroupSelection(group)"
                    >
                      <span>全选</span>
                      <span class="category-select-all__box" aria-hidden="true">
                        <i v-if="isGroupFullySelected(group)" class="category-select-all__check" />
                        <i v-else-if="isGroupPartiallySelected(group)" class="category-select-all__dash" />
                      </span>
                    </button>
                    <small>{{ group.categories.length }}</small>
                    <i>{{ isCategoryGroupCollapsed(group.label) ? '▸' : '▾' }}</i>
                  </span>
                </button>
                <p v-else class="category-group">{{ group.label }}</p>
                <div v-show="!isCategoryGroupCollapsed(group.label)" class="category-group-items">
                  <button v-for="category in group.categories" :key="category.id" class="category-button"
                    :class="{ 'category-button--muted': !activeCategories.has(category.id) }" type="button" @click="toggleCategory(category.id)">
                    <span class="category-icon" :style="{ '--category-color': category.color }">
                      <img v-if="category.iconUrl" :src="publicAssetUrl(category.iconUrl)" alt="" />
                      <template v-else>{{ category.icon }}</template>
                    </span>
                    <span>{{ category.label }}</span><small>{{ visibleCounts[category.id] }}</small>
                  </button>
                </div>
              </div>
            </template>
          </div>
        </div>
        <div class="sidebar-footer">
          <div class="sidebar-expander">
            <button class="sidebar-expander__toggle" type="button" @click="districtFilterOpen = !districtFilterOpen">
              <span><b>区域筛选</b><small>{{ hasActiveDistricts ? `${activeDistricts.size} 项已选` : '按区域筛选点位' }}</small></span>
              <i>{{ districtFilterOpen ? '▾' : '▸' }}</i>
            </button>
            <div v-show="districtFilterOpen" class="sidebar-expander__body">
              <div class="district-list">
                <button
                  v-for="district in districtOptions"
                  :key="district"
                  class="district-button"
                  :class="{ 'district-button--active': activeDistricts.has(district) }"
                  type="button"
                  @click="toggleDistrict(district)"
                >
                  {{ district }}
                </button>
              </div>
              <div class="sidebar-expander__actions">
                <button type="button" class="text-button" :disabled="!hasActiveDistricts" @click="clearDistricts">清空区域</button>
                <button
                  type="button"
                  class="text-button"
                  :disabled="!bulkIncompleteCount"
                  :title="bulkCompleteCategoryIds.length && hasActiveDistricts ? '' : '请选择至少一个普通标签和一个区域'"
                  @click="completeDistrictCategory"
                >
                  一键完成<span v-if="bulkCompleteCategoryIds.length && hasActiveDistricts">（{{ bulkIncompleteCount }}）</span>
                </button>
              </div>
            </div>
          </div>
          <label class="switch-row">
            <span><b>传送点保持开启</b><small>清空分类时仍显示传送点</small></span>
            <input :checked="keepTeleportEnabled" type="checkbox" @change="toggleTeleportProtection" /><i />
          </label>
          <label class="switch-row">
            <span><b>合并相邻点位</b><small>开启后邻近标记会聚合显示</small></span>
            <input v-model="mergeAdjacentLocationsEnabled" type="checkbox" /><i />
          </label>
          <label class="switch-row">
            <span><b>仅显示未完成</b><small>隐藏已经探索的标记</small></span>
            <input v-model="showIncompleteOnly" type="checkbox" /><i />
          </label>
          <label class="switch-row">
            <span><b>实时定位</b><small>开启后监听本地导航数据</small></span>
            <input v-model="realtimeNavigationEnabled" type="checkbox" /><i />
          </label>
          <label v-if="realtimeNavigationEnabled" class="switch-row">
            <span><b>箭头保持居中</b><small>自动将导航箭头保持在窗口中心</small></span>
            <input v-model="centerNavigationEnabled" type="checkbox" /><i />
          </label>
          <div v-if="realtimeNavigationEnabled" class="navigation-endpoint-row">
            <span><b>监听地址</b><small>{{ navigationWebSocketUrl }}</small></span>
            <div class="navigation-endpoint-fields">
              <label>
                <span>IP</span>
                <input v-model.trim="navigationHost" type="text" inputmode="url" autocomplete="off" @change="applyNavigationEndpoint" />
              </label>
              <label>
                <span>端口</span>
                <input v-model.trim="navigationPort" type="number" min="1" max="65535" step="1" inputmode="numeric" @change="applyNavigationEndpoint" />
              </label>
            </div>
          </div>
          <div class="filter-summary">{{ filteredLocations.length }} 个标记显示中</div>
        </div>
      </div>
    </aside>

    <aside v-if="routePanelOpen" class="route-panel glass-panel">
      <div class="sidebar-heading">
        <div><p class="eyebrow">ROUTES</p><h2>路线规划</h2></div>
        <button v-if="editorMode" type="button" class="text-button" @click="createRoute">+ 新建</button>
      </div>
      <div class="route-file-actions">
        <button type="button" @click="routeImportInput?.click()">导入 JSON</button>
        <button type="button" :disabled="!routes.length" @click="exportRoutes">导出 JSON</button>
        <input ref="routeImportInput" type="file" accept="application/json,.json" @change="importRoutes" />
      </div>
      <div class="route-list">
        <button v-for="route in routes" :key="route.id" type="button" :class="{ active: activeRouteId === route.id }" @click="activeRouteId = route.id">
          <span>{{ route.name }}</span><small>{{ route.segments.length }} 个路段</small>
        </button>
      </div>
      <template v-if="activeRoute">
        <div class="route-heading">
          <b>{{ activeRoute.name }}</b>
          <button v-if="editorMode" type="button" @click="deleteRoute(activeRoute)">删除路线</button>
        </div>
        <div v-if="isAddingSegment" class="segment-editor">
          <span>依次点击已有标点或地图空白处：{{ segmentPoints.length }} 个</span>
          <button type="button" @click="segmentPoints = segmentPoints.slice(0, -1); renderRouteArrows()">撤销</button>
          <button type="button" @click="cancelSegment">取消</button>
          <button type="button" :disabled="segmentPoints.length < 2" @click="finishSegment">完成</button>
        </div>
        <button v-else-if="editorMode" class="add-segment-button" type="button" @click="startSegment">+ 添加路段</button>
        <div class="segment-list">
          <button v-for="segment in activeRoute.segments" :key="segment.id" type="button" @click="focusSegment(segment)">
            <span>{{ segment.name }}</span><small>{{ getSegmentPoints(segment).length }} 个点</small>
            <i v-if="editorMode" @click.stop="deleteSegment(segment)">×</i>
          </button>
        </div>
      </template>
      <p v-else class="empty-copy">选择路线后可查看路段。</p>
    </aside>

    <section v-if="selectedLocation" class="detail-card glass-panel">
      <button class="close-button" type="button" aria-label="关闭详情" @click="selectedLocation = null">×</button>
      <div v-if="selectedLocation.images.length" class="image-gallery">
        <img v-for="image in selectedLocation.images" :key="image" :src="publicAssetUrl(image)" :alt="selectedLocation.name" @click="previewImage = image" />
      </div>
      <p class="eyebrow">{{ selectedLocation.district }}</p>
      <h2>{{ selectedLocation.name }}</h2>
      <p v-if="selectedLocation.description" class="detail-description">{{ selectedLocation.description }}</p>
      <div class="tag-row">
        <span v-for="type in getVisibleTypes(selectedLocation)" :key="type">{{ categoryLookup[type]?.label || type }}</span>
        <span v-for="tag in selectedLocation.tags" :key="tag"># {{ tag }}</span>
      </div>
      <button class="coordinate-row" type="button" @click="copyCoordinates">
        <span>坐标</span><code>{{ selectedLocation.lat.toFixed(6) }}, {{ selectedLocation.lng.toFixed(6) }}</code><small>复制</small>
      </button>
      <div v-if="editorMode" class="detail-actions">
        <button type="button" @click="openEditLocation(selectedLocation)">编辑</button>
        <button type="button" class="danger-button" @click="deleteLocation(selectedLocation)">删除</button>
      </div>
      <div v-else class="detail-actions">
        <button type="button" :class="{ 'action-button--active': favoriteIds.has(selectedLocation.id) }" @click="toggleFavorite(selectedLocation.id)">
          {{ favoriteIds.has(selectedLocation.id) ? '★ 已收藏' : '☆ 收藏' }}
        </button>
        <button type="button" class="primary-action" :class="{ 'primary-action--done': completedIds.has(selectedLocation.id) }" @click="toggleCompleted(selectedLocation.id)">
          {{ completedIds.has(selectedLocation.id) ? '✓ 已完成' : '标记完成' }}
        </button>
      </div>
    </section>

    <div class="map-hud glass-panel">
      <button type="button" @click="resetView">重置视野</button>
      <span>LAT {{ coordinates.lat.toFixed(2) }}</span><span>LNG {{ coordinates.lng.toFixed(2) }}</span>
      <span class="navigation-status" :class="`navigation-status--${navigationConnectionStatus}`">NAVI {{ navigationConnectionLabel }}</span>
      <span v-if="navigationState.position">POS {{ navigationState.position.pixelX.toFixed(0) }}, {{ navigationState.position.pixelY.toFixed(0) }}</span>
      <span v-if="navigationState.angle !== null">ANGLE {{ navigationState.angle.toFixed(1) }}°</span>
    </div>
    <div v-if="editorMode" class="editor-tip glass-panel">编辑模式：点击地图空白处添加点位</div>
    <div v-if="statusMessage" class="status-toast glass-panel">{{ statusMessage }}</div>

    <div v-if="editorFormOpen" class="modal-backdrop" @click.self="editorFormOpen = false">
      <form class="editor-form glass-panel" @submit.prevent="saveLocation">
        <div class="sidebar-heading"><h2>{{ editingLocationId ? '编辑点位' : '新建点位' }}</h2><button type="button" class="close-button" @click="editorFormOpen = false">×</button></div>
        <label>名称<input v-model="locationForm.name" required /></label>
        <label>区域<input v-model="locationForm.district" placeholder="全地图" /></label>
        <div class="form-grid"><label>LAT<input v-model.number="locationForm.lat" type="number" step="any" /></label><label>LNG<input v-model.number="locationForm.lng" type="number" step="any" /></label></div>
        <label>描述<textarea v-model="locationForm.description" rows="3" /></label>
        <label>搜索关键词（可选）<input v-model="locationForm.tagsText" placeholder="使用英文逗号分隔，用于辅助搜索" /></label>
        <fieldset><legend>类型（可多选）</legend><div class="type-picker">
          <label v-for="category in editorCategories" :key="category.id" :data-category-id="category.id" :data-category-group="category.group"><input v-model="locationForm.types" type="checkbox" :value="category.id" />{{ category.label }}</label>
        </div>
        <div class="custom-type-editor">
          <p>添加自定义类型</p>
          <div class="custom-type-row">
            <label>类型 ID<input v-model="locationForm.customTypeId" placeholder="输入稳定 ID，例如 witch-house" @keydown.enter.prevent="addCustomType" /></label>
            <label>类型名称<input v-model="locationForm.customTypeText" placeholder="输入自定义类型名称" @keydown.enter.prevent="addCustomType" /></label>
            <label>归属大类<select v-model="locationForm.customTypeGroup" aria-label="选择标记大类">
              <option disabled value="">请选择大类</option>
              <option v-for="group in editorCategoryGroups" :key="group" :value="group">{{ group }}</option>
            </select></label>
            <label>或新建大类<input v-model="locationForm.customTypeNewGroup" placeholder="新建大类（可选）" @keydown.enter.prevent="addCustomType" /></label>
          </div>
          <button type="button" :disabled="!locationForm.customTypeId.trim() || !locationForm.customTypeText.trim() || (!locationForm.customTypeGroup && !locationForm.customTypeNewGroup.trim())" @click="addCustomType">+ 添加类型</button>
        </div></fieldset>
        <label>截图<input type="file" accept="image/*" multiple @change="uploadImages" /></label>
        <div v-if="locationForm.images.length" class="form-images">
          <span v-for="(image, index) in locationForm.images" :key="image"><img :src="publicAssetUrl(image)" alt="" /><button type="button" @click="locationForm.images.splice(index, 1)">×</button></span>
        </div>
        <div class="detail-actions editor-form-actions"><button type="button" @click="editorFormOpen = false">取消</button><button class="primary-action" type="submit">{{ isLocalEditor ? '保存' : '导出修改 JSON' }}</button></div>
      </form>
    </div>

    <div v-if="previewImage" class="image-preview" @click="previewImage = ''"><img :src="publicAssetUrl(previewImage)" alt="点位截图" @click.stop /></div>
  </main>
</template>
