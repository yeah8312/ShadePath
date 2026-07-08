/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import 'dotenv/config';
import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import * as SunCalc from 'suncalc';
import proj4 from 'proj4';
import osmtogeojson from 'osmtogeojson';
import * as turf from '@turf/turf';

const app = express();
const PORT = Number(process.env.PORT) || 3000;

app.use(express.json());

// In-memory caches with short TTL
const overpassCache = new Map<string, { timestamp: number; data: any }>();
const geocodeCache = new Map<string, { timestamp: number; data: any }>();
const reverseGeocodeCache = new Map<string, { timestamp: number; data: any }>();

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Projection string for WGS84 (lat/lng)
const wgs84 = "+proj=longlat +datum=WGS84 +no_defs";

// Helper to determine the UTM Zone projection string based on a center coordinate
export function getUTMProjString(lat: number, lng: number): string {
  const zone = Math.floor((lng + 180) / 6) + 1;
  const isSouth = lat < 0;
  return `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs${isSouth ? ' +south' : ''}`;
}

// Parse height from tags with fallback rules
export function getBuildingHeight(tags: any): {
  height: number;
  heightSource: 'height' | 'est_height' | 'levels-estimate' | 'type-fallback';
  heightConfidence: 'high' | 'medium' | 'low';
} {
  if (!tags) {
    return { height: 10, heightSource: 'type-fallback', heightConfidence: 'low' };
  }

  const parseHeightString = (str: string): number | null => {
    str = str.trim().toLowerCase();
    // Support feet and inches like 30 ft or 30' 6"
    if (str.includes('ft') || str.includes('feet') || str.includes("'")) {
      const feetMatch = str.match(/([0-9.]+)\s*(ft|feet|')/);
      if (feetMatch) {
        const feet = parseFloat(feetMatch[1]);
        let inches = 0;
        const inchMatch = str.match(/([0-9.]+)\s*(in|inches|")/);
        if (inchMatch) {
          inches = parseFloat(inchMatch[1]);
        }
        if (!isNaN(feet)) {
          return (feet + inches / 12) * 0.3048;
        }
      }
    }
    const mMatch = str.match(/([0-9.]+)\s*(m|meters)?/);
    if (mMatch) {
      const val = parseFloat(mMatch[1]);
      if (!isNaN(val)) return val;
    }
    return null;
  };

  if (tags.height) {
    const h = parseHeightString(tags.height);
    if (h !== null) {
      return { height: h, heightSource: 'height', heightConfidence: 'high' };
    }
  }

  if (tags.est_height) {
    const h = parseHeightString(tags.est_height);
    if (h !== null) {
      return { height: h, heightSource: 'est_height', heightConfidence: 'medium' };
    }
  }

  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) {
      const height = levels * 3.0 + 1.5;
      return { height, heightSource: 'levels-estimate', heightConfidence: 'medium' };
    }
  }

  const type = tags.building || '';
  let defaultHeight = 10;
  if (type === 'apartments' || type === 'residential') defaultHeight = 15;
  else if (type === 'office' || type === 'commercial') defaultHeight = 18;
  else if (type === 'house' || type === 'detached') defaultHeight = 6;
  else if (type === 'retail') defaultHeight = 9;

  return { height: defaultHeight, heightSource: 'type-fallback', heightConfidence: 'low' };
}

// 5-meter sampling along a metric path coordinate list in UTM space
export function samplePathMeters(coords: [number, number][], interval: number): [number, number][] {
  if (coords.length === 0) return [];
  const samples: [number, number][] = [coords[0]];
  let distAccum = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const dx = p2[0] - p1[0];
    const dy = p2[1] - p1[1];
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen === 0) continue;

    let fraction = 0;
    while (distAccum + (segLen - fraction) >= interval) {
      const remaining = interval - distAccum;
      fraction += remaining;
      const t = fraction / segLen;
      samples.push([p1[0] + t * dx, p1[1] + t * dy]);
      distAccum = 0;
    }
    distAccum += (segLen - fraction);
  }
  if (coords.length > 1) {
    samples.push(coords[coords.length - 1]);
  }
  return samples;
}

