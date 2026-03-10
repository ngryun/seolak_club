import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import {
  adminForceAssignStudentToClub,
  advanceRecruitmentRound,
  approveApplication,
  cancelStudentPreferenceDraft,
  directAssignStudentToClub,
  directSelectInterviewMember,
  finalizeCurrentCycleDraftsIfNeeded,
  getCurrentRecruitmentCycle,
  listCurrentCycleApplications,
  listCurrentCycleDrafts,
  getStudentPreferenceDraft,
  getSubmissionWindowState,
  getTeacherPreAssignmentWindowState,
  inferStudentGrade,
  listApplicationsBySchedule,
  listClubMembers,
  listStudentApplications,
  purgeLegacyRecruitmentData,
  randomSelectPending,
  rejectApplication,
  revokeApprovedApplication,
  saveStudentPreferenceDraft,
  syncLeaderAssignmentForClub,
  syncLeaderAssignmentsForClubs,
  updateRecruitmentPreAssignmentWindow,
  updateRecruitmentSubmissionWindow,
} from "../../services/applicationService";
import {
  applyToRequestCard,
  cancelRequestCardApplication,
  createRequestCard,
  deleteRequestCard,
  drawRequestCardWinners,
  getRequestCardState,
  listRequestCardApplicationsByApplicant,
  listRequestCardApplicationsByCard,
  listRequestCards,
  updateRequestCard,
} from "../../services/requestCardService";
import {
  canEditClub,
  canManageSelection,
  createClubRoom,
  createSchedule,
  deleteClubRoom,
  deleteSchedule,
  listClubRooms,
  listSchedules,
  updateSchedule,
} from "../../services/scheduleService";
import {
  createUserAccount,
  createUsersBatch,
  deleteUserByAdmin,
  downloadUserAccountTemplate,
  listUsers,
  parseUserAccountExcel,
  resetStudentPasswordsByAdmin,
  resetUserPasswordByAdmin,
  updateMyProfile,
  updateMyPassword,
  updateUserByAdmin,
} from "../../services/userService";

const t = {
  bg: "#f6f7fb",
  card: "#ffffff",
  border: "#dfe3ee",
  text: "#1c2431",
  textSub: "#5f6b7d",
  accent: "#1f6feb",
  accentHover: "#1559be",
  danger: "#c62828",
  ok: "#2e7d32",
  warn: "#c77700",
  muted: "#eef2f8",
  radius: 12,
  font: "'Pretendard Variable', 'Pretendard', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
};

const page = {
  minHeight: "100dvh",
  background: "linear-gradient(180deg, #f9fbff 0%, #f3f5fb 40%, #eef2f8 100%)",
  color: t.text,
  fontFamily: t.font,
};

const cardStyle = {
  background: t.card,
  border: `1px solid ${t.border}`,
  borderRadius: t.radius,
  padding: 16,
  boxShadow: "0 6px 20px rgba(9, 30, 66, 0.06)",
};

const inputBase = {
  width: "100%",
  border: `1px solid ${t.border}`,
  borderRadius: 10,
  padding: "10px 12px",
  fontSize: 14,
  outline: "none",
  background: "#fff",
  color: t.text,
};

const buttonBase = {
  border: "none",
  borderRadius: 10,
  padding: "9px 12px",
  fontSize: 13,
  cursor: "pointer",
};

const badgeStyle = {
  pending: { bg: "#fff8e1", color: t.warn, label: "대기" },
  waiting_round: { bg: "#f3f4f6", color: t.textSub, label: "다음 라운드 대기" },
  approved: { bg: "#e8f5e9", color: t.ok, label: "승인" },
  rejected: { bg: "#ffebee", color: t.danger, label: "반려" },
  cancelled: { bg: "#eceff1", color: "#4b5563", label: "취소" },
};

function roleLabel(role) {
  if (role === "admin") return "관리자";
  if (role === "teacher") return "교사";
  return "학생";
}

function rejectReasonLabel(value) {
  if (value === "manual") return "수동 반려";
  if (value === "random_unselected") return "무작위 선발 미선정";
  if (value === "higher_choice_assigned") return "다른 지망 배정";
  if (value === "final_round_closed") return "3라운드 종료 미배정";
  if (value === "round_ineligible") return "라운드 전환 시 신청 불가 처리";
  if (value === "approval_revoked") return "승인 취소";
  if (value === "leader_assigned") return "동아리장 자동 배정";
  if (value === "admin_force_assigned") return "관리자 강제 배정 이동";
  return "";
}

function selectionSourceLabel(value) {
  if (value === "approval") return "일반 승인";
  if (value === "random") return "무작위 선발";
  if (value === "manual_assign") return "수동 배정 승인";
  if (value === "interview_manual") return "직접 선발";
  if (value === "leader_auto") return "동아리장 자동 배정";
  if (value === "admin_force") return "관리자 강제 배정";
  return "";
}

function decisionLabel(row) {
  return rejectReasonLabel(row?.rejectReason)
    || String(row?.decisionNote || "").trim()
    || selectionSourceLabel(row?.selectionSource)
    || "-";
}

function submissionSourceLabel(value) {
  if (value === "application") return "확정 신청";
  if (value === "draft") return "제출본";
  return "미제출";
}

function buildStudentApplicationStatusRows(students, clubs, applications, drafts) {
  const studentRows = Array.isArray(students) ? students : [];
  const clubMap = new Map((Array.isArray(clubs) ? clubs : []).map((club) => [club.id, club]));
  const appsByStudent = new Map();
  const draftByStudent = new Map();

  (Array.isArray(applications) ? applications : []).forEach((row) => {
    if (!appsByStudent.has(row.studentUid)) {
      appsByStudent.set(row.studentUid, []);
    }
    appsByStudent.get(row.studentUid).push(row);
  });

  (Array.isArray(drafts) ? drafts : []).forEach((row) => {
    draftByStudent.set(row.studentUid, row);
  });

  return [...studentRows]
    .sort((a, b) => String(a.studentNo || a.loginId || "").localeCompare(String(b.studentNo || b.loginId || ""), "ko"))
    .map((student) => {
      const apps = [...(appsByStudent.get(student.uid) || [])].sort(
        (a, b) => Number(a.preferenceRank || 0) - Number(b.preferenceRank || 0),
      );
      const draft = draftByStudent.get(student.uid) || null;
      const sourceType = apps.length > 0 ? "application" : draft ? "draft" : "none";
      const sourceRows = apps.length > 0 ? apps : (draft?.preferences || []);
      const preferences = [1, 2, 3].map((rank) => {
        const source = sourceRows.find((row) => Number(row.preferenceRank || 0) === rank) || null;
        const club = source ? clubMap.get(source.clubId) : null;
        return {
          preferenceRank: rank,
          clubId: source?.clubId || "",
          clubName: club?.clubName || source?.clubId || "",
          status: apps.length > 0 ? source?.status || "" : "",
          rejectReason: apps.length > 0 ? source?.rejectReason || "" : "",
          selectionSource: apps.length > 0 ? source?.selectionSource || "" : "",
          decisionNote: apps.length > 0 ? source?.decisionNote || "" : "",
          careerGoal: source?.careerGoal || "",
          applyReason: source?.applyReason || "",
          wantedActivity: source?.wantedActivity || "",
          updatedAt: source?.updatedAt || source?.submittedAt || null,
        };
      });
      const approved = apps.find((row) => row.status === "approved") || null;
      const approvedClub = approved ? clubMap.get(approved.clubId) : null;
      return {
        studentUid: student.uid,
        studentNo: student.studentNo || student.loginId || "",
        studentName: student.name || "",
        sourceType,
        submittedAt: draft?.submittedAt || apps[0]?.createdAt || null,
        updatedAt: draft?.updatedAt || apps[0]?.updatedAt || null,
        finalClubId: approved?.clubId || "",
        finalClubName: approvedClub?.clubName || approved?.clubId || "",
        preferences,
      };
    });
}

function formatTime(value) {
  if (!value) return "-";
  const toDate = typeof value?.toDate === "function" ? value.toDate() : null;
  const fromSeconds = typeof value?.seconds === "number" ? new Date(value.seconds * 1000) : null;
  const parsed = new Date(value);
  const date = toDate || fromSeconds || (Number.isNaN(parsed.getTime()) ? null : parsed);
  if (!date) return "-";
  return date.toLocaleString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function toDatetimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const pad = (num) => String(num).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function createPreferenceRows(source = []) {
  return Array.from({ length: 3 }, (_, index) => {
    const row = source[index] || {};
    return {
      clubId: row.clubId || "",
      careerGoal: row.careerGoal || "",
      applyReason: row.applyReason || "",
      wantedActivity: row.wantedActivity || "",
    };
  });
}

function submissionPhaseLabel(state) {
  if (!state?.configured) return "미설정";
  if (state.phase === "before") return "신청 전";
  if (state.phase === "open") return "신청 중";
  if (state.phase === "closed" && state.needsFinalization) return "마감 후 확정 대기";
  if (state.phase === "closed") return "선발 가능";
  return "-";
}

function submissionPhaseDescription(state) {
  if (!state?.configured) {
    return "관리자가 아직 학생 신청 기간을 설정하지 않았습니다.";
  }
  if (state.phase === "before") {
    return `신청 시작 전입니다. ${formatTime(state.startAt)}부터 제출할 수 있습니다.`;
  }
  if (state.phase === "open") {
    return `신청 기간입니다. ${formatTime(state.endAt)}까지 제출·수정·취소할 수 있습니다.`;
  }
  if (state.phase === "closed" && state.needsFinalization) {
    return "신청 기간이 끝났습니다. 제출본을 확정하는 중입니다.";
  }
  if (state.phase === "closed") {
    return "신청 기간이 종료되어 학생 입력은 잠겨 있고 선발 단계만 진행할 수 있습니다.";
  }
  return "";
}

function preAssignmentPhaseLabel(state) {
  if (!state?.configured) return "미설정";
  if (state.phase === "before") return "시작 전";
  if (state.phase === "open") return "진행 중";
  if (state.phase === "closed") return "종료";
  return "-";
}

function preAssignmentPhaseDescription(state) {
  if (!state?.configured) {
    return "관리자가 아직 교사 사전 학생 배정 기간을 설정하지 않았습니다.";
  }
  if (state.phase === "before") {
    return `교사 사전 학생 배정 시작 전입니다. ${formatTime(state.startAt)}부터 직접 선발과 수동 배정을 진행할 수 있습니다.`;
  }
  if (state.phase === "open") {
    return `교사 사전 학생 배정 기간입니다. ${formatTime(state.endAt)}까지 직접 선발과 수동 배정을 진행할 수 있습니다.`;
  }
  if (state.phase === "closed") {
    return "교사 사전 학생 배정 기간이 종료되었습니다.";
  }
  return "";
}

function requestCardTargetLabel(value) {
  if (value === "student") return "학생 대상";
  if (value === "teacher") return "교사 대상";
  return "-";
}

function requestCardPhaseMeta(state) {
  if (state?.phase === "open") {
    return { label: "신청 중", bg: "#eef7ee", border: "#cbe6cd", color: t.ok };
  }
  if (state?.phase === "before") {
    return { label: "시작 전", bg: "#fff8e1", border: "#f3dfb9", color: t.warn };
  }
  if (state?.phase === "closed") {
    return { label: "추첨 대기", bg: "#edf4ff", border: "#c8dcff", color: t.accent };
  }
  if (state?.phase === "drawn") {
    return { label: "추첨 완료", bg: "#f3f4f6", border: "#d6dae3", color: t.textSub };
  }
  return { label: "미설정", bg: "#f3f4f6", border: "#d6dae3", color: t.textSub };
}

function requestCardResultMeta(status) {
  if (status === "selected") {
    return { label: "당첨", bg: "#e8f5e9", color: t.ok };
  }
  if (status === "not_selected") {
    return { label: "미당첨", bg: "#ffebee", color: t.danger };
  }
  if (status === "applied") {
    return { label: "신청 완료", bg: "#edf4ff", color: t.accent };
  }
  return { label: "-", bg: "#f3f4f6", color: t.textSub };
}

function requestCardPhaseDescription(card, state) {
  if (!state?.configured) {
    return "신청 기간이 아직 설정되지 않았습니다.";
  }
  if (state.phase === "before") {
    return `신청 시작: ${formatTime(card.startAt)}`;
  }
  if (state.phase === "open") {
    return `신청 마감: ${formatTime(card.endAt)}`;
  }
  if (state.phase === "closed") {
    return "신청 기간이 종료되어 관리자의 랜덤 추첨을 기다리는 중입니다.";
  }
  if (state.phase === "drawn") {
    return `추첨 완료: ${formatTime(card.drawExecutedAt)}`;
  }
  return "";
}

function canUseRequestCard(card, user) {
  const normalizedRole = user?.role === "admin" ? "teacher" : user?.role;
  return card?.targetRole === normalizedRole;
}

function MessageBar({ message, onClose }) {
  if (!message?.text) return null;
  const colors = {
    ok: { bg: "#e8f5e9", border: "#b7dfbb", color: t.ok },
    error: { bg: "#ffebee", border: "#f2b8be", color: t.danger },
    info: { bg: "#e8f1fe", border: "#b6d1fb", color: t.accent },
  };
  const palette = colors[message.type] || colors.info;

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        width: "min(720px, calc(100vw - 32px))",
        zIndex: 2000,
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          ...cardStyle,
          background: palette.bg,
          borderColor: palette.border,
          color: palette.color,
          padding: "10px 12px",
          pointerEvents: "auto",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>{message.text}</span>
          <button
            onClick={onClose}
            style={{ ...buttonBase, background: "transparent", color: palette.color, padding: "4px 8px" }}
          >
            닫기
          </button>
        </div>
      </div>
    </div>
  );
}

function LoginPanel({ onLogin, loading, error }) {
  const [tab, setTab] = useState("teacher");
  const [loginId, setLoginId] = useState("");
  const [studentName, setStudentName] = useState("");
  const [password, setPassword] = useState("");

  return (
    <div style={{ ...page, display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ width: "min(460px, 100%)", ...cardStyle, padding: 24 }}>
        <h1 style={{ fontSize: 24, marginBottom: 6 }}>강원 설악고등학교 신청 통합 시스템</h1>
        <p style={{ fontSize: 13, color: t.textSub, marginBottom: 18 }}>
          교사/학생 탭을 선택해 로그인하세요.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 14 }}>
          {["teacher", "student"].map((mode) => {
            const active = tab === mode;
            return (
              <button
                key={mode}
                onClick={() => setTab(mode)}
                style={{
                  ...buttonBase,
                  background: active ? t.accent : "#fff",
                  color: active ? "#fff" : t.text,
                  border: `1px solid ${active ? t.accent : t.border}`,
                  fontWeight: 700,
                }}
              >
                {mode === "teacher" ? "교사/관리자" : "학생"}
              </button>
            );
          })}
        </div>

        <div style={{ display: "grid", gap: 10 }}>
          <div>
            <div style={{ fontSize: 12, color: t.textSub, marginBottom: 4 }}>
              {tab === "teacher" ? "아이디(교사명 또는 admin)" : "아이디(학번 5자리 숫자)"}
            </div>
            <input
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              style={inputBase}
              placeholder={tab === "teacher" ? "예: 김교사" : "예: 20912"}
            />
          </div>

          {tab === "student" && (
            <div>
              <div style={{ fontSize: 12, color: t.textSub, marginBottom: 4 }}>이름</div>
              <input
                value={studentName}
                onChange={(e) => setStudentName(e.target.value)}
                style={inputBase}
                placeholder="예: 홍길동"
              />
            </div>
          )}

          <div>
            <div style={{ fontSize: 12, color: t.textSub, marginBottom: 4 }}>비밀번호</div>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              style={inputBase}
              placeholder="비밀번호"
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  onLogin({ loginId, password, tab, studentName });
                }
              }}
            />
          </div>

          {error ? <div style={{ fontSize: 12, color: t.danger }}>{error}</div> : null}

          <button
            onClick={() => onLogin({ loginId, password, tab, studentName })}
            disabled={loading}
            style={{
              ...buttonBase,
              background: loading ? "#c7d2e8" : t.accent,
              color: "#fff",
              fontWeight: 700,
              padding: "10px 12px",
            }}
          >
            {loading ? "로그인 중..." : "로그인"}
          </button>

          <div style={{ fontSize: 12, color: t.textSub, lineHeight: 1.5 }}>
            학생은 학번(5자리 숫자, 예: 20912) + 이름 + 비밀번호를 입력해야 로그인됩니다.
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, hint }) {
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ fontSize: 12, color: t.textSub, fontWeight: 600 }}>{label}</div>
      {children}
      {hint ? <div style={{ fontSize: 11, color: t.textSub }}>{hint}</div> : null}
    </div>
  );
}

function Select({ value, onChange, children }) {
  return (
    <select value={value} onChange={onChange} style={{ ...inputBase, paddingRight: 28 }}>
      {children}
    </select>
  );
}

function formatStudentLabel(student) {
  if (!student) return "";
  const key = student.studentNo || student.loginId || "-";
  const name = student.name || "-";
  return `${key} / ${name}`;
}

function getDefaultRoomName(rooms) {
  const rows = Array.isArray(rooms) ? rooms : [];
  const hasUndecided = rows.some((row) => String(row?.name || "").trim() === "미정");
  if (hasUndecided) return "미정";
  const first = rows.find((row) => String(row?.name || "").trim());
  return first ? String(first.name).trim() : "미정";
}

