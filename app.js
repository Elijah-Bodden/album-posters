// ====== CONFIG ======
const SPOTIFY_CLIENT_ID = "9cf70d0696ac4e59af60645e76f90744";
// When using GitHub Pages, set this to the *exact* HTTPS URL of index.html.
const REDIRECT_URI = "https://elijah-bodden.github.io/album-posters/";

// Poster physical size & DPI (controls output resolution)
const POSTER_WIDTH_IN = 12;
const POSTER_HEIGHT_IN = 18;
const DPI = 300;             // 300 DPI is print quality
const CANVAS_WIDTH = POSTER_WIDTH_IN * DPI;   // 3600
const CANVAS_HEIGHT = POSTER_HEIGHT_IN * DPI; // 5400

// ====== DOM ======
const loginButton = document.getElementById("loginButton");
const authStatus = document.getElementById("authStatus");
const albumForm = document.getElementById("albumForm");
const albumUrlInput = document.getElementById("albumUrl");
const posterCanvas = document.getElementById("posterCanvas");
const downloadButton = document.getElementById("downloadButton");

posterCanvas.width = CANVAS_WIDTH;
posterCanvas.height = CANVAS_HEIGHT;

let accessToken = null;

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
      scope: "user-read-email", // scope doesn't really matter for public album data
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

// ====== INITIAL AUTH HANDLING ======
async function initAuth() {
  // 1) Handle redirect from Spotify (code in search params)
  const url = new URL(window.location.href);
  const code = url.searchParams.get("code");
  if (code) {
    try {
      accessToken = await exchangeCodeForToken(code);
      url.searchParams.delete("code");
      url.searchParams.delete("state");
      window.history.replaceState({}, "", url.toString());
    } catch (err) {
      console.error(err);
      authStatus.textContent = "Failed to authenticate. Try again.";
    }
  } else {
    accessToken = loadStoredToken();
  }

  if (accessToken) {
    authStatus.textContent = "Connected to Spotify.";
    loginButton.textContent = "Reconnect";
  } else {
    authStatus.textContent = "Not connected.";
  }
}

// ====== SPOTIFY DATA ======
function extractAlbumIdFromUrl(rawUrl) {
  if (!rawUrl) return null;
  try {
    // Support full URLs like https://open.spotify.com/album/{id}?si=...
    const url = new URL(rawUrl);
    const pathParts = url.pathname.split("/").filter(Boolean);
    const idx = pathParts.indexOf("album");
    if (idx !== -1 && pathParts[idx + 1]) {
      return pathParts[idx + 1];
    }
  } catch {
    // fallback: spotify:album:ID
    const match = rawUrl.match(/spotify:album:([a-zA-Z0-9]+)/);
    if (match) return match[1];
  }
  return null;
}

