/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GridCell, SolarPosition, Landmark } from '../types';

export const GRID_SIZE = 25; // 25x25 grid centered around selected map position
export const LAT_OFFSET = 0.00015; // roughly 16.5m per grid cell latitude
export const LNG_OFFSET = 0.00022; // roughly 19.5m per grid cell longitude

/**
 * Procedurally generates a realistic urban grid containing buildings, roads, and parks
 * matching the selected landmark style, to serve as the ground truth map representation.
 */
export function generateGrid(centerLat: number, centerLng: number, style: 'dense' | 'park' | 'mixed'): GridCell[][] {
  const grid: GridCell[][] = [];

  for (let y = 0; y < GRID_SIZE; y++) {
    const row: GridCell[] = [];
    for (let x = 0; x < GRID_SIZE; x++) {
      const lat = centerLat + (y - GRID_SIZE / 2) * LAT_OFFSET;
      const lng = centerLng + (x - GRID_SIZE / 2) * LNG_OFFSET;

      // Determine road structures (which are walkable)
      // We create a grid of main roads and secondary streets
      const isMainRoad = x === 12 || y === 12; // central crossroad
      const isSecondaryRoad = x % 6 === 0 || y % 6 === 0; // secondary streets
      const isWalkableAlley = (x % 3 === 0 && y % 3 === 0);

      let walkable = isMainRoad || isSecondaryRoad || isWalkableAlley;
      let buildingFactor = 0;
      let greeneryFactor = 0;

      // Set up characteristics based on landmark style
      if (style === 'dense') {
        // High density: more buildings, narrower roads, less greenery
        if (!walkable) {
          buildingFactor = 0.8 + Math.random() * 0.2; // tall buildings
        } else {
          // occasional small street trees
          if (Math.random() < 0.15) {
            greeneryFactor = 0.4;
          }
        }
      } else if (style === 'park') {
        // Green park: lots of greenery, fewer buildings
        const isParkCore = Math.sqrt(Math.pow(x - 12, 2) + Math.pow(y - 12, 2)) < 8;
        if (isParkCore) {
          walkable = true; // park pathways are walkable
          greeneryFactor = 0.7 + Math.random() * 0.3; // dense tree foliage
          buildingFactor = 0.0;
        } else {
          if (!walkable) {
            buildingFactor = 0.4 + Math.random() * 0.3; // medium-height buildings
            if (Math.random() < 0.4) {
              buildingFactor = 0.0;
              greeneryFactor = 0.6;
            }
          } else if (Math.random() < 0.3) {
            greeneryFactor = 0.5; // tree-shaded streets
          }
        }
      } else {
        // Mixed: balanced urban and park
        const isEastPark = x > 15 && y < 10;
        if (isEastPark) {
          walkable = true;
          greeneryFactor = 0.6 + Math.random() * 0.3;
        } else {
          if (!walkable) {
            buildingFactor = 0.6 + Math.random() * 0.3;
          } else if (Math.random() < 0.25) {
            greeneryFactor = 0.5; // street greenery
          }
        }
      }

      // Ensure that start/end points are walkable (e.g. near center and edges)
      if (Math.abs(x - 12) < 2 && Math.abs(y - 12) < 2) {
        walkable = true;
        buildingFactor = 0;
      }

      row.push({
        x,
        y,
        lat,
        lng,
        buildingFactor,
        walkable,
        greeneryFactor,
        isShadowed: false,
        shadowIntensity: 0,
        shadeScore: 0
      });
    }
    grid.push(row);
  }

  return grid;
}

/**
 * Projects shadows cast by buildings and greenery based on the solar position.
 * Modifies the provided grid in-place.
 */
