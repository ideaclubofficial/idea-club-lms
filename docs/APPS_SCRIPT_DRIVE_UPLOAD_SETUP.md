# ตั้งค่า Apps Script สำหรับอัปโหลดไฟล์ไป Google Drive

ระบบนี้ใช้ Google Apps Script Web App เป็นตัวกลางอัปโหลด QR Code, Logo, Favicon และสลิป ไปยัง Google Drive โดยไม่ต้องใช้ Firebase Cloud Functions หรือ Blaze ในขั้นนี้

## ขั้นตอนตั้งค่า

1. ไปที่ Google Apps Script แล้วสร้างโปรเจกต์ใหม่
2. คัดลอกโค้ดจาก `apps-script/drive-upload-webapp.gs` ไปวาง
3. ตรวจค่า `ROOT_FOLDER_ID` ให้เป็น:
   `1duCUjn4tKYPwZSgxJoo_83DQ34rztk7w`
4. กด Deploy > New deployment > Web app
5. ตั้งค่า:
   - Execute as: Me
   - Who has access: Anyone with the link
6. กด Deploy และอนุญาตสิทธิ์ Google Drive
7. Copy Web App URL
8. นำ URL ไปใส่ใน `index.html`:
   `GOOGLE_APPS_SCRIPT_UPLOAD_URL`
9. Commit และทดสอบอัปโหลด QR, Logo และสลิป

## โครงสร้าง Folder

- `site-assets`
  - QR Code
  - Logo
  - Favicon
- `payment-slips`
  - เดือน
    - ระดับชั้น
      - ไฟล์สลิป

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
5. ตรวจ Firestore `payments/{paymentId}` ต้องมี `driveViewUrl` และสถานะ `รอตรวจสลิป`
