/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface SolarPosition {
  elevation: number; // in degrees (0 to 90, negative if night)
  azimuth: number;   // in degrees (0 to 360, 0=North, 90=East, 180=South, 270=West)
  shadowLengthRatio: number; // multiplier for shadow projection length
}

export interface GridCell {
  x: number;
  y: number;
  lat: number;
  lng: number;
  buildingFactor: number; // 0 = no building, 1 = full building
  walkable: boolean;      // true if roads or walkable paths
  greeneryFactor: number; // 0 = no greenery, 1 = full tree cover
  isShadowed: boolean;    // dynamically calculated based on solar calculations
  shadowIntensity: number; // 0 to 1 shade coverage
  shadeScore: number;     // calculated composite comfort score (0 to 100)
}

export interface PathResult {
  type: 'shade' | 'shortest';
  name: string;
  coords: [number, number][]; // lat, lng pairs
  gridPath: GridCell[];
  distance: number; // meters
  duration: number; // minutes
  shadeRatio: number; // percentage (0 - 100)
  calories: number; // kcal
  steps: string[]; // text guidance
}

export type WeatherCondition = 'sunny' | 'cloudy' | 'rainy';

export interface WeatherState {
  temperature: number;
  condition: WeatherCondition;
  humidity: number;
  uvIndex: number;
}

export interface Landmark {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
  gridTemplateType: 'dense' | 'park' | 'mixed'; // to generate different building layout styles for simulation
}
