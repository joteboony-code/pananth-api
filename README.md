# Pananth Rental Backend Worker v15.4.2.36

ชุดนี้สำหรับอัปโหลดขึ้น GitHub เพื่อ Deploy เฉพาะ Worker หลังบ้านเท่านั้น

ไม่รวมไฟล์หน้าเว็บ:

- `index.html`
- PWA icon
- `manifest.json`

หน้าเว็บยังให้อัปโหลดแยกที่ Worker/Page `pananth` เหมือนเดิม

## ไฟล์สำคัญ

```text
worker.js                         = Worker หลังบ้าน v15.4.2.36
wrangler.toml                     = config deploy Cloudflare Worker
.github/workflows/deploy-worker.yml = GitHub Actions deploy อัตโนมัติ
package.json                      = script ตรวจ syntax / deploy
```

## ก่อน Deploy ต้องแก้ `wrangler.toml`

เปิดไฟล์ `wrangler.toml` แล้วแก้ 2 จุดนี้ให้เป็นค่าจริงจาก Cloudflare เดิม:

```toml
[[kv_namespaces]]
binding = "DB"
id = "PUT_YOUR_EXISTING_KV_NAMESPACE_ID_HERE"

[[r2_buckets]]
binding = "RENTAL_R2"
bucket_name = "PUT_YOUR_EXISTING_R2_BUCKET_NAME_HERE"
```

สำคัญมาก: ต้องใช้ KV namespace เดิมของระบบจริง ถ้าใส่ผิด ข้อมูลห้องเช่าจะไม่เจอ

## Secrets ที่ต้องตั้งใน Cloudflare Worker เดิม

ห้ามใส่ค่าเหล่านี้ลง GitHub repo:

```text
LINE_TOKEN
LINE_CHANNEL_SECRET
EASYSLIP_API_KEY
OWNER_ID
ADMIN_UNLOCK_KEY
```

ถ้าปัจจุบัน Worker `white-rice-cf72` ใช้งานได้อยู่แล้ว ค่าเหล่านี้น่าจะตั้งไว้แล้ว

## Secrets ที่ต้องตั้งใน GitHub repo

ไปที่ GitHub repo > Settings > Secrets and variables > Actions > New repository secret

เพิ่ม 2 ค่า:

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_API_TOKEN
```

Cloudflare แนะนำให้ใช้ API Token สำหรับ CI/CD และเก็บไว้ใน GitHub Secrets ไม่ควรเก็บ token ลง repository

## Deploy

เมื่อ push เข้า branch `main` แล้ว GitHub Actions จะ deploy อัตโนมัติ

หรือกดเองได้ที่:

```text
GitHub repo > Actions > Deploy Pananth backend Worker > Run workflow
```

## ตรวจหลัง Deploy

ทดสอบว่า Worker หลังบ้านยังตอบปกติ:

```text
https://white-rice-cf72.joteboony.workers.dev/
```

ถ้าภายหลังเปลี่ยนชื่อ Worker เป็น `pananth-api` ต้องแก้ `name` ใน `wrangler.toml`, แก้ API URL ใน `index.html`, และแก้ LINE Webhook URL ตามไปด้วย
