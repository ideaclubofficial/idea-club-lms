const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const { google } = require("googleapis");
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

function getImageFileExtension(mimeType) {
  const map = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "image/x-icon": ".ico",
    "image/vnd.microsoft.icon": ".ico",
  };
  return map[String(mimeType || "").toLowerCase()] || getFileExtension(mimeType);
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

function getDriveDirectImageUrl(fileId) {
  return `https://drive.google.com/uc?export=view&id=${fileId}`;
}

async function makeDriveFilePublic(drive, fileId) {
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: "reader",
      type: "anyone",
    },
    supportsAllDrives: true,
  });
}

function getSiteAssetLabel(assetType) {
  const map = {
    payment_qr: "payment-qr",
    logo: "logo",
    favicon: "favicon",
  };
  return map[assetType] || "";
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

    try {
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
    } catch (logError) {
      console.warn("payment_slip_uploaded log failed:", logError);
    }

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

exports.uploadSiteAssetToDrive = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อนอัปโหลดรูป");
  }

  if (!(await isAuthCleanupAdmin(request.auth.uid))) {
    throw new HttpsError("permission-denied", "ต้องเป็น Admin/Super Admin จึงจะอัปโหลดรูปตั้งค่าระบบได้");
  }

  const { assetType, fileBase64, mimeType, fileName } = request.data || {};
  const safeAssetType = String(assetType || "").trim();
  const assetLabel = getSiteAssetLabel(safeAssetType);
  const safeMimeType = String(mimeType || "").trim().toLowerCase();

  if (!assetLabel) {
    throw new HttpsError("invalid-argument", "assetType ต้องเป็น payment_qr, logo หรือ favicon");
  }
  if (!fileBase64) {
    throw new HttpsError("invalid-argument", "ไม่พบไฟล์รูปสำหรับอัปโหลด");
  }
  if (!safeMimeType.startsWith("image/")) {
    throw new HttpsError("invalid-argument", "รองรับเฉพาะไฟล์รูปภาพเท่านั้น");
  }
  if (estimateBase64Size(fileBase64) > MAX_FILE_SIZE_BYTES) {
    throw new HttpsError("invalid-argument", "ไฟล์รูปต้องมีขนาดไม่เกิน 8MB");
  }

  assertDriveFolderConfigured();

  const drive = getDriveClient();
  const assetFolder = await findOrCreateDriveFolder(drive, "site-assets", DRIVE_FOLDER_ID);
  const extension = getImageFileExtension(safeMimeType);
  const safeOriginalName = String(fileName || `${assetLabel}${extension}`).replace(/[^\wก-ฮะ-์.\- ]/g, "-");
  const driveFileName = `${assetLabel}-${Date.now()}-${safeOriginalName}`;
  const tempFilePath = path.join(os.tmpdir(), driveFileName.endsWith(extension) ? driveFileName : `${driveFileName}${extension}`);

  try {
    fs.writeFileSync(tempFilePath, base64ToBuffer(fileBase64));
    const uploadResult = await drive.files.create({
      requestBody: {
        name: driveFileName,
        parents: [assetFolder.id],
      },
      media: {
        mimeType: safeMimeType,
        body: fs.createReadStream(tempFilePath),
      },
      fields: "id, webViewLink",
      supportsAllDrives: true,
    });

    const driveFileId = uploadResult.data.id;
    await makeDriveFilePublic(drive, driveFileId);
    const driveViewUrl = uploadResult.data.webViewLink || `https://drive.google.com/file/d/${driveFileId}/view`;
    const directImageUrl = getDriveDirectImageUrl(driveFileId);

    await writeActivityLog({
      functionName: "uploadSiteAssetToDrive",
      type: "site_asset_uploaded",
      severity: "info",
      uid: request.auth.uid,
      assetType: safeAssetType,
      driveFileId,
      driveViewUrl,
      directImageUrl,
    });

    return {
      ok: true,
      assetType: safeAssetType,
      driveFileId,
      driveViewUrl,
      directImageUrl,
      folderId: assetFolder.id,
      folderName: assetFolder.name,
    };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "อัปโหลดรูปไป Google Drive ไม่สำเร็จ");
  } finally {
    if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
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
      slipStatus: "uploading",
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

    await paymentRef.set(
      {
        slipStorageType: "google_drive",
        driveFileId,
        driveViewUrl,
        driveFolderId: DRIVE_FOLDER_ID,
        slipUploadedByUid: uid,
        slipUploadedAt: admin.firestore.FieldValue.serverTimestamp(),
        slipStatus: "waiting_admin_review",
        adminReviewStatus: "pending",
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    try {
      await writeActivityLog({
        ...logBase,
        type: "payment_slip_uploaded",
        severity: "info",
        driveFileId,
        driveViewUrl,
      });
    } catch (logError) {
      console.warn("payment_slip_uploaded log failed:", logError);
    }

    return {
      ok: true,
      driveViewUrl,
      slipStatus: "waiting_admin_review",
      message: "อัปโหลดสลิปเรียบร้อย รอเจ้าหน้าที่ตรวจสอบ",
    };
  } catch (error) {
    await writeActivityLog({
      ...logBase,
      type: "payment_slip_upload_failed",
      severity: "error",
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

// ============================================================
// ระบบข้อสอบ ป.4–ป.6
// ============================================================

/**
 * parseExamFilename(name)
 * Parse grade / subject / topics จากชื่อไฟล์
 * รองรับรูปแบบ: "[ป.4] วิทย์ Monthly Test.pdf"  |  "ป6_คณิต_เศษส่วน-ทศนิยม.pdf"
 * Topics: ถ้าชื่อไฟล์มีส่วนที่ตาม _ หรือ - หลังวิชา ให้ split เป็น topics
 */
function parseExamFilename(name) {
  const lower = (name || "").toLowerCase();
  const gradePatterns = [
    { pattern: /ป\.4|ป4\b|p4\b/, value: "ป.4" },
    { pattern: /ป\.5|ป5\b|p5\b/, value: "ป.5" },
    { pattern: /ป\.6|ป6\b|p6\b/, value: "ป.6" },
  ];
  const subjectPatterns = [
    { pattern: /วิทยาศาสตร์|วิทย์|science/, value: "วิทยาศาสตร์" },
    { pattern: /คณิตศาสตร์|คณิต|math/, value: "คณิตศาสตร์" },
    { pattern: /ภาษาอังกฤษ|อังกฤษ|english/, value: "ภาษาอังกฤษ" },
    { pattern: /ภาษาไทย|ไทย\b|thai/, value: "ภาษาไทย" },
    { pattern: /สังคมศึกษา|สังคม|social/, value: "สังคมศึกษา" },
  ];
  let grade = "";
  let subject = "";
  for (const g of gradePatterns) {
    if (g.pattern.test(lower)) { grade = g.value; break; }
  }
  for (const s of subjectPatterns) {
    if (s.pattern.test(lower)) { subject = s.value; break; }
  }
  // พยายาม parse topics จากส่วนท้ายชื่อไฟล์ เช่น "_เศษส่วน-ทศนิยม.pdf"
  const withoutExt = (name || "").replace(/\.[^.]+$/, "");
  const topicSection = withoutExt.split("_").slice(2).join("_"); // หลัง _ ที่ 2
  const topics = topicSection
    ? topicSection.split(/[-_,]/).map((t) => t.trim()).filter((t) => t && !/^\d{4}$/.test(t))
    : [];
  return { grade, subject, topics };
}

/**
 * downloadDriveFileAsText(drive, fileId)
 * ดาวน์โหลด content ของไฟล์จาก Drive เป็น string
 * ใช้กับไฟล์ .json ที่ uploaded ตรงๆ (ไม่ใช่ Google Docs native)
 */
async function downloadDriveFileAsText(drive, fileId) {
  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );
  return new Promise((resolve, reject) => {
    let content = "";
    response.data.on("data", (chunk) => { content += chunk.toString("utf8"); });
    response.data.on("end", () => resolve(content));
    response.data.on("error", reject);
  });
}

/**
 * syncExamBankFromDrive
 * อ่านไฟล์จาก Google Drive folder แล้ว upsert เข้า collection examBank
 *
 * รองรับ 2 แบบ:
 *   แบบที่ 1 — JSON metadata file (.json)
 *     ไฟล์ที่มีเนื้อหา JSON ตรงตาม examBank schema จะถูก parse เต็มรูปแบบ
 *     รวมถึง answerKey, topics, testId ที่กำหนดเอง
 *   แบบที่ 2 — ไฟล์ข้อสอบจริง (PDF/Docs/Slides/Forms)
 *     Parse metadata จากชื่อไฟล์, set status="draft", needsAnswerKey=true
 *     Admin ต้องกรอก answerKey ผ่านฟอร์ม examBank ก่อน activate
 *
 * request.data: { folderId?: string }
 * return: { ok, synced, skipped, errors, errorDetails, folderId }
 */
exports.syncExamBankFromDrive = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อน Sync ข้อสอบ");
  }
  if (!(await isAuthCleanupAdmin(request.auth.uid))) {
    throw new HttpsError("permission-denied", "ต้องเป็น Admin จึงจะ Sync ข้อสอบจาก Drive ได้");
  }

  const EXAM_FOLDER_ID = "16t5boPIY4736OkQLv3S7JWZ02QvQeqBW";
  const folderId = String(
    (request.data && request.data.folderId) || EXAM_FOLDER_ID
  ).trim();

  if (!folderId) {
    throw new HttpsError("invalid-argument", "ต้องระบุ folderId ของ Google Drive");
  }

  const drive = getDriveClient();

  // ดึงไฟล์ทุกประเภทรวมทั้ง JSON metadata
  const examMimeTypes = [
    "application/json",
    "text/plain",                                       // .json อาจถูก detect เป็น text/plain
    "application/pdf",
    "application/vnd.google-apps.document",
    "application/vnd.google-apps.presentation",
    "application/vnd.google-apps.form",
    "application/vnd.google-apps.spreadsheet",
  ];
  const mimeQuery = examMimeTypes.map((m) => `mimeType = '${m}'`).join(" or ");

  let files = [];
  try {
    const listRes = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false and (${mimeQuery})`,
      fields: "files(id, name, mimeType, webViewLink, modifiedTime, size)",
      pageSize: 100,
      orderBy: "name",
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files = listRes.data.files || [];
  } catch (err) {
    throw new HttpsError(
      "internal",
      "ดึงรายการไฟล์จาก Drive ไม่สำเร็จ: " + (err.message || String(err))
    );
  }

  if (!files.length) {
    return {
      ok: true,
      synced: 0, skipped: 0, errors: 0, errorDetails: [],
      files: [],
      message: "ไม่พบไฟล์ใน folder นี้ — อัปโหลดไฟล์ข้อสอบ (.json หรือ .pdf) แล้วลองใหม่",
    };
  }

  let synced = 0, skipped = 0;
  const errorDetails = [];
  const syncedFiles = [];

  await Promise.all(
    files.map(async (file) => {
      try {
        const isJsonFile = file.name.toLowerCase().endsWith(".json")
          || file.mimeType === "application/json"
          || (file.mimeType === "text/plain" && file.name.toLowerCase().endsWith(".json"));

        // --- แบบที่ 1: JSON metadata file ---
        if (isJsonFile) {
          // ข้าม JSON ที่ใหญ่เกิน 512 KB เพื่อความปลอดภัย
          const fileSizeBytes = Number(file.size || 0);
          if (fileSizeBytes > 512 * 1024) {
            skipped++;
            return;
          }

          let examData = null;
          try {
            const raw = await downloadDriveFileAsText(drive, file.id);
            examData = JSON.parse(raw);
          } catch (parseErr) {
            console.warn("JSON parse failed:", file.name, parseErr.message);
            errorDetails.push({ file: file.name, error: "JSON parse error: " + parseErr.message });
            // ยัง continue ด้วย fallback mode ด้านล่าง
          }

          if (examData && typeof examData === "object") {
            // ใช้ testId จาก JSON หรือ derive จาก filename (ตัดนามสกุล)
            const testId = String(examData.testId || file.name.replace(/\.json$/i, "")).trim();
            const docId = testId || `drive_${file.id}`;
            const ref = db.collection("examBank").doc(docId);
            const existing = await ref.get();
            const prev = existing.exists ? (existing.data() || {}) : {};

            const answerKey = Array.isArray(examData.answerKey) && examData.answerKey.length
              ? examData.answerKey
              : (prev.answerKey || []);

            const payload = {
              testId: docId,
              firebaseDocId: docId,
              title: examData.title || prev.title || file.name,
              grade: examData.grade || prev.grade || "",
              subject: examData.subject || prev.subject || "",
              topics: (Array.isArray(examData.topics) && examData.topics.length)
                ? examData.topics
                : (prev.topics && prev.topics.length ? prev.topics : []),
              totalItems: Number(examData.totalItems)
                || answerKey.length
                || prev.totalItems
                || 0,
              answerKey,
              needsAnswerKey: answerKey.length === 0,
              sourceType: "google_drive",
              driveFolderId: folderId,
              driveFileId: file.id,
              driveViewUrl: file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`,
              driveMimeType: file.mimeType || "",
              driveModifiedTime: file.modifiedTime || "",
              status: examData.status || prev.status || (answerKey.length ? "active" : "draft"),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (!existing.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

            await ref.set(payload, { merge: true });
            synced++;
            syncedFiles.push({ id: docId, title: payload.title, grade: payload.grade, subject: payload.subject, source: "json" });
            return;
          }
          // JSON parse ล้มเหลว — fall through to filename mode
        }

        // --- แบบที่ 2: PDF / Docs / อื่นๆ — parse จากชื่อไฟล์ ---
        const docId = `drive_${file.id}`;
        const ref = db.collection("examBank").doc(docId);
        const existing = await ref.get();
        const prev = existing.exists ? (existing.data() || {}) : {};

        // ถ้ามีอยู่แล้วและมี answerKey แล้ว ให้ skip เพื่อไม่ทับ metadata ที่ admin กรอกไว้
        if (existing.exists && prev.answerKey && prev.answerKey.length > 0) {
          skipped++;
          return;
        }

        const { grade, subject, topics } = parseExamFilename(file.name || "");
        const driveViewUrl = file.webViewLink || `https://drive.google.com/file/d/${file.id}/view`;

        const payload = {
          testId: docId,
          firebaseDocId: docId,
          title: prev.title || file.name || docId,
          grade: prev.grade || grade,
          subject: prev.subject || subject,
          topics: (prev.topics && prev.topics.length) ? prev.topics : topics,
          totalItems: prev.totalItems || 0,
          answerKey: prev.answerKey || [],
          needsAnswerKey: true,   // Admin ต้องกรอก answerKey ในฟอร์ม examBank ก่อน activate
          sourceType: "google_drive",
          driveFolderId: folderId,
          driveFileId: file.id,
          driveViewUrl,
          driveMimeType: file.mimeType || "",
          driveModifiedTime: file.modifiedTime || "",
          status: prev.status || "draft",  // draft เพราะยังไม่มี answerKey
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (!existing.exists) payload.createdAt = admin.firestore.FieldValue.serverTimestamp();

        await ref.set(payload, { merge: true });
        synced++;
        syncedFiles.push({
          id: docId, title: payload.title, grade: payload.grade,
          subject: payload.subject, source: "filename", needsAnswerKey: true,
        });
      } catch (err) {
        console.error("syncExamBankFromDrive file error:", file.name, err);
        errorDetails.push({ file: file.name, error: err.message || String(err) });
      }
    })
  );

  await writeActivityLog({
    functionName: "syncExamBankFromDrive",
    type: "exam_bank_synced",
    severity: errorDetails.length ? "warn" : "info",
    uid: request.auth.uid,
    folderId,
    synced,
    skipped,
    errors: errorDetails.length,
  });

  return {
    ok: true,
    synced,
    skipped,
    errors: errorDetails.length,
    errorDetails,
    folderId,
    files: syncedFiles,
  };
});

