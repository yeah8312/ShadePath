/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Sun, Cloud, CloudRain, Navigation, Compass, Footprints, Info, MapPin, 
  ArrowUpDown, Layers, Clock, ChevronDown, Activity, Settings, Search, Check, AlertCircle
} from 'lucide-react';
import { LocationPreset, WeatherCondition, WeatherState, PathResult, SolarPosition, ResolvedLocation } from './types';
import MapContainer from './components/MapContainer';
import ControlPanel, { LOCATION_PRESETS } from './components/ControlPanel';
import PathDetails from './components/PathDetails';

export async function parseApiResponse(response: Response): Promise<any> {
  const contentType = response.headers.get('Content-Type') || '';
  const text = await response.text();
  
  if (!response.ok) {
    console.error(`API Error response [Status: ${response.status}]:`, text);
  }

  if (!text.trim()) {
    if (!response.ok) {
      throw new Error(`API 호출 실패: 빈 응답 (HTTP 상태: ${response.status})`);
    }
    return {};
  }

  const isJson = contentType.includes('application/json');

  if (isJson) {
    try {
      const data = JSON.parse(text);
      if (!response.ok) {
        throw new Error(data.message || data.error || `API 호출 실패 (HTTP 상태: ${response.status})`);
      }
      return data;
    } catch (parseErr: any) {
      if (parseErr.message && !parseErr.message.includes('Unexpected token')) {
        throw parseErr;
      }
      const previewText = text.substring(0, 100);
      throw new Error(`JSON 파싱 실패 (HTTP 상태: ${response.status}): ${previewText}`);
    }
  } else {
    const previewText = text.substring(0, 200);
    throw new Error(`잘못된 응답 형식 (Content-Type: ${contentType}, HTTP 상태: ${response.status}): ${previewText}`);
  }
}

