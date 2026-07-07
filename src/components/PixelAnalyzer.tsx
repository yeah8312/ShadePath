/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect, useRef } from 'react';
import { Cpu, Eye, RefreshCw, BarChart2, CheckCircle2 } from 'lucide-react';
import { GridCell, Landmark } from '../types';

interface PixelAnalyzerProps {
  landmark: Landmark;
  grid: GridCell[][];
}

export default function PixelAnalyzer({ landmark, grid }: PixelAnalyzerProps) {
  const [scanY, setScanY] = useState<number>(0);
  const [scannedCell, setScannedCell] = useState<GridCell | null>(null);
  const [scanning, setScanning] = useState<boolean>(true);
  const [stats, setStats] = useState({
    buildings: 0,
    greenery: 0,
    roads: 0,
    totalCells: 625 // 25 * 25
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Calculate stats on grid change
  useEffect(() => {
    let buildings = 0;
    let greenery = 0;
    let roads = 0;

    for (let y = 0; y < grid.length; y++) {
      for (let x = 0; x < grid[y].length; x++) {
        const cell = grid[y][x];
        if (cell.buildingFactor > 0.4) {
          buildings++;
        } else if (cell.greeneryFactor > 0.3) {
          greenery++;
        } else {
          roads++;
        }
      }
    }

    setStats({
      buildings,
      greenery,
      roads,
      totalCells: grid.length * (grid[0]?.length || 25)
    });
  }, [grid]);

  // Sweep animation effect
  useEffect(() => {
    if (!scanning) return;

    const interval = setInterval(() => {
      setScanY((prev) => {
        const nextY = (prev + 1) % 25;
        // Grab a cell from the current scan row for live telemetry display
        const randomX = Math.floor(Math.random() * 25);
        if (grid[nextY] && grid[nextY][randomX]) {
          setScannedCell(grid[nextY][randomX]);
        }
        return nextY;
      });
    }, 120);

    return () => clearInterval(interval);
  }, [scanning, grid]);

  // Render scan canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const cellSize = canvas.width / 25;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Draw the procedural grid pixels imitating the actual OpenStreetMap tile color spectrum
    for (let y = 0; y < 25; y++) {
      for (let x = 0; x < 25; x++) {
        const cell = grid[y][x];
        
        if (cell.buildingFactor > 0.4) {
          // OSM Building color: pale peach/orange beige #D9D0C9
          ctx.fillStyle = '#f2efe9';
          ctx.strokeStyle = '#d9d0c9';
        } else if (cell.greeneryFactor > 0.3) {
          // OSM Greenery color: soft forest green #C6E1A6
          ctx.fillStyle = '#c6e1a6';
          ctx.strokeStyle = '#b2db97';
        } else {
          // OSM Road color: clean white / pale gray #FFFFFF
          ctx.fillStyle = '#ffffff';
          ctx.strokeStyle = '#e6e6e6';
        }

        ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        ctx.strokeRect(x * cellSize, y * cellSize, cellSize, cellSize);

        // Render calculated shadow overlay
        if (cell.isShadowed && cell.shadowIntensity > 0) {
          ctx.fillStyle = `rgba(30, 41, 59, ${cell.shadowIntensity * 0.45})`;
          ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
        }
      }
    }

    // Draw scan line
    if (scanning) {
      ctx.fillStyle = 'rgba(16, 185, 129, 0.25)';
      ctx.fillRect(0, scanY * cellSize, canvas.width, cellSize);
      
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, scanY * cellSize + cellSize / 2);
      ctx.lineTo(canvas.width, scanY * cellSize + cellSize / 2);
      ctx.stroke();
    }
  }, [grid, scanY, scanning]);

  // Translate simulated pixel colors for HUD display
  const getSimulatedPixelInfo = () => {
    if (!scannedCell) return { hex: '#FFFFFF', r: 255, g: 255, b: 255, label: '보행자 길 (Roadway)' };

    if (scannedCell.buildingFactor > 0.4) {
      return {
        hex: '#F2EFE9',
        r: 242,
        g: 239,
        b: 233,
        label: '빌딩/장애물 구역 (Building)'
      };
    } else if (scannedCell.greeneryFactor > 0.3) {
      return {
        hex: '#C6E1A6',
        r: 198,
        g: 225,
        b: 166,
        label: '가로수길/녹지 공원 (Greenery)'
      };
    } else {
      return {
        hex: '#FFFFFF',
        r: 255,
        g: 255,
        b: 255,
        label: '보행 인도 (Walkway/Road)'
      };
    }
  };

  const pixelInfo = getSimulatedPixelInfo();

  return (
    <div className="flex flex-col gap-5 bg-white p-6 rounded-2xl border border-gray-100 shadow-sm w-full">
      {/* Title */}
      <div className="flex items-center justify-between border-b border-gray-50 pb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-emerald-50 text-emerald-600 rounded-xl">
            <Cpu className="w-5 h-5 animate-spin-slow" />
          </div>
          <div>
            <h3 className="font-display font-semibold text-gray-800 text-sm leading-tight">2D 지도 색상 기반 자동 분석기</h3>
            <p className="text-gray-400 text-[10px] mt-0.5">OSM 타일 픽셀 분광 분석 및 오차 극복</p>
          </div>
        </div>
        <button
          onClick={() => setScanning(!scanning)}
          className={`px-2.5 py-1 rounded-lg text-[10px] font-semibold flex items-center gap-1 transition-all ${
            scanning
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
          }`}
        >
          <RefreshCw className={`w-3 h-3 ${scanning ? 'animate-spin' : ''}`} />
          <span>{scanning ? '분석 중' : '일시정지'}</span>
        </button>
      </div>

      <div className="flex flex-col md:flex-row gap-5 items-center">
        {/* Interactive canvas */}
        <div className="relative w-44 h-44 border border-gray-200 rounded-xl overflow-hidden bg-slate-50 flex-shrink-0">
          <canvas ref={canvasRef} width={176} height={176} className="w-full h-full" />
          <div className="absolute top-1.5 left-1.5 bg-slate-900/80 backdrop-blur text-[8px] text-emerald-400 font-mono px-1.5 py-0.5 rounded uppercase tracking-wider">
            Live Scanner Feed
          </div>
        </div>

        {/* Telemetry metadata */}
        <div className="grow w-full flex flex-col gap-3 font-sans text-xs">
          <div className="bg-slate-950 text-emerald-400 p-3 rounded-xl font-mono text-[10px] flex flex-col gap-1.5 border border-slate-800/60">
            <div className="flex justify-between border-b border-slate-800 pb-1 text-slate-400">
              <span>SCAN TELEMETRY</span>
              <span className="text-emerald-500 font-bold animate-pulse">● ONLINE</span>
            </div>
            <div className="flex justify-between">
              <span>위치 (Grid Node):</span>
              <span className="text-white">X: {scannedCell?.x ?? 0}, Y: {scannedCell?.y ?? 0}</span>
            </div>
            <div className="flex justify-between">
              <span>스캔 RGB 값:</span>
              <span className="text-amber-400">rgb({pixelInfo.r}, {pixelInfo.g}, {pixelInfo.b})</span>
            </div>
            <div className="flex justify-between">
              <span>추출 매핑 결과:</span>
              <span className="text-white font-bold">{pixelInfo.label}</span>
            </div>
          </div>

          {/* Quick Stats list */}
          <div className="flex flex-col gap-1.5">
            <div className="flex justify-between text-[11px] text-gray-500 font-medium">
              <span>총 탐색 픽셀 영역:</span>
              <span className="font-mono text-gray-800">{stats.totalCells} (25x25)</span>
            </div>
            {/* Building percentage */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-[10px] text-gray-400">건물 (Building):</span>
              <div className="grow h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="bg-amber-400 h-full rounded-full transition-all duration-300"
                  style={{ width: `${(stats.buildings / stats.totalCells) * 100}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-[10px] text-gray-600">
                {Math.round((stats.buildings / stats.totalCells) * 100)}%
              </span>
            </div>
            {/* Greenery percentage */}
            <div className="flex items-center gap-2">
              <span className="w-16 text-[10px] text-gray-400">녹지 (Greenery):</span>
              <div className="grow h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div
                  className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                  style={{ width: `${(stats.greenery / stats.totalCells) * 100}%` }}
                />
              </div>
              <span className="w-8 text-right font-mono text-[10px] text-gray-600">
                {Math.round((stats.greenery / stats.totalCells) * 100)}%
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Auto calibration disclaimer info */}
      <div className="bg-gray-50 p-2.5 rounded-lg border border-gray-100 flex items-start gap-1.5 text-[10px] text-gray-500">
        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
        <p className="leading-snug">
          <b>색상 추출 보정 활성화</b>: OpenStreetMap의 표준 분광 데이터 세트인 건물(<code>#F2EFE9</code>), 녹지(<code>#C6E1A6</code>), 보도(<code>#FFFFFF</code>) 색상을 배경으로 픽셀 단위 2D 오차 보정 오버레이가 작동 중입니다.
        </p>
      </div>
    </div>
  );
}
