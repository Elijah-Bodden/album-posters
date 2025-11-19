const BACKEND_BASE_URL = "https://spotify-poster-backend.elijahbodden.workers.dev/";

const DPI = 300;
// Modes: album, song
let currentMode = "album";
const unitsPerInch = 100;
const spotifyCodeMaxWidth = unitsPerInch * 3.0;
const spotifyCodeMaxHeight = unitsPerInch * 1.0;

// Poster sizes (inches)
function getPosterSizeIn() {
  if (currentMode === "song") {
    return { width: 8.5, height: 11 };
  }
  return { width: 12, height: 18 };
}


// ====== DOM ======
const authStatus = document.getElementById("authStatus");
const albumForm = document.getElementById("albumForm");
const albumUrlInput = document.getElementById("albumUrl");
const urlLabel = document.getElementById("urlLabel");
const posterCanvas = document.getElementById("posterCanvas");
const downloadButton = document.getElementById("downloadButton");
const modeRadios = document.querySelectorAll('input[name="mode"]');

const showCodeCheckbox = document.getElementById("showSpotifyCode");
const codeDescriptionInput = document.getElementById("codeDescription");
const codeDescriptionWrapper = document.getElementById("codeDescriptionWrapper");

let accessToken = null;

// ====== CANVAS DIMENSIONS ======
function updateCanvasSizeForMode() {
  const { width, height } = getPosterSizeIn();
  posterCanvas.width = width * DPI;
  posterCanvas.height = height * DPI;
}

function updateDownloadLabel() {
  const { width, height } = getPosterSizeIn();
  downloadButton.textContent = `Download PNG (${width}×${height}" @ ${DPI} DPI)`;
}

// Initial size
updateCanvasSizeForMode();
updateDownloadLabel();

// ====== PKCE UTILITIES ======
async function generateCodeVerifier() {
  const array = new Uint8Array(64);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode.apply(null, array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+/g, "");
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return await crypto.subtle.digest("SHA-256", data);
}

function base64UrlEncode(bytes) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+/g, "");
}

async function generateCodeChallenge(codeVerifier) {
  const hashed = await sha256(codeVerifier);
  return base64UrlEncode(hashed);
}

function redirectToSpotifyAuth() {
  generateCodeVerifier().then(async (verifier) => {
    const challenge = await generateCodeChallenge(verifier);
    localStorage.setItem("spotify_code_verifier", verifier);

    const params = new URLSearchParams({
      response_type: "code",
      client_id: SPOTIFY_CLIENT_ID,
      scope: "", // no special scopes needed
      redirect_uri: REDIRECT_URI,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });

    window.location = "https://accounts.spotify.com/authorize?" + params.toString();
  });
}

async function exchangeCodeForToken(code) {
  const verifier = localStorage.getItem("spotify_code_verifier");
  if (!verifier) throw new Error("Missing code_verifier");

  const body = new URLSearchParams({
    client_id: SPOTIFY_CLIENT_ID,
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });

  if (!res.ok) {
    throw new Error("Token exchange failed");
  }

  const data = await res.json();
  const token = data.access_token;
  const expiresIn = data.expires_in; // seconds

  const expiresAt = Date.now() + (expiresIn - 60) * 1000;
  localStorage.setItem("spotify_access_token", token);
  localStorage.setItem("spotify_token_expires_at", String(expiresAt));

  return token;
}

function loadStoredToken() {
  const token = localStorage.getItem("spotify_access_token");
  const expires = Number(localStorage.getItem("spotify_token_expires_at") || 0);
  if (!token || !expires || Date.now() > expires) return null;
  return token;
}

// ====== SPOTIFY DATA HELPERS ======
function extractAlbumIdFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("album");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    const match = rawUrl.match(/spotify:album:([a-zA-Z0-9]+)/);
    if (match) return match[1];
  }
  return null;
}

function extractTrackIdFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("track");
    if (idx !== -1 && parts[idx + 1]) return parts[idx + 1];
  } catch {
    const match = rawUrl.match(/spotify:track:([a-zA-Z0-9]+)/);
    if (match) return match[1];
  }
  return null;
}

