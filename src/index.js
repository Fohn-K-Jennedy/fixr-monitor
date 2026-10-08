const FIXR_URL = "https://fixr.co/organiser/timepiece?lang=en-US";

// GitHub auto-deploy test
const WHATSAPP_API_VERSION = "v26.0";

// Keep using the currently approved template for now.
const WHATSAPP_TEMPLATE_NAME = "fixr_event_alert2";
const WHATSAPP_TEMPLATE_LANGUAGE = "en";
const TEMPLATE_ACCEPTS_EVENT_DETAILS = true;

const MONITORING_START_MINUTES = 7 * 60 + 50;
const MONITORING_END_MINUTES = 24 * 60;

const RELEASE = "dedup-coordinator-v3";
const LEDGER_KEY = "notification_ledger_v1";
const COORDINATOR_NAME = "timepiece-notifications-v1";
const MAX_EVENTS_PER_RUN = 3;
const MAX_MESSAGES_PER_RUN = 12;
const MAX_MESSAGES_PER_HOUR = 30;

function coordinator(env) {
  return env.NOTIFICATION_COORDINATOR.get(env.NOTIFICATION_COORDINATOR.idFromName(COORDINATOR_NAME));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/health") {
      return new Response("Not found", {status: 404});
    }
    try {
      return await coordinator(env).fetch("https://internal/health");
    } catch {
      return Response.json({success:false, release:RELEASE, status:"coordinator_unavailable"}, {status:503});
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledCheck(env));
  },
};

async function runScheduledCheck(env) {
  let failed = false;
  try {
    const response = await coordinator(env).fetch("https://internal/check", {method:"POST"});
    const result = await response.json();
    failed = !response.ok || !result.success;
    console.log(JSON.stringify(result));
  } catch {
    failed = true;
    console.error("Notification coordinator check failed.");
  }
  await reportHeartbeat(env, failed);
}

