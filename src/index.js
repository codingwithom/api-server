/**
 * Cloudflare Worker for StudE & OM Network (PW, JEE, YouTube & AI Engine)
 * Complete edge implementation with 100% parity with server.js:
 * - Physics Wallah API (Catalog, Metadata, Chapters, Teacher profiles, Syllabus & Full Schedules)
 * - YouTube Search & Playlist Scraper (Native HTML parsing, zero binary dependencies)
 * - AI Web Scraper & YouTube Transcript Engine (Invidious, youtube-transcript.ai, JSON-LD)
 * - DuckDuckGo Web Search with OpenGraph Thumbnails
 * - Universal CORS Proxy & Media Streaming
 */

// ─── CORS HEADERS ─────────────────────────────────────────────────────────────
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS, HEAD",
  "Access-Control-Allow-Headers": "Origin, X-Requested-With, Content-Type, Accept, Authorization, Range, Cache-Control",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
  "Access-Control-Max-Age": "86400",
};

// ─── CONSTANTS & CONFIGURATION ────────────────────────────────────────────────
const PW_DETAILS_ORIGIN = "https://vidcloud.eu.org";
const PW_OFFICIAL_API = "https://api.penpencil.co";
const PW_CATALOG_URL = "https://studystark.github.io/batches/batches.json";

const PW_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Referer": "https://vidcloud.eu.org/",
  "Origin": "https://vidcloud.eu.org",
  "Accept": "application/json, text/plain, */*",
};

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
};

// In-memory Edge Caches (per worker instance)
const pwMetadataCache = new Map();
const pwScheduleCache = new Map();
const pwChapterCache = new Map();
let pwCatalogCache = { data: null, expiresAt: 0 };
let pwTokenMemoryCache = { token: "", expiresAt: 0 };

const PW_METADATA_TTL = 60 * 60 * 1000; // 1 hour
const PW_CATALOG_TTL = 30 * 60 * 1000;  // 30 min
const PW_CHAPTER_TTL = 30 * 60 * 1000;  // 30 min
const PW_SCHEDULE_TTL = 15 * 60 * 1000; // 15 min

// ─── RESPONSE HELPERS ─────────────────────────────────────────────────────────
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

function textResponse(text, status = 200, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": contentType,
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// ─── STRING & HTML UTILITIES ──────────────────────────────────────────────────
function decodeHTMLEntities(str) {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(dec));
}

function cleanHtmlToText(html) {
  if (!html) return "";
  let text = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
    .replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");

  text = text
    .replace(/<(?:p|div|br|h[1-6]|li|tr|blockquote)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  text = decodeHTMLEntities(text);
  return text.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
}

function cleanTitle(t) {
  if (!t) return "";
  return decodeHTMLEntities(t)
    .replace(/\[\s*\d+\s*\]/g, "")
    .replace(/\(\s*\d+\s*\)/g, "")
    .trim();
}

function timeAgo(dateString) {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 60) return `${diffMins} minutes ago`;
    const diffHrs = Math.floor(diffMins / 60);
    if (diffHrs < 24) return `${diffHrs} hours ago`;
    const diffDays = Math.floor(diffHrs / 24);
    if (diffDays === 1) return "1 day ago";
    return `${diffDays} days ago`;
  } catch (e) {
    return "Recently";
  }
}

