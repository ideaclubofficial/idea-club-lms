const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { google } = require("googleapis");
const vision = require("@google-cloud/vision");
const path = require("path");
const os = require("os");
const fs = require("fs");

setGlobalOptions({
  region: "asia-southeast1",
  memory: "512MiB",
  timeoutSeconds: 120,
});

admin.initializeApp();

const db = admin.firestore();
const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID || "PUT_GOOGLE_DRIVE_FOLDER_ID_HERE";
// Place the service account at functions/service-account-drive.json locally only.
// Never commit this file to GitHub. Share the Google Drive folder with this service account as Editor.
const SERVICE_ACCOUNT_PATH = path.join(__dirname, "service-account-drive.json");
const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;

function assertDriveFolderConfigured() {
  if (!DRIVE_FOLDER_ID || DRIVE_FOLDER_ID === "PUT_GOOGLE_DRIVE_FOLDER_ID_HERE") {
    throw new HttpsError(
      "failed-precondition",
      "ยังไม่ได้ตั้งค่า DRIVE_FOLDER_ID สำหรับ Google Drive folder"
    );
  }
}

function base64ToBuffer(base64) {
  const cleanBase64 = String(base64 || "").replace(/^data:[^;]+;base64,/, "");
  return Buffer.from(cleanBase64, "base64");
}

function estimateBase64Size(base64) {
  const cleanBase64 = String(base64 || "").replace(/^data:[^;]+;base64,/, "");
  const padding = cleanBase64.endsWith("==") ? 2 : cleanBase64.endsWith("=") ? 1 : 0;
  return Math.floor((cleanBase64.length * 3) / 4) - padding;
}

function getFileExtension(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/heic": ".heic",
    "image/heif": ".heif",
  };
  return map[String(mimeType || "").toLowerCase()] || ".jpg";
}

