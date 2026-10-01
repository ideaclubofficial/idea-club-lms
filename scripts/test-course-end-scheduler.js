const assert = require('node:assert/strict');
const test = require('node:test');
const {
  buildEnrollmentCompletionPatch,
  hasCourseCompletionHistory,
  isCourseEndDue,
  isCurrentApprovedEnrollment,
} = require('../functions/course-end-helpers');

test('scheduled course becomes due only when enabled and its time has passed', () => {
  const now = Date.parse('2026-10-01T10:00:00+07:00');
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'scheduled', courseEndAt: { toMillis: () => now - 1 } }, now), true);
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'scheduled', courseEndAt: { toMillis: () => now + 1 } }, now), false);
  assert.equal(isCourseEndDue({ courseEndEnabled: false, courseEndAt: { toMillis: () => now - 1 } }, now), false);
  assert.equal(isCourseEndDue({ courseEndEnabled: true, courseEndStatus: 'completed', courseEndAt: { toMillis: () => now - 1 } }, now), false);
});

test('only active approved enrollment is a completion target', () => {
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'active' }), true);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'รออนุมัติคอร์ส', enrollmentStatus: 'active' }), false);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', enrollmentStatus: 'completed' }), false);
  assert.equal(isCurrentApprovedEnrollment({ courseStatus: 'อนุมัติแล้ว', deleted: true }), false);
});

test('completion preserves historical media access for an approved enrollment', () => {
  const patch = buildEnrollmentCompletionPatch(
    { courseStatus: 'อนุมัติแล้ว', everApproved: false },
    12345,
    '1/10/2569 10:00:00',
    'ตุลาคม 2569'
  );
  assert.equal(patch.courseStatus, 'จบคอร์ส');
  assert.equal(patch.enrollmentStatus, 'completed');
  assert.equal(patch.everApproved, true);
  assert.equal(patch.historicalMediaStatus, 'allowed');
  assert.equal(patch.completedAtMs, 12345);
});

test('legacy completion history check prevents duplicate course records', () => {
  const history = [{ courseId: 'course-a' }];
  assert.equal(hasCourseCompletionHistory(history, 'course-a'), true);
  assert.equal(hasCourseCompletionHistory(history, 'course-b'), false);
});