async function fetchAlbum(albumId) {
  const res = await fetch(`${BACKEND_BASE_URL}/album/${albumId}`);
  if (!res.ok) {
    throw new Error("Failed to fetch album: " + res.status);
  }
  return await res.json();
}

async function fetchTrack(trackId) {
  const res = await fetch(`${BACKEND_BASE_URL}/track/${trackId}`);
  if (!res.ok) {
    throw new Error("Failed to fetch track: " + res.status);
  }
  return await res.json();
}

// ====== DRAW HELPERS ======
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/**
 * Simple k-means palette extractor in RGB space.
 */
async function extractPaletteFromImage(img, k = 4) {
  const sampleSize = 80;
  const offCanvas = document.createElement("canvas");
  const offCtx = offCanvas.getContext("2d");
  offCanvas.width = sampleSize;
  offCanvas.height = sampleSize;

  offCtx.drawImage(img, 0, 0, sampleSize, sampleSize);
  const imageData = offCtx.getImageData(0, 0, sampleSize, sampleSize);
  const data = imageData.data;

  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue;
    pixels.push([r, g, b]);
  }

  if (pixels.length === 0) {
    return ["#bbbbbb", "#888888", "#555555", "#222222"].slice(0, k);
  }

  const centers = [];
  for (let i = 0; i < k; i++) {
    centers.push(pixels[Math.floor(Math.random() * pixels.length)].slice());
  }

  const maxIters = 8;
  for (let iter = 0; iter < maxIters; iter++) {
    const clusters = Array.from({ length: k }, () => []);
    for (let p = 0; p < pixels.length; p++) {
      const [r, g, b] = pixels[p];
      let bestIdx = 0;
      let bestDist = Infinity;
      for (let c = 0; c < k; c++) {
        const [cr, cg, cb] = centers[c];
        const dr = r - cr;
        const dg = g - cg;
        const db = b - cb;
        const dist = dr * dr + dg * dg + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = c;
        }
      }
      clusters[bestIdx].push(pixels[p]);
    }
    for (let c = 0; c < k; c++) {
      const cluster = clusters[c];
      if (cluster.length === 0) continue;
      let sumR = 0,
        sumG = 0,
        sumB = 0;
      for (let i = 0; i < cluster.length; i++) {
        sumR += cluster[i][0];
        sumG += cluster[i][1];
        sumB += cluster[i][2];
      }
      centers[c][0] = Math.round(sumR / cluster.length);
      centers[c][1] = Math.round(sumG / cluster.length);
      centers[c][2] = Math.round(sumB / cluster.length);
    }
  }

  const counts = new Array(k).fill(0);
  for (let p = 0; p < pixels.length; p++) {
    const [r, g, b] = pixels[p];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let c = 0; c < k; c++) {
      const [cr, cg, cb] = centers[c];
      const dr = r - cr;
      const dg = g - cg;
      const db = b - cb;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = c;
      }
    }
    counts[bestIdx]++;
  }

  const indexed = centers.map((rgb, idx) => ({ rgb, count: counts[idx] }));
  indexed.sort((a, b) => b.count - a.count);

  const palette = indexed.map(({ rgb: [r, g, b] }) => {
    const maxChannel = Math.max(r, g, b);
    if (maxChannel > 245) {
      const scale = 245 / maxChannel;
      r = Math.round(r * scale);
      g = Math.round(g * scale);
      b = Math.round(b * scale);
    }
    return `rgb(${r}, ${g}, ${b})`;
  });

  return palette.slice(0, k);
}

