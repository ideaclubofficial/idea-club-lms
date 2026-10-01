function isCurrentApprovedEnrollment(enrollment) {
  if (!enrollment || enrollment.deleted === true) return false;
  return enrollment.courseStatus === "อนุมัติแล้ว" && enrollment.enrollmentStatus !== "completed" && enrollment.enrollmentStatus !== "cancelled";
}

function buildEnrollmentCompletionPatch(enrollment, completedAtMs, completedAtText, completedAtMonth) {
  const previousStatus = String(enrollment && enrollment.courseStatus || "");
  const everApproved = enrollment && enrollment.everApproved === true || previousStatus === "อนุมัติแล้ว";
  return {
    courseStatusBeforeCompletion: previousStatus,
    courseStatus: "จบคอร์ส",
    enrollmentStatus: "completed",
    everApproved,
    historicalMediaStatus: everApproved ? "allowed" : "not_eligible",
    completedAtText,
    completedAtMonth,
    completedAtMs,
    completedBy: "system:course_end_scheduler",
  };
}

function hasCourseCompletionHistory(history, courseId) {
  return (Array.isArray(history) ? history : []).some((item) => {
    return String(item && (item.courseId || item.id) || "") === String(courseId || "");
  });
}

function isCourseEndDue(course, nowMs) {
  if (!course || course.courseEndEnabled !== true || course.courseEndStatus === "completed") return false;
  const value = course.courseEndAt;
  const endMs = value && typeof value.toMillis === "function"
    ? value.toMillis()
    : value && Number.isFinite(value.seconds)
      ? value.seconds * 1000
      : Date.parse(value || "");
  return Number.isFinite(endMs) && endMs > 0 && endMs <= nowMs;
}

module.exports = {
  buildEnrollmentCompletionPatch,
  hasCourseCompletionHistory,
  isCourseEndDue,
  isCurrentApprovedEnrollment,
};
