/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef } from 'react';
import L from 'leaflet';
import { PathResult, SolarPosition } from '../types';

interface MapContainerProps {
  center: [number, number];
  shadePath: PathResult | null;
  shortestPath: PathResult | null;
  solar: SolarPosition;
  showShadows: boolean;
  showBuildings: boolean;
  onMapClick: (lat: number, lng: number, type: 'start' | 'end') => void;
  startPoint: [number, number]; // [lat, lng]
  endPoint: [number, number];   // [lat, lng]
  endPointName?: string;
  realBuildings: {
    osmId: string;
    osmType: 'way' | 'relation';
    featureType: 'building' | 'building:part';
    name: string;
    height: number;
    footprintGeometry?: any;
    shadowGeometry?: any;
    heightSource: string;
    heightConfidence: string;
  }[];
  showDiagnostics?: boolean;
}

function getCentroidWGS84(geom: any): [number, number] | null {
  if (!geom) return null;
  if (geom.type === 'Polygon') {
    const coord = geom.coordinates?.[0]?.[0];
    if (coord) return [coord[1], coord[0]]; // [lat, lng]
  } else if (geom.type === 'MultiPolygon') {
    const coord = geom.coordinates?.[0]?.[0]?.[0];
    if (coord) return [coord[1], coord[0]]; // [lat, lng]
  }
  return null;
}

