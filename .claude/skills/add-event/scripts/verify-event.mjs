#!/usr/bin/env node
// Verify a single static-event descriptor against the project's real code before
// you paste it into STATIC_EVENTS. Runs it through the Worker's expandStaticEvents
// (so start/end epochs are DST-correct exactly as production computes them) and
// through the client's garagesForEvent (so you see which ramps it will show on).
//
// Run from the repo root:
//   node .claude/skills/add-event/scripts/verify-event.mjs [--days N] <descriptor.json | 'inline json'>
//
// It catches the two silent failures: wrong weekday/time (you eyeball the printed
// Central datetimes) and coordinates that map to no garage (a loud warning).

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  let days = 60;
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--days") {
      days = Number(argv[++i]);
      if (!Number.isFinite(days) || days <= 0) fail(`--days needs a positive number, got ${argv[i]}`);
    } else {
      rest.push(argv[i]);
    }
  }
  if (rest.length !== 1) fail("expected exactly one descriptor (a .json file path or an inline JSON string)");
  return { days, source: rest[0] };
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function loadDescriptor(source) {
  const text = existsSync(source) ? readFileSync(source, "utf8") : source;
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`could not parse descriptor as JSON: ${err.message}`);
  }
}

async function importFromRepo(relativePath) {
  const abs = resolve(process.cwd(), relativePath);
  if (!existsSync(abs)) {
    fail(`cannot find ${relativePath} — run this from the madison-parking repo root`);
  }
  return import(pathToFileURL(abs).href);
}

const central = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short", year: "numeric", month: "short", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const fmt = (sec) => (sec == null ? "(none)" : central.format(new Date(sec * 1000)));

const { days, source } = parseArgs(process.argv.slice(2));
const descriptor = loadDescriptor(source);

const { expandStaticEvents } = await importFromRepo("worker/src/index.js");
const { garagesForEvent, eventEmoji, EVENT_RADIUS_METERS } = await importFromRepo("site/events.js");
const { GARAGES } = await importFromRepo("site/garages.js");

const now = Math.floor(Date.now() / 1000);
const since = now - 3 * 3600; // mirror the Worker's past-grace window
const until = now + days * 86400;

let rows;
try {
  rows = expandStaticEvents([descriptor], since, until);
} catch (err) {
  fail(`expandStaticEvents rejected the descriptor: ${err.message}`);
}

console.log(`Descriptor: ${descriptor.id} (${descriptor.kind}) — "${descriptor.title}"`);
console.log(`Window: next ${days} days (${rows.length} occurrence${rows.length === 1 ? "" : "s"})\n`);

if (rows.length === 0) {
  console.log("No occurrences in the window. Check weekday/season/date and that a start falls inside it.");
}
for (const row of rows) {
  console.log(`  ${row.id}`);
  console.log(`    start ${fmt(row.starts_at)}   end ${fmt(row.ends_at)}`);
}

// Proximity: the event only shows on garages within EVENT_RADIUS_METERS of its coords.
const ids = garagesForEvent(descriptor, GARAGES, EVENT_RADIUS_METERS);
console.log(`\nMaps to ${ids.length} garage${ids.length === 1 ? "" : "s"} within ${EVENT_RADIUS_METERS} m:`);
if (ids.length === 0) {
  console.log("  ⚠️  NONE — this event will not appear on any card. Recheck lat/lon.");
} else {
  for (const id of ids) console.log(`  ${id} => ${GARAGES[id].name}`);
}

// Emoji: a classification with no SEGMENT_EMOJI entry falls back to the calendar.
const emoji = eventEmoji(descriptor.classification);
if (descriptor.classification && emoji === "📅") {
  console.log(`\n⚠️  classification "${descriptor.classification}" has no emoji — add one to SEGMENT_EMOJI in site/events.js`);
} else {
  console.log(`\nBadge emoji: ${emoji} (classification: ${descriptor.classification ?? "none"})`);
}
