/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { 
  Sun, Cloud, CloudRain, Shield, Navigation, Compass, Footprints, Info, MapPin, 
  ArrowUpDown, Layers, Sliders, Clock, ChevronDown, ChevronUp, Eye, 
  HelpCircle, Sparkles, Check, Play, Square, Activity, Cpu, Settings, X
} from 'lucide-react';
import { Landmark, WeatherCondition, WeatherState, GridCell, PathResult, SolarPosition } from './types';
import { calculateSolarPosition } from './utils/solar';
import { generateGrid, projectGridShadows } from './utils/mapping';
import { findPath, buildPathResult } from './utils/pathfinding';
import MapContainer from './components/MapContainer';
import { SIMULATED_LANDMARKS } from './components/ControlPanel';
import PathDetails from './components/PathDetails';
import PixelAnalyzer from './components/PixelAnalyzer';

export default function App() {
  // --- Mode State (Real-world OSM vs Simulation) ---
  const [isSimulationMode, setIsSimulationMode] = useState<boolean>(() => import.meta.env.VITE_SIMULATION_MODE === 'true');

  // --- Common States ---
  const [currentLandmark, setCurrentLandmark] = useState<Landmark>(SIMULATED_LANDMARKS[0]);
  const [weatherCondition, setWeatherCondition] = useState<WeatherCondition>('sunny');
  const [timeOffsetHours, setTimeOffsetHours] = useState<number>(0);
  const [selectedPathType, setSelectedPathType] = useState<'shade' | 'shortest'>('shade');
  const [shadeWeight, setShadeWeight] = useState<number>(50); // 0 to 100

  // --- Layer Visibility Options ---
  const [showShadows, setShowShadows] = useState<boolean>(true);
  const [showBuildings, setShowBuildings] = useState<boolean>(true);
  const [showGreenery, setShowGreenery] = useState<boolean>(true);
  const [showGridLines, setShowGridLines] = useState<boolean>(false);

  // --- UI Floating Panels state ---
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [showSpectrometer, setShowSpectrometer] = useState<boolean>(false);
  const [landmarkDropdownOpen, setLandmarkDropdownOpen] = useState<boolean>(false);
  const [endPointName, setEndPointName] = useState<string>('반월당 보행로 교차지점');

  // --- Real-world Coordinates States ---
  const [realStart, setRealStart] = useState<[number, number]>([SIMULATED_LANDMARKS[0].lat, SIMULATED_LANDMARKS[0].lng]);
  const [realEnd, setRealEnd] = useState<[number, number]>([
    SIMULATED_LANDMARKS[0].lat + 0.0012,
    SIMULATED_LANDMARKS[0].lng + 0.0016
  ]);
  const [realBuildings, setRealBuildings] = useState<any[]>([]);
  const [realSolar, setRealSolar] = useState<SolarPosition>({ elevation: 42, azimuth: 178, shadowLengthRatio: 1.1 });
  const [realShadePath, setRealShadePath] = useState<PathResult | null>(null);
  const [realShortestPath, setRealShortestPath] = useState<PathResult | null>(null);
  const [loadingRoute, setLoadingRoute] = useState<boolean>(false);

  // --- 25x25 Simulation Grid States ---
  const [startPoint, setStartPoint] = useState<{ x: number; y: number }>({ x: 3, y: 21 });
  const [endPoint, setEndPoint] = useState<{ x: number; y: number }>({ x: 21, y: 3 });

  // --- Geolocation State ---
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // --- System Base Time ---
  const [baseTime] = useState<Date>(() => new Date());

  // --- Synchronize coordinates on landmark selection ---
  useEffect(() => {
    setRealStart([currentLandmark.lat, currentLandmark.lng]);
    setRealEnd([currentLandmark.lat + 0.0012, currentLandmark.lng + 0.0016]);
    setStartPoint({ x: 3, y: 21 });
    setEndPoint({ x: 21, y: 3 });
  }, [currentLandmark]);

  // --- Weather details ---
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

  // --- 1. Compute Simulation Grid Map (Simulation Mode Only) ---
  const grid: GridCell[][] = useMemo(() => {
    return generateGrid(currentLandmark.lat, currentLandmark.lng, currentLandmark.gridTemplateType);
  }, [currentLandmark]);

  // --- 2. Calculate Simulation Solar Position ---
  const simulatedTime = useMemo(() => {
    return new Date(baseTime.getTime() + timeOffsetHours * 60 * 60 * 1000);
  }, [baseTime, timeOffsetHours]);

  const simSolarPosition = useMemo(() => {
    return calculateSolarPosition(currentLandmark.lat, currentLandmark.lng, simulatedTime);
  }, [currentLandmark, simulatedTime]);

  // Apply raycasting for procedural grid shadows
  useEffect(() => {
    if (!isSimulationMode) return;
    const isCloudyOrRainy = weatherCondition === 'cloudy' || weatherCondition === 'rainy';
    projectGridShadows(grid, simSolarPosition, isCloudyOrRainy);
  }, [grid, simSolarPosition, weatherCondition, isSimulationMode]);

  // Calculate procedural comfort index
  const simShadeComfortIndex = useMemo(() => {
    const walkableCells = grid.flat().filter(cell => cell.walkable && cell.buildingFactor < 0.2);
    if (walkableCells.length === 0) return 0;
    const shadedWalkableCells = walkableCells.filter(cell => cell.shadeScore >= 40);
    return Math.round((shadedWalkableCells.length / walkableCells.length) * 100);
  }, [grid, simSolarPosition, weatherCondition]);

  // Solve simulation path finding
  const simShadePath: PathResult | null = useMemo(() => {
    const p = findPath(grid, startPoint, endPoint, 'shade');
    return buildPathResult(p, 'shade');
  }, [grid, startPoint, endPoint, simSolarPosition, weatherCondition]);

  const simShortestPath: PathResult | null = useMemo(() => {
    const p = findPath(grid, startPoint, endPoint, 'shortest');
    return buildPathResult(p, 'shortest');
  }, [grid, startPoint, endPoint]);

  // --- 3. Real-world OSM Shade Route API Synchronizer ---
  useEffect(() => {
    if (isSimulationMode) return;

    setLoadingRoute(true);
    fetch('/api/shade-route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        start: { lat: realStart[0], lng: realStart[1] },
        end: { lat: realEnd[0], lng: realEnd[1] },
        timeOffsetHours,
        weatherCondition,
        shadeWeight
      })
    })
      .then(res => {
        if (!res.ok) throw new Error('Failed to compute shade routes');
        return res.json();
      })
      .then(data => {
        setRealSolar(data.solar);
        setRealBuildings(data.buildings || []);
        
        const shade = data.routes?.find((r: any) => r.type === 'shade') || data.routes?.[0] || null;
        const shortest = data.routes?.find((r: any) => r.type === 'shortest') || data.routes?.[1] || null;

        setRealShadePath(shade);
        setRealShortestPath(shortest);
        setLoadingRoute(false);
      })
      .catch(err => {
        console.error('API Error during real route sync:', err);
        setLoadingRoute(false);
      });
  }, [realStart, realEnd, timeOffsetHours, weatherCondition, shadeWeight, isSimulationMode]);

  // --- Real-world Reverse Geocoding Lookup ---
  useEffect(() => {
    if (isSimulationMode) return;

    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${realEnd[0]}&lon=${realEnd[1]}&zoom=18&addressdetails=1`;
    fetch(url, {
      headers: {
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'User-Agent': 'ShadePath-Pedestrian-Thermal-Map-Application'
      }
    })
      .then(res => res.json())
      .then(data => {
        if (data && data.display_name) {
          const addr = data.address;
          const name = addr.building || addr.amenity || addr.shop || addr.road || addr.suburb || addr.city || '선택한 보행로';
          setEndPointName(name);
        } else {
          setEndPointName(`WGS84 (${realEnd[0].toFixed(5)}, ${realEnd[1].toFixed(5)})`);
        }
      })
      .catch(() => {
        setEndPointName(`WGS84 (${realEnd[0].toFixed(5)}, ${realEnd[1].toFixed(5)})`);
      });
  }, [realEnd, isSimulationMode]);

  // --- Simulation reverse geocoding fallback ---
  useEffect(() => {
    if (!isSimulationMode) return;
    const targetCell = grid[endPoint.y]?.[endPoint.x];
    if (!targetCell) return;

    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${targetCell.lat}&lon=${targetCell.lng}&zoom=18&addressdetails=1`;
    fetch(url, {
      headers: {
        'Accept-Language': 'ko-KR,ko;q=0.9',
        'User-Agent': 'ShadePath-Pedestrian-Thermal-Map-Application'
      }
    })
      .then(res => res.json())
      .then(data => {
        if (data && data.display_name) {
          const addr = data.address;
          const name = addr.building || addr.amenity || addr.shop || addr.road || addr.suburb || addr.city || '선택한 가상 보행로';
          setEndPointName(name);
        } else {
          setEndPointName(`가상 구역 (X: ${endPoint.x}, Y: ${endPoint.y})`);
        }
      })
      .catch(() => {
        setEndPointName(`가상 구역 (X: ${endPoint.x}, Y: ${endPoint.y})`);
      });
  }, [endPoint, grid, isSimulationMode]);

  // --- Swap start and end points instantly ---
  const handleSwapPoints = () => {
    if (isSimulationMode) {
      const temp = startPoint;
      setStartPoint(endPoint);
      setEndPoint(temp);
    } else {
      const temp = realStart;
      setRealStart(realEnd);
      setRealEnd(temp);
    }
  };

  // --- Handle Map Interactive Clicks ---
  const handleMapClick = (lat: number, lng: number, type: 'start' | 'end') => {
    if (type === 'end') {
      setRealEnd([lat, lng]);
    } else {
      setRealStart([lat, lng]);
    }
  };

  const handleCellClick = (x: number, y: number, type: 'start' | 'end') => {
    grid[y][x].walkable = true;
    grid[y][x].buildingFactor = 0;
    if (type === 'start') {
      setStartPoint({ x, y });
    } else {
      setEndPoint({ x, y });
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
        const userLandmark: Landmark = {
          id: 'gps-user-location',
          name: '내 현재 위치 (GPS 수신)',
          lat: latitude,
          lng: longitude,
          description: '수신된 실제 보행 위치 주변의 실시간 그림자 분석',
          gridTemplateType: 'mixed'
        };

        setCurrentLandmark(userLandmark);
        setRealStart([latitude, longitude]);
        setRealEnd([latitude + 0.0012, longitude + 0.0016]);
        setGpsLoading(false);
      },
      (err) => {
        console.error(err);
        setGpsLoading(false);
        setGpsError('위치 권한 사용이 거부되었습니다. 중심 구역 대구시청으로 복원합니다.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  };

  // --- Unified Computed Props ---
  const activeShadePath = isSimulationMode ? simShadePath : realShadePath;
  const activeShortestPath = isSimulationMode ? simShortestPath : realShortestPath;
  const activeSolar = isSimulationMode ? simSolarPosition : realSolar;
  const activeComfortIndex = isSimulationMode ? simShadeComfortIndex : (realShadePath?.shadeRatio ?? 0);

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
      
      {/* 1. FULL VIEWPORT MAP LAYER */}
      <div className="absolute inset-0 w-full h-full z-0">
        <MapContainer
          center={[realStart[0], realStart[1]]}
          grid={grid}
          shadePath={activeShadePath}
          shortestPath={activeShortestPath}
          solar={activeSolar}
          showShadows={showShadows}
          showBuildings={showBuildings}
          showGreenery={showGreenery}
          showGridLines={showGridLines}
          onCellClick={handleCellClick}
          startPoint={startPoint}
          endPoint={endPoint}
          endPointName={endPointName}
          isSimulationMode={isSimulationMode}
          realStart={realStart}
          realEnd={realEnd}
          realBuildings={realBuildings}
          onMapClick={handleMapClick}
        />
      </div>

      {/* 2. FLOATING LEFT PANEL: NAVIGATION & CONTROLS */}
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
                <p className="text-[10px] text-slate-400 mt-1">실시간 OpenStreetMap 건물 그림자 분석 보행로</p>
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

          {/* Mode Switch Tab Selector */}
          <div className="grid grid-cols-2 bg-slate-50 border-b border-slate-100 p-1">
            <button
              onClick={() => {
                setIsSimulationMode(false);
                setShowSpectrometer(false);
              }}
              className={`py-2 text-[11px] font-bold rounded-lg transition-all ${
                !isSimulationMode
                  ? 'bg-white text-emerald-700 shadow-sm border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              🗺️ OSM 실제 보행 모드
            </button>
            <button
              onClick={() => setIsSimulationMode(true)}
              className={`py-2 text-[11px] font-bold rounded-lg transition-all ${
                isSimulationMode
                  ? 'bg-white text-emerald-700 shadow-sm border border-slate-200'
                  : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              🎮 25x25 격자 가상 모드
            </button>
          </div>

          {/* Tab Selection: Navigation vs Env Controller */}
          <div className="flex border-b border-slate-100 bg-slate-50/50">
            <button
              onClick={() => {}}
              className="flex-1 py-3 text-xs font-bold border-b-2 border-emerald-600 text-emerald-700 bg-white"
            >
              🧭 {isSimulationMode ? '가상 길찾기 안내' : '실시간 그늘길 탐색'}
            </button>
          </div>

          {/* Scrollable Content wrapper */}
          <div className="overflow-y-auto p-4 flex-1 flex flex-col gap-4 max-h-[55vh]">
            
            {/* Loading Indicator for Route Computation */}
            {loadingRoute && !isSimulationMode && (
              <div className="bg-emerald-50 border border-emerald-100 text-emerald-800 text-[11px] p-3 rounded-xl flex items-center justify-center gap-2 animate-pulse">
                <Activity className="w-4 h-4 animate-spin" />
                <span>OSM 경로 및 그림자 폴리곤 연산 중...</span>
              </div>
            )}

            {/* Google-Style Direction Coordinates Input Panel */}
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/60 relative flex flex-col gap-2.5">
              <div className="absolute left-6 top-8 bottom-8 w-0.5 border-l-2 border-dashed border-slate-300"></div>

              {/* Start Point Panel */}
              <div className="flex items-center gap-3 relative pl-1">
                <div className="w-4 h-4 rounded-full bg-blue-600 border-2 border-white shadow flex-shrink-0 z-10 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
                </div>
                <div className="grow flex flex-col">
                  <span className="text-[10px] text-slate-400 font-medium">보행 출발 위치</span>
                  <div className="text-xs font-bold text-slate-800 truncate mt-0.5">
                    {isSimulationMode 
                      ? `출발 지점 (Grid: ${startPoint.x}, ${startPoint.y})` 
                      : `내 위치 (${realStart[0].toFixed(4)}, ${realStart[1].toFixed(4)})`
                    }
                  </div>
                </div>
              </div>

              {/* End Point Panel */}
              <div className="flex items-center gap-3 relative pl-1">
                <div className="w-4 h-4 rounded-full bg-rose-600 border-2 border-white shadow flex-shrink-0 z-10 flex items-center justify-center">
                  <div className="w-1.5 h-1.5 rounded-full bg-white"></div>
                </div>
                <div className="grow flex flex-col">
                  <span className="text-[10px] text-slate-400 font-medium">도착지 지점</span>
                  <div className="text-xs font-bold text-slate-800 truncate mt-0.5" title={endPointName}>
                    {endPointName}
                  </div>
                </div>
              </div>

              {/* Instant Coordinate Swap Button */}
              <button
                onClick={handleSwapPoints}
                className="absolute right-3 top-1/2 -translate-y-1/2 p-2 bg-white hover:bg-slate-100 rounded-full border border-slate-200 shadow-sm text-slate-600 hover:text-emerald-600 transition-all active:scale-95"
                title="출발지-목적지 교환"
              >
                <ArrowUpDown className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Landmark Quick Selector */}
            <div className="flex flex-col gap-1.5 relative">
              <span className="text-slate-500 font-semibold text-[10px] tracking-wide uppercase">탐색 중심 구역 명소</span>
              <div className="relative">
                <button
                  onClick={() => setLandmarkDropdownOpen(!landmarkDropdownOpen)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs text-slate-700 font-semibold hover:border-slate-300 shadow-sm transition-all text-left"
                >
                  <span className="truncate flex items-center gap-1.5">
                    <MapPin className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                    {currentLandmark.name}
                  </span>
                  <ChevronDown className="w-4 h-4 text-slate-400" />
                </button>

                {landmarkDropdownOpen && (
                  <div className="absolute left-0 right-0 mt-1 bg-white border border-slate-150 rounded-xl shadow-xl z-[1200] overflow-hidden max-h-48 overflow-y-auto">
                    {SIMULATED_LANDMARKS.map((landmark) => (
                      <button
                        key={landmark.id}
                        onClick={() => {
                          setCurrentLandmark(landmark);
                          setLandmarkDropdownOpen(false);
                        }}
                        className={`w-full text-left px-3 py-2 hover:bg-slate-50 flex flex-col gap-0.5 border-b border-slate-100 last:border-0 ${
                          currentLandmark.id === landmark.id ? 'bg-emerald-50/50 font-bold' : ''
                        }`}
                      >
                        <span className="text-xs text-slate-800">{landmark.name}</span>
                        <span className="text-[9px] text-slate-400 truncate">{landmark.description}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Interactive Weight controls (Heat/Shade Importance Slider) */}
            <div className="bg-slate-50 p-3 rounded-xl border border-slate-200/60 flex flex-col gap-1.5">
              <div className="flex justify-between items-center text-[10px] text-slate-500 font-bold uppercase">
                <span>보행 선호 가중치 (거리 vs 그늘)</span>
                <span className="text-emerald-700 font-extrabold">{shadeWeight === 50 ? '균형 지점' : shadeWeight > 50 ? '그늘 우선' : '거리 우선'}</span>
              </div>
              <input
                type="range"
                min="0"
                max="100"
                step="5"
                value={shadeWeight}
                onChange={(e) => setShadeWeight(parseInt(e.target.value))}
                className="w-full accent-emerald-600 h-1 bg-slate-200 rounded-lg cursor-pointer mt-1"
              />
              <div className="flex justify-between text-[9px] text-slate-400 font-semibold font-mono">
                <span>⚡ 최단거리 중점</span>
                <span>{shadeWeight}% 그늘 가중</span>
                <span>🌲 시원한 그늘막 중점</span>
              </div>
            </div>

            {/* Weather condition toggles */}
            <div className="flex flex-col gap-1.5">
              <span className="text-slate-500 font-semibold text-[10px] uppercase tracking-wider">기상 및 일사 제어</span>
              <div className="grid grid-cols-3 gap-1.5 bg-slate-50 p-1 rounded-xl border border-slate-200">
                <button
                  onClick={() => setWeatherCondition('sunny')}
                  className={`flex items-center justify-center gap-1 py-1 text-[10px] font-semibold rounded-lg transition-all ${
                    weatherCondition === 'sunny'
                      ? 'bg-white text-amber-600 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Sun className="w-3 h-3" />
                  맑음/폭염
                </button>
                <button
                  onClick={() => setWeatherCondition('cloudy')}
                  className={`flex items-center justify-center gap-1 py-1 text-[10px] font-semibold rounded-lg transition-all ${
                    weatherCondition === 'cloudy'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <Cloud className="w-3 h-3" />
                  흐린 그늘
                </button>
                <button
                  onClick={() => setWeatherCondition('rainy')}
                  className={`flex items-center justify-center gap-1 py-1 text-[10px] font-semibold rounded-lg transition-all ${
                    weatherCondition === 'rainy'
                      ? 'bg-white text-indigo-600 shadow-sm'
                      : 'text-slate-500 hover:text-slate-800'
                  }`}
                >
                  <CloudRain className="w-3 h-3" />
                  강우 차양
                </button>
              </div>
            </div>

            {/* Time simulation slider */}
            <div className="flex flex-col gap-2 bg-slate-50 p-3 rounded-xl border border-slate-100">
              <div className="flex justify-between items-center">
                <span className="text-[10px] text-slate-500 font-bold uppercase tracking-wide">일사 시간 시뮬레이터</span>
                <button 
                  onClick={() => setTimeOffsetHours(0)}
                  className="text-[9px] text-emerald-600 hover:underline font-bold"
                >
                  실시간 동기화
                </button>
              </div>

              <div className="bg-slate-900 text-white p-2.5 rounded-lg flex items-center justify-between text-[11px]">
                <div>
                  <span className="text-[9px] text-slate-400 block">가상 시간</span>
                  <span className="font-mono font-bold text-emerald-400 text-xs">{formattedSimTime}</span>
                </div>
                <div className="text-right">
                  <span className="text-[9px] text-slate-400 block">태양 고도각</span>
                  <span className="font-mono text-xs">{activeSolar.elevation.toFixed(1)}°</span>
                </div>
              </div>

              <input
                type="range"
                min="-12"
                max="12"
                step="1"
                value={timeOffsetHours}
                onChange={(e) => setTimeOffsetHours(parseInt(e.target.value))}
                className="w-full accent-emerald-500 h-1 bg-slate-200 rounded-lg cursor-pointer mt-1"
              />
              <div className="flex justify-between text-[8px] font-mono text-slate-400">
                <span>-12h</span>
                <span className="text-emerald-600 font-bold">
                  {timeOffsetHours === 0 ? '실시간 태양 고도' : timeOffsetHours > 0 ? `+${timeOffsetHours}시간` : `${timeOffsetHours}시간`}
                </span>
                <span>+12h</span>
              </div>
            </div>

            {/* Route Selector and Step Guidance */}
            <div className="border-t border-slate-100 pt-3">
              <PathDetails
                shadePath={activeShadePath}
                shortestPath={activeShortestPath}
                selectedPathType={selectedPathType}
                setSelectedPathType={setSelectedPathType}
                endPointName={endPointName}
              />
            </div>

          </div>

          {/* Footer */}
          <div className="p-3 bg-slate-50 border-t border-slate-100 text-center text-[9px] text-slate-400 font-sans mt-auto">
            ShadePath &copy; 2026. Data sourced from OpenStreetMap & Overpass API.
          </div>

        </div>
      ) : (
        /* Expand button if closed */
        <button
          onClick={() => setSidebarOpen(true)}
          className="absolute top-4 left-4 z-[1000] p-3 bg-white/95 hover:bg-slate-50 text-slate-700 rounded-xl shadow-lg border border-slate-150 flex items-center justify-center pointer-events-auto transition-transform hover:scale-105 duration-200"
          title="사이드바 열기"
        >
          <div className="flex items-center gap-2">
            <span className="w-5 h-5 rounded-md bg-emerald-600 flex items-center justify-center text-white text-[10px]">🌲</span>
            <span className="text-xs font-bold">네비게이션 열기</span>
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
          {isSimulationMode && (
            <>
              <button
                onClick={() => setShowGreenery(!showGreenery)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
                  showGreenery ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                title="녹지 표시"
              >
                녹지
              </button>
              <button
                onClick={() => setShowGridLines(!showGridLines)}
                className={`px-2.5 py-1 text-[10px] font-bold rounded-lg transition-all ${
                  showGridLines ? 'bg-slate-900 text-white' : 'text-slate-500'
                }`}
                title="그리드선 표시"
              >
                그리드
              </button>
            </>
          )}
        </div>

        {/* Spectrometer toggle (Simulation mode only) */}
        {isSimulationMode && (
          <button
            onClick={() => setShowSpectrometer(!showSpectrometer)}
            className={`h-10 w-10 bg-white/95 backdrop-blur-md border rounded-xl shadow-lg flex items-center justify-center transition-all ${
              showSpectrometer 
                ? 'border-emerald-400 text-emerald-600 bg-emerald-50/20' 
                : 'border-slate-150 text-slate-600 hover:text-slate-800'
            }`}
            title="실시간 2D 타일 분광기 끄기/켜기"
          >
            <Activity className="w-4 h-4" />
          </button>
        )}

      </div>

      {/* 4. SPECTROMETER PANEL (Simulation mode only) */}
      {isSimulationMode && showSpectrometer && (
        <div className="absolute bottom-6 right-4 z-[1000] w-full max-w-[390px] pointer-events-auto transition-all duration-300 transform translate-y-0 hidden sm:block">
          <PixelAnalyzer
            landmark={currentLandmark}
            grid={grid}
          />
        </div>
      )}

    </div>
  );
}
