import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../../hooks/useAuth";
import {
  advanceRecruitmentRound,
  approveApplication,
  directSelectInterviewMember,
  getCurrentRecruitmentCycle,
  inferStudentGrade,
  listApplicationsBySchedule,
  listClubMembers,
  listStudentApplications,
  purgeLegacyRecruitmentData,
  randomSelectPending,
  rejectApplication,
  submitStudentPreferences,
} from "../../services/applicationService";
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
  return "";
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

function MessageBar({ message, onClose }) {
  if (!message?.text) return null;
  const colors = {
    ok: { bg: "#e8f5e9", border: "#b7dfbb", color: t.ok },
    error: { bg: "#ffebee", border: "#f2b8be", color: t.danger },
    info: { bg: "#e8f1fe", border: "#b6d1fb", color: t.accent },
  };
  const palette = colors[message.type] || colors.info;

  return (
    <div style={{ ...cardStyle, background: palette.bg, borderColor: palette.border, color: palette.color, padding: "10px 12px" }}>
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
              placeholder={tab === "teacher" ? "예: 김교사" : "예: 26001"}
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
            학생은 학번(5자리 숫자) + 이름 + 비밀번호를 입력해야 로그인됩니다.
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
      { key: "round", label: "라운드 운영" },
      { key: "users", label: "회원 관리" },
      { key: "profile", label: "내 정보" },
    ],
    teacher: [
      { key: "myClubs", label: "내 동아리" },
      { key: "clubOverview", label: "동아리개설현황" },
      { key: "profile", label: "내 정보" },
    ],
    student: isStudentLeader
      ? [
        { key: "apply", label: "동아리 신청" },
        { key: "my", label: "신청 현황" },
        { key: "clubOverview", label: "동아리개설현황" },
        { key: "clubs", label: "동아리 수정(동아리장)" },
        { key: "profile", label: "내 정보" },
      ]
      : [
        { key: "apply", label: "동아리 신청" },
        { key: "my", label: "신청 현황" },
        { key: "clubOverview", label: "동아리개설현황" },
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
                {nav.map((item) => {
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
                {nav.map((item) => {
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
  rows,
  onClose,
  onApprove,
  onReject,
  onRandom,
  randomLocked,
}) {
  if (!open) return null;

  const currentRound = cycle?.currentRound || 1;
  const pendingCurrent = rows.filter(
    (row) => row.status === "pending" && Number(row.preferenceRank) === Number(currentRound),
  ).length;
  const randomDisabled = loading || pendingCurrent === 0 || randomLocked || cycle?.status === "closed";

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
                const canDecide = row.status === "pending" && cycle?.status === "open";
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
                      {row.rejectReason ? rejectReasonLabel(row.rejectReason) : "-"}
                    </td>
                    <td style={{ borderBottom: `1px solid ${t.border}`, padding: "9px 6px" }}>
                      <div style={{ display: "flex", gap: 6 }}>
                        <button
                          onClick={() => onApprove(row)}
                          disabled={!canDecide || loading}
                          style={{
                            ...buttonBase,
                            padding: "5px 8px",
                            background: canDecide && !loading ? "#e8f5e9" : "#cfd8e3",
                            color: canDecide && !loading ? t.ok : "#6b7280",
                            fontWeight: 700,
                          }}
                        >
                          승인
                        </button>
                        <button
                          onClick={() => onReject(row)}
                          disabled={!canDecide || loading}
                          style={{
                            ...buttonBase,
                            padding: "5px 8px",
                            background: canDecide && !loading ? "#ffebee" : "#cfd8e3",
                            color: canDecide && !loading ? t.danger : "#6b7280",
                            fontWeight: 700,
                          }}
                        >
                          반려
                        </button>
                      </div>
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
                        disabled={loading}
                        style={{
                          ...buttonBase,
                          padding: "5px 8px",
                          background: loading ? "#cfd8e3" : "#fff3e0",
                          color: loading ? "#6b7280" : t.warn,
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

function RoundPanel({ cycle, stats, loading, onRefresh, onAdvance, onCleanup }) {
  const pendingTotal = Object.values(stats).reduce((sum, row) => sum + Number(row.pendingCurrent || 0), 0);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <div>
          <h2 style={{ fontSize: 17 }}>라운드 순차 운영</h2>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 4 }}>
            현재 상태: {cycle?.status === "closed" ? "종료" : "진행중"} · 현재 라운드: {cycle?.currentRound || 1}
          </div>
          <div style={{ fontSize: 12, color: t.textSub, marginTop: 2 }}>
            현재 라운드 pending 합계: {pendingTotal}명
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
            disabled={loading || cycle?.status === "closed" || pendingTotal > 0}
            style={{
              ...buttonBase,
              background: loading || cycle?.status === "closed" || pendingTotal > 0 ? "#cfd8e3" : t.accent,
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

function StudentApplyPanel({
  user,
  cycle,
  clubs,
  myApplications,
  submitting,
  onSubmit,
}) {
  const grade = inferStudentGrade(user?.studentNo || user?.loginId);
  const submitted = myApplications.length > 0;

  const available = clubs.filter((club) => {
    if (club.legacy) return false;
    if (club.isInterviewSelection) return false;
    if (!club.leaderUid) return false;
    if (!grade) return false;
    return (club.targetGrades || []).includes(grade);
  });

  const interviewClubs = clubs.filter((club) => !club.legacy && club.isInterviewSelection);

  const [rows, setRows] = useState([
    { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
    { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
    { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
  ]);

  useEffect(() => {
    if (!submitted) {
      setRows([
        { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
        { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
        { clubId: "", careerGoal: "", applyReason: "", wantedActivity: "" },
      ]);
    }
  }, [submitted, user?.uid, cycle?.currentRound, cycle?.status]);

  return (
    <section style={cardStyle}>
      <h2 style={{ fontSize: 17, marginBottom: 8 }}>학생 동아리 신청</h2>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 12 }}>
        현재 사이클 상태: {cycle?.status === "closed" ? "종료" : "진행중"} · 현재 라운드 {cycle?.currentRound || 1}
      </div>
      <div style={{ fontSize: 12, color: t.textSub, marginBottom: 12 }}>
        내 학년 추정: {grade ? `${grade}학년` : "학번 첫 자리로 학년 추정 불가"}
      </div>

      {submitted ? (
        <div style={{ ...cardStyle, background: "#edf4ff", borderColor: "#c8dcff" }}>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>이미 1~3지망을 제출했습니다.</div>
          <div style={{ fontSize: 12, color: t.textSub }}>정책상 재신청은 불가합니다.</div>
        </div>
      ) : null}

      {!submitted && cycle?.status !== "open" ? (
        <div style={{ ...cardStyle, background: "#ffebee", borderColor: "#f2b8be" }}>
          <div style={{ fontWeight: 700, marginBottom: 4, color: t.danger }}>현재 모집 사이클이 종료되었습니다.</div>
          <div style={{ fontSize: 12, color: t.textSub }}>관리자가 새 모집 사이클을 열기 전까지 신청할 수 없습니다.</div>
        </div>
      ) : null}

      {!submitted && cycle?.status === "open" ? (
        <div style={{ display: "grid", gap: 12 }}>
          {[0, 1, 2].map((idx) => (
            <div key={idx} style={{ ...cardStyle, background: "#fafbfd" }}>
              <h3 style={{ fontSize: 14, marginBottom: 10 }}>{idx + 1}지망</h3>
              <div style={{ display: "grid", gap: 8 }}>
                <Field label="동아리 선택">
                  <Select
                    value={rows[idx].clubId}
                    onChange={(e) => {
                      const next = [...rows];
                      next[idx] = { ...next[idx], clubId: e.target.value };
                      setRows(next);
                    }}
                  >
                    <option value="">선택 안함</option>
                    {available.map((club) => (
                      <option key={club.id} value={club.id}>
                        {club.clubName} ({club.room})
                      </option>
                    ))}
                  </Select>
                </Field>

                <Field label="진로희망">
                  <input
                    value={rows[idx].careerGoal}
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

          <button
            onClick={() => onSubmit(rows)}
            disabled={submitting}
            style={{
              ...buttonBase,
              background: submitting ? "#cfd8e3" : t.accent,
              color: "#fff",
              fontWeight: 700,
              justifySelf: "start",
            }}
          >
            {submitting ? "제출 중..." : "1~3지망 제출"}
          </button>
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
              {["지망", "동아리", "상태", "반려사유", "진로희망", "신청사유", "활동계획", "수정일"].map((head) => (
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
                <td style={{ borderBottom: `1px solid ${t.border}`, padding: "8px 6px", fontSize: 12, color: t.textSub }}>{rejectReasonLabel(row.rejectReason) || "-"}</td>
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
  loading,
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
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputBase, width: 260 }}
            placeholder="아이디/이름/학번 검색"
          />
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
  const [loginError, setLoginError] = useState("");
  const [message, setMessage] = useState({ type: "", text: "" });

  const [clubs, setClubs] = useState([]);
  const [clubRooms, setClubRooms] = useState([]);
  const [users, setUsers] = useState([]);
  const [cycle, setCycle] = useState({ id: "current", currentRound: 1, status: "open" });
  const [roundStats, setRoundStats] = useState({});
  const [myApplications, setMyApplications] = useState([]);

  const [clubForm, setClubForm] = useState(newClubForm(user));
  const [editingClubId, setEditingClubId] = useState("");
  const [savingClub, setSavingClub] = useState(false);
  const [savingRoom, setSavingRoom] = useState(false);
  const [clubFormDialogOpen, setClubFormDialogOpen] = useState(false);

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
  }, [isAuthenticated, user?.uid, user?.role]);

  async function refreshCycle() {
    const current = await getCurrentRecruitmentCycle();
    setCycle(current);
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
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await Promise.all([refreshUsers(), refreshMyApplications(), refreshClubRooms()]);
      await refreshRoundStats(clubRows, cycleInfo);
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

      if (editingClubId) {
        await updateSchedule(editingClubId, payload, { actor: user });
        setMessage({ type: "ok", text: "동아리 정보를 수정했습니다." });
      } else {
        await createSchedule(payload, { actor: user });
        setMessage({ type: "ok", text: "동아리를 생성했습니다." });
      }

      setClubFormDialogOpen(false);
      resetClubForm();
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await refreshRoundStats(clubRows, cycleInfo);
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
      await refreshRoundStats(clubRows, cycleInfo);
      if (editingClubId === club.id) {
        closeClubFormDialog();
      }
    } catch (error) {
      withMessageError(error, "동아리 삭제에 실패했습니다.");
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
      await refreshRoundStats(clubsData, cycleInfo);

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
      await refreshRoundStats(clubsData, cycleInfo);

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
        refreshRoundStats(clubRows, cycleInfo),
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
        refreshRoundStats(clubRows, cycleInfo),
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

      await submitStudentPreferences({
        studentUid: user.uid,
        studentNo: user.studentNo || user.loginId,
        studentName: user.name,
        preferences: normalized,
      });

      setMessage({ type: "ok", text: "1~3지망 신청을 제출했습니다." });
      const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
      await Promise.all([
        refreshRoundStats(clubRows, cycleInfo),
        refreshMyApplications(),
      ]);
    } catch (error) {
      withMessageError(error, "신청 제출에 실패했습니다.");
    } finally {
      setStudentSubmitLoading(false);
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
      await refreshUsers();
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
      await refreshUsers();
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
      await refreshUsers();
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
      await refreshUsers();
      await refreshRoundStats(clubRows, cycleInfo);
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

  const visibleClubs = clubs.filter((club) => !club.legacy);
  const leaderEditableClubs = visibleClubs.filter((club) => canEditClub(club, user));
  const teacherOwnedClubs = visibleClubs.filter((club) => String(club.teacherUid || "") === String(user?.uid || ""));
  const isStudentLeader = user?.role === "student" && leaderEditableClubs.length > 0;
  const clubsForManageTab = user?.role === "student" ? leaderEditableClubs : visibleClubs;
  const canCreateClub = user?.role === "admin" || user?.role === "teacher" || user?.loginId === "admin";
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
          onRefresh={async () => {
            try {
              const [clubRows, cycleInfo] = await Promise.all([refreshClubs(), refreshCycle()]);
              await Promise.all([
                refreshRoundStats(clubRows, cycleInfo),
                refreshMyApplications(),
              ]);
              setMessage({ type: "ok", text: "라운드 정보를 새로고침했습니다." });
            } catch (error) {
              withMessageError(error, "라운드 정보 갱신에 실패했습니다.");
            }
          }}
          onAdvance={handleAdvanceRound}
          onCleanup={handleCleanupRecruitment}
        />
      ) : null}

      {tab === "users" && user.role === "admin" ? (
        <UserManagementPanel
          currentUser={user}
          users={users}
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
          loading={loading}
        />
      ) : null}

      {tab === "apply" && user.role === "student" ? (
        <StudentApplyPanel
          user={user}
          cycle={cycle}
          clubs={visibleClubs}
          myApplications={myApplications}
          submitting={studentSubmitLoading}
          onSubmit={handleStudentPreferenceSubmit}
        />
      ) : null}

      {tab === "my" && user.role === "student" ? (
        <StudentMyPanel apps={myApplications} />
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
        open={applicantDialog.open}
        loading={applicantDialog.loading}
        club={applicantDialog.club}
        cycle={cycle}
        rows={applicantDialog.rows}
        onClose={() => setApplicantDialog({ open: false, club: null, rows: [], loading: false })}
        onApprove={handleApproveApplication}
        onReject={handleRejectApplication}
        onRandom={handleRandomSelection}
        randomLocked={applicantRandomLocked}
      />

      <InterviewSelectDialog
        open={interviewDialog.open}
        club={interviewDialog.club}
        users={users}
        members={interviewDialog.members}
        loading={interviewDialog.loading}
        keyword={interviewDialog.keyword}
        setKeyword={(value) => setInterviewDialog((prev) => ({ ...prev, keyword: value }))}
        onClose={() => setInterviewDialog({ open: false, club: null, members: [], keyword: "", loading: false })}
        onSelect={handleDirectSelect}
      />
    </Layout>
  );
}
