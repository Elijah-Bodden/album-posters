// ====== CONFIG ======
const SPOTIFY_CLIENT_ID = "9cf70d0696ac4e59af60645e76f90744";
// When using GitHub Pages, set this to the *exact* HTTPS URL of index.html.
const REDIRECT_URI = "https://elijah-bodden.github.io/album-posters";

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

  // Logical coordinate system in points; 100 units per inch just to get nicer numbers.
  const unitsPerInch = 100;
  const W = POSTER_WIDTH_IN * unitsPerInch;
  const H = POSTER_HEIGHT_IN * unitsPerInch;
  const scaleX = CANVAS_WIDTH / W;
  const scaleY = CANVAS_HEIGHT / H;
  ctx.scale(scaleX, scaleY);

  // ==== BACKGROUND ====
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, W, H);

  // ==== TOP IMAGE AREA ====
  // Roughly top 60% for the album art area (like your Billie poster)
  const topAreaHeight = H * 0.6;

  // background for top area: dark toned (subtle gradient)
  const grad = ctx.createLinearGradient(0, 0, 0, topAreaHeight);
  grad.addColorStop(0, "#021427");
  grad.addColorStop(1, "#08254f");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, topAreaHeight);

  // Load album art (largest image)
  const imageUrl = (albumData.images && albumData.images[0] && albumData.images[0].url) || null;
  if (imageUrl) {
    const img = await loadImage(imageUrl);
    const aspect = img.width / img.height; // usually 1:1

    // Fit with some margin inside top area
    const marginX = W * 0.06;
    const marginY = topAreaHeight * 0.10;
    let drawW = W - 2 * marginX;
    let drawH = drawW / aspect;
    if (drawH > topAreaHeight - 2 * marginY) {
      drawH = topAreaHeight - 2 * marginY;
      drawW = drawH * aspect;
    }
    const x = (W - drawW) / 2;
    const y = (topAreaHeight - drawH) / 2;

    ctx.drawImage(img, x, y, drawW, drawH);
  }

  // ==== TEXT AREA (BOTTOM) ====
  const bottomY = topAreaHeight;
  const paddingX = W * 0.06;
  const baselineY = bottomY + unitsPerInch * 0.8; // first line of text

  // Album/artist
  const albumTitle = albumData.name;
  const artistName = (albumData.artists || []).map(a => a.name).join(", ");

  ctx.fillStyle = "#000000";
  ctx.font = `700 ${unitsPerInch * 0.45}px "Inter", system-ui, sans-serif`;
  ctx.textBaseline = "alphabetic";
  ctx.fillText(artistName, paddingX, baselineY);

  ctx.font = `400 ${unitsPerInch * 0.32}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#444";
  ctx.fillText(albumTitle, paddingX, baselineY + unitsPerInch * 0.5);

  // "THE THIRD ALBUM BY ..." style label on the right
  const rightLabel = `ALBUM BY ${artistName.toUpperCase()}`;
  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillStyle = "#555";
  ctx.fillText(rightLabel, W - paddingX, baselineY + unitsPerInch * 0.1);

  // horizontal bar with duration
  const barTop = baselineY + unitsPerInch * 0.9;
  const barHeight = unitsPerInch * 0.08;
  const barWidth = W - 2 * paddingX;
  const barX = paddingX;
  ctx.textAlign = "left";

  // grey bar
  ctx.fillStyle = "#d6d6d6";
  ctx.fillRect(barX, barTop, barWidth, barHeight);

  // colored "progress" bar (just fixed 2/3)
  ctx.fillStyle = "#3268ff";
  ctx.fillRect(barX, barTop, barWidth * 0.65, barHeight);

  // Duration label on right of bar
  const totalMs = albumData.tracks.items.reduce((sum, t) => sum + t.duration_ms, 0);
  const totalSeconds = Math.round(totalMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const durationLabel = `${minutes}:${seconds}`;

  ctx.font = `400 ${unitsPerInch * 0.2}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#000";
  ctx.textAlign = "right";
  ctx.fillText(durationLabel, barX + barWidth, barTop + barHeight + unitsPerInch * 0.4);

  // ==== TRACKLIST ====
  const tracks = albumData.tracks.items.map(t => t.name);
  const trackAreaTop = barTop + barHeight + unitsPerInch * 0.9;

  ctx.textAlign = "left";
  ctx.fillStyle = "#000";
  ctx.font = `600 ${unitsPerInch * 0.22}px "Inter", system-ui, sans-serif`;
  ctx.fillText("TRACKLIST", paddingX, trackAreaTop);

  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#333";

  const trackTextMaxWidth = W - 2 * paddingX;
  const lineSpacing = unitsPerInch * 0.3;
  let trackY = trackAreaTop + unitsPerInch * 0.5;

  const separator = "  |  ";
  // We'll try to pack several tracks per line like the reference.
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
  const releaseDate = albumData.release_date; // ISO string, may be yyyy or yyyy-mm-dd
  const label = albumData.label || "";

  ctx.font = `400 ${unitsPerInch * 0.18}px "Inter", system-ui, sans-serif`;
  ctx.fillStyle = "#777";
  ctx.textAlign = "left";
  ctx.fillText(`RELEASE DATE: ${releaseDate}`, paddingX, footerY);
  ctx.fillText(`RECORD LABEL: ${label}`, paddingX, footerY + unitsPerInch * 0.3);

  ctx.textAlign = "right";
  ctx.fillText("Generated with Album Poster Generator", W - paddingX, footerY + unitsPerInch * 0.3);
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
