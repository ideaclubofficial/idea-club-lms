#!/usr/bin/env node
"use strict";

const admin = require("firebase-admin");
const {
  buildStudentSearchIndex,
  getEnrollmentSearchText,
} = require("../functions/student-search-index");

const args = process.argv.slice(2);
const writeMode = args.includes("--write");
const activate = args.includes("--activate");
const activateOnly = args.includes("--activate-only");
const valueArg = (name, fallback) => {
  const item = args.find((arg) => arg.startsWith(`--${name}=`));
  return item ? item.slice(name.length + 3) : fallback;
};
const maxWrites = Math.min(15000, Math.max(1, Number(valueArg("max-writes", "15000")) || 15000));
const resumeAfter = String(valueArg("resume-after", ""));
const batchSize = Math.min(400, Math.max(1, Number(valueArg("batch-size", "400")) || 400));

admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function loadEnrollmentTexts(studentIds) {
  const byStudent = new Map(studentIds.map((id) => [id, {}]));
  for (let offset = 0; offset < studentIds.length; offset += 30) {
    const ids = studentIds.slice(offset, offset + 30);
    const snapshot = await db.collection("courseEnrollments").where("studentId", "in", ids).get();
    snapshot.docs.forEach((doc) => {
      const data = doc.data() || {};
      const studentId = String(data.studentId || "");
      if (!byStudent.has(studentId)) byStudent.set(studentId, {});
      const text = getEnrollmentSearchText(data);
      if (text) byStudent.get(studentId)[doc.id] = text;
    });
  }
  return byStudent;
}

function normalizeMonthKey(value) {
  const text = String(value || "").trim();
  if (/^\d{4}-\d{2}$/.test(text)) return text;
  const thaiMonths = ["มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน", "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม"];
  const match = text.match(new RegExp(`(${thaiMonths.join("|")})\\s+(\\d{4})`));
  if (!match) return "";
  const year = Number(match[2]) > 2400 ? Number(match[2]) - 543 : Number(match[2]);
  return `${year}-${String(thaiMonths.indexOf(match[1]) + 1).padStart(2, "0")}`;
}

async function backfillSupportingFields(remainingWrites) {
  const [announcements, scoreReports] = await Promise.all([
    db.collection("announcements").get(),
    db.collection("scoreReports").get(),
  ]);
  const writes = [];
  announcements.docs.forEach((doc) => {
    const data = doc.data() || {};
    const targetKey = `${data.grade || "ทั้งหมด"}|${data.location || "ทั้งหมด"}`;
    if (data.targetKey !== targetKey) writes.push({ ref: doc.ref, data: { targetKey } });
  });
  scoreReports.docs.forEach((doc) => {
    const data = doc.data() || {};
    const monthKey = normalizeMonthKey(data.monthKey || data.month);
    if (monthKey && data.monthKey !== monthKey) writes.push({ ref: doc.ref, data: { monthKey } });
  });
  if (writes.length > remainingWrites) return { complete: false, count: writes.length };
  if (writeMode) {
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = db.batch();
      writes.slice(offset, offset + 400).forEach((item) => batch.set(item.ref, item.data, { merge: true }));
      await batch.commit();
    }
  }
  return { complete: true, count: writes.length };
}

async function main() {
  if (activateOnly) {
    const settingsRef = db.collection("settings").doc("main");
    const settingsSnapshot = await settingsRef.get();
    const settings = settingsSnapshot.exists ? (settingsSnapshot.data() || {}) : {};
    if (Number(settings.studentSearchIndexVersion || 0) < 1) {
      throw new Error("Cannot activate: studentSearchIndexVersion marker is missing. Complete the backfill first.");
    }
    if (!writeMode) {
      process.stdout.write(JSON.stringify({ ok: true, writeMode, activateOnly, wouldActivate: true }) + "\n");
      return;
    }
    await settingsRef.set({
      quotaOptimizedLoadingVersion: 1,
      quotaOptimizedLoadingActivatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    process.stdout.write(JSON.stringify({ ok: true, writeMode, activateOnly, activated: true }) + "\n");
    return;
  }
  let cursor = resumeAfter;
  let processed = 0;
  let completed = false;
  while (processed < maxWrites) {
    let query = db.collection("students")
      .orderBy(admin.firestore.FieldPath.documentId())
      .limit(Math.min(batchSize, maxWrites - processed));
    if (cursor) query = query.startAfter(cursor);
    const snapshot = await query.get();
    if (snapshot.empty) { completed = true; break; }
    const studentIds = snapshot.docs.map((doc) => doc.id);
    const enrollmentTexts = await loadEnrollmentTexts(studentIds);
    if (writeMode) {
      const batch = db.batch();
      snapshot.docs.forEach((doc) => {
        batch.set(db.collection("studentSearchIndex").doc(doc.id), {
          ...buildStudentSearchIndex(doc.id, doc.data() || {}, enrollmentTexts.get(doc.id) || {}),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      });
      await batch.commit();
    }
    processed += snapshot.size;
    cursor = snapshot.docs[snapshot.docs.length - 1].id;
    process.stdout.write(`${writeMode ? "wrote" : "would-write"}=${processed} resume-after=${cursor}\n`);
    if (snapshot.size < Math.min(batchSize, maxWrites - processed + snapshot.size)) { completed = true; break; }
  }
  let supporting = { complete: false, count: 0 };
  if (completed) supporting = await backfillSupportingFields(Math.max(0, maxWrites - processed));
  completed = completed && supporting.complete;
  processed += supporting.complete ? supporting.count : 0;
  if (writeMode && completed) {
    const marker = {
      studentSearchIndexVersion: 1,
      studentSearchIndexBackfilledAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (activate) marker.quotaOptimizedLoadingVersion = 1;
    await db.collection("settings").doc("main").set(marker, { merge: true });
  }
  process.stdout.write(JSON.stringify({ ok: true, writeMode, activate, processed, completed, supporting, resumeAfter: cursor }) + "\n");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
