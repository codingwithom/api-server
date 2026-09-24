import express from "express";
import cors from "cors";

const app = express();

const ALLOWED_ORIGINS = [
  "https://stude.is-best.net",
  "http://stude.is-best.net",
  "https://omnetwork.in",
  "http://omnetwork.in",
  "http://localhost:3000",
  "http://localhost:5173",
  "http://localhost:8080",
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    return callback(null, true);
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"],
  allowedHeaders: ["Origin", "X-Requested-With", "Content-Type", "Accept", "Authorization", "Range", "Cache-Control"],
  exposedHeaders: ["Content-Length", "Content-Range", "Accept-Ranges"]
}));

app.options("/{*path}", cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PW_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://vidcloud.eu.org/",
  "Origin": "https://vidcloud.eu.org",
  "Accept": "application/json, text/plain, */*"
};

const PW_DETAILS_ORIGIN = "https://vidcloud.eu.org";
const PW_OFFICIAL_API = "https://api.penpencil.co";
const PW_CATALOG_URL = "https://studystark.github.io/batches/batches.json";

let pwCatalogCache = { data: null, expiresAt: 0 };
let pwTokenCache = { token: "", expiresAt: 0 };
const pwMetadataCache = new Map();

async function getPwToken() {
  if (pwTokenCache.token && pwTokenCache.expiresAt > Date.now()) return pwTokenCache.token;
  try {
    const res = await fetch(`${PW_DETAILS_ORIGIN}/generate_token.php`, { headers: PW_HEADERS });
    if (res.ok) {
      const payload = await res.json();
      const token = payload.access_token || payload.token || "";
      if (token) {
        pwTokenCache = { token, expiresAt: Date.now() + 3600 * 1000 };
        return token;
      }
    }
  } catch (err) {
    console.error("Token error:", err.message);
  }
  return "";
}