// Helper to project a geojson geometry into UTM coordinates
function projectGeometryToUTM(geom: any, utmProj: string): any {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((ring: any) => {
      return ring.map((pt: number[]) => proj4(wgs84, utmProj, pt));
    });
    return { type: 'Polygon', coordinates: rings };
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map((polyCoords: any) => {
      return polyCoords.map((ring: any) => {
        return ring.map((pt: number[]) => proj4(wgs84, utmProj, pt));
      });
    });
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

// Helper to project a geojson geometry back to WGS84
function projectGeometryToWGS84(geom: any, utmProj: string): any {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((ring: any) => {
      return ring.map((pt: number[]) => proj4(utmProj, wgs84, pt));
    });
    return { type: 'Polygon', coordinates: rings };
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map((polyCoords: any) => {
      return polyCoords.map((ring: any) => {
        return ring.map((pt: number[]) => proj4(utmProj, wgs84, pt));
      });
    });
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

// Translate geometry in UTM space
export function translatePolygonUTM(geom: any, dx: number, dy: number): any {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((ring: any) => {
      return ring.map((pt: number[]) => [pt[0] + dx, pt[1] + dy]);
    });
    return { type: 'Polygon', coordinates: rings };
  } else if (geom.type === 'MultiPolygon') {
    const polys = geom.coordinates.map((polyCoords: any) => {
      return polyCoords.map((ring: any) => {
        return ring.map((pt: number[]) => [pt[0] + dx, pt[1] + dy]);
      });
    });
    return { type: 'MultiPolygon', coordinates: polys };
  }
  return geom;
}

// Create side projection polygons from original footprint to translated footprint in UTM space
export function createSidePolygonsUTM(original: any, translated: any): any[] {
  const sideQuads: any[] = [];
  
  const processRing = (origRing: [number, number][], transRing: [number, number][]) => {
    // Both rings must have the same length
    for (let i = 0; i < origRing.length - 1; i++) {
      const pA = origRing[i];
      const pB = origRing[i + 1];
      const sA = transRing[i];
      const sB = transRing[i + 1];
      
      sideQuads.push(turf.polygon([[pA, pB, sB, sA, pA]]));
    }
  };

  if (original.type === 'Polygon') {
    // Process exterior ring
    processRing(original.coordinates[0], translated.coordinates[0]);
  } else if (original.type === 'MultiPolygon') {
    for (let p = 0; p < original.coordinates.length; p++) {
      processRing(original.coordinates[p][0], translated.coordinates[p][0]);
    }
  }

  return sideQuads;
}

// Union geometries in UTM space
export function unionShadowUTM(footprint: any, translated: any, sideQuads: any[]): any {
  try {
    let shadowFeature = turf.feature(footprint);
    const transFeature = turf.feature(translated);

    const merged = turf.union(turf.featureCollection([shadowFeature, transFeature]));
    if (merged) shadowFeature = merged;

    if (sideQuads.length > 0) {
      const batchMerged = turf.union(turf.featureCollection([shadowFeature, ...sideQuads]));
      if (batchMerged) shadowFeature = batchMerged;
    }

    return shadowFeature.geometry;
  } catch (e) {
    console.warn('Turf union failed, using fallback bounding shadow:', e);
    return translated;
  }
}

// Robust OpenRouteService call
const asyncHandler = (fn: any) => (req: any, res: any, next: any) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

interface OverpassAttempt {
  endpoint: string;
  error?: string;
  name?: string;
  cause?: string;
  causeCode?: string;
  status?: number;
  timeMs?: number;
  bbox?: string;
  queryLength?: number;
}

async function fetchFromOverpassWithRetry(query: string, bbox: string): Promise<{
  data: any;
  attempts: OverpassAttempt[];
  successfulEndpoint: string;
  latencyMs: number;
}> {
  const OVERPASS_ENDPOINTS = Array.from(new Set([
    process.env.OVERPASS_API_URL,
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ].filter(Boolean))) as string[];

  const attempts: OverpassAttempt[] = [];

  for (const endpoint of OVERPASS_ENDPOINTS) {
    const startTime = Date.now();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'User-Agent': 'ShadePath/1.0 (cksgma3218@gmail.com)',
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        },
        body: new URLSearchParams({ data: query }).toString(),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
          const errText = await response.text();
          throw new Error(`QUERY_ERROR: HTTP ${response.status} - ${errText}`);
        }
        throw new Error(`HTTP_STATUS_${response.status}`);
      }

      const data = await response.json();
      return {
        data,
        attempts,
        successfulEndpoint: endpoint,
        latencyMs: duration
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;

      const attempt: OverpassAttempt = {
        endpoint,
        error: err.message || String(err),
        name: err.name || 'Error',
        cause: err.cause ? (err.cause.message || String(err.cause)) : undefined,
        causeCode: err.cause?.code || err.code,
        status: err.message?.startsWith('HTTP_STATUS_') ? parseInt(err.message.replace('HTTP_STATUS_', '')) : undefined,
        timeMs: duration,
        bbox,
        queryLength: query.length
      };

      console.error('Overpass request attempt failed:', {
        endpoint: attempt.endpoint,
        message: attempt.error,
        name: attempt.name,
        cause: attempt.cause,
        causeCode: attempt.causeCode,
        status: attempt.status,
        requestTimeMs: duration,
        bbox,
        queryLength: query.length
      });

      attempts.push(attempt);

      if (err.message && err.message.startsWith('QUERY_ERROR')) {
        const queryErr = new Error(err.message);
        (queryErr as any).attempts = attempts;
        throw queryErr;
      }
    }
  }

  const allFailedErr = new Error('ALL_ENDPOINTS_FAILED');
  (allFailedErr as any).attempts = attempts;
  throw allFailedErr;
}

