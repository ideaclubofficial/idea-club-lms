# Payment OCR Deploy Checklist

## สถานะปัจจุบัน

ระบบ OCR สลิปถูกพักไว้ก่อน เนื่องจากมีค่าใช้จ่าย API/Cloud Functions ห้าม deploy `uploadPaymentSlipToDriveAndOcr` จนกว่าจะอนุมัติงบ/ค่าใช้จ่าย และเปิด feature flag `ENABLE_PAYMENT_SLIP_OCR` ในหน้าเว็บอีกครั้ง

ระบบอัปโหลดสลิปผ่านเว็บแบบไม่ใช้ OCR ใช้ function `uploadPaymentSlipToDrive` และสร้างโฟลเดอร์ Google Drive ตาม `เดือน / ระดับชั้น`

## 1. สิ่งที่ต้องเปิดใน Google Cloud/Firebase

- Blaze plan
- Cloud Functions
- Google Drive API
- Cloud Vision API

## 2. สิ่งที่ต้องเตรียมใน Google Drive

- สร้าง folder `IDEA CLUB Payment Slips`
- Copy Folder ID
- Share folder ให้ service account เป็น Editor

## 3. สิ่งที่ต้องเตรียมใน local

- วางไฟล์จริงที่ `functions/service-account-drive.json`
- ห้าม commit ไฟล์จริง
- ตั้ง `DRIVE_FOLDER_ID`

ตั้งค่า `DRIVE_FOLDER_ID` ได้ 2 ทาง:

ทางเลือก A: ใช้ environment variable

```sh
DRIVE_FOLDER_ID="xxxx" firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

ถ้าต้อง deploy เฉพาะระบบอัปโหลดสลิปแบบไม่ใช้ OCR:

```sh
DRIVE_FOLDER_ID="xxxx" firebase deploy --only functions:uploadPaymentSlipToDrive
```

ทางเลือก B: แก้ constant ชั่วคราวใน `functions/index.js`

```js
const DRIVE_FOLDER_ID = "xxxx";
```

แนะนำ production ให้ใช้ env/secret ไม่ hardcode และห้าม commit Folder ID จริงถ้ายังไม่ได้อนุญาต

## 4. คำสั่งตรวจ

```sh
cd functions
npm install
node --check index.js
```

## 5. Data readiness before testing

- `users/{uid}` ต้องมี `memberId`/`studentId` สำหรับ student
- `payments/{paymentId}` ต้องมี `studentAuthUid` หรือ `memberId`/`studentId` ที่ตรงกับ user
- `payments` ต้องถูกสร้างจาก Admin/Finance หรือ backend workflow ก่อน student upload
- Student ไม่สามารถสร้าง payment เอง
- ถ้าไม่มี payment ของเดือนนั้น ให้ใช้ LINE flow fallback

ตัวอย่าง payment สำหรับทดสอบ:

```json
{
  "memberId": "P625690001",
  "studentId": "P625690001",
  "studentAuthUid": "<student uid>",
  "month": "มิถุนายน 2569",
  "amount": 2400,
  "expectedAmount": 2400,
  "paymentStatus": "รอชำระเงิน"
}
```

## Test payment document

Collection: `payments`

Document ID ตัวอย่าง: `TEST-PAY-P625690001-2026-06`

Fields:

```json
{
  "memberId": "P625690001",
  "studentId": "P625690001",
  "studentName": "ชื่อนักเรียนทดสอบ",
  "studentAuthUid": "<Firebase Auth UID ของนักเรียน>",
  "courseId": "TEST-COURSE-P6",
  "courseName": "คอร์สทดสอบ ป.6",
  "month": "มิถุนายน 2569",
  "amount": 2400,
  "expectedAmount": 2400,
  "paymentStatus": "รอชำระเงิน",
  "status": "รอชำระเงิน"
}
```

`users/{uid}` ของนักเรียนควรมี:

```json
{
  "role": "student",
  "status": "active",
  "memberId": "P625690001",
  "studentId": "P625690001",
  "name": "ชื่อนักเรียนทดสอบ"
}
```

- `studentAuthUid` ต้องตรงกับ uid ของผู้ใช้ที่ login ในเว็บ
- `memberId`/`studentId` ใน `users/{uid}` ต้องตรงกับ payment
- ถ้าไม่ตรง Cloud Function จะ reject ด้วย `permission-denied`

## 6. คำสั่ง deploy ภายหลัง

```sh
firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

## Manual deploy only

1. ตรวจ node/npm/firebase CLI
2. รัน `npm install`
3. รัน `node --check index.js`
4. ตรวจว่า `functions/service-account-drive.json` อยู่ local และถูก gitignore
5. ตรวจ `DRIVE_FOLDER_ID` ไม่ใช่ placeholder
6. ตรวจ Google Drive folder share ให้ service account เป็น Editor
7. Deploy ด้วยคำสั่ง:

```sh
firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

ห้าม deploy ถ้า `DRIVE_FOLDER_ID` ยังเป็น placeholder
ห้าม deploy ถ้ายังไม่มี `service-account-drive.json`
ห้าม deploy ถ้ายังไม่ได้เปิด Drive API / Vision API / Blaze Plan

## Firebase Auth cleanup

ระบบล้างบัญชี Firebase Auth ของนักเรียนที่ถูกลบแล้วใช้ callable function:

```sh
firebase deploy --only functions:cleanupDeletedStudentAuthAccounts
```

- ใช้จาก Admin Settings > ล้างบัญชี Firebase Auth นักเรียนที่ถูกลบแล้ว
- กด `ตรวจรายการที่จะลบ` ก่อนเสมอ
- ลบเฉพาะรายการใน `authCleanupQueue` ที่เป็น `role: "student"` และครบกำหนด
- Function จะข้าม Admin/ครู และไม่ลบ account ของผู้สั่งงาน

## 7. วิธีทดสอบหลัง deploy

- สร้าง payment จริงใน Firestore ที่มี `studentAuthUid` หรือ `memberId`/`studentId` ตรงกับ user
- Login student
- เลือกเดือน
- Upload slip
- ตรวจ `payments/{paymentId}` ว่ามี `driveViewUrl` และ OCR fields
- เปิด Admin payment table ตรวจปุ่มเปิดสลิป/ดู OCR

## 8. Rollback

- ถ้า OCR มีปัญหา ให้ใช้ LINE flow เดิมต่อ
- ไม่ต้องลบข้อมูล payment
