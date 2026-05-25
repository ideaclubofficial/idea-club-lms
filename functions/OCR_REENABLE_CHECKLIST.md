# Payment OCR Re-enable Checklist

ใช้ checklist นี้เมื่อ IDEA CLUB ต้องการเปิดระบบอัปโหลดสลิปผ่านเว็บ + Google Drive + OCR อีกครั้ง

## ก่อนเปิดใช้งาน

- อนุมัติงบ/ยอมรับค่าใช้จ่าย API และ Cloud Functions แล้ว
- เปิด Firebase Blaze Plan แล้ว
- เปิด Google Drive API แล้ว
- เปิด Cloud Vision API แล้ว
- ตรวจว่า `functions/service-account-drive.json` มีอยู่เฉพาะในเครื่อง local/deploy และห้าม commit
- Share Google Drive folder ให้ service account email เป็น Editor แล้ว
- ตั้งค่า `DRIVE_FOLDER_ID` จริงสำหรับ deploy

## เปิด feature

- เปลี่ยน `ENABLE_PAYMENT_SLIP_OCR = true` ใน `index.html`
- ห้ามเปิด flag เป็น `true` ถ้ายังไม่ได้ deploy function และยังไม่ได้อนุมัติงบ

## Deploy เฉพาะ function

```sh
DRIVE_FOLDER_ID="..." firebase deploy --only functions:uploadPaymentSlipToDriveAndOcr
```

ห้ามใช้ `firebase deploy` หรือ `firebase deploy --only functions` ถ้าต้องการ deploy เฉพาะ OCR function

## ทดสอบก่อนเปิดใช้จริง

- สร้าง payment test 1 รายการที่มี `studentAuthUid` หรือ `memberId`/`studentId` ตรงกับ user
- Login ด้วย student user จริง
- เลือกเดือนที่มี payment record
- Upload รูปสลิป
- ตรวจ `payments/{paymentId}` ว่ามี `driveViewUrl`, `driveFileId`, `ocrStatus`, `ocrRawText`, `ocrAmount`, `ocrReferenceNo`, `ocrCheckStatus`, `ocrCheckNote`
- ตรวจ `activityLogs` ว่ามี `payment_slip_ocr_success` หรือ `payment_slip_ocr_failed`
- ตรวจหน้า Admin ว่าเห็นปุ่มเปิดสลิป/ดู OCR และข้อมูล OCR detail

## หลังทดสอบผ่าน

- แจ้งทีม Admin/Finance ว่า OCR เป็นตัวช่วยตรวจเบื้องต้น ไม่ใช่การอนุมัติอัตโนมัติ
- คง LINE slip flow ไว้เป็น fallback
- ค่อยเปิดให้ใช้งานกับนักเรียนจริง
