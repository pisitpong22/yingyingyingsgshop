# ตั้งค่า Facebook feed (หลายเพจ รวมเป็นฟีดเดียว)

ดึงโพสจาก **ทุกเพจ Facebook** ที่ร้านดูแลอยู่ มาแสดงในฟีดหน้าแรกของเว็บ
การ์ดแต่ละใบจะมีป้ายบอกว่ามาจากเพจไหน และเรียงตามวันที่ปนกับเนื้อหาของร้านเอง
(พระเครื่อง เคส โปรเจกต์ รีวิว)

**โค้ดอยู่ตรงไหนบ้าง**

| ส่วน | ไฟล์ |
|---|---|
| งานซิงค์รายชั่วโมง | `functions/index.js` → `syncFacebookPosts` |
| ใครอ่านโพสได้บ้าง | `firestore.rules` → `fbPosts`, `fbSync` |
| ตัวโหลดฝั่งเว็บ | `firebase-shared.js` → `FB.loadFacebookPosts()` |
| การ์ดในฟีด | `index.html` → `buildFacebookFeedPosts()` |

งานนี้ **อ่านอย่างเดียว** ไม่โพส ไม่กดไลก์ ไม่คอมเมนต์แทนเพจใดๆ ทั้งสิ้น

รูปทุกใบถูก **คัดลอกมาเก็บใน Storage ของเราเอง** (`uploads-v2/social/facebook/…`)
เพราะ URL รูปของ Facebook CDN หมดอายุภายในไม่กี่วัน และเพราะ CSP ของเว็บอนุญาต
ให้โหลดรูปจาก `firebasestorage.googleapis.com` เท่านั้น — หน้าเว็บจึงไม่เคยโหลด
อะไรจาก facebook.com เลย

---

## 1. ออก Page access token ให้ครบทุกเพจ

ขั้นนี้ต้องทำเอง — Page token อ่านและโพสแทนเพจนั้นได้ ห้ามวางลงในแชต ในคอมมิต
หรือในไฟล์ใดๆ ใน repo นี้เด็ดขาด

**ไม่ต้องผ่าน App Review** Meta บังคับ review เฉพาะตอนแอปใช้ permission แทน*คนอื่น*
เท่านั้น token พวกนี้เป็นของคุณเองซึ่งเป็นแอดมินทั้งแอปและเพจ จึงใช้ได้เลยตอนที่แอป
ยังอยู่ใน Development mode

ข่าวดีสำหรับกรณีหลายเพจ: **ทำรอบเดียวได้ token ของทุกเพจที่คุณเป็นแอดมิน** —
ข้อ 4 จะคืนมาให้ทั้งหมดในรีสปอนส์เดียว

1. เข้า <https://developers.facebook.com/apps> → **Create app** → เลือกชนิด **Business**
   ใช้แอปเดียวคุมได้ทุกเพจ จดค่า **App ID** และ **App secret** ไว้ (Settings → Basic)
