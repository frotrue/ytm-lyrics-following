# YTM Lyrics Following · v0.1.1

YouTube Music의 가사 탭에 LRCLIB 동기화 가사를 표시하는 WebExtension입니다. 현재 줄을 강조하고 중앙으로 자동 스크롤합니다. Firefox 우선이며 Chromium용 빌드도 생성합니다.

## 실행

Node.js 22 이상에서:

```sh
npm ci
npm run check
npm run lint:extension
```

### Firefox 142 이상

1. `npm run build`를 실행합니다.
2. Firefox에서 `about:debugging#/runtime/this-firefox`를 엽니다.
3. **임시 부가 기능 로드**를 누르고 `dist/firefox/manifest.json`을 선택합니다.
4. 로그인한 `https://music.youtube.com` 페이지를 새로고침하고 곡을 재생한 뒤 **가사** 탭을 엽니다.

임시 설치는 Firefox를 종료하면 해제됩니다. 코드를 수정한 뒤 다시 빌드하고 부가 기능을 새로고침한 다음 YouTube Music도 새로고침하세요. Firefox 일반 배포에는 별도 서명이 필요합니다.

### Chromium / Chrome 121 이상

`chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 `dist/chromium` 폴더를 선택합니다. 이미 열린 YouTube Music 페이지를 새로고침하세요.

## 동작

- 플레이어 바의 DOM에서 제목·아티스트·앨범을, HTMLMediaElement에서 길이와 재생 위치를 읽습니다.
- background가 LRCLIB를 조회합니다. 비공개 YouTube JS 객체나 내부 API는 사용하지 않습니다.
- 명확히 식별된 가사 영역에 Shadow DOM 패널을 넣고 원래 요소는 복원 가능하게 숨깁니다.
- 곡 전환·재생 위치 탐색·플레이어/가사 DOM 재생성을 처리합니다.
- 사용자가 가사를 스크롤하면 자동 스크롤을 잠시 멈춥니다.
- 가사 줄을 클릭하거나 키보드로 선택해 Enter/Space를 누르면 해당 시점으로 이동합니다. 재생 중이면 재생을 유지하고, 일시정지 중이면 정지 상태를 유지합니다.
- 커버와 가사가 나란히 보이는 화면에서는 가사 패널의 위쪽과 높이를 커버에 맞추고, 창 크기가 바뀌면 다시 맞춥니다. 좁은 화면에서는 기본 가사 탭 배치를 사용합니다.
- 동기화 가사가 없으면 일반 가사, 연주곡 안내 또는 결과 없음 안내를 표시합니다.
- 번역, 단어별 강조, 별도 창, 설정 화면은 포함하지 않습니다.

## 데이터와 권한

가사 조회 시 현재 곡의 제목, 아티스트, 가능한 경우 앨범과 곡 길이를 **https://lrclib.net**으로 전송합니다. 재생 위치, 계정 정보, 쿠키, 페이지 URL은 조회 데이터로 전송하지 않습니다. 네트워크 통신 자체에 수반되는 IP 주소는 LRCLIB에서 볼 수 있습니다. 결과는 확장 프로그램의 로컬 저장소에 캐시하며 별도 분석/추적 서비스는 없습니다.

YouTube Music에만 content script를 삽입하고, 외부 접근 권한은 LRCLIB에 한정합니다. `storage`는 조회 캐시용입니다. Firefox의 `websiteContent` 데이터 선언은 곡 메타데이터 전송을 나타냅니다.

## 개발 구조

```text
src/content.js           곡/미디어/패널 수명 주기와 비동기 결과 관리
src/content/adapter.js   YouTube Music DOM 선택자와 메타데이터 감지
src/content/panel.js     Shadow DOM 가사 화면과 자동 스크롤
src/shared/lyrics.js     LRC 파싱 및 현재 줄 검색
src/background.js        LRCLIB 요청, 결과 매칭, 캐시
scripts/build.mjs        Firefox/Chromium 번들 및 manifest 생성
tests/                   Node 테스트
```

Firefox는 background script, Chromium은 service worker를 사용합니다. 확장 실행 시 원격 코드를 내려받지 않으며, 개발 의존성은 번들에 포함하지 않습니다.

## 검증과 한계

자동 검증은 파싱·매칭·오류·캐시와 재현 DOM의 SPA 동작을 대상으로 합니다. 로그인된 실제 YouTube Music에서 가사 탭 DOM을 조사했고, 실제 LRCLIB 응답으로 패널 표시와 재생 위치에 따른 강조·스크롤을 확인했습니다. 이 페이지 검증은 빌드한 스크립트와 테스트용 메시징/네트워크 연결을 사용합니다. Firefox에서는 별도로 임시 확장 로드를 확인했습니다. **Firefox에 설치한 확장으로 로그인부터 실제 재생까지 수행하는 전체 검증은 아직 남아 있습니다.**

현재 검증 결과: 자동 테스트 24개 통과, Firefox 확장 검사 오류·경고 0개. 실제 페이지에서 Stay This Way(73줄) ↔ Love Me Back(53줄) 전환, 앞뒤 탐색, 실제 재생, 가사 탭 재진입, 현재 줄 중앙 정렬을 확인했습니다. v0.1.1에서는 마우스·Enter·Space 가사 이동, 재생/정지 상태 유지, 2560px·1280px 화면의 커버 정렬과 800px 화면의 세로 배치도 확인했습니다. 테스트 브라우저에 표시된 패널은 임시로 삽입한 것이므로 새로고침 후에도 쓰려면 위 설치 절차를 따라 확장을 로드해야 합니다.

YouTube의 DOM 변경이나 지역/계정별 화면 차이가 있으면 `src/content/adapter.js` 선택자 조정이 필요할 수 있습니다. 가사 패널을 확실하게 식별하지 못하면 원래 화면을 유지합니다. 기본 가사 탭 자체가 비활성화되어 접근할 수 없는 곡을 강제로 여는 기능은 v0.1 범위 밖입니다.

동일 제목의 라이브·리믹스·뮤직비디오 등은 길이가 달라 조회가 거절되거나 가사가 없을 수 있습니다. 잘못된 버전의 가사를 임의로 선택하지 않는 쪽을 우선합니다.

실제 계정에서 확인할 항목:

- 동기화 가사가 있는 곡의 현재 줄과 자동 스크롤
- 빠른 연속 곡 전환 시 이전 곡 가사가 뒤늦게 나타나지 않는지
- 앞으로/뒤로 탐색, 일시정지/재개
- 재생목록·관련 항목·가사 탭 전환 및 창 크기 변경
- 일반 가사만 있는 곡, 가사 없는 곡, LRCLIB 통신 실패

`npm run package`는 `artifacts/firefox`, `artifacts/chromium`에 서명되지 않은 ZIP을 생성합니다.

## 라이선스

이 프로젝트의 소스 코드는 [MIT License](LICENSE)로 배포합니다. LRCLIB에서 제공하는 가사와 YouTube Music의 이미지·콘텐츠는 이 소스 코드 라이선스의 대상이 아닙니다.
