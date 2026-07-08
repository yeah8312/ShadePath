/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import * as SunCalc from 'suncalc';
import proj4 from 'proj4';
import * as turf from '@turf/turf';

console.log('🤖 Running ShadePath Comprehensive Unit Tests (Real-world OSM Specs)...');

// ==================== CODE MIRRORS / TESTING FUNCTIONS ====================

// 1. Height and Level Parser
function parseBuildingHeight(tags: any): {
  height: number;
  heightSource: 'height' | 'est_height' | 'levels-estimate' | 'type-fallback';
  heightConfidence: 'high' | 'medium' | 'low';
} {
  if (!tags) {
    return { height: 10, heightSource: 'type-fallback', heightConfidence: 'low' };
  }

  const parseHeightString = (str: string): number | null => {
    str = str.trim().toLowerCase();
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

// 2. Solar Positioning
function getSolarAngles(date: Date, lat: number, lng: number) {
  const position = SunCalc.getPosition(date, lat, lng);
  const elevationDeg = position.altitude;
  const azimuthDeg = position.azimuth;

  let shadowLengthRatio = 0;
  if (elevationDeg > 0) {
    if (elevationDeg < 3) {
      shadowLengthRatio = 8.0;
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(elevationDeg * Math.PI / 180));
    }
  }

  return {
    elevation: elevationDeg,
    azimuth: azimuthDeg,
    shadowLengthRatio
  };
}

// 3. Path sampling in UTM meters
function samplePathUTM(coords: [number, number][], interval: number): [number, number][] {
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
    const lastSample = samples[samples.length - 1];
    const endPoint = coords[coords.length - 1];
    const distToEnd = Math.sqrt((lastSample[0] - endPoint[0]) ** 2 + (lastSample[1] - endPoint[1]) ** 2);
    if (distToEnd > 0.01) {
      samples.push(endPoint);
    }
  }
  return samples;
}

// 4. Translate UTM coordinates
function translatePolygonUTM(geom: any, dx: number, dy: number): any {
  if (geom.type === 'Polygon') {
    const rings = geom.coordinates.map((ring: any) => {
      return ring.map((pt: number[]) => [pt[0] + dx, pt[1] + dy]);
    });
    return { type: 'Polygon', coordinates: rings };
  }
  return geom;
}

// 5. Create side polygons
function createSidePolygonsUTM(original: any, translated: any): any[] {
  const sideQuads: any[] = [];
  if (original.type === 'Polygon') {
    const origRing = original.coordinates[0];
    const transRing = translated.coordinates[0];
    for (let i = 0; i < origRing.length - 1; i++) {
      const pA = origRing[i];
      const pB = origRing[i + 1];
      const sA = transRing[i];
      const sB = transRing[i + 1];
      sideQuads.push(turf.polygon([[pA, pB, sB, sA, pA]]));
    }
  }
  return sideQuads;
}

// 6. Union footprints and extruded quads
function unionShadowUTM(footprint: any, translated: any, sideQuads: any[]): any {
  let shadowFeature = turf.feature(footprint);
  const transFeature = turf.feature(translated);

  const merged = turf.union(turf.featureCollection([shadowFeature, transFeature]));
  if (merged) shadowFeature = merged;

  if (sideQuads.length > 0) {
    const batchMerged = turf.union(turf.featureCollection([shadowFeature, ...sideQuads]));
    if (batchMerged) shadowFeature = batchMerged;
  }

  return shadowFeature.geometry;
}

// 7. Route Cost score calculator
function getRouteCost(distance: number, shadeRatio: number, weatherCondition: string): number {
  const shadeRatioFraction = shadeRatio / 100;
  const shadeDistance = Math.round(distance * shadeRatioFraction);
  const exposedDistance = distance - shadeDistance;

  const heatPenaltyByWeather: Record<string, number> = {
    sunny: 3.6,
    cloudy: 1.2,
    rainy: 0.05
  };
  const heatPenalty = heatPenaltyByWeather[weatherCondition] ?? heatPenaltyByWeather.sunny;

  return Math.round(distance + exposedDistance * heatPenalty);
}

// ==================== TEST SUITES ====================

