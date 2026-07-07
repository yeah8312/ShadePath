/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { Compass, Footprints, Flame, Timer, Sparkles, AlertTriangle, ChevronRight, Navigation } from 'lucide-react';
import { PathResult } from '../types';

interface PathDetailsProps {
  shadePath: PathResult | null;
  shortestPath: PathResult | null;
  selectedPathType: 'shade' | 'shortest';
  setSelectedPathType: (type: 'shade' | 'shortest') => void;
}

export default function PathDetails({
  shadePath,
  shortestPath,
  selectedPathType,
  setSelectedPathType
}: PathDetailsProps) {
  const [showSteps, setShowSteps] = useState(true);

  if (!shadePath || !shortestPath) {
    return (
      <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-sm flex items-center justify-center h-48">
        <p className="text-gray-400 text-sm">경로를 탐색하는 중입니다...</p>
      </div>
    );
  }

  // Active path details
  const activePath = selectedPathType === 'shade' ? shadePath : shortestPath;

  return (
    <div className="flex flex-col gap-5 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm w-full">
      
      {/* Header Block */}
      <div className="flex items-center justify-between border-b border-gray-50 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
            <Compass className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-display font-semibold text-gray-800 text-base leading-tight">경로 상세 비교 안내</h2>
            <p className="text-gray-400 text-xs mt-0.5">최적의 보행 환경을 선택하여 출발하세요</p>
          </div>
        </div>
        <button
          onClick={() => setShowSteps(!showSteps)}
          className="text-xs text-emerald-600 hover:underline font-medium flex items-center gap-1"
        >
          <span>{showSteps ? '상세경로 숨기기' : '상세경로 보기'}</span>
        </button>
      </div>

      {/* Comparative Paths (Shade vs Shortest) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        
        {/* Card 1: Shade Path Recommended (Emerald style) */}
        <div
          onClick={() => setSelectedPathType('shade')}
          className={`group flex flex-col gap-3.5 p-4 rounded-xl border cursor-pointer transition-all duration-300 relative overflow-hidden ${
            selectedPathType === 'shade'
              ? 'border-emerald-500 bg-emerald-50/20 shadow-md shadow-emerald-500/5 ring-1 ring-emerald-500/20'
              : 'border-gray-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/10'
          }`}
        >
          {/* Recommended badge */}
          <div className="absolute top-0 right-0 bg-emerald-500 text-white font-sans font-bold text-[9px] px-2.5 py-1 rounded-bl-lg tracking-wider flex items-center gap-1">
            <Sparkles className="w-2.5 h-2.5" />
            <span>쾌적 추천</span>
          </div>

          <div className="flex items-center gap-2">
            <span className="text-xl">🌲</span>
            <span className="font-display font-bold text-emerald-900 text-sm">그늘길 추천 코스</span>
          </div>

          <div className="flex items-baseline gap-1">
            <span className="font-display font-bold text-2xl text-emerald-600 font-mono">{shadePath.duration}</span>
            <span className="text-xs text-emerald-700 font-medium">분 소요</span>
            <span className="text-xs text-emerald-400 font-mono mx-1">|</span>
            <span className="text-xs text-emerald-700 font-semibold bg-emerald-100/50 px-2 py-0.5 rounded-full">
              그늘 비율 {shadePath.shadeRatio}%
            </span>
          </div>

          <div className="flex items-center justify-between border-t border-emerald-500/10 pt-3 text-[11px] text-gray-500">
            <div className="flex items-center gap-1">
              <Footprints className="w-3.5 h-3.5 text-emerald-600" />
              <span>{shadePath.distance}m</span>
            </div>
            <div className="flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 text-orange-500" />
              <span>소모 {shadePath.calories} kcal</span>
            </div>
            <div className="font-semibold text-emerald-600 flex items-center gap-0.5">
              <span>시원함!</span>
              <span>❄️</span>
            </div>
          </div>
        </div>

        {/* Card 2: Shortest Path (Red style) */}
        <div
          onClick={() => setSelectedPathType('shortest')}
          className={`flex flex-col gap-3.5 p-4 rounded-xl border cursor-pointer transition-all duration-300 relative overflow-hidden ${
            selectedPathType === 'shortest'
              ? 'border-rose-400 bg-rose-50/20 shadow-md shadow-rose-400/5 ring-1 ring-rose-400/20'
              : 'border-gray-200 bg-white hover:border-rose-200 hover:bg-rose-50/10'
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="text-xl">🥵</span>
            <span className="font-display font-bold text-gray-700 text-sm">뙤약볕 최단 경로</span>
          </div>

          <div className="flex items-baseline gap-1">
            <span className="font-display font-bold text-2xl text-rose-600 font-mono">{shortestPath.duration}</span>
            <span className="text-xs text-rose-700 font-medium">분 소요</span>
            <span className="text-xs text-rose-300 font-mono mx-1">|</span>
            <span className="text-xs text-rose-700 font-semibold bg-rose-100/50 px-2 py-0.5 rounded-full">
              그늘 비율 {shortestPath.shadeRatio}%
            </span>
          </div>

          <div className="flex items-center justify-between border-t border-rose-500/10 pt-3 text-[11px] text-gray-500">
            <div className="flex items-center gap-1">
              <Footprints className="w-3.5 h-3.5 text-rose-500" />
              <span>{shortestPath.distance}m</span>
            </div>
            <div className="flex items-center gap-1">
              <Flame className="w-3.5 h-3.5 text-amber-500" />
              <span>소모 {shortestPath.calories} kcal</span>
            </div>
            <div className="font-semibold text-rose-600 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" />
              <span>직사광선 주의</span>
            </div>
          </div>
        </div>

      </div>

      {/* 3. Detailed Steps Navigation */}
      {showSteps && (
        <div className="flex flex-col gap-3.5 bg-gray-50 p-4 rounded-xl border border-gray-100 transition-all duration-300">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-gray-700">
            <Navigation className="w-3.5 h-3.5 text-emerald-600 animate-pulse" />
            <span>선택 경로 안심 보행 가이드 ({activePath.name})</span>
          </div>

          <div className="flex flex-col gap-3">
            {activePath.steps.map((step, index) => {
              const isFirst = index === 0;
              const isLast = index === activePath.steps.length - 1;

              return (
                <div key={index} className="flex gap-3 text-xs leading-relaxed text-gray-600">
                  {/* Step Node */}
                  <div className="flex flex-col items-center">
                    <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center font-mono font-bold text-[9px] ${
                      isFirst
                        ? 'bg-emerald-500 border-white text-white shadow'
                        : isLast
                        ? 'bg-rose-500 border-white text-white shadow'
                        : 'bg-white border-gray-300 text-gray-500'
                    }`}>
                      {index + 1}
                    </div>
                    {!isLast && <div className="w-0.5 bg-gray-200 grow my-1"></div>}
                  </div>

                  {/* Step Description */}
                  <div className="pt-0.5">
                    <span className={`font-sans ${
                      isLast
                        ? 'font-bold text-gray-800'
                        : isFirst
                        ? 'font-semibold text-emerald-800'
                        : 'text-gray-600'
                    }`}>
                      {step}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Safety Info Footnote */}
      <div className="flex items-start gap-1.5 text-[10px] text-gray-400 bg-emerald-50/20 p-2.5 rounded-lg border border-emerald-500/5">
        <span className="text-emerald-500">🛡️</span>
        <p className="leading-normal">
          ShadePath는 지도의 2D 건물 색상을 실시간으로 분광 분석하여 그림자가 드리워진 지점을 수학적으로 시뮬레이션합니다. 현장 통행 환경과 신호 대기 상황에 따라 안전에 항상 주의하며 이동해 주세요.
        </p>
      </div>

    </div>
  );
}
