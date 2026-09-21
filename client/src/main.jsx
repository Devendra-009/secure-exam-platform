import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import ProctoringPanel from './ProctoringPanel.jsx';
import { getToken, isNetworkError, request, setToken } from './api.js';

const DRAFT_PREFIX = 'secureExamDraft:';
const VIOLATION_QUEUE_PREFIX = 'secureExamViolationQueue:';
const readQueue = (id) => { try { return JSON.parse(localStorage.getItem(`${VIOLATION_QUEUE_PREFIX}${id}`) || '[]') } catch { return [] } };
const writeQueue = (id, items) => localStorage.setItem(`${VIOLATION_QUEUE_PREFIX}${id}`, JSON.stringify(items.slice(-120)));
const formatTime = (seconds) => { const safe = Math.max(0, Number(seconds) || 0); return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}` };

function App() {
  const [user, setUser] = useState(null); const [booting, setBooting] = useState(Boolean(getToken()));
  useEffect(() => { if (!getToken()) { setBooting(false); return } request('/me').then(setUser).catch(() => setToken(null)).finally(() => setBooting(false)) }, []);
  const logout = () => { setToken(null); setUser(null) };
  if (booting) return <div className="boot-screen"><div className="spinner" /><strong>Loading SecureExam…</strong></div>;
  if (!user) return <Login onLogin={setUser} />;
  return <Dashboard user={user} onLogout={logout} />;
}

function Field({ label, ...props }) { return <label className="field"><span>{label}</span><input {...props} /></label> }

function Login({ onLogin }) {
  const [mode, setMode] = useState('login'); const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  const submit = async (e) => { e.preventDefault(); setError(''); setLoading(true); try { const data = await request('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }); setToken(data.token); onLogin(data.user) } catch (err) { setError(isNetworkError(err) ? 'Network error: cannot reach the SecureExam server.' : err.message) } finally { setLoading(false) } };
  return <main className="auth-shell"><section className="auth-hero"><span className="brand-mark">SECUREEXAM</span><div className="hero-copy"><p className="eyebrow">Secure assessment workspace</p><h1>Focused exams.<br />Recorded integrity.</h1><p>Timed assessments with compact local proctoring, server-controlled deadlines, recovery after interruptions, and explainable integrity analytics.</p></div><div className="feature-strip"><span>⌁ Auto-save</span><span>⌁ Resume-ready</span><span>⌁ Student registration</span><span>⌁ Risk analytics</span></div></section>{mode === 'login' ? <form className="auth-card" onSubmit={submit}><div><span className="eyebrow">Welcome back</span><h2>Sign in</h2><p className="muted">Use your SecureExam account to continue.</p></div><Field label="Email" type="email" value={email} onChange={e => setEmail(e.target.value)} required autoComplete="username" /><Field label="Password" type="password" value={password} onChange={e => setPassword(e.target.value)} required autoComplete="current-password" />{error && <div className="alert danger"><strong>Sign-in error</strong><span>{error}</span></div>}<button className="primary full" disabled={loading}>{loading ? 'Signing in…' : 'Sign in'}</button><button type="button" className="ghost center-text" onClick={() => { setMode('register'); setError('') }}>New student? Register directly</button></form> : <Registration onBack={() => setMode('login')} onRegistered={onLogin} />}</main>
}

function Registration({ onBack, onRegistered }) {
  const [exams, setExams] = useState([]); const [form, setForm] = useState({ name: '', email: '', password: '', exam_id: '', series_id: '' }); const [error, setError] = useState(''); const [loading, setLoading] = useState(false);
  useEffect(() => { request('/public/exams').then(setExams).catch(e => setError(isNetworkError(e) ? 'Network error: registration service is unavailable.' : e.message)) }, []);
  const selected = exams.find(e => e.id === form.exam_id); const series = selected?.series || [];
  const submit = async (e) => { e.preventDefault(); setError(''); setLoading(true); try { const data = await request('/auth/register', { method: 'POST', body: JSON.stringify(form) }); setToken(data.token); onRegistered(data.user); alert(`Registration successful. Your Student ID is ${data.user.student_id}.`) } catch (err) { setError(isNetworkError(err) ? 'Network error: please check the server connection.' : err.message) } finally { setLoading(false) } };
  return <form className="auth-card registration-card" onSubmit={submit}><div><span className="eyebrow">Student registration</span><h2>Create your account</h2><p className="muted">Choose the exam and the ID series assigned by the administration.</p></div><Field label="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><Field label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /><Field label="Password" type="password" minLength="8" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required /><label className="field"><span>Exam</span><select value={form.exam_id} onChange={e => setForm({ ...form, exam_id: e.target.value, series_id: '' })} required><option value="">Select exam</option>{exams.map(ex => <option value={ex.id} key={ex.id}>{ex.title} · {ex.duration_minutes} min</option>)}</select></label><label className="field"><span>Student ID series</span><select value={form.series_id} onChange={e => setForm({ ...form, series_id: e.target.value })} required disabled={!selected}><option value="">Select series</option>{series.map(s => <option value={s.id} key={s.id}>{s.batch_name} · {s.prefix}001…</option>)}</select></label>{selected && <div className="info-card"><strong>{selected.question_count} questions · {selected.duration_minutes} minutes</strong><small>Your Student ID is generated automatically from the selected series.</small></div>}{error && <div className="alert danger"><strong>Registration error</strong><span>{error}</span></div>}<button className="primary full" disabled={loading}>{loading ? 'Creating account…' : 'Register and continue'}</button><button type="button" className="ghost center-text" onClick={onBack}>Back to sign in</button></form>
}

function Dashboard({ user, onLogout }) {
  const [tab, setTab] = useState('overview'); const [exams, setExams] = useState([]); const [attempts, setAttempts] = useState([]); const [reports, setReports] = useState([]); const [taking, setTaking] = useState(null); const [editingExam, setEditingExam] = useState(null); const [loading, setLoading] = useState(false); const staff = user.role !== 'student';
  const loadDashboard = useCallback(async () => { setLoading(true); try { setExams(await request('/exams')); if (user.role === 'student') setAttempts(await request('/attempts/mine')); } catch { } finally { setLoading(false) } }, [user.role]);
  const loadReports = useCallback(() => request('/reports').then(setReports).catch(() => setReports([])), []);
  useEffect(() => { loadDashboard() }, [loadDashboard]);
  useEffect(() => { if (tab === 'reports' && staff) loadReports() }, [tab, staff, loadReports]);
  if (taking) return <TakeExam exam={taking.exam || taking} attemptId={taking.attemptId} onClose={() => { setTaking(null); loadDashboard() }} />;
  const activeAttempt = attempts.find(a => a.status === 'in_progress');
  const tabs = ['overview', ...(staff ? ['create', 'series', 'reports'] : []), ...(user.role === 'admin' ? ['users'] : [])];
  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-dot" />
          <span>SecureExam</span>
        </div>

        <nav>
          {tabs.map(item => (
            <button
              key={item}
              className={tab === item ? 'nav-active' : ''}
              onClick={() => setTab(item)}
            >
              {item === 'series' ? 'ID Series' : item[0].toUpperCase() + item.slice(1)}
            </button>
          ))}
        </nav>

        <div className="profile-chip">
          <div className="avatar">{user.name?.charAt(0)?.toUpperCase() || 'U'}</div>
          <div>
            <strong>{user.name}</strong>
            <small>
              {user.student_id ? `${user.student_id} · ` : ''}
              {user.role}
            </small>
          </div>
          <button className="ghost" onClick={onLogout}>Sign out</button>
        </div>
      </header>

      <div className="system-strip">
        <span className="system-dot" />
        Secure mode is ready
        <span className="system-separator" />
        {user.student_id
          ? `Student ID ${user.student_id}`
          : 'Camera and network checks appear during active exams'}
      </div>

      <main className="dashboard-content">
        {tab === 'create' && (
          <ExamCreator
            onDone={() => {
              setTab('overview');
              loadDashboard();
            }}
          />
        )}

        {tab === 'series' && <SeriesManagement exams={exams} />}
        {tab === 'users' && <UserManagement exams={exams} />}
        {tab === 'reports' && <Reports reports={reports} onReload={loadReports} />}

        {tab === 'overview' && (
          <>
            <section className="page-heading">
              <div>
                <span className="eyebrow">{staff ? 'Workspace' : 'Student portal'}</span>
                <h1>{staff ? 'Assessment control center' : 'My assessments'}</h1>
                <p className="muted">
                  {staff
                    ? 'Create, assign, monitor, review, and retire exam data from one workspace.'
                    : 'Only exams assigned to your account appear here. Active attempts are recoverable until the server deadline.'}
                </p>
              </div>

              {staff && (
                <button className="primary" onClick={() => setTab('create')}>
                  + Create exam
                </button>
              )}
            </section>

            {activeAttempt && (
              <ResumeBanner
                attempt={activeAttempt}
                onResume={() =>
                  setTaking({
                    exam: exams.find(e => e.id === activeAttempt.exam_id),
                    attemptId: activeAttempt.id
                  })
                }
              />
            )}

            {loading && (
              <div className="loading-line">
                <div className="spinner small" />
                Syncing workspace…
              </div>
            )}

            <section className="metric-grid">
              <Metric
                label={staff ? 'Live exams' : 'Assigned exams'}
                value={exams.length}
                detail={staff ? 'Active, non-archived' : 'Published and assigned'}
              />
              <Metric
                label="Active attempts"
                value={
                  staff
                    ? reports.filter(r => r.status === 'in_progress').length
                    : attempts.filter(a => a.status === 'in_progress').length
                }
                detail="Not yet submitted"
              />
              <Metric
                label="Integrity events"
                value={
                  staff
                    ? reports.reduce((sum, r) => sum + Number(r.violations || 0), 0)
                    : attempts.reduce((sum, a) => sum + Number(a.violation_count || 0), 0)
                }
                detail="Recorded for review"
              />
            </section>

            <section className="card-section">
              <div className="section-title">
                <div>
                  <h2>{staff ? 'Exams' : 'Assigned exams'}</h2>
                  <p className="muted">
                    {staff
                      ? 'Create timers, publish, and delete completed exams when their data is no longer needed.'
                      : 'Open an assigned exam to start or resume it.'}
                  </p>
                </div>
              </div>

              <div className="exam-grid">
                {exams.map(ex => (
                  <ExamCard
                    key={ex.id}
                    exam={ex}
                    student={!staff}
                    onStart={() =>
                      setTaking({
                        exam: ex,
                        attemptId: ex.active_attempt_id
                      })
                    }
                    onEdit={() => setEditingExam(ex)}
                    onDelete={async () => {
                      if (
                        !confirm(
                          `Delete “${ex.title}”? This permanently removes its questions, enrollments, attempts, answers and violation logs.`
                        )
                      ) {
                        return;
                      }

                      try {
                        await request(`/exams/${ex.id}`, {
                          method: 'DELETE'
                        });
                        loadDashboard();
                      } catch (err) {
                        alert(err.message);
                      }
                    }}
                  />
                ))}

                {!exams.length && !loading && (
                  <EmptyState
                    text={
                      staff
                        ? 'No exams yet. Create your first timed assessment.'
                        : 'No published exam is assigned to your account yet.'
                    }
                  />
                )}
              </div>
            </section>
          </>
        )}

        {editingExam && (
          <EditExamDrawer
            exam={editingExam}
            onClose={() => setEditingExam(null)}
            onSaved={() => {
              setEditingExam(null);
              loadDashboard();
            }}
          />
        )}
      </main>
    </div>
  );
}


function EditExamDrawer({ exam, onClose, onSaved }) {
  const [form, setForm] = useState({ title: exam.title, description: exam.description || '', duration_minutes: exam.duration_minutes, pass_mark: exam.pass_mark });
  const [error, setError] = useState(''); const [saving, setSaving] = useState(false);
  const save = async e => { e.preventDefault(); setError(''); setSaving(true); try { await request(`/exams/${exam.id}`, { method: 'PUT', body: JSON.stringify({ ...form, duration_minutes: Number(form.duration_minutes), pass_mark: Number(form.pass_mark) }) }); onSaved() } catch (err) { setError(isNetworkError(err) ? 'Network error: exam settings could not be saved.' : err.message) } finally { setSaving(false) } };
  return <div className="drawer-backdrop" onMouseDown={onClose}><form className="review-drawer edit-drawer" onSubmit={save} onMouseDown={e => e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">Exam settings</span><h2>Edit timer & rules</h2><p className="muted">Changes affect future attempts. An already-running attempt keeps its original server deadline.</p></div><button type="button" className="ghost close-button" onClick={onClose}>×</button></div><div className="drawer-body"><Field label="Exam title" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })} required /><label className="field"><span>Timer (minutes)</span><input type="number" min="1" max="600" value={form.duration_minutes} onChange={e => setForm({ ...form, duration_minutes: e.target.value })} required /><small>Quick presets: <button type="button" className="chip" onClick={() => setForm({ ...form, duration_minutes: 30 })}>30m</button><button type="button" className="chip" onClick={() => setForm({ ...form, duration_minutes: 45 })}>45m</button><button type="button" className="chip" onClick={() => setForm({ ...form, duration_minutes: 60 })}>60m</button><button type="button" className="chip" onClick={() => setForm({ ...form, duration_minutes: 90 })}>90m</button><button type="button" className="chip" onClick={() => setForm({ ...form, duration_minutes: 120 })}>120m</button></small></label><Field label="Pass mark (%)" type="number" min="0" max="100" value={form.pass_mark} onChange={e => setForm({ ...form, pass_mark: e.target.value })} required /><label className="field"><span>Description</span><textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} /></label>{error && <div className="alert danger">{error}</div>}<button className="primary full" disabled={saving}>{saving ? 'Saving…' : 'Save exam settings'}</button></div></form></div>
}

function Metric({ label, value, detail }) { return <article className="metric-card"><span>{label}</span><strong>{value}</strong><small>{detail}</small></article> }
function ResumeBanner({ attempt, onResume }) { const remaining = Math.max(0, Math.floor((new Date(attempt.expires_at).getTime() - Date.now()) / 1000)); return <section className="resume-banner"><div><span className="badge warning">Resume available</span><h2>{attempt.title}</h2><p>Your active attempt, saved answers, and server deadline are still available.</p></div><div className="resume-meta"><strong>{formatTime(remaining)}</strong><small>server time remaining</small><button className="primary" onClick={onResume}>Resume exam</button></div></section> }
function ExamCard({ exam, student, onStart, onEdit, onDelete }) { return <article className="exam-card"><div className="exam-card-top"><span className={`badge ${exam.published ? 'success' : ''}`}>{exam.published ? 'Published' : 'Draft'}</span>{student && exam.latest_attempt_status === 'submitted' && <span className="badge neutral">Submitted</span>}{!student && <div className="card-tools"><button className="ghost compact-button" onClick={onEdit}>Edit</button><button className="danger-link" onClick={onDelete}>Delete</button></div>}</div><h2>{exam.title}</h2><p>{exam.description || 'No description provided.'}</p><div className="exam-meta"><span>◫ {exam.question_count} questions</span><span>◴ {exam.duration_minutes} min</span><span>✓ {exam.pass_mark}% pass</span></div>{student && <>{exam.registration_code && <small className="registration-code">Registration: <strong>{exam.registration_code}</strong></small>}<button className="primary full" disabled={exam.latest_attempt_status === 'submitted'} onClick={onStart}>{exam.has_active_attempt ? 'Resume attempt' : exam.latest_attempt_status === 'submitted' ? 'Already submitted' : 'Start exam'}</button></>}{!student && <small className="muted">Created by {exam.creator || '—'}</small>}</article> }
function EmptyState({ text }) { return <div className="empty-state"><span>∅</span><strong>{text}</strong></div> }

function ExamCreator({ onDone }) {
  const [exam, setExam] = useState({ title: '', description: '', duration_minutes: 60, pass_mark: 40, published: false }); const [created, setCreated] = useState(null); const [question, setQuestion] = useState({ prompt: '', options: ['', '', '', ''], correct_answer: 0, marks: 1 }); const [count, setCount] = useState(0); const [error, setError] = useState('');
  const createExam = async e => { e.preventDefault(); setError(''); try { const data = await request('/exams', { method: 'POST', body: JSON.stringify({ ...exam, duration_minutes: Number(exam.duration_minutes), pass_mark: Number(exam.pass_mark) }) }); setCreated(data) } catch (err) { setError(isNetworkError(err) ? 'Network error: exam could not be created.' : err.message) } };
  const addQuestion = async e => { e.preventDefault(); setError(''); try { await request(`/exams/${created.id}/questions`, { method: 'POST', body: JSON.stringify({ ...question, marks: Number(question.marks) }) }); setCount(n => n + 1); setQuestion({ prompt: '', options: ['', '', '', ''], correct_answer: 0, marks: 1 }) } catch (err) { setError(err.message) } };
  if (created) return <section className="editor-panel"><div className="page-heading compact"><div><span className="eyebrow">Question authoring</span><h1>{created.title}</h1><p className="muted">Add questions, then publish. The timer is server-enforced for every student.</p></div><div className="editor-count"><strong>{count}</strong><small>questions added</small></div></div><form onSubmit={addQuestion} className="question-form"><label className="field wide"><span>Question</span><textarea value={question.prompt} onChange={e => setQuestion({ ...question, prompt: e.target.value })} required placeholder="Write the question clearly…" /></label><div className="option-grid">{question.options.map((value, index) => <label className="field" key={index}><span>Option {String.fromCharCode(65 + index)}</span><input value={value} onChange={e => { const next = [...question.options]; next[index] = e.target.value; setQuestion({ ...question, options: next }) }} required /></label>)}</div><div className="inline-fields"><label className="field"><span>Correct answer</span><select value={question.correct_answer} onChange={e => setQuestion({ ...question, correct_answer: Number(e.target.value) })}>{question.options.map((_, i) => <option value={i} key={i}>Option {String.fromCharCode(65 + i)}</option>)}</select></label><Field label="Marks" type="number" min="1" max="100" value={question.marks} onChange={e => setQuestion({ ...question, marks: e.target.value })} /></div>{error && <div className="alert danger">{error}</div>}<div className="form-actions"><button className="primary">Add question</button><button type="button" className="secondary" onClick={async () => { try { await request(`/exams/${created.id}/publish`, { method: 'POST', body: JSON.stringify({ published: true }) }); onDone() } catch (err) { setError(err.message) } }}>Publish and finish</button><button type="button" className="ghost" onClick={onDone}>Save for later</button></div></form></section>
  return <section className="editor-panel"><div className="page-heading compact"><div><span className="eyebrow">New assessment</span><h1>Create an exam</h1><p className="muted">Set the timer and pass mark now. Students receive a server-controlled deadline when they start.</p></div></div><form onSubmit={createExam} className="two-col-form"><Field label="Exam title" value={exam.title} onChange={e => setExam({ ...exam, title: e.target.value })} required /><label className="field"><span>Timer (minutes)</span><input type="number" min="1" max="600" value={exam.duration_minutes} onChange={e => setExam({ ...exam, duration_minutes: e.target.value })} required /><small>Quick presets: <button type="button" className="chip" onClick={() => setExam({ ...exam, duration_minutes: 30 })}>30m</button><button type="button" className="chip" onClick={() => setExam({ ...exam, duration_minutes: 45 })}>45m</button><button type="button" className="chip" onClick={() => setExam({ ...exam, duration_minutes: 60 })}>60m</button><button type="button" className="chip" onClick={() => setExam({ ...exam, duration_minutes: 90 })}>90m</button><button type="button" className="chip" onClick={() => setExam({ ...exam, duration_minutes: 120 })}>120m</button></small></label><label className="field wide"><span>Description</span><textarea value={exam.description} onChange={e => setExam({ ...exam, description: e.target.value })} /></label><Field label="Pass mark (%)" type="number" min="0" max="100" value={exam.pass_mark} onChange={e => setExam({ ...exam, pass_mark: e.target.value })} required /><label className="check-card"><input type="checkbox" checked={exam.published} onChange={e => setExam({ ...exam, published: e.target.checked })} /><span><strong>Publish immediately</strong><small>Only publish when questions are already present.</small></span></label>{error && <div className="alert danger wide">{error}</div>}<div className="form-actions wide"><button className="primary">Create and add questions</button><button type="button" className="secondary" onClick={onDone}>Cancel</button></div></form></section>
}

function SeriesManagement({ exams }) {
  const [series, setSeries] = useState([]); const [error, setError] = useState(''); const [form, setForm] = useState({ exam_id: '', batch_name: '', prefix: 'STUD-', next_number: 1, padding: 3 });
  const load = useCallback(() => request('/admin/exam-series').then(setSeries).catch(e => setError(e.message)), []); useEffect(() => { load() }, [load]);
  const save = async e => { e.preventDefault(); setError(''); try { await request('/admin/exam-series', { method: 'POST', body: JSON.stringify({ ...form, next_number: Number(form.next_number), padding: Number(form.padding) }) }); setForm({ exam_id: '', batch_name: '', prefix: 'STUD-', next_number: 1, padding: 3 }); load() } catch (err) { setError(err.message) } };
  const remove = async id => { if (!confirm('Delete this ID series? Existing student IDs remain unchanged.')) return; try { await request(`/admin/exam-series/${id}`, { method: 'DELETE' }); load() } catch (err) { setError(err.message) } };
  return <section className="editor-panel"><div className="page-heading compact"><div><span className="eyebrow">Administration</span><h1>Student ID series</h1><p className="muted">Create batch-wise or exam-wise identifiers such as STUD-001, CSE26-001, or EXAM1-001.</p></div></div><div className="split-panel"><form onSubmit={save} className="stack-form"><label className="field"><span>Scope</span><select value={form.exam_id} onChange={e => setForm({ ...form, exam_id: e.target.value })}><option value="">Batch / global</option>{exams.map(e => <option value={e.id} key={e.id}>{e.title}</option>)}</select></label><Field label="Batch name" value={form.batch_name} onChange={e => setForm({ ...form, batch_name: e.target.value })} placeholder="2026 CSE" required /><Field label="Prefix" value={form.prefix} onChange={e => setForm({ ...form, prefix: e.target.value.toUpperCase() })} placeholder="CSE26-STUD-" required /><Field label="Starting number" type="number" min="1" value={form.next_number} onChange={e => setForm({ ...form, next_number: e.target.value })} required /><Field label="Number padding" type="number" min="1" max="8" value={form.padding} onChange={e => setForm({ ...form, padding: e.target.value })} required />{error && <div className="alert danger">{error}</div>}<button className="primary">Create series</button></form><div className="series-grid">{series.map(s => <article className="series-card" key={s.id}><div className="series-icon">#</div><div><strong>{s.prefix}{String(s.next_number).padStart(s.padding, '0')}</strong><span>{s.batch_name}</span><small>{s.exam_title || 'Batch / global series'}</small></div><button className="ghost" onClick={() => remove(s.id)}>Delete</button></article>)}{!series.length && <EmptyState text="No ID series yet." />}</div></div></section>
}

function UserManagement({ exams }) {
  const [users, setUsers] = useState([]); const [series, setSeries] = useState([]); const [editing, setEditing] = useState(null); const [error, setError] = useState(''); const [form, setForm] = useState({ name: '', student_id: '', email: '', password: '', role: 'student', exam_id: '', series_id: '', batch_code: '' });
  const load = useCallback(async () => { try { const [u, s] = await Promise.all([request('/users'), request('/admin/exam-series')]); setUsers(u); setSeries(s) } catch (e) { setError(e.message) } }, []); useEffect(() => { load() }, [load]);
  const save = async e => { e.preventDefault(); setError(''); try { await request('/users', { method: 'POST', body: JSON.stringify({ ...form, student_id: form.student_id || undefined }) }); setForm({ name: '', student_id: '', email: '', password: '', role: 'student', exam_id: '', series_id: '', batch_code: '' }); load() } catch (err) { setError(err.message) } };
  const startEdit = u => setEditing({ id: u.id, name: u.name, student_id: u.student_id || '', batch_code: u.batch_code || '' });
  const saveEdit = async e => { e.preventDefault(); try { await request(`/users/${editing.id}`, { method: 'PUT', body: JSON.stringify(editing) }); setEditing(null); load() } catch (err) { setError(err.message) } };
  const studentSeries = series.filter(s => !form.exam_id || !s.exam_id || s.exam_id === form.exam_id);
  return <section className="editor-panel"><div className="page-heading compact"><div><span className="eyebrow">Administration</span><h1>Student registry</h1><p className="muted">Students can self-register, while administrators retain control of names, IDs, batches, and exam mapping.</p></div></div><div className="split-panel"><form onSubmit={save} className="stack-form"><h3>Create student manually</h3><Field label="Full name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required /><Field label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} required /><Field label="Temporary password" type="password" minLength="8" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} required /><label className="field"><span>Assign exam</span><select value={form.exam_id} onChange={e => setForm({ ...form, exam_id: e.target.value, series_id: '' })}><option value="">No exam assignment</option>{exams.map(e => <option value={e.id} key={e.id}>{e.title}</option>)}</select></label>{form.role === 'student' && <><label className="field"><span>ID series</span><select value={form.series_id} onChange={e => setForm({ ...form, series_id: e.target.value })}><option value="">Select series</option>{studentSeries.map(s => <option value={s.id} key={s.id}>{s.batch_name} · {s.prefix}…</option>)}</select></label><Field label="Optional Student ID override" value={form.student_id} onChange={e => setForm({ ...form, student_id: e.target.value })} /><Field label="Batch code" value={form.batch_code} onChange={e => setForm({ ...form, batch_code: e.target.value })} /></>}{error && <div className="alert danger">{error}</div>}<button className="primary">Create student</button><small className="muted">Self-registered students appear here automatically with generated IDs.</small></form><div className="table-wrap"><table><thead><tr><th>Student</th><th>ID / Batch</th><th>Email</th><th>Exam(s)</th><th /></tr></thead><tbody>{users.map(u => <tr key={u.id}><td><strong>{u.name}</strong><small>{u.role}</small></td><td>{u.student_id || '—'}<small>{u.batch_code || '—'}</small></td><td>{u.email}</td><td>{(u.enrollments || []).map(e => <div key={e.exam_id}><strong>{e.title}</strong><small>{e.registration_code}</small></div>)}</td><td>{u.role === 'student' && <button className="secondary compact-button" onClick={() => startEdit(u)}>Edit</button>}</td></tr>)}</tbody></table></div></div>{editing && <div className="drawer-backdrop" onMouseDown={() => setEditing(null)}><form className="review-drawer edit-drawer" onSubmit={saveEdit} onMouseDown={e => e.stopPropagation()}><div className="drawer-header"><div><span className="eyebrow">Student record</span><h2>Edit student</h2></div><button type="button" className="ghost close-button" onClick={() => setEditing(null)}>×</button></div><div className="drawer-body"><Field label="Name" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} required /><Field label="Student ID" value={editing.student_id} onChange={e => setEditing({ ...editing, student_id: e.target.value })} /><Field label="Batch code" value={editing.batch_code} onChange={e => setEditing({ ...editing, batch_code: e.target.value })} /><button className="primary full">Save student</button></div></form></div>}</section>
}

function Reports({ reports, onReload }) { const [selected, setSelected] = useState(null); const [filter, setFilter] = useState('all'); const visible = reports.filter(r => filter === 'all' || r.status === filter || (filter === 'violations' && Number(r.violations) > 0)); return <section className="editor-panel"><div className="page-heading compact"><div><span className="eyebrow">Review center</span><h1>Attempt review</h1><p className="muted">A human-review workflow with event history and an explainable integrity risk index.</p></div><button className="secondary" onClick={onReload}>Refresh</button></div><div className="report-toolbar"><div className="filter-pills">{[['all', 'All'], ['in_progress', 'In progress'], ['submitted', 'Submitted'], ['violations', 'With violations']].map(([key, label]) => <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>)}</div></div><div className="table-wrap"><table className="report-table"><thead><tr><th>Exam / student</th><th>Status</th><th>Score</th><th>Risk</th><th>Events</th><th>Resume</th><th /></tr></thead><tbody>{visible.map(r => <tr key={r.id}><td><strong>{r.title}</strong><small>{r.student} · {r.student_id || 'No ID'} · {r.registration_code || 'No registration'}</small></td><td><span className={`status-pill ${r.status}`}>{r.status.replace('_', ' ')}</span></td><td>{r.score == null ? '—' : `${Number(r.score).toFixed(1)}%`}</td><td><span className={`risk-pill ${r.risk_band}`}>{r.risk_score}/100</span></td><td><strong>{r.violations}</strong><small>{r.critical_violations} critical · {r.unreviewed_violations} open</small></td><td>{r.resume_count}</td><td><button className="secondary compact-button" onClick={() => setSelected(r.id)}>Review</button></td></tr>)}{!visible.length && <tr><td colSpan="7"><EmptyState text="No attempts match this filter." /></td></tr>}</tbody></table></div>{selected && <ReviewDrawer attemptId={selected} onClose={() => setSelected(null)} />}</section> }
function ReviewDrawer({ attemptId, onClose }) { const [data, setData] = useState(null); const [error, setError] = useState(''); const load = useCallback(() => request(`/reports/attempts/${attemptId}`).then(setData).catch(e => setError(e.message)), [attemptId]); useEffect(() => { load() }, [load]); return <div className="drawer-backdrop" onMouseDown={onClose}><aside className="review-drawer" onMouseDown={e => e.stopPropagation()}>{!data ? <div className="drawer-loading">{error ? <div className="alert danger">{error}</div> : 'Loading review…'}</div> : <><header className="drawer-header"><div><span className="eyebrow">Attempt review</span><h2>{data.attempt.student}</h2><p className="muted">{data.attempt.title} · {data.attempt.student_id || 'No ID'}</p></div><button className="ghost close-button" onClick={onClose}>×</button></header><div className="review-summary"><div><span>Status</span><strong>{data.attempt.status}</strong></div><div><span>Score</span><strong>{data.attempt.score == null ? '—' : `${Number(data.attempt.score).toFixed(1)}%`}</strong></div><div><span>Integrity risk</span><strong className={`risk-text ${data.risk.band}`}>{data.risk.score}/100</strong></div></div><div className="risk-card"><div><span className="eyebrow">Explainable integrity risk</span><strong>{data.risk.band}</strong></div><ul>{data.risk.factors.map(f => <li key={f}>{f}</li>)}</ul></div><div className="timeline">{data.violations.map(event => <ViolationRow event={event} key={event.id} onSaved={load} />)}{!data.violations.length && <EmptyState text="No integrity events recorded." />}</div></>}</aside></div> }
function ViolationRow({ event, onSaved }) { const [note, setNote] = useState(event.reviewer_note || ''); const [saving, setSaving] = useState(false); const severity = event.severity || 'warning'; const save = async reviewed => { setSaving(true); try { await request(`/reports/violations/${event.id}`, { method: 'PUT', body: JSON.stringify({ reviewed, reviewer_note: note }) }); onSaved() } catch (e) { alert(e.message) } finally { setSaving(false) } }; return <article className={`violation-row ${severity}`}><div className="violation-time">{new Date(event.occurred_at).toLocaleString()}</div><div className="violation-main"><div className="violation-heading"><div><strong>{event.violation_type.replaceAll('_', ' ')}</strong><span className={`severity-tag ${severity}`}>{severity}</span></div><span className={event.reviewed ? 'reviewed' : 'open'}>{event.reviewed ? 'Reviewed' : 'Open'}</span></div><p>{event.source} signal</p><pre>{JSON.stringify(event.details, null, 2)}</pre><textarea value={note} onChange={e => setNote(e.target.value)} placeholder="Reviewer note…" /><div className="violation-actions"><button className="secondary compact-button" disabled={saving} onClick={() => save(!event.reviewed)}>{event.reviewed ? 'Re-open' : 'Mark reviewed'}</button></div></div></article> }

function TakeExam({ exam, attemptId, onClose }) {
  const [data, setData] = useState(null); const [answers, setAnswers] = useState({}); const [left, setLeft] = useState(0); const [current, setCurrent] = useState(0); const [error, setError] = useState(''); const [networkOffline, setNetworkOffline] = useState(!navigator.onLine); const [saveState, setSaveState] = useState('Saved'); const [result, setResult] = useState(null); const [alerts, setAlerts] = useState([]); const [fullscreenState, setFullscreenState] = useState(true); const submitLock = useRef(false); const localDraftKey = data ? `${DRAFT_PREFIX}${data.attempt.id}` : null;
  const alertTimers = useRef(new Map());

  const notify = useCallback((message, tone = 'warning', duration = 4500) => {
    const id = `${Date.now()}-${Math.random()}`;

    setAlerts(items => [
      { id, message, tone },
      ...items
    ].slice(0, 4));

    const timer = window.setTimeout(() => {
      setAlerts(items => items.filter(item => item.id !== id));
      alertTimers.current.delete(id);
    }, duration);

    alertTimers.current.set(id, timer);
    return id;
  }, []);

  useEffect(() => {
    return () => {
      alertTimers.current.forEach(timer => window.clearTimeout(timer));
      alertTimers.current.clear();
    };
  }, []);
  const recordViolation = useCallback(async payload => { if (!data?.attempt?.id) return false; const id = data.attempt.id; if (!navigator.onLine) { writeQueue(id, [...readQueue(id), payload]); return false } try { await request(`/attempts/${id}/violation`, { method: 'POST', body: JSON.stringify(payload), timeoutMs: 8000 }); return true } catch (err) { writeQueue(id, [...readQueue(id), payload]); if (isNetworkError(err)) notify('Network error: integrity event queued locally for automatic sync.', 'danger'); return false } }, [data?.attempt?.id, notify]);
  const syncViolations = useCallback(async () => { if (!data?.attempt?.id || !navigator.onLine) return; const id = data.attempt.id; const queue = readQueue(id); if (!queue.length) return; const remaining = []; for (const payload of queue) { try { await request(`/attempts/${id}/violation`, { method: 'POST', body: JSON.stringify(payload), timeoutMs: 8000 }) } catch { remaining.push(payload); break } } writeQueue(id, remaining); if (!remaining.length) notify('Queued integrity events synced.', 'info') }, [data?.attempt?.id, notify]);
  const syncLocal = useCallback(async () => { if (!data || !navigator.onLine) return; const draft = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}${data.attempt.id}`) || '{}'); for (const [qid, val] of Object.entries(draft.answers || {})) await request(`/attempts/${data.attempt.id}/answers`, { method: 'PUT', body: JSON.stringify({ question_id: qid, selected_answer: Number(val) }), timeoutMs: 8000 }); setSaveState('Saved') }, [data]);
  const loadAttempt = useCallback(async () => { setError(''); try { const secureResult = await window.secureExam?.setSecure?.(true); if (secureResult && !secureResult.fullscreen) { setFullscreenState(false); notify('Fullscreen lock is not active. Retrying secure window lock…', 'danger'); await window.secureExam?.setSecure?.(true) } const payload = attemptId ? await request(`/attempts/${attemptId}`) : await request(`/exams/${exam.id}/start`, { method: 'POST' }); const map = Object.fromEntries(payload.answers.map(a => [a.question_id, Number(a.selected_answer)])); const saved = JSON.parse(localStorage.getItem(`${DRAFT_PREFIX}${payload.attempt.id}`) || '{}'); const merged = { ...map, ...(saved.answers || {}) }; setData(payload); setAnswers(merged); setLeft(payload.remaining_seconds); setCurrent(0); localStorage.setItem(`${DRAFT_PREFIX}${payload.attempt.id}`, JSON.stringify({ answers: merged, updatedAt: Date.now() })); if (payload.resumed) notify('Previous attempt restored. Continue from your last saved answer.', 'info'); } catch (err) { setError(isNetworkError(err) ? 'Network error: the secure exam server cannot be reached. Your active session remains resumable until its server deadline.' : err.message) } }, [attemptId, exam, notify]);
  useEffect(() => { loadAttempt(); return () => { window.secureExam?.setSecure?.(false) } }, [loadAttempt]);
  useEffect(() => { if (data) syncViolations() }, [data, syncViolations]);
  useEffect(() => { if (!data) return; const timer = setInterval(() => setLeft(v => Math.max(0, v - 1)), 1000); const hb = setInterval(() => request(`/attempts/${data.attempt.id}/heartbeat`, { method: 'POST', timeoutMs: 6000 }).then(() => setNetworkOffline(false)).catch(err => { setNetworkOffline(true); notify(isNetworkError(err) ? 'Network error: heartbeat lost. The server deadline is still active.' : err.message, 'danger') }), 12000); return () => { clearInterval(timer); clearInterval(hb) } }, [data, notify]);
  useEffect(() => { if (!data || !localDraftKey) return; localStorage.setItem(localDraftKey, JSON.stringify({ answers, updatedAt: Date.now() })) }, [answers, data, localDraftKey]);
  useEffect(() => { const off = () => { setNetworkOffline(true); setSaveState('Offline'); notify('Network disconnected. Answers are protected locally and will sync after reconnect.', 'danger'); recordViolation({ type: 'NETWORK_OFFLINE', severity: 'warning', details: { online: false }, source: 'browser' }) }; const on = () => { setNetworkOffline(false); notify('Network restored. Syncing local answers and integrity events.', 'info'); recordViolation({ type: 'NETWORK_RECOVERED', severity: 'info', details: { online: true }, source: 'browser' }); syncLocal().catch(() => { }); syncViolations() }; window.addEventListener('offline', off); window.addEventListener('online', on); return () => { window.removeEventListener('offline', off); window.removeEventListener('online', on) } }, [notify, recordViolation, syncLocal, syncViolations]);
  useEffect(() => { if (!data) return; const visibility = () => { if (document.hidden) { notify('Tab switch detected and logged for review.', 'danger'); recordViolation({ type: 'TAB_SWITCH', severity: 'high', details: { hidden: true }, source: 'browser' }) } }; const copy = e => { e.preventDefault(); notify('Copy is disabled during the secure exam.', 'warning'); recordViolation({ type: 'COPY_ATTEMPT', details: { blocked: true }, source: 'browser' }) }; const paste = e => { e.preventDefault(); notify('Paste is disabled during the secure exam.', 'warning'); recordViolation({ type: 'PASTE_ATTEMPT', details: { blocked: true }, source: 'browser' }) }; const context = e => { e.preventDefault(); recordViolation({ type: 'CONTEXT_MENU_ATTEMPT', details: { blocked: true }, source: 'browser' }) }; document.addEventListener('visibilitychange', visibility); document.addEventListener('copy', copy); document.addEventListener('paste', paste); document.addEventListener('contextmenu', context); const off = window.secureExam?.onViolation?.(event => { if (event?.type) { notify(`${event.type.replaceAll('_', ' ')} detected and recorded for review.`, event.type === 'WINDOW_BLUR' || event.type === 'FULLSCREEN_EXIT' ? 'danger' : 'warning'); recordViolation({ ...event, source: 'electron' }) } }); const fs = window.secureExam?.onFullscreenState?.(state => { if (state?.secure && !state.fullscreen) { setFullscreenState(false); notify('Fullscreen was lost. SecureExam is restoring the secure window.', 'danger'); recordViolation({ type: 'FULLSCREEN_EXIT', severity: 'high', details: state, source: 'electron' }) } else if (state?.fullscreen) setFullscreenState(true) }); return () => { document.removeEventListener('visibilitychange', visibility); document.removeEventListener('copy', copy); document.removeEventListener('paste', paste); document.removeEventListener('contextmenu', context); if (typeof off === 'function') off(); if (typeof fs === 'function') fs() } }, [data, notify, recordViolation]);
  useEffect(() => { if (left === 0 && data && !result) submitExam() }, [left, data]);
  const persistAnswer = useCallback(async (qid, value) => { setSaveState('Saving…'); try { if (!navigator.onLine) throw Object.assign(new Error('Offline'), { isNetworkError: true }); await request(`/attempts/${data.attempt.id}/answers`, { method: 'PUT', body: JSON.stringify({ question_id: qid, selected_answer: value }) }); setSaveState('Saved') } catch (err) { setSaveState('Queued locally'); notify(isNetworkError(err) ? 'Network error: answer is queued locally.' : 'Answer save error: ' + err.message, 'warning') } }, [data, notify]);
  async function submitExam() { if (!data || result || submitLock.current) return; submitLock.current = true; try { await syncLocal(); await syncViolations(); const response = await request(`/attempts/${data.attempt.id}/submit`, { method: 'POST', timeoutMs: 15000 }); setResult(response); localStorage.removeItem(`${DRAFT_PREFIX}${data.attempt.id}`); window.secureExam?.setSecure?.(false) } catch (err) { submitLock.current = false; notify(isNetworkError(err) ? 'Network error: submission did not reach the server. Your active attempt remains resumable.' : err.message, 'danger') } }
  if (error && !data) return <div className="exam-error"><div className="alert danger"><strong>Unable to open the exam</strong><span>{error}</span></div><button className="secondary" onClick={loadAttempt}>Retry</button><button className="ghost" onClick={onClose}>Return to dashboard</button></div>;
  if (!data) return <div className="boot-screen exam-launch"><div className="spinner" /><strong>Opening secure exam…</strong><small>Locking the window, checking your assignment, and restoring answers.</small></div>;
  if (result) return <section className="result-screen"><div className="result-card"><span className="eyebrow">Submission complete</span><h1>{exam.title}</h1><strong className="result-score">{Number(result.score).toFixed(1)}%</strong><p>{result.earned} of {result.total} marks</p><button className="primary" onClick={onClose}>Return to dashboard</button></div></section>;
  const question = data.questions[current]; const answeredCount = Object.keys(answers).filter(id => data.questions.some(q => q.id === id)).length;
  return (
    <div className="exam-shell">
      <header className="exam-topbar">
        <div className="exam-title">
          <span className="brand-dot" />
          <div>
            <strong>{data.exam.title}</strong>
            <small>{data.attempt.student_code || 'Student'} · {data.attempt.registration_code || 'Registered'}</small>
          </div>
        </div>

        <div className={`network-pill ${networkOffline ? 'offline' : ''}`}>
          <span className="system-dot" />
          {networkOffline ? 'Offline · local autosave' : 'Network connected'}
        </div>

        <div className="timer-block">
          <small>Time remaining</small>
          <strong className={left < 60 ? 'urgent-timer' : ''}>
            {formatTime(left)}
          </strong>
        </div>

        <button className="secondary submit-button" onClick={submitExam}>
          Submit exam
        </button>
      </header>

      {alerts.length > 0 && (
        <div className="exam-alert-stack" aria-live="polite">
          {alerts.map(a => (
            <div
              key={a.id}
              className={`alert ${
                a.tone === 'danger'
                  ? 'danger'
                  : a.tone === 'info'
                    ? 'info'
                    : 'warning'
              }`}
            >
              <strong>Integrity notice</strong>
              <span>{a.message}</span>
            </div>
          ))}
        </div>
      )}

      <ProctoringPanel
        attemptId={data.attempt.id}
        onReport={recordViolation}
        onIntegrityEvent={event => {
          if (event?.type) {
            notify(
              `${event.type.replaceAll('_', ' ')} detected and recorded.`,
              ['critical', 'high'].includes(event.severity) ? 'danger' : 'warning'
            );
          }
        }}
      />

      <main className="exam-main">
        <section className="question-stage">
          <div className="question-kicker">
            <span>Question {current + 1} of {data.questions.length}</span>
            <span>{answeredCount} answered</span>
          </div>

          <article className="question-card">
            <div className="question-heading">
              <span className="question-number">
                {String(current + 1).padStart(2, '0')}
              </span>
              <div>
                <h1>{question.prompt}</h1>
                <small>
                  {question.marks} mark{question.marks !== 1 ? 's' : ''}
                </small>
              </div>
            </div>

            <div className="answers">
              {question.options.map((option, index) => (
                <label
                  className={`answer-row ${
                    answers[question.id] === index ? 'selected' : ''
                  }`}
                  key={`${question.id}-${index}`}
                >
                  <input
                    type="radio"
                    name={question.id}
                    checked={answers[question.id] === index}
                    onChange={() => {
                      setAnswers(currentAnswers => ({
                        ...currentAnswers,
                        [question.id]: index
                      }));
                      persistAnswer(question.id, index);
                    }}
                  />
                  <span className="answer-letter">
                    {String.fromCharCode(65 + index)}
                  </span>
                  <span>{option}</span>
                </label>
              ))}
            </div>
          </article>

          <div className="question-actions">
            <button
              className="secondary"
              disabled={current === 0}
              onClick={() => setCurrent(i => Math.max(0, i - 1))}
            >
              ← Previous
            </button>

            <div className="question-dots">
              {data.questions.map((q, index) => (
                <button
                  key={q.id}
                  className={`${
                    index === current ? 'active' : ''
                  } ${answers[q.id] !== undefined ? 'answered' : ''}`}
                  onClick={() => setCurrent(index)}
                >
                  {index + 1}
                </button>
              ))}
            </div>

            <button
              className="primary"
              disabled={current === data.questions.length - 1}
              onClick={() =>
                setCurrent(i => Math.min(data.questions.length - 1, i + 1))
              }
            >
              Next →
            </button>
          </div>
        </section>
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