function extractPdfUrl(att) {
  if (!att || typeof att !== "object") return undefined;
  if (typeof att.key === "string" && att.key.trim().length > 0) {
    const key = att.key.trim();
    if (/^https?:\/\//i.test(key)) return key;
    const baseUrl = att.baseUrl ? att.baseUrl.trim() : "https://static.pw.live/";
    return baseUrl.endsWith("/") ? `${baseUrl}${key}` : `${baseUrl}/${key}`;
  }
  if (typeof att.url === "string" && /^https?:\/\//i.test(att.url.trim())) return att.url.trim();
  if (typeof att.fileUrl === "string" && /^https?:\/\//i.test(att.fileUrl.trim())) return att.fileUrl.trim();
  return undefined;
}

// ── Endpoints ────────────────────────────────────────────────────────────────
app.get(["/", "/api/pw-status", "/api/healthz"], (_req, res) => {
  res.json({
    status: "ok",
    service: "Physics Wallah & JEE Prep Node.js API Server",
    timestamp: Date.now()
  });
});

app.get("/api/pw-catalog", async (_req, res) => {
  if (pwCatalogCache.data && pwCatalogCache.expiresAt > Date.now()) {
    return res.json(pwCatalogCache.data);
  }
  try {
    const response = await fetch(PW_CATALOG_URL, {
      headers: { "User-Agent": PW_HEADERS["User-Agent"], Accept: "application/json" }
    });
    if (!response.ok) throw new Error(`Catalog failed: ${response.status}`);
    const data = await response.json();
    pwCatalogCache = { data, expiresAt: Date.now() + 30 * 60 * 1000 };
    res.json(data);
  } catch (err) {
    if (pwCatalogCache.data) return res.json(pwCatalogCache.data);
    res.status(502).json({ error: err.message || "PW Catalog unavailable" });
  }
});

app.get("/api/pw-metadata", async (req, res) => {
  const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
  if (!batchId) return res.status(400).json({ error: "batchId is required" });

  if (pwMetadataCache.has(batchId)) {
    const cached = pwMetadataCache.get(batchId);
    if (cached.expiresAt > Date.now()) return res.json(cached.value);
  }

  try {
    let detailsPayload = null;
    for (const host of [PW_DETAILS_ORIGIN, PW_OFFICIAL_API]) {
      try {
        const r = await fetch(`${host}/api/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`, {
          headers: PW_HEADERS
        });
        if (r.ok) {
          detailsPayload = await r.json();
          if (detailsPayload && (detailsPayload.data || detailsPayload.subjects)) break;
        }
      } catch (e) {}
    }

    if (!detailsPayload) {
      return res.status(502).json({ error: "PW batch details unavailable from official API" });
    }

    const data = detailsPayload.data || detailsPayload;
    const rawSubjects = Array.isArray(data.subjects) ? data.subjects : [];
    const remoteSubjects = rawSubjects.filter(s => {
      const sName = typeof s.subject === "string" ? s.subject : "";
      return !/^(notices?|announcements?|test\s+series|demo)/i.test(sName.trim());
    });

    const token = await getPwToken();

    const subjects = await Promise.all(
      remoteSubjects.map(async (remoteSubject) => {
        const name = remoteSubject.subject || "Subject";
        const teacherList = Array.isArray(remoteSubject.teacherIds) ? remoteSubject.teacherIds : [];
        const teachers = teacherList.map(t => ({
          _id: t?._id || "",
          name: [t?.firstName, t?.lastName].filter(Boolean).join(" ") || "Faculty",
          qualification: t?.qualification || "",
          experience: t?.experience ? `${t.experience} Years` : "",
          imageUrl: t?.imageId ? (t.imageId.baseUrl ? `${t.imageId.baseUrl}${t.imageId.key}` : `https://static.pw.live/${t.imageId.key}`) : ""
        }));

        const chapters = [];
        const subjectId = remoteSubject._id || remoteSubject.subjectId;

        if (subjectId && token) {
          try {
            const [p1Res, p2Res] = await Promise.all([
              fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/topics?page=1`, {
                headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
              }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
              fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/topics?page=2`, {
                headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
              }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] }))
            ]);

            const rawTopics = [...(p1Res.data || []), ...(p2Res.data || [])];
            const validTopics = rawTopics.filter(t => typeof t.name === "string" && !/(only\s+pdf|only\s+video|demo|notice|announcement)/i.test(t.name));

            validTopics.forEach((t, idx) => {
              const isStarted = Boolean((t.videos || 0) > 0 || (t.notes || 0) > 0 || (t.exercises || 0) > 0);
              chapters.push({
                id: t._id || `${subjectId}-ch-${idx + 1}`,
                rawId: t._id,
                title: t.name.trim(),
                videoCount: t.videos || t.lectureVideos || 0,
                notesCount: t.notes || 0,
                dppCount: t.exercises || 0,
                isStarted,
                lectures: []
              });
            });
          } catch (e) {}
        }

        const syllabusPdf = remoteSubject.fileId?.key
          ? (remoteSubject.fileId.baseUrl ? `${remoteSubject.fileId.baseUrl}${remoteSubject.fileId.key}` : `https://static.pw.live/${remoteSubject.fileId.key}`)
          : undefined;

        return {
          id: remoteSubject._id || "",
          subjectId: remoteSubject.subjectId || "",
          name,
          faculty: teachers.map(t => t.name).filter(Boolean).join(" & ") || undefined,
          teachers,
          lectureCount: chapters.reduce((acc, c) => acc + (c.videoCount || 0), 0) || remoteSubject.lectureCount || 0,
          tagCount: chapters.length || remoteSubject.tagCount || 0,
          syllabusPdf,
          schedules: remoteSubject.batchDescriptionSchedules || [],
          chapters
        };
      })
    );

    const batchPdf = data.batchPdfUrl || (data.fileId ? `https://static.pw.live/${data.fileId.key}` : undefined);
    const previewImage = data.previewImage || (data.imageId ? `https://static.pw.live/${data.imageId.key}` : undefined);

    const value = {
      batchId,
      name: data.name || data.batchName || "Physics Wallah Batch",
      class: data.class || "",
      exam: Array.isArray(data.exam) ? data.exam.join(", ") : (data.exam || ""),
      byName: data.byName || "",
      description: data.description || "",
      previewImage,
      batchPdf,
      subjects
    };

    pwMetadataCache.set(batchId, { value, expiresAt: Date.now() + 60 * 60 * 1000 });
    res.json(value);
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to load batch metadata" });
  }
});

