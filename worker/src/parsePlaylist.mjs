// Minimal HLS m3u8 parser, mirroring src/lib/hls/parsePlaylist.ts.
function resolveUrl(base, ref) {
  try { return new URL(ref, base).toString(); } catch { return ref; }
}

export function isMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/i.test(text);
}

function parseAttrs(attrs) {
  const out = {};
  const parts = attrs.match(/[A-Z0-9-]+=(?:"[^"]*"|[^,]+)/gi) ?? [];
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim().toUpperCase();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = parseAttrs(line.substring(line.indexOf(":") + 1));
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].startsWith("#"))) j++;
      const uri = lines[j]?.trim();
      if (uri) {
        variants.push({
          url: resolveUrl(baseUrl, uri),
          bandwidth: Number(attrs.BANDWIDTH ?? 0) || 0,
          resolution: attrs.RESOLUTION,
        });
      }
    }
  }
  return variants;
}

export function parseMedia(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segments = [];
  let targetDuration = 6;
  let endList = false;
  let expectSegment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-TARGETDURATION")) {
      targetDuration = Number(line.split(":")[1]) || 6;
    } else if (line.startsWith("#EXT-X-ENDLIST")) {
      endList = true;
    } else if (line.startsWith("#EXTINF")) {
      expectSegment = true;
    } else if (!line.startsWith("#") && expectSegment) {
      segments.push(resolveUrl(baseUrl, line));
      expectSegment = false;
    }
  }
  return { segments, targetDuration, endList };
}
