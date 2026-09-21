import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { query, pool } from './db.js';
import { signUser, verifyUser } from './utils/jwt.js';

dotenv.config({ path: new URL('../../.env', import.meta.url) });

const app = express();
const PORT = Number(process.env.PORT || 5000);
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const CLIENT_URLS = String(process.env.CLIENT_URL || (IS_PRODUCTION ? '' : 'http://localhost:5173,http://127.0.0.1:5173'))
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

if (IS_PRODUCTION) {
  if (!process.env.CLIENT_URL) throw new Error('CLIENT_URL is required in production.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required in production.');
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('JWT_SECRET must contain at least 32 characters in production.');
}

const trustProxy = process.env.TRUST_PROXY;
if (trustProxy !== undefined) app.set('trust proxy', trustProxy === 'true' ? true : Number(trustProxy));
else app.set('trust proxy', IS_PRODUCTION ? 1 : false);

app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' },
  strictTransportSecurity: IS_PRODUCTION ? undefined : false,
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(cors({
  origin(origin, callback) {
    if (!origin || CLIENT_URLS.includes(origin)) return callback(null, true);
    return callback(null, false);
  },
  credentials: false,
}));
app.use(express.json({ limit: '256kb' }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many authentication attempts. Please try again later.' },
});
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 180,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { message: 'Too many requests. Please slow down.' },
});

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ message: 'Authentication required.' });
  try { req.user = verifyUser(token); next(); }
  catch { res.status(401).json({ message: 'Your session has expired. Please sign in again.' }); }
}

function allow(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ message: 'You do not have permission for this action.' });
    next();
  };
}

function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((value) => String(value ?? '').trim()).filter(Boolean);
}

function safeString(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 200;
}

function isValidPassword(value) {
  const bytes = Buffer.byteLength(value, 'utf8');
  return value.length >= 8 && bytes <= 72;
}

function safeDetails(value, maxBytes = 8192) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const serialized = JSON.stringify(value);
  if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw Object.assign(new Error('Integrity event details are too large.'), { statusCode: 400 });
  return value;
}

function severityFor(type) {
  const map = {
    MULTIPLE_FACES: 'high', TAB_SWITCH: 'high', WINDOW_BLUR: 'warning', FULLSCREEN_EXIT: 'high',
    DEVTOOLS_OPEN: 'critical', CAMERA_PERMISSION_DENIED: 'critical', CAMERA_ERROR: 'critical',
    MICROPHONE_PERMISSION_DENIED: 'high', MICROPHONE_ERROR: 'high', FACE_DETECTION_UNAVAILABLE: 'warning',
    NO_FACE: 'warning', NETWORK_OFFLINE: 'warning', NETWORK_RECOVERED: 'info', RESUME: 'info',
    ANSWER_SAVE_FAILED: 'warning', TECHNICAL_DISCONNECT: 'warning', COPY_ATTEMPT: 'warning',
    PASTE_ATTEMPT: 'warning', CONTEXT_MENU_ATTEMPT: 'info', NAVIGATION_BLOCKED: 'high',
    SUSTAINED_LOUD_AUDIO: 'warning', FULLSCREEN_FAILURE: 'high',
  };
  return map[type] || 'warning';
}

function riskFromCounts({ critical = 0, high = 0, warning = 0, info = 0, resumes = 0, burst = 0 }) {
  return Math.min(100, Math.round(critical * 24 + high * 11 + warning * 4 + info * 1 + resumes * 3 + burst * 6));
}

function riskBand(score) {
  if (score >= 70) return 'critical';
  if (score >= 40) return 'elevated';
  if (score >= 15) return 'watch';
  return 'low';
}

async function ensureExamManager(examId, user) {
  const { rows: [exam] } = await query('SELECT * FROM exams WHERE id=$1', [examId]);
  if (!exam) return { exam: null, allowed: false };
  const allowed = user.role === 'admin' || (user.role === 'instructor' && exam.created_by === user.id);
  return { exam, allowed };
}

async function getAttemptForStudent(attemptId, userId) {
  const { rows: [attempt] } = await query(
    `SELECT a.*, e.title, e.description, e.duration_minutes, e.pass_mark, e.published, e.starts_at, e.ends_at,
            ee.registration_code, u.name AS student_name, u.student_id AS student_code, u.batch_code
     FROM attempts a
     JOIN exams e ON e.id=a.exam_id
     JOIN users u ON u.id=a.student_id
     LEFT JOIN exam_enrollments ee ON ee.exam_id=a.exam_id AND ee.student_id=a.student_id
     WHERE a.id=$1 AND a.student_id=$2`,
    [attemptId, userId]
  );
  return attempt || null;
}

