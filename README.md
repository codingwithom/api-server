# StudE & OM Network API Server

Edge-ready backend API service for **Physics Wallah Live Integration**, batch syllabi, verified DPP/Notes PDF resolution, and daily timetable tracking.

Designed to run seamlessly as a **Cloudflare Worker** (100% free, 0ms cold starts, zero downtime) and as a **Node.js Express** server.

---

## 🚀 Deployment Options

### Option 1: Deploy with Cloudflare Workers (Recommended)
1. In Cloudflare Dashboard, go to **Workers & Pages > Create Application**.
2. Select **Pages** or **Workers**, connect your GitHub account, and select this repository: `codingwithom/api-server`.
3. Set Build command to empty (or `npm run deploy`), Root directory to `/`.
4. Click **Deploy**.
5. Your worker will be live with a URL like `https://api-server.<subdomain>.workers.dev`.

### Option 2: Run with Wrangler CLI
```bash
npm install
npx wrangler deploy
```

### Option 3: Run with Node.js
```bash
npm install
npm start
# Server listens on port 8080 (or process.env.PORT)
```

---

## 📡 API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/pw-status` | GET | Health status check and uptime confirmation |
| `/api/pw-catalog` | GET | Batch search catalog (thousands of public batches) |
| `/api/pw-metadata?batchId=...` | GET | Full batch curriculum, teachers, chapters & syllabi |
| `/api/pw-chapter-contents?batchId=...&subjectId=...&chapterId=...` | GET | Verified video lectures, class notes PDFs & DPP sheets |
| `/api/pw-schedule?batchId=...&date=YYYY-MM-DD` | GET | Daily class schedule & live status for the batch |

---

## 🔒 CORS Support
All endpoints include `Access-Control-Allow-Origin: *` and support credentials and preflight OPTIONS requests, allowing requests from `https://omnetwork.in`, `https://stude.is-best.net`, and localhost.