export default function App() {
  // --- Core States ---
  const [currentPreset, setCurrentPreset] = useState<LocationPreset>(LOCATION_PRESETS[0]);
  const [weatherCondition, setWeatherCondition] = useState<WeatherCondition>('sunny');
  const [timeOffsetHours, setTimeOffsetHours] = useState<number>(0);
  const [selectedPathType, setSelectedPathType] = useState<'shade' | 'shortest'>('shade');

  // --- Layer Visibility Options ---
  const [showShadows, setShowShadows] = useState<boolean>(true);
  const [showBuildings, setShowBuildings] = useState<boolean>(true);
  const [showDiagnostics, setShowDiagnostics] = useState<boolean>(false);

  // --- UI Panels state ---
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [landmarkDropdownOpen, setLandmarkDropdownOpen] = useState<boolean>(false);

  // --- Coordinates States ---
  const [realStart, setRealStart] = useState<[number, number]>([LOCATION_PRESETS[0].lat, LOCATION_PRESETS[0].lng]);
  const [realEnd, setRealEnd] = useState<[number, number]>([
    LOCATION_PRESETS[0].lat + 0.0012,
    LOCATION_PRESETS[0].lng + 0.0016
  ]);
  const [mapCenter, setMapCenter] = useState<[number, number]>([LOCATION_PRESETS[0].lat, LOCATION_PRESETS[0].lng]);

  // --- Geocoding Input & Results ---
  const [startSearchQuery, setStartSearchQuery] = useState<string>('');
  const [endSearchQuery, setEndSearchQuery] = useState<string>('');
  const [startSearchResults, setStartSearchResults] = useState<ResolvedLocation[]>([]);
  const [endSearchResults, setEndSearchResults] = useState<ResolvedLocation[]>([]);
  const [isSearchingStart, setIsSearchingStart] = useState<boolean>(false);
  const [isSearchingEnd, setIsSearchingEnd] = useState<boolean>(false);
  const [endPointName, setEndPointName] = useState<string>('반월당 보행로 교차지점');

  // --- Calculated Outputs ---
  const [realBuildings, setRealBuildings] = useState<any[]>([]);
  const [realSolar, setRealSolar] = useState<SolarPosition>({ elevation: 42, azimuth: 178, shadowLengthRatio: 1.1 });
  const [realShadePath, setRealShadePath] = useState<PathResult | null>(null);
  const [realShortestPath, setRealShortestPath] = useState<PathResult | null>(null);
  
  // --- Stats and Sources ---
  const [routingSource, setRoutingSource] = useState<string>('unknown');
  const [buildingSource, setBuildingSource] = useState<string>('none');
  const [buildingCount, setBuildingCount] = useState<number>(0);
  const [shadowCount, setShadowCount] = useState<number>(0);
  const [degraded, setDegraded] = useState<boolean>(false);
  const [apiWarnings, setApiWarnings] = useState<string[]>([]);

  // --- Loading & Error States ---
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // --- AbortController for cancelable requests ---
  const routeAbortControllerRef = useRef<AbortController | null>(null);

  // --- Base System Clock ---
  const [baseTime] = useState<Date>(() => new Date());

  // --- Weather Details for HUD ---
  const weatherState: WeatherState = useMemo(() => {
    switch (weatherCondition) {
      case 'cloudy':
        return { temperature: 27, condition: 'cloudy', humidity: 65, uvIndex: 3 };
      case 'rainy':
        return { temperature: 24, condition: 'rainy', humidity: 85, uvIndex: 1 };
      case 'sunny':
      default:
        return { temperature: 33, condition: 'sunny', humidity: 55, uvIndex: 9 };
    }
  }, [weatherCondition]);

  // --- Sync coordinates when preset changes ---
  useEffect(() => {
    const presetStart = currentPreset.start ?? { lat: currentPreset.lat, lng: currentPreset.lng };
    const presetEnd = currentPreset.end ?? { lat: currentPreset.lat + 0.0012, lng: currentPreset.lng + 0.0016 };

    setRealStart([presetStart.lat, presetStart.lng]);
    setRealEnd([presetEnd.lat, presetEnd.lng]);
    setMapCenter([currentPreset.lat, currentPreset.lng]);
    setStartSearchQuery(currentPreset.startName ?? currentPreset.name);
    setEndPointName(currentPreset.endName ?? '프리셋 지정 목적지');
    setEndSearchQuery(currentPreset.endName ?? '프리셋 지정 목적지');
  }, [currentPreset]);

  // --- Geocoding Query Functions ---
  const searchGeocode = async (query: string, type: 'start' | 'end') => {
    if (!query.trim()) return;
    
    if (type === 'start') {
      setIsSearchingStart(true);
      setStartSearchResults([]);
    } else {
      setIsSearchingEnd(true);
      setEndSearchResults([]);
    }

    try {
      const response = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`);
      const data = await parseApiResponse(response);
      
      if (type === 'start') {
        setStartSearchResults(data.results || []);
      } else {
        setEndSearchResults(data.results || []);
      }
    } catch (err: any) {
      console.error('Geocoding error:', err);
    } finally {
      if (type === 'start') {
        setIsSearchingStart(false);
      } else {
        setIsSearchingEnd(false);
      }
    }
  };

  // --- Reverse Geocode lookup for manual clicks or initial sync ---
  const performReverseGeocode = async (lat: number, lng: number, type: 'start' | 'end') => {
    try {
      const res = await fetch(`/api/reverse-geocode?lat=${lat}&lng=${lng}`);
      const data = await parseApiResponse(res);
      
      if (type === 'start') {
        setStartSearchQuery(data.name);
      } else {
        setEndPointName(data.name);
        setEndSearchQuery(data.name);
      }
    } catch (err) {
      const label = `지정 좌표 (${lat.toFixed(5)}, ${lng.toFixed(5)})`;
      if (type === 'start') {
        setStartSearchQuery(label);
      } else {
        setEndPointName(label);
        setEndSearchQuery(label);
      }
    }
  };

  // Run reverse-geocodes on initial coords to populate forms
  useEffect(() => {
    performReverseGeocode(realStart[0], realStart[1], 'start');
    performReverseGeocode(realEnd[0], realEnd[1], 'end');
  }, []);

  // --- Main API Trigger: Compute Shade Paths ---
  const fetchShadeRoutes = async () => {
    // 1. Abort previous unfinished routing requests
    if (routeAbortControllerRef.current) {
      routeAbortControllerRef.current.abort();
    }
    const controller = new AbortController();
    routeAbortControllerRef.current = controller;

    // 2. Clear old state results (Requirement 9)
    setRealBuildings([]);
    setRealShadePath(null);
    setRealShortestPath(null);
    setBuildingCount(0);
    setShadowCount(0);
    setRoutingSource('unknown');
    setBuildingSource('none');
    setApiWarnings([]);
    setRouteError(null);

    setLoadingRoute(true);

    const simTime = new Date(baseTime.getTime() + timeOffsetHours * 60 * 60 * 1000);

    try {
      const res = await fetch('/api/shade-route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          start: { lat: realStart[0], lng: realStart[1] },
          end: { lat: realEnd[0], lng: realEnd[1] },
          datetime: simTime.toISOString(),
          weatherCondition
        }),
        signal: controller.signal
      });

      const data = await parseApiResponse(res);

      setRealSolar(data.solar);
      setRealBuildings(data.buildings || []);
      setRoutingSource(data.routingSource);
      setBuildingSource(data.buildingSource);
      setBuildingCount(data.buildingCount || 0);
      setShadowCount(data.shadowCount || 0);
      setDegraded(!!data.degraded);
      setApiWarnings(data.warnings || []);

      const routes = data.routes || [];
      const shade = routes.reduce((best: any | null, route: any) => {
        if (!best) return route;
        return route.routeCost < best.routeCost ? route : best;
      }, null);
      const shortest = routes.reduce((best: any | null, route: any) => {
        if (!best) return route;
        return route.distance < best.distance ? route : best;
      }, null);

      setRealShadePath(shade);
      setRealShortestPath(shortest);
    } catch (err: any) {
      if (err.name === 'AbortError') {
        // Ignored, request was aborted by a newer request
        return;
      }
      console.error('API Error during route computation:', err);
      setRouteError(err.message || '서버 통신 오류가 발생했습니다.');
      
      // Keep cleared results on failure
      setRealBuildings([]);
      setRealShadePath(null);
      setRealShortestPath(null);
      setBuildingCount(0);
      setShadowCount(0);
      setRoutingSource('unknown');
      setBuildingSource('none');
      setApiWarnings([]);
    } finally {
      if (routeAbortControllerRef.current === controller) {
        setLoadingRoute(false);
      }
    }
  };

  // --- Swap start and end points instantly ---
  const handleSwapPoints = () => {
    const tempStart = realStart;
    const tempStartQuery = startSearchQuery;

    setRealStart(realEnd);
    setStartSearchQuery(endSearchQuery);

    setRealEnd(tempStart);
    setEndPointName(tempStartQuery);
    setEndSearchQuery(tempStartQuery);
    setMapCenter(realEnd);
  };

  // --- Handle Map Interactive Clicks ---
  const handleMapClick = (lat: number, lng: number, type: 'start' | 'end') => {
    if (type === 'end') {
      setRealEnd([lat, lng]);
      performReverseGeocode(lat, lng, 'end');
    } else {
      setRealStart([lat, lng]);
      performReverseGeocode(lat, lng, 'start');
    }
  };

  // --- Geolocation GPS Tracker ---
  const handleGetLocation = () => {
    if (!navigator.geolocation) {
      setGpsError('사용 중인 브라우저가 위치 공유 기능을 지원하지 않습니다.');
      return;
    }

    setGpsLoading(true);
    setGpsError(null);

    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setRealStart([latitude, longitude]);
        setMapCenter([latitude, longitude]);
        performReverseGeocode(latitude, longitude, 'start');
        setGpsLoading(false);
      },
      (err) => {
        console.error(err);
        setGpsLoading(false);
        setGpsError('위치 권한 사용이 거부되었습니다.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  };

  const activeComfortIndex = realShadePath?.shadeRatio ?? 0;

  const isSearchDisabled = 
    !realStart || !realStart[0] || !realStart[1] ||
    !realEnd || !realEnd[0] || !realEnd[1] ||
    loadingRoute ||
    (realStart[0] === realEnd[0] && realStart[1] === realEnd[1]);

  const formattedSimTime = useMemo(() => {
    const simTime = new Date(baseTime.getTime() + timeOffsetHours * 60 * 60 * 1000);
    return simTime.toLocaleTimeString('ko-KR', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    });
  }, [baseTime, timeOffsetHours]);

  return (
    <div className="h-screen w-screen relative overflow-hidden font-sans flex flex-col md:flex-row bg-slate-100 text-slate-800">
      
      {/* 1. MAP CANVAS BACKGROUND */}
      <div className="absolute inset-0 w-full h-full z-0">
        <MapContainer
          center={mapCenter}
          shadePath={realShadePath}
          shortestPath={realShortestPath}
          solar={realSolar}
          showShadows={showShadows}
          showBuildings={showBuildings}
          onMapClick={handleMapClick}
          startPoint={realStart}
          endPoint={realEnd}
          endPointName={endPointName}
          realBuildings={realBuildings}
          showDiagnostics={showDiagnostics}
        />
      </div>

      {/* 2. FLOATING LEFT PANEL: SEARCH & CONTROLS */}
      {sidebarOpen ? (
        <div className="absolute top-4 left-4 z-[1000] w-full max-w-[400px] md:w-[390px] bg-white/95 backdrop-blur-md shadow-2xl rounded-2xl border border-slate-100/80 flex flex-col max-h-[92vh] overflow-hidden pointer-events-auto transition-all duration-300 transform translate-x-0">
          
          {/* Top Brand Header bar */}
          <div className="p-4 border-b border-slate-100 bg-gradient-to-r from-emerald-500/5 to-teal-500/5 flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg bg-emerald-600 flex items-center justify-center text-white font-bold shadow-md shadow-emerald-600/20">
                🌲
              </div>
              <div>
                <h1 className="font-display font-extrabold text-slate-900 text-sm tracking-tight leading-none flex items-center gap-1">
                  <span>ShadePath Map</span>
                  <span className="text-[9px] font-semibold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 rounded">OSM Real</span>
                </h1>
                <p className="text-[10px] text-slate-400 mt-1">실시간 OpenStreetMap 보행 그늘 최적 경로 탐색</p>
              </div>
            </div>
            <button 
              onClick={() => setSidebarOpen(false)}
              className="p-1.5 hover:bg-slate-100 rounded-lg text-slate-400 hover:text-slate-600 transition-colors"
              title="사이드바 접기"
            >
              <ChevronDown className="w-4 h-4 rotate-90" />
            </button>
          </div>

          {/* Interactive Routing Location Forms */}
          <div className="p-4 bg-slate-50/50 border-b border-slate-100 flex flex-col gap-3 relative">
            
            {/* Dashed connector line */}
            <div className="absolute left-7 top-[42px] bottom-[42px] w-0.5 border-l-2 border-dashed border-slate-300"></div>

            {/* Start Location Search input */}
            <div className="flex items-center gap-3 relative pl-1">
              <div className="w-4 h-4 rounded-full bg-indigo-600 border-2 border-white shadow flex-shrink-0 z-10 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
              </div>
              <div className="grow relative">
                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">보행 출발 위치</span>
                <div className="flex gap-1.5 mt-0.5">
                  <input
                    type="text"
                    value={startSearchQuery}
                    onChange={(e) => setStartSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchGeocode(startSearchQuery, 'start')}
                    placeholder="출발지를 입력하세요..."
                    className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                  <button
                    onClick={() => searchGeocode(startSearchQuery, 'start')}
                    disabled={isSearchingStart}
                    className="bg-slate-800 hover:bg-slate-900 text-white text-[10px] px-2 py-1 rounded-lg font-bold"
                  >
                    검색
                  </button>
                </div>

                {/* Dropdown Results */}
                {startSearchResults.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-150 rounded-lg shadow-xl z-[1300] max-h-40 overflow-y-auto">
                    {startSearchResults.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setRealStart([r.lat, r.lng]);
                          setMapCenter([r.lat, r.lng]);
                          setStartSearchQuery(r.name);
                          setStartSearchResults([]);
                        }}
                        className="w-full text-left px-2.5 py-1.5 hover:bg-emerald-50 text-[10px] border-b border-slate-50 last:border-0"
                      >
                        <div className="font-bold text-slate-800">{r.name}</div>
                        <div className="text-slate-400 truncate">{r.displayName}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* End Location Search input */}
            <div className="flex items-center gap-3 relative pl-1">
              <div className="w-4 h-4 rounded-full bg-rose-600 border-2 border-white shadow flex-shrink-0 z-10 flex items-center justify-center">
                <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
              </div>
              <div className="grow relative">
                <span className="text-[9px] text-slate-400 font-bold uppercase tracking-wider block">도착 목적 위치</span>
                <div className="flex gap-1.5 mt-0.5">
                  <input
                    type="text"
                    value={endSearchQuery}
                    onChange={(e) => setEndSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && searchGeocode(endSearchQuery, 'end')}
                    placeholder="목적지를 입력하세요..."
                    className="w-full bg-white border border-slate-200 rounded-lg px-2 py-1 text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-emerald-500"
                  />
                  <button
                    onClick={() => searchGeocode(endSearchQuery, 'end')}
                    disabled={isSearchingEnd}
                    className="bg-slate-800 hover:bg-slate-900 text-white text-[10px] px-2 py-1 rounded-lg font-bold"
                  >
                    검색
                  </button>
                </div>

                {/* Dropdown Results */}
                {endSearchResults.length > 0 && (
                  <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-150 rounded-lg shadow-xl z-[1300] max-h-40 overflow-y-auto">
                    {endSearchResults.map((r, i) => (
                      <button
                        key={i}
                        onClick={() => {
                          setRealEnd([r.lat, r.lng]);
                          setMapCenter([r.lat, r.lng]);
                          setEndPointName(r.name);
                          setEndSearchQuery(r.name);
                          setEndSearchResults([]);
                        }}
                        className="w-full text-left px-2.5 py-1.5 hover:bg-emerald-50 text-[10px] border-b border-slate-50 last:border-0"
                      >
                        <div className="font-bold text-slate-800">{r.name}</div>
                        <div className="text-slate-400 truncate">{r.displayName}</div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Swap Button */}
            <button
              onClick={handleSwapPoints}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-2 bg-white hover:bg-slate-100 rounded-full border border-slate-200 shadow-sm text-slate-600 hover:text-emerald-600 transition-all active:scale-95 z-[10]"
              title="출발지-목적지 교환"
            >
              <ArrowUpDown className="w-3.5 h-3.5" />
            </button>

          </div>

          {/* 그늘길 찾기 Button (Explicit Manual Routing Request Button) */}
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-100">
            <button
              id="find-shade-route-btn"
              onClick={fetchShadeRoutes}
              disabled={isSearchDisabled}
              className={`w-full py-2.5 px-4 rounded-xl font-bold text-xs flex items-center justify-center gap-2 transition-all shadow-md ${
                isSearchDisabled
                  ? 'bg-slate-100 text-slate-400 cursor-not-allowed shadow-none border border-slate-200'
                  : 'bg-emerald-600 hover:bg-emerald-700 text-white shadow-emerald-600/10 active:scale-[0.98]'
              }`}
            >
              <Footprints className="w-4 h-4" />
              <span>그늘길 찾기</span>
            </button>
          </div>

          {/* Preset Center Selector */}
          <div className="px-4 py-3 bg-white border-b border-slate-50 flex flex-col gap-1.5 relative">
            <span className="text-slate-500 font-semibold text-[9px] tracking-wide uppercase">탐색 중심 프리셋</span>
            <div className="relative">
              <button
                onClick={() => setLandmarkDropdownOpen(!landmarkDropdownOpen)}
                className="w-full flex items-center justify-between px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-[11px] text-slate-700 font-semibold hover:border-slate-300 transition-all"
              >
                <span className="truncate flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                  {currentPreset.name}
                </span>
                <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
              </button>

              {landmarkDropdownOpen && (
                <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-150 rounded-xl shadow-xl z-[1200] overflow-hidden max-h-48 overflow-y-auto">
                  {LOCATION_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      onClick={() => {
                        setCurrentPreset(preset);
                        setLandmarkDropdownOpen(false);
                      }}
                      className={`w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5 border-b border-slate-100 last:border-0 ${
                        currentPreset.id === preset.id ? 'bg-emerald-50/50 font-bold' : ''
                      }`}
                    >
                      <span className="text-xs text-slate-800 font-bold">{preset.name}</span>
                      <span className="text-[9px] text-slate-400 truncate">{preset.description}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Scrollable controls wrapper */}
          <div className="overflow-y-auto p-4 flex-1 flex flex-col gap-4 max-h-[48vh]">
            
            {/* Status alerts for Loading, Warning, or Error */}
            {loadingRoute && (
              <div className="bg-emerald-50 border border-emerald-100 text-emerald-800 text-[11px] p-3 rounded-xl flex items-center justify-center gap-2 animate-pulse">
                <Activity className="w-4 h-4 animate-spin" />
                <span>OSM 경로 및 실시간 그림자 연산 중...</span>
              </div>
            )}

            {routeError && (
              <div className="bg-rose-50 border border-rose-100 text-rose-800 text-[11px] p-3 rounded-xl flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <div className="font-bold">탐색 분석 실패</div>
                  <div className="mt-0.5 text-rose-600 leading-normal">{routeError}</div>
                </div>
              </div>
            )}

            {/* Environmental factor controls */}
            <ControlPanel
              currentPreset={currentPreset}
              onPresetChange={setCurrentPreset}
              weatherCondition={weatherCondition}
              onWeatherChange={setWeatherCondition}
              timeOffsetHours={timeOffsetHours}
              onTimeOffsetChange={setTimeOffsetHours}
              showShadows={showShadows}
              setShowShadows={setShowShadows}
              showBuildings={showBuildings}
              setShowBuildings={setShowBuildings}
              showDiagnostics={showDiagnostics}
              setShowDiagnostics={setShowDiagnostics}
              baseTime={baseTime}
              onResetTime={() => setTimeOffsetHours(0)}
            />

            {/* Path details comparisons & step descriptions */}
            <div className="border-t border-slate-150 pt-3">
              <PathDetails
                shadePath={realShadePath}
                shortestPath={realShortestPath}
                selectedPathType={selectedPathType}
                setSelectedPathType={setSelectedPathType}
                endPointName={endPointName}
              />
            </div>

            {/* Diagnostics HUD status labels */}
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200 text-[10px] text-slate-500 flex flex-col gap-1.5 font-mono">
              <div className="font-bold border-b pb-1 mb-0.5 text-slate-600">📊 수집 통계 HUD</div>
              <div className="flex justify-between">
                <span>경로 수집처 (Routing):</span>
                <span className="font-bold text-slate-700 uppercase">{routingSource}</span>
              </div>
              <div className="flex justify-between">
                <span>건물 정보처 (OSM):</span>
                <span className="font-bold text-slate-700 uppercase">{buildingSource}</span>
              </div>
              <div className="flex justify-between">
                <span>분석 대상 건물 수 (Buildings):</span>
                <span className="font-bold text-slate-700">{buildingCount}개</span>
              </div>
              <div className="flex justify-between">
                <span>그림자 생성 개수 (Shadows):</span>
                <span className="font-bold text-emerald-600 font-bold">{shadowCount}개</span>
              </div>
              {degraded && (
                <div className="text-[9px] text-amber-600 font-sans mt-1 bg-amber-50 p-1.5 rounded border border-amber-200 leading-normal">
                  ⚠️ 경로 주변 정보 일부가 축소 투영 모드로 동작 중입니다.
                </div>
              )}
            </div>

          </div>

          {/* Footer */}
          <div className="p-3 bg-slate-50 border-t border-slate-100 text-center text-[9px] text-slate-400 font-sans mt-auto">
            ShadePath &copy; 2026. Data sourced from OpenStreetMap, Overpass API, and Nominatim.
          </div>

        </div>
      ) : (
        /* Expand button if closed */
        <button
          onClick={() => setSidebarOpen(true)}
          className="absolute top-4 left-4 z-[1000] p-3 bg-white/95 hover:bg-slate-50 text-slate-700 rounded-xl shadow-lg border border-slate-150 flex items-center justify-center pointer-events-auto transition-transform hover:scale-105 duration-200 animate-bounce"
          title="사이드바 열기"
        >
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-md bg-emerald-600 flex items-center justify-center text-white text-[10px]">🌲</span>
            <span className="text-xs font-bold text-emerald-800">탐색 패널 열기</span>
          </div>
        </button>
      )}

      {/* 3. FLOATING TOP RIGHT HUD STATUS COMPONENT */}
      <div className="absolute top-4 right-4 z-[1000] flex flex-col md:flex-row items-end md:items-center gap-2.5 pointer-events-auto">
        
        {/* Real-time comfort circle meter */}
        <div className="bg-white/95 backdrop-blur-md px-3.5 py-2.5 rounded-xl border border-slate-100/80 shadow-lg flex items-center gap-3">
          <div className="relative w-8 h-8 flex items-center justify-center">
            <svg className="absolute w-full h-full transform -rotate-90">
              <circle cx="16" cy="16" r="13" stroke="#f1f5f9" strokeWidth="3" fill="transparent" />
              <circle cx="16" cy="16" r="13" stroke="#10b981" strokeWidth="3" fill="transparent" 
                strokeDasharray={`${2 * Math.PI * 13}`}
                strokeDashoffset={`${2 * Math.PI * 13 * (1 - activeComfortIndex / 100)}`}
              />
            </svg>
            <span className="text-[10px] font-bold text-slate-800 font-mono mt-0.5">{activeComfortIndex}%</span>
          </div>
          <div>
            <span className="text-[9px] text-slate-400 block font-semibold leading-none">선택 경로 그늘 비율</span>
            <span className="text-xs font-extrabold text-slate-800 leading-tight">
              {activeComfortIndex > 70 ? '쾌적 등급: 최우수' : activeComfortIndex > 40 ? '쾌적 등급: 양호' : '보행주의: 뙤약볕'}
            </span>
          </div>
        </div>

        {/* GPS location finder */}
        <button
          onClick={handleGetLocation}
          disabled={gpsLoading}
          className="h-10 px-3.5 bg-white/95 backdrop-blur-md text-slate-700 hover:text-emerald-700 border border-slate-150 rounded-xl shadow-lg flex items-center gap-1.5 text-xs font-semibold transition-all active:scale-95 disabled:opacity-60"
          title="내 현재 위치 구역 수신"
        >
          <Navigation className={`w-4 h-4 text-emerald-600 ${gpsLoading ? 'animate-spin' : ''}`} />
          <span className="hidden sm:inline">{gpsLoading ? 'GPS 수신중' : '내 위치 조회'}</span>
        </button>

        {/* Layer configuration controllers */}
        <div className="flex bg-white/95 backdrop-blur-md p-1 border border-slate-150 rounded-xl shadow-lg gap-1">
          <button
            onClick={() => setShowShadows(!showShadows)}
            className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
              showShadows ? 'bg-slate-900 text-white' : 'text-slate-500'
            }`}
            title="그림자 표시"
          >
            그림자
          </button>
          <button
            onClick={() => setShowBuildings(!showBuildings)}
            className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
              showBuildings ? 'bg-slate-900 text-white' : 'text-slate-500'
            }`}
            title="건물 표시"
          >
            건물
          </button>
        </div>

      </div>

    </div>
  );
}