export function projectGridShadows(grid: GridCell[][], solar: SolarPosition, isCloudyOrRainy: boolean): void {
  // Reset shadows first
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      grid[y][x].isShadowed = false;
      grid[y][x].shadowIntensity = 0;
    }
  }

  // If cloudy or rainy, there are no strong direct shadows (diffuse light).
  // Greenery still provides light rain protection / minor shade.
  if (isCloudyOrRainy) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const cell = grid[y][x];
        cell.shadowIntensity = cell.greeneryFactor * 0.3; // low contrast diffuse shade
        cell.shadeScore = Math.round(cell.shadowIntensity * 100);
      }
    }
    return;
  }

  // Greenery has local tree shade regardless of solar angle (canopy overhead)
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = grid[y][x];
      if (cell.greeneryFactor > 0.1) {
        cell.shadowIntensity = cell.greeneryFactor * 0.7; // canopy shade
        cell.isShadowed = true;
      }
    }
  }

  // If the sun is below the horizon, there's no sun shadow (it's night)
  if (solar.elevation <= 0) {
    for (let y = 0; y < GRID_SIZE; y++) {
      for (let x = 0; x < GRID_SIZE; x++) {
        const cell = grid[y][x];
        cell.isShadowed = true;
        cell.shadowIntensity = 1.0; // full night shade
        cell.shadeScore = 100;
      }
    }
    return;
  }

  // Trace shadow rays from each building block
  // Shadows project in the direction opposite to the solar azimuth
  const shadowAngleRad = (solar.azimuth + 180) * (Math.PI / 180);
  
  // Grid direction offsets
  const dx = Math.sin(shadowAngleRad);
  const dy = -Math.cos(shadowAngleRad); // grid y-axis goes down

  // Calculate maximum shadow length in grid units based on the solar altitude ratio
  const maxShadowLength = solar.shadowLengthRatio * 1.8;

  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = grid[y][x];
      
      if (cell.buildingFactor > 0.2) {
        // Project a shadow outward from this building
        const buildingHeight = cell.buildingFactor * 3.5; // building factor as a height proxy
        const shadowDistance = maxShadowLength * buildingHeight;

        // Trace steps along the shadow vector
        const steps = Math.ceil(shadowDistance * 2); // 0.5 cell steps
        for (let i = 1; i <= steps; i++) {
          const stepDist = i * 0.5;
          if (stepDist > shadowDistance) break;

          const sx = Math.round(x + dx * stepDist);
          const sy = Math.round(y + dy * stepDist);

          // Check grid boundaries
          if (sx >= 0 && sx < GRID_SIZE && sy >= 0 && sy < GRID_SIZE) {
            const targetCell = grid[sy][sx];
            if (targetCell.buildingFactor < 0.2) { // only cast shadow on streets / parks
              const distRatio = stepDist / shadowDistance;
              // Shadow intensity decays as distance increases
              const intensity = 0.85 * (1.0 - distRatio);
              
              if (intensity > targetCell.shadowIntensity) {
                targetCell.shadowIntensity = intensity;
                targetCell.isShadowed = true;
              }
            }
          }
        }
      }
    }
  }

  // Calculate final shadeScore (0 to 100) based on combined sun shadow and greenery canopy
  for (let y = 0; y < GRID_SIZE; y++) {
    for (let x = 0; x < GRID_SIZE; x++) {
      const cell = grid[y][x];
      if (cell.buildingFactor > 0.5) {
        cell.shadeScore = 0; // Buildings aren't walked on
      } else {
        const score = Math.max(cell.shadowIntensity, cell.greeneryFactor * 0.65);
        cell.shadeScore = Math.round(Math.min(1.0, score) * 100);
      }
    }
  }
}

/**
 * 2D Tile Color Analyzer function as described in the specification section 5.2.
 * This analyzes map tile RGB values to categorize grid features (building, greenery, or roads).
 */
export function analyzeMapTilePixel(r: number, g: number, b: number): { isBuilding: boolean; isGreenery: boolean } {
  let isBuilding = false;
  let isGreenery = false;

  // 1. Building detection (옅은 베이지 / 그레이 계열)
  if (r >= 210 && r <= 235 && g >= 200 && g <= 225 && b >= 195 && b <= 220) {
    isBuilding = true;
  }
  
  // 2. Greenery detection (녹색 필터)
  if (g > r + 15 && g > b + 15) {
    isGreenery = true;
  }

  return { isBuilding, isGreenery };
}