// ====== CORE DRAW (SHARED LAYOUT) ======
// ====== CORE DRAW (SHARED LAYOUT) ======
async function drawPosterCommon(options) {
  const {
    isAlbum,
    songOrAlbumName,
    artistName,
    imageUrl,
    totalDurationMs,
    releaseDate,
    label,
    tracksForTracklist, // array of track names, or null for "no tracklist"
    spotifyUri,
    showSpotifyCode,
    codeDescription,
  } = options;

  updateCanvasSizeForMode();
  const ctx = posterCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, posterCanvas.width, posterCanvas.height);

  const { width: posterWIn, height: posterHIn } = getPosterSizeIn();
  const W = posterWIn * unitsPerInch;
  const H = posterHIn * unitsPerInch;
  const scaleX = posterCanvas.width / W;
  const scaleY = posterCanvas.height / H;
  ctx.scale(scaleX, scaleY);

  // helper: wrap description under Spotify code
  function drawWrappedCenteredText(text, centerX, firstLineY, maxWidth, lineHeight) {
    if (!text) return;
    text = '"' + text + '"';
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return;

    let line = "";
    let y = firstLineY;

    for (let i = 0; i < words.length; i++) {
      const testLine = line ? line + " " + words[i] : words[i];
      const w = ctx.measureText(testLine).width;
      if (w > maxWidth && line) {
        ctx.fillText(line, centerX, y);
        line = words[i];
        y += lineHeight;
      } else {
        line = testLine;
      }
    }

    if (line) {
      ctx.fillText(line, centerX, y);
    }
  }

  // helper: draw title with optional wrap + smaller font when wrapping.
  // Returns the y-position to use for the artist baseline, but keeps
  // the total block height constant so the rest of the layout doesn't move.
  function drawTitleWithOptionalWrap(title, startX, startY, maxWidthForWrap) {
    const baseFontSize = unitsPerInch * 0.45;   // original title size
    const wrapFontSize = unitsPerInch * 0.38;   // slightly smaller when wrapping
    const titleBlockHeight = unitsPerInch * 0.5; // same vertical band as before

    ctx.fillStyle = "#000000";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";

    // First, try with base size and see if it fits.
    ctx.font = `700 ${baseFontSize}px "Inter", system-ui, sans-serif`;

    if (!maxWidthForWrap) {
      // No code on the right: just draw one line at full size.
      ctx.fillText(title, startX, startY);
      return startY + titleBlockHeight;
    }

    const fullWidth = ctx.measureText(title).width;
    if (fullWidth <= maxWidthForWrap) {
      // Fits: same as original behaviour.
      ctx.fillText(title, startX, startY);
      return startY + titleBlockHeight;
    }

    // Needs wrapping → use smaller font and up to two lines.
    ctx.font = `700 ${wrapFontSize}px "Inter", system-ui, sans-serif`;
    const words = title.split(/\s+/);
    let line1 = "";
    let splitIndex = words.length;

    for (let i = 0; i < words.length; i++) {
      const test = line1 ? line1 + " " + words[i] : words[i];
      if (ctx.measureText(test).width <= maxWidthForWrap) {
        line1 = test;
      } else {
        splitIndex = i;
        break;
      }
    }

    if (!line1) {
      // Single gigantic word; fall back to one line with smaller font.
      ctx.fillText(title, startX, startY);
      return startY + titleBlockHeight;
    }

    const line2 = words.slice(splitIndex).join(" ");
    const lineHeight = wrapFontSize * 1.15;

    if (line2) {
      // Two lines centered in the fixed block height
      const totalLinesHeight = lineHeight;
      const firstY = startY;
      const secondY = firstY + lineHeight;

      ctx.fillText(line1, startX, firstY);
      ctx.fillText(line2, startX, secondY);
    } else {
      // Only one line but still with smaller font
      ctx.fillText(line1, startX, startY);
    }

    // Artist still starts the same distance below the "title block"
    return startY + titleBlockHeight + 0.15 * unitsPerInch;
  }

  // ****************
  // LAYOUT CONSTANTS
  // ****************
  const cornerRounding = 0.02;
  const paletteColors = 4;
  const gapBelowImage = unitsPerInch * 0.75;
  const paddingX = W * 0.06;
  const barHeight = unitsPerInch * 0.12;

  // Background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // Load image + palette
  let img = null;
  let palette = ["#bbbbbb", "#888888", "#555555", "#222222"];
  if (imageUrl) {
    img = await loadImage(imageUrl);
    palette = await extractPaletteFromImage(img, paletteColors);
  }

  // ==== TOP: full-width image with rounded corners ====
  let imageBottom = 0;
  if (img) {
    const aspect = img.width / img.height;
    const drawW = W;
    const drawH = drawW / aspect;
    const x = 0;
    const y = 0;

    const radius = W * cornerRounding;

    ctx.save();
    roundRect(ctx, x, y, drawW, drawH, radius);
    ctx.clip();
    ctx.drawImage(img, x, y, drawW, drawH);
    ctx.restore();

    imageBottom = y + drawH;
  } else {
    imageBottom = H * 0.6;
  }

  let cursorY = imageBottom + gapBelowImage;

  // Duration label (album total or track length)
  const totalSeconds = Math.round(totalDurationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const durationLabel = `${minutes}:${seconds}`;

  // Max title width when a code is present on the right
  const titleMaxWidthWhenCode =
    spotifyUri && showSpotifyCode
      ? W - paddingX - (spotifyCodeMaxWidth + unitsPerInch * 0.5)
      : null;

  // ==== TITLE / ARTIST / TOP-RIGHT SECTION ====
  if (isAlbum) {
    // Title (wrap + shrink if needed)
    cursorY = drawTitleWithOptionalWrap(
      songOrAlbumName,
      paddingX,
      cursorY,
      titleMaxWidthWhenCode
    );

    // Artist
    ctx.font = `400 ${unitsPerInch * 0.32}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "#444";
    ctx.textAlign = "left";
    ctx.fillText(artistName, paddingX, cursorY);

    // Right side: album label or code
    if (spotifyUri && showSpotifyCode) {
      const codeUrl = `https://scannables.scdn.co/uri/plain/png/FFFFFF/black/640/${encodeURIComponent(
        spotifyUri
      )}`;
      try {
        const codeImg = await loadImage(codeUrl);
        const scale = Math.min(
          spotifyCodeMaxWidth / codeImg.width,
          spotifyCodeMaxHeight / codeImg.height
        );

        const drawW = codeImg.width * scale;
        const drawH = codeImg.height * scale;

        const anchorX = W - paddingX;
        const anchorY = imageBottom + gapBelowImage;

        const drawX = anchorX - drawW;
        const drawY = anchorY - drawH / 2;

        ctx.drawImage(codeImg, drawX, drawY, drawW, drawH);

        if (codeDescription) {
          ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#555";

          const centerX = drawX + drawW / 2;
          const firstLineY = drawY + drawH + unitsPerInch * 0.1;
          const maxTextWidth = drawW;
          const lineHeight = unitsPerInch * 0.22;

          drawWrappedCenteredText(
            codeDescription,
            centerX,
            firstLineY,
            maxTextWidth,
            lineHeight
          );
        }
      } catch (e) {
        console.error("Failed to load Spotify code image", e);
        ctx.textAlign = "right";
        ctx.fillStyle = "#555";
        ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
        ctx.fillText(
          "ALBUM BY " + artistName.toUpperCase(),
          W - paddingX,
          imageBottom + gapBelowImage + unitsPerInch * 0.1
        );
      }
    } else {
      ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
      ctx.textAlign = "right";
      ctx.fillStyle = "#555";
      ctx.fillText(
        "ALBUM BY " + artistName.toUpperCase(),
        W - paddingX,
        imageBottom + gapBelowImage + unitsPerInch * 0.1
      );
    }
  } else {
    // SONG VERSION

    // Right-hand area: code vs duration
    if (spotifyUri && showSpotifyCode) {
      const codeUrl = `https://scannables.scdn.co/uri/plain/png/FFFFFF/black/640/${encodeURIComponent(
        spotifyUri
      )}`;
      try {
        const codeImg = await loadImage(codeUrl);
        const scale = Math.min(
          spotifyCodeMaxWidth / codeImg.width,
          spotifyCodeMaxHeight / codeImg.height
        );

        const drawW = codeImg.width * scale;
        const drawH = codeImg.height * scale;

        const anchorX = W - paddingX;
        const anchorY = imageBottom + gapBelowImage;

        const drawX = anchorX - drawW;
        const drawY = anchorY - drawH / 2;

        ctx.drawImage(codeImg, drawX, drawY, drawW, drawH);

        if (codeDescription) {
          ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
          ctx.textAlign = "center";
          ctx.fillStyle = "#555";

          const centerX = drawX + drawW / 2;
          const firstLineY = drawY + drawH + unitsPerInch * 0.1;
          const maxTextWidth = drawW;
          const lineHeight = unitsPerInch * 0.22;

          drawWrappedCenteredText(
            codeDescription,
            centerX,
            firstLineY,
            maxTextWidth,
            lineHeight
          );
        }
      } catch (e) {
        console.error("Failed to load Spotify code image", e);
        ctx.textAlign = "right";
        ctx.fillStyle = "#555";
        ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
        ctx.fillText(
          "SONG BY " + artistName.toUpperCase(),
          W - paddingX,
          imageBottom + gapBelowImage * 0.85
        );
        ctx.fillText(
          durationLabel,
          W - paddingX,
          imageBottom + gapBelowImage * 1.1
        );
      }
    } else {
      ctx.textAlign = "right";
      ctx.fillStyle = "#555";
      ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
        ctx.fillText(
          "SONG BY " + artistName.toUpperCase(),
          W - paddingX,
          imageBottom + gapBelowImage * 0.85
        );
        ctx.fillText(
          durationLabel,
          W - paddingX,
          imageBottom + gapBelowImage * 1.1
        );
    }
    // Title (wrap + shrink if needed)
    cursorY = drawTitleWithOptionalWrap(
      songOrAlbumName,
      paddingX,
      cursorY,
      titleMaxWidthWhenCode ?? W - paddingX - (ctx.measureText("SONG BY " + artistName.toUpperCase()).width + unitsPerInch * 0.5)
    );
    // Artist
    ctx.font = `400 ${unitsPerInch * 0.32}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "#444";
    ctx.textAlign = "left";
    ctx.fillText(artistName, paddingX, cursorY);

  }

  // ==== COLOR BAR ====
  const barTop = isAlbum ? cursorY + unitsPerInch * 0.6 : H - unitsPerInch * 0.6;
  const barWidth = W - 2 * paddingX;
  const barX = paddingX;

  const nSegments = palette.length;
  const segmentWidth = barWidth / nSegments;

  for (let i = 0; i < nSegments; i++) {
    ctx.fillStyle = palette[i];
    ctx.fillRect(barX + i * segmentWidth, barTop, segmentWidth, barHeight);
  }

  let trackStartY = barTop + barHeight + unitsPerInch * 0.9;

  // ==== TRACKLIST (only if we have tracks) ====
  if (tracksForTracklist && tracksForTracklist.length > 0) {
    ctx.textAlign = "left";
    ctx.fillStyle = "#000";
    ctx.font = `600 ${unitsPerInch * 0.24}px "Inter", system-ui, sans-serif`;
    ctx.fillText("TRACKLIST", paddingX, trackStartY);

    trackStartY += unitsPerInch * 0.5;
    ctx.font = `400 ${unitsPerInch * 0.22}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "#333";

    const trackTextMaxWidth = W - 2 * paddingX;
    const lineSpacing = unitsPerInch * 0.3;
    let trackY = trackStartY;

    const separator = "  |  ";
    let currentLine = "";

    function flushLine() {
      if (!currentLine) return;
      ctx.fillText(currentLine, paddingX, trackY);
      trackY += lineSpacing;
      currentLine = "";
    }

    for (let i = 0; i < tracksForTracklist.length; i++) {
      const t = tracksForTracklist[i];
      const nextPart = currentLine ? currentLine + separator + t : t;
      const width = ctx.measureText(nextPart).width;
      if (width > trackTextMaxWidth && currentLine) {
        flushLine();
        currentLine = t;
      } else {
        currentLine = nextPart;
      }
    }
    flushLine();
  }

  // ==== FOOTER ====
  if (isAlbum) {
    const footerY = H - unitsPerInch * 0.8;
    ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
    ctx.fillStyle = "#777";
    ctx.textAlign = "left";
    ctx.fillText(`RELEASE DATE: ${releaseDate}`, paddingX, footerY);
    ctx.fillText(
      `RECORD LABEL: ${label || ""}`,
      paddingX,
      footerY + unitsPerInch * 0.3
    );
  }

  // ==== TAGLINE (bottom-right) ====
  ctx.textAlign = "right";
  ctx.font = `400 ${unitsPerInch * 0.14}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#bbb";
  ctx.fillText(
    "https://elijah-bodden.github.io/album-posters/",
    W - unitsPerInch * 0.15,
    H - unitsPerInch * 0.15
  );
}