2. เปิด **Graph API Explorer**
   (<https://developers.facebook.com/tools/explorer>) เลือกแอปของคุณ แล้วกด
   **Get token → Get Page Access Token** อนุญาต `pages_show_list` กับ
   `pages_read_engagement` และ **ติ๊กเพจทุกเพจ** ที่อยากให้ขึ้นฟีด
3. token ที่ได้ตายภายในราวหนึ่งชั่วโมง ต้องแลกเป็น *user token* แบบอายุยาวก่อน —
   เอา URL นี้ไปวางในเบราว์เซอร์ แล้วเติมค่าสามตัวของคุณลงไป:

   ```
   https://graph.facebook.com/v21.0/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=SHORT_TOKEN
   ```

4. เอา user token อายุยาวไปแลกเป็น **Page token** ซึ่งไม่มีวันหมดอายุ:

   ```
   https://graph.facebook.com/v21.0/me/accounts?access_token=LONG_LIVED_USER_TOKEN
   ```

   รีสปอนส์จะลิสต์ทุกเพจที่คุณเป็นแอดมิน แต่ละเพจมี `access_token` ของตัวเอง
   **นี่คือตัวที่ต้องใช้ — เก็บมาให้ครบทุกเพจ**

5. ทดสอบทีละอันก่อนไปต่อ ถ้าถูกต้องจะได้โพสจริงของเพจนั้นกลับมา:

   ```
   https://graph.facebook.com/v21.0/me/posts?limit=1&access_token=PAGE_TOKEN
   ```

Page token จะใช้ได้เรื่อยๆ จนกว่าคุณจะเปลี่ยนรหัสผ่าน Facebook บัญชีนั้น
ถูกถอดสิทธิ์แอดมินของเพจ หรือลบแอปทิ้ง

> **มีเพจอยู่ใต้บัญชี Facebook ส่วนตัวอีกบัญชีหนึ่ง?** ให้ทำข้อ 2–4 ซ้ำโดยล็อกอิน
> ด้วยบัญชีนั้น (ใช้แอปเดิมได้) แล้วเอา token ที่ได้ไปต่อในลิสต์เดียวกันในข้อ 2 ข้างล่าง

## 2. เก็บ token ทั้งหมดไว้ใน secret เดียว

secret นี้เก็บ **token เพจละหนึ่งบรรทัด** บรรทัดว่างถูกข้าม และบรรทัดที่ขึ้นต้นด้วย
`#` คือคอมเมนต์ — ใส่ชื่อเพจกำกับไว้ด้วย จะได้อ่านออกตอนกลับมาดูอีกทีปีหน้า

เขียนลิสต์ลงไฟล์ชั่วคราว **นอก repo**:

```bash
cat > ~/fb-page-tokens.txt <<'EOF'
# Genuine Thai Buddha & Amulet Gallery
EAAG...token1...
# Yingyingying Amulet
EAAG...token2...
# Guardian House
EAAG...token3...
EOF
```

แล้วส่งเข้า Secret Manager พร้อมลบไฟล์ชั่วคราวทิ้งในคำสั่งเดียว:

```bash
firebase functions:secrets:set FB_PAGE_TOKENS < ~/fb-page-tokens.txt && rm ~/fb-page-tokens.txt
```

ต้องทำขั้นนี้ **ก่อน deploy** เพราะ `defineSecret` ถูกอ่านตอน deploy ถ้าไม่มี
`FB_PAGE_TOKENS` การ deploy functions จะล้มทั้งชุด รวมฝั่ง Stripe ด้วย

## 3. Deploy

```bash
firebase deploy --only functions:syncFacebookPosts,firestore:rules,hosting
```

การ deploy ครั้งแรกจะเปิด Cloud Scheduler API ให้เอง และสร้าง job ชื่อ
`firebase-schedule-syncFacebookPosts-asia-southeast1` (scheduled function ต้องใช้
แพลน Blaze ซึ่งโปรเจกต์นี้ใช้อยู่แล้ว)

## 4. สั่งรันเลย ไม่ต้องรอครบชั่วโมง

Google Cloud Console → **Cloud Scheduler** → เลือก job นั้น → **Force run**

แล้วเช็คผล:

- **สำเร็จไหม** — Firestore → `fbSync/status` ดู `pages[]` จะลิสต์ทุกเพจที่ซิงค์ได้
  พร้อมชื่อและจำนวน ส่วน `failures[]` บอกเพจที่ล้มเหลว · `ok` เป็น true ต่อเมื่อ
  **ทุกเพจ** สำเร็จ
- **ตัวโพส** — Firestore → `fbPosts` หนึ่งโพสหนึ่ง document แต่ละอันมี
  `pageId` / `pageName` บอกว่ามาจากเพจไหน
- **หน้าเว็บ** — ดูฟีดหน้าแรก การ์ดจะมีป้ายสีน้ำเงิน *📘 «ชื่อเพจ»* และกดแล้วเปิด
  โพสต้นทางในแท็บใหม่

ฟีดจะโหลดโพส Facebook ช้ากว่าส่วนอื่นราว 2 วินาที ตั้งใจให้เป็นแบบนั้น —
พระเครื่องกับเคสของเราเองต้องขึ้นก่อน

## เพิ่มหรือเอาเพจออกทีหลัง

secret ถูกเก็บเป็นเวอร์ชันทั้งก้อน ไม่มีคำสั่ง "เพิ่มต่อท้าย" ต้องส่งลิสต์
**ทั้งหมด** ใหม่:

1. ออก token ของเพจใหม่ (ทำข้อ 1–4 ข้างบน ข้อ 4 จะแสดงเพจใหม่มาพร้อมเพจเดิมที่มีอยู่แล้ว)
2. เขียนไฟล์ใหม่ให้มี token ครบทั้งของเก่าและของใหม่ แล้วรันคำสั่ง
   `firebase functions:secrets:set FB_PAGE_TOKENS < …` อีกครั้ง
3. `firebase deploy --only functions:syncFacebookPosts` เพื่อให้ฟังก์ชันไปหยิบ
   secret เวอร์ชันใหม่

ถ้าจะเอาเพจออก: ลบบรรทัดของเพจนั้นแล้วทำเหมือนกัน โพสของเพจนั้นจะหยุดอัปเดต
แต่ยังค้างอยู่ใน `fbPosts` จนกว่าจะไปลบ document เอง — ตรงนี้จงใจ เพราะระบบ
จะไม่แตะเพจที่ไม่ได้ถูกสั่งให้ซิงค์เลย token เสียจึงลบประวัติของเพจนั้นไม่ได้

## หลายเพจแบ่งพื้นที่ในฟีดกันยังไง

แต่ละเพจโพสถี่ไม่เท่ากันมาก ถ้าเรียงตามวันที่รวมกันแล้วหยิบตัวบนสุด เพจที่โพสถี่
ที่สุดจะยึดช่องในฟีดไปหมด ระบบจึงทำแบบนี้แทน:

- เอาเข้าฟีด **เพจละไม่เกิน 2 โพส** (`FB_FEED_PER_PAGE` ใน `index.html`)
- สลับทีละเพจ แล้วค่อยเรียงตามวันที่ปนกับเนื้อหาส่วนอื่นของฟีด
- หน้าแรกแสดงการ์ด Facebook สูงสุด **3 ใบ** จาก 9 ใบ (`LIMIT_PER_TYPE.facebook`)
  จึงได้อย่างน้อย 2 เพจที่ต่างกันเสมอ
- ฝั่งเซิร์ฟเวอร์เก็บ **เพจละ 20 โพส** (`FB_KEEP_PER_PAGE`) และส่งถึงเบราว์เซอร์
  40 โพส (`FB_POSTS_LIMIT` ใน `firebase-shared.js`)

## การใช้งานประจำวัน

- **ซ่อนโพสบางอัน** โดยไม่ลบ: ตั้งฟิลด์ `hidden` เป็น `true` ใน Firestore console
  การซิงค์รอบถัดไปจะรักษาค่านี้ไว้ตลอด
- **ลบโพสบน Facebook** แล้วมันจะหายจากเว็บภายในหนึ่งชั่วโมง ส่วนโพสที่เก่ากว่า
  15 โพสล่าสุดของเพจนั้นจะไม่ถูกลบตาม เพื่อไม่ให้ประวัติเก่าหายไป
- **การ์ดแสดงรูปเดียว** แต่ระบบก๊อปรูปมาเก็บได้สูงสุด 4 รูปต่อโพส

## เวลามีปัญหา

ดู `fbSync/status` ก่อนเสมอ — `failures[]` บอกทั้งเพจและสาเหตุ เพจหนึ่งพัง
**ไม่ทำให้เพจอื่นหยุด** และโพสที่เก็บไว้ของเพจนั้นก็ไม่ถูกแตะ

| ข้อความที่เห็น | วิธีแก้ |
|---|---|
| `…code 190…` / "Session has expired" | token ของเพจนั้นถูกเพิกถอน (เปลี่ยนรหัสผ่าน หรือถูกถอดสิทธิ์แอดมิน) ทำข้อ 1 ใหม่เฉพาะเพจนั้น แล้วตั้ง secret ใหม่ทั้งก้อน (ข้อ 2) และ deploy |
| `FB_PAGE_TOKENS is empty` | ยังไม่ได้ตั้ง secret → ข้อ 2 |
| `(#200) Requires pages_read_engagement` | token นั้นออกมาโดยไม่ได้ให้ permission ทำข้อ 2 ของขั้นตอน Graph API Explorer ใหม่ โดยติ๊กเพจนั้นด้วย |
| `duplicate token for a page already synced` | มีเพจซ้ำใน secret ลบบรรทัดที่เกินออก |
| `token did not resolve to a page` | บรรทัดนั้นเป็น *user token* ไม่ใช่ Page token — ข้ามข้อ 4 ไป |
| โพสขึ้นแต่ไม่มีรูป | ปกติสำหรับโพสที่เป็นลิงก์ล้วน ถ้ารูป*หายหมดทุกโพส* ให้ดู log หา `image … skipped` |

ดู log: `firebase functions:log --only syncFacebookPosts`
โค้ดไม่เคยเขียน access token ลง log แม้แต่บรรทัดเดียว — แก้อะไรก็ขอให้เป็นแบบนี้ต่อไป

## เวอร์ชันของ Graph API

`GRAPH_VERSION` ที่หัวส่วน Facebook ใน `functions/index.js` ตรึงไว้ที่ `v21.0`
Meta รองรับแต่ละเวอร์ชันราวสองปี ควรเช็ค
<https://developers.facebook.com/docs/graph-api/changelog> ปีละครั้งแล้วขยับเลข
เวอร์ชันที่หมดอายุจะไม่พังทันที แต่รูปร่างของรีสปอนส์อาจเปลี่ยนไปเงียบๆ ได้
