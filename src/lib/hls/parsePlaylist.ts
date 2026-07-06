// Minimal HLS m3u8 parser: enough to pick a variant from a master and
// extract ordered segment URIs from a media playlist.

export interface Variant {
  url: string;
  bandwidth: number;
  resolution?: string;
}

export interface MediaPlaylist {
  segments: string[]; // absolute URLs
  mediaSequence: number;
  targetDuration: number;
  endList: boolean;
}

function resolveUrl(base: string, ref: string): string {
  try {
    return new URL(ref, base).toString();
  } catch {
    return ref;
  }
}

export function isMasterPlaylist(text: string): boolean {
  return /#EXT-X-STREAM-INF/i.test(text);
}

export function parseMaster(text: string, baseUrl: string): Variant[] {
  const lines = text.split(/\r?\n/);
  const variants: Variant[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const attrs = line.substring(line.indexOf(":") + 1);
      const bwMatch = attrs.match(/BANDWIDTH=(\d+)/i);
      const resMatch = attrs.match(/RESOLUTION=([0-9x]+)/i);
      // Find the next non-comment, non-empty line
      let j = i + 1;
      while (j < lines.length && (lines[j].trim() === "" || lines[j].startsWith("#"))) j++;
      const uri = lines[j]?.trim();
      if (uri) {
        variants.push({
          url: resolveUrl(baseUrl, uri),
          bandwidth: bwMatch ? Number(bwMatch[1]) : 0,
          resolution: resMatch ? resMatch[1] : undefined,
        });
      }
    }
  }
  return variants;
}

export function parseMedia(text: string, baseUrl: string): MediaPlaylist {
  const lines = text.split(/\r?\n/);
  const segments: string[] = [];
  let mediaSequence = 0;
  let targetDuration = 6;
  let endList = false;
  let expectSegment = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE")) {
      mediaSequence = Number(line.split(":")[1]) || 0;
    } else if (line.startsWith("#EXT-X-TARGETDURATION")) {
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
  return { segments, mediaSequence, targetDuration, endList };
}