// ============================================================
// end ระบบข้อสอบ ป.4–ป.6
// ============================================================

// ============================================================
// Reset Student Password to Default
// ============================================================
exports.resetStudentPasswordToDefault = onCall(async (request) => {
  if (!request.auth || !request.auth.uid) {
    throw new HttpsError("unauthenticated", "กรุณาเข้าสู่ระบบก่อนใช้งาน");
  }

  const callerUid = request.auth.uid;
  const isAdmin = await isAuthCleanupAdmin(callerUid);
  if (!isAdmin) {
    throw new HttpsError("permission-denied", "สิทธิ์ไม่เพียงพอ — เฉพาะ Admin เท่านั้น");
  }

  const { uid, memberId, defaultPassword: requestPassword } = request.data || {};
  const safeUid = String(uid || "").trim();
  const safeMemberId = String(memberId || "").trim();

  if (!safeUid && !safeMemberId) {
    throw new HttpsError("invalid-argument", "ต้องระบุ uid หรือ memberId");
  }

  // Find the user doc in Firestore
  let userDocRef = null;
  let userDocData = null;

  if (safeUid) {
    const snap = await db.collection("users").doc(safeUid).get();
    if (snap.exists) {
      userDocRef = snap.ref;
      userDocData = snap.data() || {};
    }
  }

  if (!userDocRef && safeMemberId) {
    const snap = await db.collection("users")
      .where("memberId", "==", safeMemberId)
      .limit(1)
      .get();
    if (!snap.empty) {
      userDocRef = snap.docs[0].ref;
      userDocData = snap.docs[0].data() || {};
    }
  }

  if (!userDocRef || !userDocData) {
    throw new HttpsError("not-found", "ไม่พบข้อมูลนักเรียนใน Firestore");
  }

  // Resolve the auth UID to update password in Firebase Auth
  const authUid = userDocData.authUid || userDocData.uid || userDocRef.id;
  if (!authUid) {
    throw new HttpsError("not-found", "ไม่พบ authUid ของนักเรียน");
  }

  // Resolve defaultPassword: prefer request payload, then Firestore fields
  const passwordFields = ["defaultPassword", "passwordDefault", "initialPassword", "loginPassword", "password", "plainPassword"];
  let resolvedPassword = String(requestPassword || "").trim();
  if (!resolvedPassword) {
    for (const field of passwordFields) {
      const val = String(userDocData[field] || "").trim();
      if (val) { resolvedPassword = val; break; }
    }
  }

  if (!resolvedPassword) {
    throw new HttpsError("failed-precondition", "ไม่พบ defaultPassword ของนักเรียนคนนี้");
  }

  // Update Firebase Auth password
  await admin.auth().updateUser(authUid, { password: resolvedPassword });

  // Record reset in Firestore
  await userDocRef.set({
    passwordResetAt: admin.firestore.FieldValue.serverTimestamp(),
    passwordResetBy: callerUid,
    passwordResetToDefault: true,
  }, { merge: true });

  await writeActivityLog({
    functionName: "resetStudentPasswordToDefault",
    type: "password_reset",
    severity: "info",
    uid: callerUid,
    targetUid: authUid,
    targetMemberId: safeMemberId || (userDocData.memberId || ""),
  });

  return { ok: true };
});
