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

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Accept': 'application/json, application/geo+json',
      'Authorization': ORS_API_KEY
    },
    body: JSON.stringify(body)
  });

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
}

// --- Geocoding API Endpoints ---
app.get('/api/geocode', async (req, res) => {
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
});

app.get('/api/reverse-geocode', async (req, res) => {
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
});

// --- Main Pedestrian Shade Route Endpoint ---
app.post('/api/shade-route', async (req, res) => {
  const { start, end, datetime, weatherCondition = 'sunny', shadeWeight = 50 } = req.body;

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
  const elevationDeg = position.altitude * (180 / Math.PI);
  
  // Convert SunCalc azimuth (South is 0, clockwise positive) to standard 0-360 (North is 0, clockwise positive)
  const azimuthDeg = (position.azimuth * (180 / Math.PI) + 180) % 360;

  // Shadow length ratio = 1 / tan(elevation)
  let shadowLengthRatio = 0;
  if (position.altitude > 0) {
    if (elevationDeg < 3) {
      shadowLengthRatio = 8.0;
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(position.altitude));
    }
  }

  const solar = {
    elevation: elevationDeg,
    azimuth: azimuthDeg,
    shadowLengthRatio
  };

  const isCloudyOrRainy = weatherCondition === 'cloudy' || weatherCondition === 'rainy';
  const shadowLengthFactor = isCloudyOrRainy ? 0 : solar.shadowLengthRatio;
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
      warnings.push(`OpenRouteService 라우팅 오류로 OSRM 폴백 사용: ${err.message}`);
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
  const OVERPASS_API_URL = process.env.OVERPASS_API_URL ?? 'https://overpass-api.de/api/interpreter';

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

      const response = await fetch(OVERPASS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'Accept': 'application/json'
        },
        body: new URLSearchParams({ data: overpassQuery })
      });

      if (!response.ok) {
        throw new Error(`Overpass returned status ${response.status}`);
      }

      overpassData = await response.json();
      overpassCache.set(bboxKey, { timestamp: Date.now(), data: overpassData });
    }
  } catch (err: any) {
    console.error('Overpass request failed:', err.message);
    return res.status(502).json({
      error: 'OVERPASS_UNAVAILABLE',
      message: '실제 OSM 건물 데이터를 불러오지 못했습니다.',
      buildingSource: 'none'
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
    for (const p of parts) {
      try {
        const overlap = turf.booleanOverlap(b as any, p as any) ||
                        turf.booleanContains(b as any, p as any) ||
                        turf.booleanContains(p as any, b as any);
        if (overlap) return false;
      } catch (e) {
        // Fallback bbox overlap
        const bboxB = turf.bbox(b as any);
        const bboxP = turf.bbox(p as any);
        const bboxOverlap = !(bboxB[2] < bboxP[0] || bboxB[0] > bboxP[2] || bboxB[3] < bboxP[1] || bboxB[1] > bboxP[3]);
        if (bboxOverlap) return false;
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

    // Route Cost Scoring Equation
    const temperature = weatherCondition === 'sunny' ? 33 : weatherCondition === 'cloudy' ? 26 : 22;
    const baseHeatPenalty = Math.max(1.0, 1.0 + (temperature - 25) * 0.15);
    const weightMultiplier = (shadeWeight / 50.0);
    const heatPenalty = baseHeatPenalty * weightMultiplier;
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
      footprint: b.footprintWGS84?.coordinates?.[0]?.map((p: any) => [p[1], p[0]]) || [], // Convert [lng, lat] back to [lat, lng] for leaflet
      shadows: b.shadowWGS84?.coordinates?.[0]?.map((p: any) => [p[1], p[0]]) ? [b.shadowWGS84.coordinates[0].map((p: any) => [p[1], p[0]])] : []
    })),
    routingSource,
    buildingSource: "overpass",
    buildingCount,
    shadowCount,
    degraded: routingSource !== "openrouteservice" || shadowCount === 0,
    warnings
  });
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
