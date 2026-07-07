/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Search, Sun, Cloud, CloudRain, Clock, Layers, Sliders, MapPin } from 'lucide-react';
import { LocationPreset, WeatherCondition } from '../types';

export const LOCATION_PRESETS: LocationPreset[] = [
  {
    id: 'daegu-cityhall',
    name: '대구광역시청 동인동청사',
    lat: 35.8714,
    lng: 128.6014,
    description: '대구 도심의 밀집 건물 지대 (실제 빌딩 그늘 분석 최적)'
  },
  {
    id: 'gukchaebosang-park',
    name: '대구 국채보상운동기념공원',
    lat: 35.8698,
    lng: 128.6042,
    description: '대구 도심 공원 주변 (가로수 및 빌딩 그늘 복합 구역)'
  },
  {
    id: 'seoul-cityhall',
    name: '서울특별시청',
    lat: 37.5665,
    lng: 126.9780,
    description: '행정 상업 중심의 대도시 복합 구역'
  },
  {
    id: 'gyeongbokgung',
    name: '경복궁 광화문광장',
    lat: 37.5796,
    lng: 126.9770,
    description: '넓은 광장과 세종대로 빌딩가 구역'
  },
  {
    id: 'busan-cityhall',
    name: '부산광역시청',
    lat: 35.1798,
    lng: 129.0750,
    description: '부산 행정 타운 중심의 대형 도로 및 건물 지대'
  }
];

interface ControlPanelProps {
  currentPreset: LocationPreset;
  onPresetChange: (preset: LocationPreset) => void;
  weatherCondition: WeatherCondition;
  onWeatherChange: (condition: WeatherCondition) => void;
  timeOffsetHours: number; // -12 to +12
  onTimeOffsetChange: (offset: number) => void;
  showShadows: boolean;
  setShowShadows: (val: boolean) => void;
  showBuildings: boolean;
  setShowBuildings: (val: boolean) => void;
  showDiagnostics: boolean;
  setShowDiagnostics: (val: boolean) => void;
  baseTime: Date;
  onResetTime: () => void;
}