function getDriveClient() {
  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new HttpsError(
      "failed-precondition",
      "Missing functions/service-account-drive.json. Do not commit this file; share the Drive folder with the service account as Editor."
    );
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: SERVICE_ACCOUNT_PATH,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function parseThaiSlipText(text) {
  const rawText = String(text || "");
  const lines = rawText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const normalized = rawText.replace(/,/g, "");
  const amountMatch =
    normalized.match(/(?:จำนวน|ยอด|amount|total)[^\d]{0,20}(\d+(?:\.\d{1,2})?)/i) ||
    normalized.match(/(\d+\.\d{2})\s*(?:บาท|THB|฿)?/i);
  const referenceMatch =
    rawText.match(/(?:เลขที่รายการ|เลขอ้างอิง|reference|ref|transaction)[^\w\d]{0,20}([A-Z0-9-]{8,})/i) ||
    rawText.match(/\b([0-9A-Z]{12,})\b/);
  const timeMatch = rawText.match(/\b([01]?\d|2[0-3])[:.][0-5]\d(?::[0-5]\d)?\b/);
  const dateMatch =
    rawText.match(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/) ||
    rawText.match(/\b\d{1,2}\s*(?:ม\.ค\.|ก\.พ\.|มี\.ค\.|เม\.ย\.|พ\.ค\.|มิ\.ย\.|ก\.ค\.|ส\.ค\.|ก\.ย\.|ต\.ค\.|พ\.ย\.|ธ\.ค\.)\s*\d{2,4}\b/);

  return {
    amount: amountMatch ? Number(amountMatch[1]) : null,
    referenceNo: referenceMatch ? referenceMatch[1] : "",
    transferTime: timeMatch ? timeMatch[0].replace(".", ":") : "",
    transferDateText: dateMatch ? dateMatch[0] : "",
    payerName: extractPossiblePayerName(rawText, lines),
    receiverName: extractPossibleReceiverName(rawText, lines),
    rawText,
  };
}

function extractPossiblePayerName(text, lines) {
  const sourceLines = lines || String(text || "").split(/\r?\n/);
  const keywordLine = sourceLines.find((line) => /(จาก|ผู้โอน|sender|from)/i.test(line));
  if (keywordLine) return keywordLine.replace(/^(จาก|ผู้โอน|sender|from)[:\s-]*/i, "").trim();
  return "";
}

function extractPossibleReceiverName(text, lines) {
  const sourceLines = lines || String(text || "").split(/\r?\n/);
  const keywordLine = sourceLines.find((line) => /(ไปยัง|ผู้รับ|receiver|to)/i.test(line));
  if (keywordLine) return keywordLine.replace(/^(ไปยัง|ผู้รับ|receiver|to)[:\s-]*/i, "").trim();
  return "";
}

async function checkDuplicateReference(referenceNo, currentPaymentId) {
  if (!referenceNo) return false;
  const snapshot = await db.collection("payments").where("ocrReferenceNo", "==", referenceNo).limit(5).get();
  return snapshot.docs.some((doc) => doc.id !== currentPaymentId);
}

function buildOcrCheckResult({ expectedAmount, ocrAmount, duplicateRef, referenceNo }) {
  const expected = Number(expectedAmount || 0);
  const actual = Number(ocrAmount || 0);
  const notes = [];

  if (duplicateRef) {
    notes.push("พบเลขอ้างอิงซ้ำในระบบ");
    if (expected > 0 && actual > 0 && Math.abs(expected - actual) > 0.01) {
      notes.push(`ยอด OCR ${actual.toLocaleString("th-TH")} บาท ไม่ตรงกับยอดที่ต้องชำระ ${expected.toLocaleString("th-TH")} บาท`);
    }
    notes.push("กรุณาตรวจสอบก่อนอนุมัติ");
    return {
      ocrCheckStatus: "duplicate_reference",
      ocrCheckNote: notes.join(" / "),
    };
  }
  if (!referenceNo) {
    return {
      ocrCheckStatus: "no_reference",
      ocrCheckNote: "OCR อ่านเลขอ้างอิงไม่ได้ / รอ Admin ตรวจสอบ",
    };
  }
  if (!actual) {
    return {
      ocrCheckStatus: "no_amount",
      ocrCheckNote: "OCR อ่านยอดเงินไม่ได้ / รอ Admin ตรวจสอบ",
    };
  }
  if (expected > 0 && Math.abs(expected - actual) > 0.01) {
    return {
      ocrCheckStatus: "amount_mismatch",
      ocrCheckNote: `ยอด OCR ${actual.toLocaleString("th-TH")} บาท ไม่ตรงกับยอดที่ต้องชำระ ${expected.toLocaleString("th-TH")} บาท`,
    };
  }
  if (!expected) {
    return {
      ocrCheckStatus: "need_manual_review",
      ocrCheckNote: "ไม่พบยอดที่ต้องชำระในระบบ / รอ Admin ตรวจสอบ",
    };
  }

  return {
    ocrCheckStatus: "passed",
    ocrCheckNote: "ยอดเงินตรง / เลขอ้างอิงไม่ซ้ำ / รอ Admin ตรวจสอบ",
  };
}

async function isBackOfficeUser(uid) {
  if (!uid) return false;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return false;
  const data = userDoc.data() || {};
  const acceptedRoles = ["super_admin", "admin", "manager", "finance", "FinanceAdmin", "Admin", "SuperAdmin"];
  return acceptedRoles.includes(data.role) || acceptedRoles.includes(data.appRole);
}

async function isAuthCleanupAdmin(uid) {
  if (!uid) return false;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return false;
  const data = userDoc.data() || {};
  const acceptedRoles = ["super_admin", "admin", "SuperAdmin", "Admin"];
  return acceptedRoles.includes(data.role) ||
    acceptedRoles.includes(data.appRole) ||
    (Array.isArray(data.permissions) && data.permissions.includes("admin.full"));
}

async function getUserProfile(uid) {
  if (!uid) return null;
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) return null;
  return userDoc.data() || null;
}

async function getStudentProfileForPayment(payment, uid) {
  const candidates = [
    payment.studentAuthUid,
    payment.authUid,
    uid,
  ].filter(Boolean);

  for (const authUid of candidates) {
    const snapshot = await db.collection("students").where("authUid", "==", authUid).limit(1).get();
    if (!snapshot.empty) return snapshot.docs[0].data() || null;
  }

  const memberId = payment.memberId || payment.studentId;
  if (memberId) {
    const byMember = await db.collection("students").where("memberId", "==", memberId).limit(1).get();
    if (!byMember.empty) return byMember.docs[0].data() || null;
    const byStudentId = await db.collection("students").where("id", "==", memberId).limit(1).get();
    if (!byStudentId.empty) return byStudentId.docs[0].data() || null;
  }

  return null;
}

