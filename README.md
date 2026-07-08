# ShadePath: OSM Real-World Pedestrian Shade Routing

ShadePath는 폭염과 도시 열섬 환경에서 보행자의 직사광선 노출을 줄이기 위해 실제 OpenStreetMap(OSM) 보행 경로, 실제 건물 폴리곤, 건물 높이 정보, 실시간 태양 위치 계산을 결합해 그늘이 많은 보행 경로를 추천하는 풀스택 웹 애플리케이션입니다.

---

## 주요 특징

1. **실제 지도 데이터 기반**: 가상 건물이나 가상 경로가 아니라 OSM, Overpass, OpenRouteService 데이터를 사용합니다.
2. **보행 후보 경로 생성**: OpenRouteService `foot-walking` 경로를 우선 사용하고, 장애 시 OSRM을 제한적으로 폴백합니다.
3. **과도한 우회 경로 방어**: OSRM 폴백 경로가 직선거리 대비 과도하게 길면 추천 결과로 사용하지 않습니다.
4. **실제 건물 그림자 계산**: OSM `building`, `building:part` Polygon/MultiPolygon과 높이 추정값을 이용해 그림자 폴리곤을 생성합니다.
5. **UTM 미터 좌표 연산**: 위경도 왜곡을 줄이기 위해 경로와 건물 기하 연산을 UTM 미터 좌표계에서 수행합니다.
6. **5m 단위 경로 샘플링**: 후보 경로를 5m 간격으로 샘플링해 각 지점이 그림자 안에 있는지 검사합니다.
7. **날씨 기반 경로 비용**: 사용자가 슬라이더로 가중치를 조절하지 않고, 맑음/흐림/비 상태에 따라 그늘 선호도를 자동 반영합니다.
8. **시연 안정화 프리셋**: 영남대 지하철 출구에서 영남대 IT관까지의 실제 ORS 경로 캐시를 포함해 ORS 장애 시에도 과도한 우회를 피합니다.

---

## 데이터 출처

- **지도 및 건물 데이터**: [OpenStreetMap](https://www.openstreetmap.org/)
- **건물 폴리곤 수집**: [Overpass API](https://overpass-api.de/) 및 폴백 인스턴스
- **보행 경로 API**: [OpenRouteService](https://openrouteservice.org/) `foot-walking`
- **보행 경로 폴백**: [OSRM](https://router.project-osrm.org/) `foot` profile
- **주소 검색 및 역지오코딩**: [Nominatim OpenStreetMap](https://nominatim.openstreetmap.org/)
- **태양 위치 계산**: [SunCalc](https://github.com/mourner/suncalc)

---

## 시스템 개요

```text
React + Leaflet UI
        |
        v
Express API Proxy
        |
        +-- OpenRouteService / OSRM: 보행 후보 경로
        +-- Overpass API: 실제 OSM 건물 Polygon/MultiPolygon
        +-- Nominatim: 주소 검색 및 역지오코딩
        |
        v
UTM projection + SunCalc + Turf.js
        |
        v
건물 그림자 계산 -> 경로 5m 샘플링 -> 그늘 비율/노출 거리/routeCost 산출
```

---

## 경로 추천 방식

각 후보 경로는 다음 기준으로 평가됩니다.

```text
Route Cost = Distance + Exposed Distance * Heat Penalty
```

날씨별 `Heat Penalty`는 서버에서 자동 결정합니다.

- **맑음**: 강한 그늘 우선
- **흐림**: 적당한 그늘 우선
- **비**: 그늘 선호를 거의 반영하지 않고 최단거리 중심

프런트엔드는 서버 응답의 라벨에만 의존하지 않고, `routeCost`가 가장 낮은 경로를 추천 그늘길로, `distance`가 가장 짧은 경로를 최단 경로로 표시합니다.

---

## 환경 변수

프로젝트 루트에 `.env` 파일을 생성합니다.

```env
ORS_API_KEY="YOUR_OPENROUTESERVICE_API_KEY"
OVERPASS_API_URL="https://overpass-api.de/api/interpreter"
PORT=3000
```

주의사항:

- `ORS_API_KEY`는 서버에서만 사용합니다.
- `VITE_ORS_API_KEY`처럼 브라우저에 노출되는 변수명으로 만들지 마세요.
- `.env`는 `.gitignore`에 포함되어 커밋되지 않습니다.

---

## 실행 방법

### 1. 의존성 설치

```bash
npm install
```

또는 lockfile 기준 설치:

```bash
npm ci
```

Windows PowerShell 실행 정책으로 `npm`이 막히면 다음처럼 실행할 수 있습니다.

```bash
npm.cmd install
npm.cmd run dev
```

### 2. 개발 서버 실행

```bash
npm run dev
```

기본 주소:

```text
http://localhost:3000
```

### 3. 테스트

```bash
npm run lint
npm run test
npm run build
```

---

## API 확인

```text
GET  /api/health
GET  /api/health/overpass
GET  /api/geocode?q=대구역
GET  /api/reverse-geocode?lat=35.8758&lng=128.5961
POST /api/shade-route
```

`/api/health` 응답에서 `orsConfigured: true`이면 `ORS_API_KEY`가 정상 로드된 상태입니다.

---

## 시연 프리셋

현재 시연용으로 다음 프리셋이 포함되어 있습니다.

- **영남대역 출구 -> 영남대 IT관**
- 출발: 영남대 지하철 출구
- 도착: 영남대 IT관 (`35.83062, 128.75434`)

OpenRouteService가 일시적으로 실패할 경우, 이 프리셋에 한해 실제 ORS 성공 응답에서 추출한 경로 캐시를 사용합니다. 건물 데이터와 그림자 계산은 여전히 실제 Overpass/OSM 데이터를 기반으로 수행합니다.

---

## 장애 대응

- Overpass는 여러 공개 엔드포인트를 순차 재시도합니다.
- Overpass 실패 시 HTML 성공처럼 표시하지 않고 JSON 오류를 반환합니다.
- OpenRouteService 장애 시 OSRM 폴백을 시도합니다.
- OSRM 폴백 경로가 과도하게 우회하면 결과로 사용하지 않습니다.
- 영남대 시연 프리셋은 ORS 장애 시 실제 경로 캐시를 사용해 시연 안정성을 높입니다.

---

## 기술적 한계

1. **건물 높이 누락**: OSM에 `height`, `building:levels`가 없으면 건물 유형 기반 추정값을 사용합니다.
2. **지형 고도 미반영**: 현재 그림자 계산은 평면 지형을 가정합니다.
3. **가로수/차양막 미반영**: 나무, 아케이드, 파라솔 등 비건물 그늘은 기본 계산에 포함되지 않습니다.
4. **외부 API 의존성**: ORS, Overpass, Nominatim 상태에 따라 응답 시간이 달라질 수 있습니다.
5. **실시간 기상 API 미연동**: 현재 맑음/흐림/비는 사용자가 선택하며, 실제 기상청 API와 자동 연동되지는 않았습니다.

---

## 개선 방향

- 프리셋별 ORS 경로와 Overpass 건물 데이터를 디스크 캐시로 사전 생성
- 실제 기상 API 연동으로 날씨와 기온 자동 반영
- 가로수, 지하보도, 아케이드, 차양막 데이터 반영
- 모바일 UI와 경로 비교 UX 개선
- 순수 계산 함수 모듈화 및 단위 테스트 강화
