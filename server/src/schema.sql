CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id TEXT UNIQUE,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('admin','instructor','student')),
  avatar_url TEXT,
  batch_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS batch_code TEXT;

CREATE TABLE IF NOT EXISTS exams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration_minutes INT NOT NULL CHECK (duration_minutes BETWEEN 1 AND 600),
  pass_mark INT NOT NULL DEFAULT 40 CHECK (pass_mark BETWEEN 0 AND 100),
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  published BOOLEAN NOT NULL DEFAULT false,
  archived BOOLEAN NOT NULL DEFAULT false,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE exams ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  prompt TEXT NOT NULL,
  options JSONB NOT NULL,
  correct_answer INT NOT NULL,
  marks INT NOT NULL DEFAULT 1 CHECK (marks > 0),
  position INT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ,
  last_seen_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ,
  resume_count INT NOT NULL DEFAULT 0,
  score NUMERIC,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress','submitted','expired','terminated')),
  violations JSONB NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE(exam_id, student_id)
);

ALTER TABLE attempts ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS last_activity_at TIMESTAMPTZ;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS resume_count INT NOT NULL DEFAULT 0;
ALTER TABLE attempts ADD COLUMN IF NOT EXISTS violations JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
BEGIN
  ALTER TABLE attempts DROP CONSTRAINT IF EXISTS attempts_status_check;
  ALTER TABLE attempts ADD CONSTRAINT attempts_status_check CHECK (status IN ('in_progress','submitted','expired','terminated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

UPDATE attempts a
SET expires_at = a.started_at + (e.duration_minutes * INTERVAL '1 minute')
FROM exams e
WHERE a.exam_id = e.id AND a.expires_at IS NULL;

UPDATE attempts
SET last_seen_at = COALESCE(last_seen_at, started_at),
    last_activity_at = COALESCE(last_activity_at, started_at)
WHERE last_seen_at IS NULL OR last_activity_at IS NULL;

CREATE TABLE IF NOT EXISTS answers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  question_id UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  selected_answer INT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(attempt_id, question_id)
);

ALTER TABLE answers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS violation_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id UUID NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  violation_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning' CHECK (severity IN ('info','warning','high','critical')),
  source TEXT NOT NULL DEFAULT 'client',
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed BOOLEAN NOT NULL DEFAULT false,
  reviewer_note TEXT,
  reviewed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS exam_series (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID REFERENCES exams(id) ON DELETE CASCADE,
  batch_name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  next_number INT NOT NULL DEFAULT 1 CHECK (next_number >= 1),
  padding INT NOT NULL DEFAULT 3 CHECK (padding BETWEEN 1 AND 8),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS exam_enrollments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  exam_id UUID NOT NULL REFERENCES exams(id) ON DELETE CASCADE,
  student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration_code TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn','completed')),
  enrolled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(exam_id, student_id)
);

CREATE INDEX IF NOT EXISTS idx_exams_published ON exams(published, archived, starts_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_questions_exam_position ON questions(exam_id, position, id);
CREATE INDEX IF NOT EXISTS idx_attempts_student_status ON attempts(student_id, status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_attempts_exam_student ON attempts(exam_id, student_id);
CREATE INDEX IF NOT EXISTS idx_attempts_expires ON attempts(status, expires_at);
CREATE INDEX IF NOT EXISTS idx_answers_attempt ON answers(attempt_id);
CREATE INDEX IF NOT EXISTS idx_violations_attempt_time ON violation_events(attempt_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_violations_unreviewed ON violation_events(reviewed, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_series_exam_active ON exam_series(exam_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_student ON exam_enrollments(student_id, enrolled_at DESC);
CREATE INDEX IF NOT EXISTS idx_enrollments_exam ON exam_enrollments(exam_id, enrolled_at DESC);