// ─── YOUTUBE URL PARSERS ──────────────────────────────────────────────────────
function extractVideoId(url) {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split(/[?#]/)[0] || null;
  } catch { /* ignore */ }
  return null;
}

function extractListId(url) {
  try { return new URL(url).searchParams.get("list"); } catch { return null; }
}

function detectType(url) {
  if (!url || typeof url !== "string") return "unknown";
  if (url.includes("spotify.com/track/")) return "sp_track";
  if (url.includes("spotify.com/playlist/")) return "sp_playlist";
  if (url.includes("youtube.com/playlist") || url.includes("list=")) return "yt_playlist";
  if (url.includes("youtube.com/watch") || url.includes("youtu.be/")) return "yt_video";
  return "unknown";
}

function stripToVideoUrl(url) {
  try {
    const u = new URL(url);
    const v = u.searchParams.get("v");
    if (v) return `https://www.youtube.com/watch?v=${v}`;
    if (url.includes("youtu.be/")) {
      const id = url.split("youtu.be/")[1]?.split(/[?#]/)[0];
      if (id) return `https://www.youtube.com/watch?v=${id}`;
    }
  } catch { /* keep original */ }
  return url;
}

// ─── PW AUTH & ATTACHMENTS ────────────────────────────────────────────────────
async function getPwToken() {
  if (pwTokenMemoryCache.token && pwTokenMemoryCache.expiresAt > Date.now()) {
    return pwTokenMemoryCache.token;
  }

  try {
    const tokenResponse = await fetch(`${PW_DETAILS_ORIGIN}/generate_token.php`, {
      headers: PW_HEADERS,
      signal: AbortSignal.timeout(12000),
    });
    if (tokenResponse.ok) {
      const tokenPayload = await tokenResponse.json();
      const token = tokenPayload.access_token || tokenPayload.token;
      if (token) {
        pwTokenMemoryCache = { token, expiresAt: Date.now() + 60 * 60 * 1000 };
        return token;
      }
    }
  } catch (err) {
    console.warn("PW generate_token error:", err.message);
  }

  if (pwTokenMemoryCache.token) return pwTokenMemoryCache.token;
  return "";
}

function extractPdfUrl(att) {
  if (!att || typeof att !== "object") return undefined;
  if (typeof att.key === "string" && att.key.trim().length > 0) {
    const key = att.key.trim();
    if (/^https?:\/\//i.test(key)) return key;
    const baseUrl = (typeof att.baseUrl === "string" && att.baseUrl.trim()) ? att.baseUrl.trim() : "https://static.pw.live/";
    return baseUrl.endsWith("/") ? `${baseUrl}${key}` : `${baseUrl}/${key}`;
  }
  if (typeof att.url === "string" && /^https?:\/\//i.test(att.url.trim()) && /\.pdf(?:[?#]|$)/i.test(att.url.trim())) return att.url.trim();
  if (typeof att.fileUrl === "string" && /^https?:\/\//i.test(att.fileUrl.trim()) && /\.pdf(?:[?#]|$)/i.test(att.fileUrl.trim())) return att.fileUrl.trim();
  if (typeof att.link === "string" && /^https?:\/\//i.test(att.link.trim()) && /\.pdf(?:[?#]|$)/i.test(att.link.trim())) return att.link.trim();
  return undefined;
}

async function fetchVideoAttachments(batchId, subjectId, chapterId, videoId, token) {
  if (!batchId || !subjectId || !chapterId || !videoId) return null;
  try {
    const url = `${PW_DETAILS_ORIGIN}/data-api.php?action=attachments&batch_id=${encodeURIComponent(batchId)}&subject_id=${encodeURIComponent(subjectId)}&topic_id=${encodeURIComponent(chapterId)}&video_id=${encodeURIComponent(videoId)}&token=${encodeURIComponent(token || "")}`;
    const res = await fetch(url, {
      headers: {
        "X-Requested-With": "SPA-Client",
        "Referer": "https://vidcloud.eu.org/",
        "Origin": "https://vidcloud.eu.org",
        "User-Agent": PW_HEADERS["User-Agent"]
      },
      signal: AbortSignal.timeout(5000)
    });
    if (res.ok) {
      const payload = await res.json();
      if (payload && payload.success) return payload;
    }
  } catch {}
  return null;
}

// ─── PW CHAPTER CONTENTS ──────────────────────────────────────────────────────
async function fetchChapterContents(batchId, subjectId, chapterId, token) {
  const cacheKey = `${batchId}_${subjectId}_${chapterId}`;
  const cached = pwChapterCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  try {
    const [vRes, nRes, dRes] = await Promise.all([
      fetch(
        `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=videos&tag=${encodeURIComponent(chapterId)}`,
        { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
      ).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
      fetch(
        `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=notes&tag=${encodeURIComponent(chapterId)}`,
        { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
      ).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
      fetch(
        `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/contents?page=1&contentType=DppNotes&tag=${encodeURIComponent(chapterId)}`,
        { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
      ).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] }))
    ]);

    const rawVideos = Array.isArray(vRes.data) ? vRes.data : [];
    const rawNotes = Array.isArray(nRes.data) ? nRes.data : [];
    const rawDpps = Array.isArray(dRes.data) ? dRes.data : [];

    // Pre-fetch live verified PDF attachments for videos concurrently
    const videoAttachmentsMap = new Map();
    for (let i = 0; i < rawVideos.length; i += 6) {
      const chunk = rawVideos.slice(i, i + 6);
      await Promise.all(
        chunk.map(async (v) => {
          if (!v._id) return;
          const atts = await fetchVideoAttachments(batchId, subjectId, chapterId, v._id, token);
          if (atts) videoAttachmentsMap.set(v._id, atts);
        })
      );
    }

    const notesList = [];
    rawNotes.forEach(item => {
      const hws = Array.isArray(item.homeworkIds) ? item.homeworkIds : [];
      if (hws.length > 0) {
        hws.forEach(hw => {
          if (!hw || typeof hw.topic !== "string") return;
          const att = Array.isArray(hw.attachmentIds) ? hw.attachmentIds[0] : null;
          notesList.push({
            id: `${subjectId}-${hw._id || item._id}`,
            title: hw.topic.trim(),
            attachmentName: att?.name || undefined,
            pdfUrl: extractPdfUrl(att),
            notesUrl: extractPdfUrl(att),
            date: item.date || item.startTime || undefined
          });
        });
      } else if (item.topic) {
        const att = Array.isArray(item.attachmentIds) ? item.attachmentIds[0] : null;
        notesList.push({
          id: `${subjectId}-${item._id}`,
          title: item.topic.trim(),
          attachmentName: att?.name || undefined,
          pdfUrl: extractPdfUrl(att),
          notesUrl: extractPdfUrl(att),
          date: item.date || item.startTime || undefined
        });
      }
    });

    const dppsList = [];
    rawDpps.forEach(item => {
      const hws = Array.isArray(item.homeworkIds) ? item.homeworkIds : [];
      if (hws.length > 0) {
        hws.forEach(hw => {
          if (!hw || typeof hw.topic !== "string") return;
          const att = Array.isArray(hw.attachmentIds) ? hw.attachmentIds[0] : null;
          const pdf = extractPdfUrl(att);
          dppsList.push({
            id: `${subjectId}-${hw._id || item._id}-dpp`,
            title: hw.topic.trim(),
            type: "dpp",
            attachmentName: att?.name || undefined,
            pdfUrl: pdf,
            dppPdfUrl: pdf,
            date: item.date || item.startTime || undefined
          });
        });
      } else if (item.topic) {
        const att = Array.isArray(item.attachmentIds) ? item.attachmentIds[0] : null;
        const pdf = extractPdfUrl(att);
        dppsList.push({
          id: `${subjectId}-${item._id}-dpp`,
          title: item.topic.trim(),
          type: "dpp",
          attachmentName: att?.name || undefined,
          pdfUrl: pdf,
          dppPdfUrl: pdf,
          date: item.date || item.startTime || undefined
        });
      }
    });

    const lecturesList = rawVideos.map(v => {
      const duration = typeof v.videoDetails?.duration === "string" ? v.videoDetails.duration : undefined;
      const date = v.date || v.startTime || undefined;
      const isDpp = (v.isDPPVideos === true || v.isDPPNotes === true) || (/\bdpp\b/i.test(v.topic) && !/no\s+dpp/i.test(v.topic));

      const atts = videoAttachmentsMap.get(v._id);
      const notePdf = atts?.notes?.[0]?.pdf;
      const dppPdf = atts?.dpp_pdf?.[0]?.pdf;
      const attName = atts?.notes?.[0]?.topic || atts?.notes?.[0]?.note;

      const matchingNote = !notePdf ? notesList.find(n => {
        const normV = v.topic.toLowerCase().replace(/[^a-z0-9]/g, " ");
        const normN = n.title.toLowerCase().replace(/[^a-z0-9]/g, " ");
        return normN.includes(normV) || normV.includes(normN);
      }) : null;

      const pdfUrl = notePdf || matchingNote?.pdfUrl || undefined;
      const notesUrl = notePdf || matchingNote?.notesUrl || undefined;
      const dppPdfUrl = dppPdf || undefined;

      if (Array.isArray(atts?.dpp_pdf) && atts.dpp_pdf.length > 0) {
        atts.dpp_pdf.forEach((dp, dpIdx) => {
          if (!dp || !dp.pdf) return;
          const normDp = (dp.topic || "").toLowerCase().replace(/[^a-z0-9]/g, " ");
          const existing = dppsList.find(d => {
            const normD = (d.title || "").toLowerCase().replace(/[^a-z0-9]/g, " ");
            return normD && (normD.includes(normDp) || normDp.includes(normD));
          });
          if (existing) {
            existing.pdfUrl = dp.pdf;
            existing.dppPdfUrl = dp.pdf;
            if (dp.note) existing.attachmentName = dp.note;
          } else if (!dppsList.some(d => d.pdfUrl === dp.pdf)) {
            dppsList.push({
              id: `${subjectId}-${v._id}-dpp-${dpIdx}`,
              title: dp.topic || `${v.topic} : DPP Sheet`,
              type: "dpp",
              attachmentName: dp.note || "DPP Sheet",
              pdfUrl: dp.pdf,
              dppPdfUrl: dp.pdf,
              date
            });
          }
        });
      }

      if (Array.isArray(atts?.notes) && atts.notes.length > 0) {
        atts.notes.forEach((nt, ntIdx) => {
          if (!nt || !nt.pdf) return;
          const normNt = (nt.topic || "").toLowerCase().replace(/[^a-z0-9]/g, " ");
          const existing = notesList.find(n => {
            const normN = (n.title || "").toLowerCase().replace(/[^a-z0-9]/g, " ");
            return normN && (normN.includes(normNt) || normNt.includes(normN));
          });
          if (existing) {
            existing.pdfUrl = nt.pdf;
            existing.notesUrl = nt.pdf;
            if (nt.note) existing.attachmentName = nt.note;
          } else if (!notesList.some(n => n.pdfUrl === nt.pdf)) {
            notesList.push({
              id: `${subjectId}-${v._id}-note-${ntIdx}`,
              title: nt.topic || `${v.topic} : Class Notes`,
              attachmentName: nt.note || "Class Notes",
              pdfUrl: nt.pdf,
              notesUrl: nt.pdf,
              date
            });
          }
        });
      }

      return {
        id: `${subjectId}-${v._id}`,
        rawContentId: v._id,
        title: v.topic.trim(),
        type: isDpp ? "dpp" : "lecture",
        duration,
        date,
        attachmentName: attName || matchingNote?.attachmentName || undefined,
        pdfUrl,
        notesUrl,
        dppPdfUrl,
        allNotes: atts?.notes || undefined,
        allDpps: atts?.dpp_pdf || undefined
      };
    });

    const data = {
      chapterId,
      lectures: [...lecturesList, ...dppsList],
      videosOnly: lecturesList,
      notes: notesList,
      dpps: dppsList,
      totalLectures: lecturesList.length,
      totalDpps: dppsList.length,
      totalNotes: notesList.length
    };

    pwChapterCache.set(cacheKey, { data, expiresAt: Date.now() + PW_CHAPTER_TTL });
    return data;
  } catch (err) {
    return { chapterId, lectures: [], videosOnly: [], notes: [], dpps: [], totalLectures: 0, totalDpps: 0, totalNotes: 0 };
  }
}

// ─── PW SUBJECT & BATCH METADATA ──────────────────────────────────────────────
async function fetchSubjectData(batchId, remoteSubject, token) {
  const name = typeof remoteSubject.subject === "string" ? remoteSubject.subject : "Subject";
  const teacherList = Array.isArray(remoteSubject.teacherIds) ? remoteSubject.teacherIds : [];
  const teachers = teacherList.map(t => ({
    _id: t?._id || "",
    firstName: t?.firstName || "",
    lastName: t?.lastName || "",
    name: [t?.firstName, t?.lastName].filter(Boolean).join(" ") || "Faculty",
    qualification: t?.qualification || "",
    experience: t?.experience ? `${t.experience} Years` : "",
    featuredLine: t?.featuredLine || "",
    imageUrl: t?.imageId ? (t.imageId.baseUrl ? `${t.imageId.baseUrl}${t.imageId.key}` : `https://static.pw.live/${t.imageId.key}`) : "",
    introVideoThumbnail: t?.introVideoThumbnail ? `https://static.pw.live/${t.introVideoThumbnail}` : "",
    subject: t?.subject || ""
  }));

  const faculty = teachers.map(t => t.name).filter(Boolean).join(" & ") || undefined;
  const syllabusPdf = remoteSubject.fileId?.key
    ? (remoteSubject.fileId.baseUrl ? `${remoteSubject.fileId.baseUrl}${remoteSubject.fileId.key}` : `https://static.pw.live/${remoteSubject.fileId.key}`)
    : undefined;

  const chapters = [];
  const subjectId = remoteSubject._id || remoteSubject.subjectId;

  if (subjectId && token) {
    try {
      const [p1Res, p2Res] = await Promise.all([
        fetch(
          `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/topics?page=1`,
          { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
        ).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] })),
        fetch(
          `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/subject/${encodeURIComponent(subjectId)}/topics?page=2`,
          { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) }
        ).then(r => r.ok ? r.json() : { data: [] }).catch(() => ({ data: [] }))
      ]);

      const rawTopics = [...(p1Res.data || []), ...(p2Res.data || [])];
      const validTopics = rawTopics.filter(topic => {
        if (typeof topic.name !== "string") return false;
        return !/(only\s+pdf|only\s+video|demo\s+videos?|short\s+notes|mind\s+maps?|blueprint|notice|announcement|test\s+series)/i.test(topic.name);
      });

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

      const firstStartedChapter = chapters.find(c => c.isStarted);
      if (firstStartedChapter && firstStartedChapter.rawId) {
        const contents = await fetchChapterContents(batchId, subjectId, firstStartedChapter.rawId, token);
        firstStartedChapter.lectures = contents.lectures || [];
        if (contents.totalLectures) firstStartedChapter.videoCount = contents.totalLectures;
        if (contents.totalDpps) firstStartedChapter.dppCount = contents.totalDpps;
      }
    } catch (err) {
      console.warn(`Failed fetching topics for subject ${subjectId}:`, err.message);
    }
  }

  return {
    id: remoteSubject._id || "",
    subjectId: remoteSubject.subjectId || "",
    name,
    faculty,
    teachers,
    lectureCount: chapters.reduce((acc, c) => acc + (c.videoCount || 0), 0) || remoteSubject.lectureCount || 0,
    tagCount: chapters.length || remoteSubject.tagCount || 0,
    syllabusPdf,
    schedules: remoteSubject.batchDescriptionSchedules || [],
    chapters
  };
}

async function fetchPwMetadata(batchId) {
  const cached = pwMetadataCache.get(batchId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  let detailsPayload = null;
  const candidates = [
    {
      url: `${PW_OFFICIAL_API}/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
      headers: { "User-Agent": PW_HEADERS["User-Agent"], "client-type": "WEB", "Accept": "application/json, text/plain, */*" }
    },
    {
      url: `${PW_DETAILS_ORIGIN}/api/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
      headers: PW_HEADERS
    },
    {
      url: `${PW_OFFICIAL_API}/api/v3/batches/${encodeURIComponent(batchId)}/details?type=EXPLORE_LEAD`,
      headers: { "User-Agent": PW_HEADERS["User-Agent"], "client-type": "WEB", "Accept": "application/json, text/plain, */*" }
    }
  ];

  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, {
        headers: candidate.headers,
        signal: AbortSignal.timeout(10000)
      });
      if (res.ok) {
        detailsPayload = await res.json();
        if (detailsPayload && (detailsPayload.data || detailsPayload.subjects)) break;
      }
    } catch (err) {}
  }

  if (!detailsPayload) {
    throw new Error("PW batch details unavailable from official API");
  }

  const data = detailsPayload.data || detailsPayload;
  const rawSubjects = Array.isArray(data.subjects) ? data.subjects : [];
  const remoteSubjects = rawSubjects.filter(s => {
    const sName = typeof s.subject === "string" ? s.subject : "";
    return !/^(notices?|announcements?|test\s+series|demo)/i.test(sName.trim());
  });

  const token = await getPwToken().catch(() => "");
  const subjects = [];
  for (let i = 0; i < remoteSubjects.length; i += 3) {
    const chunk = remoteSubjects.slice(i, i + 3);
    const chunkResults = await Promise.all(
      chunk.map(remoteSubject => fetchSubjectData(batchId, remoteSubject, token))
    );
    subjects.push(...chunkResults);
  }

  const batchPdf = data.batchPdfUrl || (data.fileId ? (data.fileId.baseUrl ? `${data.fileId.baseUrl}${data.fileId.key}` : `https://static.pw.live/${data.fileId.key}`) : undefined);
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

  if (subjects.length > 0) {
    pwMetadataCache.set(batchId, { value, expiresAt: Date.now() + PW_METADATA_TTL });
  }
  return value;
}

