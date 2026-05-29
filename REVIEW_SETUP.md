# ตั้งค่า Firebase สำหรับฟีเจอร์ "ลูกค้าเขียนรีวิว"

ลูกค้าส่งรีวิวจากหน้าร้าน → เก็บใน collection `reviewSubmissions` (แยกจากข้อมูลร้าน)
→ แอดมินอนุมัติ/ปฏิเสธในหน้า Reviews ของ admin

ต้องตั้งค่า 2 อย่างบน Firebase Console ก่อนฟีเจอร์จะทำงาน

---

## 1) Firestore Security Rules

ไปที่ Firebase Console → **Firestore Database** → แท็บ **Rules** แล้ววางกฎด้านล่าง
(ปรับให้เข้ากับกฎเดิมที่มีอยู่ — เพิ่มเฉพาะส่วน `reviewSubmissions` และ `admins` ถ้ายังไม่มี)

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── ข้อมูลร้านทั้งหมด: อ่านได้ทุกคน เขียนได้เฉพาะแอดมินที่ login ──
    match /app/db {
      allow read: if true;
      allow write: if request.auth != null
                   && exists(/databases/$(database)/documents/admins/$(request.auth.token.email.lower()));
    }

    // ── รายชื่อแอดมิน: อ่านได้เฉพาะคนที่ login, เขียนเฉพาะ super_admin ──
    match /admins/{email} {
      allow read: if request.auth != null;
      allow write: if request.auth != null
                   && get(/databases/$(database)/documents/admins/$(request.auth.token.email.lower())).data.role == 'super_admin';
    }

    // ── รีวิวจากลูกค้า: ใครก็ "ส่งเข้า" ได้ (create) แต่ "อ่าน/ลบ" เฉพาะแอดมิน ──
    match /reviewSubmissions/{id} {
      // ลูกค้าทั่วไป (ไม่ได้ login) สร้างได้ — แต่ต้องผ่านการตรวจรูปแบบข้อมูล
      allow create: if
           request.resource.data.keys().hasOnly(['name','anonymous','rating','text','imgs','createdAt'])
        && request.resource.data.rating is int
        && request.resource.data.rating >= 0
        && request.resource.data.rating <= 5
        && request.resource.data.text.size() <= 2000
        && request.resource.data.name.size() <= 80
        && request.resource.data.imgs.size() <= 6;
      // อ่าน/แก้/ลบ — เฉพาะแอดมินที่ login
      allow read, update, delete: if request.auth != null
                   && exists(/databases/$(database)/documents/admins/$(request.auth.token.email.lower()));
    }
  }
}
```

> **สำคัญ:** ถ้ากฎเดิมของ `app/db` กับ `admins` ต่างจากนี้ ให้คงของเดิมไว้ แล้วเพิ่มเฉพาะบล็อก `match /reviewSubmissions/{id}` เข้าไป ส่วน `app/db` และ `admins` ที่เขียนไว้นี้เป็นแค่ตัวอย่างให้กฎสมบูรณ์

กด **Publish**

---

## 2) Storage Security Rules

ลูกค้าต้องอัปรูปพระเครื่องได้ ไปที่ Firebase Console → **Storage** → แท็บ **Rules** วางกฎ:

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /uploads/{file} {
      // อ่านได้ทุกคน (รูปต้องโชว์บนเว็บ)
      allow read: if true;
      // อัปได้ทุกคน แต่จำกัดเฉพาะไฟล์รูป และไม่เกิน 10MB ต่อไฟล์
      allow write: if request.resource.size < 10 * 1024 * 1024
                   && request.resource.contentType.matches('image/.*');
    }
  }
}
```

กด **Publish**

> ถ้าไม่อยากให้ลูกค้าอัปรูปลง path เดียวกับรูปร้าน สามารถเปลี่ยนให้รูปรีวิวไปที่ path แยกได้
> (แจ้งมาได้ เดี๋ยวปรับโค้ดให้อัปไป `review-uploads/` แทน แล้วตั้ง rules เฉพาะ path นั้น)

---

