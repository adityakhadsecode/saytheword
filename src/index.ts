import adminHtml from "./admin.html";
import landingHtml from "./landing.html";
import privacyHtml from "./privacy.html";
import deletionHtml from "./data-deletion.html";
import { BotStore } from "./do";
import { Graph } from "./graph";
import type { Env, WebhookBody } from "./types";
import * as u from "./util";

export { BotStore };

const COOKIE = "igbot_admin";
const YEAR = String(new Date().getFullYear());

const bot = (env: Env) => env.BOT.get(env.BOT.idFromName("global"));

function page(html: string, status = 200): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

async function sessionToken(env: Env): Promise<string> {
  return `v1.${await u.hmacHex(env.APP_SECRET, "admin-session")}`;
}

function hasCookie(req: Request, expected: string): boolean {
  const cookie = req.headers.get("cookie") ?? "";
  return cookie.split(/;\s*/).some((c) => c === `${COOKIE}=${expected}`);
}

const PAGE_STYLES = `
:root{--ink:#17191c;--paper:#fff;--mist:#f2f2f3;--fog:#fafafb;--slate:#777b86;--ash:#979799;--peach:#fbe1d1;--sienna:#5d2a1a;--line:#ececec;--serif:"Source Serif 4",ui-serif,Georgia,serif;--sans:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
*{box-sizing:border-box}html,body{margin:0}
body{background:var(--fog);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.6;min-height:100vh;display:grid;place-items:center;padding:32px;-webkit-font-smoothing:antialiased}
a{color:var(--ink)}
.box{width:min(420px,100%)}
.wordmark{font-family:var(--serif);font-size:22px;font-weight:400;letter-spacing:-.2px}
.wordmark .arr{font-style:italic}
p.sub{color:var(--slate);font-size:14.5px;margin:4px 0 28px}
input{width:100%;background:var(--paper);border:1px solid var(--line);border-radius:16px;color:var(--ink);padding:12px 16px;font-size:15px;font-family:var(--sans);margin-bottom:12px}
input:focus{outline:none;border-color:rgba(23,25,28,.35)}
button{width:100%;background:var(--ink);color:var(--paper);border:0;border-radius:9999px;padding:12px;font-size:15px;font-weight:450;font-family:var(--sans);cursor:pointer}
button:hover{background:#2a2d33}
.err{background:var(--paper);box-shadow:0 0 0 1px var(--line);color:#a83a2e;border-radius:16px;padding:12px 16px;font-size:14px;margin-bottom:12px}
.note{color:var(--slate);font-size:15px}
.note b{font-weight:500;color:var(--ink)}
a.textlink{font-size:14.5px;font-weight:450;text-decoration:none;padding:2px 0}
a.textlink:hover{text-decoration:underline;text-underline-offset:3px}
h1{font-family:var(--serif);font-weight:400;font-size:34px;letter-spacing:-.4px;line-height:1.2;margin:0 0 12px}
.foot{margin-top:32px;font-size:13.5px;color:var(--ash)}`;

function pageShell(title: string, body: string, status = 200): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${u.esc(title)} — SayTheWord</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..500&family=Source+Serif+4:ital,opsz,wght@0,8..60,400;1,8..60,400&display=swap" rel="stylesheet">
<style>${PAGE_STYLES}</style></head><body><div class="box">${body}</div></body></html>`;
  return page(html, status);
}

function loginHtml(error: boolean, message?: string, status = 200): Response {
  return pageShell(
    "Sign in",
    `<div class="wordmark">SayTheWord</div>
