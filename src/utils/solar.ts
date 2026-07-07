/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { SolarPosition } from '../types';

/**
 * Calculates the solar elevation (altitude) and azimuth angles based on latitude, longitude and local date.
 * Relies on the standard astronomical equations supplied in the specification.
 */
export function calculateSolarPosition(latitude: number, longitude: number, date: Date): SolarPosition {
  const radian = Math.PI / 180;

  // 1. Calculate Day of the Year (N)
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date.getTime() - start.getTime();
  const oneDay = 1000 * 60 * 60 * 24;
  const N = Math.floor(diff / oneDay);

  // 2. Solar Declination (delta) in degrees
  // delta = 23.45 * sin( radian * (360 / 365 * (284 + N)) )
  const delta = 23.45 * Math.sin(radian * (360 / 365 * (284 + N)));

  // 3. Hour Angle (H) in degrees (12:00 PM is 0 degrees, each hour is 15 degrees)
  const hours = date.getHours() + date.getMinutes() / 60 + date.getSeconds() / 3600;
  const H = (hours - 12) * 15;

  const latRad = latitude * radian;
  const deltaRad = delta * radian;
  const hRad = H * radian;

  // 4. Solar Altitude/Elevation angle (h)
  // sin(h) = sin(latRad)*sin(deltaRad) + cos(latRad)*cos(deltaRad)*cos(hRad)
  const sin_h = Math.sin(latRad) * Math.sin(deltaRad) +
                Math.cos(latRad) * Math.cos(deltaRad) * Math.cos(hRad);
  
  // Guard values for Math.asin
  const clamped_sin_h = Math.max(-1, Math.min(1, sin_h));
  let elevation = Math.asin(clamped_sin_h) / radian; // in degrees

  // 5. Solar Azimuth angle (A)
  const cos_h = Math.cos(Math.asin(clamped_sin_h));
  let A = 0;
  if (cos_h !== 0 && Math.cos(latRad) !== 0) {
    const cos_A = (Math.sin(deltaRad) - Math.sin(latRad) * clamped_sin_h) / (Math.cos(latRad) * cos_h);
    A = Math.acos(Math.max(-1, Math.min(1, cos_A))) / radian;
    if (hours > 12) {
      A = 360 - A; // Afternoon hour correction
    }
  } else {
    A = hours > 12 ? 270 : 90;
  }

  // 6. Shadow Length Ratio = 1 / tan(elevation)
  let shadowLengthRatio = 0;
  if (elevation > 0) {
    const eleRad = elevation * radian;
    // Capped to prevent division-by-zero or infinite lengths during sunrise/sunset
    if (elevation < 3) {
      shadowLengthRatio = 8.0; // max cap
    } else {
      shadowLengthRatio = Math.min(8.0, 1 / Math.tan(eleRad));
    }
  }

  return {
    elevation,
    azimuth: A,
    shadowLengthRatio
  };
}

/**
 * Convenience function to determine the general direction of building shadows.
 * Since shadows point in the exact opposite direction of the sun,
 * we offset the azimuth by 180 degrees.
 */
export function getShadowAngleRad(azimuth: number): number {
  const shadowAzimuth = (azimuth + 180) % 360;
  return shadowAzimuth * (Math.PI / 180);
}
