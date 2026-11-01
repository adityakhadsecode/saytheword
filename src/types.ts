import type { BotStore } from "./do";

export interface Env {
  BOT: DurableObjectNamespace<BotStore>;
  /** Meta App Secret — used for webhook signature checks, admin sessions and link tokens. Set via `wrangler secret put APP_SECRET`. */
  APP_SECRET: string;
  /** Password for the /admin page. Set via `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD: string;
  /** Any random string; must match the verify token entered in the Meta webhook config. */
  WEBHOOK_VERIFY_TOKEN: string;
}

export interface Automation {
  id: string;
  /** Instagram media (reel) id this automation watches — one automation per reel.
   *  In "next" mode this holds a unique `next:<id>` placeholder until the first
   *  matching comment on a new reel attaches the automation. */
  media_id: string;
  title: string;
  keywords: string[];
  match_mode: "contains" | "exact";
  /** "media" = attached to media_id; "next" = waits for the first new reel that gets a keyword. */
  attach: "media" | "next";
  /** Earliest reel publish time accepted when attaching in "next" mode. */
  next_since: number | null;
  /** Ask for the commenter's email before handing over the link. */
  ask_email: boolean;
  email_prompt: string;
  skip_button_text: string;
  /** Rotating public comment replies. */
  public_replies: string[];
  /** First (and only) private reply DM text. Supports {username}. */
  dm_message: string;
  dm_button_text: string;
  /** Ask users to follow before receiving the link. */
  ask_follow: boolean;
  follow_prompt: string;
  follow_button_text: string;
  /** Message sent when the link is released. Supports {username}. */
  link_message: string;
  link_url: string;
  link_button_text: string;
  enabled: boolean;
  thumb_url: string;
  created_at: number;
  updated_at: number;
}

export interface Settings {
  /** Sends only happen when a token is connected AND this is true. */
  live_mode: boolean;
  nudge_minutes: number;
  /** Override for the public origin used in tracked /go/ links (defaults to the workers.dev URL). */
  public_url: string;
  /** Meta App ID (public) — needed for the OAuth "Connect Instagram" button. */
  app_id: string;
  graph_version: string;
}

export interface TokenInfo {
  access_token: string;
  obtained_at: number;
  refreshed_at?: number;
}

export interface Contact {
  igsid: string;
  username: string | null;
  follows_confirmed: number;
  email?: string | null;
  email_at?: number | null;
  first_seen: number;
  last_seen: number;
  stage?: string | null;
  flows_n?: number;
}

export type FlowStage = "commented" | "dm_sent" | "tapped" | "asked_follow" | "email_wait" | "link_sent" | "clicked";

export interface Flow {
  igsid: string;
  media_id: string;
  stage: FlowStage;
  /** 1 = synthetic (admin "test" run) — excluded by "Clear test data". */
  dry: number;
  source_comment_id: string | null;
  dm_sent_at: number | null;
  tapped_at: number | null;
  link_sent_at: number | null;
  clicked_at: number | null;
  followup_due_at: number | null;
  followup_sent: number;
  link_url_snap: string | null;
  created_at: number;
  updated_at: number;
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  igsid: string | null;
  media_id: string | null;
  detail: string;
  dry: number;
}

// ---------- webhook payloads ----------

export interface CommentValue {
  id: string;
  text?: string;
  from?: { id: string; username?: string };
  media?: { id: string; media_product_type?: string };
  parent_id?: string;
}

export interface MessagingEvent {
  sender?: { id: string };
  recipient?: { id: string };
  timestamp?: number;
  postback?: { title?: string; payload?: string };
  message?: { mid?: string; text?: string; is_echo?: boolean; is_deleted?: boolean };
}

export interface WebhookEntry {
  id: string;
  time?: number;
  changes?: { field: string; value: CommentValue }[];
  messaging?: MessagingEvent[];
}

export interface WebhookBody {
  object?: string;
  entry?: WebhookEntry[];
}

export interface ReelInfo {
  id: string;
  caption?: string;
  media_product_type?: string;
  permalink?: string;
  thumbnail_url?: string;
  timestamp?: string;
}
