-- DEVELOPMENT ONLY. Never run this against the production database.
-- Deletes exam-related data while preserving user accounts.
BEGIN;
TRUNCATE TABLE violation_events, answers, attempts, exam_enrollments, questions, exam_series, exams RESTART IDENTITY CASCADE;
COMMIT;
