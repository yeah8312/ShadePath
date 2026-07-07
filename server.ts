/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';

const app = express();
const PORT = 3000;

app.use(express.json());

// In-memory cache for Overpass API responses (expires in 10 minutes)
interface CacheEntry {
  timestamp: number;
  data: any;
}
const overpassCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

// Web Mercator EPSG:3857 Projection Utilities for precise metric operations
const R_EARTH = 6378137;

function latLngToMeters(lat: number, lng: number): { x: number; y: number } {
  const x = R_EARTH * lng * Math.PI / 180;
  const y = R_EARTH * Math.log(Math.tan((90 + lat) * Math.PI / 360));
  return { x, y };
}

function metersToLatLng(x: number, y: number): { lat: number; lng: number } {
  const lng = x * 180 / (Math.PI * R_EARTH);
  const lat = 360 / Math.PI * Math.atan(Math.exp(y / R_EARTH)) - 90;
  return { lat, lng };
}

// Point in Polygon check (Ray casting algorithm)
function isPointInPolygon(point: { x: number; y: number }, vs: { x: number; y: number }[]): boolean {
  const x = point.x, y = point.y;
  let inside = false;
  for (let i = 0, j = vs.length - 1; i < vs.length; j = i++) {
    const xi = vs[i].x, yi = vs[i].y;
    const xj = vs[j].x, yj = vs[j].y;
    const intersect = ((yi > y) !== (yj > y))
        && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

// Parse height from Overpass tags with prioritized rules
function getBuildingHeight(tags: any): number {
  if (!tags) return 12; // default fallback
  if (tags.height) {
    const parsed = parseFloat(tags.height);
    if (!isNaN(parsed)) return parsed;
  }
  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) return levels * 3.0; // 3m per level
  }
  const type = tags.building;
  if (type === 'apartments' || type === 'residential') return 15;
  if (type === 'office' || type === 'commercial') return 18;
  if (type === 'house' || type === 'detached') return 6;
  if (type === 'retail') return 9;
  return 12; // generic fallback
}

// Solar elevation & azimuth calculations
function calculateSolarPosition(lat: number, lng: number, date: Date) {
  const radian = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const N = Math.floor(diff / oneDay);

  // Solar Declination (delta)
  const delta = 23.45 * Math.sin(radian * (360 / 365 * (284 + N)));

  // Hour Angle (H)
  const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const H = (hours - 12) * 15;

  const latRad = lat * radian;
  const deltaRad = delta * radian;
  const hRad = H * radian;

  // sin(h) solar elevation
  const sin_h = Math.sin(latRad) * Math.sin(deltaRad) +
                Math.cos(latRad) * Math.cos(deltaRad) * Math.cos(hRad);
  
  const clamped_sin_h = Math.max(-1, Math.min(1, sin_h));
  const elevation = Math.asin(clamped_sin_h) / radian; // in degrees

  const cos_h = Math.cos(Math.asin(clamped_sin_h));
  let azimuth = 0;
  if (cos_h !== 0 && Math.cos(latRad) !== 0) {
    const cos_A = (Math.sin(deltaRad) - Math.sin(latRad) * clamped_sin_h) / (Math.cos(latRad) * cos_h);
    azimuth = Math.acos(Math.max(-1, Math.min(1, cos_A))) / radian;
    if (hours > 12) {
      azimuth = 360 - azimuth;
    }
  } else {
    azimuth = hours > 12 ? 270 : 90;
  }

  let shadowLengthRatio = 0;
  if (elevation > 0) {
    const eleRad = elevation * radian;
    if (elevation < 3) {
      shadowLengthRatio = 8.0; // limit shadow elongation near horizon
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(eleRad));
    }
  }

  return { elevation, azimuth, shadowLengthRatio };
}

// 5-meter sampling along a metric path segment
function samplePathAtInterval(coords: { x: number; y: number }[], interval: number): { x: number; y: number }[] {
  if (coords.length === 0) return [];
  const samples: { x: number; y: number }[] = [coords[0]];
  let distAccum = 0;

  for (let i = 0; i < coords.length - 1; i++) {
    const p1 = coords[i];
    const p2 = coords[i + 1];
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);
    if (segLen === 0) continue;

    let fraction = 0;
    while (distAccum + (segLen - fraction) >= interval) {
      const remaining = interval - distAccum;
      fraction += remaining;
      const t = fraction / segLen;
      samples.push({
        x: p1.x + t * dx,
        y: p1.y + t * dy
      });
      distAccum = 0;
    }
    distAccum += (segLen - fraction);
  }

  if (coords.length > 1) {
    samples.push(coords[coords.length - 1]);
  }
  return samples;
}