<p class="sub">Admin console</p>
<form method="post" action="/admin/login">
${error ? `<div class="err">${u.esc(message ?? "Wrong password. Try again.")}</div>` : ""}
<input type="password" name="password" placeholder="Admin password" autofocus required>
<button>Sign in</button></form>`,
  );
}

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    try {
      return await route(req, env, ctx, url, path);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (path.startsWith("/admin/api/")) return u.json({ error: msg }, 400);
      return pageShell(
        "Something went wrong",
        `<h1>Something went wrong</h1><p class="note"><b>${u.esc(msg)}</b></p><a class="textlink" href="/">Back to home →</a>`,
        500,
      );
    }
  },

  async scheduled(
    _ctrl: ScheduledController,
    env: Env,
    _ctx: ExecutionContext,
  ): Promise<void> {
    await bot(env).processDue();
  },
};

async function route(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
  path: string,
): Promise<Response> {
  // ---------- public pages ----------
  if (path === "/") return page(landingHtml.replace(/{{year}}/g, YEAR));
  if (path === "/privacy") return page(privacyHtml.replace(/{{year}}/g, YEAR));
  if (path === "/data-deletion")
    return page(deletionHtml.replace(/{{year}}/g, YEAR));

  // ---------- tracked link redirect ----------
  if (path.startsWith("/go/")) {
    const parsed = await u.verifyGoToken(env.APP_SECRET, path.slice(4));
    if (!parsed) {
      return pageShell(
        "Link expired",
        `<h1>Link expired</h1><p class="note">This link is no longer valid. Comment on the reel again to get a fresh one</p><a class="textlink" href="/">Back to home →</a>`,
        410,
      );
    }
    const link = await bot(env).logClick(parsed.i, parsed.m);
    if (!link) {
      return pageShell(
        "Link not found",
        `<h1>Link not found</h1><p class="note">The link behind this button was removed. Comment on the reel again and the bot will send a fresh one</p>`,
        404,
      );
    }
    return Response.redirect(link, 302);
  }

  // ---------- Meta webhook ----------
  if (path === "/webhook") {
    if (req.method === "GET") {
      const q = url.searchParams;
      const mode = q.get("hub.mode") ?? "";
      const token = q.get("hub.verify_token") ?? "";
      const challenge = q.get("hub.challenge") ?? "";
      if (
        mode === "subscribe" &&
        token &&
        u.timingSafeEqual(token, env.WEBHOOK_VERIFY_TOKEN)
      ) {
        return new Response(challenge, { status: 200 });
      }
      return new Response("Forbidden", { status: 403 });
    }
    if (req.method === "POST") {
      if (!env.APP_SECRET) {
        return new Response(
          "APP_SECRET is not set — run: npx wrangler secret put APP_SECRET",
          { status: 500 },
        );
      }
      const raw = await req.text();
      const sig = req.headers.get("x-hub-signature-256") ?? "";
      const expected = `sha256=${await u.hmacHex(env.APP_SECRET, raw)}`;
      if (!sig || !u.timingSafeEqual(sig, expected)) {
        return new Response("Invalid signature", { status: 403 });
      }
      let body: WebhookBody;
      try {
        body = JSON.parse(raw) as WebhookBody;
      } catch {
        return new Response("Bad payload", { status: 400 });
      }
      await bot(env).processWebhook(body, url.origin);
      return new Response("EVENTS_RECEIVED", { status: 200 });
    }
    return new Response("Method not allowed", { status: 405 });
  }

  // ---------- admin ----------
  if (path === "/admin") {
    if (!hasCookie(req, await sessionToken(env)))
      return loginHtml(url.searchParams.get("error") === "1");
    return page(adminHtml);
  }

  if (path === "/admin/login" && req.method === "POST") {
    const form = await req.formData();
    const pw = String(form.get("password") ?? "");
    const ok = pw.length > 0 && u.timingSafeEqual(pw, env.ADMIN_PASSWORD);
    const attempt = await bot(env).adminLoginAttempt(ok);
    if (attempt.locked)
      return loginHtml(true, "Too many attempts — locked for 15 minutes.", 429);
    if (!ok) return Response.redirect(`${url.origin}/admin?error=1`, 303);
    const secure = url.protocol === "https:" ? "; Secure" : "";
    return new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/admin`,
        "set-cookie": `${COOKIE}=${await sessionToken(env)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${30 * 86400}${secure}`,
      },
    });
  }

  if (path === "/admin/logout" && req.method === "POST") {
    return new Response(null, {
      status: 303,
      headers: {
        location: `${url.origin}/admin`,
        "set-cookie": `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
      },
    });
  }

  if (path.startsWith("/admin/api/")) {
    if (!hasCookie(req, await sessionToken(env)))
      return u.json({ error: "Unauthorized" }, 401);
    return await adminApi(req, env, url, path);
  }

  // ---------- OAuth connect ----------
  if (path === "/auth/start") {
    if (!hasCookie(req, await sessionToken(env)))
      return Response.redirect(`${url.origin}/admin`, 303);
    const cfg = await bot(env).adminGetOAuthConfig();
    if (!cfg.app_id)
      return Response.redirect(
        `${url.origin}/admin?auth_error=${encodeURIComponent("Add your Meta App ID in Settings first")}`,
        303,
      );
    const state = await u.makeGoToken(env.APP_SECRET, "oauth", "state", 1);
    return Response.redirect(
      Graph.authorizeUrl(cfg.app_id, `${url.origin}/auth/callback`, state),
      302,
    );
  }

  if (path === "/auth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const errDesc = url.searchParams.get("error_description");
    if (
      errDesc ||
      !code ||
      !state ||
      !(await u.verifyGoToken(env.APP_SECRET, state))
    ) {
      return Response.redirect(
        `${url.origin}/admin?auth_error=${encodeURIComponent(errDesc ?? "Invalid OAuth state")}`,
        303,
      );
    }
    try {
      const cfg = await bot(env).adminGetOAuthConfig();
      const g = new Graph(null, false, cfg.graph_version);
      const { access_token } = await g.exchangeCode(
        code,
        `${url.origin}/auth/callback`,
        cfg.app_id,
        env.APP_SECRET,
      );
      await bot(env).adminSetToken(access_token);
      return Response.redirect(`${url.origin}/admin?connected=1`, 303);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return Response.redirect(
        `${url.origin}/admin?auth_error=${encodeURIComponent(msg)}`,
        303,
      );
    }
  }

  return pageShell(
    "Not found",
    `<h1>Page not found</h1><p class="note">There is nothing at this address</p><a class="textlink" href="/">Back to home →</a>`,
    404,
  );
}

async function adminApi(
  req: Request,
  env: Env,
  url: URL,
  path: string,
): Promise<Response> {
  const b = bot(env);
  const sub = path.slice("/admin/api/".length);
  const method = req.method;
  const body = method === "POST" ? await req.json().catch(() => ({})) : {};

  if (method === "GET" && sub === "state")
    return u.json(await b.adminState(url.origin));
  if (method === "GET" && sub === "emails.csv") {
    const date = new Date().toISOString().slice(0, 10);
    return new Response(await b.adminExportEmailsCsv(), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="email-captures-${date}.csv"`,
      },
    });
  }
  if (method === "GET" && sub === "contacts")
    return u.json({
      contacts: await b.adminListContacts(url.searchParams.get("q") ?? ""),
    });
  if (method === "GET" && sub === "events")
    return u.json({ events: await b.adminEvents() });
  if (method === "GET" && sub === "reels")
    return u.json({ reels: await b.adminReels() });

  if (method === "POST" && sub === "automations")
    return u.json(await b.adminSaveAutomation(body as Record<string, unknown>));
  if (
    method === "POST" &&
    sub.startsWith("automations/") &&
    sub.endsWith("/catch-up")
  ) {
    const id = decodeURIComponent(
      sub.slice("automations/".length, -"/catch-up".length),
    );
    return u.json(await b.adminCatchUp(id));
  }
  if (method === "POST" && sub === "settings")
    return u.json({
      settings: await b.adminSaveSettings(body as Record<string, unknown>),
    });
  if (method === "POST" && sub === "token") {
    const r = await b.adminSetToken(
      String((body as Record<string, unknown>).access_token ?? ""),
    );
    return u.json(r);
  }
  if (method === "POST" && sub === "disconnect")
    return u.json(await b.adminDisconnect());
  if (method === "POST" && sub === "test")
    return u.json(await b.adminTest(body as Record<string, unknown>));
  if (method === "POST" && sub === "clear-test-data")
    return u.json(await b.adminClearTestData());
  if (method === "POST" && sub === "reset-activity")
    return u.json(await b.adminResetActivity());
  if (method === "POST" && sub === "force-nudges")
    return u.json(await b.adminForceNudges());

  if (method === "DELETE" && sub.startsWith("automations/")) {
    return u.json(
      await b.adminDeleteAutomation(
        decodeURIComponent(sub.slice("automations/".length)),
      ),
    );
  }
  if (
    method === "POST" &&
    sub.startsWith("contacts/") &&
    sub.endsWith("/delete")
  ) {
    const igsid = decodeURIComponent(
      sub.slice("contacts/".length, -"/delete".length),
    );
    return u.json(await b.adminDeleteContact(igsid));
  }

  return u.json({ error: "Not found" }, 404);
}
