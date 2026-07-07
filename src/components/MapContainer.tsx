/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { GridCell, PathResult, SolarPosition } from '../types';

interface MapContainerProps {
  center: [number, number];
  grid: GridCell[][];
  shadePath: PathResult | null;
  shortestPath: PathResult | null;
  solar: SolarPosition;
  showShadows: boolean;
  showBuildings: boolean;
  showGreenery: boolean;
  showGridLines: boolean;
  onCellClick: (x: number, y: number, type: 'start' | 'end') => void;
  startPoint: { x: number; y: number };
  endPoint: { x: number; y: number };
  endPointName?: string;
  // Real-world mode properties
  isSimulationMode: boolean;
  realStart: [number, number];
  realEnd: [number, number];
  realBuildings: {
    id: number;
    name: string;
    height: number;
    footprint: [number, number][];
    shadows: [number, number][][];
  }[];
  onMapClick: (lat: number, lng: number, type: 'start' | 'end') => void;
}

export default function MapContainer({
  center,
  grid,
  shadePath,
  shortestPath,
  solar,
  showShadows,
  showBuildings,
  showGreenery,
  showGridLines,
  onCellClick,
  startPoint,
  endPoint,
  endPointName = '목적지 지점',
  isSimulationMode,
  realStart,
  realEnd,
  realBuildings,
  onMapClick
}: MapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  
  // Layer groups to manage drawings without recreating the map
  const gridLayersRef = useRef<L.LayerGroup | null>(null);
  const pathLayersRef = useRef<L.LayerGroup | null>(null);
  const markerLayersRef = useRef<L.LayerGroup | null>(null);

  // Initialize Map
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Create Map
    const map = L.map(mapRef.current, {
      center: center,
      zoom: 16,
      zoomControl: false,
      minZoom: 13,
      maxZoom: 19
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Standard high-quality OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);

    gridLayersRef.current = L.layerGroup().addTo(map);
    pathLayersRef.current = L.layerGroup().addTo(map);
    markerLayersRef.current = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;

    // Force map size refresh to avoid viewport issues
    setTimeout(() => {
      map.invalidateSize();
    }, 150);

    // Set destination on map click
    map.on('click', (e: L.LeafletMouseEvent) => {
      if (isSimulationMode) {
        // Find closest grid cell
        let closestCell: GridCell | null = null;
        let minDistance = Infinity;

        for (let y = 0; y < grid.length; y++) {
          for (let x = 0; x < grid[y].length; x++) {
            const cell = grid[y][x];
            const dist = Math.sqrt(Math.pow(cell.lat - e.latlng.lat, 2) + Math.pow(cell.lng - e.latlng.lng, 2));
            if (dist < minDistance) {
              minDistance = dist;
              closestCell = cell;
            }
          }
        }

        if (closestCell) {
          onCellClick(closestCell.x, closestCell.y, 'end');
        }
      } else {
        // Real world mode: update end point coordinates directly
        onMapClick(e.latlng.lat, e.latlng.lng, 'end');
      }
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, [grid, isSimulationMode, onCellClick, onMapClick]);

  // Handle map center changes smoothly
  useEffect(() => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView(center, mapInstanceRef.current.getZoom());
      setTimeout(() => {
        mapInstanceRef.current?.invalidateSize();
      }, 50);
    }
  }, [center]);

  // Redraw Building and Shadow footprints layer
  useEffect(() => {
    const group = gridLayersRef.current;
    if (!group) return;

    group.clearLayers();

    if (isSimulationMode) {
      // 25x25 Procedural Grid Simulation mode
      const latHalf = 0.00015 / 2;
      const lngHalf = 0.00022 / 2;

      for (let y = 0; y < grid.length; y++) {
        for (let x = 0; x < grid[y].length; x++) {
          const cell = grid[y][x];
          const bounds: L.LatLngBoundsExpression = [
            [cell.lat - latHalf, cell.lng - lngHalf],
            [cell.lat + latHalf, cell.lng + lngHalf]
          ];

          if (showGridLines) {
            L.rectangle(bounds, {
              color: '#cbd5e1',
              weight: 0.5,
              fill: false,
              interactive: false
            }).addTo(group);
          }

          if (showGreenery && cell.greeneryFactor > 0.1) {
            L.rectangle(bounds, {
              color: '#10b981',
              weight: 0,
              fillColor: '#10b981',
              fillOpacity: cell.greeneryFactor * 0.35,
              interactive: false
            }).addTo(group);
          }

          if (showShadows && cell.isShadowed && cell.shadowIntensity > 0) {
            L.rectangle(bounds, {
              color: 'transparent',
              weight: 0,
              fillColor: '#1e293b',
              fillOpacity: cell.shadowIntensity * 0.45,
              interactive: false
            }).addTo(group);
          }

          if (showBuildings && cell.buildingFactor > 0.1) {
            L.rectangle(bounds, {
              color: '#94a3b8',
              weight: 1,
              fillColor: '#cbd5e1',
              fillOpacity: 0.75,
              interactive: true
            }).bindPopup(`<b>건물 차폐지구 (시뮬레이션)</b><br>높이: ${Math.round(cell.buildingFactor * 45)}m`)
              .addTo(group);
          }
        }
      }
    } else {
      // Real-world OSM Mode: Render polygons fetched from Overpass API
      
      // 1. Shadows layer (rendered below buildings)
      if (showShadows && realBuildings) {
        realBuildings.forEach(b => {
          if (!b.shadows) return;
          b.shadows.forEach(shadowPoly => {
            L.polygon(shadowPoly, {
              stroke: false,
              fillColor: '#1e293b',
              fillOpacity: 0.48,
              interactive: false
            }).addTo(group);
          });
        });
      }

      // 2. Real Buildings layer
      if (showBuildings && realBuildings) {
        realBuildings.forEach(b => {
          L.polygon(b.footprint, {
            color: '#475569',
            weight: 1,
            fillColor: '#94a3b8',
            fillOpacity: 0.75,
            interactive: true
          }).bindPopup(`<b>${b.name || '건물'}</b><br>높이: ${b.height}m`)
            .addTo(group);
        });
      }
    }
  }, [grid, isSimulationMode, realBuildings, showShadows, showBuildings, showGreenery, showGridLines]);

  // Redraw path polylines
  useEffect(() => {
    const group = pathLayersRef.current;
    if (!group) return;

    group.clearLayers();

    // 1. Draw Shortest Path (Red/Rose dashed line)
    if (shortestPath && shortestPath.coords.length > 0) {
      L.polyline(shortestPath.coords, {
        color: '#f43f5e',
        weight: 5,
        opacity: 0.8,
        dashArray: '8, 12',
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      }).bindTooltip(`🥵 뙤약볕 최단길 (${shortestPath.distance}m, 그늘 ${shortestPath.shadeRatio}%)`, { permanent: false, direction: 'top' })
        .addTo(group);
    }

    // 2. Draw Shade Path (Emerald solid line)
    if (shadePath && shadePath.coords.length > 0) {
      // Dark outline for high visibility contrast
      L.polyline(shadePath.coords, {
        color: '#064e3b',
        weight: 8,
        opacity: 0.3,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(group);

      L.polyline(shadePath.coords, {
        color: '#10b981',
        weight: 6,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      }).bindTooltip(`🌲 추천 그늘 안전길 (${shadePath.distance}m, 그늘 ${shadePath.shadeRatio}%)`, { 
        permanent: true, 
        direction: 'top', 
        className: 'font-sans font-bold text-emerald-800' 
      }).addTo(group);
    }
  }, [shadePath, shortestPath]);

  // Redraw Start & End markers
  useEffect(() => {
    const group = markerLayersRef.current;
    if (!group) return;

    group.clearLayers();

    if (isSimulationMode) {
      const startCell = grid[startPoint.y]?.[startPoint.x];
      const endCell = grid[endPoint.y]?.[endPoint.x];

      if (startCell) {
        const startIcon = L.divIcon({
          html: `
            <div class="relative flex items-center justify-center w-10 h-10">
              <span class="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-60 animate-ping"></span>
              <div class="relative w-8 h-8 rounded-full bg-emerald-600 border-4 border-white shadow-lg flex items-center justify-center text-white font-sans font-bold text-xs">
                출발
              </div>
            </div>
          `,
          className: 'custom-leaflet-icon',
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        });

        L.marker([startCell.lat, startCell.lng], { icon: startIcon })
          .bindPopup('<b>출발지 (가상 격자)</b>')
          .addTo(group);
      }

      if (endCell) {
        const endIcon = L.divIcon({
          html: `
            <div class="relative flex items-center justify-center w-10 h-10">
              <span class="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-60 animate-pulse"></span>
              <div class="relative w-8 h-8 rounded-full bg-rose-600 border-4 border-white shadow-lg flex items-center justify-center text-white font-sans font-bold text-xs">
                도착
              </div>
            </div>
          `,
          className: 'custom-leaflet-icon',
          iconSize: [40, 40],
          iconAnchor: [20, 20]
        });

        L.marker([endCell.lat, endCell.lng], { icon: endIcon })
          .bindPopup(`
            <div class="font-sans text-xs flex flex-col gap-1 p-0.5">
              <span class="font-bold text-gray-800 text-xs">📍 목적지 도착 지점</span>
              <span class="text-gray-600 font-medium">${endPointName}</span>
              <span class="text-[10px] text-gray-400 font-mono mt-1">Grid: X: ${endPoint.x}, Y: ${endPoint.y}</span>
            </div>
          `, { maxWidth: 220 })
          .addTo(group);
      }
    } else {
      // Real-world OSM markers
      const startIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center w-10 h-10">
            <span class="absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-60 animate-ping"></span>
            <div class="relative w-8 h-8 rounded-full bg-blue-600 border-4 border-white shadow-lg flex items-center justify-center text-white font-sans font-bold text-xs">
              출발
            </div>
          </div>
        `,
        className: 'custom-leaflet-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      });

      L.marker(realStart, { icon: startIcon })
        .bindPopup('<b>출발 위치 (내 위치)</b>')
        .addTo(group);

      const endIcon = L.divIcon({
        html: `
          <div class="relative flex items-center justify-center w-10 h-10">
            <span class="absolute inline-flex h-full w-full rounded-full bg-rose-400 opacity-60 animate-pulse"></span>
            <div class="relative w-8 h-8 rounded-full bg-rose-600 border-4 border-white shadow-lg flex items-center justify-center text-white font-sans font-bold text-xs">
              도착
            </div>
          </div>
        `,
        className: 'custom-leaflet-icon',
        iconSize: [40, 40],
        iconAnchor: [20, 20]
      });

      L.marker(realEnd, { icon: endIcon })
        .bindPopup(`
          <div class="font-sans text-xs flex flex-col gap-1 p-0.5">
            <span class="font-bold text-gray-800 text-xs">📍 목적지 도착 지점</span>
            <span class="text-gray-600 font-medium">${endPointName}</span>
            <span class="text-[10px] text-gray-400 font-mono mt-1">WGS84: ${realEnd[0].toFixed(5)}, ${realEnd[1].toFixed(5)}</span>
          </div>
        `, { maxWidth: 220 })
        .addTo(group);
    }
  }, [grid, isSimulationMode, startPoint, endPoint, realStart, realEnd, endPointName]);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden shadow-xl border border-gray-100 bg-gray-50">
      {/* Leaflet Map Hook */}
      <div id="leaflet-map" ref={mapRef} className="w-full h-full" />

      {/* Floating Solar HUD info */}
      <div className="absolute top-[76px] right-4 z-[1000] bg-white/95 backdrop-blur-md px-3 py-2 rounded-xl shadow-lg border border-gray-100 font-sans text-[10px] flex flex-col gap-1 transition-all duration-300 max-w-[190px]">
        <div className="flex items-center gap-1.5 font-semibold text-gray-700 border-b border-gray-150 pb-1">
          <span className="text-amber-500 text-xs">☀️</span>
          <span>태양 그림자 분석 HUD</span>
        </div>
        <div className="flex justify-between gap-3 text-gray-600">
          <span>고도각 (Elevation):</span>
          <span className="font-mono font-bold text-gray-900">{solar.elevation.toFixed(1)}°</span>
        </div>
        <div className="flex justify-between gap-3 text-gray-600">
          <span>방위각 (Azimuth):</span>
          <span className="font-mono font-bold text-gray-900">{solar.azimuth.toFixed(1)}°</span>
        </div>
        <div className="flex justify-between gap-3 text-gray-600">
          <span>그림자 배율:</span>
          <span className="font-mono font-extrabold text-amber-600">{solar.shadowLengthRatio.toFixed(2)}x</span>
        </div>
      </div>

      {/* Guide Banner */}
      <div className="absolute bottom-4 left-4 z-[1000] bg-slate-900/95 backdrop-blur-md text-white px-3.5 py-2 rounded-lg shadow-md border border-slate-700/50 font-sans text-[11px] pointer-events-none flex items-center gap-1.5">
        <span>📍</span>
        <span>
          {isSimulationMode 
            ? '시뮬레이션 가상 맵: 지도를 터치하여 목적지 격자를 변경합니다.'
            : '실제 위경도 보행 맵: 지도의 임의의 도로를 터치하여 새로운 실시간 도착지를 지정하세요.'
          }
        </span>
      </div>
    </div>
  );
}