export default function ControlPanel({
  currentPreset,
  onPresetChange,
  weatherCondition,
  onWeatherChange,
  timeOffsetHours,
  onTimeOffsetChange,
  showShadows,
  setShowShadows,
  showBuildings,
  setShowBuildings,
  showDiagnostics,
  setShowDiagnostics,
  baseTime,
  onResetTime
}: ControlPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearchDropdown, setShowSearchDropdown] = useState(false);

  // Calculate simulated time
  const simTime = new Date(baseTime.getTime() + timeOffsetHours * 60 * 60 * 1000);
  const formattedSimTime = simTime.toLocaleTimeString('ko-KR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true
  });

  const filteredPresets = LOCATION_PRESETS.filter(preset =>
    preset.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col gap-6 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm w-full">
      {/* Title block */}
      <div className="flex items-center gap-2.5 border-b border-gray-50 pb-4">
        <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
          <Sliders className="w-5 h-5" />
        </div>
        <div>
          <h2 className="font-display font-semibold text-gray-800 text-lg leading-tight">ShadePath 분석 패널</h2>
          <p className="text-gray-400 text-xs mt-0.5">실시간 OSM 보행 경로 그늘 시뮬레이터</p>
        </div>
      </div>

      {/* 1. Destination Search */}
      <div className="flex flex-col gap-2 relative">
        <label className="text-gray-700 font-medium text-xs flex items-center gap-1.5">
          <MapPin className="w-3.5 h-3.5 text-emerald-600" />
          <span>추천 기준 프리셋 지역 선택</span>
        </label>
        <div className="relative">
          <input
            type="text"
            placeholder="프리셋 검색 (예: 대구시청, 서울시청...)"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setShowSearchDropdown(true);
            }}
            onFocus={() => setShowSearchDropdown(true)}
            className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-800 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition-all duration-200"
          />
          <Search className="w-4.5 h-4.5 text-gray-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
        </div>

        {/* Search Dropdown */}
        {showSearchDropdown && (
          <div className="absolute top-[100%] left-0 right-0 mt-2 bg-white border border-gray-100 rounded-xl shadow-xl z-[1100] overflow-hidden max-h-60 overflow-y-auto">
            {filteredPresets.length > 0 ? (
              filteredPresets.map((preset) => (
                <button
                  key={preset.id}
                  onClick={() => {
                    onPresetChange(preset);
                    setSearchQuery(preset.name);
                    setShowSearchDropdown(false);
                  }}
                  className={`w-full text-left px-4 py-3 hover:bg-emerald-50/50 flex flex-col gap-0.5 border-b border-gray-50 last:border-0 transition-colors duration-150 ${
                    currentPreset.id === preset.id ? 'bg-emerald-50/30 font-medium' : ''
                  }`}
                >
                  <span className="text-sm text-gray-800">{preset.name}</span>
                  <span className="text-[10px] text-gray-400">{preset.description}</span>
                </button>
              ))
            ) : (
              <div className="p-4 text-center text-xs text-gray-400">검색 결과가 없습니다.</div>
            )}
          </div>
        )}
        <p className="text-[10px] text-gray-400">현재 프리셋 위치: <span className="text-emerald-600 font-semibold">{currentPreset.description}</span></p>
      </div>

      {/* 2. Weather Modes */}
      <div className="flex flex-col gap-2">
        <label className="text-gray-700 font-medium text-xs flex items-center gap-1.5">
          <Sun className="w-3.5 h-3.5 text-amber-500" />
          <span>실시간 기상 및 기온 연계</span>
        </label>
        <div className="grid grid-cols-3 gap-2 bg-gray-50 p-1 rounded-xl border border-gray-150">
          <button
            onClick={() => onWeatherChange('sunny')}
            className={`flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-all duration-200 ${
              weatherCondition === 'sunny'
                ? 'bg-white text-amber-600 shadow-sm animate-pulse'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            <Sun className="w-3.5 h-3.5" />
            <span>맑음 (폭염)</span>
          </button>
          <button
            onClick={() => onWeatherChange('cloudy')}
            className={`flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-all duration-200 ${
              weatherCondition === 'cloudy'
                ? 'bg-white text-blue-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            <Cloud className="w-3.5 h-3.5" />
            <span>흐림 (일반)</span>
          </button>
          <button
            onClick={() => onWeatherChange('rainy')}
            className={`flex items-center justify-center gap-1.5 py-2 text-xs font-medium rounded-lg transition-all duration-200 ${
              weatherCondition === 'rainy'
                ? 'bg-white text-indigo-600 shadow-sm'
                : 'text-gray-500 hover:text-gray-800'
            }`}
          >
            <CloudRain className="w-3.5 h-3.5" />
            <span>비 (흐린날)</span>
          </button>
        </div>
      </div>

      {/* 3. Time Adjuster Slider */}
      <div className="flex flex-col gap-3 border-t border-b border-gray-50 py-4">
        <div className="flex justify-between items-center">
          <label className="text-gray-700 font-medium text-xs flex items-center gap-1.5">
            <Clock className="w-3.5 h-3.5 text-indigo-500" />
            <span>그림자 예측 시점 조절</span>
          </label>
          <button
            onClick={onResetTime}
            className="text-[10px] text-emerald-600 hover:underline font-medium"
          >
            현재 시간 복원
          </button>
        </div>
        
        {/* Time HUD */}
        <div className="bg-slate-900 text-white p-3 rounded-xl flex items-center justify-between shadow-inner">
          <div className="flex flex-col">
            <span className="text-[10px] text-slate-400">태양 일사 예측 시각</span>
            <span className="text-base font-bold tracking-tight font-display text-emerald-400">{formattedSimTime}</span>
          </div>
          <div className="text-right flex flex-col">
            <span className="text-[10px] text-slate-400">날짜</span>
            <span className="text-xs font-mono">{simTime.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}</span>
          </div>
        </div>

        {/* Time Offset Slider */}
        <div className="flex flex-col gap-1.5 mt-1">
          <input
            type="range"
            min="-12"
            max="12"
            step="1"
            value={timeOffsetHours}
            onChange={(e) => onTimeOffsetChange(parseInt(e.target.value))}
            className="w-full accent-emerald-500 h-1.5 bg-gray-200 rounded-lg cursor-pointer"
          />
          <div className="flex justify-between text-[10px] text-gray-400 font-mono px-0.5">
            <span>-12시간 전</span>
            <span className="font-semibold text-emerald-600">
              {timeOffsetHours === 0 ? '현재 시각' : timeOffsetHours > 0 ? `+${timeOffsetHours}시간 뒤` : `${timeOffsetHours}시간 전`}
            </span>
            <span>+12시간 뒤</span>
          </div>
        </div>
      </div>

      {/* 4. Layer Toggles */}
      <div className="flex flex-col gap-3">
        <span className="text-gray-700 font-medium text-xs flex items-center gap-1.5">
          <Layers className="w-3.5 h-3.5 text-emerald-600" />
          <span>지도 오버레이 시각화 옵션</span>
        </span>
        <div className="flex flex-col gap-2 bg-gray-50/50 p-3.5 rounded-xl border border-gray-100">
          
          {/* Shadows Toggle */}
          <label className="flex items-center justify-between cursor-pointer select-none">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-gray-700">실시간 건물 그림자 투영</span>
              <span className="text-[10px] text-gray-400">실제 태양 고도/방위를 이용한 그늘 투영</span>
            </div>
            <input
              type="checkbox"
              checked={showShadows}
              onChange={(e) => setShowShadows(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 relative"></div>
          </label>

          {/* Buildings Toggle */}
          <label className="flex items-center justify-between cursor-pointer select-none pt-2 border-t border-gray-100">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-gray-700">OSM 건물 폴리곤 표시</span>
              <span className="text-[10px] text-gray-400">실제 오버패스 빌딩의 실사 경계면 오버레이</span>
            </div>
            <input
              type="checkbox"
              checked={showBuildings}
              onChange={(e) => setShowBuildings(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 relative"></div>
          </label>

          {/* Diagnostics Toggle */}
          <label className="flex items-center justify-between cursor-pointer select-none pt-2 border-t border-gray-100">
            <div className="flex flex-col">
              <span className="text-xs font-medium text-gray-700">그늘 분석 진단 라벨 표시</span>
              <span className="text-[10px] text-gray-400">건물별 미터 높이와 높이 데이터 수집 신뢰도 표시</span>
            </div>
            <input
              type="checkbox"
              checked={showDiagnostics}
              onChange={(e) => setShowDiagnostics(e.target.checked)}
              className="sr-only peer"
            />
            <div className="w-9 h-5 bg-gray-200 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-emerald-500 relative"></div>
          </label>

        </div>
      </div>
    </div>
  );
}