// One named Durable Object owns all notification attempts. Storage is strongly
// consistent; the in-memory guard prevents interleaving during external I/O.
export class NotificationCoordinator {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.busy = false;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const ledger = await this.ctx.storage.get(LEDGER_KEY);
      const blocked = ledger && (ledger.paused_reason || Object.values(ledger.deliveries).some(d => d.status !== "accepted"));
      const enabled = this.env.WHATSAPP_SENDING_ENABLED === "true";
      return Response.json({
        success: Boolean(ledger) && enabled && !blocked,
        release: RELEASE,
        status: blocked ? "delivery_review_required" : !ledger ? "initializing" : enabled ? "monitoring" : "sending_paused",
        whatsapp_sending_enabled: enabled && !blocked,
        baseline_initialized: Boolean(ledger),
        baseline_event_count: ledger?.baseline_event_count || 0,
        last_check_at: ledger?.last_check_at || null,
        last_status: ledger?.last_status || null,
        currently_in_window: isWithinMonitoringWindow(),
      }, {status: blocked ? 503 : 200});
    }
    if (request.method !== "POST" || url.pathname !== "/check") {
      return new Response("Not found", {status:404});
    }
    if (this.busy) return Response.json({success:true,status:"overlapping_run_skipped"});
    this.busy = true;
    try {
      return Response.json(await this.check());
    } catch {
      return Response.json({success:false,status:"check_failed"}, {status:503});
    } finally {
      this.busy = false;
    }
  }

  async check() {
    const storage = this.ctx.storage;
    let ledger = await storage.get(LEDGER_KEY);
    if (ledger && (ledger.paused_reason || Object.values(ledger.deliveries).some(d => d.status !== "accepted"))) {
      return {success:false,status:"delivery_review_required"};
    }
    if (ledger && this.env.WHATSAPP_SENDING_ENABLED !== "true") {
      return {success:false,status:"sending_paused"};
    }
    if (ledger && !isWithinMonitoringWindow()) {
      return {success:true,status:"outside_monitoring_window"};
    }
    const urls = await getCurrentEventUrls();
    if (urls.length === 0) throw new Error("Empty FIXR event listing; refusing to initialize or change state.");
    const events = [...new Map(urls.map(url => [eventStateId(url), url])).entries()];
    const now = Date.now();
    if (!ledger) {
      // Deliberately absorb the pre-repair backlog without sending any alerts.
      ledger = {seen:events.map(([id]) => id), deliveries:{}, attempts:[], baseline_event_count:events.length,
        last_check_at:new Date(now).toISOString(), last_status:"baseline_created"};
      await storage.put(LEDGER_KEY, ledger);
      return {success:true,status:"baseline_created",notifications_sent:0,event_count:events.length};
    }
    ledger.last_check_at = new Date(now).toISOString();
    const newEvents = events.filter(([id]) => !ledger.seen.includes(id));
    if (!newEvents.length) {
      ledger.last_status = "no_change";
      await storage.put(LEDGER_KEY,ledger);
      return {success:true,status:"no_change",notifications_sent:0};
    }
    const recipients = getWhatsAppRecipients(this.env);
    if (recipients.length > 10 || !this.env.WHATSAPP_ACCESS_TOKEN || !this.env.WHATSAPP_PHONE_NUMBER_ID) {
      throw new Error("Invalid WhatsApp configuration.");
    }
    ledger.attempts = ledger.attempts.filter(at => at > now - 3600000);
    const batchSize = newEvents.length * recipients.length;
    if (newEvents.length > MAX_EVENTS_PER_RUN || batchSize > MAX_MESSAGES_PER_RUN || ledger.attempts.length + batchSize > MAX_MESSAGES_PER_HOUR) {
      ledger.paused_reason = "sending_limit_exceeded";
      ledger.last_status = "sending_limit_exceeded";
      await storage.put(LEDGER_KEY,ledger);
      return {success:false,status:"sending_limit_exceeded",notifications_sent:0};
    }
    const recipientIds = await Promise.all(recipients.map(recipientStateId));
    let accepted = 0;
    for (const [eventId,eventUrl] of newEvents) {
      const eventName = await getEventName(eventUrl);
      for (let index=0; index<recipients.length; index++) {
        const key = `${eventId}:${recipientIds[index]}`;
        if (ledger.deliveries[key]) continue;
        // The claim must become durable BEFORE the external POST. Never erase
        // it or retry automatically, including after a crash or timeout.
        ledger.deliveries[key] = {status:"pending",attempted_at:new Date().toISOString()};
        ledger.attempts.push(Date.now());
        await storage.put(LEDGER_KEY, ledger);
        let failure = false;
        try {
          await sendWhatsAppAlert(this.env, recipients[index], {name:eventName,url:eventUrl});
          ledger.deliveries[key].status = "accepted";
          accepted++;
        } catch {
          failure = true;
          ledger.deliveries[key].status = "uncertain_or_rejected";
          ledger.paused_reason = "delivery_review_required";
        }
        ledger.last_status = failure ? "delivery_review_required" : "new_events_found";
        // Failure here leaves the durable pending claim intact: no resend.
        await storage.put(LEDGER_KEY,ledger);
        if (failure) return {success:false,status:"delivery_review_required",notifications_sent:accepted};
      }
      ledger.seen.push(eventId);
      await storage.put(LEDGER_KEY,ledger);
    }
    return {success:true,status:"new_events_found",notifications_sent:accepted};
  }
}

function eventStateId(url) {
  const parsed = new URL(url);
  const id = parsed.pathname.match(/-tickets-(\d+)\/?$/i);
  return id ? `fixr:${id[1]}` : parsed.pathname.replace(/\/$/, "");
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const response = await fetch(url, { ...options, signal: controller.signal });
		const body = await response.text();
		return { ok: response.ok, status: response.status, text: async () => body };
	} finally {
		clearTimeout(timer);
	}
}

async function reportHeartbeat(env, failed) {
	if (!env.BETTERSTACK_HEARTBEAT_URL) {
		throw new Error("Better Stack heartbeat secret is missing.");
	}
	const heartbeatUrl = String(env.BETTERSTACK_HEARTBEAT_URL).trim().replace(/\/+$/, "");
	const targetUrl = failed ? `${heartbeatUrl}/fail` : heartbeatUrl;
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		try {
			const response = await fetchWithTimeout(targetUrl, {}, 5000);
			if (!response.ok) {
				throw new Error(`Better Stack returned status ${response.status}`);
			}
			console.log(JSON.stringify({
				status: "heartbeat_delivered", failed, attempt,
				checked_at: new Date().toISOString(),
			}));
			return;
		} catch (error) {
			// Do not log the secret heartbeat URL.
			console.error(JSON.stringify({ status: "heartbeat_delivery_failed", attempt }));
			if (attempt === 3) {
				throw new Error("Could not deliver Better Stack heartbeat after 3 attempts.");
			}
		}
	}
}

async function getCurrentEventUrls() {
	const response = await fetchWithTimeout(FIXR_URL, {
		headers: {
			"User-Agent": "FIXR Event Monitor/1.0",
		},
	});

	if (!response.ok) {
		throw new Error(`FIXR returned status ${response.status}`);
	}

	const html = await response.text();
	return extractEventUrls(html);
}

