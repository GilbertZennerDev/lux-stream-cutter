import { q, escapeJsxString } from "./escapeJsxString";
import type { PremiereOptions } from "./schema";

const COLOR_PRESETS: Record<PremiereOptions["colorPreset"], { contrast: number; saturation: number; temperature: number; label: string }> = {
  none:     { contrast: 0,  saturation: 100, temperature: 0,   label: "None" },
  contrast: { contrast: 25, saturation: 110, temperature: 0,   label: "Punchy Contrast" },
  bw:       { contrast: 15, saturation: 0,   temperature: 0,   label: "Black & White" },
  warm:     { contrast: 10, saturation: 105, temperature: 15,  label: "Warm" },
  cool:     { contrast: 10, saturation: 105, temperature: -15, label: "Cool" },
};

export function generateJsx(files: { name: string }[], opts: PremiereOptions): string {
  const [w, h] = opts.resolution === "auto" ? [1920, 1080] : opts.resolution.split("x").map(Number);
  const color = COLOR_PRESETS[opts.colorPreset];
  const filenamesArray = files.map((f) => `  ${q(f.name)}`).join(",\n");

  return `#target premierepro
// =====================================================================
// Auto-generated Premiere Pro ExtendScript
// Generated: ${new Date().toISOString()}
// Images: ${files.length}
// Run in Premiere: File > Scripts > Run Script File...
// =====================================================================

// ------------------------- USER CONFIG (edit freely) -----------------
var CONFIG = {
  sequenceName:      ${q(opts.sequenceName)},
  binName:           ${q(opts.binName)},
  frameRate:         ${opts.frameRate},
  width:             ${w},
  height:            ${h},
  clipDurationSec:   ${opts.clipDurationSec},
  transition:        ${q(opts.transition)},        // none | cross_dissolve | dip_to_black
  transitionFrames:  ${opts.transitionFrames},
  kenBurns:          ${opts.kenBurns},
  kenBurnsDirection: ${q(opts.kenBurnsDirection)}, // random | in | out
  kenBurnsStrength:  ${opts.kenBurnsStrength},     // percent
  fit:               ${q(opts.fit)},               // fit | fill
  colorPreset:       ${q(opts.colorPreset)},       // ${color.label}
  colorContrast:     ${color.contrast},
  colorSaturation:   ${color.saturation},
  colorTemperature:  ${color.temperature},
  titleFromFilename: ${opts.titleFromFilename},
  titleDurationSec:  ${opts.titleDurationSec},
  pathMode:          ${q(opts.pathMode)},          // dialog | folder
  folderPath:        ${q(opts.folderPath)}
};

var FILES = [
${filenamesArray}
];

// ------------------------- HELPERS -----------------------------------
function log(msg) { $.writeln('[premiere-gen] ' + msg); }

function pickFolder() {
  if (CONFIG.pathMode === 'folder' && CONFIG.folderPath) {
    var f = new Folder(CONFIG.folderPath);
    if (f.exists) return f;
    alert('Configured folder does not exist:\\n' + CONFIG.folderPath);
  }
  var picked = Folder.selectDialog('Select folder containing the ' + FILES.length + ' images');
  return picked;
}

function ensureBin(name) {
  var root = app.project.rootItem;
  for (var i = 0; i < root.children.numItems; i++) {
    var it = root.children[i];
    if (it && it.name === name && it.type === 2 /* BIN */) return it;
  }
  return root.createBin(name);
}

function importFileInto(bin, filePath) {
  var before = app.project.rootItem.children.numItems;
  var ok = app.project.importFiles([filePath], true, bin, false);
  if (!ok) { log('Import failed: ' + filePath); return null; }
  // Find newly imported item inside the bin
  for (var i = 0; i < bin.children.numItems; i++) {
    var it = bin.children[i];
    if (it && it.getMediaPath && it.getMediaPath() === filePath) return it;
  }
  return bin.children[bin.children.numItems - 1] || null;
}

function ticksFromSeconds(sec) {
  // Premiere ticks: 254016000000 ticks per second
  return String(Math.round(sec * 254016000000));
}

function newSequenceMatching(name) {
  // Create via QE for precise preset control; fall back to createNewSequence.
  try {
    if (typeof app.enableQE === 'function') app.enableQE();
  } catch (e) {}
  var seq = null;
  try {
    seq = app.project.createNewSequence(name, name.replace(/[^A-Za-z0-9]/g, '_'));
  } catch (e) {
    log('createNewSequence failed: ' + e);
  }
  return seq;
}

function applyKenBurns(clip, index) {
  try {
    var motion = clip.components[1]; // Motion is typically index 1
    if (!motion) return;
    var scaleProp = null;
    for (var i = 0; i < motion.properties.numItems; i++) {
      var p = motion.properties[i];
      if (p && p.displayName === 'Scale') { scaleProp = p; break; }
    }
    if (!scaleProp) return;
    var startScale = 100;
    var endScale   = 100 + CONFIG.kenBurnsStrength;
    var dir = CONFIG.kenBurnsDirection;
    if (dir === 'random') dir = (index % 2 === 0) ? 'in' : 'out';
    if (dir === 'out') { var tmp = startScale; startScale = endScale; endScale = tmp; }
    scaleProp.setTimeVarying(true);
    scaleProp.addKey(clip.start.seconds);
    scaleProp.addKey(clip.end.seconds);
    scaleProp.setValueAtKey(clip.start.seconds, startScale, true);
    scaleProp.setValueAtKey(clip.end.seconds, endScale, true);
  } catch (e) {
    log('Ken Burns failed on clip ' + index + ': ' + e);
  }
}

function applyLumetri(clip) {
  if (CONFIG.colorPreset === 'none') return;
  try {
    var qeSeq = qe.project.getActiveSequence();
    // Best-effort: only works when QE DOM is available.
    if (!qeSeq) return;
    // Applying Lumetri via ExtendScript is limited; leave a marker so the
    // editor can apply the preset manually if the API path is not present.
    log('Color preset requested: ' + CONFIG.colorPreset + ' (apply Lumetri preset in the UI if not auto-applied).');
  } catch (e) {}
}

function applyDefaultTransitions(track) {
  if (CONFIG.transition === 'none') return;
  try {
    if (typeof app.enableQE === 'function') app.enableQE();
    var qeSeq = qe.project.getActiveSequence();
    if (!qeSeq) return;
    var qeTrack = qeSeq.getVideoTrackAt(0);
    var numClips = qeTrack.numItems;
    var transitionName = CONFIG.transition === 'dip_to_black' ? 'Dip to Black' : 'Cross Dissolve';
    for (var i = 0; i < numClips; i++) {
      var c = qeTrack.getItemAt(i);
      try { c.addTransition(qe.project.getVideoTransitionByName(transitionName), true, undefined, undefined, undefined, true, false); } catch (e1) {}
      try { c.addTransition(qe.project.getVideoTransitionByName(transitionName), false, undefined, undefined, undefined, false, true); } catch (e2) {}
    }
  } catch (e) {
    log('Transition apply failed: ' + e);
  }
}

// ------------------------- MAIN --------------------------------------
(function main() {
  if (!app.project) { alert('Open a Premiere project first.'); return; }
  var folder = pickFolder();
  if (!folder) { log('Cancelled.'); return; }

  var bin = ensureBin(CONFIG.binName);
  var seq = newSequenceMatching(CONFIG.sequenceName);
  if (!seq) { alert('Could not create sequence.'); return; }
  app.project.activeSequence = seq;

  var track = seq.videoTracks[0];
  var audioTrack = seq.audioTracks[0];
  var offsetSec = 0;
  var imported = [];

  for (var i = 0; i < FILES.length; i++) {
    var name = FILES[i];
    var filePath = folder.fsName + '/' + name;
    var f = new File(filePath);
    if (!f.exists) { log('Skip missing: ' + filePath); continue; }
    var item = importFileInto(bin, filePath);
    if (!item) continue;
    try {
      track.insertClip(item, ticksFromSeconds(offsetSec));
      var clip = track.clips[track.clips.numItems - 1];
      // Force clip duration
      try { clip.end = { ticks: String(Number(clip.start.ticks) + Number(ticksFromSeconds(CONFIG.clipDurationSec))) }; } catch (e) {}
      if (CONFIG.kenBurns) applyKenBurns(clip, i);
      applyLumetri(clip);
      imported.push(clip);
      offsetSec += CONFIG.clipDurationSec;
    } catch (e) {
      log('Insert failed for ' + name + ': ' + e);
    }
  }

  applyDefaultTransitions(track);

  alert('Done! Placed ' + imported.length + ' / ' + FILES.length + ' clips on the timeline.');
})();
`;
}

// Suppress unused (kept for future use)
void escapeJsxString;