## 3) Firebase App Check (กันบอท/สคริปต์ — ปลอดภัยที่สุด)

App Check ตรวจว่าทุก request มาจากเว็บจริงของคุณเท่านั้น บอทหรือสคริปต์ที่ยิง API ตรงๆ จะถูกบล็อก
ใช้ reCAPTCHA v3 ทำงานเบื้องหลัง ลูกค้าไม่ต้องกดอะไร (ไม่มีปริศนาให้ทำ)

### ขั้นตอน (ทำตามลำดับ — สำคัญมาก)

**A. ลงทะเบียนและเอา Site Key**
1. Firebase Console → **App Check** (เมนูซ้าย ใต้ Build)
2. แท็บ **Apps** → เลือกเว็บแอปของคุณ → **Register**
3. เลือก provider เป็น **reCAPTCHA v3**
4. ถ้ายังไม่มี reCAPTCHA key มันจะลิงก์ไปสร้างที่ Google reCAPTCHA — สร้างแบบ **v3**
   และใส่โดเมนของเว็บ (เช่น `yingyingyingsgshop.web.app`, `yingyingyingsgshop.firebaseapp.com`
   และโดเมนจริงถ้ามี)
5. ก็อป **Site Key** ที่ได้

**B. ใส่ Key ในโค้ด**
1. เปิดไฟล์ `firebase-shared.js`
2. หาบรรทัด `const APP_CHECK_SITE_KEY = '';`
3. วาง site key ลงไป เช่น `const APP_CHECK_SITE_KEY = '6Lxxxxxxxxxxxxxxxxxxx';`
4. Deploy เว็บ (push + Firebase Hosting deploy ตามปกติ)
5. เปิดเว็บ ลองใช้งานดูว่ายังปกติดี (ดู console ต้องขึ้น `[FB] App Check enabled`)

**C. เปิด Enforcement** (ทำหลังเทสต์ว่าเว็บยังทำงานปกติแล้วเท่านั้น)
1. Firebase Console → App Check → แท็บ **APIs**
2. กด **Enforce** สำหรับ **Cloud Firestore**
3. กด **Enforce** สำหรับ **Cloud Storage**

> ⚠️ **ลำดับสำคัญ:** อย่ากด Enforce ก่อนใส่ key + deploy + เทสต์ ไม่งั้นเว็บจะใช้งานไม่ได้ทั้งหมด
> (ทุก request จะโดนบล็อก) ทำตามลำดับ A → B → C เท่านั้น

> **ถ้ายังไม่ใส่ key:** โค้ดถูกเขียนให้ App Check ปิดอยู่โดยอัตโนมัติ (เว็บทำงานปกติ ไม่พัง)
> จะเริ่มป้องกันก็ต่อเมื่อใส่ key **และ** กด Enforce แล้วเท่านั้น

> **เทสต์บนเครื่อง (localhost):** ถ้าเปิด Enforce แล้วเทสต์ในเครื่องไม่ได้ ให้ดู comment
> `FIREBASE_APPCHECK_DEBUG_TOKEN` ในไฟล์ `firebase-shared.js` — เปิดใช้ debug token ได้

---

## ข้อควรรู้เรื่องสแปม

- ทุกรีวิวจะ **ไม่ขึ้นเว็บทันที** — ต้องผ่านการอนุมัติจากแอดมินก่อนเสมอ จึงกัน spam ไม่ให้โผล่หน้าเว็บได้
- แต่ใครก็ "ส่ง" เข้ามาได้ ถ้าเริ่มมี junk เยอะใน `reviewSubmissions` แจ้งได้ เดี๋ยวเสริมการป้องกัน
  (เช่น reCAPTCHA, จำกัดจำนวนส่งต่อ IP, honeypot)
- รูปที่ลูกค้าอัป จะถูกเก็บบน Storage ทันทีแม้รีวิวจะถูกปฏิเสธ — ถ้าปฏิเสธบ่อยอาจมีรูปค้าง
  แจ้งได้ถ้าอยากให้ลบรูปอัตโนมัติตอนกดปฏิเสธ