async function buildAttemptPayload(attempt) {
  const [{ rows: questions }, { rows: answers }] = await Promise.all([
    query(`SELECT id,prompt,options,marks,position FROM questions WHERE exam_id=$1 ORDER BY position,id`, [attempt.exam_id]),
    query(`SELECT question_id,selected_answer,updated_at FROM answers WHERE attempt_id=$1 ORDER BY updated_at`, [attempt.id]),
  ]);
  const remainingSeconds = Math.max(0, Math.floor((new Date(attempt.expires_at).getTime() - Date.now()) / 1000));
  return {
    attempt,
    exam: { id: attempt.exam_id, title: attempt.title, description: attempt.description, duration_minutes: attempt.duration_minutes, pass_mark: attempt.pass_mark },
    questions,
    answers,
    remaining_seconds: remainingSeconds,
  };
}

async function reserveStudentCode(client, seriesId, examId = null) {
  const { rows: [series] } = await client.query(`SELECT * FROM exam_series WHERE id=$1 AND active=true FOR UPDATE`, [seriesId]);
  if (!series) throw Object.assign(new Error('The selected student ID series is no longer available.'), { statusCode: 400 });
  if (examId && series.exam_id && String(series.exam_id) !== String(examId)) {
    throw Object.assign(new Error('The selected Student ID series belongs to a different exam.'), { statusCode: 400 });
  }
  const number = series.next_number;
  const code = `${series.prefix}${String(number).padStart(series.padding, '0')}`;
  await client.query(`UPDATE exam_series SET next_number=$1 WHERE id=$2`, [number + 1, series.id]);
  return { series, code };
}

async function createStudentAccount({ name, email, password, examId, seriesId, studentIdOverride = '', batchCode = '' }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (examId) {
      const { rows: [exam] } = await client.query('SELECT * FROM exams WHERE id=$1 AND archived=false', [examId]);
      if (!exam) throw Object.assign(new Error('Selected exam is unavailable.'), { statusCode: 400 });
    }

    let generatedCode = safeString(studentIdOverride, 60) || null;
    let series = null;
    if (!generatedCode && seriesId) ({ series, code: generatedCode } = await reserveStudentCode(client, seriesId, examId));
    if (!generatedCode) throw Object.assign(new Error('Choose an ID series or provide a Student ID.'), { statusCode: 400 });

    const { rows: [existingCode] } = await client.query('SELECT id FROM users WHERE student_id=$1', [generatedCode]);
    if (existingCode) throw Object.assign(new Error('That Student ID is already in use.'), { statusCode: 409 });

    const hash = await bcrypt.hash(password, 12);
    const finalBatch = safeString(batchCode || series?.batch_name || '', 100) || null;
    const { rows: [user] } = await client.query(
      `INSERT INTO users(name,email,password_hash,role,student_id,batch_code)
       VALUES($1,$2,$3,'student',$4,$5)
       RETURNING id,name,email,role,student_id,batch_code,created_at`,
      [safeString(name, 160), safeString(email, 200).toLowerCase(), hash, generatedCode, finalBatch]
    );

    let enrollment = null;
    if (examId) {
      const { rows: [row] } = await client.query(
        `INSERT INTO exam_enrollments(exam_id,student_id,registration_code)
         VALUES($1,$2,$3) RETURNING id,exam_id,student_id,registration_code,status,enrolled_at`,
        [examId, user.id, `REG-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`]
      );
      enrollment = row;
    }
    await client.query('COMMIT');
    return { user, enrollment };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

app.get('/api/health', (_req, res) => {
  res.status(200).json({
    ok: true,
    service: 'secure-exam-api',
    status: 'healthy',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/public/exams', asyncRoute(async (_req, res) => {
  const { rows } = await query(
    `SELECT e.id,e.title,e.description,e.duration_minutes,e.pass_mark,e.starts_at,e.ends_at,
            (SELECT count(*)::int FROM questions q WHERE q.exam_id=e.id) AS question_count,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'batch_name',s.batch_name,'prefix',s.prefix,'padding',s.padding)
                        ORDER BY s.created_at DESC) FROM exam_series s
                      WHERE s.active=true AND (s.exam_id=e.id OR s.exam_id IS NULL)), '[]'::jsonb) AS series
     FROM exams e
     WHERE e.published=true AND e.archived=false
     ORDER BY e.starts_at NULLS LAST,e.created_at DESC`
  );
  res.json(rows);
}));

app.post('/api/auth/register', authLimiter, asyncRoute(async (req, res) => {
  const name = safeString(req.body?.name, 160);
  const email = safeString(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  const examId = safeString(req.body?.exam_id, 80);
  const seriesId = safeString(req.body?.series_id, 80);
  if (name.length < 2 || !isValidEmail(email) || !isValidPassword(password) || !examId || !seriesId) {
    return res.status(400).json({ message: 'Name, email, password, exam and Student ID series are required.' });
  }
  const result = await createStudentAccount({ name, email, password, examId, seriesId });
  const token = signUser(result.user);
  res.status(201).json({ token, user: result.user, enrollment: result.enrollment, message: `Registration successful. Your Student ID is ${result.user.student_id}.` });
}));

app.post('/api/auth/login', authLimiter, asyncRoute(async (req, res) => {
  const email = safeString(req.body?.email, 200).toLowerCase();
  const password = String(req.body?.password || '');
  if (!isValidEmail(email) || !isValidPassword(password)) return res.status(400).json({ message: 'A valid email and password are required.' });
  const { rows: [user] } = await query('SELECT * FROM users WHERE lower(email)=lower($1)', [email]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ message: 'Invalid email or password.' });
  const token = signUser(user);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role, student_id: user.student_id || null, batch_code: user.batch_code || null } });
}));

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  const { rows: [user] } = await query('SELECT id,name,email,role,student_id,batch_code,avatar_url,created_at FROM users WHERE id=$1', [req.user.id]);
  if (!user) return res.status(404).json({ message: 'User not found.' });
  res.json(user);
}));