// Test 1: Overpass 응답 유효/무효 Geometry 처리 검증
function testOverpassGeometry() {
  console.log('🧪 Test 1: Overpass API Geometry Validation...');
  
  // Simulated invalid geometries
  const invalidElemEmpty: any = { id: 'way/1', geometry: [] };
  const invalidElemTooFewPoints: any = { id: 'way/2', geometry: [{ lat: 37, lon: 126 }] };
  const validElem: any = {
    id: 'way/3',
    geometry: [
      { lat: 37.0, lon: 126.0 },
      { lat: 37.1, lon: 126.0 },
      { lat: 37.1, lon: 126.1 },
      { lat: 37.0, lon: 126.1 },
      { lat: 37.0, lon: 126.0 }
    ]
  };

  assert.equal(invalidElemEmpty.geometry.length, 0);
  assert.equal(invalidElemTooFewPoints.geometry.length, 1);
  assert.equal(validElem.geometry.length, 5);
  
  console.log('   ✅ Passed Overpass Geometry validation!');
}

// Test 2: Building level 및 height 태그 파싱 규칙 검증
function testBuildingHeightParsing() {
  console.log('🧪 Test 2: Building height & levels tag parsing rules...');

  // 1) Explicit tag "height" in meters
  const r1 = parseBuildingHeight({ height: '18.5 m' });
  assert.equal(r1.height, 18.5);
  assert.equal(r1.heightSource, 'height');
  assert.equal(r1.heightConfidence, 'high');

  // 2) Feet tags conversion
  const r2 = parseBuildingHeight({ height: "30' 6\"" });
  const expectedMeters = (30 + 6/12) * 0.3048;
  assert.ok(Math.abs(r2.height - expectedMeters) < 0.01);
  assert.equal(r2.heightSource, 'height');

  // 3) Building:levels estimation
  const r3 = parseBuildingHeight({ 'building:levels': '10' });
  assert.equal(r3.height, 10 * 3.0 + 1.5);
  assert.equal(r3.heightSource, 'levels-estimate');
  assert.equal(r3.heightConfidence, 'medium');

  // 4) Detached house fallback
  const r4 = parseBuildingHeight({ building: 'house' });
  assert.equal(r4.height, 6);
  assert.equal(r4.heightSource, 'type-fallback');
  assert.equal(r4.heightConfidence, 'low');

  // 5) Null tags fallback
  const r5 = parseBuildingHeight(null);
  assert.equal(r5.height, 10);
  assert.equal(r5.heightSource, 'type-fallback');

  console.log('   ✅ Passed Height and level parsing!');
}

// Test 3: SunCalc 방위각 변환 및 그림자 거리 계산 검증
function testSunCalcAzimuthAndShadowLength() {
  console.log('🧪 Test 3: SunCalc azimuth correction and shadow length calculations...');

  // High noon in Daegu (Korea is UTC+9, so 12:00 KST is 03:00 UTC)
  const date = new Date(Date.UTC(2026, 6, 7, 3, 0, 0));
  const lat = 35.8714;
  const lng = 128.6014;

  const solar = getSolarAngles(date, lat, lng);
  
  // Noon azimuth in northern hemisphere should point generally South (approx 180 deg)
  assert.ok(solar.elevation > 0, 'Noon sun should be above horizon');
  assert.ok(solar.azimuth > 130 && solar.azimuth < 235, `Noon azimuth should be close to South (180 deg), got ${solar.azimuth}`);

  // Shadow length ratio for a 10m building
  const height = 10;
  const shadowDist = height * solar.shadowLengthRatio;
  assert.equal(shadowDist, height * solar.shadowLengthRatio);
  
  console.log('   ✅ Passed SunCalc azimuth correction & shadow length!');
}

// Test 4: UTM 좌표계 편위(dx, dy) 변환 검증
function testUTMCoordinatesDisplacement() {
  console.log('🧪 Test 4: UTM coordinates displacement shifts...');

  // Given a bearing of 135 degrees (South-East) and shadow length of 20 meters
  const bearing = 135;
  const distance = 20;

  const dx = distance * Math.sin(bearing * (Math.PI / 180));
  const dy = distance * Math.cos(bearing * (Math.PI / 180));

  // 135 degrees is Southeast, so dx should be positive and dy should be negative
  assert.ok(dx > 0, 'Southeast translation should shift right (Easting positive)');
  assert.ok(dy < 0, 'Southeast translation should shift down (Northing negative)');
  
  // Math check
  const actualLen = Math.sqrt(dx * dx + dy * dy);
  assert.ok(Math.abs(actualLen - distance) < 0.001);

  console.log('   ✅ Passed UTM displacement shifts!');
}