// Album-specific wrapper
async function drawAlbumPoster(albumData, showSpotifyCode, codeDescription) {
  const imageUrl =
    (albumData.images && albumData.images[0] && albumData.images[0].url) || null;
  const artistName = (albumData.artists || []).map((a) => a.name).join(", ");
  const songOrAlbumName = albumData.name;
  console.log(albumData);
  const totalDurationMs = albumData.tracks.items.reduce(
    (sum, t) => sum + t.duration_ms,
    0
  );
  const tracks = albumData.tracks.items.map((t) => t.name);
  const releaseDate = albumData.release_date;
  const label = albumData.label || "";

  await drawPosterCommon({
    isAlbum: true,
    songOrAlbumName,
    artistName,
    imageUrl,
    totalDurationMs,
    releaseDate,
    label,
    tracksForTracklist: tracks,
    spotifyUri: albumData.uri,
    showSpotifyCode,
    codeDescription,
  });
}

// Song-specific wrapper (no tracklist)
async function drawSongPoster(trackData, showSpotifyCode, codeDescription) {
  const album = trackData.album;
  const imageUrl =
    (album.images && album.images[0] && album.images[0].url) || null;

  const songOrAlbumName = trackData.name;
  const artistName = (trackData.artists || []).map((a) => a.name).join(", ");
  const releaseDate = album.release_date;
  const label = "";
  console.log(trackData);

  await drawPosterCommon({
    isAlbum: false,
    songOrAlbumName,
    artistName,
    imageUrl,
    totalDurationMs: trackData.duration_ms,
    releaseDate,
    label,
    tracksForTracklist: null,
    spotifyUri: trackData.uri,
    showSpotifyCode,
    codeDescription,
  });
}

