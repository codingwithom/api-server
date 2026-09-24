/**
 * Cloudflare Worker for StudE & OM Network (PW & JEE API Engine)
 * 100% Free • Edge Performance • Zero Cold Starts • Zero Downtime
 */

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};

const PW_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://vidcloud.eu.org/",
  "Origin": "https://vidcloud.eu.org",
  "Accept": "application/json, text/plain, */*",
};

const PW_DETAILS_ORIGIN = "https://vidcloud.eu.org";
const PW_OFFICIAL_API = "https://api.penpencil.co";
const PW_CATALOG_URL = "https://studystark.github.io/batches/batches.json";

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// ── Token Generator ──────────────────────────────────────────────────────────
async function getPwToken() {
  try {
    const res = await fetch(`${PW_DETAILS_ORIGIN}/generate_token.php`, {
      headers: {
        "User-Agent": PW_HEADERS["User-Agent"],
        "Accept": "application/json, text/plain, */*",
      },
    });
    if (res.ok) {
      const payload = await res.json();
      return payload.access_token || payload.token || "";
    }
  } catch (err) {
    console.error("Token fetch failed:", err);
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

// ── Main Request Handler ─────────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle Preflight OPTIONS
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. Health Status & Ping
    if (pathname === "/" || pathname === "/api/pw-status" || pathname === "/api/healthz") {
      return jsonResponse({
        status: "ok",
        platform: "Cloudflare Worker Edge",
        service: "Physics Wallah & JEE Prep Live API Engine",
        uptime: "100%",
        timestamp: Date.now(),
      });
    }

    // Diagnostic endpoint to check upstream API reachability
    if (pathname === "/api/pw-debug") {
      const results = {};
      try {
        const pRes = await fetch(`${PW_OFFICIAL_API}/v3/batches/698ad3519549b300a5e1cc6a/details?type=EXPLORE_LEAD`, {
          headers: { "User-Agent": PW_HEADERS["User-Agent"], "client-type": "WEB" },
        });
        results.penpencil_v3 = { status: pRes.status, ok: pRes.ok };
      } catch (e) {
        results.penpencil_v3 = { error: e.message };
      }

      try {
        const vRes = await fetch(`${PW_DETAILS_ORIGIN}/generate_token.php`, {
          headers: { "User-Agent": PW_HEADERS["User-Agent"] },
        });
        results.vidcloud_token = { status: vRes.status, ok: vRes.ok };
      } catch (e) {
        results.vidcloud_token = { error: e.message };
      }

      return jsonResponse({
        timestamp: new Date().toISOString(),
        worker_edge: "active",
        upstreams: results,
      });
    }

    // 2. PW Batch Catalog
    if (pathname === "/api/pw-catalog") {
      try {
        const catRes = await fetch(PW_CATALOG_URL, {
          headers: { "User-Agent": PW_HEADERS["User-Agent"], Accept: "application/json" },
        });
        if (!catRes.ok) throw new Error(`Catalog returned ${catRes.status}`);
        const data = await catRes.json();
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=1800" });
      } catch (err) {
        return jsonResponse({ error: err.message || "PW Catalog unavailable" }, 502);
      }
    }

    // 3. Batch Metadata & Teacher-wise Chapters
    if (pathname === "/api/pw-metadata") {
      const batchId = url.searchParams.get("batchId") || "";
      if (!batchId) return jsonResponse({ error: "batchId is required" }, 400);

      try {
        let detailsPayload = null;
        const candidateErrors = [];

        const candidates = [
          // 1. Official PW PenPencil API (Fast & direct on AWS CloudFront - no Cloudflare Bot WAF)
          {
            name: "penpencil-v3",
            url: `${PW_OFFICIAL_API}/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
            headers: {
              "User-Agent": PW_HEADERS["User-Agent"],
              "Accept": "application/json, text/plain, */*",
              "client-type": "WEB",
            },
          },
          // 2. Vidcloud Explore Lead Proxy
          {
            name: "vidcloud-v3",
            url: `${PW_DETAILS_ORIGIN}/api/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
            headers: PW_HEADERS,
          },
          // 3. Alternative Penpencil path
          {
            name: "penpencil-api-v3",
            url: `${PW_OFFICIAL_API}/api/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
            headers: {
              "User-Agent": PW_HEADERS["User-Agent"],
              "Accept": "application/json, text/plain, */*",
              "client-type": "WEB",
            },
          },
        ];

        for (const candidate of candidates) {
          try {
            const res = await fetch(candidate.url, { headers: candidate.headers });
            if (res.ok) {
              const payload = await res.json();
              if (payload && (payload.data || payload.subjects)) {
                detailsPayload = payload;
                break;
              } else {
                candidateErrors.push(`${candidate.name}: empty payload`);
              }
            } else {
              candidateErrors.push(`${candidate.name} status ${res.status}`);
            }
          } catch (e) {
            candidateErrors.push(`${candidate.name}: ${e.message}`);
          }
        }

        if (!detailsPayload) {
          return jsonResponse({
            error: "Batch details unavailable from PW API",
            details: candidateErrors.join(", ")
          }, 502);
        }

        const data = detailsPayload.data || detailsPayload;
        const rawSubjects = Array.isArray(data.subjects) ? data.subjects : [];
        const remoteSubjects = rawSubjects.filter(s => {
          const sName = typeof s.subject === "string" ? s.subject : "";
          return !/^(notices?|announcements?|test\s+series|demo)/i.test(sName.trim());
        });

        const token = await getPwToken();

        // Fetch subjects & chapters in parallel
        const subjects = await Promise.all(
          remoteSubjects.map(async (remoteSubject) => {
            const name = remoteSubject.subject || "Subject";
            const teacherList = Array.isArray(remoteSubject.teacherIds) ? remoteSubject.teacherIds : [];
            const teachers = teacherList.map(t => ({
              _id: t?._id || "",
              name: [t?.firstName, t?.lastName].filter(Boolean).join(" ") || "Faculty",
              qualification: t?.qualification || "",
              experience: t?.experience ? `${t.experience} Years` : "",
              imageUrl: t?.imageId ? (t.imageId.baseUrl ? `${t.imageId.baseUrl}${t.imageId.key}` : `https://static.pw.live/${t.imageId.key}`) : "",
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

        return jsonResponse({
          batchId,
          name: data.name || data.batchName || "Physics Wallah Batch",
          class: data.class || "",
          exam: Array.isArray(data.exam) ? data.exam.join(", ") : (data.exam || ""),
          byName: data.byName || "",
          description: data.description || "",
          previewImage,
          batchPdf,
          subjects
        }, 200, { "Cache-Control": "public, max-age=3600" });
      } catch (err) {
        return jsonResponse({ error: err.message || "Failed to load batch metadata" }, 500);
      }
    }

    // 4. Chapter Contents (Lectures, Notes, DPPs)
    if (pathname === "/api/pw-chapter-contents") {
      const batchId = url.searchParams.get("batchId") || "";
      const subjectId = url.searchParams.get("subjectId") || "";
      const chapterId = url.searchParams.get("chapterId") || "";

      if (!batchId || !subjectId || !chapterId) {
        return jsonResponse({ error: "batchId, subjectId, and chapterId are required" }, 400);
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

        return jsonResponse({
          chapterId,
          lectures: [...lectures, ...dpps],
          videosOnly: lectures,
          notes,
          dpps,
          totalLectures: lectures.length,
          totalDpps: dpps.length,
          totalNotes: notes.length
        }, 200, { "Cache-Control": "public, max-age=1800" });
      } catch (err) {
        return jsonResponse({ chapterId, lectures: [], videosOnly: [], notes: [], dpps: [] });
      }
    }

    // 5. Weekly Schedule
    if (pathname === "/api/pw-schedule") {
      const batchId = url.searchParams.get("batchId") || "";
      const date = url.searchParams.get("date") || new Date().toISOString().split("T")[0];

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

        return jsonResponse({
          batchId,
          date,
          allEnded: schedules.length > 0 && schedules.every(s => s.isEnded),
          schedules
        }, 200, { "Cache-Control": "public, max-age=600" });
      } catch (err) {
        return jsonResponse({ batchId, date, schedules: [] });
      }
    }

    return jsonResponse({ error: "Endpoint not found", path: pathname }, 404);
  }
};