app.get('/api/exams', requireAuth, asyncRoute(async (req, res) => {
  const params = [];
  let visibility = 'WHERE e.archived=false';
  let studentProjection = '';
  if (req.user.role === 'student') {
    params.push(req.user.id);
    visibility += ` AND e.published=true AND EXISTS (SELECT 1 FROM exam_enrollments ee0 WHERE ee0.exam_id=e.id AND ee0.student_id=$1 AND ee0.status='active') AND NOT EXISTS (SELECT 1 FROM attempts a0 WHERE a0.exam_id=e.id AND a0.student_id=$1 AND a0.status IN ('submitted','expired','terminated'))`;
    studentProjection = `,
      EXISTS (SELECT 1 FROM attempts a WHERE a.exam_id=e.id AND a.student_id=$1 AND a.status='in_progress') AS has_active_attempt,
      (SELECT a.id FROM attempts a WHERE a.exam_id=e.id AND a.student_id=$1 AND a.status='in_progress' ORDER BY a.started_at DESC LIMIT 1) AS active_attempt_id,
      (SELECT a.status FROM attempts a WHERE a.exam_id=e.id AND a.student_id=$1 ORDER BY a.started_at DESC LIMIT 1) AS latest_attempt_status,
      (SELECT ee.registration_code FROM exam_enrollments ee WHERE ee.exam_id=e.id AND ee.student_id=$1 LIMIT 1) AS registration_code`;
  } else if (req.user.role === 'instructor') {
    params.push(req.user.id);
    visibility += ` AND e.created_by=$1`;
  }
  const { rows } = await query(
    `SELECT e.*,u.name AS creator,
            (SELECT count(*)::int FROM questions q WHERE q.exam_id=e.id) AS question_count
            ${studentProjection}
     FROM exams e LEFT JOIN users u ON u.id=e.created_by
     ${visibility}
     ORDER BY e.starts_at NULLS LAST,e.created_at DESC`, params
  );
  res.json(rows);
}));

