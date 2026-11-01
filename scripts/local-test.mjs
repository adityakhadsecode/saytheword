#!/usr/bin/env node
/**
 * End-to-end local test against `wrangler dev` (http://127.0.0.1:8787).
 * Runs the whole funnel in dry-run mode: webhook verification, signature
 * checks, comment trigger, DM, follow gate, link delivery, click tracking,
 * nudges via the cron endpoint, admin auth and admin API.
 *
 * Idempotent: safe to run repeatedly against the same dev server.
 *
 * Usage: npm run dev   (in another terminal)   then   npm run test:local
 */
import { createHmac, randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = process.env.BASE_URL || "http://127.0.0.1:8787";

// ---- load .dev.vars ----
const varsFile = join(ROOT, ".dev.vars");
if (!existsSync(varsFile)) {
  console.error("✗ .dev.vars missing — run: cp .dev.vars.example .dev.vars");
  process.exit(1);
}
const vars = {};
for (const line of readFileSync(varsFile, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+)\s*$/);
  if (m) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { APP_SECRET, ADMIN_PASSWORD, WEBHOOK_VERIFY_TOKEN } = vars;
if (!APP_SECRET || !ADMIN_PASSWORD || !WEBHOOK_VERIFY_TOKEN) {
  console.error("✗ .dev.vars must define APP_SECRET, ADMIN_PASSWORD, WEBHOOK_VERIFY_TOKEN");
  process.exit(1);
}

// unique ids per run so reruns never collide with persisted dev state
const RUN = randomBytes(4).toString("hex");
const MEDIA = `M${RUN}`;
const MEDIA2 = `M${RUN}2`;
const MEDIA3 = `M${RUN}3`;
const USER_A = `U${RUN}A`;
const USER_C = `U${RUN}C`;
const USER_D = `U${RUN}D`;
const USER_E = `U${RUN}E`;
const USER_F = `U${RUN}F`;
const MY_IG = `OWNER${RUN}`;
let EMAIL_AUTO_ID = "";

// ---- tiny test harness ----
let pass = 0, fail = 0;
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
}
const sign = (raw) => "sha256=" + createHmac("sha256", APP_SECRET).update(raw, "utf8").digest("hex");
async function webhook(payload, { sig = true } = {}) {
  const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (sig) headers["x-hub-signature-256"] = sign(raw);
  return fetch(BASE + "/webhook", { method: "POST", headers, body: raw });
}
const commentEvent = (commentId, userId, mediaId, text, username = "tester") => ({
  object: "instagram",
  entry: [{ id: MY_IG, time: Date.now(), changes: [{ field: "comments", value: { id: commentId, text, from: { id: userId, username }, media: { id: mediaId, media_product_type: "REELS" } } }] }],
});
const postbackEvent = (userId, payload, ts = Date.now()) => ({
  object: "instagram",
  entry: [{ id: MY_IG, time: Date.now(), messaging: [{ sender: { id: userId }, recipient: { id: MY_IG }, timestamp: ts, postback: { title: payload, payload } }] }],
});
const messageEvent = (userId, text) => ({
  object: "instagram",
  entry: [{
    id: MY_IG, time: Date.now(),
    messaging: [{
      sender: { id: userId }, recipient: { id: MY_IG }, timestamp: Date.now(),
      message: { mid: `m${RUN}_${userId}_${Math.random().toString(36).slice(2, 8)}`, text },
    }],
  }],
});

// ---- run ----
console.log(`\nTesting ${BASE} (run ${RUN})\n`);
let cookie = "";

console.log("0. Fresh slate");
const withCookie = (headers = {}) => ({ ...headers, cookie });
const api = (path, opts = {}) => fetch(BASE + "/admin/api" + path, { ...opts, headers: withCookie({ "content-type": "application/json", ...(opts.headers || {}) }), body: opts.body ? JSON.stringify(opts.body) : undefined })
  .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

console.log("1. Public pages");
{
  const home = await fetch(BASE + "/");
  ok(home.status === 200 && (await home.text()).includes("SayTheWord"), "GET / serves landing page");
  const priv = await fetch(BASE + "/privacy");
  ok(priv.status === 200 && (await priv.text()).toLowerCase().includes("privacy policy"), "GET /privacy serves privacy policy");
  const del = await fetch(BASE + "/data-deletion");
  ok(del.status === 200 && (await del.text()).includes("Data Deletion"), "GET /data-deletion serves deletion page");
}

