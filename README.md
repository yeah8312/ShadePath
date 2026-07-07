# ShadePath: OSM Real-World Pedestrian Shade Routing

ShadePath는 대면적 열섬 현상과 폭염 시기 동안 보행자를 뜨거운 직사광선(뙤약볕)으로부터 보호하기 위해 실시간 태양 광학 궤적 계산과 실제 OpenStreetMap(OSM) 건물 높이 데이터를 융합하여 실시간 최적의 그늘길을 안내하는 차세대 풀스택 네비게이션 서비스입니다.

---

## 🚀 주요 특징 (Key Features)

1. **실제 데이터 기반 라우팅**: OpenStreetMap의 실제 건물 폴리곤 및 OSRM 보행 프로필 API를 사용하여 보행 가능 인도 후보 3종을 생성합니다.
2. **풀스택 프록시 캐시 설계**: Overpass API 부하를 감소시키고 로딩 속도를 향상하기 위해 바운딩 박스 기준 메모리 캐시 프록시를 서버에 구현하였습니다.
3. **위경도 기반 미터 투영 (Web Mercator EPSG:3857)**: 모든 기하 그림자 계산은 소수점 위경도의 왜곡을 극복하기 위해 물리 미터 단위로 투영하여 연산합니다.
4. **수학적 그림자 압출**: 태양 고도각(Altitude)과 방위각(Azimuth)을 실시간 천체 기하 공식으로 산출하고, 각 건물 풋프린트와 높이를 이용해 삼각함수 그림자 폴리곤을 입체적으로 투영합니다.
5. **5m 단위 정밀 샘플링**: 보행 경로를 5m 단위로 조밀하게 쪼개어 실시간 투영된 그림자 폴리곤에 속하는지 여부를 검사하여 그늘 비율을 오차 없이 계산합니다.
6. **가중치 기반 비용 계산**: 
   $$\text{Route Cost} = \text{Distance} + \text{Exposed Distance} \times \text{Heat Penalty}$$
   사용자가 최단 거리와 그늘막 선호도 가중치를 슬라이더로 조절할 수 있습니다.
7. **이중 모드 가동**: 개발자 및 가상 격자 테모 검증을 위해 `VITE_SIMULATION_MODE=true`일 때 동작하는 25x25 가상 그리드 모드를 격리 탑재하고 있습니다.

---

## 📂 데이터 출처 (Data Sources)

- **도로 및 지도 데이터**: [OpenStreetMap (OSM)](https://www.openstreetmap.org/)
- **건물 고도 및 외곽선**: [Overpass API](https://overpass-api.de/) (`way["building"]`)
- **도보 후보 경로 API**: [OSRM (Open Source Routing Machine)](https://router.project-osrm.org/) `foot` profile
- **주소지 역지오코딩**: [Nominatim OpenStreetMap](https://nominatim.openstreetmap.org/)

---

## ⚙️ API 키 설정 및 환경 변수

ShadePath는 외부 서비스의 인증 키가 브라우저에 직접 노출되는 것을 차단하기 위해 서버 측 Express 프록시를 거치도록 구축되었습니다.

`.env` 파일에 다음과 같이 구성합니다. (기본 설정 시 `.env.example` 복사 가능):

```env
# AI Studio 자동으로 런타임에 삽입해 주는 기본 주소 정보
APP_URL="http://localhost:3000"

# 가상 격자 데모 개발 모드 강제 여부 (기본값 false: 실제 OSM 기반 동작)
VITE_SIMULATION_MODE=false
```

---

## 🏃 실행 방법 (Execution)

### 1. 의존성 설치
```bash
npm install
```

### 2. 로컬 개발 서버 실행 (TypeScript tsx 엔진 연동)
```bash
npm run dev
```

### 3. 단위 테스트 실행 (검증용 패키지)
```bash
npm run test
```

### 4. 프로덕션 빌드 및 esbuild 서버 번들러 빌드
```bash
npm run build
```

---

## ⚠️ 데이터 정확도 한계 및 기술적 제약

1. **건물 높이(Height) 추정 오차**: OSM 기여자들이 건물 높이(`height`)나 층수(`building:levels`) 정보를 생략한 건물의 경우, 건물 유형(아파트: 15m, 빌딩: 18m 등)에 기초한 표준 기본값을 적용하여 계산하므로 실제 높이와 오차가 발생할 수 있습니다.
2. **지형 고도차 미반영**: 현재 3D 그림자 투영은 평면 지형을 가정하여 계산됩니다. 산악 지역이나 심한 비탈길에 위치한 건물 그림자는 지면 고도 차이에 의해 다소 비틀어질 수 있습니다.
3. **가로수/조경 음영 제약**: 실제 나무와 아케이드, 파라솔 차양막 시설물 등의 그늘은 고정된 OSM 건물 폴리곤에 기입되지 않아 수치 해석에서 배제됩니다. (격리된 가상 시뮬레이터 모드에서는 가로수 효과가 시뮬레이션 지원됩니다.)