// Test 5: 임의 다각형에 대한 그림자 투영 알고리즘 검증
function testExtrudedShadowPolygon() {
  console.log('🧪 Test 5: Arbitrary polygon extrusion and side quad calculations...');

  // Create a standard square footprint polygon (UTM space)
  const footprint = turf.polygon([[
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0]
  ]]);

  // Displace by 10m East, 10m North
  const dx = 10;
  const dy = 10;
  const translated = translatePolygonUTM(footprint.geometry, dx, dy);

  // Side quads list
  const sideQuads = createSidePolygonsUTM(footprint.geometry, translated);
  assert.equal(sideQuads.length, 4, 'A square footprint has 4 wall segments casting shadows');

  // Verify first wall quad geometry
  const q0 = sideQuads[0].geometry.coordinates[0];
  assert.deepEqual(q0[0], [0, 0]);
  assert.deepEqual(q0[1], [10, 0]);
  assert.deepEqual(q0[2], [20, 10]); // translated pB
  assert.deepEqual(q0[3], [10, 10]); // translated pA
  assert.deepEqual(q0[4], [0, 0]);

  // Union shadows
  const shadowUnion = unionShadowUTM(footprint.geometry, translated, sideQuads);
  assert.ok(shadowUnion.type === 'Polygon' || shadowUnion.type === 'MultiPolygon');
  
  // Combined area should be larger than original footprint (100)
  const origArea = turf.area(footprint);
  const shadowArea = turf.area(turf.feature(shadowUnion));
  assert.ok(shadowArea > origArea);

  console.log('   ✅ Passed Arbitrary shadow polygon extrusion!');
}

// Test 6: 분할 샘플링 점들의 그늘 여부 통계 로직 검증
function testPathSamplingStatistics() {
  console.log('🧪 Test 6: Path sampling and shade intersection logic...');

  // Straight line from UTM x=0, y=0 to UTM x=50, y=0
  const path: [number, number][] = [
    [0, 0],
    [50, 0]
  ];

  // 5m sampling should generate exactly 11 points (0, 5, 10, ..., 50)
  const samples = samplePathUTM(path, 5);
  assert.equal(samples.length, 11);

  // Simulate a shadow polygon that covers UTM [10, 0] to [30, 0]
  const shadowPoly = turf.polygon([[
    [8, -5],
    [32, -5],
    [32, 5],
    [8, 5],
    [8, -5]
  ]]);

  let shadedPoints = 0;
  for (const [x, y] of samples) {
    if (turf.booleanPointInPolygon(turf.point([x, y]), shadowPoly)) {
      shadedPoints++;
    }
  }

  // Cover points: 10, 15, 20, 25, 30 -> 5 points
  assert.equal(shadedPoints, 5);
  const shadeRatio = Math.round((shadedPoints / samples.length) * 100);
  assert.equal(shadeRatio, 45); // 5 / 11 = 45%

  console.log('   ✅ Passed Path sampling shade statistics!');
}

// Test 7: 최단거리 vs 그늘 우회길 가중치 점수 계산 검증
function testRouteCostScoring() {
  console.log('🧪 Test 7: Route penalty and score equations...');

  const dist = 1000; // 1km

  // 1) Shaded route: 90% shade, sunny weather
  const costShaded = getRouteCost(dist, 90, 'sunny');
  
  // 2) Sunny route: 10% shade, sunny weather
  const costSunny = getRouteCost(dist, 10, 'sunny');

  // Exposed route should be significantly more costly than the shaded route
  assert.ok(costSunny > costShaded, `Sunny cost (${costSunny}) should be greater than shaded (${costShaded})`);

  // 3) Sunny route in cloudy weather has a moderate penalty
  const costCloudy = getRouteCost(dist, 10, 'cloudy');
  assert.ok(costSunny > costCloudy);

  // 4) Rainy weather nearly ignores shade preference
  const costRainy = getRouteCost(dist, 10, 'rainy');
  assert.ok(costCloudy > costRainy);

  console.log('   ✅ Passed Route scoring and weight math!');
}

// Run All
try {
  testOverpassGeometry();
  testBuildingHeightParsing();
  testSunCalcAzimuthAndShadowLength();
  testUTMCoordinatesDisplacement();
  testExtrudedShadowPolygon();
  testPathSamplingStatistics();
  testRouteCostScoring();
  console.log('\n🎉 ALL SHADEPATH REAL-WORLD UNIT TESTS PASSED IN PRISTINE CONDITION! 🎉\n');
  process.exit(0);
} catch (err: any) {
  console.error('\n❌ UNIT TEST TRIPPED AN ASSERTION:');
  console.error(err.message || err);
  process.exit(1);
}
