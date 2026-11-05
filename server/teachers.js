/**
 * The teachers who can use this server. Each has their own console at
 * /teacher/<n>, their own password, and their own contexts, classes and
 * activities. They can run activities at the same time.
 *
 *   TEACHER_1_CODE, TEACHER_2_CODE, TEACHER_3_CODE   the passwords
 *   TEACHER_1_NAME, ...                              optional display names
 *   TEACHER_COUNT                                    how many slots (default 3)
 *
 * The older single TEACHER_CODE still works: it becomes Teacher 1's password.
 * A teacher with no password set is shown as "not set up" and cannot sign in.
 */

/** Teacher 1 is the admin: they set up contexts and classes for everyone. */
export const ADMIN_ID = '1';
export const isAdmin = (teacher) => teacher?.id === ADMIN_ID;

const COUNT = Math.max(1, Math.min(9, Number(process.env.TEACHER_COUNT) || 3));

export function loadTeachers(env = process.env) {
  const teachers = [];
  for (let i = 1; i <= COUNT; i++) {
    let code = env[`TEACHER_${i}_CODE`] || '';
    if (i === 1 && !code) code = env.TEACHER_CODE || env.TEACHER_PASSCODE || '';
    teachers.push({
      id: String(i),
      name: String(env[`TEACHER_${i}_NAME`] || `Teacher ${i}`).slice(0, 40),
      code: String(code),
    });
  }
  // Nothing configured at all: a local default so the app still opens.
  if (teachers.every((t) => !t.code)) teachers[0].code = 'teacher';
  return teachers;
}

export const TEACHERS = loadTeachers();

/** The teacher whose slot and password both match, or null. */
export function findTeacher(id, code) {
  const teacher = TEACHERS.find((t) => t.id === String(id || ''));
  if (!teacher || !teacher.code || String(code || '') !== teacher.code) return null;
  return teacher;
}

/** Who owns a stored record. Records from before teachers existed belong to Teacher 1. */
export const ownerOf = (record) => String(record?.teacherId || '1');

/** For the public picker page: names and whether each is set up, never codes. */
export const publicTeachers = () => TEACHERS.map((t) => ({ id: t.id, name: t.name, ready: Boolean(t.code) }));

export function teacherWarnings() {
  const out = [];
  const set = TEACHERS.filter((t) => t.code);
  if (set.length === 1 && set[0].code === 'teacher') out.push('No teacher passwords are set; Teacher 1\'s password is "teacher". Set TEACHER_1_CODE (and 2, 3) before class.');
  const codes = set.map((t) => t.code);
  if (new Set(codes).size !== codes.length) out.push('Two teachers have the same password. Each teacher needs their own.');
  for (const t of TEACHERS) if (!t.code) out.push(`${t.name} has no password (TEACHER_${t.id}_CODE), so that console is switched off.`);
  return out;
}
