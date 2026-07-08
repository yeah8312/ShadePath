/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Coordinate {
  lat: number;
  lng: number;
}

export interface SolarPosition {
  elevation: number; // in degrees
  azimuth: number;   // in degrees (0=North, 90=East, 180=South, 270=West)
  shadowLengthRatio: number;
}

export interface PathResult {
  type: 'shade' | 'shortest';
  name: string;
  coords: [number, number][]; // [lat, lng] pairs
  distance: number; // meters
  duration: number; // minutes
  shadeRatio: number; // percentage (0 - 100)
  exposedDistance: number; // meters
  shadeDistance: number; // meters
  calories: number; // kcal
  steps: string[]; // text instructions
}

export type WeatherCondition = 'sunny' | 'cloudy' | 'rainy';

export interface WeatherState {
  temperature: number;
  condition: WeatherCondition;
  humidity: number;
  uvIndex: number;
}

export interface LocationPreset {
  id: string;
  name: string;
  lat: number;
  lng: number;
  description: string;
  start?: Coordinate;
  end?: Coordinate;
  startName?: string;
  endName?: string;
}

export interface ResolvedLocation {
  name: string;
  displayName: string;
  lat: number;
  lng: number;
}

export interface BuildingFeature {
  osmId: string;
  osmType: 'way' | 'relation';
  featureType: 'building' | 'building:part';
  geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  height: number;
  heightSource: 'height' | 'est_height' | 'levels-estimate' | 'type-fallback';
  heightConfidence: 'high' | 'medium' | 'low';
}
