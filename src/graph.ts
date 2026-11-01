import type { ReelInfo } from "./types";

export type Button =
  | { type: "postback"; title: string; payload: string }
  | { type: "web_url"; title: string; url: string };

export type FollowStatus = "yes" | "no" | "unknown";

export interface SendResult {
  ok: boolean;
  dry: boolean;
  error?: string;
}

export class GraphApiError extends Error {
  constructor(public code: number | undefined, public subcode: number | undefined, message: string) {
    super(message);
  }
}

/**
 * Thin client for the Instagram API with Instagram Login (graph.instagram.com).
 * In dry mode every method no-ops and reports `dry: true` instead of touching the network.
 */
export class Graph {
  constructor(
    private token: string | null,
    private dry: boolean,
    private version = "v26.0",
  ) {}

  private base(): string {
    return `https://graph.instagram.com/${this.version}`;
  }

  private async call<T = Record<string, unknown>>(
    path: string,
    init?: { method?: string; body?: string; form?: Record<string, string> },
  ): Promise<T> {
    if (this.dry) return { __dry: true } as T;
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let body: string | undefined;
    if (init?.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(init.form).toString();
    } else if (init?.body != null) {
      headers["content-type"] = "application/json";
      body = init.body;
    }
    const res = await fetch(this.base() + path, { method: init?.method ?? "GET", headers, body });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const err = (data?.error ?? {}) as { message?: string; code?: number; error_subcode?: number };
      throw new GraphApiError(err.code, err.error_subcode, err.message ?? `Graph API error (HTTP ${res.status})`);
    }
    return data as T;
  }

  // ---------- messaging ----------

  async sendMessage(recipient: Record<string, string>, message: unknown): Promise<SendResult> {
    try {
      await this.call("/me/messages", { method: "POST", body: JSON.stringify({ recipient, message }) });
      return { ok: true, dry: this.dry };
    } catch (e) {
      return { ok: false, dry: this.dry, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Text + up to 3 buttons (template_type "button", 640-char text limit).
   * Falls back to a generic template, then to plain text, for accounts that reject the button template.
   */
  async sendButtonTemplate(recipient: Record<string, string>, text: string, buttons: Button[]): Promise<SendResult> {
    const clipped = (text || "").slice(0, 640);
    const r = await this.sendMessage(recipient, {
      attachment: { type: "template", payload: { template_type: "button", text: clipped, buttons } },
    });
    if (r.ok) return r;
    const g = await this.sendMessage(recipient, {
      attachment: {
        type: "template",
        payload: { template_type: "generic", elements: [{ title: clipped.slice(0, 80) || "👇", buttons }] },
      },
    });
    if (g.ok) return g;
    return this.sendMessage(recipient, {
      text: `${clipped}\n\n${buttons.map((b) => `👉 ${b.title}`).join("\n")}`,
    });
  }

  /** Public reply to a comment. */
  async replyToComment(commentId: string, text: string): Promise<SendResult> {
    try {
      await this.call(`/${commentId}/replies`, { method: "POST", form: { message: (text || "").slice(0, 2200) } });
      return { ok: true, dry: this.dry };
    } catch (e) {
      return { ok: false, dry: this.dry, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---------- profiles & media ----------

  async getMe(): Promise<{ user_id?: string; id?: string; username?: string; name?: string } | null> {
    if (this.dry) return null;
    try {
      return await this.call("/me?fields=user_id,username,name");
    } catch {
      return null;
    }
  }

  async getMediaList(limit = 25): Promise<ReelInfo[]> {
    if (this.dry) return [];
    try {
      const data = await this.call<{ data?: ReelInfo[] }>(
        `/me/media?fields=id,caption,media_product_type,permalink,thumbnail_url,timestamp&limit=${limit}`,
      );
      return data?.data ?? [];
    } catch {
      return [];
    }
  }

  async getMediaThumb(mediaId: string): Promise<string> {
    if (this.dry) return "";
    try {
      const data = await this.call<{ thumbnail_url?: string; media_url?: string }>(
        `/${mediaId}?fields=thumbnail_url,media_url`,
      );
      return data.thumbnail_url ?? data.media_url ?? "";
    } catch {
      return "";
    }
  }

  /** Recent comments on one of our media — used by the "DM earlier comments" catch-up. */
  async getComments(
    mediaId: string,
    limit = 50,
  ): Promise<Array<{ id: string; text?: string; timestamp?: string; from?: { id?: string; username?: string }; username?: string }>> {
    if (this.dry) return [];
    const fields = encodeURIComponent("id,text,timestamp,from{id,username}");
    const data = await this.call<{ data?: Array<{ id: string; text?: string; timestamp?: string; from?: { id?: string; username?: string }; username?: string }> }>(
      `/${mediaId}/comments?fields=${fields}&limit=${limit}`,
    );
    return data?.data ?? [];
  }

  /** Publish time of one of our media (epoch ms), or null when unavailable. */
  async getMediaTimestamp(mediaId: string): Promise<number | null> {
    if (this.dry) return null;
    try {
      const data = await this.call<{ timestamp?: string }>(`/${mediaId}?fields=timestamp`);
      return data.timestamp ? Date.parse(data.timestamp) : null;
    } catch {
      return null;
    }
  }

  async getUserProfile(igsid: string): Promise<{ username?: string; is_user_follow_business?: boolean } | null> {
    if (this.dry) return null;
    try {
      return await this.call(`/${igsid}?fields=username,is_user_follow_business`);
    } catch {
      try {
        return await this.call(`/${igsid}?fields=username`);
      } catch {
        return null;
      }
    }
  }

  /**
   * Best-effort "does this user follow me" check.
   * `is_user_follow_business` is only returned when Meta grants the app the follower-check
   * capability; otherwise we report "unknown" and the bot falls back to asking the user.
   */
  async checkFollow(igsid: string): Promise<FollowStatus> {
    if (this.dry) return "unknown";
    const p = await this.getUserProfile(igsid);
    if (p && typeof p.is_user_follow_business === "boolean") return p.is_user_follow_business ? "yes" : "no";
    return "unknown";
  }

  // ---------- auth / tokens ----------

  static authorizeUrl(appId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      client_id: appId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments",
      state,
    });
    return `https://www.instagram.com/oauth/authorize?${q.toString()}`;
  }

  /** code -> short-lived token -> 60-day long-lived token. */
  async exchangeCode(
    code: string,
    redirectUri: string,
    clientId: string,
    clientSecret: string,
  ): Promise<{ access_token: string; user_id?: string }> {
    const short = await this.call<{ access_token: string; user_id?: string }>(
      `/oauth/access_token?${new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      })}`,
    );
    const long = await this.call<{ access_token: string }>(
      `/access_token?${new URLSearchParams({
        grant_type: "ig_exchange_token",
        client_secret: clientSecret,
        access_token: short.access_token,
      })}`,
    );
    return { access_token: long.access_token, user_id: short.user_id };
  }

  /** Extend a long-lived token by another 60 days (run weekly). */
  async refreshLongLived(): Promise<{ access_token: string }> {
    return await this.call<{ access_token: string }>(
      `/refresh_access_token?${new URLSearchParams({ grant_type: "ig_refresh_token", access_token: this.token ?? "" })}`,
    );
  }
}