// ====== EVENTS ======
modeRadios.forEach((radio) => {
  radio.addEventListener("change", () => {
    currentMode = radio.value;
    updateCanvasSizeForMode();
    updateDownloadLabel();
    if (currentMode === "album") {
      urlLabel.textContent = "Spotify album URL";
      albumUrlInput.placeholder = "https://open.spotify.com/album/...";
    } else {
      urlLabel.textContent = "Spotify track URL";
      albumUrlInput.placeholder = "https://open.spotify.com/track/...";
    }
  });
});

// Show/hide description input based on checkbox
if (showCodeCheckbox && codeDescriptionWrapper) {
  const toggleDesc = () => {
    codeDescriptionWrapper.style.display = showCodeCheckbox.checked ? "" : "none";
  };
  showCodeCheckbox.addEventListener("change", toggleDesc);
  toggleDesc();
}

albumForm.addEventListener("submit", async (e) => {
  e.preventDefault();

  const url = albumUrlInput.value.trim();
  const showSpotifyCode = !!(showCodeCheckbox && showCodeCheckbox.checked);
  const codeDescription = (codeDescriptionInput?.value || "").trim().slice(0, 60);

  try {
    downloadButton.disabled = true;

    if (currentMode === "album") {
      const albumId = extractAlbumIdFromUrl(url);
      if (!albumId) {
        alert("Couldn't parse album ID from that URL.");
        downloadButton.disabled = false;
        return;
      }
      authStatus.textContent = "Fetching album…";
      const album = await fetchAlbum(albumId);
      await drawAlbumPoster(album, showSpotifyCode, codeDescription);
      authStatus.textContent = `Loaded album "${album.name}"`;
    } else {
      const trackId = extractTrackIdFromUrl(url);
      if (!trackId) {
        alert("Couldn't parse track ID from that URL.");
        downloadButton.disabled = false;
        return;
      }
      authStatus.textContent = "Fetching track…";
      const track = await fetchTrack(trackId);
      await drawSongPoster(track, showSpotifyCode, codeDescription);
      authStatus.textContent = `Loaded song "${track.name}"`;
    }

    downloadButton.disabled = false;
  } catch (err) {
    console.error(err);
    authStatus.textContent = "Error fetching data.";
    downloadButton.disabled = false;
  }
});

downloadButton.addEventListener("click", () => {
  posterCanvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const { width, height } = getPosterSizeIn();
      a.href = url;
      a.download = `spotify-poster-${width}x${height}-in.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    "image/png",
    1.0
  );
});
