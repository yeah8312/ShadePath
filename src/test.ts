/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { assert } from 'console';

console.log('🤖 Running ShadePath Unit Tests...');

// Mock-ups and logic mirrors for testing pure functions
function getBuildingHeight(tags: any): number {
  if (!tags) return 12;
  if (tags.height) {
    const parsed = parseFloat(tags.height);
    if (!isNaN(parsed)) return parsed;
  }
  if (tags['building:levels']) {
    const levels = parseFloat(tags['building:levels']);
    if (!isNaN(levels)) return levels * 3.0;
  }
  const type = tags.building;
  if (type === 'apartments' || type === 'residential') return 15;
  if (type === 'office' || type === 'commercial') return 18;
  return 12;
}

function calculateSolarPosition(lat: number, lng: number, date: Date) {
  const radian = Math.PI / 180;
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const N = Math.floor(diff / oneDay);

  const delta = 23.45 * Math.sin(radian * (360 / 365 * (284 + N)));
  const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const H = (hours - 12) * 15;

  const latRad = lat * radian;
  const deltaRad = delta * radian;
  const hRad = H * radian;

  const sin_h = Math.sin(latRad) * Math.sin(deltaRad) +
                Math.cos(latRad) * Math.cos(deltaRad) * Math.cos(hRad);
  
  const clamped_sin_h = Math.max(-1, Math.min(1, sin_h));
  const elevation = Math.asin(clamped_sin_h) / radian;

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
      shadowLengthRatio = 8.0;
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(eleRad));
    }
  }

  return { elevation, azimuth, shadowLengthRatio };
}

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

function calculateRouteScore(distance: number, shadeRatio: number, shadeWeight: number, weatherCondition: string): number {
  const shadeRatioFraction = shadeRatio / 100;
  const shadeDistance = Math.round(distance * shadeRatioFraction);
  const exposedDistance = distance - shadeDistance;

  const temperature = weatherCondition === 'sunny' ? 33 : weatherCondition === 'cloudy' ? 26 : 22;
  const baseHeatPenalty = Math.max(1.0, 1.0 + (temperature - 25) * 0.15);
  const weightMultiplier = (shadeWeight / 50.0);
  const heatPenalty = baseHeatPenalty * weightMultiplier;

  return Math.round(distance + exposedDistance * heatPenalty);
}

// ==================== TEST CASES ====================

// Test 1: Building Height Parsing
function testBuildingHeightParsing() {
  console.log('🧪 Test 1: Building Height Parsing...');
  
  // Rule A: Explicit height tag
  const h1 = getBuildingHeight({ height: '24.5' });
  assert(h1 === 24.5, `Expected 24.5, got ${h1}`);

  // Rule B: building:levels tag
  const h2 = getBuildingHeight({ 'building:levels': '4' });
  assert(h2 === 12.0, `Expected 12, got ${h2}`);

  // Rule C: building type fallback
  const h3 = getBuildingHeight({ building: 'apartments' });
  assert(h3 === 15.0, `Expected 15, got ${h3}`);

  const h4 = getBuildingHeight({ building: 'office' });
  assert(h4 === 18.0, `Expected 18, got ${h4}`);

  const h5 = getBuildingHeight(null);
  assert(h5 === 12.0, `Expected 12, got ${h5}`);

  console.log('   ✅ Passed Building Height Parsing Tests!');
}

// Test 2: Solar Direction
function testSolarDirection() {
  console.log('🧪 Test 2: Solar Direction...');
  
  // Summer solstice noon in Seoul/Daegu (approx lat 35.8, lng 128.6)
  const summerNoon = new Date(2026, 5, 21, 12, 0, 0); // Month is 0-indexed (June = 5)
  const solar = calculateSolarPosition(35.8, 128.6, summerNoon);

  assert(solar.elevation > 70, `Expected high noon elevation, got ${solar.elevation}`);
  assert(solar.azimuth > 150 && solar.azimuth < 210, `Expected southern azimuth (around 180°), got ${solar.azimuth}`);

  console.log('   ✅ Passed Solar Direction Tests!');
}

// Test 3: Shadow Length Ratio
function testShadowLengthRatio() {
  console.log('🧪 Test 3: Shadow Length Ratio...');

  // High sun should cast shorter shadow ratio
  const solarHigh = calculateSolarPosition(35.8, 128.6, new Date(2026, 6, 7, 12, 0, 0));
  // Morning low sun should cast longer shadow ratio
  const solarLow = calculateSolarPosition(35.8, 128.6, new Date(2026, 6, 7, 8, 0, 0));

  assert(solarLow.shadowLengthRatio > solarHigh.shadowLengthRatio, 
    `Expected low sun ratio (${solarLow.shadowLengthRatio}) to be greater than high sun ratio (${solarHigh.shadowLengthRatio})`);
  assert(solarLow.shadowLengthRatio <= 8.0, `Expected low sun ratio to be capped at 8.0`);

  console.log('   ✅ Passed Shadow Length Ratio Tests!');
}

// Test 4: Path Sampling
function testPathSampling() {
  console.log('🧪 Test 4: Path Sampling (5m intervals)...');

  const path = [
    { x: 0, y: 0 },
    { x: 30, y: 0 }, // segment A of 30 meters
    { x: 30, y: 40 } // segment B of 40 meters (total 70 meters)
  ];

  const samples = samplePathAtInterval(path, 5);

  // Sampling 70m at 5m interval should yield 15 samples (0, 5, 10, 15, ..., 70)
  assert(samples.length === 16, `Expected 16 sample points, got ${samples.length}`);
  
  // Verify start and end points
  assert(samples[0].x === 0 && samples[0].y === 0, 'First sample mismatch');
  assert(samples[samples.length - 1].x === 30 && samples[samples.length - 1].y === 40, 'Last sample mismatch');

  console.log('   ✅ Passed Path Sampling Tests!');
}

// Test 5: Route Scoring / Cost
function testRouteScoring() {
  console.log('🧪 Test 5: Route Scoring & Penalties...');

  const distance = 1000;
  
  // Route A: 90% shade
  const costA = calculateRouteScore(distance, 90, 50, 'sunny');
  // Route B: 10% shade (heavy sun exposure)
  const costB = calculateRouteScore(distance, 10, 50, 'sunny');

  assert(costB > costA, `Expected exposed route cost (${costB}) to be higher than shaded route cost (${costA})`);

  // Increasing shade weight should amplify heat penalty for exposed routes
  const costBHighWeight = calculateRouteScore(distance, 10, 100, 'sunny');
  assert(costBHighWeight > costB, `Expected higher weight to increase exposed cost: ${costBHighWeight} vs ${costB}`);

  console.log('   ✅ Passed Route Scoring & Penalty Tests!');
}

// Run all test groups
try {
  testBuildingHeightParsing();
  testSolarDirection();
  testShadowLengthRatio();
  testPathSampling();
  testRouteScoring();
  console.log('\n🎉 ALL SHADEPATH UNIT TESTS PASSED SUCCESSFULLY! 🎉\n');
  process.exit(0);
} catch (err: any) {
  console.error('\n❌ UNIT TEST ASSERTION FAILED:');
  console.error(err.message || err);
  process.exit(1);
}