async function fetchAlbum(albumId) {
  if (!accessToken) throw new Error("No access token");

  const res = await fetch(`https://api.spotify.com/v1/albums/${albumId}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error("Failed to fetch album: " + res.status);
  }

  return await res.json();
}

// ====== CANVAS RENDERING ======
async function drawPosterForAlbum(albumData) {
  const ctx = posterCanvas.getContext("2d");
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

  // Logical coordinate system in "units"
  const unitsPerInch = 100;
  const W = POSTER_WIDTH_IN * unitsPerInch;
  const H = POSTER_HEIGHT_IN * unitsPerInch;
  const scaleX = CANVAS_WIDTH / W;
  const scaleY = CANVAS_HEIGHT / H;
  ctx.scale(scaleX, scaleY);

  // ==== BACKGROUND ====
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ==== LOAD ALBUM ART ====
  const imageUrl =
    (albumData.images && albumData.images[0] && albumData.images[0].url) || null;

  let img = null;
  let palette = ["#bbbbbb", "#888888", "#555555", "#222222"]; // fallback

  if (imageUrl) {
    img = await loadImage(imageUrl);
    // Extract 3–5 dominant colors, we'll just pick 4 for now
    palette = await extractPaletteFromImage(img, 4);
  }

  // ==== TOP AREA: FULL-SIZE COVER ====
  // Make the cover span the full width; Spotify covers are square,
  // so height ~= width. We draw it at the top with no colored background.
  let imageBottom = 0;
  if (img) {
    const aspect = img.width / img.height; // ~1
    const drawW = W;
    const drawH = drawW / aspect;
    const x = 0;
    const y = 0;
    ctx.drawImage(img, x, y, drawW, drawH);
    imageBottom = y + drawH;
  } else {
    imageBottom = H * 0.6; // fallback if no img, unlikely
  }

  // Small vertical gap between image and text area
  const gapBelowImage = unitsPerInch * 0.4;
  const textStartY = imageBottom + gapBelowImage;

  // ==== TEXT AREA (BOTTOM) ====
  const paddingX = W * 0.06;
  let cursorY = textStartY;

  // Album / artist
  const albumTitle = albumData.name;
  const artistName = (albumData.artists || [])
    .map((a) => a.name)
    .join(", ");

  // Artist name (big, bold)
  ctx.fillStyle = "#000000";
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.font = `700 ${unitsPerInch * 0.45}px "Inter", system-ui, sans-serif`;
  ctx.fillText(artistName, paddingX, cursorY);
  cursorY += unitsPerInch * 0.5;

  // Album title (smaller, lighter)
  ctx.font = `400 ${unitsPerInch * 0.32}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#444";
  ctx.fillText(albumTitle, paddingX, cursorY);

  // "ALBUM BY ..." label on the right, aligned roughly with artist line
  const rightLabel = `ALBUM BY ${artistName.toUpperCase()}`;
  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillStyle = "#555";
  ctx.fillText(rightLabel, W - paddingX, textStartY + unitsPerInch * 0.1);

  // ==== COLOR BAR (PALETTE-BASED) ====
  // Compute bar geometry
  const barTop = cursorY + unitsPerInch * 0.6;
  const barHeight = unitsPerInch * 0.12;
  const barWidth = W - 2 * paddingX;
  const barX = paddingX;

  // Draw segmented bar: equal-length segments from dominant colors
  const nSegments = palette.length;
  const segmentWidth = barWidth / nSegments;

  for (let i = 0; i < nSegments; i++) {
    ctx.fillStyle = palette[i];
    ctx.fillRect(barX + i * segmentWidth, barTop, segmentWidth, barHeight);
  }

  // Duration label to the right below the bar
  const totalMs = albumData.tracks.items.reduce(
    (sum, t) => sum + t.duration_ms,
    0
  );
  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const durationLabel = `${minutes}:${seconds}`;

  ctx.font = `400 ${unitsPerInch * 0.2}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#000";
  ctx.textAlign = "right";
  ctx.fillText(
    durationLabel,
    barX + barWidth,
    barTop + barHeight + unitsPerInch * 0.5
  );

  // Advance cursor below the bar + duration
  let trackStartY = barTop + barHeight + unitsPerInch * 0.9;

  // ==== TRACKLIST ====
  const tracks = albumData.tracks.items.map((t) => t.name);

  ctx.textAlign = "left";
  ctx.fillStyle = "#000";
  ctx.font = `600 ${unitsPerInch * 0.22}px "Inter", system-ui, sans-serif`;
  ctx.fillText("TRACKLIST", paddingX, trackStartY);

  trackStartY += unitsPerInch * 0.5;
  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
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

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
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

  // ==== FOOTER (release date / label) ====
  const footerY = H - unitsPerInch * 0.8;
  const releaseDate = albumData.release_date;
  const label = albumData.label || "";

  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#777";
  ctx.textAlign = "left";
  ctx.fillText(`RELEASE DATE: ${releaseDate}`, paddingX, footerY);
  ctx.fillText(
    `RECORD LABEL: ${label}`,
    paddingX,
    footerY + unitsPerInch * 0.3
  );

  ctx.textAlign = "right";
  ctx.fillText(
    "Generated with Album Poster Generator",
    W - paddingX,
    footerY + unitsPerInch * 0.3
  );
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

/**
 * Extract a small palette of dominant colors from an image using
 * a simple k-means clustering over RGB space.
 *
 * @param {HTMLImageElement} img
 * @param {number} k - number of colors (3–5 recommended)
 * @returns {Promise<string[]>} - array of CSS color strings
 */
async function extractPaletteFromImage(img, k = 4) {
  // Downscale to keep it cheap
  const sampleSize = 80; // 80x80 = 6400 pixels max
  const offCanvas = document.createElement("canvas");
  const offCtx = offCanvas.getContext("2d");

  offCanvas.width = sampleSize;
  offCanvas.height = sampleSize;

  offCtx.drawImage(img, 0, 0, sampleSize, sampleSize);
  const imageData = offCtx.getImageData(0, 0, sampleSize, sampleSize);
  const data = imageData.data;

  // Collect RGB samples
  const pixels = [];
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    // Ignore fully transparent pixels
    if (a < 128) continue;
    pixels.push([r, g, b]);
  }

  if (pixels.length === 0) {
    return ["#bbbbbb", "#888888", "#555555", "#222222"].slice(0, k);
  }

  // Initialize centers by random sampling
  const centers = [];
  for (let i = 0; i < k; i++) {
    centers.push(pixels[Math.floor(Math.random() * pixels.length)].slice());
  }

  // k-means iterations
  const maxIters = 8;
  for (let iter = 0; iter < maxIters; iter++) {
    const clusters = Array.from({ length: k }, () => []);
    // Assign step
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
    // Update step
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

  // Rank centers by how many pixels they got (roughly)
  // Re-run assignment just to count
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

  // Convert to CSS colors, avoid super-near-white for visibility
  const palette = indexed.map(({ rgb: [r, g, b] }) => {
    // Slightly clamp extreme whites so they show up on white paper
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
// ====== EVENTS ======
loginButton.addEventListener("click", (e) => {
  e.preventDefault();
  redirectToSpotifyAuth();
});

albumForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!accessToken) {
    authStatus.textContent = "Connect with Spotify first.";
    return;
  }
  const url = albumUrlInput.value.trim();
  const albumId = extractAlbumIdFromUrl(url);
  if (!albumId) {
    alert("Couldn't parse album ID from that URL.");
    return;
  }

  try {
    downloadButton.disabled = true;
    authStatus.textContent = "Fetching album…";
    const album = await fetchAlbum(albumId);
    await drawPosterForAlbum(album);
    downloadButton.disabled = false;
    authStatus.textContent = `Loaded "${album.name}"`;
  } catch (err) {
    console.error(err);
    authStatus.textContent = "Error fetching album.";
  }
});

downloadButton.addEventListener("click", () => {
  posterCanvas.toBlob(
    (blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "album-poster-12x18-300dpi.png";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    "image/png",
    1.0
  );
});

// ====== BOOTSTRAP ======
initAuth();