// ─── PW FULL SCHEDULE ENGINE ──────────────────────────────────────────────────
async function fetchPwSchedule(batchId, date) {
  const cacheKey = `${batchId}_${date}`;
  const cached = pwScheduleCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const rawItems = [];
  const token = await getPwToken().catch(() => "");

  // 1. Try weekly-schedules feed (returns exact classes for selected day with full attachments)
  if (token) {
    try {
      const wsRes = await fetch(
        `${PW_DETAILS_ORIGIN}/api/v2/batches/${encodeURIComponent(batchId)}/weekly-schedules?batchId=${encodeURIComponent(batchId)}&startDate=${encodeURIComponent(date)}&endDate=${encodeURIComponent(date)}&page=1`,
        { headers: { ...PW_HEADERS, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(9000) }
      );
      if (wsRes.ok) {
        const payload = await wsRes.json();
        if (Array.isArray(payload.data) && payload.data.length > 0) {
          rawItems.push(...payload.data);
        }
      }
    } catch (err) {}
  }

  // 2. Fallback to free-schedule if weekly-schedules returned empty or token expired
  if (rawItems.length === 0) {
    try {
      const scheduleRes = await fetch(
        `${PW_OFFICIAL_API}/v3/public/batch-service/batch-subject-schedules/${encodeURIComponent(batchId)}/free-schedule`,
        { headers: PW_HEADERS, signal: AbortSignal.timeout(8000) }
      );
      if (scheduleRes.ok) {
        const payload = await scheduleRes.json();
        if (Array.isArray(payload.data)) {
          rawItems.push(...payload.data);
        }
      }
    } catch (err) {}
  }

  // Pre-fetch live attachments for candidate video items
  const scheduleAttachmentsMap = new Map();
  const candidateItems = rawItems.filter(item => {
    const details = item?.videoDetails || item?.notesDetails || item;
    return details && details._id;
  });
  if (token && candidateItems.length > 0) {
    await Promise.all(
      candidateItems.slice(0, 8).map(async item => {
        const details = item.videoDetails || item.notesDetails || item;
        const subId = typeof details.subjectId === "object" ? details.subjectId?._id : (typeof item.subjectId === "object" ? item.subjectId?._id : (details.subjectId || item.subjectId));
        const topicId = details.tags?.[0]?._id || item.tags?.[0]?._id || "";
        const vidId = details._id || item._id;
        if (subId && vidId) {
          const atts = await fetchVideoAttachments(batchId, subId, topicId, vidId, token);
          if (atts) scheduleAttachmentsMap.set(vidId, atts);
        }
      })
    );
  }

  const list = rawItems.flatMap((item, index) => {
    if (!item || typeof item !== "object") return [];
    const details = item.videoDetails || item.notesDetails || item.dppQuizDetails || item.bulkScheduleDetails || item.dppDetails || item;
    const rawSubName = details.subjectId?.name || item.subjectId?.name || (typeof item.subject === "string" ? item.subject : "") || "Subject";

    let teacher = "PW Faculty";
    if (details.teachers?.[0]?.name && typeof details.teachers[0].name === "string" && !/^[a-f0-9]{24}$/i.test(details.teachers[0].name)) {
      teacher = details.teachers[0].name;
    } else if (item.teachers?.[0]?.name && typeof item.teachers[0].name === "string" && !/^[a-f0-9]{24}$/i.test(item.teachers[0].name)) {
      teacher = item.teachers[0].name;
    } else if (typeof item.teacher === "string" && item.teacher && !/^[a-f0-9]{24}$/i.test(item.teacher)) {
      teacher = item.teacher;
    } else if (rawSubName) {
      const match = rawSubName.match(/By\s+([^()|]+)/i);
      if (match) teacher = match[1].trim();
    }

    const topic = details.topic || item.topic || details.name || "Live Class";
    const start = details.startTime || item.startTime || item.date || date;
    const end = details.endTime || item.endTime || "";
    const duration = details.videoDetails?.duration || details.duration || "1h 45m";
    const tag = (details.tag || item.tag || "").trim();
    const status = (details.status || item.status || "").trim();
    const itemDate = item.date ? item.date.split("T")[0] : (start ? start.split("T")[0] : date);

    const isLive = tag.toLowerCase() === "live" || status.toLowerCase() === "live";
    const isEnded = tag.toLowerCase() === "ended" || status.toLowerCase() === "completed" || status.toLowerCase() === "canceled" || status.toLowerCase() === "cancelled" || (!isLive && Boolean(end) && new Date(end).getTime() < Date.now());
    const isUpcoming = !isEnded && !isLive && (tag.toLowerCase() === "upcoming" || (Boolean(start) && new Date(start).getTime() > Date.now()));

    // Collect Notes & DPPs attachments
    const hws = Array.isArray(details.homeworkIds) ? details.homeworkIds : (Array.isArray(item.homeworkIds) ? item.homeworkIds : []);
    const directAtts = Array.isArray(details.attachmentIds) ? details.attachmentIds : (Array.isArray(item.attachmentIds) ? item.attachmentIds : []);
    const notesItems = [];
    const dppItems = [];

    hws.forEach(hw => {
      if (!hw || typeof hw.topic !== "string") return;
      const att = Array.isArray(hw.attachmentIds) ? hw.attachmentIds[0] : null;
      const pdf = extractPdfUrl(att);
      const isDppHw = (hw.note && /dpp/i.test(hw.note)) || /dpp/i.test(hw.topic);
      if (isDppHw) {
        dppItems.push({ topic: hw.topic.trim(), attachmentName: att?.name || undefined, url: pdf });
      } else {
        notesItems.push({ topic: hw.topic.trim(), attachmentName: att?.name || undefined, url: pdf });
      }
    });

    directAtts.forEach(att => {
      if (!att) return;
      const pdf = extractPdfUrl(att);
      const isDppAtt = (att.name && /dpp/i.test(att.name)) || (topic && /dpp/i.test(topic));
      if (isDppAtt) {
        dppItems.push({ topic: att.name || topic || "DPP Sheet", attachmentName: att.name || undefined, url: pdf });
      } else {
        notesItems.push({ topic: att.name || topic || "Class Notes", attachmentName: att.name || undefined, url: pdf });
      }
    });

    const resolvedAtts = scheduleAttachmentsMap.get(details._id || item._id);
    if (resolvedAtts?.notes) {
      resolvedAtts.notes.forEach(nt => {
        if (nt?.pdf && !notesItems.some(n => n.url === nt.pdf)) {
          notesItems.push({ topic: nt.topic || "Class Notes", attachmentName: nt.note || "Class Notes", url: nt.pdf });
        }
      });
    }
    if (resolvedAtts?.dpp_pdf) {
      resolvedAtts.dpp_pdf.forEach(dp => {
        if (dp?.pdf && !dppItems.some(d => d.url === dp.pdf)) {
          dppItems.push({ topic: dp.topic || "DPP Sheet", attachmentName: dp.note || "DPP Sheet", url: dp.pdf });
        }
      });
    }

    const isNotes = Boolean(item.notesDetails || details.type === "NOTES" || item.type === "NOTES" || /notes|summary|only pdf/i.test(topic));
    const isDpp = Boolean(item.dppQuizDetails || item.dppDetails || details.type === "DPP" || item.type === "DPP" || /dpp|quiz/i.test(topic));
    const finalType = isDpp ? "DPP" : (isNotes ? "NOTES" : "LECTURE");

    const primaryNotesUrl = notesItems.find(n => n.url)?.url || undefined;
    const primaryDppPdfUrl = dppItems.find(d => d.url)?.url || undefined;
    const teacherImage = details.teachers?.[0]?.imageUrl || details.teachers?.[0]?.image || item.teachers?.[0]?.imageUrl || details.teacherImage || item.teacherImage || "";
    const attachedDpp = dppItems[0] || notesItems.find(n => /dpp/i.test(n.topic));
    const dppTitle = attachedDpp ? attachedDpp.topic : undefined;
    const dppPdfUrl = attachedDpp?.url || primaryDppPdfUrl;

    return [{
      id: String(item._id || details._id || `${batchId}-${itemDate}-${index}`),
      type: finalType,
      subject: rawSubName,
      rawSubject: rawSubName,
      teacher,
      teacherImage,
      topic,
      chapter: details.tags?.[0]?.name || item.tags?.[0]?.name || "",
      date: itemDate,
      startTime: start,
      endTime: end,
      duration,
      time: start && end ? `${start} - ${end}` : start || "Scheduled Class",
      tag: isEnded ? "Ended" : (isLive ? "Live" : (isUpcoming ? "Upcoming" : (tag || "Scheduled"))),
      status,
      isLive,
      isUpcoming,
      isEnded,
      hasNotes: notesItems.length > 0 || Boolean(item.contentAlert?.isNotesChecked),
      hasDpp: Boolean(dppTitle) || dppItems.length > 0 || Boolean(item.contentAlert?.isDppPdfChecked),
      notesUrl: primaryNotesUrl,
      dppPdfUrl,
      dppTitle,
      notes: notesItems,
      dpps: dppItems
    }];
  });

  const daySchedules = date ? list.filter(s => s.date === date) : list;
  const availableDates = Array.from(new Set(list.map(s => s.date).filter(Boolean)));
  const allEnded = daySchedules.length > 0 && daySchedules.every(s => s.isEnded);

  const value = {
    batchId,
    date,
    allEnded,
    statusMessage: allEnded ? "Today's Classes Ended" : undefined,
    schedules: daySchedules,
    allSchedules: list,
    availableDates
  };
  pwScheduleCache.set(cacheKey, { value, expiresAt: Date.now() + PW_SCHEDULE_TTL });
  return value;
}

// ─── DUCKDUCKGO WEB SEARCH & OPENGRAPH ────────────────────────────────────────
async function fetchOgImage(url) {
  try {
    const res = await fetch(url, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return "";
    const html = await res.text();
    const match = html.match(/<meta[^>]+(?:property|name)=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']og:image["']/i);
    return match ? match[1] : "";
  } catch {
    return "";
  }
}

async function handleSearch(q, df) {
  const encoded = encodeURIComponent(q);
  let searchUrl = `https://html.duckduckgo.com/html/?q=${encoded}`;
  if (df) searchUrl += `&df=${df}`;

  const response = await fetch(searchUrl, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(8000)
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo request failed (${response.status})`);
  }

  const html = await response.text();
  if (!html.includes("result results_links")) {
    return { results: [] };
  }

  const parts = html.split('class="result results_links');
  const rawResults = parts.slice(1).map((part) => {
    const hrefMatch = part.match(/class="result__a"[^>]*href="([^"]+)"/);
    const titleMatch = part.match(/class="result__a"[^>]*>([\s\S]*?)<\/a>/);
    const snippetMatch = part.match(/class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);

    let url = hrefMatch ? hrefMatch[1] : "";
    if (url.startsWith("//")) url = "https:" + url;
    if (url.startsWith("/l/") || url.includes("uddg=")) {
      const match = url.match(/[?&]uddg=([^&]+)/);
      if (match) url = decodeURIComponent(match[1]);
    }

    let title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, "").trim() : "";
    let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]*>/g, "").trim() : "";

    return {
      url,
      title: decodeHTMLEntities(title),
      snippet: decodeHTMLEntities(snippet),
      thumbnail: ""
    };
  });

  const withThumbnails = await Promise.all(
    rawResults.slice(0, 15).map(async (item, idx) => {
      if (idx < 5 && item.url) {
        const thumbnail = await fetchOgImage(item.url);
        return { ...item, thumbnail };
      }
      return item;
    })
  );

  return { results: withThumbnails };
}

// ─── YOUTUBE SEARCH & PLAYLIST SCRAPER ─────────────────────────────────────────
async function handleYtSearch(q) {
  // Check if channel latest uploads request
  const channelMatch = q.match(/^(.*?)\s+latest\s+video$/i) || q.match(/^(.*?)\s+latest\s+uploads?$/i);
  if (channelMatch) {
    const channelName = channelMatch[1].trim();
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(channelName)}&sp=EgIQAg%253D%253D`;
      const chRes = await fetch(searchUrl, { headers: BROWSER_HEADERS, signal: AbortSignal.timeout(5000) });
      if (chRes.ok) {
        const chHtml = await chRes.text();
        const chMatch = chHtml.match(/"channelId":"(UC[a-zA-Z0-9_-]{22})"/);
        if (chMatch) {
          const channelId = chMatch[1];
          const feedRes = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { signal: AbortSignal.timeout(5000) });
          if (feedRes.ok) {
            const xml = await feedRes.text();
            const entryRegex = /<entry>([\s\S]*?)<\/entry>/g;
            let match;
            const parsed = [];
            while ((match = entryRegex.exec(xml)) !== null) {
              const entry = match[1];
              const idMatch = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
              const titleMatch = entry.match(/<title>([^<]+)<\/title>/);
              const publishedMatch = entry.match(/<published>([^<]+)<\/published>/);
              if (idMatch && titleMatch) {
                const videoId = idMatch[1];
                parsed.push({
                  videoId,
                  title: decodeHTMLEntities(titleMatch[1]),
                  author: channelName,
                  length_seconds: 0,
                  thumbnail: `https://i.ytimg.com/vi/${videoId}/hq720.jpg`,
                  views: "N/A",
                  uploadedAt: publishedMatch ? timeAgo(publishedMatch[1]) : "Recently"
                });
              }
            }
            if (parsed.length > 0) return { results: parsed };
          }
        }
      }
    } catch (e) {}
  }

  // Scrape YouTube search results page
  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&gl=US&hl=en`;
  const response = await fetch(searchUrl, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(7000)
  });

  if (!response.ok) throw new Error("YouTube search fetch failed");
  const html = await response.text();

  const videos = [];
  const seenIds = new Set();
  let pos = 0;

  while (true) {
    pos = html.indexOf('"videoRenderer"', pos);
    if (pos === -1) break;

    const startIdx = html.indexOf("{", pos + 15);
    if (startIdx !== -1) {
      let braceCount = 0;
      let inString = false;
      let escape = false;
      let block = "";
      for (let i = startIdx; i < html.length; i++) {
        const char = html[i];
        if (escape) { escape = false; continue; }
        if (char === "\\") { escape = true; continue; }
        if (char === '"') { inString = !inString; continue; }
        if (!inString) {
          if (char === "{") braceCount++;
          else if (char === "}") {
            braceCount--;
            if (braceCount === 0) {
              block = html.slice(startIdx, i + 1);
              break;
            }
          }
        }
      }

      if (block) {
        try {
          const r = JSON.parse(block);
          const vId = r.videoId;
          if (vId && !seenIds.has(vId)) {
            seenIds.add(vId);
            const title = r.title?.runs?.[0]?.text || r.title?.simpleText || "";
            const author = r.ownerText?.runs?.[0]?.text || "";
            let length_seconds = 0;
            if (r.lengthText?.simpleText) {
              const parts = r.lengthText.simpleText.split(":").map(Number);
              if (parts.every(p => !isNaN(p))) {
                if (parts.length === 2) length_seconds = parts[0] * 60 + parts[1];
                if (parts.length === 3) length_seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
              }
            }
            const views = r.viewCountText?.simpleText || r.shortViewCountText?.simpleText || "N/A";
            const uploadedAt = r.publishedTimeText?.simpleText || "Recently";

            videos.push({
              videoId: vId,
              title: cleanTitle(title),
              author: cleanTitle(author),
              length_seconds,
              thumbnail: `https://i.ytimg.com/vi/${vId}/hqdefault.jpg`,
              views,
              uploadedAt
            });
          }
        } catch (e) {}
      }
    }
    pos += 15;
  }

  return { results: videos };
}

