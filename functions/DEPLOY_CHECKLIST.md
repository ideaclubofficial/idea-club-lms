# Payment OCR Deploy Checklist

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

## 6. คำสั่ง deploy ภายหลัง

```sh
firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

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