// Robust OpenRouteService call
async function fetchOrsRoutesRaw(start: { lat: number; lng: number }, end: { lat: number; lng: number }): Promise<any> {
  const ORS_API_KEY = process.env.ORS_API_KEY;
  if (!ORS_API_KEY) {
    throw new Error('ORS_API_KEY_NOT_SET');
  }

  const url = 'https://api.openrouteservice.org/v2/directions/foot-walking/geojson';
  const body = {
    coordinates: [
      [start.lng, start.lat],
      [end.lng, end.lat]
    ],
    alternative_routes: {
      target_count: 3,
      weight_factor: 1.4,
      share_factor: 0.6
    }
  };

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 18000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Accept': 'application/json, application/geo+json',
          'Authorization': ORS_API_KEY
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (response.status === 429) {
        throw new Error('RATE_LIMIT_EXCEEDED');
      }

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`ORS_CALL_FAILED: ${response.status} - ${errText}`);
      }

      const data = await response.json();
      if (!data || !data.features || data.features.length === 0) {
        throw new Error('ROUTE_NOT_FOUND');
      }

      return data;
    } catch (err: any) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.message === 'RATE_LIMIT_EXCEEDED' || attempt === 2) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }

  throw lastError || new Error('ORS_CALL_FAILED');
}

const YEUNGNAM_PRESET_ROUTE_CACHE = {
  start: { lat: 35.83658, lng: 128.75355 },
  end: { lat: 35.83062, lng: 128.75434 },
  routes: [
    {
      distance: 771,
      duration: 540,
      geometry: {
        type: 'LineString',
        coordinates: [[128.753604,35.836621],[128.753679,35.836556],[128.753762,35.836483],[128.753493,35.836272],[128.753079,35.836083],[128.753053,35.835994],[128.752881,35.83595],[128.7534,35.834481],[128.753413,35.834443],[128.753867,35.833057],[128.753883,35.833011],[128.753971,35.832756],[128.75404,35.832546],[128.754095,35.832453],[128.754268,35.832157],[128.754472,35.831922],[128.754505,35.831773],[128.754428,35.831663],[128.754237,35.831603],[128.754249,35.831513],[128.754262,35.831423],[128.754472,35.83142],[128.754441,35.830851],[128.754476,35.830827],[128.754446,35.830666]]
      }
    },
    {
      distance: 1053,
      duration: 780,
      geometry: {
        type: 'LineString',
        coordinates: [[128.753604,35.836621],[128.753679,35.836556],[128.753762,35.836483],[128.753845,35.836549],[128.75394,35.836453],[128.754074,35.836555],[128.754296,35.836379],[128.755051,35.836549],[128.755204,35.836537],[128.755253,35.836472],[128.755675,35.835292],[128.755775,35.835019],[128.755801,35.834871],[128.755837,35.834845],[128.755875,35.834727],[128.755881,35.834662],[128.754406,35.83465],[128.754299,35.834629],[128.75418,35.834498],[128.75418,35.834394],[128.754336,35.833972],[128.754387,35.833915],[128.754406,35.833795],[128.754422,35.833744],[128.754755,35.832757],[128.754889,35.832509],[128.755021,35.832343],[128.755165,35.832209],[128.754947,35.83207],[128.755061,35.831808],[128.755216,35.831566],[128.755059,35.831371],[128.755131,35.831356],[128.755114,35.831207],[128.754602,35.830851],[128.754523,35.830848],[128.754476,35.830827],[128.754446,35.830666]]
      }
    }
  ]
};