function StudentSearchCombobox({
  students,
  value,
  onChange,
}) {
  const wrapperRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const selected = students.find((s) => s.uid === value) || null;

  useEffect(() => {
    setQuery(selected ? formatStudentLabel(selected) : "");
  }, [selected?.uid, selected?.studentNo, selected?.name, selected?.loginId]);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onPointerDown = (event) => {
      if (!wrapperRef.current) return;
      if (wrapperRef.current.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    return () => window.removeEventListener("mousedown", onPointerDown);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const rows = [...students].sort((a, b) => {
      const left = String(a.studentNo || a.loginId || "");
      const right = String(b.studentNo || b.loginId || "");
      return left.localeCompare(right, "ko");
    });

    if (!q) return rows.slice(0, 40);
    return rows
      .filter((row) => {
        const no = String(row.studentNo || "").toLowerCase();
        const id = String(row.loginId || "").toLowerCase();
        const name = String(row.name || "").toLowerCase();
        return no.includes(q) || id.includes(q) || name.includes(q);
      })
      .slice(0, 40);
  }, [students, query]);

  function handleSelect(student) {
    onChange(student.uid);
    setOpen(false);
  }

  function handleClear() {
    onChange("");
    setQuery("");
    setOpen(false);
  }

  function handleKeyDown(event) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }

    if (event.key === "Enter" && filtered.length > 0) {
      event.preventDefault();
      handleSelect(filtered[0]);
    }
  }

  return (
    <div ref={wrapperRef} style={{ position: "relative" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder="학번 또는 이름으로 검색"
          style={{ ...inputBase, flex: 1 }}
        />
        {value ? (
          <button
            onClick={handleClear}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub, padding: "0 10px" }}
          >
            해제
          </button>
        ) : null}
      </div>

      {selected ? (
        <div style={{ marginTop: 5, fontSize: 11, color: t.accent }}>
          선택됨: {formatStudentLabel(selected)}
        </div>
      ) : null}

      {open ? (
        <div
          style={{
            position: "absolute",
            zIndex: 40,
            top: selected ? 56 : 42,
            left: 0,
            right: 0,
            border: `1px solid ${t.border}`,
            borderRadius: 10,
            background: "#fff",
            boxShadow: "0 14px 26px rgba(9, 30, 66, 0.14)",
            maxHeight: 260,
            overflow: "auto",
          }}
        >
          {filtered.length === 0 ? (
            <div style={{ padding: "10px 12px", fontSize: 12, color: t.textSub }}>
              검색 결과가 없습니다.
            </div>
          ) : (
            filtered.map((student) => {
              const isSelected = value === student.uid;
              return (
                <button
                  key={student.uid}
                  onClick={() => handleSelect(student)}
                  style={{
                    width: "100%",
                    textAlign: "left",
                    border: "none",
                    borderBottom: `1px solid ${t.border}`,
                    background: isSelected ? "#edf4ff" : "#fff",
                    padding: "9px 11px",
                    cursor: "pointer",
                  }}
                >
                  <div style={{ fontSize: 13, fontWeight: 700, color: isSelected ? t.accent : t.text }}>
                    {student.studentNo || student.loginId || "-"} / {student.name || "-"}
                  </div>
                  <div style={{ fontSize: 11, color: t.textSub }}>
                    아이디: {student.loginId || "-"}
                  </div>
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }) {
  const current = badgeStyle[status] || badgeStyle.waiting_round;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 12,
        fontWeight: 700,
        background: current.bg,
        color: current.color,
      }}
    >
      {current.label}
    </span>
  );
}

function Layout({ user, tab, setTab, onSignOut, isStudentLeader, children }) {
  const [isMobile, setIsMobile] = useState(
    () => (typeof window !== "undefined" ? window.innerWidth < 980 : false),
  );

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const onResize = () => setIsMobile(window.innerWidth < 980);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const navByRole = {
    admin: [
      { key: "clubs", label: "동아리 관리" },
      { key: "studentStatus", label: "학생 신청 현황" },
      { key: "round", label: "동아리 선발 진행" },
      { key: "users", label: "회원 관리" },
      { type: "divider" },
      { key: "extraRequests", label: "기타신청현황" },
      { key: "requestCards", label: "공통 신청카드 관리" },
      { type: "divider" },
      { key: "profile", label: "내 정보" },
    ],
    teacher: [
      { key: "myClubs", label: "내 동아리" },
      { key: "clubOverview", label: "동아리개설현황" },
      { key: "studentStatus", label: "학생 신청 현황" },
      { type: "divider" },
      { key: "extraRequests", label: "기타신청현황" },
      { type: "divider" },
      { key: "profile", label: "내 정보" },
    ],
    student: isStudentLeader
      ? [
        { key: "apply", label: "동아리 신청" },
        { key: "my", label: "신청 현황" },
        { key: "clubOverview", label: "동아리개설현황" },
        { key: "clubs", label: "동아리 수정(동아리장)" },
        { type: "divider" },
        { key: "extraRequests", label: "기타신청현황" },
        { type: "divider" },
        { key: "profile", label: "내 정보" },
      ]
      : [
        { key: "apply", label: "동아리 신청" },
        { key: "my", label: "신청 현황" },
        { key: "clubOverview", label: "동아리개설현황" },
        { type: "divider" },
        { key: "extraRequests", label: "기타신청현황" },
        { type: "divider" },
        { key: "profile", label: "내 정보" },
      ],
  };

  const nav = navByRole[user?.role] || navByRole.student;

  return (
    <div style={page}>
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: 16, display: "grid", gap: 12 }}>
        <header style={{ ...cardStyle, padding: "14px 16px", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
          <div>
            <div style={{ fontSize: 22, fontWeight: 800 }}>강원 설악고등학교 신청 통합 시스템</div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              {roleLabel(user?.role)} · {user?.name || "-"} ({user?.loginId || "-"})
            </div>
          </div>
          <button
            onClick={onSignOut}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub, fontWeight: 700 }}
          >
            로그아웃
          </button>
        </header>

        {isMobile ? (
          <div style={{ display: "grid", gap: 12 }}>
            <nav style={{ ...cardStyle, padding: 8 }}>
              <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>
                {nav.map((item, index) => {
                  if (item.type === "divider") {
                    return (
                      <div
                        key={`divider-${index}`}
                        style={{ width: 1, minWidth: 1, alignSelf: "stretch", background: t.border, margin: "4px 2px" }}
                      />
                    );
                  }
                  const active = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setTab(item.key)}
                      style={{
                        ...buttonBase,
                        whiteSpace: "nowrap",
                        background: active ? t.accent : "#fff",
                        color: active ? "#fff" : t.text,
                        border: `1px solid ${active ? t.accent : t.border}`,
                        fontWeight: 700,
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </nav>
            <main style={{ display: "grid", gap: 12 }}>{children}</main>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "220px minmax(0,1fr)", gap: 12 }}>
            <aside style={{ ...cardStyle, height: "fit-content", padding: 10 }}>
              <div style={{ display: "grid", gap: 6 }}>
                {nav.map((item, index) => {
                  if (item.type === "divider") {
                    return (
                      <div
                        key={`divider-${index}`}
                        style={{ height: 1, background: t.border, margin: "4px 2px" }}
                      />
                    );
                  }
                  const active = tab === item.key;
                  return (
                    <button
                      key={item.key}
                      onClick={() => setTab(item.key)}
                      style={{
                        ...buttonBase,
                        textAlign: "left",
                        background: active ? t.accent : "transparent",
                        color: active ? "#fff" : t.text,
                        border: `1px solid ${active ? t.accent : "transparent"}`,
                        fontWeight: 700,
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })}
              </div>
            </aside>

            <main style={{ display: "grid", gap: 12 }}>{children}</main>
          </div>
        )}
      </div>
    </div>
  );
}

function ClubForm({
  actor,
  users,
  roomOptions,
  editingId,
  form,
  setForm,
  onSubmit,
  onReset,
  submitting,
  canCreate,
}) {
  const teachers = users.filter((u) => u.role === "teacher" || u.role === "admin");
  const students = users.filter((u) => u.role === "student");
  const isAdmin = actor?.role === "admin";
  const selectedTeacher = teachers.find((u) => u.uid === form.teacherUid);
  const teacherDisplay = selectedTeacher
    ? `${selectedTeacher.name} (${selectedTeacher.loginId})`
    : (form.teacherUid || "미지정");
  const normalizedRoomOptions = useMemo(() => {
    const map = new Map();
    (roomOptions || []).forEach((row) => {
      const name = String(row?.name || "").trim();
      if (!name) return;
      map.set(name, { id: row?.id || name, name });
    });
    if (!map.has("미정")) {
      map.set("미정", { id: "system-undecided", name: "미정" });
    }
    const currentRoom = String(form?.room || "").trim();
    if (currentRoom && !map.has(currentRoom)) {
      map.set(currentRoom, { id: `legacy-room-${currentRoom}`, name: currentRoom });
    }
    return [...map.values()].sort((a, b) => {
      if (a.name === "미정") return -1;
      if (b.name === "미정") return 1;
      return a.name.localeCompare(b.name, "ko");
    });
  }, [roomOptions, form?.room]);

  return (
    <section style={cardStyle}>
      <h2 style={{ fontSize: 17, marginBottom: 12 }}>{editingId ? "동아리 수정" : "동아리 개설"}</h2>

      <div style={{ display: "grid", gap: 10 }}>
        {!canCreate && !editingId ? (
          <div style={{ ...cardStyle, background: "#fff8e1", borderColor: "#f3dfb9", padding: 10, fontSize: 12, color: t.warn }}>
            동아리장은 신규 동아리 생성 권한이 없습니다. 목록에서 본인 동아리를 선택해 수정만 가능합니다.
          </div>
        ) : null}

        <Field label="동아리명">
          <input
            value={form.clubName}
            onChange={(e) => setForm((prev) => ({ ...prev, clubName: e.target.value }))}
            style={inputBase}
            placeholder="예: 미디어콘텐츠 동아리"
          />
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="담당교사 연결">
            {isAdmin ? (
              <Select
                value={form.teacherUid}
                onChange={(e) => setForm((prev) => ({ ...prev, teacherUid: e.target.value }))}
              >
                <option value="">담당교사 선택</option>
                {teachers.map((u) => (
                  <option key={u.uid} value={u.uid}>
                    {u.name} ({u.loginId})
                  </option>
                ))}
              </Select>
            ) : (
              <input
                style={{ ...inputBase, background: t.muted }}
                readOnly
                value={teacherDisplay}
              />
            )}
          </Field>

          <Field label="동아리장 학번(학생계정 연결)">
            <StudentSearchCombobox
              students={students}
              value={form.leaderUid}
              onChange={(nextUid) => setForm((prev) => ({ ...prev, leaderUid: nextUid }))}
            />
          </Field>
        </div>

        <Field label="대상학년(중복선택)">
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {[1, 2, 3].map((grade) => {
              const checked = form.targetGrades.includes(grade);
              return (
                <label
                  key={grade}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    border: `1px solid ${checked ? t.accent : t.border}`,
                    background: checked ? "#edf4ff" : "#fff",
                    borderRadius: 999,
                    padding: "6px 10px",
                    fontSize: 13,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => {
                      setForm((prev) => {
                        const exists = prev.targetGrades.includes(grade);
                        const next = exists
                          ? prev.targetGrades.filter((g) => g !== grade)
                          : [...prev.targetGrades, grade];
                        return { ...prev, targetGrades: next.sort((a, b) => a - b) };
                      });
                    }}
                  />
                  {grade}학년
                </label>
              );
            })}
          </div>
        </Field>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Field label="동아리실" hint="관리자가 등록한 목록에서 선택합니다. 공란은 미정으로 처리됩니다.">
            <Select
              value={form.room || "미정"}
              onChange={(e) => setForm((prev) => ({ ...prev, room: e.target.value }))}
            >
              {normalizedRoomOptions.map((room) => (
                <option key={room.id} value={room.name}>
                  {room.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="동아리 최대인원">
            <input
              type="number"
              min={1}
              value={form.maxMembers}
              onChange={(e) => setForm((prev) => ({ ...prev, maxMembers: e.target.value }))}
              style={inputBase}
            />
          </Field>
        </div>

        <Field label="동아리 소개(장문)">
          <textarea
            value={form.description}
            onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
            style={{ ...inputBase, minHeight: 110, resize: "vertical" }}
            placeholder="동아리 활동 목적, 운영 방식, 기대 효과 등을 입력"
          />
        </Field>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600 }}>
          <input
            type="checkbox"
            checked={form.isInterviewSelection}
            onChange={(e) => setForm((prev) => ({ ...prev, isInterviewSelection: e.target.checked }))}
          />
          자체면접 선발 여부 (O=체크 / X=해제)
        </label>

        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={onSubmit}
            disabled={submitting || (!canCreate && !editingId)}
            style={{ ...buttonBase, background: t.accent, color: "#fff", fontWeight: 700 }}
          >
            {submitting ? "저장 중..." : editingId ? "수정 저장" : canCreate ? "동아리 생성" : "신규 생성 불가"}
          </button>
          <button
            onClick={onReset}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
          >
            닫기
          </button>
        </div>
      </div>
    </section>
  );
}

function ClubRoomManager({
  rooms,
  loading,
  onAdd,
  onDelete,
  onRefresh,
}) {
  const [roomInput, setRoomInput] = useState("");
  const rows = Array.isArray(rooms) ? rooms : [];

  async function submitRoom() {
    if (loading) return;
    const ok = await onAdd(roomInput);
    if (ok) setRoomInput("");
  }

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
        <h2 style={{ fontSize: 17 }}>동아리실 등록</h2>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
        >
          새로고침
        </button>
      </div>

      <div style={{ display: "grid", gap: 8 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={roomInput}
            onChange={(e) => setRoomInput(e.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              submitRoom();
            }}
            style={{ ...inputBase, minWidth: 260, flex: 1 }}
            placeholder="예: 2층 창의융합실 (비워도 등록 가능)"
          />
          <button
            onClick={submitRoom}
            disabled={loading}
            style={{ ...buttonBase, background: loading ? "#cfd8e3" : t.accent, color: "#fff", fontWeight: 700 }}
          >
            {loading ? "처리 중..." : "동아리실 등록"}
          </button>
        </div>
        <div style={{ fontSize: 12, color: t.textSub }}>
          입력값이 비어 있으면 <strong>미정</strong>으로 등록됩니다.
        </div>
      </div>

      <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
        <div style={{ fontSize: 12, color: t.textSub }}>등록된 동아리실</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {rows.map((room) => {
            const locked = room.name === "미정";
            return (
              <div
                key={room.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  border: `1px solid ${locked ? "#f3dfb9" : t.border}`,
                  background: locked ? "#fff8e1" : "#fff",
                  borderRadius: 999,
                  padding: "6px 10px",
                }}
              >
                <span style={{ fontSize: 12, fontWeight: 700, color: locked ? t.warn : t.text }}>
                  {room.name}
                </span>
                <button
                  onClick={() => onDelete(room)}
                  disabled={loading || locked}
                  style={{
                    ...buttonBase,
                    padding: "4px 7px",
                    background: locked ? "transparent" : "#ffebee",
                    color: locked ? t.textSub : t.danger,
                    cursor: loading || locked ? "not-allowed" : "pointer",
                  }}
                >
                  {locked ? "고정" : "삭제"}
                </button>
              </div>
            );
          })}
          {rows.length === 0 ? (
            <div style={{ fontSize: 12, color: t.textSub }}>등록된 동아리실이 없습니다.</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function ClubTable({
  actor,
  clubs,
  userMap,
  cycle,
  roundStats,
  canCreate,
  onCreate,
  onOpenDetail,
  onEdit,
  onDelete,
  onOpenApplicants,
  onOpenInterviewSelect,
  showCapacity = true,
  showRoundStatus = true,
  showActions = true,
}) {
  const headers = ["동아리명", "담당교사", "동아리장", "대상학년", "동아리실"];
  if (showCapacity) headers.push("정원");
  headers.push("면접");
  if (showRoundStatus) headers.push("라운드 현황");
  if (showActions) headers.push("작업");

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
        <h2 style={{ fontSize: 17 }}>동아리 목록</h2>
        {canCreate ? (
          <button
            onClick={onCreate}
            style={{ ...buttonBase, background: t.accent, color: "#fff", fontWeight: 700 }}
          >
            생성 (+)
          </button>
        ) : null}
      </div>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 8 }}>
        동아리명을 클릭하면 동아리 상세 내용을 확인할 수 있습니다.
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1060 }}>
          <thead>
            <tr>
              {headers.map((head) => (
                <th
                  key={head}
                  style={{
                    textAlign: "left",
                    borderBottom: `1px solid ${t.border}`,
                    padding: "10px 8px",
                    fontSize: 12,
                    color: t.textSub,
                  }}
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {clubs.map((club) => {
              const teacher = userMap.get(club.teacherUid);
              const leader = userMap.get(club.leaderUid);
              const editable = canEditClub(club, actor);
              const manageable = canManageSelection(club, actor);
              const stats = roundStats[club.id] || { pendingCurrent: 0, approved: 0, total: 0 };

              return (
                <tr key={club.id}>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13, fontWeight: 700 }}>
                    <button
                      onClick={() => onOpenDetail(club)}
                      style={{
                        background: "transparent",
                        border: "none",
                        padding: 0,
                        margin: 0,
                        fontSize: 13,
                        fontWeight: 700,
                        color: t.accent,
                        cursor: "pointer",
                        textDecoration: "underline",
                        textUnderlineOffset: 2,
                      }}
                    >
                      {club.clubName}
                    </button>
                    {club.legacy ? <span style={{ marginLeft: 6, fontSize: 11, color: t.danger }}>[구형데이터]</span> : null}
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>
                    {teacher ? `${teacher.name}(${teacher.loginId})` : club.teacherUid || "-"}
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>
                    {leader ? `${leader.studentNo || leader.loginId} / ${leader.name}` : club.leaderUid || "미지정"}
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>
                    {(club.targetGrades || []).map((g) => `${g}`).join(", ")}
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>{club.room}</td>
                  {showCapacity ? (
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>
                      {club.memberCount}/{club.maxMembers}
                    </td>
                  ) : null}
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 13 }}>
                    {club.isInterviewSelection ? "O" : "X"}
                  </td>
                  {showRoundStatus ? (
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px", fontSize: 12, color: t.textSub }}>
                      {cycle?.status === "closed"
                        ? "종료"
                        : `${cycle?.currentRound || 1}R 대기 ${stats.pendingCurrent}명 / 승인 ${stats.approved}명`}
                    </td>
                  ) : null}
                  {showActions ? (
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 8px" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {editable ? (
                          <button
                            onClick={() => onEdit(club)}
                            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, padding: "6px 9px" }}
                          >
                            수정
                          </button>
                        ) : null}

                        {manageable && !club.isInterviewSelection ? (
                          <button
                            onClick={() => onOpenApplicants(club)}
                            style={{ ...buttonBase, background: "#edf4ff", color: t.accent, padding: "6px 9px", fontWeight: 700 }}
                          >
                            신청관리
                          </button>
                        ) : null}

                        {manageable && club.isInterviewSelection ? (
                          <button
                            onClick={() => onOpenInterviewSelect(club)}
                            style={{ ...buttonBase, background: "#fff3e0", color: t.warn, padding: "6px 9px", fontWeight: 700 }}
                          >
                            직접선발
                          </button>
                        ) : null}

                        {(actor?.role === "admin" || actor?.loginId === "admin") ? (
                          <button
                            onClick={() => onDelete(club)}
                            style={{ ...buttonBase, background: "#ffebee", color: t.danger, padding: "6px 9px", fontWeight: 700 }}
                          >
                            삭제
                          </button>
                        ) : null}
                      </div>
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ClubFormDialog({
  open,
  title,
  onClose,
  children,
}) {
  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 900, margin: "20px auto" }}>
        <div style={{ ...cardStyle, marginBottom: 10, padding: "10px 12px", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 800 }}>{title}</div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}>
            닫기
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ClubDetailDialog({
  open,
  club,
  userMap,
  onClose,
}) {
  if (!open || !club) return null;

  const teacher = userMap.get(club.teacherUid);
  const leader = userMap.get(club.leaderUid);

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 900, margin: "20px auto", ...cardStyle }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 18, fontWeight: 800 }}>{club.clubName}</div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}` }}>
            닫기
          </button>
        </div>

        <div style={{ display: "grid", gap: 8, marginBottom: 12 }}>
          <div style={{ fontSize: 13 }}>
            <strong>담당교사:</strong> {teacher ? `${teacher.name} (${teacher.loginId})` : (club.teacherUid || "-")}
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>동아리장:</strong> {leader ? `${leader.studentNo || leader.loginId} / ${leader.name}` : (club.leaderUid || "미지정")}
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>대상학년:</strong> {(club.targetGrades || []).join(", ")}
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>동아리실:</strong> {club.room || "-"}
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>정원:</strong> {club.memberCount}/{club.maxMembers}
          </div>
          <div style={{ fontSize: 13 }}>
            <strong>자체면접:</strong> {club.isInterviewSelection ? "O" : "X"}
          </div>
        </div>

        <div style={{ borderTop: `1px solid ${t.border}`, paddingTop: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 6 }}>동아리 소개</div>
          <div style={{ whiteSpace: "pre-wrap", lineHeight: 1.6, fontSize: 13, color: t.textSub }}>
            {String(club.description || "").trim() || "소개가 아직 입력되지 않았습니다."}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApplicantsDialog({
  open,
  loading,
  club,
  cycle,
  submissionState,
  preAssignmentState,
  rows,
  users,
  onClose,
  onApprove,
  onReject,
  onRevoke,
  onRandom,
  onManualAssign,
  randomLocked,
}) {
  const [manualStudentUid, setManualStudentUid] = useState("");

  const clubTargetGradesKey = Array.isArray(club?.targetGrades) ? club.targetGrades.join(",") : "";
  const students = useMemo(
    () => {
      const targets = clubTargetGradesKey
        ? clubTargetGradesKey.split(",").map((value) => Number(value)).filter(Boolean)
        : [];
      return (users || [])
        .filter((row) => row.role === "student")
        .filter((row) => {
          if (targets.length === 0) return true;
          const grade = inferStudentGrade(row.studentNo || row.loginId);
          return grade ? targets.includes(grade) : false;
        });
    },
    [users, clubTargetGradesKey],
  );
  const selectionReady = submissionState?.selectionReady !== false;
  const preAssignmentReady = preAssignmentState?.canAssign === true;
  const manualEnabled = cycle?.status === "open" && (selectionReady || preAssignmentReady);
  const manualDisabled = loading || !manualEnabled || !manualStudentUid;

  if (!open) return null;

  const currentRound = cycle?.currentRound || 1;
  const pendingCurrent = rows.filter(
    (row) => row.status === "pending" && Number(row.preferenceRank) === Number(currentRound),
  ).length;
  const randomDisabled = loading || pendingCurrent === 0 || randomLocked || cycle?.status === "closed" || !selectionReady;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 1180, margin: "20px auto", ...cardStyle }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{club?.clubName} 신청 관리</div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              현재 {currentRound}라운드 · 대기 {pendingCurrent}명
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}` }}>닫기</button>
        </div>

        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            onClick={onRandom}
            disabled={randomDisabled}
            style={{
              ...buttonBase,
              background: randomDisabled ? "#cfd8e3" : "#fff3e0",
              color: randomDisabled ? "#6b7280" : t.warn,
              fontWeight: 700,
            }}
          >
            무작위 선발 1회 실행
          </button>
          {randomLocked ? <span style={{ fontSize: 12, color: t.textSub }}>현재 라운드는 이미 무작위 선발을 실행했습니다.</span> : null}
        </div>

        {!selectionReady ? (
          <div
            style={{
              ...cardStyle,
              marginBottom: 12,
              background: preAssignmentReady ? "#eef7ee" : "#fff8e1",
              borderColor: preAssignmentReady ? "#cbe6cd" : "#f3dfb9",
              padding: 12,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 800, color: preAssignmentReady ? t.ok : t.warn, marginBottom: 4 }}>
              {preAssignmentReady ? "교사 사전 학생 배정 기간입니다." : "선발 기능이 잠겨 있습니다."}
            </div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              {preAssignmentReady
                ? "지금은 학생 수동 배정만 먼저 진행할 수 있고, 일반 승인/반려/무작위 선발은 학생 신청 마감 후 가능합니다."
                : submissionPhaseDescription(submissionState)}
            </div>
          </div>
        ) : null}

        <div style={{ ...cardStyle, marginBottom: 12, background: "#f8fbff", borderColor: "#d8e5ff", padding: 12 }}>
          <div style={{ fontSize: 13, fontWeight: 800, marginBottom: 8 }}>
            학생 수동 배정 승인
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) auto", gap: 8 }}>
            <StudentSearchCombobox
              students={students}
              value={manualStudentUid}
              onChange={setManualStudentUid}
            />
            <button
              onClick={async () => {
                const ok = await onManualAssign(manualStudentUid);
                if (ok) setManualStudentUid("");
              }}
              disabled={manualDisabled}
              style={{
                ...buttonBase,
                background: manualDisabled ? "#cfd8e3" : "#e8f5e9",
                color: manualDisabled ? "#6b7280" : t.ok,
                fontWeight: 700,
                minWidth: 136,
              }}
            >
              수동 배정 승인
            </button>
          </div>
          <div style={{ marginTop: 7, fontSize: 12, color: t.textSub }}>
            {preAssignmentReady
              ? "대상학년 학생만 검색되며, 교사 사전 학생 배정 기간에는 학생 신청 없이도 미리 배정할 수 있습니다."
              : "대상학년 학생만 검색되며, 신청 마감 후에는 신청하지 않은 학생도 바로 배정할 수 있습니다."}
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
            <thead>
              <tr>
                {["학번", "이름", "지망", "상태", "진로희망", "신청사유", "활동계획", "결정", "작업"].map((head) => (
                  <th
                    key={head}
                    style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const canDecide = row.status === "pending" && cycle?.status === "open" && selectionReady;
                const canRevoke = row.status === "approved"
                  && cycle?.status === "open"
                  && selectionReady
                  && row.selectionSource !== "random"
                  && row.selectionSource !== "leader_auto";
                return (
                  <tr key={row.id}>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{row.studentNo || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{row.studentName || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{row.preferenceRank}지망</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px" }}><StatusBadge status={row.status} /></td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.careerGoal || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.applyReason || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.wantedActivity || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 12, color: t.textSub }}>
                      {decisionLabel(row)}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px" }}>
                      {canDecide ? (
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => onApprove(row)}
                            disabled={loading}
                            style={{
                              ...buttonBase,
                              padding: "5px 8px",
                              background: !loading ? "#e8f5e9" : "#cfd8e3",
                              color: !loading ? t.ok : "#6b7280",
                              fontWeight: 700,
                            }}
                          >
                            승인
                          </button>
                          <button
                            onClick={() => onReject(row)}
                            disabled={loading}
                            style={{
                              ...buttonBase,
                              padding: "5px 8px",
                              background: !loading ? "#ffebee" : "#cfd8e3",
                              color: !loading ? t.danger : "#6b7280",
                              fontWeight: 700,
                            }}
                          >
                            반려
                          </button>
                        </div>
                      ) : null}
                      {canRevoke ? (
                        <button
                          onClick={() => onRevoke(row)}
                          disabled={loading}
                          style={{
                            ...buttonBase,
                            padding: "5px 8px",
                            background: !loading ? "#fff4e5" : "#cfd8e3",
                            color: !loading ? t.warn : "#6b7280",
                            fontWeight: 700,
                          }}
                        >
                          승인 취소
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={9} style={{ padding: 16, textAlign: "center", fontSize: 13, color: t.textSub }}>
                    신청 데이터가 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function InterviewSelectDialog({
  open,
  club,
  users,
  members,
  loading,
  selectionReady,
  preAssignmentState,
  cycleClosed,
  keyword,
  setKeyword,
  onClose,
  onSelect,
}) {
  if (!open) return null;

  const students = users.filter((u) => u.role === "student");
  const memberIds = new Set(members.map((m) => m.studentUid));
  const filtered = students
    .filter((s) => !memberIds.has(s.uid))
    .filter((s) => {
      if (!keyword.trim()) return true;
      const q = keyword.trim();
      return (
        String(s.studentNo || "").includes(q)
        || String(s.name || "").includes(q)
        || String(s.loginId || "").includes(q)
      );
    })
    .slice(0, 80);
  const preAssignmentReady = preAssignmentState?.canAssign === true;
  const canSelect = selectionReady || preAssignmentReady;
  const selectDisabled = loading || !canSelect || cycleClosed;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 960, margin: "20px auto", ...cardStyle }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{club?.clubName} 직접 선발</div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              자체면접 동아리는 학생 신청 없이 담당교사가 직접 선발합니다.
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}` }}>닫기</button>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {!selectionReady ? (
            <div
              style={{
                ...cardStyle,
                padding: 12,
                background: preAssignmentReady ? "#eef7ee" : "#fff8e1",
                borderColor: preAssignmentReady ? "#cbe6cd" : "#f3dfb9",
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 700, color: preAssignmentReady ? t.ok : t.warn, marginBottom: 4 }}>
                {preAssignmentReady ? "교사 사전 학생 배정 기간입니다." : "신청 기간이 끝난 뒤 직접 선발할 수 있습니다."}
              </div>
              <div style={{ fontSize: 12, color: t.textSub }}>
                {preAssignmentReady
                  ? "지금은 면접으로 미리 선발한 학생을 바로 배정할 수 있습니다."
                  : "학생 입력이 열려 있는 동안에는 직접 선발 기능을 잠급니다."}
              </div>
            </div>
          ) : null}

          <div style={{ ...cardStyle, padding: 12, background: "#fafbfd" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>
              현재 선발 인원: {club?.memberCount || 0}/{club?.maxMembers || 0}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {members.map((member) => (
                <span
                  key={member.id}
                  style={{
                    border: `1px solid ${t.border}`,
                    borderRadius: 999,
                    padding: "4px 8px",
                    fontSize: 12,
                    background: "#fff",
                  }}
                >
                  {member.studentNo} / {member.name}
                </span>
              ))}
              {members.length === 0 ? <span style={{ fontSize: 12, color: t.textSub }}>아직 선발된 학생이 없습니다.</span> : null}
            </div>
          </div>

          <div>
            <input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              style={inputBase}
              placeholder="학번 또는 이름으로 학생 검색"
            />
          </div>

          <div style={{ maxHeight: 420, overflow: "auto", border: `1px solid ${t.border}`, borderRadius: 10 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {["학번", "이름", "아이디", "작업"].map((head) => (
                    <th key={head} style={{ textAlign: "left", padding: "8px 10px", fontSize: 12, color: t.textSub, borderBottom: `1px solid ${t.border}` }}>{head}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <tr key={s.uid}>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 10px", fontSize: 13 }}>{s.studentNo || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 10px", fontSize: 13 }}>{s.name || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 10px", fontSize: 13 }}>{s.loginId || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 10px" }}>
                      <button
                        onClick={() => onSelect(s)}
                        disabled={selectDisabled}
                        style={{
                          ...buttonBase,
                          padding: "5px 8px",
                          background: selectDisabled ? "#cfd8e3" : "#fff3e0",
                          color: selectDisabled ? "#6b7280" : t.warn,
                          fontWeight: 700,
                        }}
                      >
                        선발
                      </button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ padding: 14, textAlign: "center", color: t.textSub, fontSize: 13 }}>
                      검색 결과가 없습니다.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoundPanel({
  cycle,
  stats,
  loading,
  preAssignmentState,
  preAssignmentStartValue,
  preAssignmentEndValue,
  submissionState,
  onPreAssignmentStartChange,
  onPreAssignmentEndChange,
  onSavePreAssignmentWindow,
  submissionStartValue,
  submissionEndValue,
  onSubmissionStartChange,
  onSubmissionEndChange,
  onSaveSubmissionWindow,
  onRefresh,
  onAdvance,
  onCleanup,
}) {
  const pendingTotal = Object.values(stats).reduce((sum, row) => sum + Number(row.pendingCurrent || 0), 0);
  const advanceDisabled = loading
    || cycle?.status === "closed"
    || pendingTotal > 0
    || submissionState?.selectionReady === false;

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 17 }}>동아리 선발 진행</h2>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
            현재 상태: {cycle?.status === "closed" ? "종료" : "진행중"} · 현재 라운드: {cycle?.currentRound || 1}
          </div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>
            현재 라운드 pending 합계: {pendingTotal}명
          </div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>
            교사 사전 학생 배정 상태: {preAssignmentPhaseLabel(preAssignmentState)}
          </div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>
            학생 신청 상태: {submissionPhaseLabel(submissionState)}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            onClick={onRefresh}
            disabled={loading}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
          >
            새로고침
          </button>
          <button
            onClick={onAdvance}
            disabled={advanceDisabled}
            style={{
              ...buttonBase,
              background: advanceDisabled ? "#cfd8e3" : t.accent,
              color: "#fff",
              fontWeight: 700,
            }}
          >
            다음 라운드 시작
          </button>
          <button
            onClick={onCleanup}
            disabled={loading}
            style={{ ...buttonBase, background: "#ffebee", color: t.danger, fontWeight: 700 }}
          >
            기존 모집 데이터 전체 삭제
          </button>
        </div>
      </div>

      <div style={{ ...cardStyle, marginBottom: 12, background: "#eef7ee", borderColor: "#cbe6cd", padding: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>교사 사전 학생 배정 기간 설정</div>
        <div style={{ fontSize: 12, color: t.textSub, marginBottom: 4 }}>
          현재 기간: {preAssignmentState?.configured
            ? `${formatTime(preAssignmentState.startAt)} ~ ${formatTime(preAssignmentState.endAt)}`
            : "미설정"}
        </div>
        <div style={{ fontSize: 12, color: t.textSub, marginBottom: 10 }}>
          {preAssignmentPhaseDescription(preAssignmentState)}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
          <Field label="사전 배정 시작 일시">
            <input
              type="datetime-local"
              value={preAssignmentStartValue}
              onChange={(e) => onPreAssignmentStartChange(e.target.value)}
              style={inputBase}
            />
          </Field>
          <Field label="사전 배정 종료 일시">
            <input
              type="datetime-local"
              value={preAssignmentEndValue}
              onChange={(e) => onPreAssignmentEndChange(e.target.value)}
              style={inputBase}
            />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={onSavePreAssignmentWindow}
            disabled={loading}
            style={{
              ...buttonBase,
              background: loading ? "#cfd8e3" : t.ok,
              color: "#fff",
              fontWeight: 700,
            }}
          >
            교사 사전 배정 기간 저장
          </button>
          <span style={{ fontSize: 12, color: t.textSub }}>
            이 기간이 열려 있는 동안에는 직접 선발과 수동 배정을 추가로 허용합니다.
          </span>
        </div>
      </div>

      <div style={{ ...cardStyle, marginBottom: 12, background: "#f8fbff", borderColor: "#d8e5ff", padding: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>학생 신청 기간 설정</div>
        <div style={{ fontSize: 12, color: t.textSub, marginBottom: 4 }}>
          현재 기간: {submissionState?.configured
            ? `${formatTime(submissionState.startAt)} ~ ${formatTime(submissionState.endAt)}`
            : "미설정"}
        </div>
        <div style={{ fontSize: 12, color: t.textSub, marginBottom: 10 }}>
          {submissionPhaseDescription(submissionState)}
        </div>
        {submissionState?.finalizedAt ? (
          <div style={{ fontSize: 12, color: t.textSub, marginBottom: 10 }}>
            최근 확정 시각: {formatTime(submissionState.finalizedAt)}
          </div>
        ) : null}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
          <Field label="신청 시작 일시">
            <input
              type="datetime-local"
              value={submissionStartValue}
              onChange={(e) => onSubmissionStartChange(e.target.value)}
              style={inputBase}
            />
          </Field>
          <Field label="신청 종료 일시">
            <input
              type="datetime-local"
              value={submissionEndValue}
              onChange={(e) => onSubmissionEndChange(e.target.value)}
              style={inputBase}
            />
          </Field>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" }}>
          <button
            onClick={onSaveSubmissionWindow}
            disabled={loading}
            style={{
              ...buttonBase,
              background: loading ? "#cfd8e3" : t.accent,
              color: "#fff",
              fontWeight: 700,
            }}
          >
            신청 기간 저장
          </button>
          <span style={{ fontSize: 12, color: t.textSub }}>
            시작/종료를 모두 비우고 저장하면 미설정 상태로 되돌립니다.
          </span>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 760 }}>
          <thead>
            <tr>
              {["동아리", "현재라운드 대기", "총신청", "승인", "반려", "취소"].map((head) => (
                <th key={head} style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}>{head}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Object.values(stats).map((row) => (
              <tr key={row.clubId}>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13, fontWeight: 700 }}>{row.clubName}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.pendingCurrent}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.total}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.approved}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.rejected}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.cancelled}</td>
              </tr>
            ))}
            {Object.keys(stats).length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: 14, textAlign: "center", color: t.textSub, fontSize: 13 }}>
                  동아리 데이터가 없습니다.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StudentApplicationStatusPanel({
  rows,
  loading,
  onRefresh,
  onOpenDetail,
}) {
  const [query, setQuery] = useState("");

  const filteredRows = useMemo(() => {
    const keyword = String(query || "").trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter((row) => {
      const values = [
        row.studentNo,
        row.studentName,
        row.preferences[0]?.clubName,
        row.preferences[1]?.clubName,
        row.preferences[2]?.clubName,
      ];
      return values.some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [rows, query]);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 17 }}>학생 동아리 신청 현황</h2>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
            학생 행을 클릭하면 지원 사유와 배정 이력을 확인할 수 있습니다.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="학번, 이름, 동아리 검색"
            style={{ ...inputBase, width: 240 }}
          />
          <button
            onClick={onRefresh}
            disabled={loading}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
          >
            새로고침
          </button>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
          <thead>
            <tr>
              {["학번", "이름", "1지망동아리", "2지망동아리", "3지망동아리"].map((head) => (
                <th
                  key={head}
                  style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filteredRows.map((row) => (
              <tr
                key={row.studentUid}
                onClick={() => onOpenDetail(row.studentUid)}
                style={{ cursor: "pointer" }}
              >
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 6px", fontSize: 13 }}>{row.studentNo || "-"}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 6px", fontSize: 13, fontWeight: 700 }}>{row.studentName || "-"}</td>
                {[0, 1, 2].map((index) => (
                  <td key={index} style={{ borderBottom: `1px solid ${t.border}`, padding: "10px 6px", fontSize: 13 }}>
                    {row.preferences[index]?.clubName || "-"}
                  </td>
                ))}
              </tr>
            ))}
            {filteredRows.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: "center", padding: 16, fontSize: 13, color: t.textSub }}>
                  표시할 학생 신청 데이터가 없습니다.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StudentApplicationDetailDialog({
  open,
  row,
  cycle,
  submissionState,
  clubs,
  isAdmin,
  loading,
  onClose,
  onForceAssign,
}) {
  const defaultForceClubId = row?.finalClubId || row?.preferences.find((item) => item.clubId)?.clubId || "";
  const [forceClubId, setForceClubId] = useState(defaultForceClubId);
  const [forceReason, setForceReason] = useState("");

  if (!open || !row) return null;

  const selectableClubs = (clubs || []).filter((club) => !club.legacy);
  const forceLocked = cycle?.status === "closed" || submissionState?.selectionReady === false;
  const forceDisabled = loading
    || forceLocked
    || !row.studentUid
    || !forceClubId
    || !String(forceReason || "").trim();

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 1080, margin: "20px auto", ...cardStyle }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{row.studentNo} / {row.studentName}</div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              제출 상태: {submissionSourceLabel(row.sourceType)}
              {row.finalClubName ? ` · 최종배정: ${row.finalClubName}` : ""}
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}` }}>닫기</button>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          <div style={{ ...cardStyle, background: "#fafbfd" }}>
            <div style={{ fontSize: 12, color: t.textSub, marginBottom: 8 }}>
              제출 시각: {formatTime(row.submittedAt)} · 최근 수정: {formatTime(row.updatedAt)}
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
                <thead>
                  <tr>
                    {["지망", "동아리", "상태", "결정/사유", "진로희망", "신청사유", "활동계획"].map((head) => (
                      <th
                        key={head}
                        style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {row.preferences.map((item) => (
                    <tr key={item.preferenceRank}>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{item.preferenceRank}지망</td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{item.clubName || "-"}</td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                        {item.status ? <StatusBadge status={item.status} /> : <span style={{ fontSize: 12, color: t.textSub }}>{item.clubName ? "제출" : "-"}</span>}
                      </td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, color: t.textSub }}>{decisionLabel(item)}</td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{item.careerGoal || "-"}</td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{item.applyReason || "-"}</td>
                      <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{item.wantedActivity || "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {isAdmin ? (
            <div style={{ ...cardStyle, background: "#fff7f2", borderColor: "#f2d7c4" }}>
              <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 8 }}>관리자 강제 배정</div>
              <div style={{ display: "grid", gap: 10 }}>
                <Field label="동아리 선택">
                  <Select value={forceClubId} onChange={(e) => setForceClubId(e.target.value)}>
                    <option value="">동아리 선택</option>
                    {selectableClubs.map((club) => (
                      <option key={club.id} value={club.id}>
                        {club.clubName} ({club.memberCount}/{club.maxMembers}{club.isInterviewSelection ? " · 면접" : ""})
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="강제 배정 사유" hint="학생 원본 신청서는 유지되고, 관리자 조정 기록만 추가됩니다.">
                  <textarea
                    value={forceReason}
                    onChange={(e) => setForceReason(e.target.value)}
                    style={{ ...inputBase, minHeight: 78, resize: "vertical" }}
                    placeholder="예: 상담 결과에 따른 관리자 조정"
                  />
                </Field>
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <button
                    onClick={async () => {
                      const success = await onForceAssign({
                        studentUid: row.studentUid,
                        clubId: forceClubId,
                        reason: forceReason,
                      });
                      if (success) {
                        setForceReason("");
                      }
                    }}
                    disabled={forceDisabled}
                    style={{
                      ...buttonBase,
                      background: forceDisabled ? "#cfd8e3" : "#d97706",
                      color: "#fff",
                      fontWeight: 700,
                    }}
                  >
                    {loading ? "배정 중..." : "강제 배정 실행"}
                  </button>
                  <span style={{ fontSize: 12, color: t.textSub }}>
                    {submissionState?.selectionReady === false
                      ? "학생 신청 기간이 끝난 뒤에만 강제 배정할 수 있습니다."
                      : cycle?.status === "closed"
                        ? "모집 종료 후에는 강제 배정할 수 없습니다."
                        : "기존 승인 동아리가 있으면 선택한 동아리로 이동 처리합니다."}
                  </span>
                </div>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StudentApplyPanel({
  user,
  cycle,
  clubs,
  draft,
  submissionState,
  myApplications,
  submitting,
  onSubmit,
  onCancelDraft,
}) {
  const grade = inferStudentGrade(user?.studentNo || user?.loginId);
  const finalized = myApplications.length > 0;
  const hasDraft = !!draft;
  const canEdit = cycle?.status === "open" && submissionState?.canSubmit && !finalized;

  const available = clubs.filter((club) => {
    if (club.legacy) return false;
    if (club.isInterviewSelection) return false;
    if (!club.leaderUid) return false;
    if (!grade) return false;
    return (club.targetGrades || []).includes(grade);
  });

  const nonInterviewClubs = clubs.filter((club) => !club.legacy && !club.isInterviewSelection);
  const interviewClubs = clubs.filter((club) => !club.legacy && club.isInterviewSelection);
  const readonlyRows = finalized
    ? [...myApplications].sort((a, b) => Number(a.preferenceRank || 0) - Number(b.preferenceRank || 0))
    : (draft?.preferences || []);
  const selectableClubs = canEdit ? available : nonInterviewClubs;

  const [rows, setRows] = useState(() => createPreferenceRows(readonlyRows));

  const showForm = canEdit || hasDraft || finalized || (cycle?.status === "open" && submissionState?.phase === "open");
  const statusPalette = finalized
    ? { bg: "#edf4ff", border: "#c8dcff", title: "신청이 확정되었습니다.", body: "이제 학생 화면에서는 수정할 수 없습니다." }
    : hasDraft && canEdit
      ? { bg: "#edf4ff", border: "#c8dcff", title: "제출이 완료되었습니다.", body: "마감 전까지 수정 저장 또는 제출 취소가 가능합니다." }
      : cycle?.status !== "open"
        ? { bg: "#ffebee", border: "#f2b8be", title: "현재 모집 사이클이 종료되었습니다.", body: "관리자가 새 모집 사이클을 열기 전까지 신청할 수 없습니다." }
        : submissionState?.phase === "unconfigured"
          ? { bg: "#fff8e1", border: "#f3dfb9", title: "아직 신청 기간이 설정되지 않았습니다.", body: "관리자가 신청 시작/종료 일시를 저장하면 제출할 수 있습니다." }
          : submissionState?.phase === "before"
            ? { bg: "#fff8e1", border: "#f3dfb9", title: "신청 시작 전입니다.", body: `신청 시작 시각: ${formatTime(submissionState.startAt)}` }
            : submissionState?.phase === "closed"
              ? { bg: "#fff8e1", border: "#f3dfb9", title: "신청 기간이 종료되었습니다.", body: finalized ? "선발 결과는 내 신청 현황에서 확인할 수 있습니다." : "학생 입력은 잠겨 있고 선발 단계만 진행됩니다." }
              : { bg: "#eef7ee", border: "#cbe6cd", title: "현재 신청 기간입니다.", body: `신청 마감 시각: ${formatTime(submissionState?.endAt)}` };

  return (
    <section style={cardStyle}>
      <h2 style={{ fontSize: 17, marginBottom: 8 }}>학생 동아리 신청</h2>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 12 }}>
        현재 사이클 상태: {cycle?.status === "closed" ? "종료" : "진행중"} · 현재 라운드 {cycle?.currentRound || 1}
      </div>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 12 }}>
        내 학년 추정: {grade ? `${grade}학년` : "학번 첫 자리로 학년 추정 불가"}
      </div>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 12 }}>
        신청 기간 상태: {submissionPhaseLabel(submissionState)}{submissionState?.configured ? ` · ${formatTime(submissionState.startAt)} ~ ${formatTime(submissionState.endAt)}` : ""}
      </div>

      <div style={{ ...cardStyle, background: statusPalette.bg, borderColor: statusPalette.border, marginBottom: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{statusPalette.title}</div>
        <div style={{ fontSize: 12, color: t.textSub }}>{statusPalette.body}</div>
      </div>

      {canEdit && available.length === 0 ? (
        <div style={{ ...cardStyle, background: "#fff8e1", borderColor: "#f3dfb9", marginBottom: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: t.warn }}>신청 가능한 동아리가 없습니다.</div>
          <div style={{ fontSize: 12, color: t.textSub }}>
            학년 제한, 동아리장 미지정, 자체면접 여부를 확인해주세요.
          </div>
        </div>
      ) : null}

      {showForm ? (
        <div style={{ display: "grid", gap: 12 }}>
          {[0, 1, 2].map((idx) => (
            <div key={idx} style={{ ...cardStyle, background: "#fafbfd" }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>{idx + 1}지망</h3>
              <div style={{ display: "grid", gap: 8 }}>
                <Field label="동아리 선택">
                  <Select
                    value={rows[idx].clubId}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], clubId: e.target.value };
                      setRows(next);
                    }}
                  >
                    <option value="">선택 안함</option>
                    {selectableClubs.map((club) => (
                      <option key={club.id} value={club.id}>
                        {club.clubName} ({club.room})
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="진로희망">
                  <input
                    value={rows[idx].careerGoal}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], careerGoal: e.target.value };
                      setRows(next);
                    }}
                    style={inputBase}
                    placeholder="예: 방송기획자"
                  />
                </Field>

                <Field label="신청사유">
                  <textarea
                    value={rows[idx].applyReason}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], applyReason: e.target.value };
                      setRows(next);
                    }}
                    style={{ ...inputBase, minHeight: 70, resize: "vertical" }}
                  />
                </Field>

                <Field label="원하는 활동">
                  <textarea
                    value={rows[idx].wantedActivity}
                    disabled={!canEdit}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], wantedActivity: e.target.value };
                      setRows(next);
                    }}
                    style={{ ...inputBase, minHeight: 70, resize: "vertical" }}
                  />
                </Field>
              </div>
            </div>
          ))}

          {canEdit ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                onClick={() => onSubmit(rows)}
                disabled={submitting || available.length === 0}
                style={{
                  ...buttonBase,
                  background: submitting || available.length === 0 ? "#cfd8e3" : t.accent,
                  color: "#fff",
                  fontWeight: 700,
                }}
              >
                {submitting ? (hasDraft ? "저장 중..." : "제출 중...") : hasDraft ? "수정 저장" : "제출"}
              </button>
              {hasDraft ? (
                <button
                  onClick={onCancelDraft}
                  disabled={submitting}
                  style={{
                    ...buttonBase,
                    background: submitting ? "#cfd8e3" : "#fff",
                    border: `1px solid ${t.border}`,
                    color: t.textSub,
                    fontWeight: 700,
                  }}
                >
                  제출 취소
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div style={{ marginTop: 14, ...cardStyle, background: "#fffaf0", borderColor: "#f3dfb9" }}>
        <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>자체면접 동아리(학생 신청 불가)</div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {interviewClubs.map((club) => (
            <span key={club.id} style={{ border: "1px solid #f0d9a6", borderRadius: 999, padding: "4px 8px", fontSize: 12 }}>
              {club.clubName}
            </span>
          ))}
          {interviewClubs.length === 0 ? <span style={{ fontSize: 12, color: t.textSub }}>없음</span> : null}
        </div>
      </div>
    </section>
  );
}

function StudentMyPanel({ apps }) {
  return (
    <section style={cardStyle}>
      <h2 style={{ fontSize: 17, marginBottom: 12 }}>내 신청 현황</h2>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
          <thead>
            <tr>
              {["지망", "동아리", "상태", "결정/사유", "진로희망", "신청사유", "활동계획", "수정일"].map((head) => (
                <th key={head} style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}>
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {apps.map((row) => (
              <tr key={row.id}>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.preferenceRank}지망</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.club?.clubName || row.clubId}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}><StatusBadge status={row.status} /></td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, color: t.textSub }}>{decisionLabel(row)}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.careerGoal || "-"}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.applyReason || "-"}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, whiteSpace: "pre-wrap" }}>{row.wantedActivity || "-"}</td>
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, color: t.textSub }}>{formatTime(row.updatedAt || row.createdAt)}</td>
              </tr>
            ))}
            {apps.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 14, color: t.textSub, fontSize: 13 }}>
                  신청 내역이 없습니다.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestCardApplicationsDialog({
  open,
  card,
  rows,
  loading,
  onClose,
}) {
  if (!open) return null;

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 1000, padding: 16, overflowY: "auto" }}>
      <div style={{ maxWidth: 960, margin: "20px auto", ...cardStyle }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800 }}>{card?.title || "신청 카드"} 신청 현황</div>
            <div style={{ fontSize: 12, color: t.textSub }}>
              {requestCardTargetLabel(card?.targetRole)} · 모집 {card?.capacity || 0}명 · 신청 {card?.applicantCount || 0}명
            </div>
          </div>
          <button onClick={onClose} style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}` }}>닫기</button>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 720 }}>
            <thead>
              <tr>
                {["신청자", "아이디", "학번", "역할", "상태", "신청시각"].map((head) => (
                  <th
                    key={head}
                    style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}
                  >
                    {head}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const resultMeta = requestCardResultMeta(row.status);
                return (
                  <tr key={row.id}>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.applicantName || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.applicantLoginId || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.applicantStudentNo || "-"}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{roleLabel(row.applicantRole)}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      <span style={{ display: "inline-flex", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 700, background: resultMeta.bg, color: resultMeta.color }}>
                        {resultMeta.label}
                      </span>
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, color: t.textSub }}>{formatTime(row.createdAt)}</td>
                  </tr>
                );
              })}
              {!loading && rows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 16, fontSize: 13, color: t.textSub }}>
                    신청 내역이 없습니다.
                  </td>
                </tr>
              ) : null}
              {loading ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 16, fontSize: 13, color: t.textSub }}>
                    신청 현황을 불러오는 중...
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RequestCardAdminPanel({
  cards,
  form,
  setForm,
  editingId,
  loading,
  onRefresh,
  onSubmit,
  onStartEdit,
  onCancelEdit,
  onDelete,
  onDraw,
  onOpenApplications,
}) {
  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
        <div>
          <h2 style={{ fontSize: 17 }}>공통 신청 카드 관리</h2>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
            학생 또는 교사를 대상으로 별도 신청 카드와 랜덤 추첨을 운영합니다.
          </div>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
        >
          새로고침
        </button>
      </div>

      <div style={{ ...cardStyle, background: "#fafbfd", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>
          {editingId ? "신청 카드 수정" : "신청 카드 생성"}
        </div>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(0,0.8fr) minmax(0,0.6fr)", gap: 10 }}>
            <Field label="카드 제목">
              <input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                style={inputBase}
                placeholder="예: 체육대회 진행요원 신청"
              />
            </Field>
            <Field label="대상">
              <Select
                value={form.targetRole}
                onChange={(e) => setForm((prev) => ({ ...prev, targetRole: e.target.value }))}
              >
                <option value="student">학생 대상</option>
                <option value="teacher">교사 대상</option>
              </Select>
            </Field>
            <Field label="모집인원">
              <input
                type="number"
                min={1}
                value={form.capacity}
                onChange={(e) => setForm((prev) => ({ ...prev, capacity: e.target.value }))}
                style={inputBase}
              />
            </Field>
          </div>

          <Field label="내용">
            <textarea
              value={form.description}
              onChange={(e) => setForm((prev) => ({ ...prev, description: e.target.value }))}
              style={{ ...inputBase, minHeight: 88, resize: "vertical" }}
              placeholder="신청 대상에게 보여줄 안내 내용을 입력하세요."
            />
          </Field>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
            <Field label="신청 시작 일시">
              <input
                type="datetime-local"
                value={form.startAt}
                onChange={(e) => setForm((prev) => ({ ...prev, startAt: e.target.value }))}
                style={inputBase}
              />
            </Field>
            <Field label="신청 종료 일시">
              <input
                type="datetime-local"
                value={form.endAt}
                onChange={(e) => setForm((prev) => ({ ...prev, endAt: e.target.value }))}
                style={inputBase}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={onSubmit}
              disabled={loading}
              style={{ ...buttonBase, background: loading ? "#cfd8e3" : t.accent, color: "#fff", fontWeight: 700 }}
            >
              {editingId ? "수정 저장" : "카드 생성"}
            </button>
            {editingId ? (
              <button
                onClick={onCancelEdit}
                disabled={loading}
                style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
              >
                수정 취소
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 980 }}>
          <thead>
            <tr>
              {["제목", "대상", "상태", "신청기간", "모집", "신청", "당첨", "작업"].map((head) => (
                <th
                  key={head}
                  style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}
                >
                  {head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {cards.map((card) => {
              const state = getRequestCardState(card);
              const phaseMeta = requestCardPhaseMeta(state);
              const drawDisabled = loading || state.phase !== "closed";
              return (
                <tr key={card.id}>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13, fontWeight: 700 }}>{card.title}</td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{requestCardTargetLabel(card.targetRole)}</td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px" }}>
                    <span style={{ display: "inline-flex", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 700, background: phaseMeta.bg, color: phaseMeta.color }}>
                      {phaseMeta.label}
                    </span>
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 12, color: t.textSub }}>
                    {formatTime(card.startAt)} ~ {formatTime(card.endAt)}
                  </td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{card.capacity}명</td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{card.applicantCount || 0}명</td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px", fontSize: 13 }}>{card.selectedCount || 0}명</td>
                  <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px" }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button
                        onClick={() => onOpenApplications(card)}
                        disabled={loading}
                        style={{ ...buttonBase, padding: "5px 8px", background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
                      >
                        신청현황
                      </button>
                      <button
                        onClick={() => onDraw(card)}
                        disabled={drawDisabled}
                        style={{ ...buttonBase, padding: "5px 8px", background: drawDisabled ? "#cfd8e3" : "#fff3e0", color: drawDisabled ? "#6b7280" : t.warn, fontWeight: 700 }}
                      >
                        랜덤 추첨
                      </button>
                      <button
                        onClick={() => onStartEdit(card)}
                        disabled={loading || state.phase === "drawn"}
                        style={{ ...buttonBase, padding: "5px 8px", background: "#edf4ff", color: t.accent, fontWeight: 700 }}
                      >
                        수정
                      </button>
                      <button
                        onClick={() => onDelete(card)}
                        disabled={loading || state.phase === "drawn"}
                        style={{ ...buttonBase, padding: "5px 8px", background: "#ffebee", color: t.danger, fontWeight: 700 }}
                      >
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {cards.length === 0 ? (
              <tr>
                <td colSpan={8} style={{ textAlign: "center", padding: 16, fontSize: 13, color: t.textSub }}>
                  아직 생성된 신청 카드가 없습니다.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function RequestCardUserSection({
  user,
  cards,
  myApplications,
  loading,
  onRefresh,
  onApply,
  onCancel,
}) {
  const appMap = useMemo(
    () => new Map((myApplications || []).map((row) => [row.cardId, row])),
    [myApplications],
  );

  const visibleCards = useMemo(() => {
    const phaseRank = { open: 0, before: 1, closed: 2, drawn: 3, unconfigured: 4 };
    return (cards || [])
      .filter((card) => canUseRequestCard(card, user))
      .sort((a, b) => {
        const leftState = getRequestCardState(a);
        const rightState = getRequestCardState(b);
        const leftRank = phaseRank[leftState.phase] ?? 9;
        const rightRank = phaseRank[rightState.phase] ?? 9;
        if (leftRank !== rightRank) return leftRank - rightRank;
        return String(a.title || a.id).localeCompare(String(b.title || b.id), "ko");
      });
  }, [cards, user?.role]);

  return (
    <section style={cardStyle}>
      <div style={{ borderTop: `2px dashed ${t.border}`, paddingTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
          <div>
            <h2 style={{ fontSize: 17 }}>기타 신청 현황</h2>
            <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
              동아리 외에 관리자가 연 신청 항목을 여기서 신청하고 추첨 결과를 확인할 수 있습니다.
            </div>
          </div>
          <button
            onClick={onRefresh}
            disabled={loading}
            style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
          >
            새로고침
          </button>
        </div>

        {visibleCards.length === 0 ? (
          <div style={{ fontSize: 13, color: t.textSub }}>현재 신청 가능한 추가 카드가 없습니다.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {visibleCards.map((card) => {
              const state = getRequestCardState(card);
              const phaseMeta = requestCardPhaseMeta(state);
              const myApplication = appMap.get(card.id) || null;
              const resultMeta = requestCardResultMeta(myApplication?.status);
              const canApply = !myApplication && state.phase === "open";
              const canCancel = myApplication?.status === "applied" && state.phase === "open";
              return (
                <div key={card.id} style={{ ...cardStyle, background: "#fafbfd" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                        <div style={{ fontSize: 16, fontWeight: 800 }}>{card.title}</div>
                        <span style={{ display: "inline-flex", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 700, background: phaseMeta.bg, color: phaseMeta.color }}>
                          {phaseMeta.label}
                        </span>
                        {myApplication ? (
                          <span style={{ display: "inline-flex", borderRadius: 999, padding: "3px 8px", fontSize: 12, fontWeight: 700, background: resultMeta.bg, color: resultMeta.color }}>
                            {resultMeta.label}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 12, color: t.textSub }}>
                        {requestCardPhaseDescription(card, state)}
                      </div>
                    </div>
                    <div style={{ fontSize: 12, color: t.textSub, textAlign: "right" }}>
                      모집 {card.capacity}명 · 신청 {card.applicantCount || 0}명
                    </div>
                  </div>

                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap", lineHeight: 1.6, marginBottom: 10 }}>
                    {card.description}
                  </div>

                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    {canApply ? (
                      <button
                        onClick={() => onApply(card.id)}
                        disabled={loading}
                        style={{ ...buttonBase, background: loading ? "#cfd8e3" : t.accent, color: "#fff", fontWeight: 700 }}
                      >
                        신청
                      </button>
                    ) : null}
                    {canCancel ? (
                      <button
                        onClick={() => onCancel(card.id)}
                        disabled={loading}
                        style={{ ...buttonBase, background: loading ? "#cfd8e3" : "#fff", border: `1px solid ${t.border}`, color: t.textSub, fontWeight: 700 }}
                      >
                        신청 취소
                      </button>
                    ) : null}
                    {!canApply && !canCancel ? (
                      <span style={{ fontSize: 12, color: t.textSub }}>
                        {myApplication?.status === "selected"
                          ? "추첨 결과에 당첨되었습니다."
                          : myApplication?.status === "not_selected"
                            ? "이번 추첨에서는 선발되지 않았습니다."
                            : myApplication?.status === "applied"
                              ? state.phase === "closed"
                                ? "신청이 완료되었고 관리자의 랜덤 추첨을 기다리는 중입니다."
                                : "신청이 완료되었습니다."
                              : state.phase === "before"
                                ? "신청 시작 전입니다."
                                : state.phase === "closed"
                                  ? "신청 기간이 종료되어 추첨을 기다리는 중입니다."
                                  : state.phase === "drawn"
                                    ? "추첨이 완료되었습니다."
                                    : "현재는 신청할 수 없습니다."}
                      </span>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

function UserManagementPanel({
  currentUser,
  users,
  onRefresh,
  onCreate,
  onBulkUpload,
  onDownloadTemplate,
  onUpdate,
  onDelete,
  onResetPassword,
  onResetStudentPasswords,
  loading,
  bulkResetLoading,
}) {
  const [search, setSearch] = useState("");
  const [createForm, setCreateForm] = useState({
    loginId: "",
    password: "",
    name: "",
    role: "student",
    studentNo: "",
    subject: "",
  });

  const [editingUid, setEditingUid] = useState("");
  const [editForm, setEditForm] = useState({
    name: "",
    role: "student",
    studentNo: "",
    subject: "",
  });

  const filtered = users.filter((u) => {
    const q = search.trim();
    if (!q) return true;
    return (
      String(u.loginId || "").includes(q)
      || String(u.name || "").includes(q)
      || String(u.studentNo || "").includes(q)
      || String(u.role || "").includes(q)
    );
  });

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <section style={cardStyle}>
        <h2 style={{ fontSize: 17, marginBottom: 10 }}>회원 계정 생성</h2>
        <div style={{ display: "grid", gap: 10 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0,1fr))", gap: 10 }}>
            <Field label="아이디(교사명/학생학번)">
              <input
                style={inputBase}
                value={createForm.loginId}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, loginId: e.target.value }))}
              />
            </Field>
            <Field label="비밀번호">
              <input
                type="password"
                style={inputBase}
                value={createForm.password}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, password: e.target.value }))}
              />
            </Field>
            <Field label="이름">
              <input
                style={inputBase}
                value={createForm.name}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, name: e.target.value }))}
              />
            </Field>
            <Field label="역할">
              <Select
                value={createForm.role}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, role: e.target.value }))}
              >
                <option value="student">학생</option>
                <option value="teacher">교사</option>
                <option value="admin">관리자</option>
              </Select>
            </Field>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0,1fr))", gap: 10 }}>
            <Field label="학번(학생만)">
              <input
                style={inputBase}
                value={createForm.studentNo}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, studentNo: e.target.value }))}
                placeholder="5자리 숫자"
              />
            </Field>
            <Field label="과목(교사)">
              <input
                style={inputBase}
                value={createForm.subject}
                onChange={(e) => setCreateForm((prev) => ({ ...prev, subject: e.target.value }))}
              />
            </Field>
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              onClick={() => onCreate(createForm)}
              disabled={loading}
              style={{ ...buttonBase, background: t.accent, color: "#fff", fontWeight: 700 }}
            >
              계정 생성
            </button>
            <button
              onClick={onDownloadTemplate}
              disabled={loading}
              style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
            >
              엑셀 템플릿 다운로드
            </button>
            <label style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}>
              엑셀 일괄 등록
              <input
                type="file"
                accept=".xlsx,.xls"
                style={{ display: "none" }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onBulkUpload(file);
                  e.target.value = "";
                }}
              />
            </label>
            <button
              onClick={onRefresh}
              disabled={loading}
              style={{ ...buttonBase, background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
            >
              새로고침
            </button>
          </div>
        </div>
      </section>

      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, marginBottom: 10, alignItems: "center", flexWrap: "wrap" }}>
          <h2 style={{ fontSize: 17 }}>회원 목록</h2>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={onResetStudentPasswords}
              disabled={bulkResetLoading || loading}
              style={{
                ...buttonBase,
                background: bulkResetLoading || loading ? "#cfd8e3" : "#fff3e0",
                color: bulkResetLoading || loading ? "#6b7280" : t.warn,
                fontWeight: 700,
              }}
            >
              {bulkResetLoading ? "학생 비번 초기화 중..." : "학생 비번 일괄 초기화"}
            </button>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ ...inputBase, width: 260 }}
              placeholder="아이디/이름/학번 검색"
            />
          </div>
        </div>

        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 920 }}>
            <thead>
              <tr>
                {["아이디", "이름", "역할", "학번", "과목", "작업"].map((head) => (
                  <th key={head} style={{ textAlign: "left", padding: "8px 6px", borderBottom: `1px solid ${t.border}`, fontSize: 12, color: t.textSub }}>{head}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((row) => {
                const editing = editingUid === row.uid;
                return (
                  <tr key={row.uid}>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 13 }}>{row.loginId}</td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      {editing ? (
                        <input
                          value={editForm.name}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, name: e.target.value }))}
                          style={{ ...inputBase, padding: "6px 8px" }}
                        />
                      ) : (
                        <span style={{ fontSize: 13 }}>{row.name || "-"}</span>
                      )}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      {editing ? (
                        <Select
                          value={editForm.role}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, role: e.target.value }))}
                        >
                          <option value="student">학생</option>
                          <option value="teacher">교사</option>
                          <option value="admin">관리자</option>
                        </Select>
                      ) : (
                        <span style={{ fontSize: 13 }}>{roleLabel(row.role)}</span>
                      )}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      {editing ? (
                        <input
                          value={editForm.studentNo}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, studentNo: e.target.value }))}
                          style={{ ...inputBase, padding: "6px 8px" }}
                        />
                      ) : (
                        <span style={{ fontSize: 13 }}>{row.studentNo || "-"}</span>
                      )}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      {editing ? (
                        <input
                          value={editForm.subject}
                          onChange={(e) => setEditForm((prev) => ({ ...prev, subject: e.target.value }))}
                          style={{ ...inputBase, padding: "6px 8px" }}
                        />
                      ) : (
                        <span style={{ fontSize: 13 }}>{row.subject || "-"}</span>
                      )}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px" }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        {editing ? (
                          <>
                            <button
                              onClick={async () => {
                                await onUpdate(row, editForm);
                                setEditingUid("");
                              }}
                              style={{ ...buttonBase, padding: "5px 8px", background: "#e8f5e9", color: t.ok, fontWeight: 700 }}
                            >
                              저장
                            </button>
                            <button
                              onClick={() => setEditingUid("")}
                              style={{ ...buttonBase, padding: "5px 8px", background: "#fff", border: `1px solid ${t.border}`, color: t.textSub }}
                            >
                              취소
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => {
                              setEditingUid(row.uid);
                              setEditForm({
                                name: row.name || "",
                                role: row.role || "student",
                                studentNo: row.studentNo || "",
                                subject: row.subject || "",
                              });
                            }}
                            style={{ ...buttonBase, padding: "5px 8px", background: "#fff", border: `1px solid ${t.border}` }}
                          >
                            수정
                          </button>
                        )}

                        <button
                          onClick={() => onResetPassword(row)}
                          style={{ ...buttonBase, padding: "5px 8px", background: "#fff3e0", color: t.warn, fontWeight: 700 }}
                        >
                          비번초기화
                        </button>

                        <button
                          onClick={() => onDelete(row)}
                          disabled={row.uid === currentUser?.uid}
                          style={{
                            ...buttonBase,
                            padding: "5px 8px",
                            background: row.uid === currentUser?.uid ? "#cfd8e3" : "#ffebee",
                            color: row.uid === currentUser?.uid ? "#6b7280" : t.danger,
                            fontWeight: 700,
                          }}
                        >
                          삭제
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ textAlign: "center", padding: 14, color: t.textSub, fontSize: 13 }}>
                    사용자 데이터가 없습니다.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function ProfilePanel({ user, onSave, onChangePassword, loading, passwordLoading }) {
  const [form, setForm] = useState({
    name: user?.name || "",
    subject: user?.subject || "",
  });
  const [passwordForm, setPasswordForm] = useState({
    currentPassword: "",
    nextPassword: "",
    confirmPassword: "",
  });

  useEffect(() => {
    setForm({
      name: user?.name || "",
      subject: user?.subject || "",
    });
  }, [user?.uid, user?.name, user?.subject]);

  return (
    <section style={{ ...cardStyle, maxWidth: 600 }}>
      <h2 style={{ fontSize: 17, marginBottom: 12 }}>내 정보</h2>

      <div style={{ display: "grid", gap: 10 }}>
        <Field label="아이디">
          <input value={user?.loginId || ""} readOnly style={{ ...inputBase, background: t.muted }} />
        </Field>

        <Field label="역할">
          <input value={roleLabel(user?.role)} readOnly style={{ ...inputBase, background: t.muted }} />
        </Field>

        {user?.role === "student" ? (
          <Field label="학번">
            <input value={user?.studentNo || ""} readOnly style={{ ...inputBase, background: t.muted }} />
          </Field>
        ) : null}

        <Field label="이름">
          <input
            value={form.name}
            onChange={(e) => setForm((prev) => ({ ...prev, name: e.target.value }))}
            style={inputBase}
          />
        </Field>

        {(user?.role === "teacher" || user?.role === "admin") ? (
          <Field label="과목">
            <input
              value={form.subject}
              onChange={(e) => setForm((prev) => ({ ...prev, subject: e.target.value }))}
              style={inputBase}
            />
          </Field>
        ) : null}

        <button
          onClick={() => onSave(form)}
          disabled={loading}
          style={{
            ...buttonBase,
            background: loading ? "#cfd8e3" : t.accent,
            color: "#fff",
            fontWeight: 700,
            justifySelf: "start",
          }}
        >
          {loading ? "저장 중..." : "저장"}
        </button>
      </div>

      <div style={{ marginTop: 14, paddingTop: 14, borderTop: `1px solid ${t.border}`, display: "grid", gap: 10 }}>
        <h3 style={{ fontSize: 15 }}>비밀번호 변경</h3>
        <div style={{ ...cardStyle, background: "#fff8e1", borderColor: "#f3dfb9", padding: "8px 10px", fontSize: 12, color: t.warn }}>
          비밀번호는 암호화되어 저장됩니다. 분실 시 기존 비밀번호를 확인할 수 없어 비밀번호 초기화만 가능합니다.
        </div>
        <Field label="현재 비밀번호">
          <input
            type="password"
            value={passwordForm.currentPassword}
            onChange={(e) => setPasswordForm((prev) => ({ ...prev, currentPassword: e.target.value }))}
            style={inputBase}
          />
        </Field>
        <Field label="새 비밀번호" hint="6자 이상">
          <input
            type="password"
            value={passwordForm.nextPassword}
            onChange={(e) => setPasswordForm((prev) => ({ ...prev, nextPassword: e.target.value }))}
            style={inputBase}
          />
        </Field>
        <Field label="새 비밀번호 확인">
          <input
            type="password"
            value={passwordForm.confirmPassword}
            onChange={(e) => setPasswordForm((prev) => ({ ...prev, confirmPassword: e.target.value }))}
            style={inputBase}
          />
        </Field>
        <button
          onClick={async () => {
            const changed = await onChangePassword(
              passwordForm.currentPassword,
              passwordForm.nextPassword,
              passwordForm.confirmPassword,
            );
            if (changed) {
              setPasswordForm({
                currentPassword: "",
                nextPassword: "",
                confirmPassword: "",
              });
            }
          }}
          disabled={passwordLoading}
          style={{
            ...buttonBase,
            background: passwordLoading ? "#cfd8e3" : t.accent,
            color: "#fff",
            fontWeight: 700,
            justifySelf: "start",
          }}
        >
          {passwordLoading ? "변경 중..." : "비밀번호 변경"}
        </button>
      </div>
    </section>
  );
}

function newClubForm(user, defaultRoom = "미정") {
  return {
    clubName: "",
    teacherUid: user?.role === "teacher" ? user.uid : "",
    leaderUid: "",
    targetGrades: [1],
    description: "",
    room: defaultRoom || "미정",
    maxMembers: 20,
    isInterviewSelection: false,
  };
}

function newRequestCardForm() {
  return {
    title: "",
    targetRole: "student",
    capacity: 1,
    description: "",
    startAt: "",
    endAt: "",
  };
}

export default function PrototypeApp() {
  const {
    user,
    isAuthenticated,
    isLoading,
    lastSyncError,
    signInWithCredentials,
    signOut,
  } = useAuth();

  const [tab, setTab] = useState("clubs");
  const [loading, setLoading] = useState(false);
  const [loginLoading, setLoginLoading] = useState(false);
  const [myPasswordLoading, setMyPasswordLoading] = useState(false);
  const [bulkResetLoading, setBulkResetLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [message, setMessage] = useState({ type: "", text: "" });

  const [clubs, setClubs] = useState([]);
  const [clubRooms, setClubRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [cycle, setCycle] = useState({ id: "current", currentRound: 1, status: "open" });
  const [roundStats, setRoundStats] = useState({});
  const [myDraft, setMyDraft] = useState(null);
  const [myApplications, setMyApplications] = useState([]);
  const [studentStatusRows, setStudentStatusRows] = useState([]);
  const [studentStatusLoading, setStudentStatusLoading] = useState(false);
  const [studentStatusDialog, setStudentStatusDialog] = useState({ open: false, studentUid: "" });
  const [preAssignmentWindowForm, setPreAssignmentWindowForm] = useState({ start: "", end: "" });
  const [submissionWindowForm, setSubmissionWindowForm] = useState({ start: "", end: "" });
  const [requestCards, setRequestCards] = useState([]);
  const [myRequestCardApplications, setMyRequestCardApplications] = useState([]);

  const [clubForm, setClubForm] = useState(newClubForm(user));
  const [editingClubId, setEditingClubId] = useState("");
  const [savingClub, setSavingClub] = useState(false);
  const [savingRoom, setSavingRoom] = useState(false);
  const [forceAssignLoading, setForceAssignLoading] = useState(false);
  const [clubFormDialogOpen, setClubFormDialogOpen] = useState(false);
  const [requestCardForm, setRequestCardForm] = useState(newRequestCardForm());
  const [editingRequestCardId, setEditingRequestCardId] = useState("");
  const [requestCardLoading, setRequestCardLoading] = useState(false);
  const [requestCardDialog, setRequestCardDialog] = useState({
    open: false,
    card: null,
    rows: [],
    loading: false,
  });

  const [applicantDialog, setApplicantDialog] = useState({
    open: false,
    club: null,
    rows: [],
    loading: false,
  });
  const [clubDetailDialog, setClubDetailDialog] = useState({
    open: false,
    club: null,
  });

  const [interviewDialog, setInterviewDialog] = useState({
    open: false,
    club: null,
    members: [],
    keyword: "",
    loading: false,
  });

  const [studentSubmitLoading, setStudentSubmitLoading] = useState(false);

  const userMap = useMemo(() => new Map(users.map((u) => [u.uid, u])), [users]);

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const nextTab = user.role === "admin"
      ? "clubs"
      : user.role === "teacher"
        ? "myClubs"
        : "apply";
    setTab(nextTab);
    setClubFormDialogOpen(false);
    setClubForm(newClubForm(user));
    setEditingRequestCardId("");
    setRequestCardForm(newRequestCardForm());
  }, [isAuthenticated, user?.uid, user?.role]);

  async function refreshCycle() {
    let current = await getCurrentRecruitmentCycle();
    if (getSubmissionWindowState(current).needsFinalization) {
      await finalizeCurrentCycleDraftsIfNeeded();
      current = await getCurrentRecruitmentCycle();
    }
    setCycle(current);
    setPreAssignmentWindowForm({
      start: toDatetimeLocalValue(current.preAssignmentStartAt),
      end: toDatetimeLocalValue(current.preAssignmentEndAt),
    });
    setSubmissionWindowForm({
      start: toDatetimeLocalValue(current.submissionStartAt),
      end: toDatetimeLocalValue(current.submissionEndAt),
    });
    return current;
  }

  async function refreshClubs() {
    const rows = await listSchedules();
    setClubs(rows);
    return rows;
  }

  async function refreshUsers() {
    const rows = await listUsers();
    setUsers(rows);
    return rows;
  }

  async function refreshClubRooms() {
    const rows = await listClubRooms();
    setClubRooms(rows);
    return rows;
  }

  async function refreshMyApplications() {
    if (!user?.uid || user?.role !== "student") {
      setMyApplications([]);
      return [];
    }
    const rows = await listStudentApplications(user.uid);
    setMyApplications(rows);
    return rows;
  }

  async function refreshMyDraft() {
    if (!user?.uid || user?.role !== "student") {
      setMyDraft(null);
      return null;
    }
    const draft = await getStudentPreferenceDraft(user.uid);
    setMyDraft(draft);
    return draft;
  }

  async function refreshRequestCards() {
    const rows = await listRequestCards();
    setRequestCards(rows);
    return rows;
  }

  async function refreshMyRequestCardApplications() {
    if (user?.role !== "student" && user?.role !== "teacher" && user?.role !== "admin") {
      setMyRequestCardApplications([]);
      return [];
    }
    const rows = await listRequestCardApplicationsByApplicant(user.uid);
    setMyRequestCardApplications(rows);
    return rows;
  }

  async function refreshStudentStatusRows(studentUsers = null, clubRows = null) {
    if (user?.role !== "admin" && user?.role !== "teacher") {
      setStudentStatusRows([]);
      return [];
    }

    const baseStudents = Array.isArray(studentUsers)
      ? studentUsers.filter((row) => row.role === "student")
      : users.filter((row) => row.role === "student");
    const baseClubs = Array.isArray(clubRows) ? clubRows : clubs;
    const [applications, drafts] = await Promise.all([
      listCurrentCycleApplications(),
      listCurrentCycleDrafts(),
    ]);
    const rows = buildStudentApplicationStatusRows(baseStudents, baseClubs, applications, drafts);
    setStudentStatusRows(rows);
    return rows;
  }

  async function refreshRecruitmentViews(clubRows = clubs, cycleInfo = cycle, studentUsers = users) {
    await Promise.all([
      refreshRoundStats(clubRows, cycleInfo),
      refreshStudentStatusRows(studentUsers, clubRows),
    ]);
  }

  async function refreshRoundStats(clubList = clubs, cycleInfo = cycle) {
    const next = {};

    await Promise.all(
      clubList.map(async (club) => {
        if (club.legacy) return;
        const apps = await listApplicationsBySchedule(club.id);
        next[club.id] = {
          clubId: club.id,
          clubName: club.clubName,
          pendingCurrent: apps.filter(
            (row) => row.status === "pending" && Number(row.preferenceRank) === Number(cycleInfo.currentRound || 1),
          ).length,
          total: apps.length,
          approved: apps.filter((row) => row.status === "approved").length,
          rejected: apps.filter((row) => row.status === "rejected").length,
          cancelled: apps.filter((row) => row.status === "cancelled").length,
        };
      }),
    );

    setRoundStats(next);
    return next;
  }

  async function loadAll() {
    if (!isAuthenticated || !user) return;
    setLoading(true);
    try {
      let clubRows = await refreshClubs();
      const cycleInfo = await refreshCycle();
      const syncResult = await syncLeaderAssignmentsForClubs(clubRows, { continueOnError: true });
      if (syncResult.changed > 0) {
        clubRows = await refreshClubs();
      }
      const [userRows] = await Promise.all([
        refreshUsers(),
        refreshMyApplications(),
        refreshMyDraft(),
        refreshClubRooms(),
        refreshRequestCards(),
        refreshMyRequestCardApplications(),
      ]);
      await refreshRecruitmentViews(clubRows, cycleInfo, userRows);
      setMessage({ type: "", text: "" });
    } catch (error) {
      setMessage({ type: "error", text: error instanceof Error ? error.message : "데이터 로딩에 실패했습니다." });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!isAuthenticated || !user) return;
    loadAll();
  }, [isAuthenticated, user?.uid, user?.role]);

  useEffect(() => {
    if (!lastSyncError) return;
    setMessage({ type: "error", text: lastSyncError });
  }, [lastSyncError]);

  useEffect(() => {
    if (!message?.text) return undefined;
    const timeoutId = window.setTimeout(() => {
      setMessage({ type: "", text: "" });
    }, 3200);
    return () => window.clearTimeout(timeoutId);
  }, [message?.text, message?.type]);

  async function handleLogin({ loginId, password, tab: loginTab, studentName }) {
    setLoginLoading(true);
    setLoginError("");
    try {
      await signInWithCredentials(loginId, password, {
        loginRole: loginTab,
        studentName,
      });
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "로그인 실패");
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    setMessage({ type: "", text: "" });
    setLoginError("");
  }

  function withMessageError(error, fallback) {
    setMessage({
      type: "error",
      text: error instanceof Error ? error.message : fallback,
    });
  }

  function resetClubForm() {
    setEditingClubId("");
    setClubForm(newClubForm(user, getDefaultRoomName(clubRooms)));
  }

  function closeClubFormDialog() {
    setClubFormDialogOpen(false);
    resetClubForm();
  }

  function openCreateClubDialog() {
    resetClubForm();
    setClubFormDialogOpen(true);
  }

  function resetRequestCardForm() {
    setEditingRequestCardId("");
    setRequestCardForm(newRequestCardForm());
  }

  async function reloadRequestCardDialog(card) {
    if (!card?.id) return;
    setRequestCardDialog((prev) => ({ ...prev, loading: true }));
    try {
      const [cardRows, rows] = await Promise.all([
        refreshRequestCards(),
        listRequestCardApplicationsByCard(card.id),
      ]);
      const latestCard = cardRows.find((item) => item.id === card.id) || card;
      setRequestCardDialog({
        open: true,
        card: latestCard,
        rows,
        loading: false,
      });
    } catch (error) {
      withMessageError(error, "신청 카드 현황을 불러오지 못했습니다.");
      setRequestCardDialog((prev) => ({ ...prev, loading: false }));
    }
  }

  async function openRequestCardDialog(card) {
    setRequestCardDialog({ open: true, card, rows: [], loading: true });
    await reloadRequestCardDialog(card);
  }

  async function handleSaveClub() {
    setSavingClub(true);
    try {
      const payload = {
        clubName: String(clubForm.clubName || "").trim(),
        teacherUid: String(clubForm.teacherUid || "").trim(),
        leaderUid: String(clubForm.leaderUid || "").trim(),
        targetGrades: Array.isArray(clubForm.targetGrades) ? clubForm.targetGrades : [],
        description: String(clubForm.description || "").trim(),
        room: String(clubForm.room || "").trim() || "미정",
        maxMembers: Number(clubForm.maxMembers || 0),
        isInterviewSelection: Boolean(clubForm.isInterviewSelection),
      };

      const savedClub = editingClubId
        ? await updateSchedule(editingClubId, payload, { actor: user })
        : await createSchedule(payload, { actor: user });
      await syncLeaderAssignmentForClub(savedClub);

      if (editingClubId) {
        setMessage({ type: "ok", text: "동아리 정보를 수정했습니다." });
      } else {
        setMessage({ type: "ok", text: "동아리를 생성했습니다." });
      }

      setClubFormDialogOpen(false);
      resetClubForm();
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await refreshRecruitmentViews(clubRows, cycleInfo);
    } catch (error) {
      withMessageError(error, "동아리 저장에 실패했습니다.");
    } finally {
      setSavingClub(false);
    }
  }

  function handleEditClub(club) {
    setEditingClubId(club.id);
    setClubForm({
      clubName: club.clubName || "",
      teacherUid: club.teacherUid || "",
      leaderUid: club.leaderUid || "",
      targetGrades: Array.isArray(club.targetGrades) && club.targetGrades.length > 0 ? [...club.targetGrades] : [1],
      description: club.description || "",
      room: club.room || getDefaultRoomName(clubRooms),
      maxMembers: club.maxMembers || 1,
      isInterviewSelection: Boolean(club.isInterviewSelection),
    });
    setClubFormDialogOpen(true);
  }

  async function handleCreateClubRoom(name) {
    setSavingRoom(true);
    try {
      const normalized = String(name || "").trim() || "미정";
      await createClubRoom(normalized, { actor: user });
      await refreshClubRooms();
      setMessage({ type: "ok", text: `동아리실을 등록했습니다. (${normalized})` });
      return true;
    } catch (error) {
      withMessageError(error, "동아리실 등록에 실패했습니다.");
      return false;
    } finally {
      setSavingRoom(false);
    }
  }

  async function handleDeleteClubRoom(room) {
    if (!room?.id) return false;
    if (!window.confirm(`동아리실 '${room.name}'을 삭제하시겠습니까?`)) return false;
    setSavingRoom(true);
    try {
      await deleteClubRoom(room.id, { actor: user });
      await refreshClubRooms();
      if (String(clubForm.room || "").trim() === String(room.name || "").trim()) {
        setClubForm((prev) => ({ ...prev, room: "미정" }));
      }
      setMessage({ type: "ok", text: `동아리실을 삭제했습니다. (${room.name})` });
      return true;
    } catch (error) {
      withMessageError(error, "동아리실 삭제에 실패했습니다.");
      return false;
    } finally {
      setSavingRoom(false);
    }
  }

  async function handleDeleteClub(club) {
    if (!window.confirm(`동아리 '${club.clubName}'를 삭제하시겠습니까?`)) return;
    try {
      await deleteSchedule(club.id, { actor: user });
      setMessage({ type: "ok", text: "동아리를 삭제했습니다." });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await refreshRecruitmentViews(clubRows, cycleInfo);
      if (editingClubId === club.id) {
        closeClubFormDialog();
      }
    } catch (error) {
      withMessageError(error, "동아리 삭제에 실패했습니다.");
    }
  }

  async function handleSaveRequestCard() {
    setRequestCardLoading(true);
    try {
      const payload = {
        title: String(requestCardForm.title || "").trim(),
        targetRole: String(requestCardForm.targetRole || "student").trim(),
        capacity: Number(requestCardForm.capacity || 0),
        description: String(requestCardForm.description || "").trim(),
        startAt: requestCardForm.startAt,
        endAt: requestCardForm.endAt,
      };

      if (editingRequestCardId) {
        await updateRequestCard(editingRequestCardId, payload, { actor: user });
        setMessage({ type: "ok", text: "신청 카드를 수정했습니다." });
      } else {
        await createRequestCard(payload, { actor: user });
        setMessage({ type: "ok", text: "신청 카드를 생성했습니다." });
      }

      resetRequestCardForm();
      const rows = await refreshRequestCards();
      if (requestCardDialog.open && requestCardDialog.card?.id) {
        const latestCard = rows.find((row) => row.id === requestCardDialog.card.id) || requestCardDialog.card;
        await reloadRequestCardDialog(latestCard);
      }
    } catch (error) {
      withMessageError(error, "신청 카드 저장에 실패했습니다.");
    } finally {
      setRequestCardLoading(false);
    }
  }

  function handleEditRequestCard(card) {
    setEditingRequestCardId(card.id);
    setRequestCardForm({
      title: card.title || "",
      targetRole: card.targetRole || "student",
      capacity: card.capacity || 1,
      description: card.description || "",
      startAt: toDatetimeLocalValue(card.startAt),
      endAt: toDatetimeLocalValue(card.endAt),
    });
  }

  async function handleDeleteRequestCard(card) {
    if (!window.confirm(`신청 카드 '${card.title}'를 삭제하시겠습니까?`)) return;

    setRequestCardLoading(true);
    try {
      await deleteRequestCard(card.id, { actor: user });
      setMessage({ type: "ok", text: "신청 카드를 삭제했습니다." });
      if (editingRequestCardId === card.id) {
        resetRequestCardForm();
      }
      if (requestCardDialog.open && requestCardDialog.card?.id === card.id) {
        setRequestCardDialog({ open: false, card: null, rows: [], loading: false });
      }
      await Promise.all([refreshRequestCards(), refreshMyRequestCardApplications()]);
    } catch (error) {
      withMessageError(error, "신청 카드 삭제에 실패했습니다.");
    } finally {
      setRequestCardLoading(false);
    }
  }

  async function handleDrawRequestCard(card) {
    const confirmMessage = [
      `'${card.title}' 카드를 랜덤 추첨할까요?`,
      `모집 ${card.capacity}명 / 현재 신청 ${card.applicantCount || 0}명`,
    ].join("\n");
    if (!window.confirm(confirmMessage)) return;

    setRequestCardLoading(true);
    try {
      const result = await drawRequestCardWinners({ cardId: card.id, actor: user });
      setMessage({
        type: "ok",
        text: `랜덤 추첨 완료: 총 ${result.applicantCount}명 중 ${result.selectedCount}명 선발`,
      });
      await Promise.all([refreshRequestCards(), refreshMyRequestCardApplications()]);
      if (requestCardDialog.open && requestCardDialog.card?.id === card.id) {
        await reloadRequestCardDialog(card);
      }
    } catch (error) {
      withMessageError(error, "랜덤 추첨에 실패했습니다.");
    } finally {
      setRequestCardLoading(false);
    }
  }

  async function handleApplyRequestCard(cardId) {
    setRequestCardLoading(true);
    try {
      await applyToRequestCard({ cardId, actor: user });
      setMessage({ type: "ok", text: "신청했습니다." });
      await Promise.all([refreshRequestCards(), refreshMyRequestCardApplications()]);
    } catch (error) {
      withMessageError(error, "신청에 실패했습니다.");
    } finally {
      setRequestCardLoading(false);
    }
  }

  async function handleCancelRequestCard(cardId) {
    if (!window.confirm("신청을 취소할까요?")) return;

    setRequestCardLoading(true);
    try {
      await cancelRequestCardApplication({ cardId, actor: user });
      setMessage({ type: "ok", text: "신청을 취소했습니다." });
      await Promise.all([refreshRequestCards(), refreshMyRequestCardApplications()]);
    } catch (error) {
      withMessageError(error, "신청 취소에 실패했습니다.");
    } finally {
      setRequestCardLoading(false);
    }
  }

  function openClubDetail(club) {
    setClubDetailDialog({ open: true, club });
  }

  function closeClubDetail() {
    setClubDetailDialog({ open: false, club: null });
  }

  async function openApplicantDialog(club) {
    setApplicantDialog({ open: true, club, rows: [], loading: true });
    try {
      const rows = await listApplicationsBySchedule(club.id);
      setApplicantDialog({ open: true, club, rows, loading: false });
    } catch (error) {
      withMessageError(error, "신청 목록을 불러오지 못했습니다.");
      setApplicantDialog({ open: false, club: null, rows: [], loading: false });
    }
  }

  async function reloadApplicantDialog(club) {
    if (!club) return;
    setApplicantDialog((prev) => ({ ...prev, loading: true }));
    try {
      const [rows, clubsData, cycleInfo] = await Promise.all([
        listApplicationsBySchedule(club.id),
        refreshClubs(),
        refreshCycle(),
      ]);
      await refreshRecruitmentViews(clubsData, cycleInfo);

      const latestClub = clubsData.find((item) => item.id === club.id) || club;
      setApplicantDialog({ open: true, club: latestClub, rows, loading: false });
    } catch (error) {
      withMessageError(error, "신청 목록을 새로고침하지 못했습니다.");
      setApplicantDialog((prev) => ({ ...prev, loading: false }));
    }
  }

  async function handleApproveApplication(row) {
    try {
      await approveApplication({ applicationId: row.id, actor: user });
      setMessage({ type: "ok", text: "승인 처리했습니다." });
      await reloadApplicantDialog(applicantDialog.club);
      await refreshMyApplications();
    } catch (error) {
      withMessageError(error, "승인 처리에 실패했습니다.");
    }
  }

  async function handleRejectApplication(row) {
    try {
      await rejectApplication({ applicationId: row.id, actor: user, reason: "manual" });
      setMessage({ type: "ok", text: "반려 처리했습니다." });
      await reloadApplicantDialog(applicantDialog.club);
      await refreshMyApplications();
    } catch (error) {
      withMessageError(error, "반려 처리에 실패했습니다.");
    }
  }

  async function handleRevokeApprovedApplication(row) {
    if (!window.confirm(`${row.studentName || "해당 학생"}의 승인 상태를 취소할까요?`)) {
      return;
    }

    try {
      await revokeApprovedApplication({ applicationId: row.id, actor: user });
      setMessage({ type: "ok", text: "승인 취소 처리했습니다." });
      await reloadApplicantDialog(applicantDialog.club);
      await refreshMyApplications();
    } catch (error) {
      withMessageError(error, "승인 취소에 실패했습니다.");
    }
  }

  async function handleRandomSelection() {
    try {
      const result = await randomSelectPending({
        clubId: applicantDialog.club?.id,
        actor: user,
      });
      setMessage({
        type: "ok",
        text: `무작위 선발 완료: 승인 ${result.selected}명, 반려 ${result.rejected}명`,
      });
      await reloadApplicantDialog(applicantDialog.club);
      await refreshMyApplications();
    } catch (error) {
      withMessageError(error, "무작위 선발에 실패했습니다.");
    }
  }

  async function handleManualAssignStudent(studentUid) {
    const clubId = applicantDialog.club?.id;
    const targetUid = String(studentUid || "").trim();
    if (!clubId || !targetUid) {
      setMessage({ type: "error", text: "배정할 학생을 먼저 선택해주세요." });
      return false;
    }

    try {
      await directAssignStudentToClub({
        clubId,
        studentUid: targetUid,
        actor: user,
      });
      const selected = users.find((row) => row.uid === targetUid);
      setMessage({
        type: "ok",
        text: `${selected?.name || "선택한 학생"} 학생을 수동 배정 승인했습니다.`,
      });
      await reloadApplicantDialog(applicantDialog.club);
      await refreshMyApplications();
      return true;
    } catch (error) {
      withMessageError(error, "수동 배정 승인에 실패했습니다.");
      return false;
    }
  }

  async function handleAdminForceAssign({ studentUid, clubId, reason }) {
    const targetStudent = users.find((row) => row.uid === studentUid);
    const targetClub = clubs.find((row) => row.id === clubId);

    if (!studentUid || !clubId) {
      setMessage({ type: "error", text: "학생과 동아리를 먼저 선택해주세요." });
      return false;
    }

    const confirmMessage = [
      `${targetStudent?.name || "선택한 학생"} 학생을`,
      `${targetClub?.clubName || "선택한 동아리"}로 강제 배정할까요?`,
      "",
      `사유: ${String(reason || "").trim()}`,
    ].join("\n");
    if (!window.confirm(confirmMessage)) {
      return false;
    }

    setForceAssignLoading(true);
    try {
      await adminForceAssignStudentToClub({
        studentUid,
        clubId,
        reason,
        actor: user,
      });
      setMessage({
        type: "ok",
        text: `${targetStudent?.name || "선택한 학생"} 학생을 ${targetClub?.clubName || "선택한 동아리"}로 강제 배정했습니다.`,
      });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await Promise.all([
        refreshRecruitmentViews(clubRows, cycleInfo),
        refreshMyDraft(),
        refreshMyApplications(),
      ]);
      if (applicantDialog.open && applicantDialog.club) {
        await reloadApplicantDialog(applicantDialog.club);
      }
      if (interviewDialog.open && interviewDialog.club) {
        await reloadInterviewDialog(interviewDialog.club);
      }
      return true;
    } catch (error) {
      withMessageError(error, "강제 배정에 실패했습니다.");
      return false;
    } finally {
      setForceAssignLoading(false);
    }
  }

  async function openInterviewDialog(club) {
    setInterviewDialog({
      open: true,
      club,
      members: [],
      keyword: "",
      loading: true,
    });

    try {
      const members = await listClubMembers(club.id);
      setInterviewDialog({
        open: true,
        club,
        members,
        keyword: "",
        loading: false,
      });
    } catch (error) {
      withMessageError(error, "동아리 구성원을 불러오지 못했습니다.");
      setInterviewDialog({ open: false, club: null, members: [], keyword: "", loading: false });
    }
  }

  async function reloadInterviewDialog(club) {
    if (!club) return;
    setInterviewDialog((prev) => ({ ...prev, loading: true }));
    try {
      const [members, clubsData, cycleInfo] = await Promise.all([
        listClubMembers(club.id),
        refreshClubs(),
        refreshCycle(),
      ]);
      await refreshRecruitmentViews(clubsData, cycleInfo);

      const latestClub = clubsData.find((item) => item.id === club.id) || club;
      setInterviewDialog((prev) => ({
        ...prev,
        open: true,
        club: latestClub,
        members,
        loading: false,
      }));
    } catch (error) {
      withMessageError(error, "선발 목록 갱신에 실패했습니다.");
      setInterviewDialog((prev) => ({ ...prev, loading: false }));
    }
  }

  async function handleDirectSelect(student) {
    try {
      await directSelectInterviewMember({
        clubId: interviewDialog.club?.id,
        studentUid: student.uid,
        actor: user,
      });
      setMessage({ type: "ok", text: `${student.name} 학생을 선발했습니다.` });
      await reloadInterviewDialog(interviewDialog.club);
      await refreshMyApplications();
    } catch (error) {
      withMessageError(error, "직접 선발에 실패했습니다.");
    }
  }

  async function handleAdvanceRound() {
    try {
      const next = await advanceRecruitmentRound({ actor: user });
      setCycle(next);
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await Promise.all([
        refreshRecruitmentViews(clubRows, cycleInfo),
        refreshMyApplications(),
      ]);
      setMessage({ type: "ok", text: cycleInfo.status === "closed" ? "모집 사이클을 종료했습니다." : `${cycleInfo.currentRound}라운드로 전환했습니다.` });
    } catch (error) {
      withMessageError(error, "라운드 전환에 실패했습니다.");
    }
  }

  async function handleCleanupRecruitment() {
    const confirmed = window.confirm("기존 모집 데이터(동아리/신청/라운드)를 전부 삭제하고 초기화할까요?");
    if (!confirmed) return;

    try {
      await purgeLegacyRecruitmentData({ actor: user });
      setMessage({ type: "ok", text: "모집 데이터를 초기화했습니다." });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await Promise.all([
        refreshRecruitmentViews(clubRows, cycleInfo),
        refreshMyDraft(),
        refreshMyApplications(),
      ]);
      if (applicantDialog.open) {
        setApplicantDialog({ open: false, club: null, rows: [], loading: false });
      }
      if (interviewDialog.open) {
        setInterviewDialog({ open: false, club: null, members: [], keyword: "", loading: false });
      }
    } catch (error) {
      withMessageError(error, "모집 데이터 초기화에 실패했습니다.");
    }
  }

  async function handleStudentPreferenceSubmit(rows) {
    setStudentSubmitLoading(true);
    try {
      const hadDraft = !!myDraft;
      const normalized = [];
      let firstEmptyAfterUsed = false;

      for (let idx = 0; idx < rows.length; idx += 1) {
        const row = rows[idx];
        const hasAny = [row.clubId, row.careerGoal, row.applyReason, row.wantedActivity].some((value) => String(value || "").trim());

        if (!hasAny) {
          if (normalized.length > 0) {
            firstEmptyAfterUsed = true;
          }
          continue;
        }

        if (firstEmptyAfterUsed) {
          throw new Error("지망은 빈 칸 없이 1지망부터 순서대로 입력해주세요.");
        }

        const clubId = String(row.clubId || "").trim();
        const careerGoal = String(row.careerGoal || "").trim();
        const applyReason = String(row.applyReason || "").trim();
        const wantedActivity = String(row.wantedActivity || "").trim();

        if (!clubId || !careerGoal || !applyReason || !wantedActivity) {
          throw new Error(`${idx + 1}지망 항목을 모두 입력해주세요.`);
        }

        normalized.push({ clubId, careerGoal, applyReason, wantedActivity });
      }

      if (normalized.length === 0) {
        throw new Error("최소 1개 지망을 입력해주세요.");
      }

      await saveStudentPreferenceDraft({
        studentUid: user.uid,
        studentNo: user.studentNo || user.loginId,
        studentName: user.name,
        preferences: normalized,
      });

      await refreshMyDraft();
      setMessage({
        type: "ok",
        text: hadDraft
          ? "신청서를 수정 저장했습니다."
          : "신청서를 제출했습니다. 마감 전까지 수정할 수 있습니다.",
      });
    } catch (error) {
      withMessageError(error, "신청 제출에 실패했습니다.");
    } finally {
      setStudentSubmitLoading(false);
    }
  }

  async function handleCancelStudentDraft() {
    if (!window.confirm("제출한 신청서를 취소할까요?")) {
      return;
    }

    setStudentSubmitLoading(true);
    try {
      await cancelStudentPreferenceDraft({ studentUid: user.uid });
      await refreshMyDraft();
      setMessage({ type: "ok", text: "제출한 신청서를 취소했습니다." });
    } catch (error) {
      withMessageError(error, "신청서 취소에 실패했습니다.");
    } finally {
      setStudentSubmitLoading(false);
    }
  }

  async function handleSaveSubmissionWindow() {
    try {
      await updateRecruitmentSubmissionWindow({
        actor: user,
        submissionStartAt: submissionWindowForm.start,
        submissionEndAt: submissionWindowForm.end,
      });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await refreshRecruitmentViews(clubRows, cycleInfo);
      setMessage({ type: "ok", text: "학생 신청 기간을 저장했습니다." });
    } catch (error) {
      withMessageError(error, "학생 신청 기간 저장에 실패했습니다.");
    }
  }

  async function handleSavePreAssignmentWindow() {
    try {
      await updateRecruitmentPreAssignmentWindow({
        actor: user,
        preAssignmentStartAt: preAssignmentWindowForm.start,
        preAssignmentEndAt: preAssignmentWindowForm.end,
      });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await refreshRecruitmentViews(clubRows, cycleInfo);
      setMessage({ type: "ok", text: "교사 사전 학생 배정 기간을 저장했습니다." });
    } catch (error) {
      withMessageError(error, "교사 사전 학생 배정 기간 저장에 실패했습니다.");
    }
  }

  async function handleCreateUser(form) {
    try {
      await createUserAccount({
        loginId: String(form.loginId || "").trim(),
        password: String(form.password || ""),
        name: String(form.name || "").trim(),
        role: String(form.role || "student").trim(),
        studentNo: String(form.studentNo || "").trim(),
        subject: String(form.subject || "").trim(),
      });
      setMessage({ type: "ok", text: "계정을 생성했습니다." });
      const userRows = await refreshUsers();
      await refreshStudentStatusRows(userRows);
    } catch (error) {
      withMessageError(error, "계정 생성에 실패했습니다.");
    }
  }

  async function handleBulkUserUpload(file) {
    try {
      const parsed = await parseUserAccountExcel(file);
      if (parsed.length === 0) {
        throw new Error("엑셀에서 유효한 계정 데이터를 찾지 못했습니다.");
      }

      const result = await createUsersBatch(parsed);
      const failMessages = result.failed.slice(0, 5).map((item) => `${item.row}행 ${item.loginId}: ${item.reason}`);
      const summary = [`생성 ${result.created.length}건`, `실패 ${result.failed.length}건`];
      if (failMessages.length > 0) {
        summary.push(failMessages.join(" / "));
      }
      setMessage({ type: result.failed.length > 0 ? "info" : "ok", text: summary.join(" · ") });
      const userRows = await refreshUsers();
      await refreshStudentStatusRows(userRows);
    } catch (error) {
      withMessageError(error, "엑셀 일괄 등록에 실패했습니다.");
    }
  }

  async function handleUpdateUser(row, patch) {
    try {
      await updateUserByAdmin(row.uid, {
        name: patch.name,
        role: patch.role,
        studentNo: patch.studentNo,
        subject: patch.subject,
      });
      setMessage({ type: "ok", text: "회원 정보를 수정했습니다." });
      const userRows = await refreshUsers();
      await refreshStudentStatusRows(userRows);
    } catch (error) {
      withMessageError(error, "회원 수정에 실패했습니다.");
    }
  }

  async function handleDeleteUser(row) {
    if (!window.confirm(`${row.loginId} 계정을 삭제할까요?`)) return;

    try {
      await deleteUserByAdmin(row.uid);
      setMessage({ type: "ok", text: "회원을 삭제했습니다." });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      const userRows = await refreshUsers();
      await refreshRecruitmentViews(clubRows, cycleInfo, userRows);
    } catch (error) {
      withMessageError(error, "회원 삭제에 실패했습니다.");
    }
  }

  async function handleResetPassword(row) {
    const nextPassword = window.prompt(`${row.loginId} 계정의 새 비밀번호를 입력하세요`, "123456");
    if (!nextPassword) return;

    try {
      await resetUserPasswordByAdmin(row.uid, nextPassword);
      setMessage({ type: "ok", text: `비밀번호를 초기화했습니다. (${row.loginId})` });
    } catch (error) {
      withMessageError(error, "비밀번호 초기화에 실패했습니다.");
    }
  }

  async function handleResetStudentPasswords() {
    const studentCount = users.filter((row) => row.role === "student").length;
    if (studentCount === 0) {
      setMessage({ type: "warn", text: "초기화할 학생 계정이 없습니다." });
      return;
    }

    const nextPassword = window.prompt(`학생 ${studentCount}명의 새 비밀번호를 입력하세요`, "123456");
    if (!nextPassword) return;

    if (!window.confirm(`학생 ${studentCount}명의 비밀번호를 모두 같은 값으로 초기화할까요?`)) {
      return;
    }

    try {
      setBulkResetLoading(true);
      const result = await resetStudentPasswordsByAdmin(nextPassword);
      setMessage({ type: "ok", text: `학생 비밀번호를 일괄 초기화했습니다. (${result.count}명)` });
    } catch (error) {
      withMessageError(error, "학생 비밀번호 일괄 초기화에 실패했습니다.");
    } finally {
      setBulkResetLoading(false);
    }
  }

  async function handleSaveMyProfile(form) {
    try {
      await updateMyProfile(user.uid, form);
      setMessage({ type: "ok", text: "내 정보를 저장했습니다. 다시 로그인하면 즉시 반영됩니다." });
    } catch (error) {
      withMessageError(error, "내 정보 저장에 실패했습니다.");
    }
  }

  async function handleChangeMyPassword(currentPassword, nextPassword, confirmPassword) {
    try {
      if (!currentPassword || !nextPassword || !confirmPassword) {
        throw new Error("현재/새/새 비밀번호 확인을 모두 입력해주세요.");
      }
      if (nextPassword !== confirmPassword) {
        throw new Error("새 비밀번호 확인이 일치하지 않습니다.");
      }

      setMyPasswordLoading(true);
      await updateMyPassword(user.uid, currentPassword, nextPassword);
      setMessage({ type: "ok", text: "비밀번호를 변경했습니다." });
      return true;
    } catch (error) {
      withMessageError(error, "비밀번호 변경에 실패했습니다.");
      return false;
    } finally {
      setMyPasswordLoading(false);
    }
  }

  const preAssignmentState = useMemo(() => getTeacherPreAssignmentWindowState(cycle), [cycle]);
  const submissionState = useMemo(() => getSubmissionWindowState(cycle), [cycle]);
  const visibleClubs = clubs.filter((club) => !club.legacy);
  const leaderEditableClubs = visibleClubs.filter((club) => canEditClub(club, user));
  const teacherOwnedClubs = visibleClubs.filter((club) => String(club.teacherUid || "") === String(user?.uid || ""));
  const selectedStudentStatusRow = useMemo(
    () => studentStatusRows.find((row) => row.studentUid === studentStatusDialog.studentUid) || null,
    [studentStatusDialog.studentUid, studentStatusRows],
  );
  const isStudentLeader = user?.role === "student" && leaderEditableClubs.length > 0;
  const clubsForManageTab = user?.role === "student" ? leaderEditableClubs : visibleClubs;
  const canCreateClub = user?.role === "admin" || user?.role === "teacher" || user?.loginId === "admin";
  const studentApplyFormKey = [
    user?.uid || "",
    myDraft?.id || "",
    myDraft?.updatedAt || myDraft?.submittedAt || "",
    myApplications.map((row) => `${row.id}:${row.updatedAt || row.createdAt || ""}`).join("|"),
  ].join("::");
  const applicantRandomLocked = applicantDialog.club
    ? Array.isArray(applicantDialog.club.randomDrawnRounds)
      && applicantDialog.club.randomDrawnRounds.includes(cycle.currentRound)
    : false;

  useEffect(() => {
    if (user?.role === "student" && tab === "clubs" && !isStudentLeader) {
      setTab("apply");
    }
  }, [isStudentLeader, tab, user?.role]);

  if (isLoading) {
    return (
      <div style={{ ...page, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ ...cardStyle, fontSize: 14, color: t.textSub }}>초기화 중...</div>
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return <LoginPanel onLogin={handleLogin} loading={loginLoading} error={loginError} />;
  }

  return (
    <Layout user={user} tab={tab} setTab={setTab} onSignOut={handleSignOut} isStudentLeader={isStudentLeader}>
      <MessageBar message={message} onClose={() => setMessage({ type: "", text: "" })} />

      {loading ? (
        <section style={cardStyle}>
          <div style={{ fontSize: 14, color: t.textSub }}>데이터를 불러오는 중...</div>
        </section>
      ) : null}

      {tab === "clubs" ? (
        (user.role === "admin" || isStudentLeader) ? (
          <div style={{ display: "grid", gap: 12 }}>
            {user.role === "admin" ? (
              <ClubRoomManager
                rooms={clubRooms}
                loading={savingRoom}
                onAdd={handleCreateClubRoom}
                onDelete={handleDeleteClubRoom}
                onRefresh={async () => {
                  try {
                    setSavingRoom(true);
                    await refreshClubRooms();
                    setMessage({ type: "ok", text: "동아리실 목록을 새로고침했습니다." });
                  } catch (error) {
                    withMessageError(error, "동아리실 목록 갱신에 실패했습니다.");
                  } finally {
                    setSavingRoom(false);
                  }
                }}
              />
            ) : null}

            <ClubTable
              actor={user}
              clubs={clubsForManageTab}
              userMap={userMap}
              cycle={cycle}
              roundStats={roundStats}
              canCreate={canCreateClub}
              onCreate={openCreateClubDialog}
              onOpenDetail={openClubDetail}
              onEdit={handleEditClub}
              onDelete={handleDeleteClub}
              onOpenApplicants={openApplicantDialog}
              onOpenInterviewSelect={openInterviewDialog}
            />
          </div>
        ) : null
      ) : null}

      {tab === "requestCards" && user.role === "admin" ? (
        <RequestCardAdminPanel
          cards={requestCards}
          form={requestCardForm}
          setForm={setRequestCardForm}
          editingId={editingRequestCardId}
          loading={requestCardLoading}
          onRefresh={async () => {
            try {
              await refreshRequestCards();
              setMessage({ type: "ok", text: "신청 카드 목록을 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "신청 카드 목록 새로고침에 실패했습니다.");
            }
          }}
          onSubmit={handleSaveRequestCard}
          onStartEdit={handleEditRequestCard}
          onCancelEdit={resetRequestCardForm}
          onDelete={handleDeleteRequestCard}
          onDraw={handleDrawRequestCard}
          onOpenApplications={openRequestCardDialog}
        />
      ) : null}

      {tab === "myClubs" && user.role === "teacher" ? (
        <ClubTable
          actor={user}
          clubs={teacherOwnedClubs}
          userMap={userMap}
          cycle={cycle}
          roundStats={roundStats}
          canCreate={canCreateClub}
          onCreate={openCreateClubDialog}
          onOpenDetail={openClubDetail}
          onEdit={handleEditClub}
          onDelete={handleDeleteClub}
          onOpenApplicants={openApplicantDialog}
          onOpenInterviewSelect={openInterviewDialog}
        />
      ) : null}

      {tab === "clubOverview" && (user.role === "teacher" || user.role === "student") ? (
        <ClubTable
          actor={user}
          clubs={visibleClubs}
          userMap={userMap}
          cycle={cycle}
          roundStats={roundStats}
          canCreate={false}
          onCreate={openCreateClubDialog}
          onOpenDetail={openClubDetail}
          onEdit={handleEditClub}
          onDelete={handleDeleteClub}
          onOpenApplicants={openApplicantDialog}
          onOpenInterviewSelect={openInterviewDialog}
          showCapacity={user.role !== "student"}
          showRoundStatus={user.role !== "student"}
          showActions={user.role !== "student"}
        />
      ) : null}

      {tab === "round" && user.role === "admin" ? (
        <RoundPanel
          cycle={cycle}
          stats={roundStats}
          loading={loading}
          preAssignmentState={preAssignmentState}
          preAssignmentStartValue={preAssignmentWindowForm.start}
          preAssignmentEndValue={preAssignmentWindowForm.end}
          submissionState={submissionState}
          onPreAssignmentStartChange={(value) => setPreAssignmentWindowForm((prev) => ({ ...prev, start: value }))}
          onPreAssignmentEndChange={(value) => setPreAssignmentWindowForm((prev) => ({ ...prev, end: value }))}
          onSavePreAssignmentWindow={handleSavePreAssignmentWindow}
          submissionStartValue={submissionWindowForm.start}
          submissionEndValue={submissionWindowForm.end}
          onSubmissionStartChange={(value) => setSubmissionWindowForm((prev) => ({ ...prev, start: value }))}
          onSubmissionEndChange={(value) => setSubmissionWindowForm((prev) => ({ ...prev, end: value }))}
          onSaveSubmissionWindow={handleSaveSubmissionWindow}
          onRefresh={async () => {
            try {
              const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
              await Promise.all([
                refreshRecruitmentViews(clubRows, cycleInfo),
                refreshMyApplications(),
              ]);
              setMessage({ type: "ok", text: "동아리 선발 정보를 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "동아리 선발 정보 갱신에 실패했습니다.");
            }
          }}
          onAdvance={handleAdvanceRound}
          onCleanup={handleCleanupRecruitment}
        />
      ) : null}

      {tab === "studentStatus" && (user.role === "admin" || user.role === "teacher") ? (
        <StudentApplicationStatusPanel
          rows={studentStatusRows}
          loading={studentStatusLoading || loading}
          onRefresh={async () => {
            setStudentStatusLoading(true);
            try {
              const [clubRows, userRows, cycleInfo] = await Promise.all([
                refreshClubs(),
                refreshUsers(),
                refreshCycle(),
              ]);
              await refreshRecruitmentViews(clubRows, cycleInfo, userRows);
              setMessage({ type: "ok", text: "학생 신청 현황을 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "학생 신청 현황을 새로고침하지 못했습니다.");
            } finally {
              setStudentStatusLoading(false);
            }
          }}
          onOpenDetail={(studentUid) => setStudentStatusDialog({ open: true, studentUid })}
        />
      ) : null}

      {tab === "users" && user.role === "admin" ? (
        <UserManagementPanel
          currentUser={user}
          users={users}
          bulkResetLoading={bulkResetLoading}
          onRefresh={async () => {
            try {
              await refreshUsers();
              setMessage({ type: "ok", text: "회원 목록을 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "회원 목록 갱신에 실패했습니다.");
            }
          }}
          onCreate={handleCreateUser}
          onBulkUpload={handleBulkUserUpload}
          onDownloadTemplate={downloadUserAccountTemplate}
          onUpdate={handleUpdateUser}
          onDelete={handleDeleteUser}
          onResetPassword={handleResetPassword}
          onResetStudentPasswords={handleResetStudentPasswords}
          loading={loading}
        />
      ) : null}

      {tab === "apply" && user.role === "student" ? (
        <StudentApplyPanel
          key={studentApplyFormKey}
          user={user}
          cycle={cycle}
          clubs={visibleClubs}
          draft={myDraft}
          submissionState={submissionState}
          myApplications={myApplications}
          submitting={studentSubmitLoading}
          onSubmit={handleStudentPreferenceSubmit}
          onCancelDraft={handleCancelStudentDraft}
        />
      ) : null}

      {tab === "my" && user.role === "student" ? (
        <StudentMyPanel apps={myApplications} />
      ) : null}

      {tab === "extraRequests" && (user.role === "admin" || user.role === "teacher" || user.role === "student") ? (
        <RequestCardUserSection
          user={user}
          cards={requestCards}
          myApplications={myRequestCardApplications}
          loading={requestCardLoading}
          onRefresh={async () => {
            try {
              await Promise.all([refreshRequestCards(), refreshMyRequestCardApplications()]);
              setMessage({ type: "ok", text: "기타 신청 카드 목록을 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "기타 신청 카드 목록 새로고침에 실패했습니다.");
            }
          }}
          onApply={handleApplyRequestCard}
          onCancel={handleCancelRequestCard}
        />
      ) : null}

      {tab === "profile" ? (
        <ProfilePanel
          user={user}
          onSave={handleSaveMyProfile}
          onChangePassword={handleChangeMyPassword}
          loading={loading}
          passwordLoading={myPasswordLoading}
        />
      ) : null}

      <ClubFormDialog
        open={clubFormDialogOpen}
        title={editingClubId ? "동아리 수정" : "동아리 개설"}
        onClose={closeClubFormDialog}
      >
        <ClubForm
          actor={user}
          users={users}
          roomOptions={clubRooms}
          editingId={editingClubId}
          form={clubForm}
          setForm={setClubForm}
          onSubmit={handleSaveClub}
          onReset={closeClubFormDialog}
          submitting={savingClub}
          canCreate={canCreateClub}
        />
      </ClubFormDialog>

      <ClubDetailDialog
        open={clubDetailDialog.open}
        club={clubDetailDialog.club}
        userMap={userMap}
        onClose={closeClubDetail}
      />

      <ApplicantsDialog
        key={`${applicantDialog.club?.id || "none"}:${applicantDialog.open ? "open" : "closed"}`}
        open={applicantDialog.open}
        loading={applicantDialog.loading}
        club={applicantDialog.club}
        cycle={cycle}
        submissionState={submissionState}
        preAssignmentState={preAssignmentState}
        rows={applicantDialog.rows}
        users={users}
        onClose={() => setApplicantDialog({ open: false, club: null, rows: [], loading: false })}
        onApprove={handleApproveApplication}
        onReject={handleRejectApplication}
        onRevoke={handleRevokeApprovedApplication}
        onRandom={handleRandomSelection}
        onManualAssign={handleManualAssignStudent}
        randomLocked={applicantRandomLocked}
      />

      <InterviewSelectDialog
        open={interviewDialog.open}
        club={interviewDialog.club}
        users={users}
        members={interviewDialog.members}
        loading={interviewDialog.loading}
        selectionReady={submissionState.selectionReady}
        preAssignmentState={preAssignmentState}
        cycleClosed={cycle?.status === "closed"}
        keyword={interviewDialog.keyword}
        setKeyword={(value) => setInterviewDialog((prev) => ({ ...prev, keyword: value }))}
        onClose={() => setInterviewDialog({ open: false, club: null, members: [], keyword: "", loading: false })}
        onSelect={handleDirectSelect}
      />

      <RequestCardApplicationsDialog
        open={requestCardDialog.open}
        card={requestCardDialog.card}
        rows={requestCardDialog.rows}
        loading={requestCardDialog.loading}
        onClose={() => setRequestCardDialog({ open: false, card: null, rows: [], loading: false })}
      />

      <StudentApplicationDetailDialog
        key={[
          studentStatusDialog.studentUid || "none",
          selectedStudentStatusRow?.finalClubId || "",
          selectedStudentStatusRow?.updatedAt || "",
          selectedStudentStatusRow?.sourceType || "",
        ].join(":")}
        open={studentStatusDialog.open}
        row={selectedStudentStatusRow}
        cycle={cycle}
        submissionState={submissionState}
        clubs={visibleClubs}
        isAdmin={user.role === "admin"}
        loading={forceAssignLoading}
        onClose={() => setStudentStatusDialog({ open: false, studentUid: "" })}
        onForceAssign={handleAdminForceAssign}
      />
    </Layout>
  );
}