function extractEventUrls(html) {
	const eventUrls = new Set();
	const pattern = /<[^>]*\shref\s*=\s*(["'])(.*?)\1[^>]*>/gi;

	for (const match of html.matchAll(pattern)) {
		let url;

		try {
			url = new URL(match[2], FIXR_URL);
		} catch {
			continue;
		}

		if (
			(url.hostname !== "fixr.co" &&
				url.hostname !== "www.fixr.co") ||
			!url.pathname.startsWith("/event/")
		) {
			continue;
		}

		url.search = "";
		url.hash = "";
		eventUrls.add(url.toString());
	}

	return [...eventUrls].sort();
}

async function getEventName(eventUrl) {
	const response = await fetchWithTimeout(eventUrl, {
		headers: {
			"User-Agent": "FIXR Event Monitor/1.0",
		},
	});

	if (!response.ok) {
		throw new Error(
			`FIXR event page returned status ${response.status}`,
		);
	}

	const html = await response.text();
	const headingMatch = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);

	if (!headingMatch) {
		return eventNameFromUrl(eventUrl);
	}

	const eventName = decodeHtml(
		headingMatch[1].replace(/<[^>]+>/g, " "),
	)
		.replace(/\s+/g, " ")
		.trim();

	return eventName || eventNameFromUrl(eventUrl);
}

function eventNameFromUrl(eventUrl) {
	const pathname = new URL(eventUrl).pathname;
	const slug =
		pathname.split("/").filter(Boolean).pop() || "new-event";

	return slug
		.replace(/-tickets-\d+$/i, "")
		.replace(/-/g, " ")
		.replace(/\b\w/g, (character) => character.toUpperCase())
		.trim();
}

function decodeHtml(value) {
	return value
		.replace(/&#x([0-9a-f]+);/gi, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 16)),
		)
		.replace(/&#(\d+);/g, (_, code) =>
			String.fromCodePoint(Number.parseInt(code, 10)),
		)
		.replace(/&nbsp;/gi, " ")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&amp;/gi, "&");
}

function getWhatsAppRecipients(env) {
	const configuredRecipients = parseWhatsAppRecipients(
		env.WHATSAPP_RECIPIENTS,
	);
	const recipients = configuredRecipients.length > 0
		? configuredRecipients
		: parseWhatsAppRecipients(env.WHATSAPP_TO);

	if (recipients.length === 0) {
		throw new Error("One or more WhatsApp secrets are missing.");
	}

	return recipients;
}

function parseWhatsAppRecipients(value) {
	if (!value) {
		return [];
	}

	return [
		...new Set(
			String(value)
				.split(",")
				.map((recipient) =>
					recipient.replace(/\s+/g, "").replace(/\D/g, ""),
				)
				.filter(Boolean),
		),
	];
}

async function recipientStateId(recipient) {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(recipient),
	);

	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

async function sendWhatsAppAlert(env, recipient, event) {
	if (
		!env.WHATSAPP_ACCESS_TOKEN ||
		!env.WHATSAPP_PHONE_NUMBER_ID ||
		!recipient
	) {
		throw new Error("One or more WhatsApp secrets are missing.");
	}

	const template = {
		name: WHATSAPP_TEMPLATE_NAME,
		language: {
			code: WHATSAPP_TEMPLATE_LANGUAGE,
		},
	};

	if (TEMPLATE_ACCEPTS_EVENT_DETAILS) {
		template.components = [
			{
				type: "body",
				parameters: [
					{
						type: "text",
						text: event.name,
					},
					{
						type: "text",
						text: event.url,
					},
				],
			},
		];
	}

	const response = await fetchWithTimeout(
		`https://graph.facebook.com/${WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				messaging_product: "whatsapp",
				to: recipient,
				type: "template",
				template,
			}),
		},
	);

	if (!response.ok) {
		throw new Error(
			`WhatsApp returned status ${response.status}.`,
		);
	}
}

function isWithinMonitoringWindow(date = new Date()) {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone: "Europe/London",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(date);

	const values = Object.fromEntries(
		parts
			.filter((part) => part.type !== "literal")
			.map((part) => [part.type, part.value]),
	);

	const ukMinutes =
		Number(values.hour) * 60 + Number(values.minute);

	return (
		ukMinutes >= MONITORING_START_MINUTES &&
		ukMinutes < MONITORING_END_MINUTES
	);
}
