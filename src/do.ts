import { DurableObject } from "cloudflare:workers";
import type {
  Automation,
  Contact,
  Env,
  EventRow,
  Flow,
  MessagingEvent,
  ReelInfo,
  Settings,
  TokenInfo,
  WebhookBody,
  WebhookEntry,
  CommentValue,
} from "./types";
import { Graph, type Button } from "./graph";
import * as u from "./util";

const DEFAULTS: Settings = {
  live_mode: false,
  nudge_minutes: 60,
  public_url: "",
  app_id: "",
  graph_version: "v26.0",
};

const DEFAULT_EMAIL_PROMPT =
  "Quick one before the link — drop your email below and I'll send the next guide straight to your inbox. Or skip it";
const DEFAULT_SKIP_TEXT = "Skip, send the link";
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
/** Private replies are only allowed within 7 days of the comment. */
const CATCHUP_WINDOW_MS = 7 * u.DAY_MS;
/** Safety cap for one catch-up run. */
const CATCHUP_MAX = 50;

const FLOW_COLS: Record<string, string> = {
  stage: "stage",
  dry: "dry",
  source_comment_id: "source_comment_id",
  dm_sent_at: "dm_sent_at",
  tapped_at: "tapped_at",
  link_sent_at: "link_sent_at",
  clicked_at: "clicked_at",
  followup_due_at: "followup_due_at",
  followup_sent: "followup_sent",
  link_url_snap: "link_url_snap",
};

function matchesKeyword(text: string, a: Automation): boolean {
  const t = (text || "").trim().toLowerCase();
  if (!t) return false;
  return a.match_mode === "exact"
    ? a.keywords.some((k) => t === k.toLowerCase())
    : a.keywords.some((k) => t.includes(k.toLowerCase()));
}

export class BotStore extends DurableObject<Env> {
  #ready?: Promise<void>;

