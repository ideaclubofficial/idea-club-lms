"use strict";

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("th-TH")
    .replace(/[^0-9a-zก-๙]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchTokens(values) {
  const tokens = new Set();
  (values || []).forEach((value) => {
    const normalized = normalizeSearchText(value);
    if (!normalized) return;
    normalized.split(" ").concat([normalized]).forEach((part) => {
      if (!part) return;
      if (part.length <= 3) tokens.add(part);
      for (let size = 2; size <= 3; size++) {
        for (let i = 0; i <= part.length - size; i++) tokens.add(part.slice(i, i + size));
      }
    });
  });
  return Array.from(tokens).slice(0, 1500);
}

function getEnrollmentSearchText(enrollment) {
  if (!enrollment || enrollment.deleted === true) return "";
  return normalizeSearchText([
    enrollment.courseName,
    enrollment.course,
    enrollment.courseStatus,
    enrollment.paymentStatus,
    enrollment.location,
    enrollment.grade,
  ].join(" "));
}

function buildStudentSearchIndex(studentId, student, enrollmentTexts) {
  const safeStudent = student || {};
  const safeEnrollmentTexts = enrollmentTexts && typeof enrollmentTexts === "object" ? enrollmentTexts : {};
  const values = [
    safeStudent.name,
    safeStudent.nickname,
    safeStudent.parentName,
    safeStudent.phone,
    safeStudent.lineId,
    safeStudent.school,
    safeStudent.preferredLocation,
    safeStudent.memberId,
    safeStudent.studentId,
    safeStudent.grade,
    safeStudent.course,
    safeStudent.courseStatus,
    safeStudent.paymentStatus,
  ].concat(Object.values(safeEnrollmentTexts));
  const expandedValues = values.reduce((result, value) => {
    const normalized = normalizeSearchText(value);
    if (!normalized) return result;
    result.push(normalized);
    const compact = normalized.replace(/\s/g, "");
    if (compact !== normalized) result.push(compact);
    return result;
  }, []);
  return {
    studentId: String(studentId || ""),
    authUid: String(safeStudent.authUid || ""),
    memberId: String(safeStudent.memberId || safeStudent.studentId || ""),
    grade: String(safeStudent.grade || ""),
    location: String(safeStudent.preferredLocation || ""),
    learningStatus: String(safeStudent.learningStatus || safeStudent.status || "เรียนอยู่"),
    deleted: safeStudent.deleted === true,
    normalizedText: normalizeSearchText(expandedValues.join(" ")),
    searchTokens: buildSearchTokens(expandedValues),
    enrollmentTexts: safeEnrollmentTexts,
  };
}

function getSearchToken(query) {
  const normalized = normalizeSearchText(query).replace(/\s/g, "");
  if (normalized.length < 2) return "";
  return normalized.slice(0, Math.min(3, normalized.length));
}

module.exports = {
  buildSearchTokens,
  buildStudentSearchIndex,
  getEnrollmentSearchText,
  getSearchToken,
  normalizeSearchText,
};