async function writeActivityLog(data) {
  try {
    await db.collection("activityLogs").add({
      source: "cloud_function",
      functionName: data.functionName || "uploadPaymentSlipToDriveAndOcr",
      ...data,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("write activity log error:", error);
  }
}

function timestampToMillis(value) {
  if (!value) return 0;
  if (value.toMillis) return value.toMillis();
  if (value.toDate) return value.toDate().getTime();
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function normalizeCleanupDays(value) {
  const days = Number(value);
  if (!Number.isFinite(days) || days < 0) return 30;
  return Math.min(Math.floor(days), 365);
}

async function shouldSkipAuthCleanup(uid, requesterUid) {
  if (!uid || uid === requesterUid) return "ข้ามบัญชีผู้สั่งงานหรือ uid ว่าง";

  const userDoc = await db.collection("users").doc(uid).get();
  if (userDoc.exists) {
    const userData = userDoc.data() || {};
    const role = String(userData.role || "").toLowerCase();
    const appRole = String(userData.appRole || "");
    if (role !== "student" || ["SuperAdmin", "Admin", "Teacher", "Finance", "Manager"].includes(appRole)) {
      return "ข้ามเพราะ users/{uid} ไม่ใช่นักเรียน";
    }
  }

  const teacherSnapshot = await db.collection("teachers").where("authUid", "==", uid).limit(1).get();
  if (!teacherSnapshot.empty) return "ข้ามเพราะ uid ยังอยู่ใน teachers";

  return "";
}

function sanitizeDriveFolderName(name) {
  return String(name || "")
    .trim()
    .replace(/[\\/:*?"<>|#%\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .slice(0, 120) || "ไม่ระบุ";
}

async function findOrCreateDriveFolder(drive, name, parentId) {
  const folderName = sanitizeDriveFolderName(name);
  const escapedName = folderName.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const escapedParent = String(parentId || "").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const query = [
    "mimeType = 'application/vnd.google-apps.folder'",
    `name = '${escapedName}'`,
    `'${escapedParent}' in parents`,
    "trashed = false",
  ].join(" and ");

  const existing = await drive.files.list({
    q: query,
    fields: "files(id, name, webViewLink)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const folder = existing.data.files && existing.data.files[0];
  if (folder && folder.id) {
    return {
      id: folder.id,
      name: folder.name || folderName,
      webViewLink: folder.webViewLink || `https://drive.google.com/drive/folders/${folder.id}`,
    };
  }

  const created = await drive.files.create({
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id, name, webViewLink",
    supportsAllDrives: true,
  });
  return {
    id: created.data.id,
    name: created.data.name || folderName,
    webViewLink: created.data.webViewLink || `https://drive.google.com/drive/folders/${created.data.id}`,
  };
}

function getPaymentSlipMonth(payment) {
  return sanitizeDriveFolderName(
    payment.month ||
    payment.paymentMonth ||
    payment.studentSelectedMonth ||
    "ไม่ระบุเดือน"
  );
}

function getPaymentSlipGrade(payment, userProfile, studentProfile) {
  return sanitizeDriveFolderName(
    payment.grade ||
    payment.studentGrade ||
    payment.classLevel ||
    payment.level ||
    (studentProfile && (studentProfile.grade || studentProfile.studentGrade || studentProfile.classLevel || studentProfile.level)) ||
    (userProfile && (userProfile.grade || userProfile.studentGrade || userProfile.classLevel || userProfile.level)) ||
    "ไม่ระบุระดับชั้น"
  );
}

function getUploadedByName(userProfile, payment, uid) {
  return (
    (userProfile && (userProfile.name || userProfile.displayName || userProfile.studentName)) ||
    payment.studentName ||
    payment.student ||
    uid
  );
}

function buildSlipLogBase(payment, paymentId, uid) {
  return {
    paymentId,
    uid,
    studentId: payment.studentId || "",
    memberId: payment.memberId || "",
    studentName: payment.studentName || payment.student || "",
    paymentMonth: payment.month || "",
    month: payment.month || "",
    amount: payment.amount || payment.finalAmount || "",
    expectedAmount: payment.expectedAmount || payment.finalAmount || payment.amount || payment.baseAmount || "",
  };
}

function userOwnsPaymentByProfile(payment, userProfileData) {
  return !!(
    userProfileData &&
    (
      (userProfileData.memberId && payment.memberId === userProfileData.memberId) ||
      (userProfileData.memberId && payment.studentId === userProfileData.memberId) ||
      (userProfileData.studentId && payment.studentId === userProfileData.studentId) ||
      (userProfileData.studentId && payment.memberId === userProfileData.studentId)
    )
  );
}

async function assertCanUploadPaymentSlip(payment, uid, userProfileData, studentProfileData) {
  const ownerFields = [
    payment.studentAuthUid,
    payment.authUid,
    payment.slipUploadedByUid,
    payment.uploadedByUid,
  ].filter(Boolean);
  const ownsByUid = ownerFields.includes(uid);
  const ownsByProfile = userOwnsPaymentByProfile(payment, userProfileData) || userOwnsPaymentByProfile(payment, studentProfileData);
  const canUpload = ownsByUid || ownsByProfile || (await isBackOfficeUser(uid));
  if (!canUpload) {
    throw new HttpsError("permission-denied", "ไม่มีสิทธิ์อัปโหลดสลิปสำหรับรายการนี้");
  }
}

exports.uploadPaymentSlipToDrive = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อนอัปโหลดสลิป");
  }

  const uid = request.auth.uid;
  const { paymentId, fileBase64, mimeType, fileName } = request.data || {};
  const safePaymentId = String(paymentId || "").trim();
  const safeMimeType = String(mimeType || "").trim();

  if (!safePaymentId || !fileBase64) {
    throw new HttpsError("invalid-argument", "ต้องระบุ paymentId และ fileBase64");
  }
  if (!safeMimeType.startsWith("image/")) {
    throw new HttpsError("invalid-argument", "รองรับเฉพาะไฟล์รูปภาพเท่านั้น");
  }
  if (estimateBase64Size(fileBase64) > MAX_FILE_SIZE_BYTES) {
    throw new HttpsError("invalid-argument", "ไฟล์สลิปต้องมีขนาดไม่เกิน 8MB");
  }

  const paymentRef = db.collection("payments").doc(safePaymentId);
  const paymentDoc = await paymentRef.get();
  if (!paymentDoc.exists) {
    throw new HttpsError("not-found", "ไม่พบรายการชำระเงินนี้");
  }

  const payment = paymentDoc.data() || {};
  const userProfileData = await getUserProfile(uid);
  const studentProfileData = await getStudentProfileForPayment(payment, uid);
  await assertCanUploadPaymentSlip(payment, uid, userProfileData, studentProfileData);

  const logBase = buildSlipLogBase(payment, safePaymentId, uid);
  const uploadedByName = getUploadedByName(userProfileData, payment, uid);

  await paymentRef.set(
    {
      slipStatus: "uploading",
      slipUploadedByUid: uid,
      slipUploadedByName: uploadedByName,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  let tempFilePath = "";
  try {
    assertDriveFolderConfigured();

    const drive = getDriveClient();
    const monthFolderName = getPaymentSlipMonth(payment);
    const gradeFolderName = getPaymentSlipGrade(payment, userProfileData, studentProfileData);
    const monthFolder = await findOrCreateDriveFolder(drive, monthFolderName, DRIVE_FOLDER_ID);
    const gradeFolder = await findOrCreateDriveFolder(drive, gradeFolderName, monthFolder.id);

    const buffer = base64ToBuffer(fileBase64);
    const extension = getFileExtension(safeMimeType);
    const originalName = String(fileName || `payment-slip-${safePaymentId}${extension}`).replace(/[^\wก-ฮะ-์.\- ]/g, "-");
    const driveFileName = `${safePaymentId}-${Date.now()}-${originalName}`;
    tempFilePath = path.join(os.tmpdir(), driveFileName.endsWith(extension) ? driveFileName : `${driveFileName}${extension}`);
    fs.writeFileSync(tempFilePath, buffer);

    const uploadResult = await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [gradeFolder.id],
      },
      media: {
        mimeType: safeMimeType,
        body: fs.createReadStream(tempFilePath),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    const driveFileId = uploadResult.data.id;
    const driveViewUrl = uploadResult.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`;

    await paymentRef.set(
      {
        slipStorageType: "google_drive",
        driveFileId,
        driveViewUrl,
        driveFolderId: gradeFolder.id,
        driveFolderName: `${monthFolder.name} / ${gradeFolder.name}`,
        studentGrade: payment.studentGrade || payment.grade || (studentProfileData && studentProfileData.grade) || "",
        driveMonthFolderId: monthFolder.id,
        driveMonthFolderName: monthFolder.name,
        driveGradeFolderId: gradeFolder.id,
        driveGradeFolderName: gradeFolder.name,
        driveFolderUrl: gradeFolder.webViewLink,
        slipUploadedByUid: uid,
        slipUploadedByName: uploadedByName,
        slipUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        slipStatus: "waiting_admin_review",
        adminReviewStatus: "pending",
        paymentStatus: "รอตรวจสลิป",
        status: "รอตรวจสลิป",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await writeActivityLog({
      ...logBase,
      functionName: "uploadPaymentSlipToDrive",
      type: "payment_slip_uploaded",
      severity: "info",
      uploadedByName,
      driveFileId,
      driveViewUrl,
      driveFolderId: gradeFolder.id,
      driveFolderName: `${monthFolder.name} / ${gradeFolder.name}`,
      paymentGrade: gradeFolder.name,
    });

    return {
      ok: true,
      driveViewUrl,
      driveFolderId: gradeFolder.id,
      driveFolderName: `${monthFolder.name} / ${gradeFolder.name}`,
      slipStatus: "waiting_admin_review",
      message: "อัปโหลดสลิปเรียบร้อย รอเจ้าหน้าที่ตรวจสอบ",
    };
  } catch (error) {
    await writeActivityLog({
      ...logBase,
      functionName: "uploadPaymentSlipToDrive",
      type: "payment_slip_upload_failed",
      severity: "error",
      uploadedByName,
      error: error.message || String(error),
    });
    await paymentRef.set(
      {
        slipStatus: "upload_failed",
        slipUploadError: error.message || String(error),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "อัปโหลดสลิปไม่สำเร็จ");
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});

exports.cleanupDeletedStudentAuthAccounts = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อนล้างบัญชี Auth");
  }

  const requesterUid = request.auth.uid;
  if (!(await isAuthCleanupAdmin(requesterUid))) {
    throw new HttpsError("permission-denied", "ต้องเป็น Super Admin/Admin จึงจะล้าง Firebase Auth ได้");
  }

  const dryRun = request.data && request.data.dryRun !== false;
  const olderThanDays = normalizeCleanupDays(request.data && request.data.olderThanDays);
  const nowMs = Date.now();
  const eligibleBeforeMs = nowMs - olderThanDays * 24 * 60 * 60 * 1000;

  const snapshot = await db.collection("authCleanupQueue")
    .where("role", "==", "student")
    .where("status", "==", "queued")
    .limit(500)
    .get();

  const candidates = [];
  const skipped = [];

  for (const doc of snapshot.docs) {
    const item = doc.data() || {};
    const uid = String(item.uid || "").trim();
    const eligibleAtMs = timestampToMillis(item.eligibleAfter || item.deletedAt);
    const deletedAtMs = timestampToMillis(item.deletedAt);
    const isOldEnough = eligibleAtMs ? eligibleAtMs <= nowMs : deletedAtMs <= eligibleBeforeMs;

    if (!uid || !isOldEnough) {
      skipped.push({
        uid,
        email: item.email || "",
        reason: uid ? "ยังไม่ครบกำหนดล้าง Auth" : "ไม่มี uid",
      });
      continue;
    }

    const skipReason = await shouldSkipAuthCleanup(uid, requesterUid);
    if (skipReason) {
      skipped.push({
        uid,
        email: item.email || "",
        reason: skipReason,
      });
      continue;
    }

    candidates.push({
      doc,
      uid,
      email: item.email || "",
      studentName: item.studentName || "",
      memberId: item.memberId || "",
      source: item.source || "",
    });
  }

  const results = [];
  if (!dryRun) {
    for (const candidate of candidates) {
      try {
        await admin.auth().deleteUser(candidate.uid);
        await candidate.doc.ref.set({
          status: "deleted",
          deletedAuthAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedByUid: requesterUid,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        results.push({
          uid: candidate.uid,
          email: candidate.email,
          studentName: candidate.studentName,
          memberId: candidate.memberId,
          status: "deleted",
        });
      } catch (error) {
        const code = String(error.code || error.message || "");
        const missing = code.includes("auth/user-not-found") || code.includes("no user record");
        await candidate.doc.ref.set({
          status: missing ? "already_deleted" : "failed",
          cleanupError: error.message || String(error),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
        results.push({
          uid: candidate.uid,
          email: candidate.email,
          studentName: candidate.studentName,
          memberId: candidate.memberId,
          status: missing ? "already_deleted" : "failed",
          error: error.message || String(error),
        });
      }
    }

    await writeActivityLog({
      functionName: "cleanupDeletedStudentAuthAccounts",
      type: "student_auth_cleanup",
      severity: results.some((item) => item.status === "failed") ? "warning" : "info",
      uid: requesterUid,
      dryRun,
      olderThanDays,
      candidateCount: candidates.length,
      deletedCount: results.filter((item) => item.status === "deleted").length,
      failedCount: results.filter((item) => item.status === "failed").length,
    });
  }

  return {
    ok: true,
    dryRun,
    olderThanDays,
    candidateCount: candidates.length,
    skippedCount: skipped.length,
    candidates: candidates.map((candidate) => ({
      uid: candidate.uid,
      email: candidate.email,
      studentName: candidate.studentName,
      memberId: candidate.memberId,
      source: candidate.source,
    })),
    skipped,
    results,
  };
});

exports.uploadPaymentSlipToDriveAndOcr = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อนอัปโหลดสลิป");
  }

  const uid = request.auth.uid;
  const { paymentId, fileBase64, mimeType, fileName } = request.data || {};
  const safePaymentId = String(paymentId || "").trim();
  const safeMimeType = String(mimeType || "").trim();

  if (!safePaymentId || !fileBase64) {
    throw new HttpsError("invalid-argument", "ต้องระบุ paymentId และ fileBase64");
  }
  if (!safeMimeType.startsWith("image/")) {
    throw new HttpsError("invalid-argument", "รองรับเฉพาะไฟล์รูปภาพเท่านั้น");
  }
  if (estimateBase64Size(fileBase64) > MAX_FILE_SIZE_BYTES) {
    throw new HttpsError("invalid-argument", "ไฟล์สลิปต้องมีขนาดไม่เกิน 8MB");
  }

  const paymentRef = db.collection("payments").doc(safePaymentId);
  const paymentDoc = await paymentRef.get();
  if (!paymentDoc.exists) {
    throw new HttpsError("not-found", "ไม่พบรายการชำระเงินนี้");
  }

  const payment = paymentDoc.data() || {};
  const logBase = {
    paymentId: safePaymentId,
    uid,
    studentId: payment.studentId || "",
    memberId: payment.memberId || "",
    studentName: payment.studentName || payment.student || "",
    paymentMonth: payment.month || "",
    month: payment.month || "",
    amount: payment.amount || payment.finalAmount || "",
    expectedAmount: payment.expectedAmount || payment.finalAmount || payment.amount || payment.baseAmount || "",
  };
  const ownerFields = [
    payment.studentAuthUid,
    payment.authUid,
    payment.slipUploadedByUid,
    payment.uploadedByUid,
  ].filter(Boolean);
  const ownsByUid = ownerFields.includes(uid);
  const userProfileData = await getUserProfile(uid);
  const ownsByProfile = !!(
    userProfileData &&
    (
      (userProfileData.memberId && payment.memberId === userProfileData.memberId) ||
      (userProfileData.memberId && payment.studentId === userProfileData.memberId) ||
      (userProfileData.studentId && payment.studentId === userProfileData.studentId) ||
      (userProfileData.studentId && payment.memberId === userProfileData.studentId)
    )
  );
  const canUpload = ownsByUid || ownsByProfile || (await isBackOfficeUser(uid));
  if (!canUpload) {
    throw new HttpsError("permission-denied", "ไม่มีสิทธิ์อัปโหลดสลิปสำหรับรายการนี้");
  }

  await paymentRef.set(
    {
      slipStatus: "ocr_processing",
      slipUploadedByUid: uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  let tempFilePath = "";
  try {
    assertDriveFolderConfigured();

    const buffer = base64ToBuffer(fileBase64);
    const extension = getFileExtension(safeMimeType);
    const originalName = String(fileName || `payment-slip-${safePaymentId}${extension}`).replace(/[^\wก-ฮะ-์.\- ]/g, "-");
    const driveFileName = `${safePaymentId}-${Date.now()}-${originalName}`;
    tempFilePath = path.join(os.tmpdir(), driveFileName.endsWith(extension) ? driveFileName : `${driveFileName}${extension}`);
    fs.writeFileSync(tempFilePath, buffer);

    const drive = getDriveClient();
    const uploadResult = await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: safeMimeType,
        body: fs.createReadStream(tempFilePath),
      },
      fields: "id, webViewLink",
    });

    const driveFileId = uploadResult.data.id;
    const driveViewUrl = uploadResult.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`;

    const visionClient = new vision.ImageAnnotatorClient({ keyFilename: SERVICE_ACCOUNT_PATH });
    const [ocrResult] = await visionClient.textDetection(tempFilePath);
    const ocrRawText =
      (ocrResult.fullTextAnnotation && ocrResult.fullTextAnnotation.text) ||
      ((ocrResult.textAnnotations || [])[0] && ocrResult.textAnnotations[0].description) ||
      "";
    const parsed = parseThaiSlipText(ocrRawText);
    const duplicateRef = await checkDuplicateReference(parsed.referenceNo, safePaymentId);
    const expectedAmount = payment.finalAmount || payment.amount || payment.baseAmount || 0;
    const checkResult = buildOcrCheckResult({
      expectedAmount,
      ocrAmount: parsed.amount,
      duplicateRef,
      referenceNo: parsed.referenceNo,
    });

    await paymentRef.set(
      {
        slipStorageType: "google_drive",
        driveFileId,
        driveViewUrl,
        driveFolderId: DRIVE_FOLDER_ID,
        slipUploadedByUid: uid,
        slipUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        slipStatus: "waiting_admin_review",
        ocrStatus: ocrRawText ? "completed" : "no_text_found",
        ocrRawText: parsed.rawText,
        ocrPayerName: parsed.payerName,
        ocrReceiverName: parsed.receiverName,
        ocrTransferDateText: parsed.transferDateText,
        ocrTransferTime: parsed.transferTime,
        ocrAmount: parsed.amount,
        ocrReferenceNo: parsed.referenceNo,
        ocrCheckStatus: checkResult.ocrCheckStatus,
        ocrCheckNote: checkResult.ocrCheckNote,
        adminReviewStatus: "pending",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    await writeActivityLog({
      ...logBase,
      type: "payment_slip_ocr_success",
      severity: checkResult.ocrCheckStatus === "passed" ? "info" : "warning",
      driveFileId,
      ocrAmount: parsed.amount || "",
      ocrReferenceNo: parsed.referenceNo || "",
      ocrCheckStatus: checkResult.ocrCheckStatus,
      ocrCheckNote: checkResult.ocrCheckNote,
    });
    if (duplicateRef) {
      await writeActivityLog({
        ...logBase,
        type: "payment_slip_duplicate_reference",
        severity: "warning",
        referenceNo: parsed.referenceNo,
        ocrReferenceNo: parsed.referenceNo || "",
      });
    }

    return {
      ok: true,
      driveViewUrl,
      ocrCheckStatus: checkResult.ocrCheckStatus,
      ocrCheckNote: checkResult.ocrCheckNote,
    };
  } catch (error) {
    await writeActivityLog({
      ...logBase,
      type: "payment_slip_ocr_failed",
      severity: "error",
      error: error.message || String(error),
    });
    await paymentRef.set(
      {
        slipStatus: "ocr_failed",
        ocrStatus: "failed",
        ocrError: error.message || String(error),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "อัปโหลดหรือ OCR สลิปไม่สำเร็จ");
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});
