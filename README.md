# 강원 설악고등학교 신청 통합 시스템

상담신청프로그램 클론을 기반으로 전환한 React + Firebase 기반 동아리 신청 앱입니다.

## 주요 기능

- 학생/교사: 동아리 모집 조회, 신청/취소, 내 신청 현황 확인
- 관리자: 모집 등록/수정/삭제, 신청자 확인, 회원 권한 관리
- 관리자: 회원관리에서 회원 정보 수정/삭제/비밀번호 초기화
- 관리자: `회원계정_양식.xlsx` 업로드로 계정 일괄 생성
- 인증: Firestore `users` 컬렉션 기반 아이디/비밀번호 로그인
- 역할(Role): Firestore `users` 문서(`admin` / `teacher` / `student`)로 분리 관리

## 로그인 ID 설계

- 교사 아이디: 교사명(한글) 사용 가능
- 학생 아이디: 5자리 숫자 학번
- 학생 로그인: `학번 + 이름 + 비밀번호` 3개 입력(학번 혼동 방지)
- Firestore `users`에는 비밀번호 해시(`passwordHash`)와 이름/학번/권한 등 부가 정보를 저장합니다.

## 초기 관리자 계정

- 기본 계정: `admin / Seolak#2026!` (기본값)
- 앱 시작 시 기본 관리자 계정이 없으면 자동 생성됩니다.
- 기존 `admin / admin`으로 생성된 계정은 앱 시작 시 새 기본 비밀번호로 자동 마이그레이션됩니다.
- 운영 전에는 관리자 비밀번호를 즉시 변경해 사용하세요.

## 실행 방법

```bash
npm install
npm run dev
```

## 스크립트

```bash
npm run dev
npm run build
npm run preview
npm run lint
```

## 환경 변수

`.env.example`를 복사해 `.env`를 만들고 값을 설정합니다.

- `VITE_USE_FIREBASE`: `true`면 Firebase Firestore 사용, `false`면 데모 모드
- `VITE_AUTH_LOGIN_DOMAIN`: 내부 호환용 값(기본값: `seolak.local`)
- `VITE_DEFAULT_ADMIN_PASSWORD`: 기본 관리자 비밀번호(기본값: `Seolak#2026!`)
  - `.env`에 값을 직접 넣으면 앱 시작 시 관리자(`admin`) 비밀번호가 그 값으로 동기화됩니다.
- `VITE_FIREBASE_*`: Firebase 프로젝트 설정값

## Firebase 설정 체크리스트

1. Firestore Database 생성(Standard 권장)
2. 보안 규칙 배포

```bash
firebase deploy --only firestore:rules
```

- Cloud Functions/Firebase Auth를 사용하지 않으므로 Blaze 요금제 전환이 필수는 아닙니다.

## 주의

- 계정 일괄 생성은 관리자 권한으로 실행해야 합니다.
- 학생 계정은 `5자리 숫자 학번(loginId)`과 `이름`을 함께 넣어야 운영 시 식별이 편합니다.
- 현재 규칙은 Firestore-only 로그인 운영을 위해 전 컬렉션 접근을 허용합니다.
