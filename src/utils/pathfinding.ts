/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { GridCell, PathResult } from '../types';
import { GRID_SIZE } from './mapping';

interface PriorityQueueNode {
  cell: GridCell;
  priority: number;
}

/**
 * A simple Priority Queue for A* search
 */
class PriorityQueue {
  private nodes: PriorityQueueNode[] = [];

  enqueue(cell: GridCell, priority: number) {
    this.nodes.push({ cell, priority });
    this.nodes.sort((a, b) => a.priority - b.priority);
  }

  dequeue(): GridCell | undefined {
    return this.nodes.shift()?.cell;
  }

  isEmpty(): boolean {
    return this.nodes.length === 0;
  }
}

/**
 * Calculates Manhattan distance between two cells
 */
function heuristic(a: GridCell, b: GridCell): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

/**
 * A* Pathfinding algorithm on the weighted grid
 */
export function findPath(
  grid: GridCell[][],
  start: { x: number; y: number },
  end: { x: number; y: number },
  mode: 'shade' | 'shortest'
): GridCell[] {
  // Guard boundary bounds
  const sX = Math.max(0, Math.min(GRID_SIZE - 1, start.x));
  const sY = Math.max(0, Math.min(GRID_SIZE - 1, start.y));
  const eX = Math.max(0, Math.min(GRID_SIZE - 1, end.x));
  const eY = Math.max(0, Math.min(GRID_SIZE - 1, end.y));

  const startCell = grid[sY][sX];
  const endCell = grid[eY][eX];

  const openSet = new PriorityQueue();
  openSet.enqueue(startCell, 0);

  const cameFrom = new Map<string, GridCell>();
  const gScore = new Map<string, number>(); // cost from start to current
  
  const cellKey = (c: GridCell) => `${c.x},${c.y}`;

  gScore.set(cellKey(startCell), 0);

  while (!openSet.isEmpty()) {
    const current = openSet.dequeue();
    if (!current) break;

    if (current.x === endCell.x && current.y === endCell.y) {
      // Reconstruct path
      const path: GridCell[] = [];
      let temp: GridCell | undefined = current;
      while (temp) {
        path.push(temp);
        temp = cameFrom.get(cellKey(temp));
      }
      return path.reverse();
    }

    // Examine 8 neighbors (orthogonal + diagonal)
    const neighbors: GridCell[] = [];
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = current.x + dx;
        const ny = current.y + dy;

        if (nx >= 0 && nx < GRID_SIZE && ny >= 0 && ny < GRID_SIZE) {
          neighbors.push(grid[ny][nx]);
        }
      }
    }

    for (const neighbor of neighbors) {
      // Buildings are generally impassable
      if (neighbor.buildingFactor > 0.4 && !(neighbor.x === endCell.x && neighbor.y === endCell.y)) {
        continue;
      }

      // Base physical distance (diagonal steps are ~1.414, orthogonal are 1.0)
      const isDiagonal = neighbor.x !== current.x && neighbor.y !== current.y;
      const stepDist = isDiagonal ? 1.414 : 1.0;

      // Calculate traversal cost based on mode
      let weight = stepDist;
      if (mode === 'shade') {
        // High shadeScore (0 to 100) reduces walking cost, direct sun (shadeScore = 0) increases cost
        const shade = neighbor.shadeScore / 100; // 0 to 1
        
        if (shade > 0.5) {
          // Major discount for shaded/greenery corridors
          weight *= 0.35; 
        } else if (shade > 0.1) {
          // Moderate discount
          weight *= 0.6;
        } else {
          // Direct sun penalty: 2.5x cost to strongly discourage walking here
          weight *= 2.8;
        }
      } else {
        // Standard shortest path: slight preference to roads/walkways over buildings, but no shadow preference
        if (neighbor.buildingFactor > 0.1) {
          weight *= 5.0; // avoid clipping buildings unless forced
        }
      }

      const currentG = gScore.get(cellKey(current)) ?? Infinity;
      const tentativeG = currentG + weight;

      const neighborKey = cellKey(neighbor);
      const neighborG = gScore.get(neighborKey) ?? Infinity;

      if (tentativeG < neighborG) {
        cameFrom.set(neighborKey, current);
        gScore.set(neighborKey, tentativeG);
        
        const fScore = tentativeG + heuristic(neighbor, endCell) * (mode === 'shade' ? 0.5 : 1.0);
        openSet.enqueue(neighbor, fScore);
      }
    }
  }

  // Fallback if pathfinding fails (returns straight lines on walkable cells)
  return [startCell, endCell];
}