app.get("/api/pw-chapter-contents", async (req, res) => {
  const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
  const subjectId = typeof req.query.subjectId === "string" ? req.query.subjectId : "";
  const chapterId = typeof req.query.chapterId === "string" ? req.query.chapterId : "";

  if (!batchId || !subjectId || !chapterId) {
    return res.status(400).json({ error: "batchId, subjectId, and chapterId are required" });
  }

  try {
    const token = await getPwToken();
    const [vRes, nRes, dRes] = await Promise.all([
      fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=videos&tag=${encodeURIComponent(chapterId)}`, {
        headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
      }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
      fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=notes&tag=${encodeURIComponent(chapterId)}`, {
        headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
      }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
      fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=DppNotes&tag=${encodeURIComponent(chapterId)}`, {
        headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
      }).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] }))
    ]);

    const rawVideos = Array.isArray(vRes.data) ? vRes.data : [];
    const rawNotes = Array.isArray(nRes.data) ? nRes.data : [];
    const rawDpps = Array.isArray(dRes.data) ? dRes.data : [];

    const notes = rawNotes.map(item => ({
      id: `${subjectId}-${item._id}`,
      title: (item.topic || "").trim(),
      attachmentName: item.attachmentIds?.[0]?.name,
      pdfUrl: extractPdfUrl(item.attachmentIds?.[0]),
      notesUrl: extractPdfUrl(item.attachmentIds?.[0]),
      date: item.date || item.startTime
    }));

    const dpps = rawDpps.map(item => ({
      id: `${subjectId}-${item._id}-dpp`,
      title: (item.topic || "").trim(),
      type: "dpp",
      attachmentName: item.attachmentIds?.[0]?.name,
      pdfUrl: extractPdfUrl(item.attachmentIds?.[0]),
      dppPdfUrl: extractPdfUrl(item.attachmentIds?.[0]),
      date: item.date || item.startTime
    }));

    const lectures = rawVideos.map(v => {
      const isDpp = v.isDPPVideos === true || /\bdpp\b/i.test(v.topic);
      return {
        id: `${subjectId}-${v._id}`,
        rawContentId: v._id,
        title: (v.topic || "").trim(),
        type: isDpp ? "dpp" : "lecture",
        duration: v.videoDetails?.duration,
        date: v.date || v.startTime
      };
    });

    res.json({
      chapterId,
      lectures: [...lectures, ...dpps],
      videosOnly: lectures,
      notes,
      dpps,
      totalLectures: lectures.length,
      totalDpps: dpps.length,
      totalNotes: notes.length
    });
  } catch (err) {
    res.status(500).json({ chapterId, lectures: [], videosOnly: [], notes: [], dpps: [] });
  }
});

app.get("/api/pw-schedule", async (req, res) => {
  const batchId = typeof req.query.batchId === "string" ? req.query.batchId : "";
  const date = typeof req.query.date === "string" ? req.query.date : new Date().toISOString().split("T")[0];

  try {
    const token = await getPwToken();
    let rawItems = [];

    if (token) {
      const wsRes = await fetch(`${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/weekly-schedules?batchId=${encodeURIComponent(batchId)}&startDate=${encodeURIComponent(date)}&endDate=${encodeURIComponent(date)}&page=1`, {
        headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }
      });
      if (wsRes.ok) {
        const payload = await wsRes.json();
        if (Array.isArray(payload.data)) rawItems = payload.data;
      }
    }

    const schedules = rawItems.map((item, idx) => {
      const details = item.videoDetails || item.notesDetails || item;
      return {
        id: String(item._id || details._id || `${batchId}-${date}-${idx}`),
        type: "LECTURE",
        subject: details.subjectId?.name || item.subject || "Subject",
        teacher: details.teachers?.[0]?.name || "PW Faculty",
        topic: details.topic || item.topic || "Live Class",
        date,
        startTime: details.startTime || item.startTime,
        endTime: details.endTime || item.endTime,
        status: details.status || item.status || "Scheduled",
        isLive: (details.status || item.status) === "LIVE",
        isEnded: (details.status || item.status) === "COMPLETED",
      };
    });

    res.json({
      batchId,
      date,
      allEnded: schedules.length > 0 && schedules.every(s => s.isEnded),
      schedules
    });
  } catch (err) {
    res.status(500).json({ batchId, date, schedules: [] });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`API Server running cleanly on port ${PORT}`);
});
