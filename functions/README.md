# IDEA CLUB Functions

## Payment Slip OCR Paused

ระบบ OCR สลิปถูกพักไว้ก่อน เนื่องจากมีค่าใช้จ่าย API/Cloud Functions ห้าม deploy `uploadPaymentSlipToDriveAndOcr` จนกว่าจะอนุมัติงบ/ค่าใช้จ่ายและเปิด feature flag ในหน้าเว็บอีกครั้ง

## Payment Slip Web Upload

ระบบอัปโหลดสลิปผ่านเว็บแบบไม่ใช้ OCR ใช้ callable function `uploadPaymentSlipToDrive` เพื่อเก็บสลิปใน Google Drive ตามโครงสร้าง `DRIVE_FOLDER_ID / เดือน / ระดับชั้น` และบันทึกผู้อัปโหลดกลับไปที่ `payments/{paymentId}`.

## Site Assets on Google Drive

รูปตั้งค่าระบบ เช่น QR Code, Logo และ Favicon ใช้ callable function `uploadSiteAssetToDrive` เพื่อเก็บใน Google Drive โฟลเดอร์ `site-assets` แทน Firebase Storage.

## Setup Google Drive OCR

The payment slip OCR function uploads student slip images to Google Drive and uses Cloud Vision OCR for a first-pass review.

## Required APIs

- Google Drive API
- Cloud Vision API

## Required Local Secret

- Create the real service account JSON at `functions/service-account-drive.json`.
- Do not commit the real `service-account-drive.json` file.
- Share the target Google Drive folder with the service account email as Editor.

## Required Env/Constant

- Set `DRIVE_FOLDER_ID` before deploy, or replace the local placeholder only in a safe deployment environment.
- The code placeholder is `PUT_GOOGLE_DRIVE_FOLDER_ID_HERE`.
- Production should use environment/secret configuration instead of hardcoding IDs.

### Option A: environment variable

```sh
DRIVE_FOLDER_ID="xxxx" firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

สำหรับระบบอัปโหลดสลิปแบบไม่ใช้ OCR ให้ deploy เฉพาะ:

```sh
DRIVE_FOLDER_ID="xxxx" firebase deploy --only functions:uploadPaymentSlipToDrive
```

สำหรับระบบอัปโหลด QR/Logo/Favicon ไป Google Drive ให้ deploy เฉพาะ:

```sh
DRIVE_FOLDER_ID="xxxx" firebase deploy --only functions:uploadSiteAssetToDrive
```

### Option B: temporary local constant

```js
const DRIVE_FOLDER_ID = "xxxx";
```

Only use Option B in a safe local/deployment branch. Do not commit the real folder ID unless explicitly approved.

## Deploy Command Later

```sh
firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```
