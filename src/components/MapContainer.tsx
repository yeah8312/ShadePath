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
  endPoint
}: MapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  
  // Layer refs to clear and update dynamically without destroying map
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
      zoomControl: false, // will position it customly
      minZoom: 14,
      maxZoom: 18
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Add high contrast OpenStreetMap tile layer
    L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO'
    }).addTo(map);

    // Initialize layer groups
    gridLayersRef.current = L.layerGroup().addTo(map);
    pathLayersRef.current = L.layerGroup().addTo(map);
    markerLayersRef.current = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;

    // Force map to recalculate container dimensions to avoid rendering zero height
    setTimeout(() => {
      map.invalidateSize();
    }, 150);

    // Add click listener to the map to update destination (EndPoint)
    map.on('click', (e: L.LeafletMouseEvent) => {
      // Find the closest grid cell to the clicked coordinate
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
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

  // Update map center when coordinates change
  useEffect(() => {
    if (mapInstanceRef.current) {
      mapInstanceRef.current.setView(center, mapInstanceRef.current.getZoom());
      // Re-trigger layout bounds checks
      setTimeout(() => {
        mapInstanceRef.current?.invalidateSize();
      }, 50);
    }
  }, [center]);

  // Redraw Grid Overlays (Buildings, Shadows, Greenery, Grid lines)
  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = gridLayersRef.current;
    if (!map || !group) return;

    group.clearLayers();

    // Loop through grid cells to draw polygons/rectangles
    // Cell dimensions: lat span is LAT_OFFSET, lng span is LNG_OFFSET
    const latHalf = 0.00015 / 2;
    const lngHalf = 0.00022 / 2;

    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const cell = grid[y][x];

        // Define bounding box for the grid cell
        const bounds: L.LatLngBoundsExpression = [
          [cell.lat - latHalf, cell.lng - lngHalf],
          [cell.lat + latHalf, cell.lng + lngHalf]
        ];

        // Draw grid lines if enabled
        if (showGridLines) {
          L.rectangle(bounds, {
            color: '#e5e7eb',
            weight: 0.5,
            fill: false,
            interactive: false
          }).addTo(group);
        }

        // Draw greenery cover
        if (showGreenery && cell.greeneryFactor > 0.1) {
          L.rectangle(bounds, {
            color: '#10b981',
            weight: 0,
            fillColor: '#10b981',
            fillOpacity: cell.greeneryFactor * 0.35,
            interactive: false
          }).addTo(group);
        }

        // Draw shadow layers (rgba projection based on shadowIntensity)
        if (showShadows && cell.isShadowed && cell.shadowIntensity > 0) {
          L.rectangle(bounds, {
            color: 'transparent',
            weight: 0,
            fillColor: '#1e293b', // deep cosmic slate shadow
            fillOpacity: cell.shadowIntensity * 0.48,
            interactive: false
          }).addTo(group);
        }

        // Draw buildings
        if (showBuildings && cell.buildingFactor > 0.1) {
          L.rectangle(bounds, {
            color: '#94a3b8',
            weight: 1,
            fillColor: '#cbd5e1',
            fillOpacity: 0.75,
            interactive: true
          }).bindPopup(`<b>건물 차폐지구</b><br>높이 지수: ${Math.round(cell.buildingFactor * 45)}m`)
            .addTo(group);
        }
      }
    }
  }, [grid, showShadows, showBuildings, showGreenery, showGridLines]);

  // Redraw path polylines
  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = pathLayersRef.current;
    if (!map || !group) return;

    group.clearLayers();

    // 1. Draw Shortest Path (뙤약볕 최단길 - 주황색/빨간색 점선)
    if (shortestPath && shortestPath.coords.length > 0) {
      L.polyline(shortestPath.coords, {
        color: '#f43f5e', // rose-500
        weight: 5,
        opacity: 0.8,
        dashArray: '8, 12',
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      }).bindTooltip('🥵 뙤약볕 최단길', { permanent: false, direction: 'top' })
        .addTo(group);
    }

    // 2. Draw Shade Path (그늘길 추천 경로 - 시원한 초록색/파란색 실선)
    if (shadePath && shadePath.coords.length > 0) {
      // Shadow stroke for contrast
      L.polyline(shadePath.coords, {
        color: '#064e3b', // dark emerald shadow outline
        weight: 8,
        opacity: 0.3,
        lineCap: 'round',
        lineJoin: 'round'
      }).addTo(group);

      L.polyline(shadePath.coords, {
        color: '#10b981', // emerald-500 primary
        weight: 6,
        opacity: 0.95,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: true
      }).bindTooltip('🌲 추천 그늘길', { permanent: true, direction: 'top', className: 'font-sans font-bold text-emerald-800' })
        .addTo(group);
    }
  }, [shadePath, shortestPath]);

  // Redraw Markers (Start & End with custom styled divIcons)
  useEffect(() => {
    const map = mapInstanceRef.current;
    const group = markerLayersRef.current;
    if (!map || !group) return;

    group.clearLayers();

    // Retrieve latlng for markers from the grid coordinates
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
        .bindPopup('<b>출발지 (내 보행 위치)</b>')
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
        .bindPopup('<b>목적지 (그늘 목적지)</b>')
        .addTo(group);
    }
  }, [grid, startPoint, endPoint]);

  return (
    <div className="relative w-full h-full rounded-2xl overflow-hidden shadow-xl border border-gray-100 bg-gray-50">
      {/* Map Element */}
      <div id="leaflet-map" ref={mapRef} className="w-full h-full" />

      {/* Floating Solar HUD info */}
      <div className="absolute top-4 right-4 z-[1000] bg-white/95 backdrop-blur-md px-4 py-3 rounded-xl shadow-lg border border-gray-100 font-sans text-xs flex flex-col gap-1.5 transition-all duration-300">
        <div className="flex items-center gap-2 font-semibold text-gray-700 border-b border-gray-100 pb-1.5">
          <span className="text-amber-500 text-sm">☀️</span>
          <span>실시간 태양 위치 HUD</span>
        </div>
        <div className="flex justify-between gap-6 text-gray-600">
          <span>태양 고도각 (Elevation):</span>
          <span className="font-mono font-medium text-gray-900">{solar.elevation.toFixed(1)}°</span>
        </div>
        <div className="flex justify-between gap-6 text-gray-600">
          <span>태양 방위각 (Azimuth):</span>
          <span className="font-mono font-medium text-gray-900">{solar.azimuth.toFixed(1)}°</span>
        </div>
        <div className="flex justify-between gap-6 text-gray-600">
          <span>그림자 배율 (Length Ratio):</span>
          <span className="font-mono font-medium text-amber-600 font-bold">{solar.shadowLengthRatio.toFixed(2)}x</span>
        </div>
      </div>

      {/* Touch to set location banner on bottom-left */}
      <div className="absolute bottom-4 left-4 z-[1000] bg-slate-900/90 backdrop-blur-md text-white px-3 py-1.5 rounded-lg shadow-md border border-slate-700/50 font-sans text-[11px] pointer-events-none flex items-center gap-1.5 animate-pulse">
        <span>📍</span>
        <span>지도를 터치하여 목적지(도착)를 새로 지정할 수 있습니다.</span>
      </div>
    </div>
  );
}