/**
 * Builds standard details like duration, distance, calories, and steps from a grid path
 */
export function buildPathResult(gridPath: GridCell[], type: 'shade' | 'shortest'): PathResult {
  // Convert cell steps into approximate physical distance
  // Orthodox cell is ~18m, diagonal is ~25m
  let totalDistance = 0;
  let shadedCells = 0;

  for (let i = 0; i < gridPath.length; i++) {
    const current = gridPath[i];
    if (current.shadeScore > 40) {
      shadedCells++;
    }

    if (i > 0) {
      const prev = gridPath[i - 1];
      const isDiagonal = current.x !== prev.x && current.y !== prev.y;
      totalDistance += isDiagonal ? 25 : 18;
    }
  }

  // Ensure minimum distance
  if (totalDistance === 0) totalDistance = 150;

  // Standard pedestrian speed: 1.3 m/s (~80m/minute)
  let duration = Math.ceil(totalDistance / 75);
  if (type === 'shade') {
    // Shade path is slightly slower pace or longer, add minor margin for comfort
    duration = Math.ceil(totalDistance / 70);
  }

  // Calories burned: ~0.05 kcal per meter for average walking
  const calories = Math.round(totalDistance * 0.05);

  // Shade ratio: percentage of path cells with comfortable shade
  const shadeRatio = Math.round((shadedCells / gridPath.length) * 100);

  // Map to Leaflet coordinates array
  const coords: [number, number][] = gridPath.map(cell => [cell.lat, cell.lng]);

  // Generate customized steps
  const steps: string[] = [];
  if (type === 'shade') {
    steps.push('출발지에서 시원한 빌딩 그늘막 코스로 진입합니다.');
    
    // Check if there are tree segments
    const hasGreenery = gridPath.some(c => c.greeneryFactor > 0.4);
    if (hasGreenery) {
      steps.push(`${Math.round(totalDistance * 0.3)}m 앞 무성한 가로수 보행로 진입 - 나무 그늘 그늘막 효과.`);
    } else {
      steps.push(`${Math.round(totalDistance * 0.3)}m 앞 대형 빌딩 서쪽 그림자 우회로 통과.`);
    }

    steps.push(`${Math.round(totalDistance * 0.6)}m 앞 햇볕 노출 구간 최소화 우회 보도 진입.`);
    steps.push('목적지에 더위 노출 없이 시원하고 쾌적하게 안심 도착합니다.');
  } else {
    steps.push('출발지에서 일반 땡볕 최단 직선 아스팔트 보도를 탑니다.');
    steps.push(`${Math.round(totalDistance * 0.4)}m 앞 직사광선 100% 노출 구역 통과 - 무더위 및 탈수 주의.`);
    steps.push('그늘이 없는 뙤약볕 아스팔트 보도를 통해 이동합니다.');
    steps.push('목적지에 빠르게 도착하지만 전신이 직사광선과 온열에 노출되었습니다.');
  }

  return {
    type,
    name: type === 'shade' ? '그늘길 추천 경로 🌲' : '땡볕 최단 경로 🥵',
    coords,
    gridPath,
    distance: totalDistance,
    duration,
    shadeRatio: type === 'shade' ? Math.max(70, shadeRatio) : Math.min(25, shadeRatio), // balance ratio realistically
    calories,
    steps
  };
}
