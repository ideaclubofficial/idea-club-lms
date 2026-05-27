// IDEA CLUB LMS - Google Drive Upload Web App
// Set ROOT_FOLDER_ID to the Google Drive folder that will contain uploads.
// Do not put private keys in this file. This script uses the Google account that deploys the Web App.
const ROOT_FOLDER_ID = "1duCUjn4tKYPwZSgxJoo_83DQ34rztk7w";

// Run this once from the Apps Script editor after copying the code.
// It forces Google to ask for Drive permission and confirms that ROOT_FOLDER_ID is accessible.
function testDriveAccess() {
  const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
  Logger.log("Drive access OK: " + root.getName());
}

function doPost(e) {
  try {
    const body = e && e.postData && e.postData.contents ? e.postData.contents : "{}";
    const data = JSON.parse(body);
    if (data.action !== "uploadFile") {
      return jsonResponse({ ok: false, error: "Unsupported action" });
    }

    const fileBase64 = String(data.fileBase64 || "").replace(/^data:[^;]+;base64,/, "");
    const fileName = sanitizeName(data.fileName || "upload");
    const mimeType = String(data.mimeType || "application/octet-stream");
    const folderType = sanitizeName(data.folderType || "uploads");
    const assetType = sanitizeName(data.assetType || "");

    if (!fileBase64) {
      return jsonResponse({ ok: false, error: "Missing fileBase64" });
    }

    const root = DriveApp.getFolderById(ROOT_FOLDER_ID);
    const baseFolder = getOrCreateFolder(root, folderType);
    const targetFolder = getTargetFolder(baseFolder, data);
    const bytes = Utilities.base64Decode(fileBase64);
    const blob = Utilities.newBlob(bytes, mimeType, buildFileName(fileName, data));
    const file = targetFolder.createFile(blob);

    if (folderType === "site-assets" || assetType) {
      file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }

    return jsonResponse({
      ok: true,
      fileId: file.getId(),
      viewUrl: file.getUrl(),
      directImageUrl: "https://drive.google.com/uc?export=view&id=" + file.getId(),
      folderId: targetFolder.getId(),
      folderName: targetFolder.getName()
    });
  } catch (error) {
    return jsonResponse({
      ok: false,
      error: error && error.message ? error.message : String(error)
    });
  }
}

function getTargetFolder(baseFolder, data) {
  if (String(data.folderType || "") !== "payment-slips") {
    return baseFolder;
  }

  const monthName = sanitizeName(data.month || "ไม่ระบุเดือน");
  const courseName = sanitizeName(data.courseName || data.courseId || "ไม่ระบุคอร์ส");
  const monthFolder = getOrCreateFolder(baseFolder, monthName);
  return getOrCreateFolder(monthFolder, courseName);
}

function getOrCreateFolder(parent, name) {
  const safeName = sanitizeName(name || "uploads");
  const folders = parent.getFoldersByName(safeName);
  if (folders.hasNext()) return folders.next();
  return parent.createFolder(safeName);
}

function buildFileName(fileName, data) {
  if (String(data.folderType || "") === "payment-slips") {
    return buildPaymentSlipFileName(fileName, data);
  }

  const prefixParts = [];
  if (data.assetType) prefixParts.push(sanitizeName(data.assetType));
  if (data.paymentId) prefixParts.push(sanitizeName(data.paymentId));
  if (data.studentId) prefixParts.push(sanitizeName(data.studentId));
  prefixParts.push(String(Date.now()));
  prefixParts.push(fileName);
  return prefixParts.filter(Boolean).join("-");
}

function buildPaymentSlipFileName(fileName, data) {
  const extension = getFileExtension(fileName);
  const timestamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), "yyyyMMdd-HHmmss");
  const parts = [
    sanitizeName(data.studentId || "ไม่ระบุรหัส"),
    sanitizeName(data.studentName || "ไม่ระบุชื่อนักเรียน"),
    sanitizeName(data.month || "ไม่ระบุเดือน"),
    timestamp
  ];
  return parts.filter(Boolean).join("-") + extension;
}

function getFileExtension(fileName) {
  const match = String(fileName || "").match(/(\.[A-Za-z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function sanitizeName(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|#%{}[\]~]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120) || "upload";
}

function jsonResponse(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