console.log("2. Webhook verification & signature checks");
{
  const bad = await fetch(BASE + "/webhook?hub.mode=subscribe&hub.verify_token=WRONG&hub.challenge=abc123");
  ok(bad.status === 403, "GET /webhook with wrong verify token → 403");
  const good = await fetch(BASE + `/webhook?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(WEBHOOK_VERIFY_TOKEN)}&hub.challenge=abc123`);
  ok(good.status === 200 && (await good.text()) === "abc123", "GET /webhook with correct token echoes challenge");
  const nosig = await webhook(commentEvent(`c0${RUN}`, USER_A, MEDIA, "LINK"), { sig: false });
  ok(nosig.status === 403, "POST /webhook without signature → 403");
  const badsig = await fetch(BASE + "/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=" + "0".repeat(64) },
    body: JSON.stringify(commentEvent(`c0${RUN}`, USER_A, MEDIA, "LINK")),
  });
  ok(badsig.status === 403, "POST /webhook with bad signature → 403");
}

console.log("3. Admin auth");
{
  const unauth = await fetch(BASE + "/admin/api/state");
  ok(unauth.status === 401, "GET /admin/api/state without session → 401");
  const loginPage = await fetch(BASE + "/admin");
  ok(loginPage.status === 200 && (await loginPage.text()).includes("Sign in"), "GET /admin shows login form");
  const wrong = await fetch(BASE + "/admin/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ password: "nope" }) });
  ok(wrong.status === 303, "POST /admin/login wrong password rejected");
  const right = await fetch(BASE + "/admin/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ password: ADMIN_PASSWORD }) });
  const setCookie = right.headers.get("set-cookie") || "";
  ok(right.status === 303 && setCookie.includes("igbot_admin="), "POST /admin/login sets session cookie");
  cookie = setCookie.split(";")[0];
  const authed = await fetch(BASE + "/admin", { headers: { cookie } });
  ok(authed.status === 200 && (await authed.text()).includes("Automations"), "GET /admin with cookie serves console");

  // clean slate for the funnel assertions below (kept from previous reruns otherwise)
  const reset = await api("/reset-activity", { method: "POST" });
  ok(reset.status === 200, "reset-activity wipes contacts/flows/events");
}

console.log("4. Admin API & automation setup");
{
  const st = await api("/state");
  ok(st.status === 200 && st.data.mode === "dry", "state shows DRY RUN mode (no token connected)");
  ok(st.data.connected === false, "no token connected yet");

  const bad = await api("/automations", { method: "POST", body: { media_id: MEDIA + "x", keywords: [], dm_message: "x", link_url: "https://x.com" } });
  ok(bad.status === 400, "creating automation without keywords → 400");
  const badLink = await api("/automations", { method: "POST", body: { media_id: MEDIA + "x", keywords: ["LINK"], link_url: "http://not-secure.com" } });
  ok(badLink.status === 400, "non-https link_url → 400");

  const created = await api("/automations", {
    method: "POST",
    body: {
      media_id: MEDIA, title: "Test reel", keywords: ["LINK", "send"], match_mode: "contains",
      public_replies: ["Check your DMs! 📩", "On its way 💌"],
      dm_message: "Hey {username}! Tap below 👇", dm_button_text: "Send me the link",
      ask_follow: true, follow_prompt: "Follow me first 🙏", follow_button_text: "I'm following",
      link_message: "Here you go 🔗", link_url: "https://example.com/offer", link_button_text: "Open the link",
    },
  });
  ok(created.status === 200 && created.data.id, "automation created (ask_follow on)");

  const dup = await api("/automations", { method: "POST", body: { media_id: MEDIA, keywords: ["X"] } });
  ok(dup.status === 400, "second automation for the same reel → 400");
}

console.log("5. Comment trigger (dry run)");
{
  const r = await webhook(commentEvent(`c1${RUN}`, USER_A, MEDIA, "LINK please!"));
  ok(r.status === 200, "comment webhook accepted");
  let st = await api("/state");
  ok(st.data.funnel.commented === 1, "funnel: commented = 1");
  ok(st.data.funnel.dm_sent === 1, "funnel: dm_sent = 1 (dry)");
  const ev = await api("/events");
  const types = ev.data.events.filter(e => e.media_id === MEDIA).map(e => e.type);
  ok(types.includes("commented") && types.includes("comment_replied") && types.includes("dm_sent"), "events: commented + comment_replied + dm_sent");

  const noMatch = await webhook(commentEvent(`c2${RUN}`, USER_A, MEDIA, "nice reel"));
  ok(noMatch.status === 200, "non-keyword comment accepted");
  st = await api("/state");
  ok(st.data.funnel.commented === 1, "non-keyword comment did not trigger");

  const dup = await webhook(commentEvent(`c1${RUN}`, USER_A, MEDIA, "LINK again"));
  ok(dup.status === 200, "webhook redelivery accepted");
  st = await api("/state");
  ok(st.data.funnel.commented === 1, "same comment id is deduped");

  await webhook(commentEvent(`c3${RUN}`, USER_C, MEDIA, "send"));
  st = await api("/state");
  ok(st.data.funnel.commented === 2, "a different user on the same reel triggers again");
}

console.log("6. Follow gate → link → click tracking");
{
  let pb = await webhook(postbackEvent(USER_A, "GET_LINK", Date.now()));
  ok(pb.status === 200, "GET_LINK postback accepted");
  let st = await api("/state");
  ok(st.data.funnel.tapped === 1, "funnel: tapped = 1");
  ok(st.data.funnel.link_sent === 0, "follow gate held the link (ask_follow on)");

  pb = await webhook(postbackEvent(USER_A, "CONFIRM_FOLLOW", Date.now() + 1));
  ok(pb.status === 200, "CONFIRM_FOLLOW postback accepted");
  st = await api("/state");
  ok(st.data.funnel.link_sent === 1, "funnel: link_sent = 1 after confirm");

  const ev = await api("/events");
  const linkEvt = ev.data.events.find(e => e.type === "link_sent" && e.media_id === MEDIA);
  const goPath = (linkEvt?.detail || "").match(/\/go\/[A-Za-z0-9_.-]+/)?.[0];
  ok(!!goPath, "link_sent event contains tracked /go/ URL", linkEvt?.detail);
  if (goPath) {
    const click = await fetch(BASE + goPath, { redirect: "manual" });
    ok(click.status === 302 && click.headers.get("location") === "https://example.com/offer", "/go/ redirects to the automation link");
    st = await api("/state");
    ok(st.data.funnel.clicked === 1, "funnel: clicked = 1 after redirect");
    const bad = await fetch(BASE + "/go/garbage.token", { redirect: "manual" });
    ok(bad.status === 410 || bad.status === 404, "invalid /go token rejected");
  }
}

console.log("7. Nudge via cron");
{
  const force = await api("/force-nudges", { method: "POST" });
  ok(force.status === 200 && force.data.due >= 1, "pending nudges forced due (USER_C never tapped)", JSON.stringify(force.data));
  const cron = await fetch(BASE + "/__scheduled?cron=*+*+*+*+*");
  ok(cron.status === 200, "cron (scheduled handler) executed");
  const countNudges = async () => (await api("/events")).data.events.filter(e => e.type === "nudge_sent" && e.media_id === MEDIA).length;
  ok((await countNudges()) === 1, "nudge sent exactly once");
  await fetch(BASE + "/__scheduled?cron=*+*+*+*+*");
  ok((await countNudges()) === 1, "second cron run does not re-nudge (followup_sent flag)");
}

console.log("8. Simulated test run & data tools");
{
  const t = await api("/test", { method: "POST", body: { media_id: MEDIA, text: "LINK" } });
  ok(t.status === 200 && t.data.igsid?.startsWith("test_"), "admin test run completed");
  const ev = await api("/events");
  ok(ev.data.events.some(e => e.type === "test_completed"), "test_completed event recorded");
  const contacts = await api("/contacts?q=test_");
  ok(contacts.data.contacts.some(c => c.igsid.startsWith("test_")), "test contact visible in contacts list");
  const clear = await api("/clear-test-data", { method: "POST" });
  ok(clear.status === 200, "clear test data");
  const contacts2 = await api("/contacts?q=test_");
  ok(!contacts2.data.contacts.some(c => c.igsid.startsWith("test_")), "test contacts removed");
}

console.log("9. Next-post automation");
{
  const bad = await api("/automations", { method: "POST", body: { keywords: ["X"] } });
  ok(bad.status === 400, "media automation without a reel → 400");
  const created = await api("/automations", {
    method: "POST",
    body: { title: "Next reel test", keywords: ["NEXTKW"], attach: "next", dm_message: "Tap below", link_url: "https://example.com/offer" },
  });
  ok(created.status === 200 && created.data.id, "next-reel automation created without media_id");
  const st0 = await api("/state");
  const listening = st0.data.automations.find((a) => a.id === created.data.id);
  ok(listening && listening.attach === "next" && listening.media_id === "next:" + created.data.id, "listening automation holds a next: placeholder");

  const r = await webhook(commentEvent(`c10${RUN}`, USER_D, MEDIA2, "NEXTKW please"));
  ok(r.status === 200, "comment on a new reel accepted");
  const st1 = await api("/state");
  const attached = st1.data.automations.find((a) => a.id === created.data.id);
  ok(attached && attached.attach === "media" && attached.media_id === MEDIA2, "automation attached itself to the new reel");
  ok(st1.data.funnel.commented >= 1, "attaching comment triggered the flow");
}

console.log("10. Email step + CSV export");
{
  const created = await api("/automations", {
    method: "POST",
    body: {
      media_id: MEDIA3, title: "Email test", keywords: ["MAILKW"], match_mode: "contains",
      dm_message: "Tap below", ask_follow: false, ask_email: true,
      email_prompt: "Drop your email first", skip_button_text: "Skip, send the link",
      link_url: "https://example.com/offer",
    },
  });
  ok(created.status === 200 && created.data.id, "email automation created");
  EMAIL_AUTO_ID = created.data.id;

  const baseLink = (await api("/state")).data.funnel.link_sent;
  await webhook(commentEvent(`c11${RUN}`, USER_E, MEDIA3, "MAILKW"));
  await webhook(postbackEvent(USER_E, "GET_LINK", Date.now() + 10));
  let st = await api("/state");
  ok(st.data.funnel.link_sent === baseLink, "email gate held the link");
  const contacts1 = await api("/contacts?q=" + USER_E);
  ok(contacts1.data.contacts.some((c) => c.stage === "email_wait"), "flow waits for an email");

  await webhook(messageEvent(USER_E, "maya@example.com"));
  st = await api("/state");
  ok(st.data.funnel.link_sent === baseLink + 1, "email captured, link delivered");
  const contacts2 = await api("/contacts?q=" + USER_E);
  ok(contacts2.data.contacts.some((c) => c.email === "maya@example.com"), "contact stored the email");

  // skip path
  await webhook(commentEvent(`c12${RUN}`, USER_F, MEDIA3, "MAILKW"));
  await webhook(postbackEvent(USER_F, "GET_LINK", Date.now() + 11));
  await webhook(postbackEvent(USER_F, "SKIP_EMAIL", Date.now() + 12));
  st = await api("/state");
  ok(st.data.funnel.link_sent === baseLink + 2, "skip button delivers the link without an email");

  const csv = await fetch(BASE + "/admin/api/emails.csv", { headers: { cookie } });
  const text = await csv.text();
  ok(csv.status === 200 && (csv.headers.get("content-type") || "").includes("text/csv"), "CSV endpoint returns text/csv");
  ok(text.includes("maya@example.com") && text.includes(USER_E), "CSV contains the captured email");
}

console.log("11. Catch-up (needs live mode)");
{
  const r = await api("/automations/" + EMAIL_AUTO_ID + "/catch-up", { method: "POST" });
  ok(r.status === 400 && /connect/i.test(r.data.error || ""), "catch-up refused in dry-run with a clear error", JSON.stringify(r.data));
}

console.log("12. Cleanup");
{
  const st = await api("/state");
  let deleted = 0;
  for (const mid of [MEDIA, MEDIA2, MEDIA3]) {
    const auto = st.data.automations.find((a) => a.media_id === mid);
    if (auto) {
      const r = await api("/automations/" + auto.id, { method: "DELETE" });
      ok(r.status === 200, `automation for ${mid} deleted`);
      deleted++;
    }
  }
  ok(deleted >= 1, "test automations cleaned up");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