  #ensure(): Promise<void> {
    this.#ready ??= this.#init();
    return this.#ready;
  }

  async #init(): Promise<void> {
    this.#sql.exec(`
      CREATE TABLE IF NOT EXISTS automations (
        id TEXT PRIMARY KEY,
        media_id TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL DEFAULT '',
        keywords TEXT NOT NULL DEFAULT '[]',
        match_mode TEXT NOT NULL DEFAULT 'contains',
        public_replies TEXT NOT NULL DEFAULT '[]',
        dm_message TEXT NOT NULL DEFAULT '',
        dm_button_text TEXT NOT NULL DEFAULT 'Send me the link',
        ask_follow INTEGER NOT NULL DEFAULT 0,
        follow_prompt TEXT NOT NULL DEFAULT '',
        follow_button_text TEXT NOT NULL DEFAULT "I'm following",
        ask_email INTEGER NOT NULL DEFAULT 0,
        email_prompt TEXT NOT NULL DEFAULT '',
        skip_button_text TEXT NOT NULL DEFAULT 'Skip, send the link',
        link_message TEXT NOT NULL DEFAULT '',
        link_url TEXT NOT NULL DEFAULT '',
        link_button_text TEXT NOT NULL DEFAULT 'Open the link',
        thumb_url TEXT NOT NULL DEFAULT '',
        attach TEXT NOT NULL DEFAULT 'media',
        next_since INTEGER,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS contacts (
        igsid TEXT PRIMARY KEY,
        username TEXT,
        follows_confirmed INTEGER NOT NULL DEFAULT 0,
        email TEXT,
        email_at INTEGER,
        first_seen INTEGER NOT NULL,
        last_seen INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS flows (
        igsid TEXT NOT NULL,
        media_id TEXT NOT NULL,
        stage TEXT NOT NULL DEFAULT 'commented',
        dry INTEGER NOT NULL DEFAULT 0,
        source_comment_id TEXT,
        dm_sent_at INTEGER,
        tapped_at INTEGER,
        link_sent_at INTEGER,
        clicked_at INTEGER,
        followup_due_at INTEGER,
        followup_sent INTEGER NOT NULL DEFAULT 0,
        link_url_snap TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (igsid, media_id)
      );
      CREATE INDEX IF NOT EXISTS idx_flows_due ON flows(followup_sent, followup_due_at);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        igsid TEXT,
        media_id TEXT,
        detail TEXT NOT NULL DEFAULT '',
        dry INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    // Columns added after the first release — no-ops on fresh databases.
    this.#addColumn("automations", "ask_email", `INTEGER NOT NULL DEFAULT 0`);
    this.#addColumn("automations", "email_prompt", `TEXT NOT NULL DEFAULT ''`);
    this.#addColumn("automations", "skip_button_text", `TEXT NOT NULL DEFAULT ${JSON.stringify(DEFAULT_SKIP_TEXT)}`);
    this.#addColumn("automations", "attach", `TEXT NOT NULL DEFAULT 'media'`);
    this.#addColumn("automations", "next_since", `INTEGER`);
    this.#addColumn("contacts", "email", `TEXT`);
    this.#addColumn("contacts", "email_at", `INTEGER`);
  }

  #addColumn(table: string, column: string, ddl: string): void {
    const cols = this.#q<{ name: string }>(`PRAGMA table_info(${table})`);
    if (!cols.some((c) => c.name === column)) this.#sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }

  // ---------- storage helpers ----------

  get #sql() {
    return this.ctx.storage.sql;
  }

  #q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return [...this.#sql.exec(sql, ...params)] as T[];
  }

  #one<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | null {
    for (const row of this.#sql.exec(sql, ...params)) return row as T;
    return null;
  }

  #getKv<T>(k: string): T | null {
    const row = this.#one<{ v: string }>(`SELECT v FROM kv WHERE k=?`, k);
    if (!row) return null;
    try {
      return JSON.parse(row.v) as T;
    } catch {
      return null;
    }
  }

  #setKv(k: string, v: unknown): void {
    this.#sql.exec(
      `INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`,
      k,
      JSON.stringify(v),
    );
  }

  #delKv(k: string): void {
    this.#sql.exec(`DELETE FROM kv WHERE k=?`, k);
  }

  /** Returns true if this dedupe key was already processed (webhook retries). */
  #seen(key: string): boolean {
    return !!this.#one(`SELECT k FROM kv WHERE k=?`, `seen:${key}`);
  }

  #markSeen(key: string): void {
    this.#setKv(`seen:${key}`, { t: u.now() });
  }

  // ---------- settings / token / account ----------

  async #getSettings(): Promise<Settings> {
    return { ...DEFAULTS, ...(this.#getKv<Partial<Settings>>("settings") ?? {}) };
  }

  #saveSettings(patch: Partial<Settings>): Settings {
    const merged = { ...DEFAULTS, ...(this.#getKv<Partial<Settings>>("settings") ?? {}), ...patch };
    this.#setKv("settings", merged);
    return merged;
  }

  #token(): TokenInfo | null {
    return this.#getKv<TokenInfo>("ig_token");
  }

  #saveToken(t: TokenInfo): void {
    this.#setKv("ig_token", t);
  }

  #account(): { user_id?: string; username?: string } | null {
    return this.#getKv("account");
  }

  #isLive(settings: Settings, token: TokenInfo | null): boolean {
    return !!token?.access_token && settings.live_mode;
  }

  /** Builds a Graph client; live only when a token exists and live mode is on. */
  async #graph(forceDry = false): Promise<{ g: Graph; live: boolean; settings: Settings }> {
    const settings = await this.#getSettings();
    const token = this.#token();
    const live = !forceDry && this.#isLive(settings, token);
    const g = new Graph(live ? token!.access_token : null, !live, settings.graph_version);
    return { g, live, settings };
  }

  #origin(): string {
    const s = this.#getKv<Partial<Settings>>("settings") ?? {};
    return s.public_url || this.#getKv<string>("origin") || "";
  }

  /**
   * Remember the request origin (workers.dev URL) for /go/ links, but never let a
   * localhost dev session overwrite a real deployment origin.
   */
  async #maybeSetOrigin(origin: string): Promise<void> {
    if (!origin || !/^https?:\/\//.test(origin)) return;
    if ((this.#getKv<Partial<Settings>>("settings") ?? {}).public_url) return;
    const cur = this.#getKv<string>("origin");
    const isLocal = (o?: string | null) => !!o && /localhost|127\.0\.0\.1/.test(o);
    if (!cur || (isLocal(cur) && !isLocal(origin))) this.#setKv("origin", origin);
  }

  #event(type: string, o: { igsid?: string | null; media_id?: string | null; detail?: string; dry?: boolean } = {}): void {
    this.#sql.exec(
      `INSERT INTO events (ts, type, igsid, media_id, detail, dry) VALUES (?, ?, ?, ?, ?, ?)`,
      u.now(),
      type,
      o.igsid ?? null,
      o.media_id ?? null,
      (o.detail ?? "").slice(0, 500),
      o.dry ? 1 : 0,
    );
  }

  // ---------- automations ----------

  #rowToAutomation(r: Record<string, unknown>): Automation {
    const arr = (v: unknown, fallback: string[] = []) => {
      try {
        const p = JSON.parse(String(v ?? ""));
        return Array.isArray(p) ? p : fallback;
      } catch {
        return fallback;
      }
    };
    return {
      id: String(r.id),
      media_id: String(r.media_id),
      title: String(r.title ?? ""),
      keywords: arr(r.keywords),
      match_mode: r.match_mode === "exact" ? "exact" : "contains",
      public_replies: arr(r.public_replies),
      dm_message: String(r.dm_message ?? ""),
      dm_button_text: String(r.dm_button_text ?? ""),
      ask_follow: !!r.ask_follow,
      follow_prompt: String(r.follow_prompt ?? ""),
      follow_button_text: String(r.follow_button_text ?? ""),
      link_message: String(r.link_message ?? ""),
      link_url: String(r.link_url ?? ""),
      link_button_text: String(r.link_button_text ?? ""),
      attach: r.attach === "next" ? "next" : "media",
      next_since: r.next_since == null ? null : Number(r.next_since),
      ask_email: !!r.ask_email,
      email_prompt: String(r.email_prompt ?? ""),
      skip_button_text: String(r.skip_button_text ?? ""),
      enabled: !!r.enabled,
      thumb_url: String(r.thumb_url ?? ""),
      created_at: Number(r.created_at),
      updated_at: Number(r.updated_at),
    };
  }

  async #automationByMedia(mediaId: string): Promise<Automation | null> {
    const row = this.#one(`SELECT * FROM automations WHERE media_id=?`, mediaId);
    return row ? this.#rowToAutomation(row) : null;
  }

  /** Oldest enabled "next reel" automation whose keywords match this comment text. */
  #nextAutomationFor(text: string): Automation | null {
    const rows = this.#q(`SELECT * FROM automations WHERE attach='next' AND enabled=1 ORDER BY created_at ASC`);
    for (const r of rows) {
      const a = this.#rowToAutomation(r);
      if (matchesKeyword(text, a)) return a;
    }
    return null;
  }

  /**
   * Attaches a "next reel" automation to mediaId. Reels published before the mode
   * was armed are rejected (with a memo) so old posts can't claim the automation.
   */
  async #tryAttach(candidate: Automation, mediaId: string): Promise<boolean> {
    if (this.#seen(`nextskip:${candidate.id}:${mediaId}`)) return false;
    const { g, live } = await this.#graph();
    if (live && candidate.next_since) {
      const publishedAt = await g.getMediaTimestamp(mediaId);
      if (publishedAt && publishedAt < candidate.next_since) {
        this.#markSeen(`nextskip:${candidate.id}:${mediaId}`);
        this.#event("next_skipped_old", {
          media_id: mediaId,
          detail: `reel predates the automation — "${candidate.title}" keeps waiting for the next one`,
        });
        return false;
      }
    }
    this.#sql.exec(`UPDATE automations SET media_id=?, attach='media', updated_at=? WHERE id=?`, mediaId, u.now(), candidate.id);
    this.#event("next_attached", { media_id: mediaId, detail: `"${candidate.title}" attached to this reel` });
    return true;
  }

  // ---------- contacts & flows ----------

  async #upsertContact(igsid: string, username: string | null): Promise<Contact | null> {
    const n = u.now();
    this.#sql.exec(
      `INSERT INTO contacts (igsid, username, follows_confirmed, first_seen, last_seen)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(igsid) DO UPDATE SET
         last_seen=excluded.last_seen,
         username=COALESCE(contacts.username, excluded.username)`,
      igsid,
      username,
      n,
      n,
    );
    return this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, igsid);
  }

  #insertFlow(igsid: string, mediaId: string, dry: boolean, sourceCommentId: string | null): void {
    const n = u.now();
    this.#sql.exec(
      `INSERT INTO flows (igsid, media_id, stage, dry, source_comment_id, created_at, updated_at)
       VALUES (?, ?, 'commented', ?, ?, ?, ?)
       ON CONFLICT(igsid, media_id) DO NOTHING`,
      igsid,
      mediaId,
      dry ? 1 : 0,
      sourceCommentId,
      n,
      n,
    );
  }

  #updateFlow(igsid: string, mediaId: string, patch: Partial<Record<keyof typeof FLOW_COLS, unknown>>): void {
    const sets: string[] = ["updated_at=?"];
    const vals: unknown[] = [u.now()];
    for (const [k, col] of Object.entries(FLOW_COLS)) {
      if (k in patch) {
        sets.push(`${col}=?`);
        vals.push(patch[k] === undefined ? null : patch[k]);
      }
    }
    vals.push(igsid, mediaId);
    this.#sql.exec(`UPDATE flows SET ${sets.join(", ")} WHERE igsid=? AND media_id=?`, ...vals);
  }

  // =====================================================================
  // Webhook processing
  // =====================================================================

  async processWebhook(body: WebhookBody, origin: string): Promise<{ ok: true }> {
    await this.#ensure();
    await this.#maybeSetOrigin(origin);
    if (body.object !== "instagram") return { ok: true };
    for (const entry of body.entry ?? []) {
      for (const ch of entry.changes ?? []) {
        if (ch.field === "comments") await this.#handleComment(entry, ch.value);
      }
      for (const m of entry.messaging ?? []) {
        if (m.postback) await this.#handlePostback(entry, m);
        else if (m.message) await this.#handleMessage(entry, m);
      }
    }
    return { ok: true };
  }

  async #handleComment(entry: WebhookEntry, v: CommentValue, forceDry = false, catchUp = false): Promise<void> {
    if (!v?.id) return;
    const dedupeKey = `comment:${forceDry ? "test-" : ""}${v.id}`;
    if (!catchUp && this.#seen(dedupeKey)) return;

    const account = this.#account();
    if (v.from?.id && (v.from.id === entry.id || (account?.user_id && v.from.id === account.user_id))) {
      return; // our own comment
    }

    const mediaId = v.media?.id ?? "";
    const text = (v.text ?? "").trim();
    let automation = mediaId ? await this.#automationByMedia(mediaId) : null;

    // No automation on this reel yet — a "next reel" automation may claim it.
    if (!automation && mediaId && !catchUp) {
      const candidate = this.#nextAutomationFor(text);
      if (candidate && (await this.#tryAttach(candidate, mediaId))) {
        automation = { ...candidate, media_id: mediaId, attach: "media" };
      }
    }

    if (!automation || !automation.enabled) {
      // Not marked as seen: if the automation is created after the comment, a
      // webhook redelivery (or the same user commenting again) can still trigger.
      this.#event("comment_ignored", { media_id: mediaId || null, detail: "no enabled automation for this reel" });
      return;
    }
    if (!catchUp) this.#markSeen(dedupeKey);

    if (!matchesKeyword(text, automation)) {
      this.#event("comment_no_keyword", { media_id: mediaId, detail: `no keyword match: "${text.slice(0, 80)}"` });
      return;
    }

    const igsid = v.from?.id ?? "";
    if (!igsid) {
      this.#event("comment_ignored", { media_id: mediaId, detail: "commenter id missing" });
      return;
    }

    const { g, live, settings } = await this.#graph(forceDry);
    const dry = !live;
    const username = v.from?.username ?? null;
    await this.#upsertContact(igsid, username);

    const existingFlow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? AND media_id=?`, igsid, mediaId);
    if (existingFlow && (existingFlow.dm_sent_at || !catchUp)) {
      this.#event("comment_repeat", { igsid, media_id: mediaId, detail: "user already triggered this reel", dry });
      return;
    }
    if (existingFlow) {
      // Catch-up retry after a failed DM — clear the old flow and run fresh.
      this.#sql.exec(`DELETE FROM flows WHERE igsid=? AND media_id=?`, igsid, mediaId);
    }

    this.#insertFlow(igsid, mediaId, dry, v.id);
    this.#event("commented", {
      igsid,
      media_id: mediaId,
      detail: `"${text.slice(0, 60)}" matched [${automation.keywords.join(", ")}]`,
      dry,
    });

    // 1) Public reply — rotate through the configured replies.
    if (automation.public_replies.length) {
      const reply = automation.public_replies[u.strHash(v.id) % automation.public_replies.length];
      const r = await g.replyToComment(v.id, u.render(reply, username));
      this.#event(r.ok ? "comment_replied" : "comment_reply_failed", {
        igsid,
        media_id: mediaId,
        detail: r.ok ? reply : r.error ?? "reply failed",
        dry,
      });
    }

    // 2) Private reply DM. Instagram allows exactly ONE private reply per comment,
    //    so the message with the "Send me the link" button is a single message.
    const r = await g.sendButtonTemplate(
      { comment_id: v.id },
      u.render(automation.dm_message, username),
      [{ type: "postback", title: automation.dm_button_text.slice(0, 20), payload: "GET_LINK" }],
    );
    if (r.ok) {
      const nudgeDue = automation.link_url ? u.now() + Math.max(0, settings.nudge_minutes) * 60_000 : null;
      this.#updateFlow(igsid, mediaId, { stage: "dm_sent", dm_sent_at: u.now(), followup_due_at: nudgeDue });
      this.#event("dm_sent", { igsid, media_id: mediaId, detail: dry ? "dry run — nothing sent" : "private reply sent", dry });
    } else {
      this.#event("dm_failed", { igsid, media_id: mediaId, detail: r.error ?? "private reply failed", dry });
    }
  }

  async #handlePostback(entry: WebhookEntry, m: MessagingEvent, forceDry = false): Promise<void> {
    const igsid = m.sender?.id ?? "";
    if (!igsid) return;
    const account = this.#account();
    if (igsid === entry.id || (account?.user_id && igsid === account.user_id)) return;

    const dedupeKey = `pb:${igsid}:${m.timestamp ?? 0}:${m.postback?.payload ?? ""}`;
    if (this.#seen(dedupeKey)) return;
    this.#markSeen(dedupeKey);

    const { g, live } = await this.#graph(forceDry);
    const dry = !live;

    // Best-effort username lookup for the contacts list.
    const contact = await this.#upsertContact(igsid, null);
    if (contact && !contact.username) {
      const p = await g.getUserProfile(igsid);
      if (p?.username) this.#sql.exec(`UPDATE contacts SET username=? WHERE igsid=?`, p.username, igsid);
    }

    const payload = m.postback?.payload ?? "";
    this.#event("postback", { igsid, detail: payload || m.postback?.title || "unknown", dry });

    const flow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? ORDER BY created_at DESC LIMIT 1`, igsid);
    if (!flow) return;

    if (payload === "GET_LINK") {
      if (!flow.tapped_at) {
        this.#updateFlow(flow.igsid, flow.media_id, {
          tapped_at: u.now(),
          stage: flow.stage === "link_sent" ? "link_sent" : "tapped",
        });
        this.#event("tapped", { igsid: flow.igsid, media_id: flow.media_id, detail: "tapped the DM button", dry });
      }
      await this.#onGetLink(flow, forceDry);
    } else if (payload === "CONFIRM_FOLLOW") {
      this.#sql.exec(`UPDATE contacts SET follows_confirmed=1 WHERE igsid=?`, igsid);
      this.#event("follow_confirmed", { igsid, detail: "user confirmed they follow", dry });
      await this.#afterGate(flow, forceDry);
    } else if (payload === "SKIP_EMAIL") {
      this.#event("email_skipped", { igsid, detail: "user skipped the email step", dry });
      await this.#deliverLink(flow, forceDry);
    }
  }

  /** Button tap: enforce the follow gate, then hand over the link. */
  async #onGetLink(flow: Flow, forceDry = false): Promise<void> {
    const automation = await this.#automationByMedia(flow.media_id);
    const { live } = await this.#graph(forceDry);
    if (!automation || !automation.enabled) {
      this.#event("flow_error", { igsid: flow.igsid, media_id: flow.media_id, detail: "automation no longer exists", dry: !live });
      return;
    }
    const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
    if (automation.ask_follow && !contact?.follows_confirmed) {
      const { g } = await this.#graph(forceDry);
      const status = await g.checkFollow(flow.igsid);
      this.#event("follow_check", { igsid: flow.igsid, detail: `api check: ${status}`, dry: !live });
      if (status === "yes") {
        this.#sql.exec(`UPDATE contacts SET follows_confirmed=1 WHERE igsid=?`, flow.igsid);
        return this.#afterGate(flow, forceDry);
      }
      return this.#askFollow(flow, automation, forceDry);
    }
    await this.#afterGate(flow, forceDry);
  }

  /** After the follow gate: optional email capture, then the link. */
  async #afterGate(flow: Flow, forceDry = false): Promise<void> {
    const automation = await this.#automationByMedia(flow.media_id);
    const { live } = await this.#graph(forceDry);
    if (!automation || !automation.enabled) {
      this.#event("flow_error", { igsid: flow.igsid, media_id: flow.media_id, detail: "automation no longer exists", dry: !live });
      return;
    }
    if (automation.ask_email) {
      const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
      if (!contact?.email) return this.#askEmail(flow, automation, forceDry);
    }
    await this.#deliverLink(flow, forceDry);
  }

  async #askEmail(flow: Flow, automation: Automation, forceDry = false): Promise<void> {
    const { g, live } = await this.#graph(forceDry);
    const dry = !live;
    const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
    const r = await g.sendButtonTemplate(
      { id: flow.igsid },
      u.render(automation.email_prompt || DEFAULT_EMAIL_PROMPT, contact?.username),
      [{ type: "postback", title: (automation.skip_button_text || DEFAULT_SKIP_TEXT).slice(0, 20), payload: "SKIP_EMAIL" }],
    );
    if (r.ok) {
      this.#updateFlow(flow.igsid, flow.media_id, { stage: "email_wait" });
      this.#event("asked_email", { igsid: flow.igsid, media_id: flow.media_id, detail: dry ? "dry run — nothing sent" : "email prompt sent", dry });
    } else {
      this.#event("email_prompt_failed", { igsid: flow.igsid, media_id: flow.media_id, detail: r.error ?? "send failed", dry });
    }
  }

  async #askFollow(flow: Flow, automation: Automation, forceDry = false): Promise<void> {
    const { g, live } = await this.#graph(forceDry);
    const dry = !live;
    const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
    const r = await g.sendButtonTemplate(
      { id: flow.igsid },
      u.render(automation.follow_prompt, contact?.username),
      [{ type: "postback", title: automation.follow_button_text.slice(0, 20), payload: "CONFIRM_FOLLOW" }],
    );
    if (r.ok) {
      this.#updateFlow(flow.igsid, flow.media_id, { stage: "asked_follow" });
      this.#event("asked_follow", { igsid: flow.igsid, media_id: flow.media_id, detail: dry ? "dry run — nothing sent" : "follow prompt sent", dry });
    } else {
      this.#event("asked_follow_failed", { igsid: flow.igsid, media_id: flow.media_id, detail: r.error ?? "send failed", dry });
    }
  }

  async #deliverLink(flow: Flow, forceDry = false): Promise<void> {
    const automation = await this.#automationByMedia(flow.media_id);
    const { g, live } = await this.#graph(forceDry);
    if (!automation?.link_url) {
      this.#event("link_error", { igsid: flow.igsid, media_id: flow.media_id, detail: "no link configured on the automation", dry: !live });
      return;
    }
    const dry = !live;
    const origin = this.#origin();
    const goUrl = origin
      ? `${origin}/go/${await u.makeGoToken(this.env.APP_SECRET, flow.igsid, flow.media_id)}`
      : automation.link_url;
    const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
    const r = await g.sendButtonTemplate(
      { id: flow.igsid },
      u.render(automation.link_message, contact?.username),
      [{ type: "web_url", title: automation.link_button_text.slice(0, 20), url: goUrl }],
    );
    if (r.ok) {
      this.#updateFlow(flow.igsid, flow.media_id, {
        stage: "link_sent",
        link_sent_at: u.now(),
        followup_sent: 1, // link delivered — no nudge needed
        link_url_snap: automation.link_url,
      });
      this.#event("link_sent", { igsid: flow.igsid, media_id: flow.media_id, detail: dry ? `dry run — would send ${goUrl}` : `link button sent → ${goUrl}`, dry });
    } else {
      this.#event("link_failed", { igsid: flow.igsid, media_id: flow.media_id, detail: r.error ?? "send failed", dry });
    }
  }

  async #handleMessage(entry: WebhookEntry, m: MessagingEvent, forceDry = false): Promise<void> {
    const msg = m.message;
    if (!msg || msg.is_echo || msg.is_deleted) return;
    const igsid = m.sender?.id ?? "";
    if (!igsid) return;
    const account = this.#account();
    if (igsid === entry.id || (account?.user_id && igsid === account.user_id)) return;
    if (msg.mid && this.#seen(`msg:${msg.mid}`)) return;
    if (msg.mid) this.#markSeen(`msg:${msg.mid}`);

    const { g, live } = await this.#graph(forceDry);
    await this.#upsertContact(igsid, null);
    const text = (msg.text ?? "").trim();
    const lower = text.toLowerCase();

    // Privacy: honor in-DM deletion requests.
    if (/^(delete my data|delete my info|delete my account|stop|unsubscribe)\b/.test(lower)) {
      await g.sendMessage({ id: igsid }, { text: "Done — all of your data has been deleted from our system. 🗑️" });
      this.#sql.exec(`DELETE FROM flows WHERE igsid=?`, igsid);
      this.#sql.exec(`DELETE FROM contacts WHERE igsid=?`, igsid);
      this.#sql.exec(`DELETE FROM events WHERE igsid=?`, igsid);
      this.#event("data_deleted", { detail: igsid });
      return;
    }

    // Email capture step: a flow waiting for an email gets first crack at the reply.
    const pendingFlow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? ORDER BY created_at DESC LIMIT 1`, igsid);
    if (pendingFlow?.stage === "email_wait" && text) {
      const match = text.match(EMAIL_RE);
      if (match) {
        this.#sql.exec(`UPDATE contacts SET email=?, email_at=? WHERE igsid=?`, match[0].toLowerCase(), u.now(), igsid);
        this.#event("email_captured", { igsid, media_id: pendingFlow.media_id, detail: "email captured before the link" });
        await this.#deliverLink(pendingFlow, forceDry);
      } else {
        const automation = await this.#automationByMedia(pendingFlow.media_id);
        const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, igsid);
        await g.sendButtonTemplate(
          { id: igsid },
          u.render(automation?.email_prompt || DEFAULT_EMAIL_PROMPT, contact?.username),
          [{ type: "postback", title: (automation?.skip_button_text || DEFAULT_SKIP_TEXT).slice(0, 20), payload: "SKIP_EMAIL" }],
        );
        this.#event("email_reprompt", { igsid, media_id: pendingFlow.media_id, detail: `not an email: "${text.slice(0, 60)}"` });
      }
      return;
    }

    this.#event("dm_received", { igsid, detail: text.slice(0, 120) || "(attachment)", dry: !live });

    // If they typed the keyword again, re-run the flow (resends the button/link).
    if (text) {
      const flow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? ORDER BY created_at DESC LIMIT 1`, igsid);
      const automation = flow ? await this.#automationByMedia(flow.media_id) : null;
      if (flow && automation?.enabled && matchesKeyword(lower, automation)) {
        await this.#onGetLink(flow, forceDry);
      }
    }
  }

  // =====================================================================
  // Cron: one-time nudges + weekly token refresh + housekeeping
  // =====================================================================

  async processDue(): Promise<{ nudges: number; refreshed: boolean }> {
    await this.#ensure();
    const n = u.now();
    let refreshed = false;

    const due = this.#q<Flow>(
      `SELECT * FROM flows
       WHERE followup_sent=0 AND followup_due_at IS NOT NULL AND followup_due_at<=?
         AND dm_sent_at IS NOT NULL AND link_sent_at IS NULL`,
      n,
    );
    for (const flow of due) {
      this.#updateFlow(flow.igsid, flow.media_id, { followup_sent: 1 }); // claim first — never double-send
      const automation = await this.#automationByMedia(flow.media_id);
      if (!automation || !automation.enabled) continue;
      const { g, live } = await this.#graph();
      const dry = !live;
      const contact = this.#one<Contact>(`SELECT * FROM contacts WHERE igsid=?`, flow.igsid);
      const gated = flow.stage === "asked_follow";
      const text = `Just checking in 👀 ${u.render(gated ? automation.follow_prompt : automation.dm_message, contact?.username)}`;
      const buttons: Button[] = gated
        ? [{ type: "postback", title: automation.follow_button_text.slice(0, 20), payload: "CONFIRM_FOLLOW" }]
        : [{ type: "postback", title: automation.dm_button_text.slice(0, 20), payload: "GET_LINK" }];
      const r = await g.sendButtonTemplate({ id: flow.igsid }, text, buttons);
      if (r.ok) {
        this.#event("nudge_sent", { igsid: flow.igsid, media_id: flow.media_id, detail: dry ? "dry run — nothing sent" : "one-time follow-up sent", dry });
      } else {
        this.#event("nudge_failed", {
          igsid: flow.igsid,
          media_id: flow.media_id,
          detail: `${r.error} — Instagram only delivers messages within 24h of the user's last reply`,
          dry,
        });
      }
    }

    // Long-lived tokens last 60 days; refresh weekly so they never get close to expiry.
    const token = this.#token();
    if (token?.access_token) {
      const last = token.refreshed_at ?? token.obtained_at ?? 0;
      if (n - last > 6 * u.DAY_MS) {
        const { g } = await this.#graph();
        try {
          const r = await g.refreshLongLived();
          if (r?.access_token) {
            this.#saveToken({ ...token, access_token: r.access_token, refreshed_at: n });
            this.#event("token_refreshed", { detail: "long-lived token refreshed" });
            refreshed = true;
          }
        } catch (e) {
          this.#event("token_refresh_failed", { detail: e instanceof Error ? e.message : String(e) });
        }
      }
    }

    // Housekeeping: cap the event log, expire dedupe markers.
    this.#sql.exec(`DELETE FROM events WHERE id < (SELECT COALESCE(MAX(id),0) - 5000 FROM events)`);
    this.#sql.exec(`DELETE FROM kv WHERE k LIKE 'seen:%' AND json_extract(v, '$.t') < ?`, n - 35 * u.DAY_MS);

    return { nudges: due.length, refreshed };
  }

  /** /go/<token> redirect target — counts the "clicked" funnel step. */
  async logClick(igsid: string, mediaId: string): Promise<string | null> {
    await this.#ensure();
    const flow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? AND media_id=?`, igsid, mediaId);
    if (!flow) return null;
    if (!flow.clicked_at) {
      this.#updateFlow(igsid, mediaId, { clicked_at: u.now(), stage: "clicked" });
      this.#event("clicked", { igsid, media_id: mediaId, detail: "opened the link" });
    }
    if (flow.link_url_snap) return flow.link_url_snap;
    return (await this.#automationByMedia(mediaId))?.link_url ?? null;
  }

  // =====================================================================
  // Admin API
  // =====================================================================

  async adminState(origin?: string): Promise<Record<string, unknown>> {
    await this.#ensure();
    if (origin) await this.#maybeSetOrigin(origin);
    const settings = await this.#getSettings();
    const token = this.#token();
    const account = this.#account();
    const live = this.#isLive(settings, token);

    const funnelRow = (mediaId?: string) => {
      const base = `SELECT COUNT(*) n, SUM(dm_sent_at IS NOT NULL) dm, SUM(tapped_at IS NOT NULL) tp, SUM(link_sent_at IS NOT NULL) ls, SUM(clicked_at IS NOT NULL) ck FROM flows`;
      const r = mediaId
        ? this.#one<{ n: number | null; dm: number | null; tp: number | null; ls: number | null; ck: number | null }>(`${base} WHERE media_id=?`, mediaId)
        : this.#one<{ n: number | null; dm: number | null; tp: number | null; ls: number | null; ck: number | null }>(base);
      return {
        commented: Number(r?.n ?? 0),
        dm_sent: Number(r?.dm ?? 0),
        tapped: Number(r?.tp ?? 0),
        link_sent: Number(r?.ls ?? 0),
        clicked: Number(r?.ck ?? 0),
      };
    };

    const automations = this.#q(`SELECT * FROM automations ORDER BY created_at DESC`).map((r) => {
      const a = this.#rowToAutomation(r);
      return { ...a, funnel: funnelRow(a.media_id) };
    });

    const emails = this.#one<{ n: number }>(`SELECT COUNT(*) n FROM contacts WHERE email IS NOT NULL`);

    return {
      mode: live ? "live" : "dry",
      connected: !!token?.access_token,
      account: account ?? null,
      token_updated_at: token?.refreshed_at ?? token?.obtained_at ?? null,
      settings,
      origin: this.#origin(),
      webhook_fields: ["comments", "messages", "messaging_postbacks"],
      automations,
      funnel: { ...funnelRow(), emails: Number(emails?.n ?? 0) },
    };
  }

  async adminSaveAutomation(dto: Partial<Automation> & Record<string, unknown>): Promise<{ id: string }> {
    await this.#ensure();
    const attach = dto.attach === "next" ? "next" : "media";
    const n = u.now();
    const id = String(dto.id || "").trim() || u.randomId("a_");
    const existingById = String(dto.id || "")
      ? this.#one<{ id: string; media_id: string; attach: string; next_since: number | null }>(
          `SELECT id, media_id, attach, next_since FROM automations WHERE id=?`,
          id,
        )
      : null;

    // In "next" mode the automation holds a unique placeholder until a new reel claims it.
    let mediaId = String(dto.media_id ?? "").trim();
    let nextSince: number | null = null;
    if (attach === "next") {
      mediaId = `next:${id}`;
      nextSince =
        existingById?.attach === "next" && existingById.next_since ? Number(existingById.next_since) : n;
    } else {
      if (!mediaId) throw new Error("Pick a reel, or choose 'my next reel' under Trigger.");
    }

    const keywords = (Array.isArray(dto.keywords) ? dto.keywords : [])
      .map((k) => String(k).trim())
      .filter(Boolean);
    if (!keywords.length) throw new Error("Add at least one keyword.");
    const replies = (Array.isArray(dto.public_replies) ? dto.public_replies : [])
      .map((k) => String(k).trim())
      .filter(Boolean);
    const dmMessage = String(dto.dm_message ?? "").trim();
    if (!dmMessage) throw new Error("Write the private DM message.");
    const linkUrl = String(dto.link_url ?? "").trim();
    if (linkUrl && !/^https:\/\//i.test(linkUrl)) throw new Error("The link URL must start with https://");
    const emailPrompt = String(dto.email_prompt ?? "").trim();
    if (dto.ask_email && !emailPrompt) throw new Error("Write the email prompt message.");

    const clash =
      attach === "media"
        ? this.#one(`SELECT id FROM automations WHERE media_id=? AND id<>?`, mediaId, existingById?.id ?? "")
        : null;
    if (clash) throw new Error("There is already an automation for this reel (one automation per reel).");

    let thumb = String(dto.thumb_url ?? "");
    if (!thumb && !existingById && attach === "media") {
      const { g } = await this.#graph();
      thumb = await g.getMediaThumb(mediaId);
    }

    const values = {
      media_id: mediaId,
      title: String(dto.title ?? "").trim() || (attach === "next" ? "My next reel" : `Reel ${mediaId}`),
      keywords: JSON.stringify(keywords),
      match_mode: dto.match_mode === "exact" ? "exact" : "contains",
      public_replies: JSON.stringify(replies),
      dm_message: dmMessage,
      dm_button_text: String(dto.dm_button_text ?? "").trim().slice(0, 20) || "Send me the link",
      ask_follow: dto.ask_follow ? 1 : 0,
      follow_prompt: String(dto.follow_prompt ?? "").trim(),
      follow_button_text: String(dto.follow_button_text ?? "").trim().slice(0, 20) || "I'm following",
      ask_email: dto.ask_email ? 1 : 0,
      email_prompt: emailPrompt,
      skip_button_text: String(dto.skip_button_text ?? "").trim().slice(0, 20) || DEFAULT_SKIP_TEXT,
      link_message: String(dto.link_message ?? "").trim() || "Here's your link 🔗",
      link_url: linkUrl,
      link_button_text: String(dto.link_button_text ?? "").trim().slice(0, 20) || "Open the link",
      thumb_url: thumb,
      attach,
      next_since: nextSince,
      enabled: dto.enabled === false ? 0 : 1,
      updated_at: n,
    };

    if (existingById) {
      this.#sql.exec(
        `UPDATE automations SET media_id=?, title=?, keywords=?, match_mode=?, public_replies=?, dm_message=?,
         dm_button_text=?, ask_follow=?, follow_prompt=?, follow_button_text=?, ask_email=?, email_prompt=?,
         skip_button_text=?, link_message=?, link_url=?, link_button_text=?, thumb_url=?, attach=?,
         next_since=?, enabled=?, updated_at=? WHERE id=?`,
        values.media_id, values.title, values.keywords, values.match_mode, values.public_replies, values.dm_message,
        values.dm_button_text, values.ask_follow, values.follow_prompt, values.follow_button_text, values.ask_email,
        values.email_prompt, values.skip_button_text, values.link_message, values.link_url, values.link_button_text,
        values.thumb_url, values.attach, values.next_since, values.enabled, values.updated_at, id,
      );
    } else {
      this.#sql.exec(
        `INSERT INTO automations (id, media_id, title, keywords, match_mode, public_replies, dm_message,
         dm_button_text, ask_follow, follow_prompt, follow_button_text, ask_email, email_prompt,
         skip_button_text, link_message, link_url, link_button_text, thumb_url, attach, next_since,
         enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, values.media_id, values.title, values.keywords, values.match_mode, values.public_replies, values.dm_message,
        values.dm_button_text, values.ask_follow, values.follow_prompt, values.follow_button_text, values.ask_email,
        values.email_prompt, values.skip_button_text, values.link_message, values.link_url, values.link_button_text,
        values.thumb_url, values.attach, values.next_since, values.enabled, values.updated_at, values.updated_at,
      );
    }
    return { id };
  }

  async adminDeleteAutomation(id: string): Promise<{ ok: true }> {
    await this.#ensure();
    this.#sql.exec(`DELETE FROM automations WHERE id=?`, id);
    return { ok: true };
  }

  async adminListContacts(q: string): Promise<Contact[]> {
    await this.#ensure();
    const like = `%${q.trim()}%`;
    const rows = q?.trim()
      ? this.#q(
          `SELECT c.igsid, c.username, c.follows_confirmed, c.email, c.email_at, c.first_seen, c.last_seen,
             (SELECT stage FROM flows f WHERE f.igsid=c.igsid ORDER BY f.updated_at DESC LIMIT 1) AS stage,
             (SELECT COUNT(*) FROM flows f2 WHERE f2.igsid=c.igsid) AS flows_n
           FROM contacts c WHERE c.username LIKE ?1 OR c.igsid LIKE ?1 ORDER BY c.last_seen DESC LIMIT 500`,
          like,
        )
      : this.#q(
          `SELECT c.igsid, c.username, c.follows_confirmed, c.email, c.email_at, c.first_seen, c.last_seen,
             (SELECT stage FROM flows f WHERE f.igsid=c.igsid ORDER BY f.updated_at DESC LIMIT 1) AS stage,
             (SELECT COUNT(*) FROM flows f2 WHERE f2.igsid=c.igsid) AS flows_n
           FROM contacts c ORDER BY c.last_seen DESC LIMIT 500`,
        );
    return rows as unknown as Contact[];
  }

  async adminDeleteContact(igsid: string): Promise<{ ok: true }> {
    await this.#ensure();
    this.#sql.exec(`DELETE FROM flows WHERE igsid=?`, igsid);
    this.#sql.exec(`DELETE FROM events WHERE igsid=?`, igsid);
    this.#sql.exec(`DELETE FROM contacts WHERE igsid=?`, igsid);
    return { ok: true };
  }

  async adminEvents(limit = 120): Promise<EventRow[]> {
    await this.#ensure();
    return this.#q<EventRow>(`SELECT * FROM events ORDER BY id DESC LIMIT ?`, Math.min(500, Math.max(1, limit)));
  }

  async adminSaveSettings(patch: Record<string, unknown>): Promise<Settings> {
    await this.#ensure();
    const out: Partial<Settings> = {};
    if ("nudge_minutes" in patch) {
      const n = Math.max(0, Math.min(10080, Number(patch.nudge_minutes) || 0));
      out.nudge_minutes = n;
    }
    if ("public_url" in patch) {
      const p = String(patch.public_url ?? "").trim().replace(/\/+$/, "");
      if (p && !/^https?:\/\//.test(p)) throw new Error("Public URL must start with https://");
      out.public_url = p;
    }
    if ("app_id" in patch) out.app_id = String(patch.app_id ?? "").trim();
    if ("graph_version" in patch) {
      const v = String(patch.graph_version ?? "").trim();
      if (!/^v\d+\.\d+$/.test(v)) throw new Error("Graph version looks like v26.0");
      out.graph_version = v;
    }
    if ("live_mode" in patch) out.live_mode = !!patch.live_mode;
    return this.#saveSettings(out);
  }

  async adminSetToken(accessToken: string): Promise<{ ok: true; username?: string }> {
    await this.#ensure();
    const token = String(accessToken ?? "").trim();
    if (!token) throw new Error("Paste an access token.");
    const g = new Graph(token, false);
    const me = await g.getMe();
    if (!me) throw new Error("Instagram rejected this token — generate a fresh one (Settings → Connect, or the token guide).");
    this.#saveToken({ access_token: token, obtained_at: u.now() });
    this.#setKv("account", { user_id: me.user_id ?? me.id, username: me.username });
    this.#saveSettings({ live_mode: true });
    this.#event("token_set", { detail: me.username ? `connected as @${me.username}` : "token connected" });
    return { ok: true, username: me.username };
  }

  async adminDisconnect(): Promise<{ ok: true }> {
    await this.#ensure();
    this.#delKv("ig_token");
    this.#saveSettings({ live_mode: false });
    this.#event("token_removed", { detail: "disconnected — dry-run mode" });
    return { ok: true };
  }

  async adminGetOAuthConfig(): Promise<{ app_id: string; graph_version: string }> {
    await this.#ensure();
    const s = await this.#getSettings();
    return { app_id: s.app_id, graph_version: s.graph_version };
  }

  async adminReels(): Promise<ReelInfo[]> {
    await this.#ensure();
    const token = this.#token();
    if (!token?.access_token) throw new Error("Connect your Instagram account first (Settings → Connect).");
    const { g } = await this.#graph();
    const list = await g.getMediaList(25);
    return list.sort((a, b) => (a.media_product_type === "REELS" ? -1 : 0) - (b.media_product_type === "REELS" ? -1 : 0));
  }

  /**
   * "DM earlier comments": reads the reel's real comments, finds keyword matches
   * from the last 7 days (the private-reply window) that never received a DM,
   * and runs the normal flow for each. Live mode only.
   */
  async adminCatchUp(automationId: string): Promise<{ fetched: number; matched: number; dm: number; already: number; skippedOld: number }> {
    await this.#ensure();
    const row = this.#one(`SELECT * FROM automations WHERE id=?`, automationId);
    if (!row) throw new Error("Automation not found.");
    const automation = this.#rowToAutomation(row);
    if (automation.attach === "next") throw new Error("This automation is still waiting for its reel — there is nothing to catch up on yet.");

    const { g, live } = await this.#graph();
    if (!live) throw new Error("Connect your Instagram account first — catch-up reads the reel's real comments.");

    const comments = await g.getComments(automation.media_id, 100);
    const cutoff = u.now() - CATCHUP_WINDOW_MS;
    let matched = 0, dm = 0, already = 0, skippedOld = 0, noSender = 0;
    const entry: WebhookEntry = { id: this.#account()?.user_id ?? "CATCHUP" };

    for (const c of comments) {
      const ts = c.timestamp ? Date.parse(c.timestamp) : NaN;
      if (!(ts >= cutoff)) { skippedOld++; continue; }
      const fromId = c.from?.id;
      if (!fromId) { noSender++; continue; }
      if (!matchesKeyword(c.text ?? "", automation)) continue;
      matched++;
      if (dm >= CATCHUP_MAX) continue;

      const existing = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? AND media_id=?`, fromId, automation.media_id);
      if (existing?.dm_sent_at) { already++; continue; }

      await this.#handleComment(
        entry,
        { id: c.id, text: c.text, from: { id: fromId, username: c.from?.username ?? c.username }, media: { id: automation.media_id } },
        false,
        true,
      );
      dm++;
      await new Promise((r) => setTimeout(r, 250));
    }

    const summary = `fetched ${comments.length}, matched ${matched}, DM started ${dm}, already had it ${already}, older than 7 days ${skippedOld}${noSender ? `, ${noSender} without sender id` : ""}`;
    this.#event("catchup_run", { media_id: automation.media_id, detail: summary });
    return { fetched: comments.length, matched, dm, already, skippedOld };
  }

  /** CSV of everyone who gave their email before the link. */
  adminExportEmailsCsv(): string {
    this.#ensure();
    const rows = this.#q<{ username: string | null; igsid: string; email: string; email_at: number | null; source: string | null }>(
      `SELECT c.username, c.igsid, c.email, c.email_at,
         COALESCE((SELECT a.title FROM flows f JOIN automations a ON a.media_id=f.media_id
                   WHERE f.igsid=c.igsid ORDER BY f.updated_at DESC LIMIT 1), '') AS source
       FROM contacts c WHERE c.email IS NOT NULL ORDER BY c.email_at DESC`,
    );
    // Keep spreadsheet formulas from executing: neutralize leading =,+,-,@
    const safe = (v: unknown) => (/^[=+@-]/.test(String(v ?? "")) ? `'${v}` : String(v ?? ""));
    const cell = (v: unknown) => `"${safe(v).replace(/"/g, '""')}"`;
    const lines = [
      "username,instagram_id,email,captured_at,source",
      ...rows.map((r) =>
        [r.username ?? "", r.igsid, r.email, r.email_at ? new Date(Number(r.email_at)).toISOString() : "", r.source ?? ""]
          .map(cell)
          .join(","),
      ),
    ];
    return lines.join("\r\n");
  }

  /** Simulates the full funnel (comment → DM → tap → gate → link) without sending anything. */
  async adminTest(input: { media_id?: string; text?: string; username?: string }): Promise<{ ok: true; igsid: string }> {
    await this.#ensure();
    const mediaId = String(input.media_id ?? "").trim();
    if (!mediaId) throw new Error("Pick a reel or paste a media ID first.");
    if (!this.#one(`SELECT id FROM automations WHERE media_id=?`, mediaId)) {
      throw new Error("Save the automation first, then run the test.");
    }
    const igsid = "test_" + u.randomId();
    const comment: CommentValue = {
      id: "test_" + u.randomId(),
      text: String(input.text ?? "LINK"),
      from: { id: igsid, username: String(input.username ?? "test_user") },
      media: { id: mediaId, media_product_type: "REELS" },
    };
    await this.#handleComment({ id: "TEST" }, comment, true);
    const postback = (payload: string): MessagingEvent => ({
      sender: { id: igsid },
      recipient: { id: "TEST" },
      timestamp: u.now() + 1,
      postback: { title: payload, payload },
    });
    await this.#handlePostback({ id: "TEST" }, postback("GET_LINK"), true);
    await this.#handlePostback({ id: "TEST" }, postback("CONFIRM_FOLLOW"), true);
    // If the email gate is on, the test flow now waits for an address — supply one.
    const flowRow = this.#one<Flow>(`SELECT * FROM flows WHERE igsid=? ORDER BY created_at DESC LIMIT 1`, igsid);
    if (flowRow?.stage === "email_wait") {
      await this.#handleMessage(
        { id: "TEST" },
        { sender: { id: igsid }, recipient: { id: "TEST" }, timestamp: u.now() + 2, message: { mid: "test_" + u.randomId(), text: "test.user@example.com" } },
        true,
      );
    }
    this.#event("test_completed", { igsid, media_id: mediaId, detail: "simulated comment → DM → tap → link", dry: true });
    return { ok: true, igsid };
  }

  async adminClearTestData(): Promise<{ ok: true }> {
    await this.#ensure();
    this.#sql.exec(`DELETE FROM flows WHERE dry=1`);
    this.#sql.exec(`DELETE FROM events WHERE dry=1`);
    this.#sql.exec(`DELETE FROM contacts WHERE igsid LIKE 'test_%'`);
    return { ok: true };
  }

  /** Wipes contacts, flows, events and dedupe markers — keeps automations, token and settings. */
  async adminResetActivity(): Promise<{ ok: true }> {
    await this.#ensure();
    this.#sql.exec(`DELETE FROM flows`);
    this.#sql.exec(`DELETE FROM events`);
    this.#sql.exec(`DELETE FROM contacts`);
    this.#sql.exec(`DELETE FROM kv WHERE k LIKE 'seen:%'`);
    return { ok: true };
  }

  /** Test helper: makes every pending nudge due immediately (dry runs included). */
  async adminForceNudges(): Promise<{ due: number }> {
    await this.#ensure();
    const r = this.#one<{ n: number }>(
      `SELECT COUNT(*) n FROM flows WHERE dm_sent_at IS NOT NULL AND link_sent_at IS NULL AND followup_sent=0`,
    );
    this.#sql.exec(
      `UPDATE flows SET followup_due_at=0 WHERE dm_sent_at IS NOT NULL AND link_sent_at IS NULL AND followup_sent=0`,
    );
    return { due: Number(r?.n ?? 0) };
  }

  async adminLoginAttempt(success: boolean): Promise<{ locked: boolean }> {
    await this.#ensure();
    const st = this.#getKv<{ count: number; until: number }>("login_fails") ?? { count: 0, until: 0 };
    if (success) {
      this.#setKv("login_fails", { count: 0, until: 0 });
      return { locked: false };
    }
    const n = u.now();
    if (st.until > n) return { locked: true };
    const count = st.count + 1;
    if (count >= 5) {
      this.#setKv("login_fails", { count: 0, until: n + 15 * 60_000 });
      return { locked: true };
    }
    this.#setKv("login_fails", { count, until: 0 });
    return { locked: false };
  }
}
