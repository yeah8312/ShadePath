/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useMemo } from 'react';
import { Sun, Cloud, CloudRain, Shield, Navigation, Compass, Footprints, Info, MapPin } from 'lucide-react';
import { Landmark, WeatherCondition, WeatherState, GridCell, PathResult } from './types';
import { calculateSolarPosition } from './utils/solar';
import { generateGrid, projectGridShadows, GRID_SIZE } from './utils/mapping';
import { findPath, buildPathResult } from './utils/pathfinding';
import MapContainer from './components/MapContainer';
import ControlPanel, { SIMULATED_LANDMARKS } from './components/ControlPanel';
import PathDetails from './components/PathDetails';

export default function App() {
  // --- Standard States ---
  const [currentLandmark, setCurrentLandmark] = useState<Landmark>(SIMULATED_LANDMARKS[0]);
  const [weatherCondition, setWeatherCondition] = useState<WeatherCondition>('sunny');
  const [timeOffsetHours, setTimeOffsetHours] = useState<number>(0);
  const [selectedPathType, setSelectedPathType] = useState<'shade' | 'shortest'>('shade');

  // --- Layer Visibility Options ---
  const [showShadows, setShowShadows] = useState<boolean>(true);
  const [showBuildings, setShowBuildings] = useState<boolean>(true);
  const [showGreenery, setShowGreenery] = useState<boolean>(true);
  const [showGridLines, setShowGridLines] = useState<boolean>(false);

  // --- Start and End Nodes on 25x25 Grid ---
  // Start is bottom-left (3, 21), End is top-right (21, 3) to cross the map diagonally
  const [startPoint, setStartPoint] = useState<{ x: number; y: number }>({ x: 3, y: 21 });
  const [endPoint, setEndPoint] = useState<{ x: number; y: number }>({ x: 21, y: 3 });

  // --- Geolocation State ---
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [gpsError, setGpsError] = useState<string | null>(null);

  // --- System Base Time ---
  const [baseTime] = useState<Date>(() => new Date());

  // --- Weather details matching the weather state ---
  const weatherState: WeatherState = useMemo(() => {
    switch (weatherCondition) {
      case 'cloudy':
        return { temperature: 27, condition: 'cloudy', humidity: 65, uvIndex: 3 };
      case 'rainy':
        return { temperature: 24, condition: 'rainy', humidity: 85, uvIndex: 1 };
      case 'sunny':
      default:
        // Hot summer day in South Korea (July 7th)
        return { temperature: 33, condition: 'sunny', humidity: 55, uvIndex: 9 };
    }
  }, [weatherCondition]);

  // --- 1. Compute Grid Map based on Selected Landmark ---
  const grid: GridCell[][] = useMemo(() => {
    return generateGrid(currentLandmark.lat, currentLandmark.lng, currentLandmark.gridTemplateType);
  }, [currentLandmark]);

  // --- 2. Calculate Solar Angles based on Time Offset ---
  const simulatedTime = useMemo(() => {
    return new Date(baseTime.getTime() + timeOffsetHours * 60 * 60 * 1000);
  }, [baseTime, timeOffsetHours]);

  const solarPosition = useMemo(() => {
    return calculateSolarPosition(currentLandmark.lat, currentLandmark.lng, simulatedTime);
  }, [currentLandmark, simulatedTime]);

  // --- 3. Dynamic Ray-Cast Shadows Calculation ---
  // Modifies the grid cells' isShadowed and shadeScore values based on solar vectors
  useEffect(() => {
    const isCloudyOrRainy = weatherCondition === 'cloudy' || weatherCondition === 'rainy';
    projectGridShadows(grid, solarPosition, isCloudyOrRainy);
  }, [grid, solarPosition, weatherCondition]);

  // --- 4. Calculate Real-time "그늘 쾌적 지수" (Shade Comfort Index) ---
  // Calculates the ratio of shaded walkable cells over total walkable cells in the current grid
  const shadeComfortIndex = useMemo(() => {
    const walkableCells = grid.flat().filter(cell => cell.walkable && cell.buildingFactor < 0.2);
    if (walkableCells.length === 0) return 0;
    
    // Comfortable cells are those with shade score above 40 (comfortable buildings shade or canopy shade)
    const shadedWalkableCells = walkableCells.filter(cell => cell.shadeScore >= 40);
    return Math.round((shadedWalkableCells.length / walkableCells.length) * 100);
  }, [grid, solarPosition, weatherCondition]);

  // --- 5. A* Paths Calculation ---
  const shadePath: PathResult | null = useMemo(() => {
    const p = findPath(grid, startPoint, endPoint, 'shade');
    return buildPathResult(p, 'shade');
  }, [grid, startPoint, endPoint, solarPosition, weatherCondition]);

  const shortestPath: PathResult | null = useMemo(() => {
    const p = findPath(grid, startPoint, endPoint, 'shortest');
    return buildPathResult(p, 'shortest');
  }, [grid, startPoint, endPoint]);

  // --- Handler to set start or end point from clicks ---
  const handleCellClick = (x: number, y: number, type: 'start' | 'end') => {
    // Ensure nodes are walkable first to keep pathfinding flawless
    grid[y][x].walkable = true;
    grid[y][x].buildingFactor = 0;

    if (type === 'start') {
      setStartPoint({ x, y });
    } else {
      setEndPoint({ x, y });
    }
  };

  // --- Geolocation HTML5 Tracker (FN-01) ---
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
        
        // Create custom user location landmark
        const userLandmark: Landmark = {
          id: 'gps-user-location',
          name: '내 현재 위치 (GPS 수신)',
          lat: latitude,
          lng: longitude,
          description: '수신된 실제 보행 위치 주변의 실시간 그림자 시뮬레이션',
          gridTemplateType: 'mixed'
        };

        setCurrentLandmark(userLandmark);
        setGpsLoading(false);
      },
      (err) => {
        console.error(err);
        setGpsLoading(false);
        setGpsError('위치 권한 사용이 거부되었거나 신호가 약합니다. 기본 대구 청사로 시뮬레이션합니다.');
      },
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 }
    );
  };

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col text-slate-800">
      
      {/* 1. TOP HEADER STATUS BAR (상단 상태바 - [A]) */}
      <header className="bg-white border-b border-gray-100 shadow-sm sticky top-0 z-[2000] px-6 py-4">
        <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-center gap-4">
          
          {/* Logo & Service Brand */}
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-600 flex items-center justify-center text-white shadow-md shadow-emerald-600/10 transition-transform hover:scale-105 duration-200">
              <span className="text-xl">🌲</span>
            </div>
            <div>
              <h1 className="font-display font-bold text-gray-900 text-lg leading-tight flex items-center gap-1.5">
                <span>ShadePath</span>
                <span className="text-[10px] bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full font-sans font-semibold">그늘길 찾기 맵</span>
              </h1>
              <p className="text-gray-400 text-xs mt-0.5">뚜벅이를 위한 폭염 우회 및 빌딩 그늘막 도보 네비게이션</p>
            </div>
          </div>

          {/* Real-time comfort Index & Weather Badge (실시간 그늘 쾌적 지수 HUD) */}
          <div className="flex flex-wrap items-center gap-3">
            
            {/* GPS Trigger Button */}
            <button
              onClick={handleGetLocation}
              disabled={gpsLoading}
              className={`flex items-center gap-1.5 px-3 py-1.8 bg-gray-50 border border-gray-200 rounded-xl text-xs font-medium text-gray-600 transition-all hover:bg-emerald-50 hover:text-emerald-700 hover:border-emerald-200 ${
                gpsLoading ? 'animate-pulse pointer-events-none opacity-60' : ''
              }`}
            >
              <Navigation className="w-3.5 h-3.5 text-emerald-600" />
              <span>{gpsLoading ? 'GPS 수신 중...' : '내 위치 수신'}</span>
            </button>

            {/* Weather status indicator */}
            <div className="flex items-center gap-2 px-3 py-1.5 bg-gray-50 border border-gray-100 rounded-xl">
              {weatherCondition === 'sunny' && <Sun className="w-4 h-4 text-amber-500 animate-spin-slow" />}
              {weatherCondition === 'cloudy' && <Cloud className="w-4 h-4 text-blue-500" />}
              {weatherCondition === 'rainy' && <CloudRain className="w-4 h-4 text-indigo-500" />}
              <span className="text-xs font-semibold text-gray-700">
                {weatherState.temperature}°C ({weatherCondition === 'sunny' ? '맑음/폭염' : weatherCondition === 'cloudy' ? '흐림' : '비'})
              </span>
            </div>

            {/* Real-time Comfort Index Badge */}
            <div className="flex items-center gap-2 px-4 py-1.5 bg-emerald-500 text-white rounded-xl shadow-sm border border-emerald-400/20">
              <span className="text-xs font-sans font-bold leading-none">쾌적 지수</span>
              <span className="text-sm font-mono font-extrabold tracking-tight bg-white text-emerald-600 px-2 py-0.5 rounded-md leading-none">
                {shadeComfortIndex}%
              </span>
            </div>

          </div>
        </div>
      </header>

      {/* Main Workspace Frame */}
      <main className="grow max-w-7xl w-full mx-auto p-4 md:p-6 flex flex-col lg:flex-row gap-6">
        
        {/* LEFT COLUMN: Map View Container ([C]) */}
        <div className="flex-[7] min-h-[500px] lg:min-h-0 flex flex-col gap-4">
          
          {/* GPS error Banner if any */}
          {gpsError && (
            <div className="bg-rose-50 border border-rose-200 text-rose-800 text-xs px-4 py-3 rounded-xl flex items-center gap-2">
              <span>⚠️</span>
              <span>{gpsError}</span>
            </div>
          )}

          {/* Leaflet Map component */}
          <div className="w-full h-[520px] lg:h-[640px] rounded-2xl overflow-hidden shadow-sm relative">
            <MapContainer
              center={[currentLandmark.lat, currentLandmark.lng]}
              grid={grid}
              shadePath={shadePath}
              shortestPath={shortestPath}
              solar={solarPosition}
              showShadows={showShadows}
              showBuildings={showBuildings}
              showGreenery={showGreenery}
              showGridLines={showGridLines}
              onCellClick={handleCellClick}
              startPoint={startPoint}
              endPoint={endPoint}
            />
          </div>
        </div>

        {/* RIGHT COLUMN: Control Panel & Path Details List ([B], [D]) */}
        <div className="flex-[3] flex flex-col gap-6 max-h-none lg:max-h-[680px] overflow-y-auto pr-0 lg:pr-1">
          
          {/* Controls Panel */}
          <ControlPanel
            currentLandmark={currentLandmark}
            onLandmarkChange={(landmark) => {
              setCurrentLandmark(landmark);
              // reset start/end point on coordinates shift
              setStartPoint({ x: 3, y: 21 });
              setEndPoint({ x: 21, y: 3 });
            }}
            weatherCondition={weatherCondition}
            onWeatherChange={setWeatherCondition}
            timeOffsetHours={timeOffsetHours}
            onTimeOffsetChange={setTimeOffsetHours}
            showShadows={showShadows}
            setShowShadows={setShowShadows}
            showBuildings={showBuildings}
            setShowBuildings={setShowBuildings}
            showGreenery={showGreenery}
            setShowGreenery={setShowGreenery}
            showGridLines={showGridLines}
            setShowGridLines={setShowGridLines}
            baseTime={baseTime}
            onResetTime={() => setTimeOffsetHours(0)}
          />

          {/* Details & Comparisons Card panel */}
          <PathDetails
            shadePath={shadePath}
            shortestPath={shortestPath}
            selectedPathType={selectedPathType}
            setSelectedPathType={setSelectedPathType}
          />
        </div>

      </main>

      {/* Simple decorative premium footer */}
      <footer className="bg-white border-t border-gray-100 py-6 text-center text-xs text-gray-400 font-sans mt-auto">
        <p>&copy; 2026 ShadePath Map Project. Designed for pedestrian thermal wellness. Standard OSM Data.</p>
      </footer>
    </div>
  );
}
