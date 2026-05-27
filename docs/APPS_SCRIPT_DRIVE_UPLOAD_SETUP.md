# ตั้งค่า Apps Script สำหรับอัปโหลดไฟล์ไป Google Drive

ระบบนี้ใช้ Google Apps Script Web App เป็นตัวกลางอัปโหลด QR Code, Logo, Favicon และสลิป ไปยัง Google Drive โดยไม่ต้องใช้ Firebase Cloud Functions หรือ Blaze ในขั้นนี้

## ขั้นตอนตั้งค่า

1. ไปที่ Google Apps Script แล้วสร้างโปรเจกต์ใหม่
2. คัดลอกโค้ดจาก `apps-script/drive-upload-webapp.gs` ไปวาง
3. ตรวจค่า `ROOT_FOLDER_ID` ให้เป็น:
   `1duCUjn4tKYPwZSgxJoo_83DQ34rztk7w`
4. กด Save
5. เลือกฟังก์ชัน `testDriveAccess` แล้วกด Run
6. ระบบจะให้ Authorize:
   - กด Review permissions
   - เลือกบัญชี Google ที่มีสิทธิ์ใน Drive folder
   - ถ้าขึ้นเตือนว่าแอปยังไม่ได้ verify ให้กด Advanced > Go to project
   - กด Allow
7. เปิด Executions/Logs แล้วต้องเห็นข้อความประมาณ:
   `Drive access OK: <ชื่อโฟลเดอร์>`
8. ถ้า `testDriveAccess` ขึ้นว่าไม่ได้รับอนุญาตหรือหา folder ไม่เจอ ให้ตรวจว่า Google account นี้มีสิทธิ์ Editor ใน folder:
   `1duCUjn4tKYPwZSgxJoo_83DQ34rztk7w`
9. กด Deploy > New deployment > Web app
10. ตั้งค่า:
   - Execute as: Me
   - Who has access: Anyone with the link
11. กด Deploy
12. Copy Web App URL
13. นำ URL ไปใส่ใน `index.html`:
   `GOOGLE_APPS_SCRIPT_UPLOAD_URL`
14. Commit และทดสอบอัปโหลด QR, Logo และสลิป
15. ถ้าแก้โค้ด Apps Script ภายหลัง ให้กด Deploy > Manage deployments > Edit > New version แล้ว Deploy ซ้ำ

## แก้ Error: ไม่ได้รับอนุญาตให้เข้าถึง DriveApp

ถ้าเว็บขึ้น error เช่น `ไม่ได้รับอนุญาตให้เข้าถึง: DriveApp` ให้ทำตามนี้:

1. กลับไปที่ Apps Script editor
2. ตรวจว่ามีฟังก์ชัน `testDriveAccess`
3. กด Run `testDriveAccess`
4. กด Authorize ให้ครบ
5. ตรวจว่า account ที่เลือกเป็น account เดียวกับที่มีสิทธิ์เข้าถึง Google Drive folder
6. Deploy ใหม่ด้วย:
   - Manage deployments > Edit
   - Version: New version
   - Execute as: Me
   - Who has access: Anyone with the link
7. ใช้ URL `/exec` จาก deployment ล่าสุด
8. กลับไปทดสอบอัปโหลดในเว็บอีกครั้ง

## หลัง Deploy Apps Script

1. Copy Web App URL จากหน้า deployment
2. ใส่ใน `index.html`:
   `const GOOGLE_APPS_SCRIPT_UPLOAD_URL = "...";`
3. Commit เฉพาะ `index.html`
4. ทดสอบ upload slip ด้วยบัญชีนักเรียนจริง
5. ตรวจ `payments/{paymentId}` ว่ามี `driveViewUrl` และสถานะ `รอตรวจสลิป`

## Firestore Rules requirement

- `payments/{paymentId}` ต้องมี `studentAuthUid` ตรงกับ Firebase Auth UID ของนักเรียน
- นักเรียน update ได้เฉพาะ field สำหรับสลิป เช่น `driveViewUrl`, `slipUploadedByUid`, `slipStatus`, `paymentStatus`
- นักเรียนเปลี่ยนสถานะได้เฉพาะ `รอตรวจสลิป`
- นักเรียนไม่สามารถอนุมัติ payment เอง หรือแก้ยอดเงิน/คอร์ส/ใบเสร็จได้
- Admin/Finance ยังเป็นคน approve/reject และออกใบเสร็จเหมือนเดิม

## โครงสร้าง Folder

- `site-assets`
  - QR Code
  - Logo
  - Favicon
- `payment-slips`
  - เดือน
    - คอร์ส
      - ไฟล์สลิป เช่น `P6690001-ชื่อนักเรียน-มิถุนายน 2569-20260527-143000.jpg`

## หมายเหตุสำคัญ

- ห้ามใส่ private key หรือ service account key ใน Apps Script หรือ `index.html`
- Apps Script ใช้สิทธิ์ของ Google account ที่ deploy Web App
- Logo, QR และ Favicon จะถูกตั้งค่าเป็น anyone with link view
- สลิปจะไม่ถูกตั้ง public โดยอัตโนมัติ
- Apps Script มี quota การใช้งานรายวัน ถ้า upload จำนวนมากอาจติด quota
- ถ้า browser แจ้ง CORS หรือ permission error ให้ copy error message เต็มกลับมาตรวจ

## ทดสอบหลังตั้งค่า

1. Admin Settings > อัปโหลด Logo > บันทึกตั้งค่าระบบ
2. Admin Settings > อัปโหลด Favicon > บันทึกตั้งค่าระบบ
3. ตั้งค่า QR Code > อัปโหลด QR Code > บันทึก QR Code
4. Student Payment > เลือกเดือน > อัปโหลดสลิป
5. ตรวจ Google Drive ว่าไฟล์อยู่ใน `payment-slips / เดือน / คอร์ส`
6. ตรวจชื่อไฟล์ว่ามีรหัสและชื่อนักเรียน
7. ตรวจ Firestore `payments/{paymentId}` ต้องมี `driveViewUrl` และสถานะ `รอตรวจสลิป`