function getPresetRouteCache(start: { lat: number; lng: number }, end: { lat: number; lng: number }) {
  const distanceMeters = (a: { lat: number; lng: number }, b: { lat: number; lng: number }) => turf.distance(
    turf.point([a.lng, a.lat]),
    turf.point([b.lng, b.lat]),
    { units: 'kilometers' }
  ) * 1000;

  const startMatches = distanceMeters(start, YEUNGNAM_PRESET_ROUTE_CACHE.start) <= 40;
  const endMatches = distanceMeters(end, YEUNGNAM_PRESET_ROUTE_CACHE.end) <= 40;

  if (!startMatches || !endMatches) return null;
  return YEUNGNAM_PRESET_ROUTE_CACHE.routes;
}

// --- Geocoding API Endpoints ---
app.get('/api/geocode', asyncHandler(async (req, res) => {
  const q = (req.query.q as string || '').trim();
  if (!q) {
    return res.status(400).json({ error: 'Search query is required' });
  }
  if (q.length > 150) {
    return res.status(400).json({ error: 'Search query is too long' });
  }

  const cached = geocodeCache.get(q);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json({ results: cached.data });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=5&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ShadePath/1.0 (cksgma3218@gmail.com)',
        'Accept-Language': 'ko,en'
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim returned status ${response.status}`);
    }

    const data = await response.json();
    const results = (data || []).map((item: any) => ({
      name: item.name || item.display_name.split(',')[0],
      displayName: item.display_name,
      lat: parseFloat(item.lat),
      lng: parseFloat(item.lon)
    })).filter((item: any) => !isNaN(item.lat) && !isNaN(item.lng));

    geocodeCache.set(q, { timestamp: Date.now(), data: results });
    return res.json({ results });
  } catch (err: any) {
    console.error('Geocoding error:', err.message);
    return res.status(502).json({ error: '지오코딩 서비스를 사용할 수 없습니다.' });
  }
}));

app.get('/api/reverse-geocode', asyncHandler(async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }

  const cacheKey = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  const cached = reverseGeocodeCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'ShadePath/1.0 (cksgma3218@gmail.com)',
        'Accept-Language': 'ko,en'
      }
    });

    if (!response.ok) {
      throw new Error(`Nominatim returned status ${response.status}`);
    }

    const item = await response.json();
    const result = {
      name: item.name || item.display_name?.split(',')[0] || '지정된 위치',
      displayName: item.display_name || '알 수 없는 주소',
      lat,
      lng
    };

    reverseGeocodeCache.set(cacheKey, { timestamp: Date.now(), data: result });
    return res.json(result);
  } catch (err: any) {
    console.error('Reverse geocoding error:', err.message);
    return res.status(502).json({ error: '역지오코딩 서비스를 사용할 수 없습니다.' });
  }
}));

// --- Main Pedestrian Shade Route Endpoint ---
app.post('/api/shade-route', asyncHandler(async (req, res) => {
  const { start, end, datetime, weatherCondition = 'sunny' } = req.body;

  if (!start || typeof start.lat !== 'number' || typeof start.lng !== 'number' ||
      !end || typeof end.lat !== 'number' || typeof end.lng !== 'number') {
    return res.status(400).json({ error: '출발지와 도착지 위경도 정보가 올바르지 않습니다.' });
  }

  if (!datetime) {
    return res.status(400).json({ error: '계산 기준 일시(datetime)가 필요합니다.' });
  }

  const targetTime = new Date(datetime);
  if (isNaN(targetTime.getTime())) {
    return res.status(400).json({ error: '올바르지 않은 datetime 형식입니다.' });
  }

  // Calculate center of the area
  const routeCenterLat = (start.lat + end.lat) / 2;
  const routeCenterLng = (start.lng + end.lng) / 2;

  // 1. Calculate Solar Coordinates using suncalc
  const position = SunCalc.getPosition(targetTime, routeCenterLat, routeCenterLng);
  const elevationDeg = position.altitude;
  const azimuthDeg = position.azimuth;

  // Shadow length ratio = 1 / tan(elevation)
  let shadowLengthRatio = 0;
  if (elevationDeg > 0) {
    if (elevationDeg < 3) {
      shadowLengthRatio = 8.0;
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(elevationDeg * Math.PI / 180));
    }
  }

  const solar = {
    elevation: elevationDeg,
    azimuth: azimuthDeg,
    shadowLengthRatio
  };

  const shadowLengthFactor = weatherCondition === 'rainy' ? 0 : solar.shadowLengthRatio;
  const shadowBearing = (solar.azimuth + 180) % 360;

  // 2. Request walking routes (prefer ORS, fallback to OSRM)
  let routesData: any = null;
  let routingSource = "openrouteservice";
  const warnings: string[] = [];

  if (process.env.ORS_API_KEY) {
    try {
      const orsData = await fetchOrsRoutesRaw(start, end);
      routesData = {
        routes: orsData.features.map((f: any) => ({
          geometry: f.geometry,
          distance: f.properties?.summary?.distance ?? 0,
          duration: f.properties?.summary?.duration ?? 0
        }))
      };
    } catch (err: any) {
      console.warn('OpenRouteService routing failed, falling back to OSRM:', err.message);
      const presetRoutes = getPresetRouteCache(start, end);
      if (presetRoutes) {
        routingSource = "preset-cache";
        routesData = { routes: presetRoutes };
        warnings.push(`OpenRouteService 라우팅 오류로 영남대 프리셋 캐시 사용: ${err.message}`);
      } else {
        warnings.push(`OpenRouteService 라우팅 오류로 OSRM 폴백 사용: ${err.message}`);
      }
    }
  } else {
    warnings.push("ORS_API_KEY가 비어 있어 기본 OSRM 라우터를 사용합니다.");
  }

  if (!routesData) {
    routingSource = "osrm";
    const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&alternatives=true`;
    try {
      const osrmRes = await fetch(osrmUrl);
      if (!osrmRes.ok) {
        throw new Error(`OSRM returned HTTP ${osrmRes.status}`);
      }
      const data = await osrmRes.json();
      if (!data || !data.routes || data.routes.length === 0) {
        throw new Error('OSRM returned empty routes');
      }
      routesData = {
        routes: data.routes.map((r: any) => ({
          geometry: r.geometry,
          distance: r.distance,
          duration: r.duration
        }))
      };
    } catch (err: any) {
      console.error('OSRM route failed:', err.message);
      return res.status(502).json({ error: '보행 경로 데이터를 불러오는 데 실패했습니다.' });
    }
  }

  if (routingSource === "osrm") {
    const straightLineDistance = turf.distance(
      turf.point([start.lng, start.lat]),
      turf.point([end.lng, end.lat]),
      { units: 'kilometers' }
    ) * 1000;
    const maxFallbackDistance = Math.max(straightLineDistance * 2.2, straightLineDistance + 600);
    const viableRoutes = routesData.routes.filter((route: any) => Number(route.distance) <= maxFallbackDistance);

    if (viableRoutes.length === 0) {
      return res.status(502).json({
        error: 'OSRM 폴백 경로가 출발지와 도착지를 과도하게 우회하여 사용하지 않았습니다. OpenRouteService 연결을 다시 시도해 주세요.',
        routingSource,
        directDistance: Math.round(straightLineDistance),
        maxAcceptedDistance: Math.round(maxFallbackDistance),
        warnings
      });
    }

    if (viableRoutes.length < routesData.routes.length) {
      warnings.push(`OSRM 폴백 경로 중 과도한 우회 후보 ${routesData.routes.length - viableRoutes.length}개를 제외했습니다.`);
      routesData.routes = viableRoutes;
    }
  }

  // 3. Compute precise bounding box around actual candidate route coordinates
  const allCoords: [number, number][] = [];
  for (const r of routesData.routes) {
    if (r.geometry && r.geometry.coordinates) {
      r.geometry.coordinates.forEach((c: number[]) => {
        allCoords.push([c[1], c[0]]); // [lat, lng]
      });
    }
  }
  allCoords.push([start.lat, start.lng]);
  allCoords.push([end.lat, end.lng]);

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [lat, lng] of allCoords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
  }

  // 200m buffer padding in lat/lng degrees
  const bufferMeters = 200;
  const latBuffer = bufferMeters / 111320;
  const lngBuffer = bufferMeters / (111320 * Math.cos(routeCenterLat * Math.PI / 180));

  const south = minLat - latBuffer;
  const north = maxLat + latBuffer;
  const west = minLng - lngBuffer;
  const east = maxLng + lngBuffer;

  const bboxKey = `${south.toFixed(4)},${west.toFixed(4)},${north.toFixed(4)},${east.toFixed(4)}`;

  // 4. Fetch real OSM buildings using Overpass API
  let overpassData: any = null;
  let attempts: OverpassAttempt[] = [];

  try {
    const cached = overpassCache.get(bboxKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      overpassData = cached.data;
    } else {
      const overpassQuery = `
        [out:json][timeout:25];
        (
          way["building"](${south},${west},${north},${east});
          relation["building"]["type"="multipolygon"](${south},${west},${north},${east});
          way["building:part"](${south},${west},${north},${east});
          relation["building:part"]["type"="multipolygon"](${south},${west},${north},${east});
        );
        out body geom;
      `;

      const result = await fetchFromOverpassWithRetry(overpassQuery, bboxKey);
      overpassData = result.data;
      attempts = result.attempts;
      overpassCache.set(bboxKey, { timestamp: Date.now(), data: overpassData });
    }
  } catch (err: any) {
    console.error('Overpass request failed:', err.message);
    return res.status(502).json({
      error: 'OVERPASS_UNAVAILABLE',
      message: '모든 Overpass 서버에서 실제 OSM 건물 데이터를 불러오지 못했습니다.',
      buildingSource: 'none',
      attempts: err.attempts || attempts
    });
  }

  if (!overpassData || !overpassData.elements || overpassData.elements.length === 0) {
    return res.status(404).json({
      error: 'NO_BUILDINGS_FOUND',
      message: '선택한 경로 주변에서 OSM 건물 데이터를 찾지 못했습니다.',
      buildingSource: 'overpass'
    });
  }

  // 5. Convert Overpass elements to GeoJSON using osmtogeojson
  let geojsonData: any;
  try {
    geojsonData = osmtogeojson(overpassData, { flatProperties: true });
  } catch (err: any) {
    console.error('osmtogeojson conversion failed:', err.message);
    return res.status(500).json({ error: 'OSM 데이터 변환에 실패했습니다.' });
  }

  // Filter building and building:part features
  const rawFeatures: any[] = [];
  if (geojsonData && geojsonData.features) {
    for (const f of geojsonData.features) {
      if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
      const props = f.properties || {};
      const isBuilding = !!props.building;
      const isPart = !!props['building:part'];
      if (!isBuilding && !isPart) continue;

      const osmId = String(f.id);
      const [osmType, osmIdNum] = osmId.split('/');
      const hData = getBuildingHeight(props);

      rawFeatures.push({
        osmId: osmIdNum || osmId,
        osmType: osmType === 'relation' ? 'relation' : 'way',
        featureType: isPart ? 'building:part' : 'building',
        geometry: f.geometry,
        height: hData.height,
        heightSource: hData.heightSource,
        heightConfidence: hData.heightConfidence,
        name: props.name || (isPart ? '건물 부분' : '근처 건물')
      });
    }
  }

  // Deduplicate: remove parents of building:parts to prevent shadow stacking
  const parts = rawFeatures.filter(f => f.featureType === 'building:part');
  const buildings = rawFeatures.filter(f => f.featureType === 'building');
  
  const filteredBuildings = buildings.filter(b => {
    const buildingFeature = turf.feature(b.geometry);
    for (const p of parts) {
      try {
        const partFeature = turf.feature(p.geometry);
        const overlap = turf.booleanOverlap(buildingFeature, partFeature) ||
                        turf.booleanContains(buildingFeature, partFeature) ||
                        turf.booleanContains(partFeature, buildingFeature);
        if (overlap) return false;
      } catch (e) {
        // Fallback bbox overlap
        try {
          const partFeature = turf.feature(p.geometry);
          const bboxB = turf.bbox(buildingFeature);
          const bboxP = turf.bbox(partFeature);
          const bboxOverlap = !(bboxB[2] < bboxP[0] || bboxB[0] > bboxP[2] || bboxB[3] < bboxP[1] || bboxB[1] > bboxP[3]);
          if (bboxOverlap) return false;
        } catch (bboxErr) {
          // Ignore deep failures per building pair so we don't crash
        }
      }
    }
    return true;
  });

  const finalBuildingFeatures = [...parts, ...filteredBuildings];

  // 6. Proj4 UTM Setup for calculations in precise metric units
  const utmProj = getUTMProjString(routeCenterLat, routeCenterLng);

  // Pre-process buildings and extrude complete shadow polygons in UTM space
  interface MetricBuilding {
    osmId: string;
    osmType: 'way' | 'relation';
    featureType: 'building' | 'building:part';
    height: number;
    heightSource: string;
    heightConfidence: string;
    name: string;
    footprintWGS84: any;
    footprintUTM: any;
    shadowWGS84: any;
    shadowUTMUTM: any;
    shadowBBoxUTM: number[]; // pre-calculated bbox in UTM space for fast filtering
  }

  const processedBuildings: MetricBuilding[] = [];

  for (const b of finalBuildingFeatures) {
    const footprintUTM = projectGeometryToUTM(b.geometry, utmProj);
    let shadowUTM: any = null;
    let shadowBBoxUTM: number[] = [];

    if (solar.elevation > 0 && shadowLengthFactor > 0) {
      const shadowDist = b.height * shadowLengthFactor;
      // Direction of displacement (opposite to sun)
      const dx = shadowDist * Math.sin(shadowBearing * (Math.PI / 180));
      const dy = shadowDist * Math.cos(shadowBearing * (Math.PI / 180));

      const translatedUTM = translatePolygonUTM(footprintUTM, dx, dy);
      const sideQuads = createSidePolygonsUTM(footprintUTM, translatedUTM);
      shadowUTM = unionShadowUTM(footprintUTM, translatedUTM, sideQuads);
      shadowBBoxUTM = turf.bbox(turf.feature(shadowUTM));
    }

    processedBuildings.push({
      osmId: b.osmId,
      osmType: b.osmType,
      featureType: b.featureType,
      height: b.height,
      heightSource: b.heightSource,
      heightConfidence: b.heightConfidence,
      name: b.name,
      footprintWGS84: b.geometry,
      footprintUTM,
      shadowWGS84: shadowUTM ? projectGeometryToWGS84(shadowUTM, utmProj) : null,
      shadowUTMUTM: shadowUTM,
      shadowBBoxUTM
    });
  }

  // 7. Route shadow intersection calculations using fast bounding box checks
  const finalRoutes = routesData.routes.map((route: any, index: number) => {
    const rawCoords = route.geometry.coordinates; // [lng, lat]
    const routeLatLng = rawCoords.map((c: number[]) => [c[1], c[0]] as [number, number]);

    // Project route coordinates to UTM meters
    const routeUTMCoords = routeLatLng.map(([lat, lng]: [number, number]) => proj4(wgs84, utmProj, [lng, lat]) as [number, number]);

    // Sample path every 5 meters
    const samplesUTM = samplePathMeters(routeUTMCoords, 5);
    let shadedSamples = 0;

    for (const [x, y] of samplesUTM) {
      let isShaded = false;
      
      for (const b of processedBuildings) {
        // Skip check if sun is below horizon
        if (solar.elevation <= 0) {
          isShaded = true;
          break;
        }

        if (!b.shadowUTMUTM) continue;

        // BBox optimization check before calling expensive point-in-polygon
        const [minX, minY, maxX, maxY] = b.shadowBBoxUTM;
        if (x >= minX && x <= maxX && y >= minY && y <= maxY) {
          try {
            if (turf.booleanPointInPolygon(turf.point([x, y]), b.shadowUTMUTM)) {
              isShaded = true;
              break;
            }
          } catch (err) {
            // Ignore error
          }
        }
      }
      
      if (isShaded) {
        shadedSamples++;
      }
    }

    const totalSamples = samplesUTM.length || 1;
    const shadeRatioFraction = shadedSamples / totalSamples;
    const shadeRatio = Math.round(shadeRatioFraction * 100);

    const distance = Math.round(route.distance);
    const duration = Math.round(route.duration / 60) || 1;

    const shadeDistance = Math.round(distance * shadeRatioFraction);
    const exposedDistance = distance - shadeDistance;

    const heatPenaltyByWeather: Record<string, number> = {
      sunny: 3.6,
      cloudy: 1.2,
      rainy: 0.05
    };
    const heatPenalty = heatPenaltyByWeather[weatherCondition] ?? heatPenaltyByWeather.sunny;
    const routeCost = Math.round(distance + exposedDistance * heatPenalty);

    const calories = Math.round(duration * 4.2);

    return {
      type: 'shortest' as 'shade' | 'shortest',
      name: `대안 경로 ${index + 1}`,
      coords: routeLatLng,
      distance,
      duration,
      shadeRatio,
      exposedDistance,
      shadeDistance,
      routeCost,
      calories,
      steps: [
        '출발지에서 도보 안전로를 이용해 출발합니다.',
        `전체 경로의 약 ${shadeRatio}% 구간이 시원한 빌딩 그늘에 보행 통과됩니다.`,
        `목적지 부근에 보행 통행을 거쳐 안전하게 진입합니다.`
      ]
    };
  });

  // Calculate recommendedShadeRoute and shortestRoute
  let recommendedShadeRoute = finalRoutes[0];
  let shortestRoute = finalRoutes[0];

  for (const r of finalRoutes) {
    if (r.routeCost < recommendedShadeRoute.routeCost) {
      recommendedShadeRoute = r;
    }
    if (r.distance < shortestRoute.distance) {
      shortestRoute = r;
    }
  }

  // Update types
  finalRoutes.forEach((r: any) => {
    if (r === recommendedShadeRoute && r === shortestRoute) {
      r.type = 'shade';
      r.name = '추천 그늘길 & 최단 경로 🌲🥵';
    } else if (r === recommendedShadeRoute) {
      r.type = 'shade';
      r.name = '실시간 추천 그늘 안전길 🌲';
    } else if (r === shortestRoute) {
      r.type = 'shortest';
      r.name = '뙤약볕 최단 직선 경로 🥵';
    }
  });

  // Count actually loaded buildings and projected shadows
  const buildingCount = processedBuildings.length;
  const shadowCount = processedBuildings.filter(b => b.shadowWGS84).length;

  return res.json({
    solar,
    routes: finalRoutes,
    buildings: processedBuildings.map(b => ({
      osmId: b.osmId,
      osmType: b.osmType,
      featureType: b.featureType,
      height: b.height,
      heightSource: b.heightSource,
      heightConfidence: b.heightConfidence,
      name: b.name,
      footprintGeometry: b.footprintWGS84,
      shadowGeometry: b.shadowWGS84
    })),
    routingSource,
    buildingSource: "overpass",
    buildingCount,
    shadowCount,
    degraded: routingSource !== "openrouteservice" || shadowCount === 0,
    warnings
  });
}));