app.post('/api/exams', requireAuth, allow('admin','instructor'), asyncRoute(async (req, res) => {
  const title = safeString(req.body?.title, 200);
  const description = safeString(req.body?.description, 2000);
  const duration = Number(req.body?.duration_minutes);
  const passMark = Number(req.body?.pass_mark ?? 40);
  const published = Boolean(req.body?.published);
  const startsAt = req.body?.starts_at ? new Date(req.body.starts_at) : null;
  const endsAt = req.body?.ends_at ? new Date(req.body.ends_at) : null;
  if (!title) return res.status(400).json({ message: 'Exam title is required.' });
  if (published) return res.status(400).json({ message: 'Create the exam as a draft first. Add questions, then publish it.' });
  if (!Number.isInteger(duration) || duration < 1 || duration > 600) return res.status(400).json({ message: 'Duration must be between 1 and 600 minutes.' });
  if (!Number.isInteger(passMark) || passMark < 0 || passMark > 100) return res.status(400).json({ message: 'Pass mark must be between 0 and 100.' });
  if (startsAt && Number.isNaN(startsAt.getTime())) return res.status(400).json({ message: 'Start time is invalid.' });
  if (endsAt && Number.isNaN(endsAt.getTime())) return res.status(400).json({ message: 'End time is invalid.' });
  if (startsAt && endsAt && endsAt <= startsAt) return res.status(400).json({ message: 'End time must be after the start time.' });
  const { rows: [exam] } = await query(
    `INSERT INTO exams(title,description,duration_minutes,pass_mark,starts_at,ends_at,published,created_by)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [title,description,duration,passMark,startsAt,endsAt,published,req.user.id]
  );
  res.status(201).json(exam);
}));

app.put('/api/exams/:id', requireAuth, allow('admin','instructor'), asyncRoute(async (req,res)=>{
  const { exam, allowed } = await ensureExamManager(req.params.id, req.user);
  if (!exam) return res.status(404).json({ message:'Exam not found.' });
  if (!allowed) return res.status(403).json({ message:'You can only edit exams created by you.' });
  const title = safeString(req.body?.title ?? exam.title,200);
  const description = safeString(req.body?.description ?? exam.description,2000);
  const duration = Number(req.body?.duration_minutes ?? exam.duration_minutes);
  const passMark = Number(req.body?.pass_mark ?? exam.pass_mark);
  if (!title || !Number.isInteger(duration) || duration < 1 || duration > 600 || !Number.isInteger(passMark) || passMark < 0 || passMark > 100) return res.status(400).json({ message:'Invalid exam settings.' });
  const { rows:[updated] } = await query(`UPDATE exams SET title=$1,description=$2,duration_minutes=$3,pass_mark=$4 WHERE id=$5 RETURNING *`,[title,description,duration,passMark,exam.id]);
  res.json(updated);
}));

app.post('/api/exams/:id/questions', requireAuth, allow('admin','instructor'), asyncRoute(async (req, res) => {
  const prompt = safeString(req.body?.prompt, 5000);
  const options = normalizeOptions(req.body?.options);
  const correctAnswer = Number(req.body?.correct_answer);
  const marks = Number(req.body?.marks ?? 1);
  if (!prompt) return res.status(400).json({ message: 'Question text is required.' });
  if (options.length < 2 || options.length > 6) return res.status(400).json({ message: 'Provide between 2 and 6 answer options.' });
  if (!Number.isInteger(correctAnswer) || correctAnswer < 0 || correctAnswer >= options.length) return res.status(400).json({ message: 'Correct answer selection is invalid.' });
  if (!Number.isInteger(marks) || marks < 1) return res.status(400).json({ message: 'Marks must be at least 1.' });
  const { exam, allowed } = await ensureExamManager(req.params.id, req.user);
  if (!exam) return res.status(404).json({ message: 'Exam not found.' });
  if (!allowed) return res.status(403).json({ message: 'You can only edit exams created by you.' });
  const { rows: [question] } = await query(
    `INSERT INTO questions(exam_id,prompt,options,correct_answer,marks,position)
     VALUES($1,$2,$3,$4,$5,COALESCE((SELECT MAX(position)+1 FROM questions WHERE exam_id=$1),0))
     RETURNING id,prompt,options,marks,position`,
    [exam.id,prompt,JSON.stringify(options),correctAnswer,marks]
  );
  res.status(201).json(question);
}));

app.post('/api/exams/:id/publish', requireAuth, allow('admin','instructor'), asyncRoute(async (req, res) => {
  const { exam, allowed } = await ensureExamManager(req.params.id, req.user);
  if (!exam) return res.status(404).json({ message: 'Exam not found.' });
  if (!allowed) return res.status(403).json({ message: 'You can only publish exams created by you.' });
  const published = Boolean(req.body?.published);
  if (exam.archived) return res.status(409).json({ message: 'Archived exams cannot be published.' });
  const { rows: [count] } = await query('SELECT count(*)::int AS n FROM questions WHERE exam_id=$1', [exam.id]);
  if (published && Number(count.n) < 1) return res.status(400).json({ message: 'Add at least one question before publishing.' });
  const { rows: [updated] } = await query('UPDATE exams SET published=$1 WHERE id=$2 RETURNING *',[published,exam.id]);
  res.json(updated);
}));

app.delete('/api/exams/:id', requireAuth, allow('admin','instructor'), asyncRoute(async (req,res)=>{
  const { exam, allowed } = await ensureExamManager(req.params.id, req.user);
  if (!exam) return res.status(404).json({ message:'Exam not found.' });
  if (!allowed) return res.status(403).json({ message:'You can only delete exams created by you.' });
  const { rows: [activeAttempt] } = await query(
    `SELECT count(*)::int AS count FROM attempts WHERE exam_id=$1 AND status='in_progress'`,
    [exam.id],
  );
  if (Number(activeAttempt.count) > 0) return res.status(409).json({ message: 'This exam has an active attempt and cannot be deleted yet.' });
  const { rowCount } = await query('DELETE FROM exams WHERE id=$1',[exam.id]);
  if (!rowCount) return res.status(404).json({ message:'Exam not found.' });
  res.json({ ok:true,message:'Exam and its questions, enrollments, attempts, answers, and violation records were deleted.' });
}));

app.post('/api/exams/:id/start', requireAuth, allow('student'), asyncRoute(async (req,res)=>{
  const { rows:[exam] } = await query(`SELECT * FROM exams WHERE id=$1 AND published=true AND archived=false`,[req.params.id]);
  if (!exam) return res.status(404).json({ message:'This exam is unavailable.' });
  if (exam.starts_at && new Date(exam.starts_at) > new Date()) return res.status(403).json({ message:`This exam starts at ${new Date(exam.starts_at).toLocaleString()}.` });
  if (exam.ends_at && new Date(exam.ends_at) < new Date()) return res.status(403).json({ message:'This exam has ended.' });
  const { rows:questions } = await query('SELECT id FROM questions WHERE exam_id=$1',[exam.id]);
  if (!questions.length) return res.status(400).json({ message:'This exam has no questions yet.' });
  const { rows:[enrollment] } = await query(`SELECT * FROM exam_enrollments WHERE exam_id=$1 AND student_id=$2 AND status='active'`,[exam.id,req.user.id]);
  if (!enrollment) return res.status(403).json({ message:'You are not registered for this exam.' });
  const { rows:existing } = await query(`SELECT * FROM attempts WHERE exam_id=$1 AND student_id=$2 ORDER BY started_at DESC LIMIT 1`,[exam.id,req.user.id]);
  let attempt = existing[0] || null;
  if (attempt?.status === 'in_progress') {
    if (attempt.expires_at && new Date(attempt.expires_at) <= new Date()) {
      await query(`UPDATE attempts SET status='expired',submitted_at=COALESCE(submitted_at,now()) WHERE id=$1`,[attempt.id]);
      attempt = null;
    } else {
      await query(`UPDATE attempts SET resume_count=resume_count+1,last_seen_at=now(),last_activity_at=now() WHERE id=$1`,[attempt.id]);
      attempt = await getAttemptForStudent(attempt.id,req.user.id);
      await query(`INSERT INTO violation_events(attempt_id,violation_type,severity,source,details) VALUES($1,'RESUME','info','system',$2::jsonb)`,[attempt.id,JSON.stringify({ reason:'re-opened active attempt',resume_count:attempt.resume_count })]);
      return res.json({...(await buildAttemptPayload(attempt)),resumed:true});
    }
  }
  if (attempt && attempt.status !== 'in_progress') return res.status(409).json({ message:'This exam attempt has already been submitted.' });
  const { rows:[created] } = await query(`INSERT INTO attempts(exam_id,student_id,expires_at,last_seen_at,last_activity_at) VALUES($1,$2,now()+($3*INTERVAL '1 minute'),now(),now()) RETURNING *`,[exam.id,req.user.id,exam.duration_minutes]);
  res.status(201).json({...(await buildAttemptPayload(await getAttemptForStudent(created.id,req.user.id))),resumed:false});
}));

app.get('/api/attempts/mine',requireAuth,allow('student'),asyncRoute(async(req,res)=>{
  await query(`UPDATE attempts SET status='expired',submitted_at=COALESCE(submitted_at,now()) WHERE student_id=$1 AND status='in_progress' AND expires_at IS NOT NULL AND expires_at<=now()`,[req.user.id]);
  const { rows } = await query(
    `SELECT a.id,a.exam_id,a.status,a.score,a.started_at,a.expires_at,a.submitted_at,a.resume_count,
            e.title,e.duration_minutes,e.pass_mark,ee.registration_code,u.student_id,u.batch_code,
            (SELECT count(*)::int FROM violation_events v WHERE v.attempt_id=a.id) AS violation_count
     FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.student_id
     LEFT JOIN exam_enrollments ee ON ee.exam_id=a.exam_id AND ee.student_id=a.student_id
     WHERE a.student_id=$1 ORDER BY a.started_at DESC`,[req.user.id]
  );
  res.json(rows);
}));

app.get('/api/attempts/:id',requireAuth,allow('student'),asyncRoute(async(req,res)=>{
  const attempt = await getAttemptForStudent(req.params.id,req.user.id);
  if (!attempt) return res.status(404).json({ message:'Attempt not found.' });
  if (attempt.status !== 'in_progress') return res.status(409).json({ message:'This attempt is no longer active.' });
  if (!attempt.expires_at || new Date(attempt.expires_at)<=new Date()) {
    await query(`UPDATE attempts SET status='expired',submitted_at=COALESCE(submitted_at,now()) WHERE id=$1`,[attempt.id]);
    return res.status(409).json({ message:'This attempt has expired.' });
  }
  res.json({...(await buildAttemptPayload(attempt)),resumed:true});
}));

app.post('/api/attempts/:id/heartbeat',requireAuth,allow('student'),writeLimiter,asyncRoute(async(req,res)=>{
  const {rowCount}=await query(`UPDATE attempts SET last_seen_at=now(),last_activity_at=now() WHERE id=$1 AND student_id=$2 AND status='in_progress'`,[req.params.id,req.user.id]);
  if(!rowCount) return res.status(409).json({message:'The exam session is no longer active.'});
  res.json({ok:true,server_time:new Date().toISOString()});
}));

app.put('/api/attempts/:id/answers',requireAuth,allow('student'),writeLimiter,asyncRoute(async(req,res)=>{
  const questionId=safeString(req.body?.question_id,80);
  const selected=Number(req.body?.selected_answer);
  if(!questionId || !Number.isInteger(selected) || selected<0) return res.status(400).json({message:'Invalid answer payload.'});
 const { rows: [answer] } = await query(
  `INSERT INTO answers (
     attempt_id,
     question_id,
     selected_answer
   )
   SELECT $1, $2, $3
   WHERE EXISTS (
     SELECT 1
     FROM attempts
     WHERE id = $1
       AND student_id = $4
       AND status = 'in_progress'
   )
   AND EXISTS (
     SELECT 1
     FROM questions q
     WHERE q.id = $2
       AND (
         SELECT exam_id
         FROM attempts
         WHERE id = $1
       ) = q.exam_id
       AND $3 < jsonb_array_length(q.options)
   )
   ON CONFLICT (attempt_id, question_id)
   DO UPDATE SET
     selected_answer = EXCLUDED.selected_answer,
     updated_at = now()
   RETURNING
     attempt_id,
     question_id,
     selected_answer,
     updated_at`,
  [req.params.id, questionId, selected, req.user.id]
);
  if(!answer) return res.status(409).json({message:'The answer could not be saved because the attempt is no longer active, expired, or the question/option is invalid.'});
  await query('UPDATE attempts SET last_seen_at=now(),last_activity_at=now() WHERE id=$1',[req.params.id]);
  res.json({ok:true,answer});
}));

app.post('/api/attempts/:id/violation',requireAuth,allow('student'),writeLimiter,asyncRoute(async(req,res)=>{
  const attempt=await getAttemptForStudent(req.params.id,req.user.id);
  if(!attempt) return res.status(404).json({message:'Attempt not found.'});
  if(attempt.status!=='in_progress') return res.status(409).json({message:'The attempt is no longer active.'});
  const type=safeString(req.body?.type||'UNKNOWN',100).toUpperCase().replace(/[^A-Z0-9_:-]/g,'_');
  const severityRaw=safeString(req.body?.severity||severityFor(type),20).toLowerCase();
  const severity=['info','warning','high','critical'].includes(severityRaw)?severityRaw:severityFor(type);
  const source=safeString(req.body?.source||'client',40);
  const details=safeDetails(req.body?.details);
  const {rows:[event]}=await query(`INSERT INTO violation_events(attempt_id,violation_type,severity,source,details) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING *`,[attempt.id,type,severity,source,JSON.stringify(details)]);
  await query(`UPDATE attempts SET last_seen_at=now(),last_activity_at=now(),violations=COALESCE(violations,'[]'::jsonb)||$1::jsonb WHERE id=$2`,[JSON.stringify([{type,severity,details,at:event.occurred_at}]),attempt.id]);
  res.status(201).json({ok:true,event});
}));

app.post('/api/attempts/:id/submit',requireAuth,allow('student'),writeLimiter,asyncRoute(async(req,res)=>{
  const attempt=await getAttemptForStudent(req.params.id,req.user.id);
  if(!attempt) return res.status(404).json({message:'Attempt not found.'});
  if(attempt.status!=='in_progress') return res.status(409).json({message:'Attempt is not active.'});
  const expired=attempt.expires_at&&new Date(attempt.expires_at)<=new Date();
  if (expired) {
    await query(`UPDATE attempts SET status='expired',submitted_at=COALESCE(submitted_at,now()),last_seen_at=now(),last_activity_at=now() WHERE id=$1`,[attempt.id]);
    return res.status(409).json({message:'The exam time has expired. Your attempt is closed.'});
  }
  const {rows:[score]}=await query(`SELECT COALESCE(SUM(CASE WHEN ans.selected_answer=q.correct_answer THEN q.marks ELSE 0 END),0)::numeric AS earned,COALESCE(SUM(q.marks),0)::numeric AS total FROM questions q LEFT JOIN answers ans ON ans.attempt_id=$1 AND ans.question_id=q.id WHERE q.exam_id=$2`,[attempt.id,attempt.exam_id]);
  const earned=Number(score.earned||0), total=Number(score.total||0), percentage=total?earned*100/total:0;
  await query(`UPDATE attempts SET status='submitted',submitted_at=COALESCE(submitted_at,now()),score=$1,last_seen_at=now(),last_activity_at=now() WHERE id=$2`,[percentage,attempt.id]);
  res.json({score:percentage,earned,total,expired:false});
}));

app.get('/api/reports',requireAuth,allow('admin','instructor'),asyncRoute(async(req,res)=>{
  const params = [];
  const ownerClause = req.user.role === 'instructor' ? `WHERE e.created_by=$1` : '';
  if (req.user.role === 'instructor') params.push(req.user.id);
  const {rows}=await query(`
    SELECT a.id,a.status,a.score,a.started_at,a.expires_at,a.submitted_at,a.resume_count,
           e.title,e.pass_mark,u.name AS student,u.email,u.student_id,u.batch_code,ee.registration_code,
           COALESCE(v.total_violations,0)::int AS violations,
           COALESCE(v.high_violations,0)::int AS high_violations,
           COALESCE(v.critical_violations,0)::int AS critical_violations,
           COALESCE(v.warning_violations,0)::int AS warning_violations,
           COALESCE(v.unreviewed_violations,0)::int AS unreviewed_violations,
           LEAST(100,ROUND(COALESCE(v.critical_violations,0)*24+COALESCE(v.high_violations,0)*11+COALESCE(v.warning_violations,0)*4+COALESCE(v.info_violations,0)+a.resume_count*3+COALESCE(v.burst_violations,0)*6))::int AS risk_score
    FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.student_id
    LEFT JOIN exam_enrollments ee ON ee.exam_id=a.exam_id AND ee.student_id=a.student_id
    LEFT JOIN LATERAL (
      SELECT count(*) total_violations,
             count(*) FILTER(WHERE severity='high') high_violations,
             count(*) FILTER(WHERE severity='critical') critical_violations,
             count(*) FILTER(WHERE severity='warning') warning_violations,
             count(*) FILTER(WHERE severity='info') info_violations,
             count(*) FILTER(WHERE reviewed=false) unreviewed_violations,
             count(*) FILTER(WHERE occurred_at >= now()-interval '60 seconds' AND severity IN ('high','critical')) burst_violations
      FROM violation_events WHERE attempt_id=a.id
    ) v ON true
    ${ownerClause}
    ORDER BY a.started_at DESC`,params);
  res.json(rows.map((row)=>({...row,risk_band:riskBand(Number(row.risk_score||0))})));
}));

app.get('/api/reports/attempts/:id',requireAuth,allow('admin','instructor'),asyncRoute(async(req,res)=>{
  const params = [req.params.id];
  const ownerClause = req.user.role === 'instructor' ? ' AND e.created_by=$2' : '';
  if (req.user.role === 'instructor') params.push(req.user.id);
  const {rows:[attempt]}=await query(`SELECT a.id,a.status,a.score,a.started_at,a.expires_at,a.submitted_at,a.resume_count,e.id exam_id,e.created_by,e.title,e.pass_mark,u.name student,u.email,u.student_id,u.batch_code,ee.registration_code FROM attempts a JOIN exams e ON e.id=a.exam_id JOIN users u ON u.id=a.student_id LEFT JOIN exam_enrollments ee ON ee.exam_id=a.exam_id AND ee.student_id=a.student_id WHERE a.id=$1${ownerClause}` ,params);
  if(!attempt) return res.status(404).json({message:'Attempt not found.'});
  const {rows:violations}=await query(`SELECT id,violation_type,severity,source,details,occurred_at,reviewed,reviewer_note,reviewed_at FROM violation_events WHERE attempt_id=$1 ORDER BY occurred_at DESC`,[req.params.id]);
  const counts=violations.reduce((acc,e)=>{acc[e.severity]=(acc[e.severity]||0)+1;return acc;},{info:0,warning:0,high:0,critical:0});
  const burst=violations.filter(e=>['high','critical'].includes(e.severity)&&new Date(e.occurred_at)>=Date.now()-60000).length;
  const score=riskFromCounts({...counts,resumes:Number(attempt.resume_count||0),burst});
  const factors=[];
  if(counts.critical) factors.push(`${counts.critical} critical integrity event${counts.critical>1?'s':''}`);
  if(counts.high) factors.push(`${counts.high} high-severity event${counts.high>1?'s':''}`);
  if(counts.warning) factors.push(`${counts.warning} warning event${counts.warning>1?'s':''}`);
  if(Number(attempt.resume_count||0)) factors.push(`${attempt.resume_count} resume/recovery event${attempt.resume_count>1?'s':''}`);
  if(burst) factors.push(`${burst} recent high/critical event${burst>1?'s':''} in the last minute`);
  res.json({attempt,violations,risk:{score,band:riskBand(score),factors:factors.length?factors:['No material integrity signals recorded.']}});
}));

app.put('/api/reports/violations/:id',requireAuth,allow('admin','instructor'),asyncRoute(async(req,res)=>{
  const reviewed=Boolean(req.body?.reviewed);
  const note=safeString(req.body?.reviewer_note||'',2000)||null;
  let params = [reviewed,note,req.params.id];
  let ownerClause = '';
  if (req.user.role === 'instructor') { params.push(req.user.id); ownerClause = ' AND e.created_by=$4'; }
  const {rows:[event]}=await query(`UPDATE violation_events v SET reviewed=$1,reviewer_note=$2,reviewed_at=CASE WHEN $1 THEN now() ELSE NULL END FROM attempts a JOIN exams e ON e.id=a.exam_id WHERE v.id=$3 AND v.attempt_id=a.id${ownerClause} RETURNING v.*`,params);
  if(!event) return res.status(404).json({message:'Violation event not found.'});
  res.json(event);
}));

app.get('/api/admin/exam-series',requireAuth,allow('admin'),asyncRoute(async(_req,res)=>{
  const {rows}=await query(`SELECT s.id,s.exam_id,s.batch_name,s.prefix,s.next_number,s.padding,s.active,s.created_at,e.title AS exam_title FROM exam_series s LEFT JOIN exams e ON e.id=s.exam_id ORDER BY s.created_at DESC`);
  res.json(rows);
}));

app.post('/api/admin/exam-series',requireAuth,allow('admin'),asyncRoute(async(req,res)=>{
  const examId=safeString(req.body?.exam_id||'',80)||null;
  const batch=safeString(req.body?.batch_name,100);
  const prefix=safeString(req.body?.prefix,40);
  const nextNumber=Number(req.body?.next_number??1);
  const padding=Number(req.body?.padding??3);
  if(!batch||!prefix||!Number.isInteger(nextNumber)||nextNumber<1||!Number.isInteger(padding)||padding<1||padding>8) return res.status(400).json({message:'Batch, prefix, starting number and padding are required.'});
  if(examId){const {rowCount}=await query('SELECT 1 FROM exams WHERE id=$1',[examId]); if(!rowCount) return res.status(404).json({message:'Exam not found.'});}
  const {rows:[series]}=await query(`INSERT INTO exam_series(exam_id,batch_name,prefix,next_number,padding,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,[examId,batch,prefix,nextNumber,padding,req.user.id]);
  res.status(201).json(series);
}));

app.delete('/api/admin/exam-series/:id',requireAuth,allow('admin'),asyncRoute(async(req,res)=>{
  const {rowCount}=await query('DELETE FROM exam_series WHERE id=$1',[req.params.id]);
  if(!rowCount) return res.status(404).json({message:'ID series not found.'});
  res.json({ok:true});
}));

app.post('/api/admin/enrollments',requireAuth,allow('admin'),asyncRoute(async(req,res)=>{
  const studentId=safeString(req.body?.student_id,80);
  const examId=safeString(req.body?.exam_id,80);
  if(!studentId||!examId) return res.status(400).json({message:'Student and exam are required.'});
  const {rows:[student]}=await query('SELECT id,student_id,name,batch_code FROM users WHERE id=$1 AND role=\'student\'',[studentId]);
  if(!student) return res.status(404).json({message:'Student not found.'});
  const {rows:[exam]}=await query('SELECT id,title,archived FROM exams WHERE id=$1',[examId]);
  if(!exam||exam.archived) return res.status(404).json({message:'Exam not found.'});
  const code=`REG-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
  const {rows:[enrollment]}=await query(`INSERT INTO exam_enrollments(exam_id,student_id,registration_code) VALUES($1,$2,$3) ON CONFLICT(exam_id,student_id) DO UPDATE SET status='active' RETURNING *`,[examId,student.id,code]);
  res.status(201).json(enrollment);
}));

app.get('/api/users',requireAuth,allow('admin'),asyncRoute(async(_req,res)=>{
  const {rows}=await query(`
    SELECT u.id,u.student_id,u.name,u.email,u.role,u.batch_code,u.created_at,
           COALESCE((SELECT jsonb_agg(jsonb_build_object('exam_id',e.id,'title',e.title,'registration_code',ee.registration_code,'status',ee.status) ORDER BY ee.enrolled_at DESC)
                     FROM exam_enrollments ee JOIN exams e ON e.id=ee.exam_id WHERE ee.student_id=u.id),'[]'::jsonb) AS enrollments
    FROM users u ORDER BY CASE WHEN u.role='student' THEN 0 ELSE 1 END,u.created_at DESC`);
  res.json(rows);
}));

app.post('/api/users',requireAuth,allow('admin'),asyncRoute(async(req,res)=>{
  const name=safeString(req.body?.name,160), email=safeString(req.body?.email,200).toLowerCase(), password=String(req.body?.password||''), role=safeString(req.body?.role||'student',20);
  const examId=safeString(req.body?.exam_id||'',80)||null, seriesId=safeString(req.body?.series_id||'',80)||null, studentId=safeString(req.body?.student_id||'',60), batchCode=safeString(req.body?.batch_code||'',100);
  if(!name||!isValidEmail(email)||!isValidPassword(password)) return res.status(400).json({message:'Name, valid email and a password of at least 8 characters are required.'});
  if(!['student','instructor','admin'].includes(role)) return res.status(400).json({message:'Invalid account role.'});
  if(role==='student') {
    const result=await createStudentAccount({name,email,password,examId,seriesId,studentIdOverride:studentId,batchCode});
    return res.status(201).json({...result.user,enrollment:result.enrollment});
  }
  const hash=await bcrypt.hash(password,12);
  const {rows:[user]}=await query(`INSERT INTO users(name,email,password_hash,role,batch_code) VALUES($1,$2,$3,$4,$5) RETURNING id,name,email,role,student_id,batch_code,created_at`,[name,email,hash,role,null]);
  res.status(201).json(user);
}));

app.put('/api/users/:id',requireAuth,allow('admin'),asyncRoute(async(req,res)=>{
  const {rows:[updated]}=await query(`UPDATE users SET name=$1,student_id=$2,batch_code=$3 WHERE id=$4 AND role='student' RETURNING id,name,email,role,student_id,batch_code,created_at`,[safeString(req.body?.name,160),safeString(req.body?.student_id,60)||null,safeString(req.body?.batch_code,100)||null,req.params.id]);
  if(!updated) return res.status(404).json({message:'Student not found.'});
  res.json(updated);
}));

app.use((_req,res) => { res.status(404).json({ message: 'API endpoint not found.' }); });

app.use((err,_req,res,_next)=>{
  console.error(err);
  if(err?.statusCode) return res.status(err.statusCode).json({message:err.message});
  if(err?.type === 'entity.parse.failed') return res.status(400).json({message:'Request body contains invalid JSON.'});
  if(err?.code==='23505') return res.status(409).json({message:'That email, Student ID, or registration is already in use.'});
  if(err?.code==='22P02') return res.status(400).json({message:'One or more request values have an invalid format.'});
  res.status(500).json({message:'Unexpected server error. Please try again later.'});
});

app.listen(PORT,()=>console.log(`SecureExam API listening on port ${PORT}`));