export default function MapContainer({
  center,
  shadePath,
  shortestPath,
  solar,
  showShadows,
  showBuildings,
  onMapClick,
  startPoint,
  endPoint,
  endPointName = '목적지 지점',
  realBuildings,
  showDiagnostics = false
}: MapContainerProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const mapInstanceRef = useRef<L.Map | null>(null);
  
  // Layer groups to manage drawings without recreating the map
  const buildingLayersRef = useRef<L.LayerGroup | null>(null);
  const shadowLayersRef = useRef<L.LayerGroup | null>(null);
  const pathLayersRef = useRef<L.LayerGroup | null>(null);
  const markerLayersRef = useRef<L.LayerGroup | null>(null);
  const diagnosticLayersRef = useRef<L.LayerGroup | null>(null);

  // Store click callback in ref to prevent map destruction
  const onMapClickRef = useRef(onMapClick);
  useEffect(() => {
    onMapClickRef.current = onMapClick;
  }, [onMapClick]);

  // Initialize Map exactly once
  useEffect(() => {
    if (!mapRef.current || mapInstanceRef.current) return;

    // Create Map
    const map = L.map(mapRef.current, {
      center: center,
      zoom: 16,
      zoomControl: false,
      minZoom: 12,
      maxZoom: 20
    });

    L.control.zoom({ position: 'bottomright' }).addTo(map);

    // Standard high-quality OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    shadowLayersRef.current = L.layerGroup().addTo(map);
    buildingLayersRef.current = L.layerGroup().addTo(map);
    pathLayersRef.current = L.layerGroup().addTo(map);
    markerLayersRef.current = L.layerGroup().addTo(map);
    diagnosticLayersRef.current = L.layerGroup().addTo(map);

    mapInstanceRef.current = map;

    // Force map size refresh to avoid viewport issues
    setTimeout(() => {
      map.invalidateSize();
    }, 150);

    // Set destination on map click
    map.on('click', (e: L.LeafletMouseEvent) => {
      onMapClickRef.current(e.latlng.lat, e.latlng.lng, 'end');
    });

    return () => {
      if (mapInstanceRef.current) {
        mapInstanceRef.current.remove();
        mapInstanceRef.current = null;
      }
    };
  }, []);

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
    const shadowGroup = shadowLayersRef.current;
    const buildingGroup = buildingLayersRef.current;
    const diagGroup = diagnosticLayersRef.current;

    if (!shadowGroup || !buildingGroup || !diagGroup) return;

    shadowGroup.clearLayers();
    buildingGroup.clearLayers();
    diagGroup.clearLayers();

    // 1. Render shadows
    if (showShadows && realBuildings) {
      realBuildings.forEach(b => {
        if (!b.shadowGeometry) return;
        L.geoJSON(b.shadowGeometry, {
          style: {
            stroke: false,
            fillColor: '#1e293b',
            fillOpacity: 0.5
          },
          interactive: false
        }).addTo(shadowGroup);
      });
    }

    // 2. Render buildings
    if (showBuildings && realBuildings) {
      realBuildings.forEach(b => {
        if (!b.footprintGeometry) return;
        
        // Define building styling color based on feature type
        const strokeColor = b.featureType === 'building:part' ? '#6366f1' : '#475569';
        const fillColor = b.featureType === 'building:part' ? '#c7d2fe' : '#94a3b8';

        const geojsonLayer = L.geoJSON(b.footprintGeometry, {
          style: {
            color: strokeColor,
            weight: 1,
            fillColor: fillColor,
            fillOpacity: 0.75
          }
        });

        // Detailed building popup with info
        geojsonLayer.bindPopup(`
          <div class="font-sans text-xs flex flex-col gap-1 p-1">
            <div class="font-bold text-gray-800 text-sm border-b pb-1 mb-1 flex items-center justify-between">
              <span>🏢 ${b.name || '건물'}</span>
              <span class="text-[10px] text-gray-400 font-mono">#${b.osmId}</span>
            </div>
            <div><span class="text-gray-500">유형:</span> <span class="font-semibold text-gray-700">${b.featureType === 'building:part' ? '건물 세부부품 (part)' : '기본 건물'}</span></div>
            <div><span class="text-gray-500">실제 높이:</span> <span class="font-bold text-indigo-600">${b.height.toFixed(1)}m</span></div>
            <div><span class="text-gray-500">높이 출처:</span> <span class="font-mono bg-gray-100 text-gray-600 px-1 py-0.5 rounded text-[10px]">${b.heightSource}</span></div>
            <div><span class="text-gray-500">신뢰도:</span> <span class="font-semibold text-xs ${b.heightConfidence === 'high' ? 'text-emerald-600' : b.heightConfidence === 'medium' ? 'text-amber-500' : 'text-rose-500'}">${b.heightConfidence.toUpperCase()}</span></div>
          </div>
        `, { maxWidth: 220 });

        geojsonLayer.addTo(buildingGroup);

        // Render diagnostics text label if activated
        if (showDiagnostics) {
          const centerPt = getCentroidWGS84(b.footprintGeometry);
          if (centerPt) {
            L.marker(centerPt, {
              icon: L.divIcon({
                html: `<div class="bg-black/80 text-white px-1 rounded text-[9px] font-mono whitespace-nowrap shadow-sm border border-slate-700">${b.height.toFixed(0)}m (${b.heightConfidence[0].toUpperCase()})</div>`,
                className: 'diagnostic-label',
                iconSize: [0, 0]
              }),
              interactive: false
            }).addTo(diagGroup);
          }
        }
      });
    }
  }, [realBuildings, showShadows, showBuildings, showDiagnostics]);

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
      }).bindTooltip(`🥵 뙤약볕 최단 직선 경로 (${shortestPath.distance}m, 그늘 ${shortestPath.shadeRatio}%)`, { permanent: false, direction: 'top' })
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
      }).bindTooltip(`🌲 실시간 추천 그늘 안전길 (${shadePath.distance}m, 그늘 ${shadePath.shadeRatio}%)`, { 
        permanent: true, 
        direction: 'top', 
        className: 'font-sans font-bold text-emerald-800 shadow-lg border border-emerald-200 rounded-lg px-2 py-1' 
      }).addTo(group);
    }
  }, [shadePath, shortestPath]);

  // Redraw Start & End markers
  useEffect(() => {
    const group = markerLayersRef.current;
    if (!group) return;

    group.clearLayers();

    // WGS84 markers
    const startIcon = L.divIcon({
      html: `
        <div class="relative flex items-center justify-center w-10 h-10">
          <span class="absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-60 animate-ping"></span>
          <div class="relative w-8 h-8 rounded-full bg-indigo-600 border-4 border-white shadow-lg flex items-center justify-center text-white font-sans font-bold text-xs">
            출발
          </div>
        </div>
      `,
      className: 'custom-leaflet-icon',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });

    L.marker(startPoint, { icon: startIcon })
      .bindPopup('<b>📍 출발지 (검색 위치)</b>')
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

    L.marker(endPoint, { icon: endIcon })
      .bindPopup(`
        <div class="font-sans text-xs flex flex-col gap-1 p-0.5">
          <span class="font-bold text-gray-800 text-xs">📍 목적지 도착 지점</span>
          <span class="text-gray-600 font-medium">${endPointName}</span>
          <span class="text-[10px] text-gray-400 font-mono mt-1">WGS84: ${endPoint[0].toFixed(5)}, ${endPoint[1].toFixed(5)}</span>
        </div>
      `, { maxWidth: 220 })
      .addTo(group);

  }, [startPoint, endPoint, endPointName]);

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
        <span>실제 위경도 보행 맵: 지도의 임의의 도로를 터치하여 새로운 실시간 도착지를 지정하세요.</span>
      </div>
    </div>
  );
}