// --- Diagnostic & Health Endpoints ---
app.get('/api/health', (req, res) => {
  const OVERPASS_ENDPOINTS = Array.from(new Set([
    process.env.OVERPASS_API_URL,
    'https://overpass-api.de/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
    'https://overpass.osm.ch/api/interpreter',
  ].filter(Boolean))) as string[];

  res.json({
    ok: true,
    service: "ShadePath",
    timestamp: new Date().toISOString(),
    orsConfigured: !!process.env.ORS_API_KEY,
    overpassEndpoints: OVERPASS_ENDPOINTS
  });
});

app.get('/api/health/overpass', asyncHandler(async (req, res) => {
  const query = `[out:json][timeout:5];node(35.8714,128.6014,35.8715,128.6015);out;`;
  const bbox = '35.8714,128.6014,35.8715,128.6015';

  try {
    const { attempts, successfulEndpoint, latencyMs } = await fetchFromOverpassWithRetry(query, bbox);
    return res.json({
      ok: true,
      selectedEndpoint: successfulEndpoint,
      latencyMs,
      attempts
    });
  } catch (err: any) {
    return res.status(502).json({
      ok: false,
      error: "ALL_ENDPOINTS_FAILED",
      message: "Overpass health check failed on all endpoints.",
      causeCode: err.cause?.code || err.code,
      attempts: err.attempts || []
    });
  }
}));

// 404 handler for /api/*
app.use('/api/*', (req, res, next) => {
  res.status(404).json({
    error: 'API_NOT_FOUND',
    message: '요청하신 API 엔드포인트를 찾을 수 없습니다.',
    requestId: `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`
  });
});

// JSON error middleware for API
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path.startsWith('/api/')) {
    const requestId = `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const status = err.status || err.statusCode || 500;
    
    console.error(`API Error [Request ID: ${requestId}]:`, err);

    const errorResponse: any = {
      error: err.code || "INTERNAL_API_ERROR",
      message: err.message || "서버 내부 오류가 발생했습니다.",
      requestId
    };

    if (process.env.NODE_ENV !== 'production') {
      errorResponse.stack = err.stack;
      errorResponse.cause = err.cause ? (err.cause.message || String(err.cause)) : undefined;
      errorResponse.causeCode = err.cause?.code || err.code;
    }

    return res.status(status).json(errorResponse);
  }
  next(err);
});

// Setup dev and production servers
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ShadePath full-stack server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