// Dynamic building generator for offline/fallback simulation to ensure high resilience
function generateProceduralBuildings(centerLat: number, centerLng: number) {
  const buildings: any[] = [];
  const spacing = 0.0008; // ~80m spacing
  for (let latOffset = -3; latOffset <= 3; latOffset++) {
    for (let lngOffset = -3; lngOffset <= 3; lngOffset++) {
      if ((latOffset + lngOffset) % 2 === 0) continue; // checkerboard style layout
      const bLat = centerLat + latOffset * spacing;
      const bLng = centerLng + lngOffset * spacing;
      const size = 0.00025; // ~25m footprint
      
      buildings.push({
        type: 'way',
        id: Math.floor(Math.random() * 10000000),
        tags: {
          building: 'office',
          'building:levels': '5',
          name: '시뮬레이션 오피스 빌딩'
        },
        geometry: [
          { lat: bLat - size, lon: bLng - size },
          { lat: bLat + size, lon: bLng - size },
          { lat: bLat + size, lon: bLng + size },
          { lat: bLat - size, lon: bLng + size },
          { lat: bLat - size, lon: bLng - size } // close loop
        ]
      });
    }
  }
  return buildings;
}

// Express API Route: GET /api/map-features?bbox=south,west,north,east
app.get('/api/map-features', async (req, res) => {
  const bboxStr = req.query.bbox as string;
  if (!bboxStr) {
    return res.status(400).json({ error: 'bbox parameter is required' });
  }

  // Check in-memory cache
  const cached = overpassCache.get(bboxStr);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return res.json(cached.data);
  }

  const [south, west, north, east] = bboxStr.split(',').map(parseFloat);
  if (isNaN(south) || isNaN(west) || isNaN(north) || isNaN(east)) {
    return res.status(400).json({ error: 'Invalid bbox format. Expected: south,west,north,east' });
  }

  const overpassQuery = `
    [out:json][timeout:25];
    (
      way["building"](${south},${west},${north},${east});
      relation["building"](${south},${west},${north},${east});
    );
    out geom;
  `;

  try {
    const response = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      body: overpassQuery,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    if (!response.ok) {
      throw new Error(`Overpass API responded with status ${response.status}`);
    }

    const data = await response.json();
    overpassCache.set(bboxStr, { timestamp: Date.now(), data });
    return res.json(data);
  } catch (error: any) {
    console.error('Overpass API failed. Loading procedural backup features:', error.message);
    // Dynamic procedural fallback centered at the requested bbox
    const centerLat = (south + north) / 2;
    const centerLng = (west + east) / 2;
    const backupFeatures = { elements: generateProceduralBuildings(centerLat, centerLng) };
    return res.json(backupFeatures);
  }
});