async function scrapePlaylistHtml(ytPlaylistId) {
  const targetUrl = `https://www.youtube.com/playlist?list=${ytPlaylistId}`;
  const response = await fetch(targetUrl, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) throw new Error("Failed to fetch playlist page");

  const html = await response.text();
  let playlistName = "YouTube Playlist";
  const nameMatch = html.match(/<meta\s+name="title"\s+content="([^"]+)"/i) || html.match(/<title>([^<]+)<\/title>/i);
  if (nameMatch) playlistName = cleanTitle(nameMatch[1].replace(" - YouTube", ""));

  const tracks = [];
  const seenIds = new Set();
  const videoRegex = /"playlistVideoRenderer"\s*:\s*\{[\s\S]*?"videoId"\s*:\s*"([a-zA-Z0-9_-]{11})"[\s\S]*?"title"\s*:\s*\{[\s\S]*?"text"\s*:\s*"([^"]+)"/g;
  let match;

  while ((match = videoRegex.exec(html)) !== null) {
    const vId = match[1];
    const rawTitle = match[2];
    if (!seenIds.has(vId)) {
      seenIds.add(vId);
      tracks.push({
        title: cleanTitle(rawTitle) || `YouTube Video [${vId}]`,
        artist: playlistName,
        thumbnail: `https://img.youtube.com/vi/${vId}/hqdefault.jpg`,
        duration: 0,
        youtubeId: vId,
        streamUrl: `/api/stream?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${vId}`)}`
      });
    }
  }

  return { name: playlistName, tracks };
}

// ─── AI WEB SCRAPER & TRANSCRIPT ENGINE ───────────────────────────────────────
async function handleScrape(targetUrl) {
  const cleanUrl = targetUrl.trim();

  // 1. YouTube Link Resolution (Metadata + Transcript)
  if (cleanUrl.includes("youtube.com/") || cleanUrl.includes("youtu.be/")) {
    const yvId = extractVideoId(cleanUrl);
    if (yvId) {
      let metaText = "";
      let transcriptText = "";

      const mirrors = [
        "https://inv.thepixora.com",
        "https://invidious.f5.si",
        "https://invidious.tiekoetter.com"
      ];
      for (const mirror of mirrors) {
        try {
          const vres = await fetch(`${mirror}/api/v1/videos/${yvId}`, {
            headers: { "User-Agent": "Mozilla/5.0" },
            signal: AbortSignal.timeout(5000)
          });
          if (vres.ok) {
            const data = await vres.json();
            if (data && data.title) {
              metaText = `=== YOUTUBE VIDEO METADATA ===\nURL: ${cleanUrl}\nTitle: ${data.title}\nChannel: ${data.author || "Unknown"}\nViews: ${data.viewCount || 0}\nDuration: ${data.lengthSeconds || 0}s\nDescription:\n${data.description || ""}\n`;
              break;
            }
          }
        } catch (e) {}
      }

      try {
        const tres = await fetch(`https://youtube-transcript.ai/transcript/${yvId}.txt`, {
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(6000)
        });
        if (tres.ok) {
          const body = await tres.text();
          if (!body.includes("<!DOCTYPE") && body.trim().length > 30) {
            transcriptText = body;
          }
        }
      } catch (e) {}

      if (!metaText) {
        try {
          const oembed = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(cleanUrl)}`, { signal: AbortSignal.timeout(4000) });
          if (oembed.ok) {
            const data = await oembed.json();
            if (data?.title) {
              metaText = `=== YOUTUBE VIDEO METADATA ===\nTitle: ${data.title}\nAuthor: ${data.author_name || ""}\n`;
            }
          }
        } catch (e) {}
      }

      let combined = metaText || `=== YOUTUBE VIDEO ===\nURL: ${cleanUrl}\n`;
      if (transcriptText) {
        combined += `\n=== SPOKEN TRANSCRIPT ===\n${transcriptText}\n`;
      }
      return { url: cleanUrl, text: combined, links: [] };
    }
  }

  // 2. GitHub Raw Code
  if (cleanUrl.includes("github.com/") && cleanUrl.includes("/blob/")) {
    try {
      const rawUrl = cleanUrl.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/");
      const res = await fetch(rawUrl, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        let code = await res.text();
        if (code.length > 20000) code = code.slice(0, 20000) + "\n\n... [Truncated for size]";
        return { url: cleanUrl, text: `=== GITHUB FILE (${cleanUrl}) ===\n\n${code}`, links: [] };
      }
    } catch (e) {}
  }

  // 3. Generic Web Page
  const response = await fetch(cleanUrl, {
    headers: BROWSER_HEADERS,
    signal: AbortSignal.timeout(9000)
  });

  if (!response.ok) throw new Error(`HTTP ${response.status} fetching web page`);
  const html = await response.text();

  let metaSummary = "=== PAGE METADATA ===\n";
  const metaRegex = /<meta[^>]+(?:name|property)=["']([^"']+)["'][^>]+content=["']([^"']+)["']/gi;
  let match;
  while ((match = metaRegex.exec(html)) !== null) {
    const k = match[1].toLowerCase();
    if (k.startsWith("og:") || k.startsWith("twitter:") || k === "description" || k === "title") {
      metaSummary += `${match[1]}: ${decodeHTMLEntities(match[2])}\n`;
    }
  }

  let text = cleanHtmlToText(html);
  if (text.length > 15000) text = text.slice(0, 15000) + "... [Truncated]";

  return {
    url: cleanUrl,
    text: `${metaSummary}\n=== CONTENT ===\n${text}`,
    links: []
  };
}

// ─── UNIVERSAL CORS PROXY ─────────────────────────────────────────────────────
async function handleProxy(targetUrl, request) {
  const reqUrl = new URL(targetUrl);
  const fetchHeaders = {
    "User-Agent": BROWSER_HEADERS["User-Agent"],
    "Accept": request.headers.get("accept") || "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": reqUrl.origin + "/"
  };

  const response = await fetch(targetUrl, {
    method: request.method,
    headers: fetchHeaders,
    body: request.method === "POST" ? await request.arrayBuffer() : undefined,
    redirect: "follow"
  });

  const contentType = response.headers.get("content-type") || "";
  const headers = new Headers(CORS_HEADERS);
  headers.set("Content-Type", contentType);
  headers.set("X-Frame-Options", "ALLOWALL");

  if (contentType.includes("text/html")) {
    let html = await response.text();
    const baseUrl = reqUrl.origin + reqUrl.pathname;
    const protocol = reqUrl.protocol;

    html = html.replace(/(href|src|action)=["']\/\/([^"']+)["']/gi, (_, attr, path) => `${attr}="${protocol}//${path}"`);
    html = html.replace(/target\s*=\s*["']?\s*(_top|_parent)\s*["']?/gi, 'target="_self"');
    return new Response(html, { status: response.status, headers });
  }

  if (contentType.includes("text/css")) {
    let css = await response.text();
    return new Response(css, { status: response.status, headers });
  }

  return new Response(response.body, { status: response.status, headers });
}

// ─── CLOUDFLARE WORKER ROUTER ─────────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    // Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 1. Root & Health Check
    if (pathname === "/" || pathname === "/api/healthz") {
      return jsonResponse({
        status: "ok",
        platform: "Cloudflare Worker Edge",
        service: "StudE & OM Network API Gateway",
        uptime: "100%",
        timestamp: Date.now()
      });
    }

    // 2. PW Status
    if (pathname === "/api/pw-status") {
      return jsonResponse({
        status: "ok",
        platform: "Cloudflare Worker Edge",
        service: "Physics Wallah & JEE Prep Live API Engine",
        uptime: "100%",
        cachedBatches: Array.from(pwMetadataCache.keys()),
        timestamp: Date.now()
      });
    }

    // 3. PW Catalog
    if (pathname === "/api/pw-catalog") {
      if (pwCatalogCache.data && pwCatalogCache.expiresAt > Date.now()) {
        return jsonResponse(pwCatalogCache.data, 200, { "Cache-Control": "public, max-age=1800" });
      }
      try {
        const res = await fetch(PW_CATALOG_URL, { headers: PW_HEADERS, signal: AbortSignal.timeout(12000) });
        if (res.ok) {
          const data = await res.json();
          pwCatalogCache = { data, expiresAt: Date.now() + PW_CATALOG_TTL };
          return jsonResponse(data, 200, { "Cache-Control": "public, max-age=1800" });
        }
      } catch (err) {}
      if (pwCatalogCache.data) return jsonResponse(pwCatalogCache.data);
      return jsonResponse({ error: "PW catalog temporarily unavailable" }, 502);
    }

    // 4. PW Metadata
    if (pathname === "/api/pw-metadata") {
      const batchId = url.searchParams.get("batchId") || "";
      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(batchId)) {
        return jsonResponse({ error: "A valid batchId is required" }, 400);
      }
      try {
        const data = await fetchPwMetadata(batchId);
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=3600" });
      } catch (err) {
        return jsonResponse({ error: err.message || "PW metadata unavailable" }, 502);
      }
    }

    // 5. PW Chapter Contents (Videos, Notes, DPPs)
    if (pathname === "/api/pw-chapter-contents") {
      const batchId = url.searchParams.get("batchId") || "";
      const subjectId = url.searchParams.get("subjectId") || "";
      const chapterId = url.searchParams.get("chapterId") || "";

      if (!batchId || !subjectId || !chapterId) {
        return jsonResponse({ error: "batchId, subjectId, and chapterId are required" }, 400);
      }

      try {
        const token = await getPwToken().catch(() => "");
        const data = await fetchChapterContents(batchId, subjectId, chapterId, token);
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=1800" });
      } catch (err) {
        return jsonResponse({ chapterId, lectures: [], videosOnly: [], notes: [], dpps: [] });
      }
    }

    // 6. PW Schedule (Official Weekly + Free Schedules + Live Attachments)
    if (pathname === "/api/pw-schedule") {
      const batchId = url.searchParams.get("batchId") || "";
      const requestedDate = url.searchParams.get("date") || "";
      const istDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
      const date = /^\d{4}-\d{2}-\d{2}$/.test(requestedDate) ? requestedDate : istDate;

      if (!/^[a-zA-Z0-9_-]{8,100}$/.test(batchId)) {
        return jsonResponse({ error: "A valid batchId is required" }, 400);
      }

      try {
        const data = await fetchPwSchedule(batchId, date);
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=600" });
      } catch (err) {
        return jsonResponse({ error: err.message || "PW schedule unavailable" }, 502);
      }
    }

    // 7. DuckDuckGo Web Search
    if (pathname === "/api/search") {
      const q = url.searchParams.get("q");
      const df = url.searchParams.get("df");
      if (!q) return jsonResponse({ error: "Missing search query parameter 'q'" }, 400);
      try {
        const results = await handleSearch(q, df);
        return jsonResponse(results, 200, { "Cache-Control": "public, max-age=300" });
      } catch (err) {
        return jsonResponse({ error: err.message || "Search error" }, 500);
      }
    }

    // 8. YouTube Video & Channel Search
    if (pathname === "/api/yt-search") {
      const q = url.searchParams.get("q");
      if (!q) return jsonResponse({ error: "Missing search query parameter 'q'" }, 400);
      try {
        const data = await handleYtSearch(q);
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=600" });
      } catch (err) {
        return jsonResponse({ error: err.message || "YouTube search error" }, 500);
      }
    }

    // 9. Media Info (Playlists & Videos)
    if (pathname === "/api/media-info") {
      const targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "url param required" }, 400);
      const type = detectType(targetUrl);

      if (type === "yt_playlist") {
        const listId = extractListId(targetUrl) || targetUrl;
        try {
          const scraped = await scrapePlaylistHtml(listId);
          return jsonResponse(scraped);
        } catch (err) {
          return jsonResponse({ error: err.message || "Playlist scrape failed" }, 500);
        }
      }

      if (type === "yt_video") {
        const videoId = extractVideoId(targetUrl);
        try {
          const oembed = await fetch(`https://noembed.com/embed?url=${encodeURIComponent(targetUrl)}`);
          if (oembed.ok) {
            const d = await oembed.json();
            return jsonResponse({
              type: "track",
              youtubeId: videoId,
              title: cleanTitle(d.title || "YouTube Video"),
              artist: cleanTitle(d.author_name || "YouTube"),
              thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
              duration: 0,
              streamUrl: `/api/stream?url=${encodeURIComponent(targetUrl)}`
            });
          }
        } catch (e) {}
        return jsonResponse({
          type: "track",
          youtubeId: videoId,
          title: "YouTube Video",
          artist: "YouTube",
          thumbnail: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
          duration: 0,
          streamUrl: `/api/stream?url=${encodeURIComponent(targetUrl)}`
        });
      }

      return jsonResponse({ error: "Unsupported media URL" }, 400);
    }

    // 10. AI Web & Transcript Scraper
    if (pathname === "/api/scrape") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return jsonResponse({ error: "Missing 'url' parameter" }, 400);
      try {
        const data = await handleScrape(targetUrl);
        return jsonResponse(data, 200, { "Cache-Control": "public, max-age=600" });
      } catch (err) {
        return jsonResponse({ error: err.message || "Scrape failed" }, 500);
      }
    }

    // 11. Media Stream Proxy
    if (pathname === "/api/stream") {
      const targetUrl = (url.searchParams.get("url") || "").trim();
      if (!targetUrl) return jsonResponse({ error: "url param required" }, 400);
      const vId = extractVideoId(targetUrl);
      if (vId) {
        // Redirect or stream directly from Invidious audio stream endpoint
        return Response.redirect(`https://inv.thepixora.com/latest_version?id=${vId}&itag=140`, 302);
      }
      return jsonResponse({ error: "Unable to resolve stream source" }, 400);
    }

    // 12. Universal CORS Proxy
    if (pathname === "/api/proxy") {
      const targetUrl = url.searchParams.get("url");
      if (!targetUrl) return textResponse("Missing 'url' parameter", 400);
      try {
        return await handleProxy(targetUrl, request);
      } catch (err) {
        return textResponse(`Proxy Error: ${err.message}`, 500);
      }
    }

    return jsonResponse({ error: "Endpoint not found", path: pathname }, 404);
  }
};