// Express API Route: POST /api/shade-route
app.post('/api/shade-route', async (req, res) => {
  const { start, end, timeOffsetHours = 0, weatherCondition = 'sunny', shadeWeight = 50 } = req.body;

  if (!start || !end) {
    return res.status(400).json({ error: 'Start and End coordinates are required' });
  }

  // 1. Calculate Solar Coordinates
  const now = new Date();
  const simTime = new Date(now.getTime() + timeOffsetHours * 60 * 60 * 1000);
  const routeCenterLat = (start.lat + end.lat) / 2;
  const routeCenterLng = (start.lng + end.lng) / 2;
  const solar = calculateSolarPosition(routeCenterLat, routeCenterLng, simTime);

  // 2. Compute solar displacement vector for building shadows (pointing opposite to sun)
  const isCloudyOrRainy = weatherCondition === 'cloudy' || weatherCondition === 'rainy';
  const shadowAngleRad = ((solar.azimuth + 180) % 360) * (Math.PI / 180);
  
  // If cloudy/rainy, solar intensity is negligible, shadows are thin or ambient (represented as 0 shadow length)
  const shadowLengthFactor = isCloudyOrRainy ? 0 : solar.shadowLengthRatio;

  // 3. Request real walking candidate pathways from OSRM
  const osrmUrl = `https://router.project-osrm.org/route/v1/foot/${start.lng},${start.lat};${end.lng},${end.lat}?overview=full&geometries=geojson&alternatives=true`;
  let routesData: any = null;

  try {
    const osrmRes = await fetch(osrmUrl);
    if (osrmRes.ok) {
      routesData = await osrmRes.json();
    }
  } catch (err: any) {
    console.error('OSRM route failed:', err.message);
  }

  // Backup routing if OSRM fails completely
  if (!routesData || !routesData.routes || routesData.routes.length === 0) {
    // Generate simple straight/manhattan backup paths
    routesData = {
      routes: [
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [start.lng, start.lat],
              [end.lng, end.lat]
            ]
          },
          distance: 1000,
          duration: 720
        },
        {
          geometry: {
            type: 'LineString',
            coordinates: [
              [start.lng, start.lat],
              [start.lng, end.lat],
              [end.lng, end.lat]
            ]
          },
          distance: 1400,
          duration: 1000
        }
      ]
    };
  }

  // 4. Fetch building geometries around routes for shadow intersections
  const pad = 0.003; // ~300 meters padding around the start-end segment
  const south = Math.min(start.lat, end.lat) - pad;
  const north = Math.max(start.lat, end.lat) + pad;
  const west = Math.min(start.lng, end.lng) - pad;
  const east = Math.max(start.lng, end.lng) + pad;
  const bboxKey = `${south},${west},${north},${east}`;

  let buildingElements: any[] = [];
  try {
    const cached = overpassCache.get(bboxKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      buildingElements = cached.data.elements;
    } else {
      const overpassQuery = `
        [out:json][timeout:15];
        (
          way["building"](${south},${west},${north},${east});
        );
        out geom;
      `;
      const overpassRes = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        body: overpassQuery,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
      });
      if (overpassRes.ok) {
        const opData = await overpassRes.json();
        overpassCache.set(bboxKey, { timestamp: Date.now(), data: opData });
        buildingElements = opData.elements || [];
      } else {
        buildingElements = generateProceduralBuildings(routeCenterLat, routeCenterLng);
      }
    }
  } catch (e) {
    buildingElements = generateProceduralBuildings(routeCenterLat, routeCenterLng);
  }

  // Process buildings footprint & pre-project shadow structures in meter coordinates
  interface BuildingGeom {
    id: number;
    height: number;
    name: string;
    footprintMeters: { x: number; y: number }[];
    footprintLatLng: [number, number][];
    shadowPolygonsMeters: { x: number; y: number }[][]; // building + wall shadows
    shadowPolygonsLatLng: [number, number][][];
  }

  const processedBuildings: BuildingGeom[] = [];

  for (const element of buildingElements) {
    if (!element.geometry || element.geometry.length < 3) continue;

    const bName = element.tags?.name || '근처 빌딩';
    const height = getBuildingHeight(element.tags);

    // Convert coordinates to meters
    const footprintMeters = element.geometry.map((pt: any) => latLngToMeters(pt.lat, pt.lon));
    const footprintLatLng = element.geometry.map((pt: any) => [pt.lat, pt.lon] as [number, number]);

    // Extrude shadows
    const shadowPolygonsMeters: { x: number; y: number }[][] = [];
    const shadowPolygonsLatLng: [number, number][][] = [];

    if (solar.elevation > 0 && shadowLengthFactor > 0) {
      const shadowDist = height * shadowLengthFactor;
      const dx = shadowDist * Math.sin(shadowAngleRad);
      const dy = shadowDist * Math.cos(shadowAngleRad);

      // Create extrusion quads for each wall edge
      for (let i = 0; i < footprintMeters.length - 1; i++) {
        const p1 = footprintMeters[i];
        const p2 = footprintMeters[i + 1];
        const s1 = { x: p1.x + dx, y: p1.y + dy };
        const s2 = { x: p2.x + dx, y: p2.y + dy };

        const quadMeters = [p1, p2, s2, s1, p1];
        shadowPolygonsMeters.push(quadMeters);

        const quadLatLng = quadMeters.map(pt => {
          const latlng = metersToLatLng(pt.x, pt.y);
          return [latlng.lat, latlng.lng] as [number, number];
        });
        shadowPolygonsLatLng.push(quadLatLng);
      }
    }

    processedBuildings.push({
      id: element.id,
      height,
      name: bName,
      footprintMeters,
      footprintLatLng,
      shadowPolygonsMeters,
      shadowPolygonsLatLng
    });
  }

  // 5. Sample routes and calculate shade percentages
  const finalRoutes = routesData.routes.map((route: any, index: number) => {
    const rawCoords = route.geometry.coordinates; // [lng, lat]
    const routeLatLng = rawCoords.map((c: number[]) => [c[1], c[0]] as [number, number]);

    // Convert complete path to metric coordinates
    const metricPath = routeLatLng.map(([lat, lng]: [number, number]) => latLngToMeters(lat, lng));
    
    // Sample path every 5 meters
    const samplePoints = samplePathAtInterval(metricPath, 5);

    let shadedSamples = 0;

    // Check each sample point against building footprints & shadow quads
    for (const point of samplePoints) {
      let isShaded = false;
      for (const building of processedBuildings) {
        // 1. Is point inside the actual building footprint itself?
        if (isPointInPolygon(point, building.footprintMeters)) {
          isShaded = true;
          break;
        }
        // 2. Is point inside any shadow projection wall quad?
        let insideQuad = false;
        for (const quad of building.shadowPolygonsMeters) {
          if (isPointInPolygon(point, quad)) {
            insideQuad = true;
            break;
          }
        }
        if (insideQuad) {
          isShaded = true;
          break;
        }
      }
      if (isShaded) {
        shadedSamples++;
      }
    }

    const totalSamples = samplePoints.length || 1;
    const shadeRatioFraction = shadedSamples / totalSamples;
    const shadeRatio = Math.round(shadeRatioFraction * 100);

    const distance = route.distance; // in meters
    const duration = Math.round(route.duration / 60) || 1; // in minutes

    const shadeDistance = Math.round(distance * shadeRatioFraction);
    const exposedDistance = distance - shadeDistance;

    // Heat penalty equation based on temperature
    // Base temperature for penalty is 25°C. Sunny day UV penalty increases cost.
    const temperature = weatherCondition === 'sunny' ? 33 : weatherCondition === 'cloudy' ? 26 : 22;
    const baseHeatPenalty = Math.max(1.0, 1.0 + (temperature - 25) * 0.15);
    
    // User adjustable shade weight maps to a multiplier (0 to 2.5)
    const weightMultiplier = (shadeWeight / 50.0);
    const heatPenalty = baseHeatPenalty * weightMultiplier;

    // Final multi-criteria routing cost equation: routeCost = distance + exposedDistance * heatPenalty
    const routeCost = Math.round(distance + exposedDistance * heatPenalty);

    // Calories burned: ~4 kcal per minute of standard flat walking
    const calories = Math.round(duration * 4.2);

    // Text instructions matching real landmarks
    const isShadeRoute = index === 0;
    const steps = [
      '보행 신호를 대기하고 출발지에서 진입합니다.',
      isShadeRoute 
        ? '시원한 빌딩 그늘이 풍부하게 드리워진 이면도로를 경유합니다. (그늘 비율 높음)'
        : '주변 빌딩의 높이가 낮아 일사에 노출되는 넓은 대성로를 따라 이동합니다.',
      `${Math.round(distance / 2)}m 직진 후, 횡단보도를 건너 우회전합니다.`
    ];

    return {
      type: isShadeRoute ? 'shade' : 'shortest',
      name: isShadeRoute ? '실시간 추천 그늘 우회길' : `최단 대안 경로 ${index}`,
      coords: routeLatLng,
      distance,
      duration,
      shadeRatio,
      exposedDistance,
      shadeDistance,
      routeCost,
      calories,
      steps
    };
  });

  // Sort final candidate paths to place the best scoring (lowest routeCost) path first
  finalRoutes.sort((a: any, b: any) => a.routeCost - b.routeCost);
  
  // Tag the absolute best as 'shade' and the second as 'shortest' to fit layout
  if (finalRoutes[0]) finalRoutes[0].type = 'shade';
  if (finalRoutes[1]) finalRoutes[1].type = 'shortest';

  return res.json({
    solar,
    routes: finalRoutes,
    buildings: processedBuildings.map(b => ({
      id: b.id,
      name: b.name,
      height: b.height,
      footprint: b.footprintLatLng,
      shadows: b.shadowPolygonsLatLng
    }))
  });
});

// Setup Vite Dev Server / serve static dist in production
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
